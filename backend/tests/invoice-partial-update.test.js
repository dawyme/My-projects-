require('dotenv').config();
/** Regression: a partial invoice update (e.g. only `status`) must not wipe the stored line items or total. */
const assert = require('assert');
const dbUrl = process.env.DATABASE_URL || '';
if (/supabase\.(co|com)|pooler\./i.test(dbUrl) && process.env.ALLOW_FINANCE_TEST_DB !== '1') { console.error('Refusing to run against a hosted Supabase database.'); process.exit(2); }
const app = require('../src/app'); const prisma = require('../src/lib/prisma');
let base;
function client() {
  const jar = new Map(); let csrf = null; let bearer = null;
  return { setBearer(t) { bearer = t; },
    async req(method, path, body) {
      const h = {}; if (body !== undefined) h['Content-Type'] = 'application/json';
      const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; '); if (cookie) h.Cookie = cookie; if (csrf) h['x-csrf-token'] = csrf; if (bearer) h.Authorization = `Bearer ${bearer}`;
      const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
      for (const c of r.headers.getSetCookie?.() || []) { const pair = c.split(';')[0]; const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); if (pair.startsWith('hvac_csrf=')) csrf = pair.slice('hvac_csrf='.length); }
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ } return { status: r.status, body: json };
    }, get(p) { return this.req('GET', p); }, post(p, b) { return this.req('POST', p, b); }, put(p, b) { return this.req('PUT', p, b); } };
}
(async () => {
  const server = app.listen(0); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`;
  const admin = client(); let customerId; let invoiceId;
  try {
    let r = await admin.get('/api/csrf-token'); assert.strictEqual(r.status, 200);
    r = await admin.post('/api/auth/login', { email: 'admin@ndsairconditioning.com', password: 'Admin@12345' }); assert.strictEqual(r.status, 200); admin.setBearer(r.body.data.accessToken);
    r = await admin.post('/api/customers', { name: 'INVPUT customer', email: `invput-${Date.now()}@example.com`, phone: '+1868 000 0002' }); assert.strictEqual(r.status, 201); customerId = r.body.data.id;
    r = await admin.post('/api/invoices', { customerId, labour: [{ description: 'Service call', quantity: 2, unitPrice: 12.5 }], parts: [{ description: 'Filter', quantity: 1, unitPrice: 10 }], taxRate: 0, discount: 0 });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body)); invoiceId = r.body.data.id; assert.strictEqual(Number(r.body.data.total), 35);
    const stored = async () => prisma.invoice.findUnique({ where: { id: invoiceId } });
    r = await admin.put(`/api/invoices/${invoiceId}`, { notes: 'only notes changed' }); assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    let inv = await stored(); assert.strictEqual(Number(inv.total), 35, 'partial update keeps the total'); assert.strictEqual(JSON.parse(inv.labour).length, 1, 'line items are not double-encoded or lost'); assert.strictEqual(JSON.parse(inv.parts).length, 1);
    r = await admin.put(`/api/invoices/${invoiceId}`, { discount: 5 }); assert.strictEqual(r.status, 200);
    inv = await stored(); assert.strictEqual(Number(inv.total), 30, 'discount recalculates from the stored line items');
    r = await admin.put(`/api/invoices/${invoiceId}`, { status: 'PAID' }); assert.strictEqual(r.status, 200);
    inv = await stored(); assert.strictEqual(inv.status, 'PAID'); assert.strictEqual(Number(inv.total), 30); assert.strictEqual(JSON.parse(inv.labour)[0].description, 'Service call');
    r = await admin.put(`/api/invoices/${invoiceId}`, { labour: [{ description: 'New', quantity: 1, unitPrice: 100 }] }); assert.strictEqual(r.status, 200);
    inv = await stored(); assert.strictEqual(Number(inv.total), 105, 'sending new line items still replaces them (100 labour + 10 parts - 5 discount)');
    console.log('Invoice partial-update regression passed');
  } finally {
    if (invoiceId) await prisma.invoice.deleteMany({ where: { id: invoiceId } }).catch(() => {});
    if (customerId) await prisma.customer.deleteMany({ where: { id: customerId } }).catch(() => {});
    server.close(); await prisma.$disconnect();
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
