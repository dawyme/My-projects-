/**
 * Universal Integrations — owner-first access model (PR #71 correction).
 *
 * Corrects the earlier "platform read-only / tenant operational" split,
 * which was backwards for this platform: N&D'S (SUPER_ADMIN) is the
 * owner-OPERATOR of Universal Integrations. This suite verifies:
 *
 *   1. SUPER_ADMIN can open Universal Integrations (catalogue, schema, lists).
 *   2. SUPER_ADMIN can connect / configure / test an integration.
 *   3. SUPER_ADMIN can enable / disable / disconnect / reconnect.
 *   4. SUPER_ADMIN can rotate / clear credentials safely (fingerprints kept,
 *      plaintext never exposed).
 *   5. SUPER_ADMIN can inspect integration events.
 *   6. SUPER_ADMIN can execute supported provider operations (and unsupported
 *      ones fail safely).
 *   7. Disabling `universal-integrations` for a tenant: the tenant loses nav
 *      (central shell wiring), direct routes and API access — while the
 *      SUPER_ADMIN keeps FULL access (central Feature-Management bypass,
 *      never a UI workaround).
 *   8. Enabling it again restores tenant access per normal tenant RBAC.
 *   9. Tenant A cannot access Tenant B's connections/events/operations — and
 *      the owner alias cannot escape N&D'S's own scope either (tenant ids
 *      404 through /platform/owner/*; the owner's user keeps businessId NULL).
 *  10. Credential values never appear in responses, events or audits.
 *
 * Plus the API-shape invariants of the corrected model: cross-tenant
 * platform lists stay read-only (POST → 404), tenant users get 403 on the
 * owner surface, and the admin shell gates nav + direct routes through the
 * central /api/features/access mechanism.
 *
 *   node backend/tests/platform-owner-integrations.test.js
 */
require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

process.env.RATE_LIMIT_API_MAX = process.env.RATE_LIMIT_API_MAX || '20000';
process.env.RATE_LIMIT_WRITE_MAX = process.env.RATE_LIMIT_WRITE_MAX || '20000';

const app = require('../src/app');
const prisma = require('../src/lib/prisma');

const ROOT = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

let base = '';
const results = [];
let failures = 0;
const suiteStart = new Date();
const tracked = { connections: [], businessIds: [], userIds: [] };

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
    async req(method, p, body, opts = {}) {
      const headers = { ...(opts.headers || {}) };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookie) headers.Cookie = cookie;
      if (csrf) headers['x-csrf-token'] = csrf;
      if (bearer && !opts.noBearer) headers.Authorization = `Bearer ${bearer}`;
      const res = await fetch(base + p, {
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

const OWNER = '/api/integrations/platform/owner/connections';

function signHmac(secret, rawBody) {
  return `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const owner = makeClient();
  const staff = makeClient();
  const anon = makeClient();
  await owner.get('/api/csrf-token');
  await staff.get('/api/csrf-token');
  await anon.get('/api/csrf-token');

  /* ---------------------------------------------------- identities */
  await test('SUPER_ADMIN logs in with businessId NULL (not a fake tenant grant)', async () => {
    const r = await owner.post('/api/auth/login', { email: 'platform@ndsairconditioning.com', password: 'Platform@12345' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.data.user.role, 'SUPER_ADMIN');
    assert.strictEqual(r.body.data.user.businessId, null, 'the owner must remain businessId = NULL');
    owner.setBearer(r.body.data.accessToken);
    const s = await staff.post('/api/auth/login', { email: 'staff@ndsairconditioning.com', password: 'Staff@12345' });
    assert.strictEqual(s.status, 200);
    staff.setBearer(s.body.data.accessToken);
  });

  /* ---------------------------------------- 1 · owner can open everything */
  await test('1) SUPER_ADMIN opens the Universal Integrations surfaces', async () => {
    assert.strictEqual((await owner.get('/api/integrations/providers')).status, 200);
    assert.strictEqual((await owner.get('/api/integrations/providers/SANDBOX_DEMO/schema')).status, 200);
    const list = await owner.get(`${OWNER}?limit=100`);
    assert.strictEqual(list.status, 200);
    assert.ok(Array.isArray(list.body.data));
    assert.strictEqual((await owner.get('/api/integrations/platform/overview')).status, 200);
  });

  /* -------------------------------- 2 · connect / configure / test */
  let demoId; let demoToken;
  const SECRET_KEY = `sk-owner-${Date.now()}-s3cr3t-XYZ`;
  const SECRET_WH = `whsec-owner-${Date.now()}-s3cr3t-ABC`;
  await test('2) SUPER_ADMIN connects, configures and tests an integration (owner scope)', async () => {
    const created = await owner.post(OWNER, {
      providerId: 'SANDBOX_DEMO', name: `Owner PSP ${Date.now()}`,
      authType: 'API_KEY', config: { descriptor: 'NDS OWNER' },
      credentials: { apiKey: SECRET_KEY, webhookSecret: SECRET_WH },
    });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    demoId = created.body.data.id;
    demoToken = created.body.data.webhookToken;
    tracked.connections.push(demoId);
    // Owner scope: stored under N&D'S's own business; the owner's user row
    // still has businessId NULL — this is the owner's operational surface,
    // not a fake tenant session.
    assert.strictEqual(created.body.data.businessId, 'default');
    assert.strictEqual(created.body.data.status, 'CONFIGURED');
    assert.ok(!JSON.stringify(created.body).includes(SECRET_KEY));
    // Configure (non-secret config) then real test → CONNECTED only after
    // the adapter confirms it.
    const put = await owner.put(`${OWNER}/${demoId}`, { config: { descriptor: 'NDS OWNER FINAL' } });
    assert.strictEqual(put.status, 200);
    assert.strictEqual(put.body.data.config.descriptor, 'NDS OWNER FINAL');
    const t = await owner.post(`${OWNER}/${demoId}/test`, {});
    assert.strictEqual(t.status, 200);
    assert.strictEqual(t.body.data.ok, true);
    const row = await prisma.integrationConnection.findUnique({ where: { id: demoId } });
    assert.strictEqual(row.status, 'CONNECTED');
    assert.match(row.credentialsCipher, /^v1\./);
    assert.ok(!row.credentialsCipher.includes(SECRET_KEY), 'plaintext secret at rest');
  });

  /* -------------------------------- 3 · enable/disable/disconnect/reconnect */
  await test('3) SUPER_ADMIN runs the full lifecycle: enable/disable/disconnect/reconnect', async () => {
    const dis = await owner.post(`${OWNER}/${demoId}/disable`, {});
    assert.strictEqual(dis.status, 200);
    assert.strictEqual(dis.body.data.status, 'DISABLED');
    const blocked = await owner.post(`${OWNER}/${demoId}/test`, {});
    assert.strictEqual(blocked.status, 400);
    assert.match(blocked.body.error, /disabled/);
    const en = await owner.post(`${OWNER}/${demoId}/enable`, {});
    assert.strictEqual(en.status, 200);
    assert.strictEqual(en.body.data.status, 'CONFIGURED');
    // PATCH alias parity
    assert.strictEqual((await owner.patch(`${OWNER}/${demoId}/enabled`, { enabled: false })).status, 200);
    assert.strictEqual((await owner.patch(`${OWNER}/${demoId}/enabled`, { enabled: true })).status, 200);
    assert.strictEqual((await owner.post(`${OWNER}/${demoId}/test`, {})).status, 200);
    assert.strictEqual((await owner.post(`${OWNER}/${demoId}/disconnect`, {})).status, 200);
    assert.strictEqual((await prisma.integrationConnection.findUnique({ where: { id: demoId } })).status, 'DISCONNECTED');
    const rec = await owner.post(`${OWNER}/${demoId}/reconnect`, {});
    assert.strictEqual(rec.status, 200);
    assert.strictEqual((await prisma.integrationConnection.findUnique({ where: { id: demoId } })).status, 'CONNECTED');
  });

  /* -------------------------------- 4 · rotate / clear credentials safely */
  await test('4) SUPER_ADMIN rotates and clears credentials (fingerprints only)', async () => {
    const ROTATED = `sk-owner-${Date.now()}-rotated-999`;
    const rot = await owner.post(`${OWNER}/${demoId}/credentials`, { credentials: { apiKey: ROTATED } });
    assert.strictEqual(rot.status, 200, JSON.stringify(rot.body));
    assert.ok(!JSON.stringify(rot.body).includes(ROTATED), 'rotation response leaked the secret');
    const names = rot.body.data.credentialFields.map((f) => f.name).sort();
    assert.deepStrictEqual(names, ['apiKey', 'webhookSecret'], 'omitted secret kept');
    assert.ok(rot.body.data.credentialFields.every((f) => /^••••/.test(f.fingerprint)));
    assert.strictEqual(rot.body.data.status, 'CONFIGURED', 'rotation invalidates the previous connected claim');
    // Clearing drops the value AND its descriptor.
    const cleared = await owner.post(`${OWNER}/${demoId}/credentials`, { credentials: { webhookSecret: null } });
    assert.strictEqual(cleared.status, 200);
    assert.deepStrictEqual(cleared.body.data.credentialFields.map((f) => f.name), ['apiKey']);
    // Restore the webhook secret for the webhook checks below.
    const restored = await owner.post(`${OWNER}/${demoId}/credentials`, { credentials: { webhookSecret: SECRET_WH } });
    assert.strictEqual(restored.status, 200);
    assert.strictEqual((await owner.post(`${OWNER}/${demoId}/test`, {})).status, 200);
    const row = await prisma.integrationConnection.findUnique({ where: { id: demoId } });
    assert.ok(!row.credentialsCipher.includes(ROTATED) && !row.credentialsCipher.includes(SECRET_WH));
  });

  /* -------------------------------- 5 · events */
  await test('5) SUPER_ADMIN inspects integration events (owner + cross-tenant)', async () => {
    const ev = await owner.get(`${OWNER}/${demoId}/events?limit=100`);
    assert.strictEqual(ev.status, 200);
    const ops = ev.body.data.map((e) => e.operation);
    for (const op of ['connectionCreated', 'testConnection', 'enable', 'disable', 'disconnect', 'reconnect', 'credentialRotated']) {
      assert.ok(ops.includes(op), `missing ${op} in owner events (saw ${ops.join(',')})`);
    }
    const failedOnly = await owner.get(`${OWNER}/${demoId}/events?success=false&limit=10`);
    assert.ok(failedOnly.body.data.every((e) => e.success === false));
    const all = await owner.get('/api/integrations/platform/events?limit=50&operation=testConnection');
    assert.ok(all.body.data.every((e) => e.operation === 'testConnection'));
    assert.ok(all.body.data.some((e) => e.businessName), 'cross-tenant events carry tenant names');
  });

  /* -------------------------------- 6 · provider operations */
  await test('6) SUPER_ADMIN executes supported operations; unsupported fail safely', async () => {
    const ref = `OWNER-${Date.now()}`;
    const pay = await owner.post(`${OWNER}/${demoId}/operations/createPayment`, {
      payload: { amount: 42, currency: 'USD', reference: ref },
      idempotencyKey: `owner-${ref}`,
    });
    assert.strictEqual(pay.status, 201, JSON.stringify(pay.body));
    assert.strictEqual(pay.body.data.status, 'PENDING');
    assert.strictEqual(pay.body.data.provider, 'SANDBOX_DEMO');
    const status = await owner.get(`/api/integrations/platform/owner/connections/${demoId}/payments/${encodeURIComponent(ref)}`);
    assert.strictEqual(status.status, 200);
    assert.strictEqual(status.body.data.status, 'PENDING');
    const refund = await owner.post(`${OWNER}/${demoId}/refunds`, { reference: ref });
    assert.strictEqual(refund.status, 200, JSON.stringify(refund.body));
    assert.strictEqual(refund.body.data.refunded, true);
    // Typed + generic endpoints both live on the owner surface.
    const manual = await owner.post(OWNER, {
      providerId: 'MANUAL_BANK_TRANSFER', name: `Owner bank ${Date.now()}`,
      config: { bankName: 'Owner Bank', accountName: 'N&D', accountNumber: '77' },
    });
    const mId = manual.body.data.id;
    tracked.connections.push(mId);
    await owner.post(`${OWNER}/${mId}/test`, {});
    const mPay = await owner.post(`${OWNER}/${mId}/operations/createPayment`, { payload: { amount: 9, currency: 'TTD', reference: `OWN-${Date.now()}` } });
    assert.strictEqual(mPay.status, 201);
    assert.match(mPay.body.data.instructions, /Owner Bank/);
    const bal = await owner.post(`${OWNER}/${mId}/operations/getBalance`, { payload: {} });
    assert.strictEqual(bal.status, 400);
    assert.strictEqual(bal.body.code, 'UNSUPPORTED_CAPABILITY');
    // Duplicate webhook redelivery dedupes on the owner connection too.
    const raw = JSON.stringify({ event: 'PAYMENT_COMPLETED', reference: ref, amount: 42, currency: 'USD' });
    const wh = async () => fetch(`${base}/api/integrations/webhooks/SANDBOX_DEMO/${demoToken}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-payment-signature': signHmac(SECRET_WH, raw) }, body: raw,
    });
    const w1 = await wh(); const w2 = await wh();
    assert.strictEqual(w1.status, 200);
    assert.strictEqual((await w1.json()).handled, true);
    const j2 = await w2.json();
    assert.strictEqual(j2.duplicate, true, 'owner connections get the same idempotent webhook pipeline');
    // Bad signature still 401.
    const bad = await fetch(`${base}/api/integrations/webhooks/SANDBOX_DEMO/${demoToken}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-payment-signature': signHmac('wrong', raw) }, body: raw,
    });
    assert.strictEqual(bad.status, 401);
  });

  /* -------------------------------- cross-tenant invariants */
  await test('cross-tenant platform lists stay READ-ONLY (no writes through oversight paths)', async () => {
    const x = await owner.get('/api/integrations/platform/connections?limit=50');
    assert.strictEqual(x.status, 200);
    assert.strictEqual(x.body.meta.ownerBusinessId, 'default', 'oversight list names the owner business for UI affordances');
    assert.strictEqual((await owner.post('/api/integrations/platform/connections', { providerId: 'SANDBOX_DEMO', name: 'x' })).status, 404);
    assert.strictEqual((await owner.del('/api/integrations/platform/connections/does-not-exist')).status, 404);
    assert.strictEqual((await owner.put('/api/integrations/platform/connections/does-not-exist', { name: 'x' })).status, 404);
  });

  /* -------------------------------- 7/8 · Feature Management interaction */
  let tenantBId; let tenantB; let featureId;
  await test('tenant B fixture (business + admin)', async () => {
    const stamp = Date.now();
    const biz = await prisma.business.create({ data: { name: `Owner B71 ${stamp}`, slug: `owner-b71-${stamp}` } });
    tenantBId = biz.id; tracked.businessIds.push(biz.id);
    const email = `ownerb71.${stamp}@example.com`;
    const u = await prisma.user.create({ data: { name: 'B71 Admin', email, passwordHash: await bcrypt.hash('B71@12345x', 12), role: 'ADMIN', businessId: biz.id } });
    tracked.userIds.push(u.id);
    tenantB = makeClient();
    await tenantB.get('/api/csrf-token');
    const login = await tenantB.post('/api/auth/login', { email, password: 'B71@12345x' });
    assert.strictEqual(login.status, 200, JSON.stringify(login.body));
    tenantB.setBearer(login.body.data.accessToken);
  });

  await test('tenant users are denied the owner surface (403) — it is SUPER_ADMIN-only', async () => {
    // The tenant admin of ANOTHER business (B) and the default tenant's own
    // admin role both get 403: the owner alias requires the platform role,
    // not just an ADMIN with a business.
    assert.strictEqual((await tenantB.get(OWNER)).status, 403);
    assert.strictEqual((await tenantB.post(OWNER, { providerId: 'SANDBOX_DEMO', name: 'nope' })).status, 403);
    const tenantA = makeClient();
    await tenantA.get('/api/csrf-token');
    const login = await tenantA.post('/api/auth/login', { email: 'admin@ndsairconditioning.com', password: 'Admin@12345' });
    assert.strictEqual(login.body.data.user.role, 'TENANT_ADMIN');
    tenantA.setBearer(login.body.data.accessToken);
    assert.strictEqual((await tenantA.get(OWNER)).status, 403);
    assert.strictEqual((await staff.get(OWNER)).status, 403);
    assert.strictEqual((await anon.get(OWNER)).status, 401);
  });

  await test('9) tenant isolation holds through every surface (both directions)', async () => {
    // Tenant B creates its own connection (feature enabled by default).
    const b = await tenantB.post('/api/integrations', {
      providerId: 'MANUAL_BANK_TRANSFER', name: `B bank ${Date.now()}`,
      config: { bankName: 'B', accountName: 'B', accountNumber: '1' },
    });
    assert.strictEqual(b.status, 201);
    const bId = b.body.data.id;
    tracked.connections.push(bId);
    // Owner scope cannot reach tenant B's connection (404, existence-safe).
    assert.strictEqual((await owner.get(`${OWNER}/${bId}`)).status, 404);
    assert.strictEqual((await owner.post(`${OWNER}/${bId}/test`, {})).status, 404);
    assert.strictEqual((await owner.del(`${OWNER}/${bId}`)).status, 404);
    assert.strictEqual((await owner.post(`${OWNER}/${bId}/credentials`, { credentials: { apiKey: 'x' } })).status, 404);
    assert.strictEqual((await owner.post(`${OWNER}/${bId}/operations/getBalance`, { payload: {} })).status, 404);
    // Tenant B cannot touch the owner connection either.
    assert.strictEqual((await tenantB.get(`/api/integrations/${demoId}`)).status, 404);
    assert.strictEqual((await tenantB.post(`/api/integrations/${demoId}/operations/createPayment`, { payload: { amount: 1, reference: 'x' } })).status, 404);
    // Lists stay scoped both ways.
    assert.ok((await tenantB.get('/api/integrations?limit=100')).body.data.every((c) => c.businessId === tenantBId));
    assert.ok((await owner.get(`${OWNER}?limit=100`)).body.data.every((c) => c.businessId === 'default'));
  });

  await test('7) disabling universal-integrations: tenant locked out, SUPER_ADMIN untouched', async () => {
    const list = await owner.get('/api/saas/features');
    assert.strictEqual(list.status, 200);
    const feature = list.body.data.find((f) => f.key === 'universal-integrations');
    assert.ok(feature, 'feature must be centrally manageable');
    featureId = feature.id;
    const off = await owner.patch(`/api/saas/features/${feature.id}/access/${tenantBId}`, { enabled: false });
    assert.strictEqual(off.status, 200, JSON.stringify(off.body));

    // Tenant API access is rejected at the central gate.
    const blocked = await tenantB.get('/api/integrations');
    assert.strictEqual(blocked.status, 403);
    assert.match(blocked.body.error, /not enabled for this tenant/);
    assert.strictEqual((await tenantB.post('/api/integrations', { providerId: 'SANDBOX_DEMO', name: 'while-off' })).status, 403);
    assert.strictEqual((await tenantB.get(`/api/integrations/${demoId}`)).status, 403, 'reads are gated too, not just writes');

    // …but SUPER_ADMIN keeps FULL access on every integration route.
    assert.strictEqual((await owner.get('/api/integrations/providers')).status, 200);
    assert.strictEqual((await owner.get(`${OWNER}?limit=50`)).status, 200);
    assert.strictEqual((await owner.post(`${OWNER}/${demoId}/test`, {})).status, 200);
    const keepOp = await owner.post(`${OWNER}/${demoId}/operations/getPaymentStatus`, { payload: { reference: 'whatever' } });
    assert.strictEqual(keepOp.status, 200);
    // The owner's central feature list still contains the feature (bypass at
    // the shared boundary, mirrored to the shell's nav gating).
    const ownerAccess = await owner.get('/api/features/access');
    assert.ok(ownerAccess.body.data.some((f) => f.key === 'universal-integrations'), 'owner must always see the feature');
    const tenantAccess = await tenantB.get('/api/features/access');
    assert.strictEqual(tenantAccess.status, 200);
    assert.ok(!tenantAccess.body.data.some((f) => f.key === 'universal-integrations'), 'disabled feature must vanish from the tenant access set (nav + direct routes)');
  });

  await test('8) re-enabling restores tenant access per tenant RBAC (not owner privileges)', async () => {
    const on = await owner.patch(`/api/saas/features/${featureId}/access/${tenantBId}`, { enabled: true });
    assert.strictEqual(on.status, 200);
    assert.strictEqual((await tenantB.get('/api/integrations?limit=5')).status, 200);
    // Tenant admins get the FEATURE, never the owner surface:
    assert.strictEqual((await tenantB.get(OWNER)).status, 403);
    const staffB = makeClient();
    await staffB.get('/api/csrf-token');
    const sl = await staffB.post('/api/auth/login', { email: 'staff@ndsairconditioning.com', password: 'Staff@12345' });
    staffB.setBearer(sl.body.data.accessToken);
    assert.strictEqual((await staffB.get('/api/integrations/providers')).status, 403, 'staff never gains integration management');
  });

  /* -------------------------------- 10 · secret containment sweep */
  await test('10) secrets appear nowhere: responses, events, audits, URLs, localStorage sources', async () => {
    const sweep = [];
    for (const p of [
      '/api/integrations/providers', `${OWNER}?limit=100`, `/api/integrations/${demoId}`,
      `${OWNER}/${demoId}/events?limit=100`, '/api/integrations/platform/events?limit=100',
      '/api/integrations/platform/overview', '/api/integrations/platform/connections?limit=100',
    ]) sweep.push(JSON.stringify((await owner.get(p)).body || {}));
    const all = sweep.join('\n');
    for (const secret of [SECRET_KEY, SECRET_WH]) {
      assert.ok(!all.includes(secret), `response sweep leaked ${secret}`);
    }
    assert.ok(!all.includes('credentialsCipher'));
    const events = await prisma.integrationEvent.findMany({ where: { connectionId: demoId } });
    assert.ok(!JSON.stringify(events).includes(SECRET_WH));
    const audits = await prisma.auditLog.findMany({ where: { entity: 'IntegrationConnection' }, orderBy: { createdAt: 'desc' }, take: 30 });
    const auditBlob = JSON.stringify(audits);
    assert.ok(!auditBlob.includes(SECRET_KEY) && !auditBlob.includes(SECRET_WH));
    // Admin UI sources never persist or echo secrets (client-side half of the rule).
    for (const f of ['admin/js/pages/integrations.js', 'admin/js/pages/platform-integrations.js', 'admin/js/pages/integrations-shared.js']) {
      const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
      assert.ok(!/(localStorage|sessionStorage)\s*[.([]/.test(src), `${f} must never persist browser state`);
      assert.ok(!src.includes('credentialsCipher'));
    }
  });

  /* -------------------------------- static shell wiring */
  await test('static: shell gates tenant nav + direct routes through the central /features/access', async () => {
    const layout = read('admin/js/layout.js');
    assert.match(layout, /await auth\.refreshFeatures\(\)/, 'boot must load the central feature set');
    assert.match(layout, /auth\.hasFeature\(i\.feature\)/, 'nav items hide disabled tenant features');
    assert.match(layout, /featureForPath\(path\)/, 'direct routes are blocked for disabled tenant features');
    assert.match(layout, /not enabled for your business/);
    const apijs = read('admin/js/api.js');
    assert.match(apijs, /api\.get\('\/features\/access'\)/, 'features come from the Feature Management endpoint');
    assert.match(apijs, /this\.features = new Set/, 'in-memory feature set (never persisted)');
    assert.match(apijs, /features: null/, 'features are NOT part of the localStorage auth store');
    // The bypass is at the central server boundary, not per-page:
    const features = read('backend/src/lib/features.js');
    assert.match(features, /if \(role === 'SUPER_ADMIN'\) return true;\n\s*if \(!feature \|\| !feature\.isActive\) return false;/);
    // Integrations code contains no private tenant-permission system: the
    // entitlement gate stays on the central app.js boundary only.
    const routes = read('backend/src/routes/integrations.js');
    assert.doesNotMatch(routes, /platformFeature|tenantFeatureAccess/, 'integrations must not reimplement Feature Management');
    assert.match(
      read('backend/src/app.js'),
      /app\.use\('\/api\/integrations', \.\.\.featureProtectedRoute\('universal-integrations'\), require\('\.\/routes\/integrations'\)\)/,
      'the tenant gate remains the central featureProtectedRoute boundary'
    );
    // Owner page writes are owner-scoped (see #69 suite) and N&D'S links gate
    // too — through the central data-feature/applyEntitlements mechanism. (The
    // earlier one-off hasFeature('universal-integrations') branch was migrated
    // to the shared helper so every current and future feature gates the same
    // way; the tab still hides for tenants without the entitlement.)
    assert.match(read('admin/js/pages/settings.js'), /data-feature="universal-integrations"/);
    assert.match(read('admin/js/pages/settings.js'), /applyEntitlements\(view\)/);
    assert.doesNotMatch(read('admin/js/pages/settings.js'), /hasFeature\('universal-integrations'\)/);
  });

  /* -------------------------------- cleanup */
  await test('cleanup fixtures', async () => {
    if (featureId && tenantBId) {
      await owner.patch(`/api/saas/features/${featureId}/access/${tenantBId}`, { enabled: true }).catch(() => {});
      await prisma.tenantFeatureAccess.deleteMany({ where: { featureId, businessId: tenantBId } }).catch(() => {});
    }
    await prisma.integrationEvent.deleteMany({
      where: { businessId: { in: ['default', tenantBId] }, createdAt: { gte: suiteStart } },
    });
    await prisma.integrationConnection.deleteMany({ where: { id: { in: tracked.connections } } });
    const ids = (await prisma.user.findMany({ where: { businessId: { in: tracked.businessIds } }, select: { id: true } })).map((u) => u.id);
    await prisma.auditLog.deleteMany({ where: { OR: [{ businessId: { in: tracked.businessIds } }, { userId: { in: ids } }] } });
    await prisma.activity.deleteMany({ where: { OR: [{ businessId: { in: tracked.businessIds } }, { userId: { in: ids } }] } });
    await prisma.user.deleteMany({ where: { id: { in: [...ids, ...tracked.userIds.filter((x) => !ids.includes(x))] } } });
    await prisma.business.deleteMany({ where: { id: { in: tracked.businessIds } } });
    assert.strictEqual(await prisma.integrationConnection.count({ where: { id: { in: tracked.connections } } }), 0);
    assert.strictEqual(await prisma.business.count({ where: { id: { in: tracked.businessIds } } }), 0);
  });

  server.close();
  await prisma.$disconnect();

  const pass = results.filter((r) => r[0] === 'PASS').length;
  console.log('\nUniversal Integrations — owner-first access model\n==================================================');
  for (const [state, name] of results) console.log(`  ${state === 'PASS' ? '✔' : '✘'} ${name}`);
  console.log(`\n${pass}/${results.length} checks passed${failures ? ` — ${failures} FAILED` : ''}\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
