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
 *   4. (PR #71) applies idempotency replay protection for keyed writes/syncs,
 *      bounded provider-safe retries (retry.js), and a confirmation guard so
 *      lifecycle success is only reported when the adapter confirms it
 *      (lifecycle.js) — a fake green "Connected" is impossible;
 *   5. normalises results (results.js) and failures into the stable
 *      IntegrationError taxonomy { code, category, retryable };
 *   6. writes a secret-scrubbed IntegrationEvent and maintains the
 *      connection's status / last-sync / last-error bookkeeping.
 *
 * PR #68 scope (connection lifecycle, payment initiation/status/refund,
 * webhook reception, disconnect) is preserved verbatim — every extension
 * here is additive so existing callers and the PR #69 UI keep working.
 */

const crypto = require('crypto');
const prisma = require('../prisma');
const registry = require('./registry');
const credentials = require('./credentials');
const { logEvent } = require('./events');
const { IntegrationError, IntegrationConfigError, UnsupportedCapabilityError, CAPABILITY_IDS } = require('./base');
const lifecycle = require('./lifecycle');
const results = require('./results');
const retry = require('./retry');
const idempotency = require('./idempotency');
const pipeline = require('./pipeline');

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

/** Operations that may carry a caller-supplied idempotency key. */
const IDEMPOTENT_OPERATIONS = new Set([
  'createPayment', 'capturePayment', 'refundPayment', 'voidPayment', 'createPaymentLink',
  'initiateTransfer', 'verifyAccount',
  'syncCustomers', 'syncProducts', 'syncInventory', 'syncInvoices', 'syncPayments',
  'pollSync', 'reconcile', 'importStatement',
]);

/** Lifecycle operations whose success must be confirmed by the adapter. */
const CONFIRMED_OPERATIONS = new Set(['connect', 'testConnection', 'reconnect']);

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
  const { credentialsCipher, ...rest } = connection; // eslint-disable-next-line no-unused-vars
  return {
    ...rest,
    config: parseJson(connection.config, {}),
    credentialFields: parseJson(connection.credentialFields, []),
    capabilities: parseJson(connection.capabilities, []),
    lifecyclePhase: lifecycle.phaseOf(connection.status),
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
  const info = results.classifyError(err);
  const message = err && err.message
    ? String(err.message).slice(0, 300)
    : 'The provider request failed unexpectedly.';
  const safe = adapter ? adapter.redactForLog(message) : message;
  return new IntegrationError(typeof safe === 'string' ? safe : 'The provider request failed unexpectedly.', {
    code: info.code,
    category: info.category,
    retryable: info.retryable,
    status: info.status,
  });
}

async function touchConnection(connectionId, data) {
  try {
    return await prisma.integrationConnection.update({ where: { id: connectionId }, data });
  } catch (_) {
    return null;
  }
}

/** Durable idempotency recovery: a completed success event for the same key. */
async function findCompletedIdempotentEvent({ connectionId, operation, key }) {
  try {
    const rows = await prisma.integrationEvent.findMany({
      where: { connectionId, operation, success: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    // Match on the stored dedupeRef — a truncated SHA-256 of the caller's
    // idempotency key (never the key itself, and safe from redaction since
    // it does not look like a credential name).
    const needle = idempotency.digest({ key }).slice(0, 32);
    for (const row of rows) {
      const md = parseJson(row.metadata, {});
      if (md && md.dedupeRef === needle) return row;
    }
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Core operation pipeline shared by every typed and generic operation:
 * load (tenant-scoped) → gate → capability → idempotency → retry →
 * confirm (lifecycle only) → execute → normalise → event → bookkeeping.
 * Throws the normalised IntegrationError on failure (after logging), so
 * routes can translate it directly to HTTP.
 */
async function executeOperation({
  tenantId, connectionId, capability, operation, adapterMethod = null,
  args = [], externalReference = null, metadata = null,
  idempotencyKey = null, confirm = null,
}) {
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

  /* ---------------- idempotency (keyed writes/syncs) ---------------- */
  const scopedKey = idempotencyKey && IDEMPOTENT_OPERATIONS.has(operation) ? String(idempotencyKey).slice(0, 200) : null;
  const scope = scopedKey
    ? { tenantId, connectionId: connection.id, operation, idempotencyKey: scopedKey, payload: { args, externalReference } }
    : null;
  if (scope) {
    const claim = idempotency.claim(scope);
    if (claim.state === 'conflict') {
      throw new IntegrationError(
        'An operation with this idempotency key was already used with a different request body. Use a new key to retry with changed data.',
        { code: 'IDEMPOTENCY_CONFLICT', category: 'VALIDATION', retryable: false, status: 409 }
      );
    }
    if (claim.state === 'in-flight') {
      throw new IntegrationError(
        'A request with this idempotency key is still being processed. Wait and retry with the same key to receive its result.',
        { code: 'IDEMPOTENCY_IN_FLIGHT', category: 'VALIDATION', retryable: true, status: 409 }
      );
    }
    if (claim.state === 'replay') {
      await logEvent({
        tenantId, connectionId: connection.id, providerId: connection.providerId,
        operation, success: true, externalReference,
        metadata: { idempotentReplay: true },
      });
      return { connection, adapter, result: claim.entry.result, replayed: true, scope };
    }
    // Fresh claim but the ledger has no memory (e.g. after a restart): the
    // durable audit trail decides whether this key already completed.
    const completed = await findCompletedIdempotentEvent({ connectionId: connection.id, operation, key: scopedKey });
    if (completed) {
      const replayResult = { replayed: true, completedAt: completed.createdAt, note: 'Original response is not reconstructable; the operation completed and is recorded in the activity log. No provider call was repeated.' };
      idempotency.settle(scope, replayResult);
      await logEvent({
        tenantId, connectionId: connection.id, providerId: connection.providerId,
        operation, success: true, externalReference,
        metadata: { idempotentReplay: true, durable: true },
      });
      return { connection, adapter, result: replayResult, replayed: true, durableReplay: true, scope };
    }
  }

  const shouldConfirm = confirm === null ? CONFIRMED_OPERATIONS.has(operation) : confirm;

  try {
    const policy = retry.policyFor({
      capability,
      providerIdempotency: Boolean(adapter.constructor.providerIdempotency),
    });
    // `adapterMethod` aliases framework operations onto adapter methods
    // (e.g. reconnect runs the adapter's connect/testConnection — the
    // Gateway defines the operation, the adapter defines the verbs).
    const method = adapterMethod || operation;
    if (typeof adapter[method] !== 'function') {
      throw new UnsupportedCapabilityError(connection.providerId, method);
    }
    const result = await retry.executeWithRetry(
      async () => {
        const raw = await adapter[method](...args);
        if (shouldConfirm) lifecycle.assertConfirmed(raw, { providerId: connection.providerId, operation });
        return raw;
      },
      {
        policy,
        onRetry: ({ attempt, maxAttempts, delayMs, error }) => {
          // Classify exactly like the post-run normalisation so retry
          // telemetry and the eventual failure record always agree.
          const info = results.classifyError(error);
          return logEvent({
            tenantId, connectionId: connection.id, providerId: connection.providerId,
            operation: 'retryAttempt', success: false,
            errorCategory: info.category,
            // Adapter-redacted before insert — provider error strings can echo
            // request fragments; secrets must not reach the event log.
            errorMessage: error && error.message
              ? String(adapter.redactForLog(String(error.message))).slice(0, 300)
              : 'Retried after a retryable provider failure.',
            retryable: true,
            metadata: { operation, attempt, maxAttempts, backoffMs: delayMs },
          });
        },
      }
    );
    const ref = externalReference
      || (result && typeof result === 'object'
        ? result.reference || result.transactionId || result.refundReference || result.transferId || null
        : null);
    await logEvent({
      tenantId, connectionId: connection.id, providerId: connection.providerId,
      operation, success: true, externalReference: ref,
      metadata: adapter.redactForLog({
        ...(metadata || {}),
        ...(scopedKey ? { dedupeRef: idempotency.digest({ key: scopedKey }).slice(0, 32) } : {}),
      }),
    });
    if (scope) idempotency.settle(scope, result);
    // Lifecycle bookkeeping — reached ONLY after the adapter confirmed the
    // operation (the confirm guard above throws otherwise), so the stored
    // status always reflects provider-verified truth.
    let updated = null;
    if (operation === 'testConnection' || operation === 'reconnect') {
      updated = await touchConnection(connection.id, {
        status: 'CONNECTED', lastTestedAt: new Date(), lastConnectedAt: new Date(), lastError: null,
      });
    } else if (operation === 'connect') {
      updated = await touchConnection(connection.id, {
        status: 'CONNECTED', lastConnectedAt: new Date(), lastError: null,
      });
    } else if (operation === 'disconnect') {
      // Disconnect closes the session; stored credentials are retained so the
      // tenant can reconnect without re-entering secrets. DELETE destroys them.
      updated = await touchConnection(connection.id, { status: 'DISCONNECTED', lastError: null });
    } else {
      await touchConnection(connection.id, { lastError: null });
    }
    return { connection, adapter, result, updated, replayed: false, scope };
  } catch (err) {
    if (scope) idempotency.release(scope); // failures must not poison the key
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

/* Legacy name kept for any existing internal callers/tests. */
const runOperation = executeOperation;

/* ------------------------------------------------------------------ lifecycle */

/**
 * Real, side-effect-free credential/reachability check. The connection only
 * transitions to CONNECTED when the adapter itself confirms success (the
 * confirm guard lives inside executeOperation — see lifecycle.js).
 */
async function testConnection({ tenantId, connectionId }) {
  const { result } = await executeOperation({
    tenantId, connectionId, capability: 'testConnection', operation: 'testConnection',
  });
  return result;
}

async function connect({ tenantId, connectionId }) {
  const { result } = await executeOperation({
    tenantId, connectionId, capability: 'connect', operation: 'connect',
  });
  return result;
}

/**
 * Reconnect re-establishes a session after disconnect/credential change/error.
 * Adapters without a dedicated connect() fall back to testConnection — the
 * confirmation rule still applies, so success needs provider evidence either way.
 */
async function reconnect({ tenantId, connectionId }) {
  const connection = await getConnectionForTenant(tenantId, connectionId);
  if (!connection) {
    const err = new IntegrationError('Integration connection not found', {
      code: 'CONNECTION_NOT_FOUND', category: 'VALIDATION', retryable: false, status: 404,
    });
    err.notFound = true;
    throw err;
  }
  if (connection.status === 'DISABLED') {
    throw new IntegrationConfigError('This integration is disabled. Re-enable it before reconnecting.');
  }
  if (!lifecycle.RECONNECTABLE.has(connection.status)) {
    throw new IntegrationConfigError(`Cannot reconnect from ${connection.status} — fix the connection configuration first.`);
  }
  const adapter = adapterFor(connection);
  const capability = adapter.supports('connect') ? 'connect' : 'testConnection';
  const { result } = await executeOperation({
    tenantId, connectionId, capability, operation: 'reconnect', adapterMethod: capability,
    metadata: { via: capability, previousStatus: connection.status },
  });
  return result;
}

async function disconnect({ tenantId, connectionId }) {
  const { connection, result, updated } = await executeOperation({
    tenantId, connectionId, capability: 'disconnect', operation: 'disconnect',
  });
  return { connection: safeConnection(updated || { ...connection, status: 'DISCONNECTED' }), result };
}

/** Enable/disable as first-class lifecycle operations (routes kept as the HTTP entry). */
async function setEnabled({ tenantId, connectionId, enabled }) {
  const connection = await getConnectionForTenant(tenantId, connectionId);
  if (!connection) {
    const err = new IntegrationError('Integration connection not found', {
      code: 'CONNECTION_NOT_FOUND', category: 'VALIDATION', retryable: false, status: 404,
    });
    err.notFound = true;
    throw err;
  }
  const nextStatus = enabled ? 'CONFIGURED' : 'DISABLED';
  if (!lifecycle.isAllowedTransition(connection.status, nextStatus)) {
    throw new IntegrationConfigError(`Cannot ${enabled ? 'enable' : 'disable'} from status ${connection.status}.`);
  }
  const updated = await prisma.integrationConnection.update({
    where: { id: connection.id },
    data: enabled ? { status: 'CONFIGURED', lastError: null } : { status: 'DISABLED' },
  });
  await logEvent({
    tenantId, connectionId: connection.id, providerId: connection.providerId,
    operation: enabled ? 'enable' : 'disable', success: true,
    metadata: { from: connection.status, to: nextStatus },
  });
  return updated;
}

/* ------------------------------------------------------- credential rotation */

/**
 * Merge an incoming credentials object over the stored set.
 * Semantics (shared with the PUT route): omitted/'' keeps the existing
 * secret, null clears it, a value rotates it.
 */
function mergeSecrets(existingPlain, incoming) {
  const next = { ...existingPlain };
  const submitted = {};
  const cleared = [];
  for (const [key, value] of Object.entries(incoming || {})) {
    if (value === undefined || value === '') continue;
    if (value === null) { delete next[key]; cleared.push(key); continue; }
    next[key] = String(value);
    submitted[key] = String(value);
  }
  return { next, submitted, cleared };
}

/**
 * Atomic credential rotation + optional adapter-side validation.
 * One row update swaps cipher AND descriptors together (no torn state); the
 * adapter's validateCredentials() hook may reject malformed new secrets
 * BEFORE anything is persisted. Rotating credentials invalidates the previous
 * CONNECTED claim (the old session belongs to the old material).
 */
async function rotateCredentials({ tenantId, connectionId, credentials: incoming }) {
  const connection = await getConnectionForTenant(tenantId, connectionId);
  if (!connection) {
    const err = new IntegrationError('Integration connection not found', {
      code: 'CONNECTION_NOT_FOUND', category: 'VALIDATION', retryable: false, status: 404,
    });
    err.notFound = true;
    throw err;
  }
  const Provider = registry.get(connection.providerId);
  if (!Provider) throw new IntegrationConfigError(`No provider adapter is registered for '${connection.providerId}'.`);

  let existing = {};
  try { existing = decryptConnectionSecrets(connection); } catch (_) { existing = {}; }
  const { next, submitted, cleared } = mergeSecrets(existing, incoming);

  const { normalizeFields } = require('./fields');
  const credentialFields = normalizeFields(Provider.credentialFields, 'credential');
  const missing = credentialFields
    .filter((f) => f.required)
    .map((f) => f.name)
    .filter((name) => !next[name]);
  if (missing.length) {
    throw new IntegrationConfigError(
      `Rotation would leave required credentials unset: ${missing.join(', ')}. Supply new values for them.`
    );
  }

  // Adapter-side validation with the PROPOSED secrets (never logged).
  if (typeof Provider.prototype.validateCredentials === 'function') {
    const validation = await new Provider({
      connection, secrets: next, config: connectionConfig(connection), tenantId: connection.businessId,
    }).validateCredentials(next);
    if (validation && validation.ok === false) {
      throw new IntegrationConfigError(`Provider rejected the new credentials: ${String(validation.message || 'validation failed').slice(0, 200)}`);
    }
  }

  const priorDescriptors = parseJson(connection.credentialFields, []);
  const descriptors = credentials.describeFields(next, priorDescriptors)
    .filter((f) => !cleared.includes(f.name));
  const updated = await prisma.integrationConnection.update({
    where: { id: connection.id },
    data: {
      credentialsCipher: credentials.encryptSecrets(next),
      credentialFields: JSON.stringify(descriptors),
      // A credential change invalidates any prior "connected" claim.
      status: Object.keys(submitted).length || cleared.length ? 'CONFIGURED' : connection.status,
      lastError: null,
    },
  });
  await logEvent({
    tenantId, connectionId: connection.id, providerId: connection.providerId,
    operation: 'credentialRotated', success: true,
    // Field NAMES only — values never enter the event log.
    metadata: { rotated: Object.keys(submitted), cleared },
  });
  return { connection: updated, rotated: Object.keys(submitted), cleared };
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

function assertTransferInput(transfer = {}) {
  const amount = Number(transfer.amount);
  if (!(amount > 0)) throw new IntegrationConfigError('A positive transfer amount is required.');
  if (!String(transfer.reference || '').trim()) throw new IntegrationConfigError('A transfer reference is required.');
  if (!transfer.destination || typeof transfer.destination !== 'object') {
    throw new IntegrationConfigError('Transfer destination details are required.');
  }
  return {
    amount,
    currency: String(transfer.currency || 'TTD').toUpperCase().slice(0, 3),
    reference: String(transfer.reference).trim().slice(0, 200),
    destination: {
      accountNumber: transfer.destination.accountNumber ? String(transfer.destination.accountNumber).slice(0, 60) : undefined,
      accountName: transfer.destination.accountName ? String(transfer.destination.accountName).slice(0, 120) : undefined,
      bankCode: transfer.destination.bankCode ? String(transfer.destination.bankCode).slice(0, 40) : undefined,
      bankName: transfer.destination.bankName ? String(transfer.destination.bankName).slice(0, 120) : undefined,
    },
    description: transfer.description ? String(transfer.description).slice(0, 300) : undefined,
  };
}

async function createPayment({ tenantId, connectionId, payment, idempotencyKey = null }) {
  const input = assertPaymentInput(payment);
  const { result } = await executeOperation({
    tenantId, connectionId, capability: 'createPayment', operation: 'createPayment',
    args: [input], externalReference: input.reference,
    metadata: { amount: input.amount, currency: input.currency },
    idempotencyKey,
  });
  return result;
}

async function getPaymentStatus({ tenantId, connectionId, reference }) {
  if (!String(reference || '').trim()) throw new IntegrationConfigError('A payment reference is required.');
  const { result } = await executeOperation({
    tenantId, connectionId, capability: 'getPaymentStatus', operation: 'getPaymentStatus',
    args: [String(reference).trim()], externalReference: String(reference).trim(),
  });
  return result;
}

async function verifyPayment({ tenantId, connectionId, reference }) {
  if (!String(reference || '').trim()) throw new IntegrationConfigError('A payment reference is required.');
  const { result } = await executeOperation({
    tenantId, connectionId, capability: 'verifyPayment', operation: 'verifyPayment',
    args: [String(reference).trim()], externalReference: String(reference).trim(),
  });
  return result;
}

async function refundPayment({ tenantId, connectionId, reference, amount, idempotencyKey = null }) {
  if (!String(reference || '').trim()) throw new IntegrationConfigError('A payment reference is required.');
  const value = amount === undefined || amount === null ? undefined : Number(amount);
  if (value !== undefined && !(value > 0)) throw new IntegrationConfigError('Refund amount must be positive.');
  const { result } = await executeOperation({
    tenantId, connectionId, capability: 'refundPayment', operation: 'refundPayment',
    args: [String(reference).trim(), value], externalReference: String(reference).trim(),
    metadata: value === undefined ? null : { amount: value },
    idempotencyKey,
  });
  return result;
}

async function capturePayment({ tenantId, connectionId, reference, amount, idempotencyKey = null }) {
  if (!String(reference || '').trim()) throw new IntegrationConfigError('A payment reference is required.');
  const value = amount === undefined || amount === null ? undefined : Number(amount);
  if (value !== undefined && !(value > 0)) throw new IntegrationConfigError('Capture amount must be positive.');
  const { result } = await executeOperation({
    tenantId, connectionId, capability: 'capturePayment', operation: 'capturePayment',
    args: [String(reference).trim(), value], externalReference: String(reference).trim(),
    metadata: value === undefined ? null : { amount: value },
    idempotencyKey,
  });
  return result;
}

async function voidPayment({ tenantId, connectionId, reference, idempotencyKey = null }) {
  if (!String(reference || '').trim()) throw new IntegrationConfigError('A payment reference is required.');
  const { result } = await executeOperation({
    tenantId, connectionId, capability: 'voidPayment', operation: 'voidPayment',
    args: [String(reference).trim()], externalReference: String(reference).trim(),
    idempotencyKey,
  });
  return result;
}

async function createPaymentLink({ tenantId, connectionId, payment, idempotencyKey = null }) {
  const input = assertPaymentInput(payment);
  const { result } = await executeOperation({
    tenantId, connectionId, capability: 'createPaymentLink', operation: 'createPaymentLink',
    args: [input], externalReference: input.reference,
    metadata: { amount: input.amount, currency: input.currency },
    idempotencyKey,
  });
  return result;
}

/* --------------------------------------------------------- banking / POS */

async function getAccounts({ tenantId, connectionId }) {
  const { result } = await executeOperation({
    tenantId, connectionId, capability: 'getAccounts', operation: 'getAccounts',
  });
  return result;
}

async function getBalance({ tenantId, connectionId, params = {} }) {
  const { result } = await executeOperation({
    tenantId, connectionId, capability: 'getBalance', operation: 'getBalance',
    args: [params && typeof params === 'object' ? params : {}],
  });
  return result;
}

async function getTransactions({ tenantId, connectionId, params = {} }) {
  const { result } = await executeOperation({
    tenantId, connectionId, capability: 'getTransactions', operation: 'getTransactions',
    args: [params && typeof params === 'object' ? params : {}],
  });
  return result;
}

async function initiateTransfer({ tenantId, connectionId, transfer, idempotencyKey = null }) {
  const input = assertTransferInput(transfer);
  const { result } = await executeOperation({
    tenantId, connectionId, capability: 'initiateTransfer', operation: 'initiateTransfer',
    args: [input], externalReference: input.reference,
    metadata: { amount: input.amount, currency: input.currency },
    idempotencyKey,
  });
  return result;
}

async function getTransferStatus({ tenantId, connectionId, reference }) {
  if (!String(reference || '').trim()) throw new IntegrationConfigError('A transfer reference is required.');
  const { result } = await executeOperation({
    tenantId, connectionId, capability: 'getTransferStatus', operation: 'getTransferStatus',
    args: [String(reference).trim()], externalReference: String(reference).trim(),
  });
  return result;
}

async function verifyAccount({ tenantId, connectionId, account, idempotencyKey = null }) {
  if (!account || typeof account !== 'object' || !String(account.number || account.accountNumber || '').trim()) {
    throw new IntegrationConfigError('An account number is required for verification.');
  }
  const input = {
    number: String(account.number || account.accountNumber).trim().slice(0, 60),
    name: account.name ? String(account.name).slice(0, 120) : undefined,
    branch: account.branch ? String(account.branch).slice(0, 120) : undefined,
  };
  const { result } = await executeOperation({
    tenantId, connectionId, capability: 'verifyAccount', operation: 'verifyAccount',
    args: [input],
    metadata: { account: input.number.slice(-4) ? `••••${input.number.slice(-4)}` : 'provided' },
    idempotencyKey,
  });
  return result;
}

/* ----------------------------------------------------------- synchronisation */

/** Runs one sync or poll operation and normalises its counts for callers. */
async function sync({ tenantId, connectionId, resource = 'customers', params = {}, idempotencyKey = null }) {
  const operation = `sync${String(resource).charAt(0).toUpperCase()}${String(resource).slice(1)}`;
  if (!CAPABILITY_IDS.includes(operation) && operation !== 'pollSync') {
    throw new IntegrationConfigError(`Unknown sync resource '${resource}'.`);
  }
  const { result } = await executeOperation({
    tenantId, connectionId, capability: operation, operation,
    args: [params && typeof params === 'object' ? params : {}],
    metadata: { resource },
    idempotencyKey,
  });
  return results.syncResult(result, { resource });
}

/* ------------------------------------------------------------------ webhooks */

/**
 * Provider → Webhook → Integration Gateway → internal event log (+ pipeline).
 *
 * The route is `POST /api/integrations/webhooks/:providerId/:webhookToken`.
 * The webhook token is a per-connection unguessable secret issued at creation:
 * unknown provider → 404, unknown token → 404, bad signature → 401. Only a
 * verified payload is ever parsed, and parsing is strictly the adapter's job.
 *
 * PR #71 adds the remaining normalisation stages of the framework contract:
 * identify provider → verify → NORMALISE (results.providerEvent) → DEDUPE
 * (fingerprint against the durable event log so provider retry storms create
 * one internal record) → record event → DISPATCH to application handlers via
 * pipeline.js. Dispatch runs with the connection's tenant only — a payload
 * can never steer an event into another tenant.
 *
 * Wiring provider events into the payment lifecycle stays a later phase
 * (unchanged from PR #68): the pipeline has no production subscribers yet,
 * so verified webhooks are recorded and handed to whoever subscribes.
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

  /* ---- PR #71: normalise → dedupe → record → dispatch ---- */
  const event = results.providerEvent(parsed, {
    providerId: id, connectionId: connection.id, tenantId,
  });
  const fingerprint = idempotency.webhookFingerprint({ connectionId: connection.id, event });

  const prior = await findMatchingWebhookEvent({ connectionId: connection.id, reference: event.reference, fingerprint });
  if (prior) {
    await logEvent({
      tenantId, connectionId: connection.id, providerId: id,
      operation: 'receiveWebhook', success: true, externalReference: event.reference,
      metadata: { duplicate: true, whDigest: fingerprint.slice(0, 32), note: 'Identical provider redelivery; already processed.' },
    });
    return {
      received: true, handled: true, duplicate: true,
      reference: event.reference, transactionId: event.transactionId, paid: event.status === 'PAID',
    };
  }

  const dispatchOutcome = await pipeline.dispatch({ tenantId, connectionId: connection.id, providerId: id, capability: 'receiveWebhook', event });
  if (dispatchOutcome.failures.length) {
    // Handler failures are audit-logged (never break the provider response)
    // and recorded as a dispatch-failed event so the SAME payload is safely
    // re-dispatched on the provider's next redelivery.
    await logEvent({
      tenantId, connectionId: connection.id, providerId: id,
      operation: 'receiveWebhook', success: false, externalReference: event.reference,
      errorCategory: 'INTERNAL',
      errorMessage: `Event handlers failed: ${dispatchOutcome.failures.map((f) => f.label).join(', ')}`,
      retryable: true,
      metadata: { whDigest: fingerprint.slice(0, 32), dispatch: 'FAILED' },
    });
  }
  await logEvent({
    tenantId, connectionId: connection.id, providerId: id,
    operation: 'receiveWebhook', success: true, externalReference: event.reference,
    metadata: adapter.redactForLog({
      transactionId: event.transactionId,
      paid: event.status === 'PAID',
      amount: event.amount,
      currency: event.currency,
      whDigest: fingerprint.slice(0, 32),
      dispatch: dispatchOutcome.status,
    }),
  });
  await touchConnection(connection.id, { lastSyncAt: new Date(), lastSyncStatus: 'WEBHOOK_RECEIVED', lastError: null });
  return {
    received: true,
    handled: true,
    reference: event.reference,
    transactionId: event.transactionId,
    paid: event.status === 'PAID',
    dispatched: dispatchOutcome.status,
  };
}

/** Find a successfully-dispatched, identical webhook event for dedupe. */
async function findMatchingWebhookEvent({ connectionId, reference, fingerprint }) {
  try {
    const rows = await prisma.integrationEvent.findMany({
      where: { connectionId, operation: 'receiveWebhook', success: true, externalReference: reference },
      orderBy: { createdAt: 'desc' },
      take: 25,
    });
    for (const row of rows) {
      const md = parseJson(row.metadata, {});
      if (md.whDigest === fingerprint.slice(0, 32) && md.dispatch !== 'FAILED' && !md.duplicate) return row;
    }
    return null;
  } catch (_) {
    return null;
  }
}

/* ---------------------------------------------------------------- reconcile */

async function reconcile({ tenantId, connectionId, params = {} }) {
  const { connection, result } = await executeOperation({
    tenantId, connectionId, capability: 'reconcile', operation: 'reconcile',
    args: [params && typeof params === 'object' ? params : {}],
  });
  await touchConnection(connection.id, { lastSyncAt: new Date(), lastSyncStatus: 'RECONCILED', lastError: null });
  return result;
}

/* ------------------------------------------------ generic operation dispatch */

/**
 * The operation whitelist for `POST /:id/operations/:operation` — the single
 * generic entry point application code (and future UI) uses for any operation
 * that doesn't need a dedicated typed route. Every entry maps a stable
 * operation name to its capability gate + adapter method + normaliser, so
 * provider-specific methods NEVER leak into application code: the gateway
 * only ever speaks this contract.
 */
const EXECUTABLE_OPERATIONS = {
  testConnection: {
    capability: 'testConnection',
    normalize: (r, ctx) => results.connectionResult({ ok: true, provider: ctx.providerId, connectionId: ctx.connectionId, status: 'CONNECTED', message: r && r.message }),
  },
  connect: {
    capability: 'connect',
    normalize: (r, ctx) => results.connectionResult({ ok: true, provider: ctx.providerId, connectionId: ctx.connectionId, status: 'CONNECTED', message: r && r.message }),
  },
  disconnect: {
    capability: 'disconnect',
    normalize: (r, ctx) => results.connectionResult({ ok: true, provider: ctx.providerId, connectionId: ctx.connectionId, status: 'DISCONNECTED', message: r && r.message }),
  },
  createPayment: {
    capability: 'createPayment', idempotent: true,
    args: (payload) => [assertPaymentInput(payload)],
    reference: (payload) => payload && payload.reference,
    normalize: (r, ctx) => results.paymentResult(r, ctx),
  },
  getPaymentStatus: {
    capability: 'getPaymentStatus',
    args: (payload) => [String((payload && payload.reference) || '').trim()],
    requiresReference: true,
    normalize: (r, ctx) => results.paymentResult(r, ctx),
  },
  verifyPayment: {
    capability: 'verifyPayment',
    args: (payload) => [String((payload && payload.reference) || '').trim()],
    requiresReference: true,
    normalize: (r, ctx) => results.paymentResult({ ...r, status: r && r.paid ? 'PAID' : (r && r.status) || 'UNKNOWN' }, ctx),
  },
  capturePayment: {
    capability: 'capturePayment', idempotent: true,
    args: (payload) => [String((payload && payload.reference) || '').trim(), payload && payload.amount !== undefined && payload.amount !== null ? Number(payload.amount) : undefined],
    requiresReference: true,
    normalize: (r, ctx) => results.paymentResult(r, ctx),
  },
  refundPayment: {
    capability: 'refundPayment', idempotent: true,
    args: (payload) => [String((payload && payload.reference) || '').trim(), payload && payload.amount !== undefined && payload.amount !== null ? Number(payload.amount) : undefined],
    requiresReference: true,
    normalize: (r, ctx) => ({ ...r, provider: ctx.providerId, amount: r && r.amount !== undefined ? Number(r.amount) : null }),
  },
  voidPayment: {
    capability: 'voidPayment', idempotent: true,
    args: (payload) => [String((payload && payload.reference) || '').trim()],
    requiresReference: true,
    normalize: (r, ctx) => results.paymentResult({ ...r, status: 'CANCELLED' }, ctx),
  },
  createPaymentLink: {
    capability: 'createPaymentLink', idempotent: true,
    args: (payload) => [assertPaymentInput(payload)],
    reference: (payload) => payload && payload.reference,
    normalize: (r, ctx) => results.paymentResult(r, ctx),
  },
  getAccounts: {
    capability: 'getAccounts',
    normalize: (r, ctx) => ({ accounts: (Array.isArray(r) ? r : []).map((a) => results.accountResult(a, ctx)) }),
  },
  getBalance: {
    capability: 'getBalance',
    args: (payload) => [payload && typeof payload === 'object' ? payload : {}],
    normalize: (r, ctx) => results.balanceResult(r, ctx),
  },
  getTransactions: {
    capability: 'getTransactions',
    args: (payload) => [payload && typeof payload === 'object' ? payload : {}],
    normalize: (r, ctx) => {
      const list = Array.isArray(r) ? r : (r && Array.isArray(r.transactions) ? r.transactions : []);
      return { transactions: list.map((t) => results.transactionResult(t, ctx)), nextCursor: r && r.nextCursor ? r.nextCursor : null };
    },
  },
  initiateTransfer: {
    capability: 'initiateTransfer', idempotent: true,
    args: (payload) => [assertTransferInput(payload)],
    reference: (payload) => payload && payload.reference,
    normalize: (r, ctx) => results.transferResult(r, ctx),
  },
  getTransferStatus: {
    capability: 'getTransferStatus',
    args: (payload) => [String((payload && payload.reference) || '').trim()],
    requiresReference: true,
    normalize: (r, ctx) => results.transferResult({ ...(r || {}), reference: (r && r.reference) || (ctx.reference) }, ctx),
  },
  verifyAccount: {
    capability: 'verifyAccount', idempotent: true,
    args: (payload) => [payload && typeof payload === 'object' ? payload : {}],
    normalize: (r) => r,
  },
  createPosTransaction: {
    capability: 'createPosTransaction', idempotent: true,
    args: (payload) => [payload && typeof payload === 'object' ? payload : {}],
    reference: (payload) => payload && payload.reference,
    normalize: (r, ctx) => results.transactionResult(r, ctx),
  },
  getPosTransaction: {
    capability: 'getPosTransaction',
    args: (payload) => [String((payload && payload.reference) || '').trim()],
    requiresReference: true,
    normalize: (r, ctx) => results.transactionResult(r, ctx),
  },
  syncCustomers: { capability: 'syncCustomers', idempotent: true, syncResource: 'customers' },
  syncProducts: { capability: 'syncProducts', idempotent: true, syncResource: 'products' },
  syncInventory: { capability: 'syncInventory', idempotent: true, syncResource: 'inventory' },
  syncInvoices: { capability: 'syncInvoices', idempotent: true, syncResource: 'invoices' },
  syncPayments: { capability: 'syncPayments', idempotent: true, syncResource: 'payments' },
  pollSync: { capability: 'pollSync', idempotent: true, syncResource: 'poll' },
  reconcile: { capability: 'reconcile', idempotent: true, args: (payload) => [payload && typeof payload === 'object' ? payload : {}] },
  importStatement: {
    capability: 'importStatement', idempotent: true,
    args: (payload) => [normaliseImportPayload(payload)],
    normalize: (r, ctx) => results.syncResult(r, { ...ctx, resource: 'statement' }),
  },
};

function normaliseImportPayload(payload = {}) {
  const filename = String(payload.filename || 'statement.csv').slice(0, 120);
  if (typeof payload.contentsBase64 === 'string' && payload.contentsBase64) {
    const buf = Buffer.from(payload.contentsBase64, 'base64');
    if (!buf.length || buf.length > 2 * 1024 * 1024) {
      throw new IntegrationConfigError('Import contents must be non-empty and at most 2 MB.');
    }
    return { filename, contents: buf.toString('utf8') };
  }
  if (Array.isArray(payload.rows)) return { filename, rows: payload.rows.slice(0, 20000) };
  throw new IntegrationConfigError('Statement import requires `contentsBase64` or `rows`.');
}

/**
 * Execute one whitelisted provider operation end-to-end.
 * @returns {Promise<{ result, normalized, replayed, connection }>}
 */
async function execute({ tenantId, connectionId, operation, payload = {}, idempotencyKey = null }) {
  const spec = EXECUTABLE_OPERATIONS[operation];
  if (!spec) {
    throw new IntegrationConfigError(
      `Operation '${String(operation).slice(0, 60)}' is not part of the standard provider contract. Supported: ${Object.keys(EXECUTABLE_OPERATIONS).join(', ')}.`
    );
  }
  if (spec.requiresReference && !String((payload && payload.reference) || '').trim()) {
    throw new IntegrationConfigError(`Operation '${operation}' requires a 'reference'.`);
  }
  let args;
  if (spec.syncResource) args = [payload && typeof payload === 'object' ? payload : {}];
  else if (spec.args) args = spec.args(payload || {});
  else args = [];
  const reference = typeof spec.reference === 'function' ? spec.reference(payload || {}) : undefined;
  const exec = await executeOperation({
    tenantId, connectionId, capability: spec.capability, operation,
    args,
    externalReference: reference || (payload && payload.reference) || null,
    metadata: reference || (payload && payload.reference) ? { reference: String(reference || payload.reference).slice(0, 200) } : null,
    idempotencyKey,
  });
  const ctx = {
    providerId: exec.connection.providerId,
    connectionId: exec.connection.id,
    reference: (payload && payload.reference) || undefined,
    resource: spec.syncResource,
  };
  const normalized = spec.syncResource
    ? results.syncResult(exec.result, ctx)
    : (spec.normalize ? spec.normalize(exec.result || {}, ctx) : exec.result);
  return {
    result: exec.result,
    normalized,
    replayed: Boolean(exec.replayed),
    durableReplay: Boolean(exec.durableReplay),
    connectionId: exec.connection.id,
    providerId: exec.connection.providerId,
    capability: spec.capability,
  };
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
  IDEMPOTENT_OPERATIONS,
  EXECUTABLE_OPERATIONS,
  sandboxSecret,
  parseJson,
  getConnectionForTenant,
  decryptConnectionSecrets,
  connectionConfig,
  adapterFor,
  safeConnection,
  capabilityMatrix,
  normaliseError,
  executeOperation,
  runOperation,
  testConnection,
  connect,
  reconnect,
  disconnect,
  setEnabled,
  rotateCredentials,
  mergeSecrets,
  createPayment,
  getPaymentStatus,
  verifyPayment,
  capturePayment,
  voidPayment,
  refundPayment,
  createPaymentLink,
  getAccounts,
  getBalance,
  getTransactions,
  initiateTransfer,
  getTransferStatus,
  verifyAccount,
  sync,
  execute,
  reconcile,
  handleWebhook,
  toHttpError,
};
