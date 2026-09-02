/**
 * End-to-end API verification. Starts the app on an ephemeral port and exercises
 * every route group with both ADMIN and STAFF credentials.
 *   npm test
 */
require('dotenv').config();
const assert = require('assert');
const app = require('../src/app');
const prisma = require('../src/lib/prisma');

let base = '';
const results = [];
let failures = 0;

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
    get token() { return bearer; },
    async req(method, path, body, opts = {}) {
      const headers = { ...(opts.headers || {}) };
      if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
      const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookie) headers.Cookie = cookie;
      if (csrf) headers['x-csrf-token'] = csrf;
      if (bearer && !opts.noBearer) headers.Authorization = `Bearer ${bearer}`;
      const res = await fetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : (body instanceof FormData ? body : JSON.stringify(body)),
        redirect: 'manual',
      });
      for (const c of res.headers.getSetCookie?.() || []) {
        const [pair] = c.split(';');
        const idx = pair.indexOf('=');
        const k = pair.slice(0, idx); const v = pair.slice(idx + 1);
        if (v === '') jar.delete(k); else jar.set(k, v);
        if (k === 'hvac_csrf') csrf = v;
      }
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) {}
      return { status: res.status, body: json, text, headers: res.headers };
    },
    get(p, o) { return this.req('GET', p, undefined, o); },
    post(p, b, o) { return this.req('POST', p, b, o); },
    put(p, b, o) { return this.req('PUT', p, b, o); },
    patch(p, b, o) { return this.req('PATCH', p, b, o); },
    del(p, b, o) { return this.req('DELETE', p, b, o); },
  };
}

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const admin = makeClient();
  const staff = makeClient();
  const anon = makeClient();

  // ---------- infrastructure
  await test('GET /health returns healthy', async () => {
    const r = await anon.get('/health');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.status, 'healthy');
  });
  await test('GET /api/status returns ok', async () => {
    const r = await anon.get('/api/status');
    assert.strictEqual(r.body.status, 'ok');
  });
  await test('GET /api/csrf-token issues a token', async () => {
    const r = await admin.get('/api/csrf-token');
    assert.ok(r.body.data.csrfToken.length > 10);
    await staff.get('/api/csrf-token');
    await anon.get('/api/csrf-token');
  });

  // ---------- auth
  await test('POST /api/auth/login rejects bad credentials', async () => {
    const r = await anon.post('/api/auth/login', { email: 'admin@ndsairconditioning.com', password: 'wrong-password' });
    assert.strictEqual(r.status, 401);
  });
  await test('POST /api/auth/login validates the payload', async () => {
    const r = await anon.post('/api/auth/login', { email: 'not-an-email', password: '' });
    assert.strictEqual(r.status, 400);
    assert.ok(Array.isArray(r.body.details));
  });
  await test('POST /api/auth/login succeeds for ADMIN', async () => {
    const r = await admin.post('/api/auth/login', { email: process.env.SEED_ADMIN_EMAIL || 'admin@ndsairconditioning.com', password: process.env.SEED_ADMIN_PASSWORD || 'Admin@12345' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.data.user.role, 'ADMIN');
    assert.ok(r.body.data.accessToken);
    admin.setBearer(r.body.data.accessToken);
  });
  await test('POST /api/auth/login succeeds for STAFF', async () => {
    const r = await staff.post('/api/auth/login', { email: process.env.SEED_STAFF_EMAIL || 'staff@ndsairconditioning.com', password: process.env.SEED_STAFF_PASSWORD || 'Staff@12345' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.data.user.role, 'STAFF');
    staff.setBearer(r.body.data.accessToken);
  });
  await test('GET /api/auth/me returns the session user', async () => {
    const r = await admin.get('/api/auth/me');
    assert.strictEqual(r.body.data.user.role, 'ADMIN');
  });
  await test('GET /api/auth/me rejects anonymous requests', async () => {
    const r = await anon.get('/api/auth/me');
    assert.strictEqual(r.status, 401);
  });
  await test('GET /api/auth/me rejects a forged token', async () => {
    const r = await anon.get('/api/auth/me', { headers: { Authorization: 'Bearer not.a.token' } });
    assert.strictEqual(r.status, 401);
  });
  await test('POST /api/auth/refresh rotates tokens', async () => {
    const c = makeClient();
    await c.get('/api/csrf-token');
    const login = await c.post('/api/auth/login', { email: 'admin@ndsairconditioning.com', password: 'Admin@12345' });
    const r = await c.post('/api/auth/refresh', { refreshToken: login.body.data.refreshToken });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.data.accessToken);
    const reuse = await c.post('/api/auth/refresh', { refreshToken: login.body.data.refreshToken });
    assert.strictEqual(reuse.status, 401, 'rotated refresh token must not be reusable');
  });
  await test('POST /api/auth/logout revokes the session', async () => {
    const c = makeClient();
    await c.get('/api/csrf-token');
    const login = await c.post('/api/auth/login', { email: 'staff@ndsairconditioning.com', password: 'Staff@12345' });
    const out = await c.post('/api/auth/logout', { refreshToken: login.body.data.refreshToken });
    assert.strictEqual(out.status, 200);
    const after = await c.post('/api/auth/refresh', { refreshToken: login.body.data.refreshToken });
    assert.strictEqual(after.status, 401);
  });

  // ---------- CSRF
  await test('CSRF blocks cookie-authenticated writes without a token', async () => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@ndsairconditioning.com', password: 'Admin@12345' }),
    });
    assert.strictEqual(res.status, 403);
  });

  // ---------- dashboard
  let stats;
  await test('GET /api/dashboard/stats returns every widget', async () => {
    const r = await admin.get('/api/dashboard/stats');
    stats = r.body.data;
    for (const k of ['products', 'bookings', 'customers', 'messages', 'inventory', 'revenue']) assert.ok(stats[k], `missing ${k}`);
    assert.ok(stats.products.total > 0);
  });
  await test('GET /api/dashboard/activity returns the feed', async () => {
    const r = await admin.get('/api/dashboard/activity?limit=5');
    assert.ok(Array.isArray(r.body.data));
  });
  await test('GET /api/dashboard/upcoming returns bookings', async () => {
    const r = await admin.get('/api/dashboard/upcoming');
    assert.ok(Array.isArray(r.body.data));
  });
  await test('GET /api/dashboard/low-stock returns alerts', async () => {
    const r = await admin.get('/api/dashboard/low-stock');
    assert.ok(Array.isArray(r.body.data));
  });

  // ---------- categories & products
  let categoryId, productId;
  await test('GET /api/categories lists all 10 catalogue categories', async () => {
    const r = await admin.get('/api/categories');
    assert.ok(r.body.data.length >= 10);
    categoryId = r.body.data[0].id;
  });
  await test('POST /api/products creates a product', async () => {
    const r = await admin.post('/api/products', {
      sku: `TEST-${Date.now()}`, name: 'Test Inverter Condenser', categoryId,
      price: 499.99, costPrice: 320, quantity: 12, lowStockLevel: 4, brand: 'TestBrand',
      specs: { Warranty: '24 months' },
    });
    assert.strictEqual(r.status, 201);
    productId = r.body.data.id;
  });
  await test('POST /api/products rejects an invalid payload', async () => {
    const r = await admin.post('/api/products', { sku: 'X', name: '', categoryId: 'nope' });
    assert.strictEqual(r.status, 400);
  });
  await test('GET /api/products paginates', async () => {
    const r = await admin.get('/api/products?page=1&limit=5');
    assert.strictEqual(r.body.data.length, 5);
    assert.ok(r.body.meta.pages > 1);
  });
  await test('GET /api/products searches', async () => {
    const r = await admin.get('/api/products?search=compressor');
    assert.ok(r.body.data.length > 0);
  });
  await test('GET /api/products filters by low stock', async () => {
    const r = await admin.get('/api/products?lowStock=true');
    assert.ok(r.body.data.every((p) => p.quantity <= p.lowStockLevel));
  });
  await test('GET /api/products exports CSV', async () => {
    const r = await admin.get('/api/products?format=csv');
    assert.ok(r.text.startsWith('SKU,Name'));
  });
  await test('PUT /api/products/:id updates a product', async () => {
    const r = await admin.put(`/api/products/${productId}`, { price: 459, featured: true });
    assert.strictEqual(r.body.data.price, 459);
    assert.strictEqual(r.body.data.featured, true);
  });
  await test('POST /api/products/bulk-update applies a price adjustment', async () => {
    const r = await admin.post('/api/products/bulk-update', { ids: [productId], updates: { priceAdjustPercent: 10 } });
    assert.strictEqual(r.body.data.updated, 1);
    const p = await admin.get(`/api/products/${productId}`);
    assert.ok(Math.abs(p.body.data.price - 504.9) < 0.05);
  });
  await test('DELETE /api/products/:id is admin-only', async () => {
    const r = await staff.del(`/api/products/${productId}`);
    assert.strictEqual(r.status, 403);
  });
  await test('POST /api/products/bulk-delete removes products', async () => {
    const r = await admin.post('/api/products/bulk-delete', { ids: [productId] });
    assert.strictEqual(r.body.data.deleted, 1);
  });

  // ---------- customers
  let customerId;
  await test('GET /api/customers paginates and searches', async () => {
    const r = await admin.get('/api/customers?limit=5&search=a');
    assert.ok(Array.isArray(r.body.data));
    const all = await admin.get('/api/customers?limit=1');
    customerId = all.body.data[0].id;
  });
  await test('GET /api/customers/:id includes booking and purchase history', async () => {
    const r = await admin.get(`/api/customers/${customerId}`);
    assert.ok(Array.isArray(r.body.data.bookings));
    assert.ok(Array.isArray(r.body.data.orders));
    assert.ok(typeof r.body.data.stats.lifetimeValue === 'number');
  });
  await test('GET /api/customers exports CSV', async () => {
    const r = await admin.get('/api/customers?format=csv');
    assert.ok(r.text.startsWith('Name,Email'));
  });
  await test('POST + PUT + DELETE /api/customers round-trips', async () => {
    const email = `test.customer.${Date.now()}@example.com`;
    const created = await admin.post('/api/customers', { name: 'Test Customer', email, phone: '+1 555 9999', city: 'Springfield' });
    assert.strictEqual(created.status, 201);
    const updated = await admin.put(`/api/customers/${created.body.data.id}`, { city: 'Riverton' });
    assert.strictEqual(updated.body.data.city, 'Riverton');
    const removed = await admin.del(`/api/customers/${created.body.data.id}`);
    assert.strictEqual(removed.status, 200);
  });

  // ---------- bookings
  let bookingId, technicianId;
  await test('GET /api/users lists staff for technician assignment', async () => {
    const r = await admin.get('/api/users');
    assert.ok(r.body.data.length >= 3);
    technicianId = r.body.data.find((u) => u.role === 'STAFF').id;
  });
  await test('POST /api/bookings creates a booking with a new customer', async () => {
    const r = await admin.post('/api/bookings', {
      customer: { name: 'Walk-in Client', email: `walkin.${Date.now()}@example.com`, phone: '+1 555 7777' },
      scheduledAt: new Date(Date.now() + 864e5).toISOString(),
      description: 'Automated test booking', price: 150,
    });
    assert.strictEqual(r.status, 201);
    assert.ok(r.body.data.reference.startsWith('BK-'));
    bookingId = r.body.data.id;
  });
  await test('PATCH /api/bookings/:id/assign assigns a technician', async () => {
    const r = await admin.patch(`/api/bookings/${bookingId}/assign`, { technicianId });
    assert.strictEqual(r.body.data.technicianId, technicianId);
  });
  await test('PATCH /api/bookings/:id/status walks the full status flow', async () => {
    for (const status of ['CONFIRMED', 'IN_PROGRESS', 'COMPLETED']) {
      const r = await admin.patch(`/api/bookings/${bookingId}/status`, { status, notify: false });
      assert.strictEqual(r.body.data.status, status);
    }
    const r = await admin.patch(`/api/bookings/${bookingId}/status`, { status: 'CANCELLED', notify: false });
    assert.strictEqual(r.body.data.status, 'CANCELLED');
  });
  await test('PATCH /api/bookings/:id/status rejects an unknown status', async () => {
    const r = await admin.patch(`/api/bookings/${bookingId}/status`, { status: 'NOT_A_STATUS' });
    assert.strictEqual(r.status, 400);
  });
  await test('POST /api/bookings/:id/notes adds a note', async () => {
    const r = await admin.post(`/api/bookings/${bookingId}/notes`, { body: 'Technician note from the test suite.' });
    assert.strictEqual(r.status, 201);
  });
  await test('GET /api/bookings/:id includes notes and customer history', async () => {
    const r = await admin.get(`/api/bookings/${bookingId}`);
    assert.ok(r.body.data.notes.length >= 1);
    assert.ok(Array.isArray(r.body.data.customerHistory));
  });
  await test('GET /api/bookings/calendar groups by day', async () => {
    const r = await admin.get(`/api/bookings/calendar?month=${new Date().toISOString().slice(0, 7)}`);
    assert.ok(r.body.data.days && typeof r.body.data.total === 'number');
  });
  await test('GET /api/bookings filters by status', async () => {
    const r = await admin.get('/api/bookings?status=COMPLETED');
    assert.ok(r.body.data.every((b) => b.status === 'COMPLETED'));
  });
  await test('GET /api/bookings exports CSV', async () => {
    const r = await admin.get('/api/bookings?format=csv');
    assert.ok(r.text.startsWith('Reference,Customer'));
  });
  await test('DELETE /api/bookings/:id is admin-only and works', async () => {
    assert.strictEqual((await staff.del(`/api/bookings/${bookingId}`)).status, 403);
    assert.strictEqual((await admin.del(`/api/bookings/${bookingId}`)).status, 200);
  });

  // ---------- services
  await test('GET /api/services lists services', async () => {
    const r = await admin.get('/api/services');
    assert.ok(r.body.data.length >= 6);
  });

  // ---------- messages
  let messageId;
  await test('POST /api/public/contact creates an inbox message', async () => {
    const r = await anon.post('/api/public/contact', {
      name: 'Website Visitor', email: 'visitor@example.com', subject: 'Test enquiry',
      message: 'This enquiry was generated by the automated test suite.',
    });
    assert.strictEqual(r.status, 201);
    messageId = r.body.data.id;
  });
  await test('GET /api/messages returns status counts', async () => {
    const r = await admin.get('/api/messages');
    assert.ok(r.body.meta.summary.UNREAD >= 1);
  });
  await test('GET /api/messages/:id marks the message read', async () => {
    const r = await admin.get(`/api/messages/${messageId}`);
    assert.strictEqual(r.body.data.status, 'READ');
  });
  await test('POST /api/messages/:id/reply stores a reply', async () => {
    const r = await admin.post(`/api/messages/${messageId}/reply`, { body: 'Thank you for contacting N&D\'S Air Conditioning & Refrigeration Services.' });
    assert.strictEqual(r.status, 201);
  });
  await test('POST /api/messages/bulk archives messages', async () => {
    const r = await admin.post('/api/messages/bulk', { ids: [messageId], action: 'archive' });
    assert.strictEqual(r.body.data.affected, 1);
  });
  await test('DELETE /api/messages/:id is admin-only', async () => {
    assert.strictEqual((await staff.del(`/api/messages/${messageId}`)).status, 403);
    assert.strictEqual((await admin.del(`/api/messages/${messageId}`)).status, 200);
  });

  // ---------- inventory
  let invProductId;
  await test('GET /api/inventory summarises stock', async () => {
    const r = await admin.get('/api/inventory');
    assert.ok(r.body.meta.summary.totalSkus > 0);
    invProductId = r.body.data[0].id;
  });
  await test('GET /api/inventory/alerts lists low stock', async () => {
    const r = await admin.get('/api/inventory/alerts');
    assert.ok(r.body.data.length >= 1);
  });
  await test('POST /api/inventory/adjust changes stock and logs it', async () => {
    const before = (await admin.get(`/api/products/${invProductId}`)).body.data.quantity;
    const r = await admin.post('/api/inventory/adjust', { productId: invProductId, change: 5, reason: 'Test adjustment' });
    assert.strictEqual(r.body.data.product.quantity, before + 5);
  });
  await test('POST /api/inventory/adjust rejects negative stock', async () => {
    const r = await admin.post('/api/inventory/adjust', { productId: invProductId, change: -100000, reason: 'Overdraw' });
    assert.strictEqual(r.status, 400);
  });
  await test('POST /api/inventory/restock records a restock', async () => {
    const r = await admin.post('/api/inventory/restock', { productId: invProductId, quantity: 10, unitCost: 42, supplier: 'Test Supplier' });
    assert.strictEqual(r.status, 201);
  });
  await test('GET /api/inventory/restocks and /adjustments paginate', async () => {
    assert.ok((await admin.get('/api/inventory/restocks?limit=5')).body.data.length > 0);
    assert.ok((await admin.get('/api/inventory/adjustments?limit=5')).body.data.length > 0);
  });
  await test('GET /api/inventory/report returns totals and CSV', async () => {
    const json = await admin.get('/api/inventory/report');
    assert.ok(json.body.data.totals.skus > 0);
    const csv = await admin.get('/api/inventory/report?format=csv');
    assert.ok(csv.text.startsWith('SKU,Product'));
  });

  // ---------- orders
  await test('POST /api/orders creates an order and decrements stock', async () => {
    const product = (await admin.get('/api/products?limit=1&sort=quantity&order=desc')).body.data[0];
    const customer = (await admin.get('/api/customers?limit=1')).body.data[0];
    const before = product.quantity;
    const r = await admin.post('/api/orders', { customerId: customer.id, taxRate: 7.5, items: [{ productId: product.id, quantity: 2 }] });
    assert.strictEqual(r.status, 201);
    const after = (await admin.get(`/api/products/${product.id}`)).body.data.quantity;
    assert.strictEqual(after, before - 2);
    const cancelled = await admin.patch(`/api/orders/${r.body.data.id}/status`, { status: 'CANCELLED' });
    assert.strictEqual(cancelled.body.data.status, 'CANCELLED');
    assert.strictEqual((await admin.get(`/api/products/${product.id}`)).body.data.quantity, before);
    await admin.del(`/api/orders/${r.body.data.id}`);
  });
  await test('POST /api/orders rejects insufficient stock', async () => {
    const product = (await admin.get('/api/products?limit=1')).body.data[0];
    const customer = (await admin.get('/api/customers?limit=1')).body.data[0];
    const r = await admin.post('/api/orders', { customerId: customer.id, items: [{ productId: product.id, quantity: 999999 }] });
    assert.strictEqual(r.status, 400);
  });

  // ---------- analytics
  await test('GET /api/analytics/overview returns every chart series', async () => {
    const r = await admin.get('/api/analytics/overview?months=12');
    const d = r.body.data;
    assert.strictEqual(d.labels.length, 12);
    for (const k of ['monthlyBookings', 'sales', 'revenueTrend', 'customerGrowth', 'productPerformance']) assert.ok(d[k], `missing ${k}`);
  });
  await test('GET /api/analytics/technicians ranks technicians', async () => {
    const r = await admin.get('/api/analytics/technicians');
    assert.ok(r.body.data.length >= 1);
  });

  // ---------- settings
  await test('GET /api/settings returns all sections', async () => {
    const r = await admin.get('/api/settings');
    for (const k of ['company', 'hours', 'social', 'email', 'payment', 'seo']) assert.ok(r.body.data[k], `missing ${k}`);
  });
  await test('PUT /api/settings/company persists changes (admin only)', async () => {
    assert.strictEqual((await staff.put('/api/settings/company', { name: 'Nope' })).status, 403);
    const r = await admin.put('/api/settings/company', { name: 'N&D\'S Air Conditioning & Refrigeration Services', email: 'info@ndsairconditioning.com', phone: '+1 555 0102030' });
    assert.strictEqual(r.status, 200);
    const check = await admin.get('/api/settings');
    assert.strictEqual(check.body.data.company.phone, '+1 555 0102030');
  });
  await test('PUT /api/settings/:section rejects an unknown section', async () => {
    assert.strictEqual((await admin.put('/api/settings/bogus', { a: 1 })).status, 400);
  });

  // ---------- users / RBAC
  await test('POST /api/users is admin-only and creates staff', async () => {
    assert.strictEqual((await staff.post('/api/users', { name: 'X Y', email: 'x@y.com', password: 'Passw0rd!' })).status, 403);
    const email = `tech.${Date.now()}@ndsairconditioning.com`;
    const created = await admin.post('/api/users', { name: 'Test Technician', email, password: 'Passw0rd123', role: 'STAFF' });
    assert.strictEqual(created.status, 201);
    const updated = await admin.put(`/api/users/${created.body.data.id}`, { isActive: false });
    assert.strictEqual(updated.status, 200);
    assert.strictEqual((await admin.del(`/api/users/${created.body.data.id}`)).status, 200);
  });
  await test('Admins cannot be locked out of the system', async () => {
    const me = (await admin.get('/api/auth/me')).body.data.user;
    const r = await admin.put(`/api/users/${me.id}`, { role: 'STAFF' });
    assert.strictEqual(r.status, 400);
  });

  await test('a tenant admin cannot edit or delete a platform-admin / global (businessId: null) account', async () => {
    const email = `global-tech.${Date.now()}@ndsairconditioning.com`;
    const globalUser = await prisma.user.create({
      data: { name: 'Global Shared Technician', email, passwordHash: '$2a$12$abcdefghijklmnopqrstuv', role: 'STAFF', businessId: null },
    });
    const editAttempt = await admin.put(`/api/users/${globalUser.id}`, { name: 'Hijacked' });
    assert.strictEqual(editAttempt.status, 404, 'a tenant admin must not be able to edit a businessId:null account');
    const deleteAttempt = await admin.del(`/api/users/${globalUser.id}`);
    assert.strictEqual(deleteAttempt.status, 404, 'a tenant admin must not be able to delete a businessId:null account');
    const stillThere = await prisma.user.findUnique({ where: { id: globalUser.id } });
    assert.ok(stillThere, 'the global account must not have been affected');
    assert.strictEqual(stillThere.name, 'Global Shared Technician');
    await prisma.user.delete({ where: { id: globalUser.id } });
  });

  await test('a platform admin retains the ability to manage a businessId: null account', async () => {
    const platform = makeClient();
    await platform.req('GET', '/api/csrf-token');
    const login = await platform.post('/api/auth/login', {
      email: process.env.SEED_PLATFORM_EMAIL || 'platform@ndsairconditioning.com',
      password: process.env.SEED_PLATFORM_PASSWORD || 'Platform@12345',
    });
    assert.strictEqual(login.status, 200, JSON.stringify(login.body));
    platform.setBearer(login.body.data.accessToken);

    const email = `global-tech-2.${Date.now()}@ndsairconditioning.com`;
    const globalUser = await prisma.user.create({
      data: { name: 'Global Shared Technician 2', email, passwordHash: '$2a$12$abcdefghijklmnopqrstuv', role: 'STAFF', businessId: null },
    });
    const editAttempt = await platform.put(`/api/users/${globalUser.id}`, { name: 'Renamed By Platform' });
    assert.strictEqual(editAttempt.status, 200, 'a platform admin must retain the ability to manage global accounts');
    assert.strictEqual(editAttempt.body.data.name, 'Renamed By Platform');
    await prisma.user.delete({ where: { id: globalUser.id } });
  });

  // ---------- audit logs
  await test('GET /api/audit-logs is admin-only and records actions', async () => {
    assert.strictEqual((await staff.get('/api/audit-logs')).status, 403);
    const r = await admin.get('/api/audit-logs?limit=10');
    assert.ok(r.body.data.length > 0);
  });

  // ---------- public API
  await test('GET /api/public/products is open and hides stock counts', async () => {
    const r = await anon.get('/api/public/products?limit=6');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.data.length > 0);
    assert.strictEqual(r.body.data[0].quantity, undefined);
    assert.strictEqual(typeof r.body.data[0].inStock, 'boolean');
  });
  await test('GET /api/public/categories and /services are open', async () => {
    assert.ok((await anon.get('/api/public/categories')).body.data.length >= 10);
    assert.ok((await anon.get('/api/public/services')).body.data.length >= 6);
  });
  await test('GET /api/public/settings exposes business info only', async () => {
    const r = await anon.get('/api/public/settings');
    assert.ok(r.body.data.company.name);
    assert.strictEqual(r.body.data.payment, undefined);
  });
  await test('POST /api/public/bookings creates a pending booking', async () => {
    const r = await anon.post('/api/public/bookings', {
      name: 'Public Booker', email: `public.${Date.now()}@example.com`,
      phone: '+1 555 3333', scheduledAt: new Date(Date.now() + 2 * 864e5).toISOString(),
      description: 'Public booking from the test suite',
    });
    assert.strictEqual(r.status, 201);
    assert.ok(r.body.data.reference);
  });

  // ---------- security
  await test('Input sanitisation neutralises script payloads', async () => {
    const email = `xss.${Date.now()}@example.com`;
    const r = await admin.post('/api/customers', { name: '<script>alert(1)</script>Evil', email });
    assert.ok(!r.body.data.name.includes('<script'));
    await admin.del(`/api/customers/${r.body.data.id}`);
  });
  await test('SQL injection attempts are treated as literal search text', async () => {
    const r = await admin.get(`/api/products?search=${encodeURIComponent("'; DROP TABLE Product;--")}`);
    assert.strictEqual(r.status, 200);
    assert.ok((await admin.get('/api/products?limit=1')).body.data.length === 1, 'Product table intact');
  });
  await test('Unknown routes return a JSON 404', async () => {
    const r = await admin.get('/api/does-not-exist');
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.body.success, false);
  });
  await test('Malformed JSON returns a 400 rather than crashing', async () => {
    const res = await fetch(`${base}/api/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.token}` },
      body: '{ not valid json',
    });
    assert.strictEqual(res.status, 400);
  });

  // ---------- static assets
  await test('Admin dashboard HTML is served', async () => {
    const r = await anon.get('/admin/index.html');
    assert.strictEqual(r.status, 200);
    assert.ok(r.text.includes('<!DOCTYPE html>'));
  });

  server.close();
  await prisma.$disconnect();

  const pass = results.filter((r) => r[0] === 'PASS').length;
  console.log('\nAPI verification\n================');
  for (const [state, name] of results) console.log(`  ${state === 'PASS' ? '✔' : '✘'} ${name}`);
  console.log(`\n${pass}/${results.length} checks passed${failures ? ` — ${failures} FAILED` : ''}\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
