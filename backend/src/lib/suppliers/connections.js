/**
 * Connection lifecycle service.
 *
 * Wraps the connector's connect / testConnection / disconnect capabilities and
 * persists the outcome on the SupplierIntegration row, so the Admin UI always
 * shows the real state of a supplier link — including the honest
 * "Not connected — credentials required" state.
 */
const prisma = require('../prisma');
const registry = require('./registry');
const syncEngine = require('./sync-engine');
const { decryptSecrets, redactString } = require('./credentials');
const { audit } = require('../audit');

const STATUSES = ['NOT_CONNECTED', 'CONFIGURED', 'CONNECTED', 'DISABLED', 'ERROR'];

async function load({ tenantId = 'default', integrationId }) {
  const integration = await prisma.supplierIntegration.findFirst({
    where: { id: integrationId, tenantId }, include: { supplier: true },
  });
  if (!integration) throw Object.assign(new Error('Integration not found'), { status: 404 });
  return integration;
}

/** Capabilities currently available, computed from the live configuration. */
async function detectCapabilities({ tenantId = 'default', integrationId }) {
  const integration = await load({ tenantId, integrationId });
  const adapter = await syncEngine.adapterFor(integration, integration.supplier);
  const Connector = registry.get(integration.connectorType);
  const possible = Connector ? Connector.capabilities : [];
  const available = adapter.capabilities();
  return {
    connectorType: integration.connectorType,
    hasCredentials: adapter.hasCredentials(),
    capabilities: possible.map((id) => ({ id, available: available.includes(id) })),
    missingCredentials: !adapter.hasCredentials(),
  };
}

/**
 * Tests the connection for real and records the outcome.
 * A failure is never hidden — it lands in `lastError` and the status becomes
 * ERROR (or stays NOT_CONNECTED when credentials are simply absent).
 */
async function testConnection({ tenantId = 'default', integrationId, actorId = null, req = null }) {
  const integration = await load({ tenantId, integrationId });
  let adapter;
  try {
    adapter = await syncEngine.adapterFor(integration, integration.supplier);
  } catch (err) {
    await prisma.supplierIntegration.update({
      where: { id: integration.id },
      data: { status: 'ERROR', lastError: err.message.slice(0, 400), lastTestedAt: new Date() },
    });
    throw err;
  }

  if (!adapter.supports('testConnection')) {
    const message = `${integration.connectorType} does not implement a connection test.`;
    await prisma.supplierIntegration.update({
      where: { id: integration.id }, data: { lastTestedAt: new Date(), lastError: message },
    });
    return { ok: true, tested: false, message, status: integration.status };
  }

  if (!adapter.hasCredentials()) {
    const message = 'Not connected — credentials required';
    await prisma.supplierIntegration.update({
      where: { id: integration.id },
      data: { status: 'NOT_CONNECTED', lastError: message, lastTestedAt: new Date() },
    });
    if (req) await audit(req, 'TEST_CONNECTION', 'SupplierIntegration', integration.id, { result: 'credentials_required' });
    return { ok: false, tested: true, connected: false, message, status: 'NOT_CONNECTED' };
  }

  try {
    const result = await adapter.testConnection();
    await prisma.supplierIntegration.update({
      where: { id: integration.id },
      data: {
        status: 'CONNECTED',
        lastTestedAt: new Date(),
        lastConnectedAt: new Date(),
        lastError: result.warnings?.length ? result.warnings.join('; ') : null,
      },
    });
    if (req) await audit(req, 'TEST_CONNECTION', 'SupplierIntegration', integration.id, { result: 'ok' });
    return { ok: true, tested: true, connected: true, ...result, status: 'CONNECTED' };
  } catch (err) {
    let secretValues = [];
    try { secretValues = Object.values(decryptSecrets(integration.credentialsCipher)); } catch (_) { /* nothing to redact */ }
    const message = redactString(err.message || 'Connection test failed', secretValues);
    const status = err.code === 'NOT_CONNECTED' ? 'NOT_CONNECTED' : 'ERROR';
    await prisma.supplierIntegration.update({
      where: { id: integration.id },
      data: { status, lastTestedAt: new Date(), lastError: message.slice(0, 400) },
    });
    if (req) await audit(req, 'TEST_CONNECTION', 'SupplierIntegration', integration.id, { result: 'failed' });
    return { ok: false, tested: true, connected: false, message, status, code: err.code };
  }
}

async function connect({ tenantId = 'default', integrationId, actorId = null, req = null }) {
  const integration = await load({ tenantId, integrationId });
  const adapter = await syncEngine.adapterFor(integration, integration.supplier);
  if (!adapter.supports('connect')) {
    return testConnection({ tenantId, integrationId, actorId, req });
  }
  if (!adapter.hasCredentials()) {
    await prisma.supplierIntegration.update({
      where: { id: integration.id },
      data: { status: 'NOT_CONNECTED', lastError: 'Not connected — credentials required', lastTestedAt: new Date() },
    });
    throw Object.assign(new Error('Not connected — credentials required'), { status: 400, code: 'NOT_CONNECTED' });
  }
  try {
    const result = await adapter.connect();
    await prisma.supplierIntegration.update({
      where: { id: integration.id },
      data: { status: 'CONNECTED', lastConnectedAt: new Date(), lastTestedAt: new Date(), lastError: null },
    });
    if (req) await audit(req, 'CONNECT', 'SupplierIntegration', integration.id, { result: 'ok' });
    return { ok: true, ...result, status: 'CONNECTED' };
  } catch (err) {
    const message = redactString(err.message || 'Connection failed', []);
    await prisma.supplierIntegration.update({
      where: { id: integration.id }, data: { status: 'ERROR', lastError: message.slice(0, 400), lastTestedAt: new Date() },
    });
    throw Object.assign(new Error(message), { status: 502, code: err.code || 'CONNECT_FAILED' });
  }
}

async function disconnect({ tenantId = 'default', integrationId, req = null }) {
  const integration = await load({ tenantId, integrationId });
  let message = 'Disconnected.';
  try {
    const adapter = await syncEngine.adapterFor(integration, integration.supplier);
    if (adapter.supports('disconnect')) {
      const result = await adapter.disconnect();
      message = result.message || message;
    }
  } catch (err) {
    message = `Connector teardown reported: ${err.message}`;
  }
  const updated = await prisma.supplierIntegration.update({
    where: { id: integration.id },
    data: { status: 'CONFIGURED', lastConnectedAt: null, lastError: null, syncEnabled: false },
  });
  if (req) await audit(req, 'DISCONNECT', 'SupplierIntegration', integration.id);
  return { ok: true, message, integration: updated };
}

/** Enables or disables an integration (disabling also stops scheduled syncs). */
async function setEnabled({ tenantId = 'default', integrationId, enabled }) {
  const integration = await load({ tenantId, integrationId });
  if (enabled && integration.status === 'NOT_CONNECTED') {
    throw Object.assign(new Error('Connect the integration before enabling it'), { status: 409 });
  }
  return prisma.supplierIntegration.update({
    where: { id: integration.id },
    data: { status: enabled ? (integration.status === 'DISABLED' ? 'CONFIGURED' : integration.status) : 'DISABLED', syncEnabled: Boolean(enabled) && integration.syncEnabled },
  });
}

module.exports = { STATUSES, testConnection, connect, disconnect, detectCapabilities, setEnabled, load };
