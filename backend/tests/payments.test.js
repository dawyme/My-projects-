/**
 * Payment gateway verification — exercises the full storefront checkout flow
 * for every supported method (COD, bank transfer, Stripe, PayPal, WiPay,
 * Tilopay), webhook signature verification, idempotent capture, admin capture /
 * refund and inventory deduction. Gateways run in sandbox mode because no real
 * API keys exist in CI; the webhook path is exercised with the sandbox shared
 * secret so the signature code is genuinely verified.
 */
require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
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
    del(p, b, o) { return this.req('DELETE', p, b, o); },
  };
}

function sandboxWebhook(method, payload, secret = 'dev-sandbox-secret') {
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return fetch(`${base}/api/payments/webhook/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-payment-signature': `sha256=${sig}` },
    body,
  });
}

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const admin = makeClient();
  const anon = makeClient();

  await test('admin login', async () => {
    await admin.get('/api/csrf-token');
    await anon.get('/api/csrf-token');
    const r = await admin.post('/api/auth/login', { email: 'admin@ndsairconditioning.com', password: 'Admin@12345' });
    assert.strictEqual(r.status, 200);
    admin.setBearer(r.body.data.accessToken);
  });

  await test('enable all payment methods via settings', async () => {
    const r = await admin.put('/api/settings/payment', {
      currency: 'USD', currencySymbol: '$', taxRate: 10,
      bankTransfer: true, bankTransferDetails: 'ACME Bank — account 111-222-333, memo = order reference',
      cashOnDelivery: true,
      stripeEnabled: true, stripePublicKey: 'pk_test_123', paypalEnabled: true, paypalClientId: 'test-client',
      wipayEnabled: true, tilopayEnabled: true,
    });
    assert.strictEqual(r.status, 200);
    const check = await admin.get('/api/settings');
    assert.strictEqual(check.body.data.payment.wipayEnabled, true);
    assert.strictEqual(check.body.data.payment.tilopayEnabled, true);
  });

  await test('GET /api/public/settings exposes checkout config without secrets', async () => {
    const r = await anon.get('/api/public/settings');
    assert.strictEqual(r.body.data.payment, undefined);
    assert.ok(r.body.data.checkout);
    assert.strictEqual(r.body.data.checkout.taxRate, 10);
    const ids = r.body.data.checkout.methods.map((m) => m.id);
    for (const m of ['CASH_ON_DELIVERY', 'BANK_TRANSFER', 'STRIPE', 'PAYPAL', 'WIPAY', 'TILOPAY']) {
      assert.ok(ids.includes(m), `missing ${m}`);
    }
    assert.ok(r.body.data.checkout.methods.find((m) => m.id === 'STRIPE').sandbox, 'unconfigured gateway should be marked sandbox');
  });

  // Create a dedicated product so stock assertions are isolated.
  let productId;
  await test('create a test product', async () => {
    const cats = await admin.get('/api/categories');
    const r = await admin.post('/api/products', {
      sku: `PAY-${Date.now()}`, name: 'Payment Test Condenser', categoryId: cats.body.data[0].id,
      price: 100, costPrice: 50, quantity: 50, lowStockLevel: 2,
    });
    assert.strictEqual(r.status, 201);
    productId = r.body.data.id;
  });

  let orderId = null;
  let orderReference = null;

  await test('checkout with Cash on Delivery creates a pending order and deducts stock', async () => {
    const r = await anon.post('/api/payments/checkout', {
      name: 'Cod Buyer', email: `cod.${Date.now()}@example.com`, phone: '+1 555 1000',
      address: '10 Main St', city: 'Springfield',
      paymentMethod: 'CASH_ON_DELIVERY', items: [{ productId, quantity: 3 }],
    });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.data.order.status, 'PENDING');
    assert.strictEqual(r.body.data.order.paymentStatus, 'PENDING');
    assert.strictEqual(r.body.data.payment.action, 'manual');
    assert.strictEqual(r.body.data.payment.sandbox, false);
    orderId = r.body.data.order.id;
    orderReference = r.body.data.order.reference;
    const p = await admin.get(`/api/products/${productId}`);
    assert.strictEqual(p.body.data.quantity, 47, 'stock should have dropped by 3');
    // Customer order history now includes this order.
    const c = await admin.get('/api/customers?search=cod.');
    assert.ok(c.body.data.length >= 1, 'customer record exists');
    const profile = await admin.get(`/api/customers/${c.body.data[0].id}`);
    assert.ok(profile.body.data.orders.some((o) => o.reference === orderReference), 'order appears in customer history');
  });

  await test('checkout with Bank Transfer returns instructions', async () => {
    const r = await anon.post('/api/payments/checkout', {
      name: 'BT Buyer', email: `bt.${Date.now()}@example.com`, paymentMethod: 'BANK_TRANSFER',
      items: [{ productId, quantity: 1 }],
    });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.data.payment.action, 'manual');
    assert.match(r.body.data.payment.instructions, /ACME Bank/);
  });

  await test('checkout ignores client-supplied prices (server prices win)', async () => {
    const r = await anon.post('/api/payments/checkout', {
      name: 'Price Buyer', email: `price.${Date.now()}@example.com`,
      paymentMethod: 'BANK_TRANSFER',
      items: [{ productId, quantity: 1, unitPrice: 0.01 }],
    });
    assert.strictEqual(r.status, 201);
    const o = await admin.get(`/api/orders/${r.body.data.order.id}`);
    assert.strictEqual(o.body.data.items[0].unitPrice, 100);
    assert.strictEqual(o.body.data.subtotal, 100);
    assert.strictEqual(o.body.data.tax, 10, '10% tax from settings applies');
    assert.strictEqual(o.body.data.total, 110);
  });

  await test('checkout rejects a disabled payment method', async () => {
    await admin.put('/api/settings/payment', {
      currency: 'USD', currencySymbol: '$', taxRate: 10, bankTransfer: true, bankTransferDetails: '',
      cashOnDelivery: true, stripeEnabled: false, paypalEnabled: false, wipayEnabled: false, tilopayEnabled: false,
    });
    const r = await anon.post('/api/payments/checkout', {
      name: 'Disabled Buyer', email: `disabled.${Date.now()}@example.com`,
      paymentMethod: 'STRIPE', items: [{ productId, quantity: 1 }],
    });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /disabled/i);
    // re-enable for the rest of the suite
    await admin.put('/api/settings/payment', {
      currency: 'USD', currencySymbol: '$', taxRate: 10, bankTransfer: true, bankTransferDetails: 'ACME Bank — account 111-222-333, memo = order reference',
      cashOnDelivery: true, stripeEnabled: true, stripePublicKey: 'pk_test_123', paypalEnabled: true, paypalClientId: 'test-client',
      wipayEnabled: true, tilopayEnabled: true,
    });
  });

  await test('checkout rejects insufficient stock', async () => {
    const current = (await admin.get(`/api/products/${productId}`)).body.data.quantity;
    const r = await anon.post('/api/payments/checkout', {
      name: 'Over Buyer', email: `over.${Date.now()}@example.com`,
      paymentMethod: 'CASH_ON_DELIVERY', items: [{ productId, quantity: current + 1 }],
    });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /stock/i);
  });

  await test('checkout rejects an empty cart', async () => {
    const r = await anon.post('/api/payments/checkout', {
      name: 'Empty Buyer', email: `empty.${Date.now()}@example.com`,
      paymentMethod: 'CASH_ON_DELIVERY', items: [],
    });
    assert.strictEqual(r.status, 400);
  });

  // Sandbox gateways: order is created and auto-captured (no real keys).
  for (const [method, label] of [['STRIPE', 'Stripe'], ['PAYPAL', 'PayPal'], ['WIPAY', 'WiPay'], ['TILOPAY', 'Tilopay']]) {
    await test(`checkout with ${label} (sandbox) auto-captures with a redirect`, async () => {
      const r = await anon.post('/api/payments/checkout', {
        name: `${method} Buyer`, email: `${method.toLowerCase()}.${Date.now()}@example.com`,
        paymentMethod: method, items: [{ productId, quantity: 1 }],
      });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      assert.strictEqual(r.body.data.payment.sandbox, true);
      assert.strictEqual(r.body.data.payment.action, 'redirect');
      assert.match(r.body.data.payment.url, /checkout\.html\?order=/);
      assert.strictEqual(r.body.data.order.paymentStatus, 'PAID', 'sandbox payment captured immediately');
      assert.strictEqual(r.body.data.order.status, 'PAID');
      const o = await admin.get(`/api/orders/${r.body.data.order.id}`);
      assert.match(o.body.data.paymentReference, /^sandbox_/);
      assert.ok(o.body.data.paidAt);
    });
  }

  // ---- webhooks
  let webOrderId;
  await test('prepare a pending gateway order for webhook capture', async () => {
    const customers = await admin.get('/api/customers?limit=1');
    const created = await admin.post('/api/orders', {
      customerId: customers.body.data[0].id, items: [{ productId, quantity: 2 }],
    });
    assert.strictEqual(created.status, 201);
    await prisma.order.update({
      where: { id: created.body.data.id },
      data: { paymentMethod: 'STRIPE', paymentStatus: 'PENDING', paymentReference: 'cs_test_prepared' },
    });
    webOrderId = created.body.data.id;
  });

  await test('webhook rejects a missing/invalid signature', async () => {
    const r = await fetch(`${base}/api/payments/webhook/stripe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'checkout.session.completed', data: { object: {} } }),
    });
    assert.strictEqual(r.status, 401);
  });

  await test('webhook rejects an unknown gateway', async () => {
    const r = await fetch(`${base}/api/payments/webhook/nonsense`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.strictEqual(r.status, 404);
  });

  await test('webhook with a valid signature captures the order', async () => {
    const payload = {
      type: 'checkout.session.completed',
      data: { object: { client_reference_id: (await admin.get(`/api/orders/${webOrderId}`)).body.data.reference, payment_intent: 'pi_live_abc123' } },
    };
    const r = await sandboxWebhook('stripe', payload);
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).handled, true);
    const o = await admin.get(`/api/orders/${webOrderId}`);
    assert.strictEqual(o.body.data.status, 'PAID');
    assert.strictEqual(o.body.data.paymentStatus, 'PAID');
    assert.strictEqual(o.body.data.paymentReference, 'pi_live_abc123');
    assert.ok(o.body.data.paidAt);
  });

  await test('webhook replay is idempotent', async () => {
    const payload = {
      type: 'checkout.session.completed',
      data: { object: { client_reference_id: (await admin.get(`/api/orders/${webOrderId}`)).body.data.reference, payment_intent: 'pi_live_abc123' } },
    };
    const r = await sandboxWebhook('stripe', payload);
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).handled, true);
  });

  await test('webhook for an unknown order is reported but not fatal', async () => {
    const r = await sandboxWebhook('stripe', { type: 'checkout.session.completed', data: { object: { client_reference_id: 'OR-DOES-NOT-EXIST' } } });
    assert.strictEqual(r.status, 404);
    assert.strictEqual((await r.json()).handled, false);
  });

  await test('webhook with a valid signature but unrelated event is ignored', async () => {
    const r = await sandboxWebhook('stripe', { type: 'payment_intent.amount_capturable_updated', data: { object: {} } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).handled, false);
  });

  await test('sandbox secret mismatch is rejected', async () => {
    const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: {} } });
    const sig = crypto.createHmac('sha256', 'wrong-secret').update(body).digest('hex');
    const r = await fetch(`${base}/api/payments/webhook/stripe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-payment-signature': `sha256=${sig}` }, body,
    });
    assert.strictEqual(r.status, 401);
  });

  // ---- admin capture / refund
  await test('admin captures a bank-transfer order with a transaction id', async () => {
    const r = await anon.post('/api/payments/checkout', {
      name: 'Capture Buyer', email: `capture.${Date.now()}@example.com`,
      paymentMethod: 'BANK_TRANSFER', items: [{ productId, quantity: 1 }],
    });
    const cap = await admin.post(`/api/payments/${r.body.data.order.id}/capture`, { transactionId: 'BT-TRX-777' });
    assert.strictEqual(cap.status, 200);
    assert.strictEqual(cap.body.data.paymentStatus, 'PAID');
    assert.strictEqual(cap.body.data.paymentReference, 'BT-TRX-777');
    assert.strictEqual(cap.body.data.status, 'PAID');
  });

  await test('double capture is idempotent', async () => {
    const r = await anon.post('/api/payments/checkout', {
      name: 'Dbl Buyer', email: `dbl.${Date.now()}@example.com`,
      paymentMethod: 'CASH_ON_DELIVERY', items: [{ productId, quantity: 1 }],
    });
    const first = await admin.post(`/api/payments/${r.body.data.order.id}/capture`, {});
    const second = await admin.post(`/api/payments/${r.body.data.order.id}/capture`, { transactionId: 'LATE' });
    assert.strictEqual(first.status, 200);
    assert.strictEqual(second.status, 200);
    assert.strictEqual(second.body.data.paymentReference, null, 'second capture must not overwrite');
  });

  await test('admin refund marks a paid order refunded', async () => {
    const r = await anon.post('/api/payments/checkout', {
      name: 'Refund Buyer', email: `refund.${Date.now()}@example.com`,
      paymentMethod: 'BANK_TRANSFER', items: [{ productId, quantity: 1 }],
    });
    await admin.post(`/api/payments/${r.body.data.order.id}/capture`, {});
    const refund = await admin.post(`/api/payments/${r.body.data.order.id}/refund`, {});
    assert.strictEqual(refund.status, 200);
    assert.strictEqual(refund.body.data.paymentStatus, 'REFUNDED');
  });

  await test('refunding an unpaid order is rejected', async () => {
    const r = await anon.post('/api/payments/checkout', {
      name: 'NoRef Buyer', email: `noref.${Date.now()}@example.com`,
      paymentMethod: 'BANK_TRANSFER', items: [{ productId, quantity: 1 }],
    });
    const refund = await admin.post(`/api/payments/${r.body.data.order.id}/refund`, {});
    assert.strictEqual(refund.status, 400);
  });

  await test('capture is staff-permitted, refund is admin-only', async () => {
    const staff = makeClient();
    await staff.get('/api/csrf-token');
    const login = await staff.post('/api/auth/login', { email: 'staff@ndsairconditioning.com', password: 'Staff@12345' });
    staff.setBearer(login.body.data.accessToken);
    const r = await anon.post('/api/payments/checkout', {
      name: 'Rbac Buyer', email: `rbac.${Date.now()}@example.com`,
      paymentMethod: 'BANK_TRANSFER', items: [{ productId, quantity: 1 }],
    });
    assert.strictEqual((await staff.post(`/api/payments/${r.body.data.order.id}/capture`, {})).status, 200);
    assert.strictEqual((await staff.post(`/api/payments/${r.body.data.order.id}/refund`, {})).status, 403);
  });

  await test('GET /api/payments/gateways reports configuration status', async () => {
    const r = await admin.get('/api/payments/gateways');
    for (const gw of ['STRIPE', 'PAYPAL', 'WIPAY', 'TILOPAY']) {
      assert.strictEqual(r.body.data[gw].configured, false, `${gw} should be unconfigured in CI`);
    }
  });

  await test('marking an order PAID via status also records the payment', async () => {
    const r = await anon.post('/api/payments/checkout', {
      name: 'Status Buyer', email: `status.${Date.now()}@example.com`,
      paymentMethod: 'CASH_ON_DELIVERY', items: [{ productId, quantity: 1 }],
    });
    await admin.patch(`/api/orders/${r.body.data.order.id}/status`, { status: 'PAID' });
    const o = await admin.get(`/api/orders/${r.body.data.order.id}`);
    assert.strictEqual(o.body.data.paymentStatus, 'PAID');
  });

  // Cleanup: remove orders created directly for webhook tests, restore stock.
  await test('cleanup test orders', async () => {
    await prisma.order.deleteMany({ where: { id: webOrderId } });
    const p = await admin.get(`/api/products/${productId}`);
    await admin.del(`/api/products/${productId}`);
    assert.strictEqual(p.body.data.quantity >= 0, true);
  });

  server.close();
  await prisma.$disconnect();

  const pass = results.filter((r) => r[0] === 'PASS').length;
  console.log('\nPayment gateway verification\n============================');
  for (const [state, name] of results) console.log(`  ${state === 'PASS' ? '✔' : '✘'} ${name}`);
  console.log(`\n${pass}/${results.length} checks passed${failures ? ` — ${failures} FAILED` : ''}\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
