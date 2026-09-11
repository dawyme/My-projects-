require('dotenv').config();
const assert = require('assert');
const bcrypt = require('bcryptjs');
const app = require('../src/app');
const prisma = require('../src/lib/prisma');

let base;
function client() {
  let bearer = null;
  let csrf = null;
  const jar = new Map();
  return {
    bearer(token) { bearer = token; },
    async req(method, path, body) {
      const headers = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (bearer) headers.Authorization = `Bearer ${bearer}`;
      const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookie) headers.Cookie = cookie;
      if (csrf) headers['x-csrf-token'] = csrf;
      const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      for (const set of response.headers.getSetCookie?.() || []) {
        const pair = set.split(';')[0];
        const i = pair.indexOf('=');
        const key = pair.slice(0, i); const value = pair.slice(i + 1);
        if (value === '') jar.delete(key); else jar.set(key, value);
        if (key === 'hvac_csrf') csrf = value;
      }
      const text = await response.text();
      let json; try { json = JSON.parse(text); } catch { json = null; }
      return { status: response.status, body: json };
    },
    get(path) { return this.req('GET', path); },
    post(path, body) { return this.req('POST', path, body); },
    patch(path, body) { return this.req('PATCH', path, body); },
  };
}

async function logoutRole(role, email, password) {
  const c = client();
  assert.strictEqual((await c.get('/api/csrf-token')).status, 200);
  const login = await c.post('/api/auth/login', { email, password });
  assert.strictEqual(login.status, 200, `${role} login failed`);
  assert.strictEqual(login.body.data.user.role, role);
  const refreshToken = login.body.data.refreshToken;
  c.bearer(login.body.data.accessToken);
  assert.strictEqual((await c.get('/api/auth/me')).status, 200);
  assert.strictEqual((await c.post('/api/auth/logout', { refreshToken })).status, 200);
  assert.strictEqual((await c.get('/api/auth/me')).status, 401, `${role} session survived logout`);
  assert.strictEqual((await c.post('/api/auth/refresh', { refreshToken })).status, 401, `${role} refresh token survived logout`);
}

async function main() {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const createdUsers = [];
  let planId;
  try {
    const platformEmail = process.env.SEED_PLATFORM_EMAIL;
    const platformPassword = process.env.SEED_PLATFORM_PASSWORD;
    const regressionPassword = process.env.REGRESSION_TEST_PASSWORD;
    assert.ok(platformEmail && platformPassword && regressionPassword, 'Isolated regression credentials are required');

    const platform = client();
    assert.strictEqual((await platform.get('/api/csrf-token')).status, 200);
    const login = await platform.post('/api/auth/login', { email: platformEmail, password: platformPassword });
    assert.strictEqual(login.status, 200);
    assert.strictEqual(login.body.data.user.role, 'SUPER_ADMIN');
    platform.bearer(login.body.data.accessToken);

    const stamp = Date.now();
    const slug = `regression-edit-${stamp}`;
    let r = await platform.post('/api/saas/plans', {
      name: `Regression Edit ${stamp}`, slug, description: 'Before edit', price: 12,
      currency: 'USD', interval: 'month', features: { support: false }, limits: { users: 1 }, isActive: true,
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    planId = r.body.data.id;
    r = await platform.patch(`/api/saas/plans/${planId}`, {
      name: `Regression Edited ${stamp}`, slug: `${slug}-updated`, description: 'After edit', price: 29,
      currency: 'USD', interval: 'year', features: { support: true }, limits: { users: 10 }, isActive: false,
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.data.price, 29);
    assert.strictEqual(r.body.data.interval, 'year');
    assert.strictEqual(r.body.data.isActive, false);
    assert.strictEqual(r.body.data.features.support, true);
    assert.strictEqual(r.body.data.limits.users, 10);

    const hash = await bcrypt.hash(regressionPassword, 4);
    const suffix = Date.now();
    const users = [
      ['TENANT_ADMIN', 'ADMIN', `logout-tenant-${suffix}@example.com`, 'Logout Tenant'],
      ['TECHNICIAN', 'STAFF', `logout-tech-${suffix}@example.com`, 'Logout Technician'],
      ['CUSTOMER', 'CUSTOMER', `logout-customer-${suffix}@example.com`, 'Logout Customer'],
    ];
    for (const [effectiveRole, dbRole, email, name] of users) {
      const u = await prisma.user.create({ data: { name, email, passwordHash: hash, role: dbRole, businessId: 'default', isActive: true } });
      createdUsers.push(u.id);
      await logoutRole(effectiveRole, email, regressionPassword);
    }
    console.log('Auth + plan regression: PASS');
  } finally {
    try { if (planId) await prisma.plan.delete({ where: { id: planId } }); } catch {}
    try {
      if (createdUsers.length) {
        await prisma.refreshToken.deleteMany({ where: { userId: { in: createdUsers } } });
        await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
      }
    } catch {}
    server.close();
  }
}

main().catch((e) => { console.error('Auth + plan regression: FAIL', e.stack || e); process.exitCode = 1; });
