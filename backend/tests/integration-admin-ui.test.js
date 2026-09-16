/**
 * Universal Integrations Admin UI — verification (PR #69).
 *
 * Covers the UI/API integration contracts for "Platform → Universal
 * Integrations" (SUPER_ADMIN) and "Settings → Integrations" (TENANT_ADMIN):
 *
 *   • static UI contracts — routes, navigation entries, role guards, and the
 *     hard rule that integration UI sources never touch secret material
 *   • platform endpoints — SUPER_ADMIN-only cross-tenant visibility is
 *     read-only with an explicit safe-field allowlist (no ciphers, tokens,
 *     configs or secret values anywhere in any response), while owner
 *     operations live exclusively behind /platform/owner/connections…
 *   • tenant boundaries — TENANT_ADMIN is denied the platform surface in both
 *     directions and stays isolated on the tenant surface
 *   • RBAC — staff 403, anonymous 401 on the platform surface
 *   • feature entitlement — disabling `universal-integrations` for a tenant
 *     blocks that tenant's API (403) while SUPER_ADMIN platform controls and
 *     other tenants keep working
 *   • credential rotation semantics consumed by the UI (omitted = keep,
 *     null = clear)
 *   • webhook activity visibility for the platform owner
 *
 * The PR #68 backend is consumed as-is; nothing here redesigns the Gateway.
 *
 *   node backend/tests/integration-admin-ui.test.js
 */
require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

// Widen request budgets for this suite rather than weakening the app.
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
const trackedConnectionIds = [];
let tenantBId = null;

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
  /* ------------------------------------------- static: routes + navigation */
  await test('static: shell registers both integration routes', async () => {
    const layout = read('admin/js/layout.js');
    assert.match(layout, /'\/integrations': \(\) => import\('\.\/pages\/integrations\.js'\)/);
    assert.match(layout, /'\/platform-integrations': \(\) => import\('\.\/pages\/platform-integrations\.js'\)/);
  });

  await test('static: nav places Universal Integrations under Platform (SUPER_ADMIN only)', async () => {
    const layout = read('admin/js/layout.js');
    assert.match(layout, /path: '\/platform-integrations', label: 'Universal Integrations'[^}]*platformOnly: true/);
    const features = layout.indexOf("path: '/features'");
    const uni = layout.indexOf("path: '/platform-integrations'");
    const analytics = layout.indexOf("path: '/platform-analytics'");
    assert.ok(features !== -1 && uni !== -1 && analytics !== -1, 'platform nav entries must exist');
    assert.ok(features < uni && uni < analytics, 'Universal Integrations sits between Feature Management and Platform Analytics');
  });

  await test('static: nav places Integrations under Administration (tenant-only, feature-gated)', async () => {
    const layout = read('admin/js/layout.js');
    assert.match(layout, /path: '\/integrations', label: 'Integrations'[^}]*tenantOnly: true/);
    assert.match(layout, /path: '\/integrations'[^}]*feature: 'universal-integrations'/);
    const settings = layout.indexOf("path: '/settings'");
    const integrations = layout.indexOf("path: '/integrations'");
    assert.ok(settings !== -1 && integrations > settings, 'tenant Integrations follows Settings in the nav');
  });

  await test('static: Settings links to Integrations (Settings → Integrations)', async () => {
    assert.match(read('admin/js/pages/settings.js'), /href="#\/integrations">Integrations<\/a>/);
  });

  await test('static: role guards — platform page is SUPER_ADMIN-only, tenant page is admin-only', async () => {
    const platform = read('admin/js/pages/platform-integrations.js');
    const tenant = read('admin/js/pages/integrations.js');
    assert.match(platform, /isPlatformAdmin\(auth\.user\)/);
    assert.match(platform, /Platform administrators only/);
    assert.match(tenant, /if \(!auth\.isAdmin\)/);
  });

  await test('static: platform UI writes only through owner-scoped platform endpoints', async () => {
    const platform = read('admin/js/pages/platform-integrations.js');
    // N&D'S is the operator: the platform page has real operational writes,
    // but they may ONLY target the owner-scoped alias (N&D'S's own
    // connections). Tenant paths and cross-tenant paths must stay read-only.
    const baseDecl = platform.match(/const OWNER_BASE = '([^']+)'/);
    assert.ok(baseDecl, 'platform page must pin its writes to one OWNER_BASE constant');
    assert.strictEqual(baseDecl[1], '/integrations/platform/owner/connections',
      'OWNER_BASE must be the SUPER_ADMIN owner-scope alias of the tenant handlers');
    const writeCalls = [...platform.matchAll(/api\.(post|put|patch|del)\(\s*[`'"]([^`'"]+)/g)].map((m) => m[2]);
    assert.ok(writeCalls.length >= 5, 'platform page should expose owner operations (connect/test/enable/disable/remove/rotate/operations)');
    for (const target of writeCalls) {
      const resolved = target.replace('${OWNER_BASE}', baseDecl[1]).replace(/^\$\{OWNER_BASE\}/, baseDecl[1]);
      assert.ok(resolved.startsWith(baseDecl[1]),
        `platform write escaped the owner scope: ${target}`);
    }
    // No inline absolute /integrations/ write may bypass the owner alias,
    // and the cross-tenant oversight endpoints stay GET-only.
    assert.doesNotMatch(platform, /api\.(post|put|patch|del)\(\s*[`'"]\/integrations\//);
  });

  // Comments may NAME the forbidden things (e.g. "never sends a businessId"),
  // so static security assertions run against comment-stripped sources.
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');

  await test('static: integration UI never touches secret material or storage', async () => {
    for (const file of [
      'admin/js/pages/integrations.js',
      'admin/js/pages/platform-integrations.js',
      'admin/js/pages/integrations-shared.js',
    ]) {
      const src = stripComments(read(file));
      assert.ok(!src.includes('credentialsCipher'), `${file} must never reference the cipher envelope`);
      assert.doesNotMatch(src, /(localStorage|sessionStorage)\s*[.([]/, `${file} must never persist browser state`);
    }
    // No secret material in logs.
    const tenant = stripComments(read('admin/js/pages/integrations.js'));
    assert.doesNotMatch(tenant, /console\.(log|info|debug)\s*\([^)]*(credential|secret|password)/i);
  });

  await test('static: tenant UI never sends a businessId (tenant comes from the session)', async () => {
    assert.doesNotMatch(stripComments(read('admin/js/pages/integrations.js')), /businessId/);
  });

  await test('static: feature registry + API guard wire up universal-integrations', async () => {
    const { TENANT_FEATURE_REGISTRY } = require('../src/lib/feature-registry');
    const entry = TENANT_FEATURE_REGISTRY.find((f) => f.key === 'universal-integrations');
    assert.ok(entry, 'registry must define universal-integrations');
    assert.deepStrictEqual(entry.routes, ['/integrations']);
    assert.deepStrictEqual(entry.apiPrefixes, ['/api/integrations']);
    assert.strictEqual(entry.defaultEnabled, true);
    assert.match(
      read('backend/src/app.js'),
      /app\.use\('\/api\/integrations', \.\.\.featureProtectedRoute\('universal-integrations'\), require\('\.\/routes\/integrations'\)\)/
    );
  });

  /* ------------------------------------------------------------------ boot */
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const owner = makeClient();
  const tenantA = makeClient();
  const staff = makeClient();
  const anon = makeClient();

  await test('owner + tenant admin + staff login', async () => {
    for (const c of [owner, tenantA, staff, anon]) await c.get('/api/csrf-token');
    const o = await owner.post('/api/auth/login', { email: 'platform@ndsairconditioning.com', password: 'Platform@12345' });
    assert.strictEqual(o.status, 200);
    assert.strictEqual(o.body.data.user.role, 'SUPER_ADMIN');
    owner.setBearer(o.body.data.accessToken);
    const a = await tenantA.post('/api/auth/login', { email: 'admin@ndsairconditioning.com', password: 'Admin@12345' });
    assert.strictEqual(a.status, 200);
    assert.strictEqual(a.body.data.user.role, 'TENANT_ADMIN');
    tenantA.setBearer(a.body.data.accessToken);
    const s = await staff.post('/api/auth/login', { email: 'staff@ndsairconditioning.com', password: 'Staff@12345' });
    assert.strictEqual(s.status, 200);
    staff.setBearer(s.body.data.accessToken);
  });

  /* ------------------------------------------------- fixtures across tenants */
  let tenantB;
  const stamp = Date.now();
  const SECRET_API_KEY = `sk-ui-admin-${stamp}-s3cr3t`;
  const SECRET_WEBHOOK = `whsec-ui-admin-${stamp}-s3cr3t`;
  let connA1;
  let connA2;
  let connB1;

  await test('tenant B fixture: business + admin user', async () => {
    tenantB = await prisma.business.create({
      data: { name: `UI Tenant B ${stamp}`, slug: `ui-tenant-b-int-${stamp}` },
    });
    tenantBId = tenantB.id;
    const email = `uitenantb.${stamp}@example.com`;
    await prisma.user.create({
      data: {
        name: 'UI Tenant B Admin', email, passwordHash: await bcrypt.hash('UiTenantB@12345', 12),
        role: 'ADMIN', businessId: tenantB.id,
      },
    });
    tenantB = makeClient();
    await tenantB.get('/api/csrf-token');
    const login = await tenantB.post('/api/auth/login', { email, password: 'UiTenantB@12345' });
    assert.strictEqual(login.status, 200, JSON.stringify(login.body));
    tenantB.setBearer(login.body.data.accessToken);
  });

  await test('fixtures: connected (A), secret-bearing (A) and idle (B) connections', async () => {
    const a1 = await tenantA.post('/api/integrations', {
      providerId: 'MANUAL_BANK_TRANSFER', name: `UI Conn A1 ${stamp}`,
      config: { bankName: 'UI Bank', accountName: 'UI A', accountNumber: '1001' },
    });
    assert.strictEqual(a1.status, 201, JSON.stringify(a1.body));
    connA1 = a1.body.data;
    trackedConnectionIds.push(connA1.id);
    assert.strictEqual((await tenantA.post(`/api/integrations/${connA1.id}/test`, {})).status, 200);

    const a2 = await tenantA.post('/api/integrations', {
      providerId: 'SANDBOX_DEMO', name: `UI Conn A2 ${stamp}`,
      authType: 'API_KEY',
      credentials: { apiKey: SECRET_API_KEY, webhookSecret: SECRET_WEBHOOK },
    });
    assert.strictEqual(a2.status, 201, JSON.stringify(a2.body));
    connA2 = a2.body.data;
    trackedConnectionIds.push(connA2.id);
    assert.strictEqual((await tenantA.post(`/api/integrations/${connA2.id}/test`, {})).status, 200);

    const b1 = await tenantB.post('/api/integrations', {
      providerId: 'MANUAL_BANK_TRANSFER', name: `UI Conn B1 ${stamp}`,
      config: { bankName: 'UI Bank B', accountName: 'UI B', accountNumber: '2002' },
    });
    assert.strictEqual(b1.status, 201, JSON.stringify(b1.body));
    connB1 = b1.body.data;
    trackedConnectionIds.push(connB1.id);
  });

  await test('fixtures: a failed operation exists for failure views', async () => {
    const bad = await tenantB.post('/api/integrations', {
      providerId: 'MANUAL_BANK_TRANSFER', name: `UI Conn B2 bad ${stamp}`, config: { bankName: 'X' },
    });
    assert.strictEqual(bad.status, 201);
    trackedConnectionIds.push(bad.body.data.id);
    const r = await tenantB.post(`/api/integrations/${bad.body.data.id}/test`, {});
    assert.strictEqual(r.status, 400);
  });

  /* ------------------------------------------------------- platform: owner */
  const CONNECTION_KEYS = new Set([
    'id', 'businessId', 'businessName', 'providerId', 'providerLabel', 'providerCategory',
    'name', 'authType', 'connectionMethod', 'capabilities', 'status',
    'lastTestedAt', 'lastConnectedAt', 'lastSyncAt', 'lastSyncStatus', 'lastError',
    'createdAt', 'updatedAt',
  ]);

  await test('platform overview: shape, real counts, tenant names, zero secret material', async () => {
    const r = await owner.get('/api/integrations/platform/overview');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const d = r.body.data;
    assert.ok(d.providers.total >= 2 && d.providers.available >= 2);
    assert.ok(Array.isArray(d.providers.byCategory));
    assert.ok(d.connections.total >= 4, `expected >=4 connections, saw ${d.connections.total}`);
    assert.ok(Array.isArray(d.connections.byStatus));
    assert.ok(Array.isArray(d.connections.byProvider));
    assert.ok(d.tenants.withConnections >= 2, 'both fixture tenants must be counted');
    assert.ok(d.tenants.connected >= 1);
    assert.ok(d.events.total >= 1);
    assert.ok(Array.isArray(d.recentEvents) && d.recentEvents.length >= 1);
    assert.ok(Array.isArray(d.failedConnections) && d.failedConnections.length >= 1);
    assert.ok(Array.isArray(d.recentWebhooks));
    assert.ok(d.recentEvents.every((e) => e.businessName), 'recent events carry tenant names');
    assert.ok(d.failedConnections.every((c) => c.businessName && c.lastError), 'failures carry tenant + error');
    for (const c of d.failedConnections) {
      assert.deepStrictEqual(Object.keys(c).sort(), [...CONNECTION_KEYS].sort());
    }
    const serialised = JSON.stringify(r.body);
    assert.ok(!serialised.includes(SECRET_API_KEY), 'overview must never contain secret values');
    assert.ok(!serialised.includes(SECRET_WEBHOOK), 'overview must never contain secret values');
    assert.ok(!serialised.includes('credentialsCipher'));
    assert.ok(!serialised.includes('webhookToken'));
  });

  await test('platform connections: cross-tenant list, safe-field allowlist, no leaks', async () => {
    const r = await owner.get('/api/integrations/platform/connections?limit=50');
    assert.strictEqual(r.status, 200);
    const ids = r.body.data.map((c) => c.id);
    assert.ok(ids.includes(connA1.id) && ids.includes(connA2.id) && ids.includes(connB1.id));
    for (const c of r.body.data) {
      assert.deepStrictEqual(Object.keys(c).sort(), [...CONNECTION_KEYS].sort(), `unsafe keys on ${c.id}`);
      assert.ok(c.businessName && c.providerLabel);
      assert.ok(Array.isArray(c.capabilities));
    }
    const serialised = JSON.stringify(r.body);
    assert.ok(!serialised.includes(SECRET_API_KEY));
    assert.ok(!serialised.includes(SECRET_WEBHOOK));
    assert.ok(!serialised.includes('credentialsCipher'));
    assert.ok(!serialised.includes('webhookToken'));
    assert.ok(!serialised.includes('credentialFields'));
  });

  await test('platform connections: filters and pagination', async () => {
    const byTenant = await owner.get(`/api/integrations/platform/connections?businessId=${tenantBId}&limit=50`);
    assert.strictEqual(byTenant.status, 200);
    assert.ok(byTenant.body.data.length >= 2);
    assert.ok(byTenant.body.data.every((c) => c.businessId === tenantBId));
    const connected = await owner.get('/api/integrations/platform/connections?status=CONNECTED&limit=50');
    assert.ok(connected.body.data.every((c) => c.status === 'CONNECTED'));
    assert.ok(connected.body.data.some((c) => c.id === connA1.id));
    const manual = await owner.get('/api/integrations/platform/connections?providerId=MANUAL_BANK_TRANSFER&limit=50');
    assert.ok(manual.body.data.every((c) => c.providerId === 'MANUAL_BANK_TRANSFER'));
    const psp = await owner.get('/api/integrations/platform/connections?category=PSP&limit=50');
    assert.ok(psp.body.data.every((c) => c.providerCategory === 'PSP'));
    const search = await owner.get(`/api/integrations/platform/connections?search=${encodeURIComponent(`UI Conn B1 ${stamp}`)}`);
    assert.ok(search.body.data.some((c) => c.id === connB1.id));
    const paged = await owner.get('/api/integrations/platform/connections?limit=1');
    assert.strictEqual(paged.body.data.length, 1);
    assert.ok(paged.body.meta.total >= 4 && paged.body.meta.pages > 1);
  });

  await test('platform events: cross-tenant activity with tenant names, filters, no leaks', async () => {
    const r = await owner.get('/api/integrations/platform/events?limit=100');
    assert.strictEqual(r.status, 200);
    const tenants = new Set(r.body.data.map((e) => e.businessId));
    assert.ok(tenants.size >= 2, 'platform events span both fixture tenants');
    for (const e of r.body.data) {
      assert.ok(e.businessName, 'event carries a tenant name');
      assert.ok(e.createdAt && typeof e.success === 'boolean' && typeof e.retryable === 'boolean');
    }
    const serialised = JSON.stringify(r.body);
    assert.ok(!serialised.includes(SECRET_API_KEY));
    assert.ok(!serialised.includes(SECRET_WEBHOOK));
    const failed = await owner.get('/api/integrations/platform/events?success=false&limit=100');
    assert.strictEqual(failed.status, 200);
    assert.ok(failed.body.data.length >= 1);
    assert.ok(failed.body.data.every((e) => e.success === false && e.errorCategory));
    const tests = await owner.get('/api/integrations/platform/events?operation=testConnection&limit=100');
    assert.ok(tests.body.data.every((e) => e.operation === 'testConnection'));
    const byTenant = await owner.get(`/api/integrations/platform/events?businessId=${tenantBId}&limit=100`);
    assert.ok(byTenant.body.data.length >= 1);
    assert.ok(byTenant.body.data.every((e) => e.businessId === tenantBId));
  });

  /* --------------------------------- platform denied: tenants/staff/anon */
  await test('TENANT_ADMIN cannot access the platform surface (both directions)', async () => {
    for (const client of [tenantA, tenantB]) {
      assert.strictEqual((await client.get('/api/integrations/platform/overview')).status, 403);
      assert.strictEqual((await client.get('/api/integrations/platform/connections')).status, 403);
      assert.strictEqual((await client.get('/api/integrations/platform/events')).status, 403);
    }
  });

  await test('tenant surface stays isolated in both directions', async () => {
    const listB = await tenantB.get('/api/integrations?limit=50');
    assert.strictEqual(listB.status, 200);
    assert.ok(listB.body.data.every((c) => c.businessId === tenantBId));
    assert.strictEqual((await tenantB.get(`/api/integrations/${connA1.id}`)).status, 404);
    assert.strictEqual((await tenantB.get(`/api/integrations/${connA1.id}/events`)).status, 404);
    assert.strictEqual((await tenantB.post(`/api/integrations/${connA1.id}/test`, {})).status, 404);
    assert.strictEqual((await tenantB.del(`/api/integrations/${connA1.id}`)).status, 404);
    assert.strictEqual((await tenantA.get(`/api/integrations/${connB1.id}`)).status, 404);
    assert.strictEqual((await tenantA.del(`/api/integrations/${connB1.id}`)).status, 404);
  });

  await test('RBAC: staff and anonymous callers are rejected from the platform surface', async () => {
    for (const client of [staff]) {
      assert.strictEqual((await client.get('/api/integrations/platform/overview')).status, 403);
      assert.strictEqual((await client.get('/api/integrations/platform/connections')).status, 403);
      assert.strictEqual((await client.get('/api/integrations/platform/events')).status, 403);
    }
    assert.strictEqual((await anon.get('/api/integrations/platform/overview')).status, 401);
    assert.strictEqual((await anon.get('/api/integrations/platform/connections')).status, 401);
    assert.strictEqual((await anon.get('/api/integrations/platform/events')).status, 401);
  });

  /* --------------------------------- rotation semantics consumed by the UI */
  await test('credential rotation: omitted keeps, null clears, descriptors stay honest', async () => {
    // Omitted credentials keep the stored secrets and the CONNECTED claim.
    const kept = await tenantA.put(`/api/integrations/${connA2.id}`, { name: `UI Conn A2 renamed ${stamp}` });
    assert.strictEqual(kept.status, 200);
    assert.strictEqual(kept.body.data.status, 'CONNECTED');
    assert.strictEqual(kept.body.data.credentialFields.length, 2);
    // Explicit null clears one secret and drops its descriptor.
    const cleared = await tenantA.put(`/api/integrations/${connA2.id}`, { credentials: { apiKey: null } });
    assert.strictEqual(cleared.status, 200);
    const names = cleared.body.data.credentialFields.map((f) => f.name);
    assert.deepStrictEqual(names, ['webhookSecret']);
    assert.ok(!JSON.stringify(cleared.body).includes(SECRET_API_KEY));
    // Restore the secret so later webhook verification can use it.
    const restored = await tenantA.put(`/api/integrations/${connA2.id}`, { credentials: { apiKey: SECRET_API_KEY } });
    assert.strictEqual(restored.status, 200);
    assert.strictEqual(restored.body.data.status, 'CONFIGURED');
    assert.strictEqual((await tenantA.post(`/api/integrations/${connA2.id}/test`, {})).status, 200);
  });

  /* --------------------------------------------------- webhook visibility */
  await test('platform owner sees verified webhook activity with tenant names', async () => {
    const ref = `UI-WH-${stamp}`;
    const raw = JSON.stringify({ event: 'PAYMENT_COMPLETED', reference: ref, amount: 42, currency: 'USD' });
    const row = await prisma.integrationConnection.findUnique({ where: { id: connA2.id } });
    const r = await fetch(`${base}/api/integrations/webhooks/SANDBOX_DEMO/${row.webhookToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-payment-signature': signHmac(SECRET_WEBHOOK, raw) },
      body: raw,
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).handled, true);
    const events = await owner.get('/api/integrations/platform/events?operation=receiveWebhook&limit=20');
    assert.strictEqual(events.status, 200);
    const seen = events.body.data.find((e) => e.externalReference === ref);
    assert.ok(seen, 'verified webhook must be visible to the platform owner');
    assert.ok(seen.businessName && seen.success === true);
    assert.ok(!JSON.stringify(events.body).includes(SECRET_WEBHOOK));
    const overview = await owner.get('/api/integrations/platform/overview');
    assert.ok(overview.body.data.events.webhooks >= 1);
    assert.ok(overview.body.data.recentWebhooks.some((e) => e.externalReference === ref));
  });

  /* ------------------------------------------------------- feature gating */
  let featureId;
  await test('feature entitlement: disabling universal-integrations blocks one tenant only', async () => {
    const list = await owner.get('/api/saas/features');
    assert.strictEqual(list.status, 200);
    const feature = list.body.data.find((f) => f.key === 'universal-integrations');
    assert.ok(feature, 'universal-integrations must be a manageable platform feature');
    featureId = feature.id;
    const off = await owner.patch(`/api/saas/features/${feature.id}/access/${tenantBId}`, { enabled: false });
    assert.strictEqual(off.status, 200, JSON.stringify(off.body));

    const blocked = await tenantB.get('/api/integrations');
    assert.strictEqual(blocked.status, 403);
    assert.match(blocked.body.error, /not enabled for this tenant/);
    assert.strictEqual((await tenantB.post('/api/integrations', { providerId: 'SANDBOX_DEMO', name: 'x' })).status, 403);

    // Other tenants and SUPER_ADMIN platform controls are unaffected.
    assert.strictEqual((await tenantA.get('/api/integrations?limit=1')).status, 200);
    assert.strictEqual((await owner.get('/api/integrations/platform/overview')).status, 200);

    const on = await owner.patch(`/api/saas/features/${feature.id}/access/${tenantBId}`, { enabled: true });
    assert.strictEqual(on.status, 200);
    assert.strictEqual((await tenantB.get('/api/integrations?limit=1')).status, 200);
  });

  /* -------------------------------------------------------------- cleanup */
  await test('cleanup fixtures', async () => {
    const businessIds = ['default', tenantBId];
    const tenantAUsers = await prisma.user.findMany({ where: { businessId: { in: businessIds } }, select: { id: true, businessId: true } });
    void tenantAUsers;
    await prisma.integrationEvent.deleteMany({
      where: { businessId: { in: businessIds }, createdAt: { gte: suiteStart } },
    });
    await prisma.integrationConnection.deleteMany({ where: { id: { in: trackedConnectionIds } } });
    assert.strictEqual(await prisma.integrationConnection.count({ where: { id: { in: trackedConnectionIds } } }), 0);
    if (featureId) {
      await prisma.tenantFeatureAccess.deleteMany({ where: { featureId, businessId: tenantBId } });
    }
    // PostgreSQL enforces Business/User FKs (RESTRICT) — audit/activity rows
    // referencing the tenant or its users must go before the tenant itself.
    const tenantBUserIds = (await prisma.user.findMany({
      where: { businessId: tenantBId }, select: { id: true },
    })).map((u) => u.id);
    await prisma.auditLog.deleteMany({
      where: { OR: [{ businessId: tenantBId }, { userId: { in: tenantBUserIds } }] },
    });
    await prisma.activity.deleteMany({
      where: { OR: [{ businessId: tenantBId }, { userId: { in: tenantBUserIds } }] },
    });
    await prisma.user.deleteMany({ where: { businessId: tenantBId } });
    await prisma.business.delete({ where: { id: tenantBId } });
  });

  server.close();
  await prisma.$disconnect();

  const pass = results.filter((r) => r[0] === 'PASS').length;
  console.log('\nUniversal Integrations Admin UI verification\n============================================');
  for (const [state, name] of results) console.log(`  ${state === 'PASS' ? '✔' : '✘'} ${name}`);
  console.log(`\n${pass}/${results.length} checks passed${failures ? ` — ${failures} FAILED` : ''}\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
