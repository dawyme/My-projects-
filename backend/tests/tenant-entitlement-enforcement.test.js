/**
 * Global Feature Management — Tenant Entitlement Enforcement.
 *
 * Proves the central entitlement architecture end to end, for every feature
 * below (universal-integrations, content-manager, service-bookings, orders,
 * customers):
 *
 *   Enabled → Disable for tenants → tenant fully blocked/removed →
 *   SUPER_ADMIN unaffected → Re-enable → tenant restored per RBAC.
 *
 * For EACH feature the suite verifies:
 *   • tenant navigation removed   (via /api/features/access, which drives the
 *     shell nav — plus static proof the shell filters through that set)
 *   • tenant dashboard surfaces removed (data-feature declarations + the
 *     central applyEntitlements helper — statically pinned per feature)
 *   • tenant direct route blocked  (central featureForPath gate — statically
 *     pinned per route; the shell blocks before any page code runs)
 *   • tenant API blocked           (live HTTP 403 on the feature's read AND
 *     write endpoints, including the in-router orders gate on order payment
 *     capture/refund — no back door around a disabled feature)
 *   • SUPER_ADMIN still has access (live HTTP 200 on the same APIs, owner
 *     operational alias included, and the key stays in the owner access set)
 *   • re-enable restores the tenant exactly per normal RBAC (feature back,
 *     owner-only surfaces still 403, staff permissions unchanged)
 *   • a sibling tenant is never affected (per-tenant scoping, not global)
 *
 * Plus the hard requirements:
 *   • NO-SPILLOVER: disabling for tenants — including a GLOBAL isActive flip —
 *     must NEVER restrict SUPER_ADMIN. These tests FAIL if tenant feature
 *     state is ever applied application-wide.
 *   • N&D'S protection: the platform-owned default business cannot receive a
 *     tenant toggle (400) and never appears in the tenant roster; the owner
 *     keeps businessId = NULL and no fake tenant grant is created.
 *   • Tenant isolation is preserved: cross-tenant reads 404, and disabled
 *     features cannot be used to bypass isolation (the 403 gate pre-empts).
 *   • No one-off checks: pages declare data-feature and share ONE mechanism;
 *     literal per-feature branches are forbidden by static test.
 *
 *   node backend/tests/tenant-entitlement-enforcement.test.js
 */
require('dotenv').config();
const assert = require('assert');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const { JSDOM, VirtualConsole } = require('jsdom');

process.env.RATE_LIMIT_API_MAX = process.env.RATE_LIMIT_API_MAX || '20000';
process.env.RATE_LIMIT_WRITE_MAX = process.env.RATE_LIMIT_WRITE_MAX || '20000';

const app = require('../src/app');
const prisma = require('../src/lib/prisma');

const ROOT = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

let base = '';
const results = [];
let failures = 0;
const tracked = { businessIds: [], userIds: [], customerIds: [] };

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

const FAKE_ID = '00000000-0000-0000-0000-000000000000';

// Every feature under test: shell route, tenant probes ([method, path, body,
// allowedStatus]) and owner probes. Write probes use invalid/empty bodies or
// fake ids on purpose: an allowed request fails validation/lookup (400/404),
// NEVER 403 — so 403 unambiguously means "blocked by the entitlement gate"
// while nothing is ever mutated by the probes themselves.
const FEATURES = [
  {
    key: 'universal-integrations', route: '/integrations',
    tenantProbes: [
      ['GET', '/api/integrations?limit=5', undefined, 200],
      ['POST', '/api/integrations', {}, 400],
    ],
    ownerProbes: [
      ['GET', '/api/integrations/providers', undefined, 200],
      ['GET', '/api/integrations/platform/owner/connections?limit=5', undefined, 200],
      ['POST', '/api/integrations', {}, 400],
    ],
  },
  {
    key: 'content-manager', route: '/content',
    tenantProbes: [
      ['GET', '/api/content', undefined, 200],
      ['GET', '/api/site-content/testimonials?limit=1', undefined, 200],
    ],
    ownerProbes: [
      ['GET', '/api/content', undefined, 200],
      ['GET', '/api/site-content/testimonials?limit=1', undefined, 200],
    ],
  },
  {
    key: 'service-bookings', route: '/bookings',
    tenantProbes: [
      ['GET', '/api/bookings?limit=5', undefined, 200],
      ['POST', '/api/bookings', {}, 400],
    ],
    ownerProbes: [
      ['GET', '/api/bookings?limit=5', undefined, 200],
    ],
  },
  {
    key: 'orders', route: '/orders',
    tenantProbes: [
      ['GET', '/api/orders?limit=5', undefined, 200],
      ['POST', '/api/orders', {}, 400],
      // In-router orders gate: order payment capture/refund must follow the
      // feature too (fake id → 404 when allowed, so 403 proves the gate).
      ['POST', `/api/payments/${FAKE_ID}/capture`, {}, 404],
      ['POST', `/api/payments/${FAKE_ID}/refund`, {}, 404],
    ],
    ownerProbes: [
      ['GET', '/api/orders?limit=5', undefined, 200],
      ['POST', `/api/payments/${FAKE_ID}/capture`, {}, 404],
      ['POST', `/api/payments/${FAKE_ID}/refund`, {}, 404],
    ],
  },
  {
    key: 'customers', route: '/customers',
    tenantProbes: [
      ['GET', '/api/customers?limit=5', undefined, 200],
      ['POST', '/api/customers', {}, 400],
    ],
    ownerProbes: [
      ['GET', '/api/customers?limit=5', undefined, 200],
    ],
  },
];

async function runProbes(client, probes, label) {
  for (const [method, url, body, allowed] of probes) {
    const r = body === undefined ? await client.req(method, url) : await client.req(method, url, body);
    assert.strictEqual(r.status, allowed, `${label}: ${method} ${url} → ${r.status}, expected ${allowed} (${r.text.slice(0, 160)})`);
  }
}

async function expectBlocked(client, probes, label) {
  for (const [method, url, body] of probes) {
    const r = body === undefined ? await client.req(method, url) : await client.req(method, url, body);
    assert.strictEqual(r.status, 403, `${label}: ${method} ${url} → ${r.status}, expected 403 (${r.text.slice(0, 160)})`);
    assert.match(r.body?.error || '', /not enabled for this tenant/, `${label}: ${method} ${url} must be denied by the entitlement gate`);
  }
}

async function accessKeys(client) {
  const r = await client.get('/api/features/access');
  assert.strictEqual(r.status, 200, `/api/features/access → ${r.status}`);
  return (r.body.data || []).map((f) => f.key);
}

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const owner = makeClient();
  const tenantB = makeClient();
  const tenantC = makeClient();
  const staff = makeClient();
  let tenantBId; let tenantCId;
  const featureIds = new Map();

  /* ------------------------------------------------- identities + N&D'S */
  await test('SUPER_ADMIN logs in with businessId NULL (platform owner, not a tenant)', async () => {
    await owner.get('/api/csrf-token');
    const r = await owner.post('/api/auth/login', { email: 'platform@ndsairconditioning.com', password: 'Platform@12345' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.data.user.role, 'SUPER_ADMIN');
    assert.strictEqual(r.body.data.user.businessId, null, 'owner must keep businessId = NULL (no fake tenant grant)');
    owner.setBearer(r.body.data.accessToken);
    await staff.get('/api/csrf-token');
    const s = await staff.post('/api/auth/login', { email: 'staff@ndsairconditioning.com', password: 'Staff@12345' });
    assert.strictEqual(s.status, 200);
    staff.setBearer(s.body.data.accessToken);
  });

  await test('customer tenant fixtures B + C (business + admin each)', async () => {
    const stamp = Date.now();
    for (const [slot, tag] of [['B', 'ent-b'], ['C', 'ent-c']]) {
      const biz = await prisma.business.create({ data: { name: `Entitlement ${slot} ${stamp}`, slug: `${tag}-${stamp}` } });
      if (slot === 'B') tenantBId = biz.id; else tenantCId = biz.id;
      tracked.businessIds.push(biz.id);
      const email = `${tag}.${stamp}@example.com`;
      const u = await prisma.user.create({
        data: { name: `${slot} Admin`, email, passwordHash: await bcrypt.hash('Ent@12345x', 12), role: 'ADMIN', businessId: biz.id },
      });
      tracked.userIds.push(u.id);
      const client = slot === 'B' ? tenantB : tenantC;
      await client.get('/api/csrf-token');
      const login = await client.post('/api/auth/login', { email, password: 'Ent@12345x' });
      assert.strictEqual(login.status, 200, JSON.stringify(login.body));
      assert.strictEqual(login.body.data.user.role, 'TENANT_ADMIN');
      client.setBearer(login.body.data.accessToken);
    }
  });

  await test('N&D’S platform business is not a customer tenant (no toggle, not listed)', async () => {
    const list = await owner.get('/api/saas/features');
    assert.strictEqual(list.status, 200);
    for (const f of FEATURES) {
      const row = list.body.data.find((x) => x.key === f.key);
      assert.ok(row, `feature ${f.key} must be centrally manageable`);
      featureIds.set(f.key, row.id);
      assert.ok(!row.tenants.some((t) => t.id === 'default'), `${f.key}: N&D'S must never appear in the tenant roster`);
    }
    // The toggle endpoint itself refuses the platform business.
    const refused = await owner.patch(`/api/saas/features/${featureIds.get('orders')}/access/default`, { enabled: false });
    assert.strictEqual(refused.status, 400, `toggling N&D'S must be refused, got ${refused.status}`);
  });

  /* ------------------------------------------------- tenant isolation */
  await test('tenant isolation holds (cross-tenant reads 404 both directions)', async () => {
    const stamp = Date.now();
    const custB = await prisma.customer.create({ data: { businessId: tenantBId, name: 'Iso Bee', email: `iso-b-${stamp}@example.com` } });
    const custC = await prisma.customer.create({ data: { businessId: tenantCId, name: 'Iso Cee', email: `iso-c-${stamp}@example.com` } });
    tracked.customerIds.push(custB.id, custC.id);
    assert.strictEqual((await tenantB.get(`/api/customers/${custB.id}`)).status, 200);
    assert.strictEqual((await tenantB.get(`/api/customers/${custC.id}`)).status, 404);
    assert.strictEqual((await tenantC.get(`/api/customers/${custC.id}`)).status, 200);
    assert.strictEqual((await tenantC.get(`/api/customers/${custB.id}`)).status, 404);
    const listB = await tenantB.get('/api/customers?limit=100');
    assert.ok(listB.body.data.every((c) => c.id !== custC.id), 'tenant B list must exclude tenant C rows');
    const listC = await tenantC.get('/api/customers?limit=100');
    assert.ok(listC.body.data.every((c) => c.id !== custB.id), 'tenant C list must exclude tenant B rows');
  });

  /* ------------------------------------------------- lifecycle per feature */
  for (const f of FEATURES) {
    await test(`${f.key}: initially enabled for the tenant`, async () => {
      assert.ok((await accessKeys(tenantB)).includes(f.key), 'tenant access set must contain the feature');
      await runProbes(tenantB, f.tenantProbes, `${f.key} baseline`);
    });

    await test(`${f.key}: disable for tenants → tenant blocked, sibling + owner untouched`, async () => {
      const off = await owner.patch(`/api/saas/features/${featureIds.get(f.key)}/access/${tenantBId}`, { enabled: false });
      assert.strictEqual(off.status, 200, JSON.stringify(off.body));
      // Tenant navigation + direct-route + dashboard visibility all derive
      // from this set: the key must vanish for the tenant only.
      assert.ok(!(await accessKeys(tenantB)).includes(f.key), 'disabled feature must vanish from the tenant access set');
      assert.ok((await accessKeys(tenantC)).includes(f.key), 'sibling tenant must keep the feature (per-tenant scope)');
      assert.ok((await accessKeys(owner)).includes(f.key), 'SUPER_ADMIN must keep the feature (no spillover)');
      // Tenant API access is blocked server-side (reads AND writes).
      await expectBlocked(tenantB, f.tenantProbes, f.key);
      // A disabled feature cannot become an isolation bypass: the 403 gate
      // pre-empts every handler, so cross-tenant probing is impossible too.
      assert.strictEqual((await tenantB.get(`/api/customers/${tracked.customerIds[1]}`)).status,
        f.key === 'customers' ? 403 : 404, 'disabled → 403 gate; enabled → 404 isolation');
      // Sibling tenant keeps working.
      await runProbes(tenantC, f.tenantProbes, `${f.key} sibling`);
      // SUPER_ADMIN keeps FULL operational access on the same APIs.
      await runProbes(owner, f.ownerProbes, `${f.key} owner`);
    });

    await test(`${f.key}: re-enable restores tenant access per normal RBAC`, async () => {
      const on = await owner.patch(`/api/saas/features/${featureIds.get(f.key)}/access/${tenantBId}`, { enabled: true });
      assert.strictEqual(on.status, 200);
      assert.ok((await accessKeys(tenantB)).includes(f.key), 'tenant access set must contain the feature again');
      await runProbes(tenantB, f.tenantProbes, `${f.key} restored`);
      // Restored means the FEATURE — never owner privileges.
      assert.strictEqual((await tenantB.get('/api/integrations/platform/owner/connections?limit=1')).status, 403);
    });
  }

  await test('RBAC is unchanged after the cycles (staff + tenant limits intact)', async () => {
    assert.strictEqual((await staff.get('/api/integrations/providers')).status, 403, 'staff never gains integration management');
    assert.strictEqual((await tenantB.get('/api/saas/businesses')).status, 403, 'tenants never gain platform management');
    assert.strictEqual((await tenantB.get('/api/content/homepage')).status, 200, 'tenant route-level content API works');
  });

  /* ------------------------------------------------- live shell E2E (jsdom) */
  // Boots the REAL tenant + owner shells in jsdom with features disabled for
  // tenant B and asserts what each role actually SEES: nav links, direct
  // routes and dashboard surfaces. This is the end-to-end proof behind the
  // access-set + static checks above.
  const ADMIN_DIR = path.join(ROOT, 'admin');
  const MODULE_TAG = /<script type="module">([\s\S]*?)<\/script>/;
  async function bundleEntry(entryFile, entryDir) {
    const html = fs.readFileSync(path.join(entryDir, entryFile), 'utf8').replace(/<link[^>]+fonts\.googleapis[^>]*>/g, '');
    const match = html.match(MODULE_TAG);
    assert.ok(match, `${entryFile} must boot through an inline module script`);
    const entryName = `.test-entry-ent-${path.basename(entryFile, '.html')}-${Date.now()}.js`;
    const entryPath = path.join(ADMIN_DIR, entryName);
    // esbuild's IIFE format cannot emit top-level await (the tenant entry
    // uses it), so the entry body runs inside an async wrapper with static
    // imports hoisted above it. Execution order and imports are unchanged —
    // this only adapts the module shape for the jsdom harness.
    const head = (match[1].match(/^\s*(?:import[\s\S]*?;\s*)+/) || [''])[0];
    const wrapped = `${head};(async () => {\n${match[1].slice(head.length)}\n})();`;
    fs.writeFileSync(entryPath, wrapped);
    try {
      const result = await esbuild.build({
        entryPoints: [entryPath], bundle: true, write: false,
        format: 'iife', platform: 'browser', target: 'es2020',
        plugins: [{
          name: 'root-absolute-resolver',
          setup(build) {
            build.onResolve({
              filter: /^\/(?:admin|tenant|technician|customer|superadmin|assets|auth)(?:\/|$)|^\/[a-zA-Z0-9._-]+\.(?:js|mjs|css)(?:$|[?#])/,
            }, (args) => {
              if (args.path.startsWith(ROOT)) return null;
              return { path: path.join(ROOT, args.path.split('?')[0].split('#')[0]) };
            });
          },
        }],
      });
      return { html: html.replace(MODULE_TAG, ''), script: result.outputFiles[0].text };
    } finally {
      fs.unlinkSync(entryPath);
    }
  }
  function installFetch(window, urlBase) {
    const jar = new Map();
    const syncFromDoc = () => {
      for (const part of (window.document.cookie || '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
      }
    };
    window.fetch = async (input, init = {}) => {
      syncFromDoc();
      const url = new URL(String(input && input.url ? input.url : input), urlBase).toString();
      const headers = new Headers(init.headers || {});
      const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookie) headers.set('cookie', cookie);
      const res = await fetch(url, { ...init, headers, redirect: 'manual' });
      for (const c of res.headers.getSetCookie?.() || []) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        const k = pair.slice(0, i);
        const v = pair.slice(i + 1);
        if (v === '') jar.delete(k); else { jar.set(k, v); window.document.cookie = `${k}=${v}; path=/`; }
      }
      return res;
    };
    window.Headers = Headers;
    window.FormData = FormData;
    window.Request = Request;
    window.Response = Response;
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(fn, timeout = 12000, step = 60) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try { if (await fn()) return true; } catch (_) {}
      await wait(step);
    }
    return false;
  }
  async function bootShell({ entryFile, entryDir, pageUrl, session, hash = '#/' }) {
    const page = await bundleEntry(entryFile, entryDir);
    const jsErrors = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', (e) => {
      if (!/Could not parse CSS|Not implemented/.test(e.message)) jsErrors.push(e.message);
    });
    virtualConsole.on('error', (...args) => {
      const msg = args.join(' ');
      if (!/Not implemented|Could not parse CSS/.test(msg)) jsErrors.push(msg);
    });
    const dom = new JSDOM(page.html, {
      url: `${base}${pageUrl}`, runScripts: 'dangerously', resources: 'usable',
      pretendToBeVisual: true, virtualConsole,
      beforeParse(window) {
        installFetch(window, base);
        window.localStorage.setItem('nds.auth', session);
        window.scrollTo = () => {};
        window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
        window.URL.createObjectURL = () => 'blob:mock';
        window.URL.revokeObjectURL = () => {};
      },
    });
    const w = dom.window;
    const doc = w.document;
    const s = w.document.createElement('script');
    s.textContent = page.script;
    w.document.body.appendChild(s);
    const ready = await until(() => doc.querySelector('.sidebar') && doc.querySelector('#view'));
    assert.ok(ready, `${pageUrl} shell must boot`);
    if (hash !== '#/') {
      w.location.hash = hash;
      await until(() => {
        const view = doc.getElementById('view');
        return view && !view.querySelector('.spinner') && (view.textContent || '').length > 40;
      });
    } else {
      await until(() => {
        const view = doc.getElementById('view');
        return view && !view.querySelector('.spinner') && (view.textContent || '').length > 60;
      });
    }
    return { dom, w, doc, jsErrors };
  }

  await test('E2E tenant shell: disabled features vanish from nav, routes + dashboard', async () => {
    for (const key of ['orders', 'service-bookings']) {
      const off = await owner.patch(`/api/saas/features/${featureIds.get(key)}/access/${tenantBId}`, { enabled: false });
      assert.strictEqual(off.status, 200);
    }
    // Fresh session snapshot for the browser (same shape the login page stores).
    const login = await tenantB.post('/api/auth/login', { email: (await prisma.user.findUnique({ where: { id: tracked.userIds[0] } })).email, password: 'Ent@12345x' });
    assert.strictEqual(login.status, 200);
    tenantB.setBearer(login.body.data.accessToken);
    const session = JSON.stringify({ accessToken: login.body.data.accessToken, refreshToken: login.body.data.refreshToken, user: login.body.data.user });

    const { dom, w, doc, jsErrors } = await bootShell({
      entryFile: 'index.html', entryDir: path.join(ROOT, 'tenant'), pageUrl: '/tenant/index.html', session,
    });
    try {
      // Navigation: disabled features are gone, enabled controls remain.
      assert.strictEqual(doc.querySelector('.nav-link[data-path="/orders"]'), null, 'tenant nav must not list orders');
      assert.strictEqual(doc.querySelector('.nav-link[data-path="/bookings"]'), null, 'tenant nav must not list bookings');
      assert.ok(doc.querySelector('.nav-link[data-path="/customers"]'), 'tenant nav must keep customers (control)');
      assert.ok(doc.querySelector('.nav-link[data-path="/content"]'), 'tenant nav must keep content (control)');
      // Dashboard surfaces: booking/order widgets/cards hidden, others stay.
      // (hidden elements keep their textContent, so assert the hidden state.)
      const hidden = (sel) => doc.querySelector(sel)?.closest('section,article')?.hidden === true;
      const shown = (sel) => {
        const node = doc.querySelector(sel)?.closest('section,article');
        return !!node && node.hidden !== true;
      };
      assert.ok(hidden('#upcoming'), 'upcoming appointments section must hide');
      assert.ok(hidden('#statusChart'), 'bookings chart section must hide');
      assert.ok(hidden('#trendSection') === false, 'trend section must stay (reports still enabled)');
      assert.ok(shown('#lowStock'), 'low-stock section must stay (inventory still enabled)');
      const cards = [...doc.querySelectorAll('#stats .stat')];
      const card = (label) => cards.find((c) => (c.textContent || '').includes(label));
      assert.ok(card('Service Bookings')?.hidden === true, 'bookings stat card must hide');
      assert.ok(card('Pending Bookings')?.hidden === true, 'pending bookings card must hide');
      assert.ok(card('Revenue')?.hidden === true, 'revenue card must hide (orders + bookings both off)');
      assert.ok(card('Total Products') && card('Total Products').hidden !== true, 'products card must stay (control)');
      assert.ok(doc.querySelector('[data-entitlement-hidden="service-bookings"]'), 'helper must mark hidden surfaces');
      // Direct routes: typing the URL is blocked server-side-safe with the
      // Feature Management explanation (no page code ever runs).
      w.location.hash = '#/orders';
      assert.ok(await until(() => (doc.getElementById('view').textContent || '').includes('not enabled for your business')),
        'direct #/orders must be blocked for the tenant');
      w.location.hash = '#/bookings';
      assert.ok(await until(() => (doc.getElementById('view').textContent || '').includes('not enabled for your business')),
        'direct #/bookings must be blocked for the tenant');
      // Enabled routes still render.
      w.location.hash = '#/customers';
      assert.ok(await until(() => {
        const t = doc.getElementById('view').textContent || '';
        return t.includes('Customers') && !t.includes('not enabled for your business');
      }), 'direct #/customers must render (control)');
      assert.strictEqual(jsErrors.length, 0, `tenant shell must boot cleanly (saw: ${jsErrors.slice(0, 2).join(' | ')})`);
    } finally {
      dom.window.close();
    }
    for (const key of ['orders', 'service-bookings']) {
      const on = await owner.patch(`/api/saas/features/${featureIds.get(key)}/access/${tenantBId}`, { enabled: true });
      assert.strictEqual(on.status, 200);
    }
  });

  await test('E2E owner shell: tenant-disabled features stay fully visible + usable', async () => {
    for (const key of ['orders', 'service-bookings']) {
      const off = await owner.patch(`/api/saas/features/${featureIds.get(key)}/access/${tenantBId}`, { enabled: false });
      assert.strictEqual(off.status, 200);
    }
    try {
      const login = await owner.post('/api/auth/login', { email: 'platform@ndsairconditioning.com', password: 'Platform@12345' });
      assert.strictEqual(login.status, 200);
      owner.setBearer(login.body.data.accessToken);
      const session = JSON.stringify({ accessToken: login.body.data.accessToken, refreshToken: login.body.data.refreshToken, user: login.body.data.user });
      const { dom, w, doc, jsErrors } = await bootShell({
        entryFile: 'index.html', entryDir: path.join(ROOT, 'admin'), pageUrl: '/admin/index.html', session,
      });
      try {
        // Owner nav keeps everything despite the tenant disable.
        assert.ok(doc.querySelector('.nav-link[data-path="/orders"]'), 'owner nav must keep orders');
        assert.ok(doc.querySelector('.nav-link[data-path="/bookings"]'), 'owner nav must keep bookings');
        // Owner dashboard keeps the surfaces (nothing entitlement-hidden).
        assert.ok(doc.querySelector('#upcoming')?.closest('section')?.hidden !== true,
          'owner dashboard must keep upcoming appointments');
        assert.strictEqual(doc.querySelectorAll('#view [data-entitlement-hidden]').length, 0,
          'owner must have zero entitlement-hidden surfaces');
        // Owner direct routes render (never the blocked page).
        w.location.hash = '#/orders';
        assert.ok(await until(() => {
          const t = doc.getElementById('view').textContent || '';
          return t.includes('New order') && !t.includes('not enabled for your business');
        }), 'owner #/orders must render while disabled for tenants');
        assert.strictEqual(jsErrors.length, 0, `owner shell must boot cleanly (saw: ${jsErrors.slice(0, 2).join(' | ')})`);
      } finally {
        dom.window.close();
      }
    } finally {
      for (const key of ['orders', 'service-bookings']) {
        await owner.patch(`/api/saas/features/${featureIds.get(key)}/access/${tenantBId}`, { enabled: true });
      }
    }
  });

  await test('E2E tenant shell: re-enable brings nav, routes + dashboard back', async () => {
    const user = await prisma.user.findUnique({ where: { id: tracked.userIds[0] } });
    const login = await tenantB.post('/api/auth/login', { email: user.email, password: 'Ent@12345x' });
    tenantB.setBearer(login.body.data.accessToken);
    const session = JSON.stringify({ accessToken: login.body.data.accessToken, refreshToken: login.body.data.refreshToken, user: login.body.data.user });
    const { dom, w, doc } = await bootShell({
      entryFile: 'index.html', entryDir: path.join(ROOT, 'tenant'), pageUrl: '/tenant/index.html', session,
    });
    try {
      assert.ok(doc.querySelector('.nav-link[data-path="/orders"]'), 'tenant nav must list orders again');
      assert.ok(doc.querySelector('.nav-link[data-path="/bookings"]'), 'tenant nav must list bookings again');
      assert.ok(doc.querySelector('#upcoming')?.closest('section')?.hidden !== true,
        'tenant dashboard must show upcoming appointments again');
      assert.strictEqual(doc.querySelectorAll('#view [data-entitlement-hidden]').length, 0,
        'no surfaces stay hidden after re-enable');
      w.location.hash = '#/orders';
      assert.ok(await until(() => {
        const t = doc.getElementById('view').textContent || '';
        return t.includes('New order') && !t.includes('not enabled for your business');
      }), 'direct #/orders must render again after re-enable');
    } finally {
      dom.window.close();
    }
  });

  /* ------------------------------------------------- global no-spillover */
  await test('NO-SPILLOVER: global deactivation blocks every customer tenant, never SUPER_ADMIN', async () => {
    const list = await owner.get('/api/saas/features');
    const row = list.body.data.find((x) => x.key === 'content-manager');
    const restore = {
      key: row.key, name: row.name, description: row.description,
      isActive: row.isActive, isCore: row.isCore, defaultEnabled: row.defaultEnabled,
    };
    try {
      const off = await owner.patch(`/api/saas/features/${row.id}`, { ...restore, isActive: false });
      assert.strictEqual(off.status, 200, JSON.stringify(off.body));
      // Every customer tenant loses it…
      assert.strictEqual((await tenantB.get('/api/content')).status, 403);
      assert.strictEqual((await tenantC.get('/api/content')).status, 403);
      assert.strictEqual((await tenantB.get('/api/site-content/testimonials?limit=1')).status, 403);
      assert.ok(!(await accessKeys(tenantB)).includes('content-manager'));
      // …while SUPER_ADMIN stays fully operational. If tenant feature state
      // were ever applied application-wide, these assertions would fail.
      assert.strictEqual((await owner.get('/api/content')).status, 200);
      assert.strictEqual((await owner.get('/api/site-content/testimonials?limit=1')).status, 200);
      assert.ok((await accessKeys(owner)).includes('content-manager'), 'owner access set must keep a globally-deactivated feature');
    } finally {
      const on = await owner.patch(`/api/saas/features/${row.id}`, restore);
      assert.strictEqual(on.status, 200, `global flag must restore, got ${on.status}`);
    }
    assert.strictEqual((await tenantB.get('/api/content')).status, 200, 'tenant access returns after global restore');
    assert.strictEqual((await tenantC.get('/api/content')).status, 200, 'sibling access returns after global restore');
  });

  /* ------------------------------------------------- static: central mechanism */
  await test('static: registry defines every tested feature with routes + API prefixes', async () => {
    const { TENANT_FEATURE_REGISTRY } = require('../src/lib/feature-registry');
    const expected = {
      'universal-integrations': [['/integrations'], ['/api/integrations']],
      'content-manager': [['/content'], ['/api/content', '/api/site-content']],
      'service-bookings': [['/bookings'], ['/api/bookings']],
      orders: [['/orders'], ['/api/orders']],
      customers: [['/customers'], ['/api/customers']],
    };
    for (const [key, [routes, prefixes]] of Object.entries(expected)) {
      const entry = TENANT_FEATURE_REGISTRY.find((f) => f.key === key);
      assert.ok(entry, `registry must define ${key}`);
      assert.deepStrictEqual(entry.routes, routes, `${key} routes`);
      assert.deepStrictEqual(entry.apiPrefixes, prefixes, `${key} apiPrefixes`);
      assert.strictEqual(entry.defaultEnabled, true, `${key} must default on for new tenants`);
    }
  });

  await test('static: API mounts gate every tested prefix (central featureProtectedRoute)', async () => {
    const appSrc = read('backend/src/app.js');
    for (const f of FEATURES) {
      for (const [, url] of f.tenantProbes) {
        const prefix = url.startsWith('/api/payments/') ? null : `/${url.split('?')[0].split('/').slice(1, 3).join('/')}`;
        if (!prefix) continue; // in-router gate (asserted separately below)
        assert.match(appSrc, new RegExp(`app\\.use\\('${prefix.replace(/\//g, '\\/')}', \\.\\.\\.featureProtectedRoute\\('${f.key}'\\)`),
          `${prefix} must sit behind featureProtectedRoute('${f.key}')`);
      }
    }
    const payments = read('backend/src/routes/payments.js');
    assert.match(payments, /requireFeature\('orders'\)/, 'order capture/refund must carry the in-router orders gate');
  });

  await test('static: shell gates tenant nav + direct routes centrally (per-feature metadata)', async () => {
    const layout = read('admin/js/layout.js');
    // The mechanism (shared, not per-feature)…
    assert.match(layout, /await auth\.refreshFeatures\(\)/, 'boot must load the central feature set');
    assert.match(layout, /auth\.hasFeature\(i\.feature\)/, 'nav items hide through the central entitlement set');
    assert.match(layout, /featureForPath\(path\)/, 'direct routes resolve through the central metadata lookup');
    assert.match(layout, /not enabled for your business/, 'blocked direct routes explain Feature Management');
    assert.match(layout, /from '\.\/entitlements\.js'/, 'shell must share the central tenant/owner context check');
    // …and the per-feature metadata it acts on (declarations, not branches).
    for (const f of FEATURES) {
      assert.ok(layout.includes(`path: '${f.route}'`) && layout.includes(`feature: '${f.key}'`),
        `nav metadata must bind ${f.route} to ${f.key}`);
    }
  });

  await test('static: dashboard surfaces declare entitlements (no per-feature branches)', async () => {
    const dashboard = read('admin/js/pages/dashboard.js');
    assert.match(dashboard, /from '\.\.\/entitlements\.js'/, 'dashboard must use the central helper');
    assert.ok(dashboard.includes('applyEntitlements(view)'), 'dashboard must apply entitlements after render');
    // Stat cards: the template emits data-feature/data-feature-any from a
    // declarative per-card mapping (declarations, not branches).
    assert.ok(dashboard.includes('data-feature="${feature}"'), 'stat cards must emit data-feature from the mapping');
    assert.ok(dashboard.includes('data-feature-any="${featureAny}"'), 'stat cards must emit data-feature-any from the mapping');
    for (const key of ['products', 'service-bookings', 'customers', 'messages', 'inventory']) {
      assert.ok(dashboard.includes(`feature: '${key}'`), `dashboard must map a stat card to ${key}`);
    }
    // Revenue blends order + booking takings, so it declares the OR-form.
    assert.ok(dashboard.includes(`featureAny: 'orders service-bookings'`),
      'dashboard revenue card must declare its orders/service-bookings entitlement');
    // Sections + quick actions carry literal data-feature attributes.
    for (const key of ['reports', 'service-bookings', 'inventory', 'recurring-maintenance']) {
      assert.ok(dashboard.includes(`data-feature="${key}"`), `dashboard must gate a section with ${key}`);
    }
    // The analytics fetch is skipped generically when its section is hidden —
    // no 403, no error flash, and no literal feature check.
    assert.ok(dashboard.includes("view.querySelector('#trendSection')?.hidden"), 'trend fetch must follow the applied entitlement state');
    // universal-integrations surfaces through the settings tab (same mechanism).
    const settings = read('admin/js/pages/settings.js');
    assert.ok(settings.includes('data-feature="universal-integrations"'), 'settings integrations tab must declare its entitlement');
    assert.ok(settings.includes('applyEntitlements(view)'), 'settings must apply entitlements');
    // content-manager has no dashboard surface to remove (nav + route + API
    // carry it); pin that so a future surface cannot slip in ungated.
    assert.doesNotMatch(dashboard, /#\/content/, 'any future dashboard content surface must be added gated');
  });

  await test('static: cross-page discovery links declare entitlements', async () => {
    const cases = [
      ['admin/js/pages/calendar.js', 'data-feature="service-bookings"'],
      ['admin/js/pages/pos.js', 'data-feature="orders"'],
      ['admin/js/pages/messages.js', 'data-feature="customers"'],
      ['admin/js/pages/supplier-fulfillment.js', 'data-feature="orders"'],
    ];
    for (const [file, marker] of cases) {
      const src = read(file);
      assert.ok(src.includes(marker), `${file} must declare ${marker}`);
      assert.ok(src.includes('applyEntitlements('), `${file} must apply entitlements`);
    }
  });

  await test('static: no one-off per-feature checks anywhere in the dashboard shell', async () => {
    // Pages may DECLARE features (NAV `feature: 'x'` metadata, data-feature
    // attributes, registry entries) but must never BRANCH on them. A literal
    // hasFeature('x') / canSee('x') / === 'x' check for a tested feature key
    // anywhere under admin/js fails this test.
    const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
      .filter((f) => f.endsWith('.js'));
    for (const file of walk('admin/js')) {
      const src = read(file);
      for (const fn of ['hasFeature', 'canSee', 'canSeeAny']) {
        assert.ok(!src.includes(`${fn}('`) && !src.includes(`${fn}("`),
          `${file} must not call ${fn}() with a literal feature key (declare data-feature instead)`);
      }
      for (const f of FEATURES) {
        for (const op of ['===', '!==', '==']) {
          assert.ok(!src.includes(`${op} '${f.key}'`) && !src.includes(`${op} "${f.key}"`),
            `${file} must not compare against '${f.key}' (use the central mechanism)`);
        }
        assert.ok(!src.includes(`includes('${f.key}')`) && !src.includes(`case '${f.key}'`),
          `${file} must not branch on '${f.key}' (use the central mechanism)`);
      }
    }
    // The central helper itself stays generic: tenant-only filtering driven
    // by the server set, with the owner path a no-op.
    const ent = read('admin/js/entitlements.js');
    assert.match(ent, /export function isTenantAdmin/, 'central tenant/owner context check');
    assert.match(ent, /export function canSee/, 'central visibility check');
    assert.match(ent, /export function applyEntitlements/, 'central surface applier');
    assert.match(ent, /if \(!isTenantAdmin\(user\)\) return/, 'non-tenant contexts are never filtered');
  });

  /* ------------------------------------------------- cleanup */
  await test('cleanup fixtures + restore feature state', async () => {
    for (const key of featureIds.keys()) {
      const id = featureIds.get(key);
      for (const biz of tracked.businessIds) {
        await owner.patch(`/api/saas/features/${id}/access/${biz}`, { enabled: true }).catch(() => {});
      }
      await prisma.tenantFeatureAccess.deleteMany({ where: { featureId: id, businessId: { in: tracked.businessIds } } }).catch(() => {});
      await prisma.platformFeature.updateMany({ where: { id, isActive: false }, data: { isActive: true } }).catch(() => {});
    }
    await prisma.customer.deleteMany({ where: { id: { in: tracked.customerIds } } }).catch(() => {});
    await prisma.contentPage.deleteMany({ where: { businessId: { in: tracked.businessIds } } }).catch(() => {});
    const ids = (await prisma.user.findMany({ where: { businessId: { in: tracked.businessIds } }, select: { id: true } })).map((u) => u.id);
    await prisma.auditLog.deleteMany({ where: { OR: [{ businessId: { in: tracked.businessIds } }, { userId: { in: ids } }] } }).catch(() => {});
    await prisma.activity.deleteMany({ where: { OR: [{ businessId: { in: tracked.businessIds } }, { userId: { in: ids } }] } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: [...new Set([...ids, ...tracked.userIds])] } } }).catch(() => {});
    await prisma.business.deleteMany({ where: { id: { in: tracked.businessIds } } }).catch(() => {});
    assert.strictEqual(await prisma.business.count({ where: { id: { in: tracked.businessIds } } }), 0);
    assert.strictEqual(await prisma.user.count({ where: { id: { in: tracked.userIds } } }), 0);
  });

  server.close();
  await prisma.$disconnect();

  const pass = results.filter((r) => r[0] === 'PASS').length;
  console.log('\nGlobal Feature Management — Tenant Entitlement Enforcement\n==============================================================');
  for (const [state, name] of results) console.log(`  ${state === 'PASS' ? '✔' : '✘'} ${name}`);
  console.log(`\n${pass}/${results.length} checks passed${failures ? ` — ${failures} FAILED` : ''}\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
