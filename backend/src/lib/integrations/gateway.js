'use strict';

/**
 * Integration Gateway — the provider-agnostic runtime facade.
 *
 *     N&D'S Application → Integration Gateway → Provider Adapter → Provider
 *
 * Application code calls into this module; it NEVER imports an adapter
 * directly. For every operation the Gateway:
 *
 *   1. loads the tenant's connection row — tenant-scoped, 404 on miss so one
 *      tenant can never discover another tenant's connections;
 *   2. decrypts secrets server-side and instantiates the registered adapter;
 *   3. enforces capability detection (`supports()`) so unsupported operations
 *      fail safely instead of pretending they succeeded;
 *   4. executes the adapter call and normalises failures into the stable
 *      IntegrationError taxonomy ({ code, category, retryable });
 *   5. writes a secret-scrubbed IntegrationEvent and maintains the
 *      connection's status / last-sync / last-error bookkeeping.
 *
 * Phase-1 scope: connection lifecycle, payment initiation/status/refund,
 * webhook reception (logged, not yet wired into orders) and disconnect. Real
 * banking/PSP/POS/accounting adapters arrive in later phases behind the same
 * interface.
 */

const crypto = require('crypto');
const prisma = require('../prisma');
const registry = require('./registry');
const credentials = require('./credentials');
const { logEvent } = require('./events');
const { IntegrationError, IntegrationConfigError, CAPABILITY_IDS } = require('./base');

const isProd = () => process.env.NODE_ENV === 'production';

/** Shared secret used only in non-production sandbox webhook tests. */
const sandboxSecret = () => process.env.INTEGRATION_SANDBOX_SECRET
  || process.env.PAYMENT_SANDBOX_SECRET
  || 'dev-sandbox-secret';

const CONNECTION_STATUSES = [
  'NOT_CONNECTED',
  'CONFIGURED',
  'CONNECTED',
  'DISCONNECTED',
  'DISABLED',
  'ERROR',
];

function parseJson(text, fallback = {}) {
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

/**
 * Loads a connection row scoped to the tenant. Returns null on miss — callers
 * translate that to 404 so cross-tenant existence is never leaked.
 */
async function getConnectionForTenant(tenantId, connectionId) {
  if (!tenantId || !connectionId) return null;
  return prisma.integrationConnection.findFirst({
    where: { id: connectionId, businessId: tenantId },
  });
}

/** Decrypts a connection's secrets. Returns {} when nothing is stored. */
function decryptConnectionSecrets(connection) {
  if (!connection?.credentialsCipher) return {};
  return credentials.decryptSecrets(connection.credentialsCipher);
}

function connectionConfig(connection) {
  return parseJson(connection?.config, {});
}

/**
 * Instantiates the registered adapter for a connection row.
 * @throws {IntegrationConfigError} when no adapter is registered for the provider
 */
function adapterFor(connection, { secrets = null, config = null } = {}) {
  const adapter = registry.create({
    connection,
    secrets: secrets !== null ? secrets : decryptConnectionSecrets(connection),
    config: config !== null ? config : connectionConfig(connection),
    tenantId: connection?.businessId || null,
  });
  if (!adapter) {
    throw new IntegrationConfigError(
      `No provider adapter is registered for '${connection?.providerId}'. The provider may have been removed — reconnect or delete this connection.`
    );
  }
  return adapter;
}

/** Browser-safe connection shape: cipher stripped, JSON columns parsed. */
function safeConnection(connection) {
  if (!connection) return connection;
  const { credentialsCipher, ...rest } = connection; // eslint-disable-line no-unused-vars
  return {
    ...rest,
    config: parseJson(connection.config, {}),
    credentialFields: parseJson(connection.credentialFields, []),
    capabilities: parseJson(connection.capabilities, []),
  };
}

/**
 * Full capability matrix for a connection: every known capability annotated
 * with whether THIS connection's adapter + configuration supports it.
 */
function capabilityMatrix(connection) {
  let adapter = null;
  try {
    adapter = adapterFor(connection);
  } catch (_) {
    adapter = null;
  }
  return CAPABILITY_IDS.map((id) => ({
    id,
    supported: adapter ? adapter.supports(id) : false,
    available: adapter ? adapter.supports(id) : false,
  }));
}

/** Normalises any adapter failure into an IntegrationError (never leaks secrets). */
function normaliseError(adapter, err) {
  if (err instanceof IntegrationError) return err;
  const message = err && err.message
    ? String(err.message).slice(0, 300)
    : 'The provider request failed unexpectedly.';
  const safe = adapter ? adapter.redactForLog(message) : message;
  return new IntegrationError(typeof safe === 'string' ? safe : 'The provider request failed unexpectedly.', {
    code: 'PROVIDER_ERROR',
    category: 'PROVIDER',
    retryable: false,
    status: 502,
  });
}

async function touchConnection(connectionId, data) {
  try {
    return await prisma.integrationConnection.update({ where: { id: connectionId }, data });
  } catch (_) {
    return null;
  }
}

/**
 * Runs one adapter operation end-to-end: capability gate → execute → event log
 * → connection bookkeeping. Throws the normalised IntegrationError on failure
 * (after logging), so routes can translate it directly to HTTP.
 */
async function runOperation({ tenantId, connectionId, capability, operation, args = [], externalReference = null, metadata = null }) {
  const connection = await getConnectionForTenant(tenantId, connectionId);
  if (!connection) {
    const err = new IntegrationError('Integration connection not found', {
      code: 'CONNECTION_NOT_FOUND', category: 'VALIDATION', retryable: false, status: 404,
    });
    err.notFound = true;
    throw err;
  }
  if (connection.status === 'DISABLED') {
    throw new IntegrationConfigError('This integration is disabled. Re-enable it before use.');
  }
  let adapter;
  try {
    adapter = adapterFor(connection);
  } catch (err) {
    await logEvent({
      tenantId, connectionId: connection.id, providerId: connection.providerId,
      operation, success: false, errorCategory: 'CONFIG', errorMessage: err.message,
    });
    throw err;
  }
  try {
    adapter.requireCapability(capability);
  } catch (err) {
    // A rejected capability is still audit-worthy (who tried what, when) —
    // log it, but never flip a healthy connection into ERROR for it.
    const normalised = normaliseError(adapter, err);
    await logEvent({
      tenantId, connectionId: connection.id, providerId: connection.providerId,
      operation, success: false,
      errorCategory: normalised.category, errorMessage: normalised.message,
      retryable: normalised.retryable,
    });
    throw normalised;
  }
  try {
    const result = await adapter[operation](...args);
    const ref = externalReference
      || (result && typeof result === 'object' ? result.reference || result.transactionId || result.refundReference || null : null);
    await logEvent({
      tenantId, connectionId: connection.id, providerId: connection.providerId,
      operation, success: true, externalReference: ref,
      metadata: adapter.redactForLog(metadata || result),
    });
    await touchConnection(connection.id, { lastError: null });
    return { connection, adapter, result };
  } catch (err) {
    const normalised = normaliseError(adapter, err);
    await logEvent({
      tenantId, connectionId: connection.id, providerId: connection.providerId,
      operation, success: false,
      errorCategory: normalised.category, errorMessage: normalised.message,
      retryable: normalised.retryable,
      metadata: metadata ? adapter.redactForLog(metadata) : null,
    });
    if (normalised.category !== 'UNSUPPORTED') {
      await touchConnection(connection.id, { status: 'ERROR', lastError: String(normalised.message).slice(0, 500) });
    }
    throw normalised;
  }
}

/* ------------------------------------------------------------------ lifecycle */

async function testConnection({ tenantId, connectionId }) {
  const { connection, result } = await runOperation({
    tenantId, connectionId, capability: 'testConnection', operation: 'testConnection',
  });
  // The successful testConnection event already marks the moment the
  // connection became CONNECTED — no synthetic event needed.
  await touchConnection(connection.id, {
    status: 'CONNECTED', lastTestedAt: new Date(), lastConnectedAt: new Date(), lastError: null,
  });
  return result;
}

async function connect({ tenantId, connectionId }) {
  const { connection, result } = await runOperation({
    tenantId, connectionId, capability: 'connect', operation: 'connect',
  });
  await touchConnection(connection.id, {
    status: 'CONNECTED', lastConnectedAt: new Date(), lastError: null,
  });
  return result;
}

async function disconnect({ tenantId, connectionId }) {
  const { connection, result } = await runOperation({
    tenantId, connectionId, capability: 'disconnect', operation: 'disconnect',
  });
  // Disconnect closes the session; stored credentials are retained so the
  // tenant can reconnect without re-entering secrets. DELETE destroys them.
  const updated = await touchConnection(connection.id, { status: 'DISCONNECTED', lastError: null });
  return { connection: safeConnection(updated || { ...connection, status: 'DISCONNECTED' }), result };
}

/* ------------------------------------------------------------------ payments */

function assertPaymentInput(payment = {}) {
  const amount = Number(payment.amount);
  if (!(amount > 0)) {
    throw new IntegrationConfigError('A positive payment amount is required.');
  }
  if (!String(payment.reference || '').trim()) {
    throw new IntegrationConfigError('A payment reference is required.');
  }
  return {
    amount,
    currency: String(payment.currency || 'USD').toUpperCase().slice(0, 3),
    reference: String(payment.reference).trim().slice(0, 200),
    description: payment.description ? String(payment.description).slice(0, 300) : undefined,
    customer: payment.customer && typeof payment.customer === 'object' ? {
      name: payment.customer.name ? String(payment.customer.name).slice(0, 120) : undefined,
      email: payment.customer.email ? String(payment.customer.email).slice(0, 180) : undefined,
      phone: payment.customer.phone ? String(payment.customer.phone).slice(0, 40) : undefined,
    } : undefined,
    returnUrls: payment.returnUrls && typeof payment.returnUrls === 'object' ? {
      success: payment.returnUrls.success ? String(payment.returnUrls.success).slice(0, 500) : undefined,
      cancel: payment.returnUrls.cancel ? String(payment.returnUrls.cancel).slice(0, 500) : undefined,
    } : undefined,
  };
}

async function createPayment({ tenantId, connectionId, payment }) {
  const input = assertPaymentInput(payment);
  const { result } = await runOperation({
    tenantId, connectionId, capability: 'createPayment', operation: 'createPayment',
    args: [input], externalReference: input.reference,
    metadata: { amount: input.amount, currency: input.currency },
  });
  return result;
}

async function getPaymentStatus({ tenantId, connectionId, reference }) {
  if (!String(reference || '').trim()) throw new IntegrationConfigError('A payment reference is required.');
  const { result } = await runOperation({
    tenantId, connectionId, capability: 'getPaymentStatus', operation: 'getPaymentStatus',
    args: [String(reference).trim()], externalReference: String(reference).trim(),
  });
  return result;
}

async function verifyPayment({ tenantId, connectionId, reference }) {
  if (!String(reference || '').trim()) throw new IntegrationConfigError('A payment reference is required.');
  const { result } = await runOperation({
    tenantId, connectionId, capability: 'verifyPayment', operation: 'verifyPayment',
    args: [String(reference).trim()], externalReference: String(reference).trim(),
  });
  return result;
}

async function refundPayment({ tenantId, connectionId, reference, amount }) {
  if (!String(reference || '').trim()) throw new IntegrationConfigError('A payment reference is required.');
  const value = amount === undefined || amount === null ? undefined : Number(amount);
  if (value !== undefined && !(value > 0)) throw new IntegrationConfigError('Refund amount must be positive.');
  const { result } = await runOperation({
    tenantId, connectionId, capability: 'refundPayment', operation: 'refundPayment',
    args: [String(reference).trim(), value], externalReference: String(reference).trim(),
    metadata: value === undefined ? null : { amount: value },
  });
  return result;
}

/* ------------------------------------------------------------------ webhooks */

/**
 * Provider → Webhook → Integration Gateway → internal event log.
 *
 * The route is `POST /api/integrations/webhooks/:providerId/:webhookToken`.
 * The webhook token is a per-connection unguessable secret issued at creation:
 * unknown provider → 404, unknown token → 404, bad signature → 401. Only a
 * verified payload is ever parsed, and parsing is strictly the adapter's job.
 *
 * Phase-1 scope: verified webhooks are recorded as IntegrationEvents (the
 * handoff point). They do NOT mutate orders/invoices — wiring provider events
 * into the payment lifecycle is a later phase with its own review.
 */
async function handleWebhook({ providerId, webhookToken, rawBody, headers }) {
  const id = String(providerId || '').toUpperCase();
  const Provider = registry.get(id);
  if (!Provider) {
    const err = new IntegrationError(`Unknown provider '${id}'`, {
      code: 'UNKNOWN_PROVIDER', category: 'VALIDATION', retryable: false, status: 404,
    });
    err.notFound = true;
    throw err;
  }
  const connection = webhookToken
    ? await prisma.integrationConnection.findUnique({ where: { webhookToken: String(webhookToken) } })
    : null;
  if (!connection || connection.providerId !== id) return { received: true, handled: false, unknown: true };
  if (connection.status === 'DISABLED') return { received: true, handled: false, disabled: true };

  const tenantId = connection.businessId;
  let adapter;
  try {
    adapter = adapterFor(connection);
  } catch (err) {
    await logEvent({
      tenantId, connectionId: connection.id, providerId: id,
      operation: 'receiveWebhook', success: false, errorCategory: 'CONFIG', errorMessage: err.message,
    });
    return { received: true, handled: false, error: err.message };
  }
  if (!adapter.supports('receiveWebhook')) {
    await logEvent({
      tenantId, connectionId: connection.id, providerId: id,
      operation: 'receiveWebhook', success: false, errorCategory: 'UNSUPPORTED',
      errorMessage: `Provider '${id}' does not support webhooks.`,
    });
    return { received: true, handled: false, unsupported: true };
  }

  let verified = false;
  try {
    verified = await adapter.verifyWebhook(rawBody == null ? '' : String(rawBody), headers || {});
  } catch (_) {
    verified = false;
  }
  // Non-production sandbox fallback for connections without stored secrets —
  // mirrors the existing payment-webhook behaviour so end-to-end tests can run
  // without real provider credentials. Never active in production.
  if (!verified && !isProd() && !connection.credentialsCipher) {
    try {
      const sig = headers['x-payment-signature'] || headers['x-signature'] || headers.signature;
      const expected = crypto.createHmac('sha256', sandboxSecret()).update(String(rawBody || '')).digest('hex');
      const A = Buffer.from(String(sig || '').replace(/^sha256=/i, ''));
      const B = Buffer.from(expected);
      verified = A.length === B.length && A.length > 0 && crypto.timingSafeEqual(A, B);
    } catch (_) {
      verified = false;
    }
  }
  if (!verified) {
    await logEvent({
      tenantId, connectionId: connection.id, providerId: id,
      operation: 'receiveWebhook', success: false, errorCategory: 'AUTH',
      errorMessage: 'Webhook signature verification failed.',
    });
    const err = new IntegrationError('Invalid webhook signature', {
      code: 'WEBHOOK_VERIFICATION_FAILED', category: 'AUTH', retryable: false, status: 401,
    });
    err.unauthorized = true;
    throw err;
  }

  let body = null;
  try { body = rawBody ? JSON.parse(String(rawBody)) : null; } catch (_) { body = null; }
  let parsed = null;
  try {
    parsed = await adapter.parseWebhook(rawBody == null ? '' : String(rawBody), headers || {}, body);
  } catch (err) {
    await logEvent({
      tenantId, connectionId: connection.id, providerId: id,
      operation: 'receiveWebhook', success: false, errorCategory: 'PROVIDER',
      errorMessage: adapter.redactForLog(err.message),
    });
    return { received: true, handled: false, error: 'Webhook payload could not be parsed.' };
  }
  if (!parsed || !parsed.reference) {
    await logEvent({
      tenantId, connectionId: connection.id, providerId: id,
      operation: 'receiveWebhook', success: true,
      metadata: { note: 'Verified webhook carried no actionable reference; ignored.' },
    });
    return { received: true, handled: false };
  }
  await logEvent({
    tenantId, connectionId: connection.id, providerId: id,
    operation: 'receiveWebhook', success: true, externalReference: parsed.reference,
    metadata: adapter.redactForLog({
      transactionId: parsed.transactionId || null,
      paid: parsed.paid === true,
      amount: parsed.amount ?? null,
      currency: parsed.currency || null,
    }),
  });
  await touchConnection(connection.id, { lastSyncAt: new Date(), lastSyncStatus: 'WEBHOOK_RECEIVED', lastError: null });
  return {
    received: true,
    handled: true,
    reference: parsed.reference,
    transactionId: parsed.transactionId || null,
    paid: parsed.paid === true,
  };
}

/* ------------------------------------------------------------------ reconcile */

async function reconcile({ tenantId, connectionId, params = {} }) {
  const { connection, result } = await runOperation({
    tenantId, connectionId, capability: 'reconcile', operation: 'reconcile',
    args: [params && typeof params === 'object' ? params : {}],
  });
  await touchConnection(connection.id, { lastSyncAt: new Date(), lastSyncStatus: 'RECONCILED', lastError: null });
  return result;
}

/* ------------------------------------------------------------------ misc */

function toHttpError(err) {
  if (err && err.notFound) return { status: 404, code: err.code || 'NOT_FOUND', message: 'Integration connection not found' };
  if (err && err.unauthorized) return { status: 401, code: err.code || 'UNAUTHORIZED', message: err.message || 'Unauthorized' };
  if (err instanceof IntegrationError) {
    // Covers UnsupportedCapabilityError / NotConnectedError /
    // IntegrationConfigError too — each carries its own HTTP status.
    return { status: err.status || 502, code: err.code, message: err.message, category: err.category, retryable: err.retryable };
  }
  return { status: 502, code: 'PROVIDER_ERROR', message: 'The provider request failed unexpectedly.' };
}

module.exports = {
  CONNECTION_STATUSES,
  sandboxSecret,
  parseJson,
  getConnectionForTenant,
  decryptConnectionSecrets,
  connectionConfig,
  adapterFor,
  safeConnection,
  capabilityMatrix,
  testConnection,
  connect,
  disconnect,
  createPayment,
  getPaymentStatus,
  verifyPayment,
  refundPayment,
  reconcile,
  handleWebhook,
  toHttpError,
};
