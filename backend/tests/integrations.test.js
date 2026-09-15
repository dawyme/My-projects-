/**
 * Universal Banking & Payment Integration Framework — verification.
 *
 * Boots the real Express app and drives the Integration Gateway through its
 * HTTP API plus focused unit checks: provider registration, capability
 * detection, tenant isolation, connection lifecycle, unsupported-capability
 * handling, webhook verification, error taxonomy, secret redaction,
 * integration logging, provider selection and RBAC.
 *
 * Only the two phase-1 proof-of-design adapters exist (MANUAL_BANK_TRANSFER
 * and SANDBOX_DEMO), so no real network, bank or money movement is possible:
 * the demo adapter refuses to run in production and its redirect URL targets
 * the unresolvable `.invalid` TLD.
 *
 *   node backend/tests/integrations.test.js
 */
require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// Widen request budgets for this suite rather than weakening the app.
process.env.RATE_LIMIT_API_MAX = process.env.RATE_LIMIT_API_MAX || '20000';
process.env.RATE_LIMIT_WRITE_MAX = process.env.RATE_LIMIT_WRITE_MAX || '20000';

const app = require('../src/app');
const prisma = require('../src/lib/prisma');
const registry = require('../src/lib/integrations/registry');
const gateway = require('../src/lib/integrations/gateway');
const {
  IntegrationProvider,
  IntegrationError,
  UnsupportedCapabilityError,
  CAPABILITY_IDS,
} = require('../src/lib/integrations/base');
const { _resetSandboxLedger } = require('../src/lib/integrations/adapters/sandbox-psp');

let base = '';
const results = [];
let failures = 0;
const suiteStart = new Date();
const trackedConnectionIds = [];

async function test(name, fn) {
  try { await fn(); results.push(['PASS', name]); }
  catch (e) { failures++; results.push(['FAIL', `${name} — ${e.message}`]); }
}

function makeClient() {
  const jar = new Map();
  let csrf = null;
  let bearer = null;
  return {
    setBearer(t) { bearer = t; },
    async req(method, path, body, opts = {}) {
      const headers = { ...(opts.headers || {}) };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookie) headers.Cookie = cookie;
      if (csrf) headers['x-csrf-token'] = csrf;
      if (bearer && !opts.noBearer) headers.Authorization = `Bearer ${bearer}`;
      const res = await fetch(base + path, {
        method, headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
      });
      for (const c of res.headers.getSetCookie?.() || []) {
        const [pair] = c.split(';');
        const idx = pair.indexOf('=');
        jar.set(pair.slice(0, idx), pair.slice(idx + 1));
        if (pair.startsWith('hvac_csrf=')) csrf = pair.slice('hvac_csrf='.length);
      }
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) {}
      return { status: res.status, body: json, text };
    },
    get(p, o) { return this.req('GET', p, undefined, o); },
    post(p, b, o) { return this.req('POST', p, b, o); },
    put(p, b, o) { return this.req('PUT', p, b, o); },
    patch(p, b, o) { return this.req('PATCH', p, b, o); },
    del(p, o) { return this.req('DELETE', p, undefined, o); },
  };
}

function signHmac(secret, rawBody) {
  return `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

async function main() {
  _resetSandboxLedger();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const admin = makeClient();
  const staff = makeClient();
  const anon = makeClient();

  /* ---------------------------------------------------------- unit: base */
  await test('unit: base provider rejects every capability safely', async () => {
    const p = new IntegrationProvider({ connection: { providerId: 'base' } });
    assert.deepStrictEqual(p.capabilities(), []);
    assert.strictEqual(p.supports('createPayment'), false);
    for (const op of ['connect', 'testConnection', 'createPayment', 'getPaymentStatus', 'verifyPayment',
      'refundPayment', 'voidPayment', 'createPaymentLink', 'reconcile', 'importStatement']) {
      await assert.rejects(() => p[op]({}), (e) => e instanceof UnsupportedCapabilityError && e.code === 'UNSUPPORTED_CAPABILITY');
    }
    assert.strictEqual(await p.verifyWebhook('x', {}), false);
    assert.strictEqual(await p.parseWebhook('x', {}, {}), null);
  });

  await test('unit: provider registration round-trip', async () => {
    class TempBank extends IntegrationProvider {
      static id = 'TEMP_UNIT_BANK';
      static label = 'Temp Unit Bank';
      static category = 'BANK';
      static connectionMethods = ['MANUAL'];
      static capabilities = ['configure'];
    }
    assert.strictEqual(registry.has('TEMP_UNIT_BANK'), false);
    registry.register(TempBank);
    assert.strictEqual(registry.has('TEMP_UNIT_BANK'), true);
    assert.strictEqual(registry.get('TEMP_UNIT_BANK'), TempBank);
    assert.ok(registry.list().some((p) => p.id === 'TEMP_UNIT_BANK'));
    const adapter = registry.create({ connection: { providerId: 'TEMP_UNIT_BANK' } });
    assert.ok(adapter instanceof IntegrationProvider);
    assert.deepStrictEqual(adapter.capabilities(), ['configure']);
    assert.strictEqual(registry.unregister('TEMP_UNIT_BANK'), true);
    assert.strictEqual(registry.get('TEMP_UNIT_BANK'), null);
  });

  await test('unit: registry rejects invalid registrations', async () => {
    assert.throws(() => registry.register(class NotAProvider {}), TypeError);
    class NoId extends IntegrationProvider {}
    assert.throws(() => registry.register(NoId), TypeError);
    class BadCategory extends IntegrationProvider {
      static id = 'BAD_CAT_X';
      static category = 'NOPE';
    }
    assert.throws(() => registry.register(BadCategory), TypeError);
    assert.strictEqual(registry.create({ connection: { providerId: 'DOES_NOT_EXIST' } }), null);
  });

  await test('unit: capability detection across phase-1 adapters', async () => {
    const manual = registry.create({ connection: { providerId: 'MANUAL_BANK_TRANSFER' } });
    const demo = registry.create({ connection: { providerId: 'SANDBOX_DEMO' } });
    assert.ok(manual && demo);
    assert.strictEqual(manual.constructor.category, 'BANK');
    assert.strictEqual(demo.constructor.category, 'PSP');
    // Manual bank transfer: no electronic capabilities whatsoever.
    for (const c of ['refundPayment', 'voidPayment', 'getPaymentStatus', 'verifyPayment', 'receiveWebhook', 'reconcile']) {
      assert.strictEqual(manual.supports(c), false, `manual must not advertise ${c}`);
    }
    assert.strictEqual(manual.supports('createPayment'), true);
    // Demo PSP: full hosted-checkout surface.
    for (const c of ['createPayment', 'getPaymentStatus', 'verifyPayment', 'refundPayment', 'receiveWebhook']) {
      assert.strictEqual(demo.supports(c), true, `demo must advertise ${c}`);
    }
    assert.strictEqual(demo.supports('reconcile'), false);
    assert.ok(CAPABILITY_IDS.length >= 13);
  });

  await test('unit: error taxonomy maps to stable HTTP responses', async () => {
    assert.deepStrictEqual(
      gateway.toHttpError(Object.assign(new IntegrationError('x'), { notFound: true })).status, 404
    );
    const unsupported = new UnsupportedCapabilityError('MANUAL_BANK_TRANSFER', 'refundPayment');
    const http = gateway.toHttpError(unsupported);
    assert.strictEqual(http.status, 400);
    assert.strictEqual(http.code, 'UNSUPPORTED_CAPABILITY');
    assert.strictEqual(http.category, 'UNSUPPORTED');
    assert.strictEqual(http.retryable, false);
    assert.strictEqual(gateway.toHttpError(new Error('boom')).status, 502);
  });

  await test('unit: unknown provider rows fail closed, never half-open', async () => {
    assert.throws(
      () => gateway.adapterFor({ providerId: 'NO_SUCH_PROVIDER', businessId: 'default' }),
      (e) => e.code === 'INTEGRATION_NOT_CONFIGURED'
    );
  });

  await test('unit: sandbox demo refuses to run in production', async () => {
    const demo = registry.create({ connection: { id: 'unit', providerId: 'SANDBOX_DEMO' } });
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await assert.rejects(() => demo.createPayment({ amount: 1, reference: 'X' }), /never available in production/);
      await assert.rejects(() => demo.testConnection(), /never available in production/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  /* --------------------------------------------------------------- auth */
  await test('admin + staff login', async () => {
    await admin.get('/api/csrf-token');
    await staff.get('/api/csrf-token');
    await anon.get('/api/csrf-token');
    const a = await admin.post('/api/auth/login', { email: 'admin@ndsairconditioning.com', password: 'Admin@12345' });
    assert.strictEqual(a.status, 200);
    admin.setBearer(a.body.data.accessToken);
    const s = await staff.post('/api/auth/login', { email: 'staff@ndsairconditioning.com', password: 'Staff@12345' });
    assert.strictEqual(s.status, 200);
    staff.setBearer(s.body.data.accessToken);
  });

  await test('RBAC: staff and anonymous callers are rejected', async () => {
    assert.strictEqual((await staff.get('/api/integrations/providers')).status, 403);
    assert.strictEqual((await staff.get('/api/integrations')).status, 403);
    assert.strictEqual((await staff.post('/api/integrations', { providerId: 'X', name: 'y' })).status, 403);
    assert.strictEqual((await anon.get('/api/integrations/providers')).status, 401);
    assert.strictEqual((await anon.get('/api/integrations')).status, 401);
  });

  /* ------------------------------------------------------------ catalogue */
  await test('GET /providers catalogues adapters, categories, capabilities, methods', async () => {
    const r = await admin.get('/api/integrations/providers');
    assert.strictEqual(r.status, 200);
    const ids = r.body.data.map((p) => p.id);
    assert.ok(ids.includes('MANUAL_BANK_TRANSFER'));
    assert.ok(ids.includes('SANDBOX_DEMO'));
    const manual = r.body.data.find((p) => p.id === 'MANUAL_BANK_TRANSFER');
    assert.strictEqual(manual.category, 'BANK');
    assert.deepStrictEqual(manual.connectionMethods.map((m) => m.id), ['MANUAL']);
    const refund = manual.capabilities.find((c) => c.id === 'refundPayment');
    assert.strictEqual(refund.supported, false);
    assert.strictEqual(manual.capabilities.find((c) => c.id === 'createPayment').supported, true);
    const cats = r.body.meta.categories.map((c) => c.id);
    for (const c of ['BANK', 'PSP', 'POS', 'ACCOUNTING']) assert.ok(cats.includes(c), `missing category ${c}`);
    assert.ok(r.body.meta.capabilities.length >= 13);
    assert.ok(r.body.meta.connectionMethods.some((m) => m.id === 'MANUAL'));
    assert.ok(r.body.meta.connectionMethods.some((m) => m.id === 'OPEN_BANKING'));
    // No secrets or ciphers in the catalogue.
    assert.ok(!JSON.stringify(r.body).includes('credentialsCipher'));
  });

  /* ------------------------------------------------- provider selection */
  await test('provider selection rejects unknown providers and mismatched auth/methods', async () => {
    const unknown = await admin.post('/api/integrations', { providerId: 'FAKE_BANK_X', name: 'Nope' });
    assert.strictEqual(unknown.status, 400);
    assert.match(unknown.body.error, /Unknown provider/);
    const badAuth = await admin.post('/api/integrations', {
      providerId: 'MANUAL_BANK_TRANSFER', name: 'Bad auth', authType: 'OAUTH2',
    });
    assert.strictEqual(badAuth.status, 400);
    assert.match(badAuth.body.error, /does not support OAUTH2/);
    const badMethod = await admin.post('/api/integrations', {
      providerId: 'MANUAL_BANK_TRANSFER', name: 'Bad method', connectionMethod: 'SFTP',
    });
    assert.strictEqual(badMethod.status, 400);
    assert.match(badMethod.body.error, /does not support the SFTP/);
  });

  /* ------------------------------------------------------ lifecycle: manual */
  let manualId;
  let manualToken;
  await test('create manual bank connection (client businessId is ignored)', async () => {
    const r = await admin.post('/api/integrations', {
      providerId: 'manual_bank_transfer', // normalised to upper-case
      name: `TT Bank ${Date.now()}`,
      businessId: 'some-other-tenant', // must be stripped — tenant comes from the session
      config: { bankName: 'Test Bank T&T', accountName: 'N&D Services', accountNumber: '987654' },
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.data.providerId, 'MANUAL_BANK_TRANSFER');
    assert.strictEqual(r.body.data.providerCategory, 'BANK');
    assert.strictEqual(r.body.data.status, 'CONFIGURED');
    assert.strictEqual(r.body.data.businessId, 'default');
    assert.ok(!('credentialsCipher' in r.body.data), 'cipher must never be serialised');
    // Unguessable per-connection webhook path token (UUID v4 — 122 random bits).
    assert.match(r.body.data.webhookToken, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    manualId = r.body.data.id;
    manualToken = r.body.data.webhookToken;
    trackedConnectionIds.push(manualId);
    const row = await prisma.integrationConnection.findUnique({ where: { id: manualId } });
    assert.strictEqual(row.businessId, 'default');
  });

  await test('duplicate connection names are rejected per tenant', async () => {
    const existing = await prisma.integrationConnection.findUnique({ where: { id: manualId } });
    const r = await admin.post('/api/integrations', { providerId: 'SANDBOX_DEMO', name: existing.name });
    assert.strictEqual(r.status, 409);
  });

  await test('detail exposes capability matrix, provider description and recent events', async () => {
    const r = await admin.get(`/api/integrations/${manualId}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.data.provider.id, 'MANUAL_BANK_TRANSFER');
    const matrix = new Map(r.body.data.capabilityMatrix.map((c) => [c.id, c.supported]));
    assert.strictEqual(matrix.get('createPayment'), true);
    assert.strictEqual(matrix.get('refundPayment'), false);
    assert.strictEqual(matrix.get('receiveWebhook'), false);
    assert.ok(Array.isArray(r.body.data.recentEvents));
    assert.ok(r.body.data.recentEvents.some((e) => e.operation === 'connectionCreated' && e.success === true));
  });

  await test('testConnection transitions CONFIGURED → CONNECTED and clears errors', async () => {
    const r = await admin.post(`/api/integrations/${manualId}/test`, {});
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.data.ok, true);
    const row = await prisma.integrationConnection.findUnique({ where: { id: manualId } });
    assert.strictEqual(row.status, 'CONNECTED');
    assert.ok(row.lastTestedAt);
    assert.strictEqual(row.lastError, null);
  });

  await test('incomplete manual config fails the test with actionable error + ERROR status', async () => {
    const created = await admin.post('/api/integrations', {
      providerId: 'MANUAL_BANK_TRANSFER', name: `Incomplete ${Date.now()}`, config: { bankName: 'X' },
    });
    assert.strictEqual(created.status, 201);
    const id = created.body.data.id;
    trackedConnectionIds.push(id);
    const r = await admin.post(`/api/integrations/${id}/test`, {});
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.code, 'INTEGRATION_NOT_CONFIGURED');
    assert.strictEqual(r.body.category, 'CONFIG');
    assert.strictEqual(r.body.retryable, false);
    assert.match(r.body.error, /missing/);
    const row = await prisma.integrationConnection.findUnique({ where: { id } });
    assert.strictEqual(row.status, 'ERROR');
    assert.match(row.lastError, /missing/);
    // Fixing the config and retesting recovers to CONNECTED and clears the error.
    const put = await admin.put(`/api/integrations/${id}`, {
      config: { bankName: 'X Bank', accountName: 'N&D', accountNumber: '111' },
    });
    assert.strictEqual(put.status, 200);
    const retry = await admin.post(`/api/integrations/${id}/test`, {});
    assert.strictEqual(retry.status, 200);
    const fixed = await prisma.integrationConnection.findUnique({ where: { id } });
    assert.strictEqual(fixed.status, 'CONNECTED');
    assert.strictEqual(fixed.lastError, null);
    assert.strictEqual((await admin.del(`/api/integrations/${id}`)).status, 200);
  });

  await test('manual createPayment returns payer instructions (no redirect, no sandbox)', async () => {
    const r = await admin.post(`/api/integrations/${manualId}/payments`, {
      amount: 250.5, currency: 'TTD', reference: `INV-${Date.now()}`, description: 'AC service',
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.data.action, 'manual');
    assert.strictEqual(r.body.data.sandbox, false);
    assert.ok(!r.body.data.url);
    assert.match(r.body.data.instructions, /Test Bank T&T/);
    assert.match(r.body.data.instructions, new RegExp(r.body.data.reference));
  });

  await test('payment input validation fails closed', async () => {
    assert.strictEqual((await admin.post(`/api/integrations/${manualId}/payments`, {
      amount: -5, reference: 'NEG',
    })).status, 400);
    assert.strictEqual((await admin.post(`/api/integrations/${manualId}/payments`, {
      amount: 10,
    })).status, 400);
  });

  await test('unsupported refund fails safely — never pretends success', async () => {
    const r = await admin.post(`/api/integrations/${manualId}/refunds`, { reference: `INV-${Date.now()}` });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.success, false);
    assert.strictEqual(r.body.code, 'UNSUPPORTED_CAPABILITY');
    assert.strictEqual(r.body.category, 'UNSUPPORTED');
    assert.strictEqual(r.body.retryable, false);
    // An unsupported call must not flip a healthy connection into ERROR.
    const row = await prisma.integrationConnection.findUnique({ where: { id: manualId } });
    assert.strictEqual(row.status, 'CONNECTED');
    // ...but the attempt IS recorded in the event log as a failed operation.
    const events = await prisma.integrationEvent.findMany({
      where: { connectionId: manualId, operation: 'refundPayment' }, orderBy: { createdAt: 'desc' }, take: 1,
    });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].success, false);
    assert.strictEqual(events[0].errorCategory, 'UNSUPPORTED');
  });

  await test('disable blocks operations until re-enabled', async () => {
    assert.strictEqual((await admin.patch(`/api/integrations/${manualId}/enabled`, { enabled: false })).status, 200);
    const blocked = await admin.post(`/api/integrations/${manualId}/test`, {});
    assert.strictEqual(blocked.status, 400);
    assert.match(blocked.body.error, /disabled/);
    assert.strictEqual((await admin.patch(`/api/integrations/${manualId}/enabled`, { enabled: true })).status, 200);
    assert.strictEqual((await admin.post(`/api/integrations/${manualId}/test`, {})).status, 200);
  });

  await test('disconnect closes the session without destroying configuration', async () => {
    const r = await admin.post(`/api/integrations/${manualId}/disconnect`, {});
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.data.status, 'DISCONNECTED');
    const row = await prisma.integrationConnection.findUnique({ where: { id: manualId } });
    assert.strictEqual(row.status, 'DISCONNECTED');
    assert.ok(row.config, 'config retained for reconnect');
    assert.strictEqual(row.webhookToken, manualToken, 'webhook token stays stable');
    // ...and the session can be re-established afterwards.
    const re = await admin.post(`/api/integrations/${manualId}/connect`, {});
    assert.strictEqual(re.status, 200);
    assert.strictEqual(re.body.data.ok, true);
    assert.strictEqual((await prisma.integrationConnection.findUnique({ where: { id: manualId } })).status, 'CONNECTED');
    assert.strictEqual((await admin.post(`/api/integrations/${manualId}/disconnect`, {})).status, 200);
  });

  /* -------------------------------------------------------- lifecycle: demo */
  const DEMO_KEY = 'sk-demo-UNIT-SECRET-abc-987654321';
  const DEMO_WH = 'whsec-demo-UNIT-SECRET-xyz-123456789';
  let demoId;
  let demoToken;
  await test('create demo PSP connection with encrypted secrets', async () => {
    const r = await admin.post('/api/integrations', {
      providerId: 'SANDBOX_DEMO',
      name: `Demo PSP ${Date.now()}`,
      authType: 'API_KEY',
      config: { descriptor: 'NDS DEMO' },
      credentials: { apiKey: DEMO_KEY, webhookSecret: DEMO_WH },
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    demoId = r.body.data.id;
    demoToken = r.body.data.webhookToken;
    trackedConnectionIds.push(demoId);
    // Response carries fingerprints, never plaintext.
    const serialised = JSON.stringify(r.body.data);
    assert.ok(!serialised.includes(DEMO_KEY), 'apiKey leaked into create response');
    assert.ok(!serialised.includes(DEMO_WH), 'webhookSecret leaked into create response');
    const fields = new Map(r.body.data.credentialFields.map((f) => [f.name, f]));
    assert.strictEqual(fields.get('apiKey').set, true);
    assert.match(fields.get('apiKey').fingerprint, /^••••/);
    // Database stores an AES envelope, never plaintext.
    const row = await prisma.integrationConnection.findUnique({ where: { id: demoId } });
    assert.match(row.credentialsCipher, /^v1\./);
    assert.ok(!row.credentialsCipher.includes(DEMO_KEY));
    // Audit trail records field names, never values.
    const audits = await prisma.auditLog.findMany({
      where: { entity: 'IntegrationConnection', entityId: demoId, action: 'CREATE' },
      orderBy: { createdAt: 'desc' }, take: 1,
    });
    assert.strictEqual(audits.length, 1);
    assert.ok(audits[0].data.includes('apiKey'));
    assert.ok(!audits[0].data.includes(DEMO_KEY));
  });

  await test('secrets stay encrypted at rest and masked on every read', async () => {
    for (const r of [await admin.get(`/api/integrations/${demoId}`), await admin.get('/api/integrations?limit=50')]) {
      assert.strictEqual(r.status, 200);
      const serialised = JSON.stringify(r.body);
      assert.ok(!serialised.includes(DEMO_KEY), 'apiKey leaked into a read response');
      assert.ok(!serialised.includes(DEMO_WH), 'webhookSecret leaked into a read response');
      assert.ok(!serialised.includes('credentialsCipher'), 'cipher envelope leaked into a read response');
    }
  });

  await test('demo lifecycle: test → payment → status → refund', async () => {
    assert.strictEqual((await admin.post(`/api/integrations/${demoId}/test`, {})).status, 200);
    const ref = `DEMO-${Date.now()}`;
    const pay = await admin.post(`/api/integrations/${demoId}/payments`, {
      amount: 99.99, currency: 'USD', reference: ref,
    });
    assert.strictEqual(pay.status, 201, JSON.stringify(pay.body));
    assert.strictEqual(pay.body.data.action, 'redirect');
    assert.strictEqual(pay.body.data.sandbox, true);
    assert.match(pay.body.data.url, /^https:\/\/sandbox-demo\.invalid\//);
    assert.strictEqual(pay.body.data.reference, ref);
    const status = await admin.get(`/api/integrations/${demoId}/payments/${encodeURIComponent(ref)}`);
    assert.strictEqual(status.status, 200);
    assert.strictEqual(status.body.data.status, 'PENDING');
    const refund = await admin.post(`/api/integrations/${demoId}/refunds`, { reference: ref });
    assert.strictEqual(refund.status, 200, JSON.stringify(refund.body));
    assert.strictEqual(refund.body.data.refunded, true);
    const after = await admin.get(`/api/integrations/${demoId}/payments/${encodeURIComponent(ref)}`);
    assert.strictEqual(after.body.data.status, 'REFUNDED');
  });

  await test('demo refund of an unknown payment fails closed', async () => {
    const r = await admin.post(`/api/integrations/${demoId}/refunds`, { reference: 'DEMO-NOPE-123' });
    assert.strictEqual(r.status, 400);
  });

  await test('credential rotation: omitted fields kept, null clears, values never echoed', async () => {
    const ROTATED = 'sk-demo-ROTATED-SECRET-zzz-000111222';
    const r = await admin.put(`/api/integrations/${demoId}`, {
      credentials: { apiKey: ROTATED }, // webhookSecret omitted → kept
    });
    assert.strictEqual(r.status, 200);
    assert.ok(!JSON.stringify(r.body.data).includes(ROTATED));
    assert.strictEqual(r.body.data.authType, 'API_KEY', 'updates must not reset omitted fields to defaults');
    const names = r.body.data.credentialFields.map((f) => f.name).sort();
    assert.deepStrictEqual(names, ['apiKey', 'webhookSecret']);
    const cleared = await admin.put(`/api/integrations/${demoId}`, {
      credentials: { apiKey: null },
    });
    assert.strictEqual(cleared.status, 200);
    assert.deepStrictEqual(cleared.body.data.credentialFields.map((f) => f.name), ['webhookSecret']);
    // Restore for the webhook tests below.
    const restored = await admin.put(`/api/integrations/${demoId}`, {
      credentials: { apiKey: DEMO_KEY },
    });
    assert.strictEqual(restored.status, 200);
    assert.strictEqual((await admin.post(`/api/integrations/${demoId}/test`, {})).status, 200);
  });

  await test('changing provider resets status and destroys the old secret set', async () => {
    const created = await admin.post('/api/integrations', {
      providerId: 'SANDBOX_DEMO', name: `SwitchMe ${Date.now()}`,
      authType: 'API_KEY', credentials: { apiKey: 'sk-switch-me-999' },
    });
    assert.strictEqual(created.status, 201);
    const id = created.body.data.id;
    trackedConnectionIds.push(id);
    assert.strictEqual((await admin.post(`/api/integrations/${id}/test`, {})).status, 200);
    const switched = await admin.put(`/api/integrations/${id}`, {
      providerId: 'MANUAL_BANK_TRANSFER',
      authType: 'NONE',
      connectionMethod: 'MANUAL',
      config: { bankName: 'Switched Bank', accountName: 'N&D', accountNumber: '5' },
    });
    assert.strictEqual(switched.status, 200);
    assert.strictEqual(switched.body.data.providerId, 'MANUAL_BANK_TRANSFER');
    assert.strictEqual(switched.body.data.status, 'NOT_CONNECTED');
    assert.deepStrictEqual(switched.body.data.credentialFields, []);
    const row = await prisma.integrationConnection.findUnique({ where: { id } });
    assert.strictEqual(row.credentialsCipher, null, 'old provider secrets must be destroyed');
    assert.strictEqual((await admin.del(`/api/integrations/${id}`)).status, 200);
  });

  /* -------------------------------------------------------------- webhooks */
  await test('webhook: unknown provider and unknown token are 404', async () => {
    const noProvider = await fetch(`${base}/api/integrations/webhooks/NOPE_SOMEWHERE/abc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.strictEqual(noProvider.status, 404);
    const noToken = await fetch(`${base}/api/integrations/webhooks/SANDBOX_DEMO/${'0'.repeat(48)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.strictEqual(noToken.status, 404);
    assert.strictEqual((await noToken.json()).received, false);
  });

  await test('webhook: bad signature is 401 and logged; orders untouched', async () => {
    const ordersBefore = await prisma.order.count();
    const payload = { event: 'PAYMENT_COMPLETED', reference: 'DEMO-WH-1', amount: 10, currency: 'USD' };
    const raw = JSON.stringify(payload);
    const bad = await fetch(`${base}/api/integrations/webhooks/SANDBOX_DEMO/${demoToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-payment-signature': signHmac('wrong-secret', raw) },
      body: raw,
    });
    assert.strictEqual(bad.status, 401);
    const missing = await fetch(`${base}/api/integrations/webhooks/SANDBOX_DEMO/${demoToken}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw,
    });
    assert.strictEqual(missing.status, 401);
    const failures = await prisma.integrationEvent.findMany({
      where: { connectionId: demoId, operation: 'receiveWebhook', success: false },
    });
    assert.ok(failures.length >= 2, 'rejected webhooks must be logged');
    assert.ok(failures.every((e) => e.errorCategory === 'AUTH'));
    assert.strictEqual(await prisma.order.count(), ordersBefore, 'rejected webhooks must not touch orders');
  });

  await test('webhook: verified demo payload is handled and logged; orders untouched', async () => {
    const ordersBefore = await prisma.order.count();
    const ref = `DEMO-WH-${Date.now()}`;
    await admin.post(`/api/integrations/${demoId}/payments`, { amount: 42, currency: 'USD', reference: ref });
    const raw = JSON.stringify({ event: 'PAYMENT_COMPLETED', reference: ref, amount: 42, currency: 'USD' });
    const r = await fetch(`${base}/api/integrations/webhooks/SANDBOX_DEMO/${demoToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-payment-signature': signHmac(DEMO_WH, raw) },
      body: raw,
    });
    assert.strictEqual(r.status, 200);
    const json = await r.json();
    assert.strictEqual(json.received, true);
    assert.strictEqual(json.handled, true);
    const status = await admin.get(`/api/integrations/${demoId}/payments/${encodeURIComponent(ref)}`);
    assert.strictEqual(status.body.data.status, 'PAID');
    const logged = await prisma.integrationEvent.findMany({
      where: { connectionId: demoId, operation: 'receiveWebhook', success: true, externalReference: ref },
    });
    assert.strictEqual(logged.length, 1);
    assert.strictEqual(await prisma.order.count(), ordersBefore, 'phase-1 webhooks must not mutate orders');
  });

  await test('webhook: verified but unparseable payload is ignored, not fatal', async () => {
    const raw = JSON.stringify({ event: 'SOMETHING_ELSE_ENTIRELY', hello: 'world' });
    const r = await fetch(`${base}/api/integrations/webhooks/SANDBOX_DEMO/${demoToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-payment-signature': signHmac(DEMO_WH, raw) },
      body: raw,
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).handled, false);
  });

  await test('webhook: sandbox fallback accepts the shared secret only when no secrets stored', async () => {
    const created = await admin.post('/api/integrations', {
      providerId: 'SANDBOX_DEMO', name: `NoSecrets ${Date.now()}`,
    });
    assert.strictEqual(created.status, 201);
    const id = created.body.data.id;
    const token = created.body.data.webhookToken;
    trackedConnectionIds.push(id);
    const ref = `DEMO-FB-${Date.now()}`;
    const raw = JSON.stringify({ event: 'PAYMENT_COMPLETED', reference: ref });
    const ok = await fetch(`${base}/api/integrations/webhooks/SANDBOX_DEMO/${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-payment-signature': signHmac('dev-sandbox-secret', raw) },
      body: raw,
    });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual((await ok.json()).handled, true);
    // ...but the sandbox secret must NOT verify a connection that HAS secrets.
    const spoof = await fetch(`${base}/api/integrations/webhooks/SANDBOX_DEMO/${demoToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-payment-signature': signHmac('dev-sandbox-secret', raw) },
      body: raw,
    });
    assert.strictEqual(spoof.status, 401);
    assert.strictEqual((await admin.del(`/api/integrations/${id}`)).status, 200);
  });

  await test('webhook: providers without the capability report handled=false', async () => {
    const raw = JSON.stringify({ event: 'PAYMENT_COMPLETED', reference: 'X' });
    const r = await fetch(`${base}/api/integrations/webhooks/MANUAL_BANK_TRANSFER/${manualToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-payment-signature': signHmac('dev-sandbox-secret', raw) },
      body: raw,
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).handled, false);
  });

  /* ---------------------------------------------------------- event log */
  await test('event log records every operation with a stable shape', async () => {
    const r = await admin.get(`/api/integrations/${demoId}/events?limit=100`);
    assert.strictEqual(r.status, 200);
    const ops = r.body.data.map((e) => `${e.operation}:${e.success}`);
    for (const op of ['connectionCreated:true', 'testConnection:true', 'createPayment:true',
      'refundPayment:true', 'receiveWebhook:true', 'receiveWebhook:false', 'connectionUpdated:true']) {
      assert.ok(ops.includes(op), `missing event ${op} (saw: ${ops.join(', ')})`);
    }
    for (const e of r.body.data) {
      assert.strictEqual(e.businessId, 'default');
      assert.strictEqual(e.providerId, 'SANDBOX_DEMO');
      assert.ok(e.createdAt, 'event timestamp required');
      assert.strictEqual(typeof e.success, 'boolean');
      assert.strictEqual(typeof e.retryable, 'boolean');
      if (!e.success) assert.ok(e.errorCategory, 'failed events need an error category');
    }
    // Pagination metadata present.
    assert.ok(r.body.meta.total >= r.body.data.length);
    // No secret material anywhere in the log.
    const serialised = JSON.stringify(r.body.data);
    assert.ok(!serialised.includes(DEMO_KEY));
    assert.ok(!serialised.includes(DEMO_WH));
    assert.ok(!serialised.includes('authorization'));
  });

  await test('list supports provider/status filters and never leaks ciphers', async () => {
    const byProvider = await admin.get('/api/integrations?providerId=SANDBOX_DEMO&limit=50');
    assert.strictEqual(byProvider.status, 200);
    assert.ok(byProvider.body.data.length >= 1);
    assert.ok(byProvider.body.data.every((c) => c.providerId === 'SANDBOX_DEMO'));
    const byStatus = await admin.get('/api/integrations?status=DISCONNECTED&limit=50');
    assert.ok(byStatus.body.data.every((c) => c.status === 'DISCONNECTED'));
    assert.ok(!JSON.stringify(byProvider.body).includes('credentialsCipher'));
  });

  /* ------------------------------------------------------ tenant isolation */
  let tenantB;
  let tenantBAdmin;
  await test('tenant B fixture: business + admin user', async () => {
    tenantB = await prisma.business.create({
      data: { name: `Tenant B ${Date.now()}`, slug: `tenant-b-int-${Date.now()}` },
    });
    const email = `tenantb.${Date.now()}@example.com`;
    await prisma.user.create({
      data: {
        name: 'Tenant B Admin', email, passwordHash: await bcrypt.hash('TenantB@12345', 12),
        role: 'ADMIN', businessId: tenantB.id,
      },
    });
    tenantBAdmin = makeClient();
    await tenantBAdmin.get('/api/csrf-token');
    const login = await tenantBAdmin.post('/api/auth/login', { email, password: 'TenantB@12345' });
    assert.strictEqual(login.status, 200, JSON.stringify(login.body));
    tenantBAdmin.setBearer(login.body.data.accessToken);
  });

  await test('Tenant B cannot see, use or modify Tenant A connections', async () => {
    // List isolation.
    const list = await tenantBAdmin.get('/api/integrations?limit=50');
    assert.strictEqual(list.status, 200);
    assert.deepStrictEqual(list.body.data, []);
    // Direct access by id is 404 (existence never leaked).
    assert.strictEqual((await tenantBAdmin.get(`/api/integrations/${demoId}`)).status, 404);
    assert.strictEqual((await tenantBAdmin.put(`/api/integrations/${demoId}`, { name: 'Hijacked' })).status, 404);
    assert.strictEqual((await tenantBAdmin.post(`/api/integrations/${demoId}/test`, {})).status, 404);
    assert.strictEqual((await tenantBAdmin.post(`/api/integrations/${demoId}/connect`, {})).status, 404);
    assert.strictEqual((await tenantBAdmin.post(`/api/integrations/${demoId}/disconnect`, {})).status, 404);
    assert.strictEqual((await tenantBAdmin.post(`/api/integrations/${demoId}/payments`, { amount: 1, reference: 'H' })).status, 404);
    assert.strictEqual((await tenantBAdmin.get(`/api/integrations/${demoId}/payments/H`)).status, 404);
    assert.strictEqual((await tenantBAdmin.post(`/api/integrations/${demoId}/refunds`, { reference: 'H' })).status, 404);
    assert.strictEqual((await tenantBAdmin.get(`/api/integrations/${demoId}/events`)).status, 404);
    assert.strictEqual((await tenantBAdmin.patch(`/api/integrations/${demoId}/enabled`, { enabled: false })).status, 404);
    assert.strictEqual((await tenantBAdmin.del(`/api/integrations/${demoId}`)).status, 404);
    // Tenant A's connection is byte-identical afterwards.
    const row = await prisma.integrationConnection.findUnique({ where: { id: demoId } });
    assert.strictEqual(row.businessId, 'default');
    assert.ok(!row.name.includes('Hijacked'));
  });

  await test('Tenant B connections are invisible to Tenant A (symmetric isolation)', async () => {
    const created = await tenantBAdmin.post('/api/integrations', {
      providerId: 'MANUAL_BANK_TRANSFER',
      name: `Tenant B Bank ${Date.now()}`,
      config: { bankName: 'B Bank', accountName: 'B', accountNumber: '1' },
    });
    assert.strictEqual(created.status, 201);
    const bId = created.body.data.id;
    trackedConnectionIds.push(bId);
    assert.strictEqual(created.body.data.businessId, tenantB.id);
    assert.strictEqual((await admin.get(`/api/integrations/${bId}`)).status, 404);
    assert.strictEqual((await admin.del(`/api/integrations/${bId}`)).status, 404);
    const list = await admin.get('/api/integrations?limit=100');
    assert.ok(list.body.data.every((c) => c.businessId === 'default'));
  });

  await test('platform owner stays scoped and cannot escape via businessId', async () => {
    const owner = makeClient();
    await owner.get('/api/csrf-token');
    const login = await owner.post('/api/auth/login', { email: 'platform@ndsairconditioning.com', password: 'Platform@12345' });
    assert.strictEqual(login.status, 200);
    owner.setBearer(login.body.data.accessToken);
    // Same catalogue + default-tenant scope as any other caller: no cross-tenant
    // parameter is accepted anywhere on this API.
    const r = await owner.get('/api/integrations?limit=100');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.data.every((c) => c.businessId === 'default'));
  });

  /* --------------------------------------------------------------- delete */
  await test('delete destroys the connection and its secrets, keeps scrubbed events', async () => {
    const temp = await admin.post('/api/integrations', {
      providerId: 'SANDBOX_DEMO', name: `DeleteMe ${Date.now()}`,
      credentials: { apiKey: 'sk-delete-me-12345' },
    });
    const id = temp.body.data.id;
    trackedConnectionIds.push(id);
    assert.strictEqual((await admin.post(`/api/integrations/${id}/test`, {})).status, 200);
    const r = await admin.del(`/api/integrations/${id}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(await prisma.integrationConnection.findUnique({ where: { id } }), null);
    assert.strictEqual((await admin.get(`/api/integrations/${id}`)).status, 404);
    // Audit trail retained but detached.
    const events = await prisma.integrationEvent.findMany({ where: { providerId: 'SANDBOX_DEMO', businessId: 'default' } });
    assert.ok(events.some((e) => e.operation === 'connectionDeleted' && e.success === true));
    assert.ok(!JSON.stringify(events).includes('sk-delete-me-12345'));
  });

  /* -------------------------------------------------------------- cleanup */
  await test('cleanup fixtures', async () => {
    await prisma.integrationEvent.deleteMany({
      where: { businessId: { in: ['default', tenantB.id] }, createdAt: { gte: suiteStart } },
    });
    await prisma.integrationConnection.deleteMany({ where: { id: { in: trackedConnectionIds } } });
    assert.strictEqual(await prisma.integrationConnection.count({ where: { id: { in: trackedConnectionIds } } }), 0);
    // Tenant B's API activity left audit/activity rows behind; PostgreSQL
    // enforces the Business/User FKs (RESTRICT), so they must go before the
    // tenant and its users. (SQLite skips FK constraints, which is why this
    // only bites on Postgres.) Match by tenant AND by user id so no
    // referencing row can survive to block the deletes below.
    const tenantBUserIds = (await prisma.user.findMany({
      where: { businessId: tenantB.id }, select: { id: true },
    })).map((u) => u.id);
    await prisma.auditLog.deleteMany({
      where: { OR: [{ businessId: tenantB.id }, { userId: { in: tenantBUserIds } }] },
    });
    await prisma.activity.deleteMany({
      where: { OR: [{ businessId: tenantB.id }, { userId: { in: tenantBUserIds } }] },
    });
    await prisma.user.deleteMany({ where: { businessId: tenantB.id } });
    await prisma.business.delete({ where: { id: tenantB.id } });
  });

  server.close();
  await prisma.$disconnect();

  const pass = results.filter((r) => r[0] === 'PASS').length;
  console.log('\nUniversal Integration Gateway verification\n========================================');
  for (const [state, name] of results) console.log(`  ${state === 'PASS' ? '✔' : '✘'} ${name}`);
  console.log(`\n${pass}/${results.length} checks passed${failures ? ` — ${failures} FAILED` : ''}\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
