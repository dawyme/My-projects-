require('dotenv').config();
/**
 * Financial Management tests: money/period unit tests + API contract tests.
 * SAFETY: these tests write data. They refuse to run against a hosted Supabase
 * database (your live data). Use a local/CI database, or set
 * ALLOW_FINANCE_TEST_DB=1 only for a throwaway database you can afford to lose.
 */
const assert = require('assert');

const dbUrl = process.env.DATABASE_URL || '';
if (/supabase\.(co|com)|pooler\./i.test(dbUrl) && process.env.ALLOW_FINANCE_TEST_DB !== '1') {
  console.error('Refusing to run finance tests against a hosted Supabase database. Use a local/CI database.');
  process.exit(2);
}

const { parseMoney, toCents, fromCents, sumCents } = require('../src/lib/finance/money');
const { periodRange, parseLocalDate, monthKey, monthKeysBetween } = require('../src/lib/finance/periods');

/* ------------------------------------------------------------------ unit: money */
function unitMoney() {
  assert.strictEqual(parseMoney('12.50'), 1250);
  assert.strictEqual(parseMoney(12.5), 1250);
  assert.strictEqual(parseMoney('0.01'), 1);
  assert.strictEqual(parseMoney('1234567.89'), 123456789);
  for (const bad of ['', null, undefined, 'abc', '-5', '1.234', '10.005', '1e3', NaN, Infinity, '99999999999.00', ' ', '1,000']) {
    assert.throws(() => parseMoney(bad), RangeError, `parseMoney should reject ${String(bad)}`);
  }
  assert.strictEqual(toCents(0.1 + 0.2), 30);
  assert.strictEqual(toCents('19.99'), 1999);
  assert.strictEqual(toCents(null), 0);
  assert.strictEqual(toCents({ toString: () => '5.10' }), 510);
  assert.strictEqual(fromCents(1250), '12.50');
  assert.strictEqual(fromCents(5), '0.05');
  assert.strictEqual(fromCents(-1999), '-19.99');
  assert.strictEqual(fromCents(0), '0.00');
  assert.strictEqual(sumCents([10, 20, -5]), 25);
  // floating point drift never leaks: 0.1 + 0.2 summed as cents is exactly 0.30
  assert.strictEqual(fromCents(sumCents([toCents(0.1), toCents(0.2)])), '0.30');
}

/* ------------------------------------------------------------------ unit: periods (Port of Spain, UTC-4) */
function unitPeriods() {
  // 2024-03-10 02:00Z is still Saturday 2024-03-09 22:00 in Trinidad.
  const now = new Date('2024-03-10T02:00:00Z');
  let r = periodRange('today', { now });
  assert.strictEqual(r.from.toISOString(), '2024-03-09T04:00:00.000Z');
  assert.strictEqual(r.to.toISOString(), '2024-03-10T04:00:00.000Z');
  r = periodRange('week', { now }); // Monday start
  assert.strictEqual(r.from.toISOString(), '2024-03-04T04:00:00.000Z');
  assert.strictEqual(r.to.toISOString(), '2024-03-11T04:00:00.000Z');
  r = periodRange('month', { now });
  assert.strictEqual(r.from.toISOString(), '2024-03-01T04:00:00.000Z');
  assert.strictEqual(r.to.toISOString(), '2024-04-01T04:00:00.000Z');
  r = periodRange('last_month', { now });
  assert.strictEqual(r.from.toISOString(), '2024-02-01T04:00:00.000Z');
  assert.strictEqual(r.to.toISOString(), '2024-03-01T04:00:00.000Z');
  r = periodRange('year', { now });
  assert.strictEqual(r.from.toISOString(), '2024-01-01T04:00:00.000Z');
  assert.strictEqual(r.to.toISOString(), '2025-01-01T04:00:00.000Z');
  // custom: `to` is inclusive for people
  r = periodRange('custom', { now, from: '2024-03-10', to: '2024-03-10' });
  assert.strictEqual(r.from.toISOString(), '2024-03-10T04:00:00.000Z');
  assert.strictEqual(r.to.toISOString(), '2024-03-11T04:00:00.000Z');
  assert.throws(() => periodRange('custom', { now, from: '2024-03-10' }), RangeError);
  assert.throws(() => periodRange('custom', { now, from: '2024-03-11', to: '2024-03-10' }), RangeError);
  assert.throws(() => periodRange('custom', { now, from: '2010-01-01', to: '2024-03-10' }), RangeError);
  assert.throws(() => periodRange('decade', { now }), RangeError);
  assert.throws(() => parseLocalDate('2024-02-30'), RangeError);
  assert.throws(() => parseLocalDate('10/03/2024'), RangeError);
  // 23:30 local on 31 Jan belongs to January, not February (UTC would say Feb 1)
  assert.strictEqual(monthKey(new Date('2024-02-01T03:30:00Z')), '2024-01');
  assert.deepStrictEqual(monthKeysBetween(new Date('2024-01-01T04:00:00Z'), new Date('2024-04-01T04:00:00Z')), ['2024-01', '2024-02', '2024-03']);
}

/* ------------------------------------------------------------------ API helpers */
let base;
function client() {
  const jar = new Map(); let csrf = null; let bearer = null;
  const headers = (extra = {}) => {
    const h = { ...extra }; const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) h.Cookie = cookie; if (csrf) h['x-csrf-token'] = csrf; if (bearer) h.Authorization = `Bearer ${bearer}`; return h;
  };
  const remember = (r) => { for (const c of r.headers.getSetCookie?.() || []) { const pair = c.split(';')[0]; const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); if (pair.startsWith('hvac_csrf=')) csrf = pair.slice('hvac_csrf='.length); } };
  const parse = async (r) => { const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } return { status: r.status, body: json, text }; };
  return {
    setBearer(t) { bearer = t; },
    async req(method, path, body) {
      const h = headers(body !== undefined ? { 'Content-Type': 'application/json' } : {});
      const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
      remember(r); return parse(r);
    },
    async form(path, fd) { const r = await fetch(base + path, { method: 'POST', headers: headers(), body: fd }); remember(r); return parse(r); },
    get(p) { return this.req('GET', p); }, post(p, b) { return this.req('POST', p, b); }, put(p, b) { return this.req('PUT', p, b); }, del(p) { return this.req('DELETE', p); },
  };
}

const TAG = 'FINTEST';
const DAY = '2024-03-10'; // pinned past day so exact totals can be asserted
const RANGE = `period=custom&from=${DAY}&to=${DAY}`;

async function api() {
  const app = require('../src/app');
  const prisma = require('../src/lib/prisma');
  const server = app.listen(0); await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const admin = client(); const anon = client();
  let otherBusinessId = null;
  const invoiceIds = []; let testCustomerId = null;
  const cleanup = async () => {
    await prisma.financialTransaction.deleteMany({ where: { notes: { startsWith: TAG } } });
    if (invoiceIds.length) {
      await prisma.financialTransaction.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
      await prisma.financeAuditLog.deleteMany({ where: { entity: 'TRANSACTION', after: { contains: 'FINTEST-INV' } } }).catch(() => {});
      await prisma.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    }
    if (testCustomerId) await prisma.customer.deleteMany({ where: { id: testCustomerId } }).catch(() => {});
    await prisma.expense.deleteMany({ where: { description: { startsWith: TAG } } });
    if (otherBusinessId) {
      await prisma.financialTransaction.deleteMany({ where: { businessId: otherBusinessId } });
      await prisma.expense.deleteMany({ where: { businessId: otherBusinessId } });
      await prisma.financeAuditLog.deleteMany({ where: { businessId: otherBusinessId } });
      await prisma.business.deleteMany({ where: { id: otherBusinessId } });
    }
  };
  try {
    await cleanup();
    let r = await anon.get('/api/csrf-token'); assert.strictEqual(r.status, 200);

    // Unauthenticated access is refused.
    r = await anon.get('/api/finance/summary'); assert.ok([401, 403].includes(r.status), `anon summary -> ${r.status}`);
    r = await anon.get('/api/finance/transactions'); assert.ok([401, 403].includes(r.status));

    r = await admin.get('/api/csrf-token'); assert.strictEqual(r.status, 200);
    r = await admin.post('/api/auth/login', { email: 'admin@ndsairconditioning.com', password: 'Admin@12345' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body)); admin.setBearer(r.body.data.accessToken);

    r = await admin.get('/api/finance/meta'); assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.data.currency, 'TTD'); assert.strictEqual(r.body.data.timezone, 'America/Port_of_Spain');

    const base0 = (await admin.get(`/api/finance/summary?${RANGE}`)).body.data.totals;
    const cents = (v) => toCents(v);

    // ---- payments: validation
    const pay = (extra) => admin.post('/api/finance/transactions', { type: 'PAYMENT', method: 'CASH', paidAt: DAY, notes: `${TAG} payment`, ...extra });
    r = await pay({ amount: '10.005' }); assert.strictEqual(r.status, 400, 'more than 2 decimals must be rejected');
    r = await pay({ amount: '-5' }); assert.strictEqual(r.status, 400);
    r = await pay({ amount: '0' }); assert.strictEqual(r.status, 400);
    r = await pay({ amount: 'abc' }); assert.strictEqual(r.status, 400);
    r = await pay({ amount: '5', method: undefined }); assert.strictEqual(r.status, 400, 'method required');
    r = await pay({ amount: '5', paidAt: '2999-01-01' }); assert.strictEqual(r.status, 400, 'future dates rejected');
    r = await pay({ amount: '5', unexpected: true }); assert.strictEqual(r.status, 400, 'unknown fields rejected (strict)');

    // ---- payments: create, exact decimals, duplicate reference
    r = await pay({ amount: '100.10', reference: `${TAG}-REF-1` }); assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const p1 = r.body.data; assert.strictEqual(p1.amount, '100.10'); assert.strictEqual(p1.type, 'PAYMENT'); assert.strictEqual(p1.status, 'RECORDED');
    r = await pay({ amount: '100.10', reference: `${TAG}-REF-1` }); assert.strictEqual(r.status, 409, 'duplicate reference must not double-record');
    r = await pay({ amount: '50.00', method: 'BANK_TRANSFER' }); assert.strictEqual(r.status, 201); const p2 = r.body.data;

    // ---- concurrent duplicate submits: at most one row is created
    const racers = await Promise.all([1, 2, 3].map(() => pay({ amount: '7.00', reference: `${TAG}-RACE` })));
    assert.strictEqual(racers.filter((x) => x.status === 201).length, 1, 'exactly one concurrent request wins');
    assert.strictEqual(await prisma.financialTransaction.count({ where: { externalReference: `${TAG}-RACE` } }), 1);
    // remove the race row from the totals math by voiding it
    const race = racers.find((x) => x.status === 201).body.data;
    r = await admin.post(`/api/finance/transactions/${race.id}/void`, { reason: 'test cleanup' }); assert.strictEqual(r.status, 200);

    // ---- refunds
    const refund = (extra) => admin.post('/api/finance/transactions', { type: 'REFUND', paidAt: DAY, notes: `${TAG} refund`, ...extra });
    r = await refund({ amount: '5' }); assert.strictEqual(r.status, 400, 'refund must reference a payment');
    r = await refund({ amount: '100.11', relatedTransactionId: p1.id }); assert.strictEqual(r.status, 400, 'refund cannot exceed the payment');
    r = await refund({ amount: '20.00', relatedTransactionId: p1.id }); assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const rf = r.body.data; assert.strictEqual(rf.type, 'REFUND'); assert.strictEqual(rf.amount, '20.00');
    r = await refund({ amount: '80.11', relatedTransactionId: p1.id }); assert.strictEqual(r.status, 400, 'cumulative refunds cannot exceed the payment');
    r = await refund({ amount: '80.10', relatedTransactionId: p1.id }); assert.strictEqual(r.status, 201, 'refunding exactly the remainder is allowed');
    const rfRest = r.body.data;
    r = await admin.post(`/api/finance/transactions/${rfRest.id}/void`, { reason: 'test: undo remainder refund' });
    assert.strictEqual(r.status, 200);

    // ---- expenses
    const exp = (extra) => admin.post('/api/finance/expenses', { category: 'FUEL_TRANSPORT', amount: '30.25', expenseDate: DAY, method: 'CASH', description: `${TAG} fuel`, ...extra });
    r = await exp({ category: 'NOPE' }); assert.strictEqual(r.status, 400);
    r = await exp({ amount: '1.999' }); assert.strictEqual(r.status, 400);
    r = await exp({ amount: '-1' }); assert.strictEqual(r.status, 400);
    r = await exp({ expenseDate: '2999-01-01' }); assert.strictEqual(r.status, 400);
    r = await exp(); assert.strictEqual(r.status, 201, JSON.stringify(r.body)); const e1 = r.body.data; assert.strictEqual(e1.amount, '30.25');
    assert.strictEqual(e1.receiptPath, undefined, 'internal storage path never leaves the API');
    r = await exp({ amount: '9.99', description: `${TAG} deleted soon` }); const e2 = r.body.data;

    // ---- exact pinned-day totals (delta vs. baseline so other data cannot break the test)
    let s = (await admin.get(`/api/finance/summary?${RANGE}`)).body.data;
    assert.strictEqual(cents(s.totals.received) - cents(base0.received), 15010, 'received = 100.10 + 50.00');
    assert.strictEqual(cents(s.totals.refunds) - cents(base0.refunds), 2000, 'refunds = 20.00');
    assert.strictEqual(cents(s.totals.netReceipts) - cents(base0.netReceipts), 13010);
    assert.strictEqual(cents(s.totals.expenses) - cents(base0.expenses), 3025 + 999);
    assert.strictEqual(cents(s.totals.netCashMovement) - cents(base0.netCashMovement), 13010 - 3025 - 999);
    assert.strictEqual(s.currency, 'TTD');

    // ---- soft delete removes the expense from totals but keeps its history
    r = await admin.del(`/api/finance/expenses/${e2.id}`); assert.strictEqual(r.status, 200);
    r = await admin.del(`/api/finance/expenses/${e2.id}`); assert.strictEqual(r.status, 404);
    s = (await admin.get(`/api/finance/summary?${RANGE}`)).body.data;
    assert.strictEqual(cents(s.totals.expenses) - cents(base0.expenses), 3025);
    r = await admin.get(`/api/finance/expenses/${e2.id}/history`); assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.data.map((h) => h.action), ['CREATE', 'DELETE']);

    // ---- edits are audited
    r = await admin.put(`/api/finance/expenses/${e1.id}`, { amount: '31.00' }); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.data.amount, '31.00');
    r = await admin.get(`/api/finance/expenses/${e1.id}/history`); assert.deepStrictEqual(r.body.data.map((h) => h.action), ['CREATE', 'UPDATE']);
    r = await admin.put(`/api/finance/expenses/${e1.id}`, { amount: '30.25' }); assert.strictEqual(r.status, 200);

    // ---- void rules
    r = await admin.post(`/api/finance/transactions/${p1.id}/void`, { reason: 'x' }); assert.strictEqual(r.status, 400, 'reason must be at least 3 chars');
    r = await admin.post(`/api/finance/transactions/${p1.id}/void`, { reason: 'duplicate entry' }); assert.strictEqual(r.status, 400, 'cannot void a payment that still has a live refund');
    r = await admin.post(`/api/finance/transactions/${rf.id}/void`, { reason: 'refund entered by mistake' }); assert.strictEqual(r.status, 200);
    r = await admin.post(`/api/finance/transactions/${rf.id}/void`, { reason: 'again' }); assert.strictEqual(r.status, 409);
    s = (await admin.get(`/api/finance/summary?${RANGE}`)).body.data;
    assert.strictEqual(cents(s.totals.refunds) - cents(base0.refunds), 0, 'voided refund stops counting');
    r = await admin.post(`/api/finance/transactions/${p2.id}/void`, { reason: 'customer cheque bounced' }); assert.strictEqual(r.status, 200);
    s = (await admin.get(`/api/finance/summary?${RANGE}`)).body.data;
    assert.strictEqual(cents(s.totals.received) - cents(base0.received), 10010, 'voided payment stops counting');
    r = await admin.get(`/api/finance/transactions/${p2.id}/history`); assert.deepStrictEqual(r.body.data.map((h) => h.action), ['CREATE', 'VOID']);

    // ---- listing + CSV (formula-injection guard)
    r = await admin.get(`/api/finance/transactions?${RANGE}&limit=50`); assert.strictEqual(r.status, 200);
    assert.ok(r.body.data.some((t) => t.id === p1.id));
    r = await exp({ description: `${TAG} =HYPERLINK("http://evil.example")`, payee: '=cmd|\' /C calc\'!A0' }); assert.strictEqual(r.status, 201);
    r = await admin.get(`/api/finance/expenses?${RANGE}&format=csv`); assert.strictEqual(r.status, 200); assert.ok(/text\/csv/.test('text/csv'));
    assert.ok(!/(^|,|")=HYPERLINK/.test(r.text.replace(/'=HYPERLINK/g, '')), 'CSV cells must not start with =');
    assert.ok(r.text.includes("'=cmd"), 'formula-like payee is neutralised with a leading quote');
    r = await admin.get(`/api/finance/transactions?${RANGE}&format=csv`); assert.strictEqual(r.status, 200);
    r = await admin.get('/api/finance/summary?period=custom&from=2024-03-11&to=2024-03-10'); assert.strictEqual(r.status, 400);
    r = await admin.get('/api/finance/summary?period=bogus'); assert.strictEqual(r.status, 400);

    // ---- receipts: wrong content is refused before storage is touched; no storage configured => clear 503
    const fakePdf = new FormData(); fakePdf.append('file', new Blob(['this is not a pdf at all, just text'], { type: 'application/pdf' }), 'r.pdf');
    r = await admin.form(`/api/finance/expenses/${e1.id}/receipt`, fakePdf); assert.strictEqual(r.status, 400, 'mime/content mismatch rejected');
    const exe = new FormData(); exe.append('file', new Blob(['MZ'], { type: 'application/x-msdownload' }), 'r.exe');
    r = await admin.form(`/api/finance/expenses/${e1.id}/receipt`, exe); assert.strictEqual(r.status, 400, 'disallowed type rejected');
    const realPdf = new FormData(); realPdf.append('file', new Blob(['%PDF-1.4\n%test receipt content\n'], { type: 'application/pdf' }), 'r.pdf');
    r = await admin.form(`/api/finance/expenses/${e1.id}/receipt`, realPdf);
    assert.ok([201, 503].includes(r.status), `valid receipt -> 201 (storage configured) or 503 (not configured), got ${r.status}`);
    r = await admin.get(`/api/finance/expenses/${e2.id}/receipt`); assert.strictEqual(r.status, 404);

    // ---- POS sale + refund reach the ledger exactly once
    r = await admin.get('/api/categories?limit=1'); const categoryId = r.body.data[0].id;
    r = await admin.post('/api/products', { sku: `${TAG}-${Date.now()}`, name: `${TAG} product`, categoryId, price: 125, costPrice: 60, quantity: 10, lowStockLevel: 2 }); assert.strictEqual(r.status, 201); const productId = r.body.data.id;
    r = await admin.post('/api/pos/sales', { items: [{ productId, quantity: 2 }], discount: 5, taxRate: 12.5, paymentMethod: 'CASH', location: 'shop' });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body)); const sale = r.body.data;
    let rows = await prisma.financialTransaction.findMany({ where: { saleId: sale.id } });
    assert.strictEqual(rows.length, 1, 'one ledger row per POS sale'); assert.strictEqual(rows[0].type, 'PAYMENT');
    assert.strictEqual(fromCents(toCents(rows[0].amount)), '275.63'); assert.strictEqual(rows[0].method, 'CASH');
    r = await admin.post('/api/pos/refunds', { saleId: sale.id, items: [{ saleLineItemId: sale.lineItems[0].id, quantity: 1 }], reason: `${TAG} refund` }); assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    rows = await prisma.financialTransaction.findMany({ where: { saleId: sale.id }, orderBy: { createdAt: 'asc' } });
    assert.strictEqual(rows.length, 2); assert.strictEqual(rows[1].type, 'REFUND');
    const saleRefund = await prisma.saleRefund.findFirst({ where: { saleId: sale.id } });
    assert.strictEqual(toCents(rows[1].amount), toCents(saleRefund.amount), 'refund row equals the POS refund amount');
    assert.strictEqual(rows[1].relatedTransactionId, rows[0].id);
    await prisma.financialTransaction.deleteMany({ where: { saleId: sale.id } }); // keep the shared test DB tidy

    // ---- invoices: deposit, partial payment, overpayment, mark-paid settles only the balance
    r = await admin.post('/api/customers', { name: `${TAG} customer`, email: `fintest-${Date.now()}@example.com`, phone: '+1868 000 0001' });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body)); testCustomerId = r.body.data.id;
    const newInvoice = async (extra = {}) => {
      const res = await admin.post('/api/invoices', { customerId: testCustomerId, labour: [{ description: `${TAG}-INV service call`, quantity: 1, unitPrice: 300 }], taxRate: 0, discount: 0, ...extra });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body)); invoiceIds.push(res.body.data.id); return res.body.data;
    };
    const ledgerFor = (invoiceId) => prisma.financialTransaction.findMany({ where: { invoiceId }, orderBy: { createdAt: 'asc' } });
    const invStatus = async (id) => (await prisma.invoice.findUnique({ where: { id } })).status;
    const payInv = (invoiceId, amount, extra = {}) => admin.post('/api/finance/transactions', { type: 'PAYMENT', method: 'CASH', invoiceId, amount, paidAt: DAY, ...extra });

    const inv = await newInvoice(); assert.strictEqual(Number(inv.total), 300); assert.strictEqual(inv.status, 'PENDING');
    r = await payInv(inv.id, '300.01'); assert.strictEqual(r.status, 400, 'cannot pay more than the invoice balance');
    r = await payInv(inv.id, '100.00'); assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.data.kind, 'DEPOSIT', 'first part-payment is a deposit'); assert.strictEqual(r.body.data.invoiceId, inv.id);
    assert.strictEqual(await invStatus(inv.id), 'PARTIAL');
    r = await payInv(inv.id, '50.00'); assert.strictEqual(r.status, 201); assert.strictEqual(r.body.data.kind, 'PARTIAL');
    assert.strictEqual(await invStatus(inv.id), 'PARTIAL');
    r = await payInv(inv.id, '150.01'); assert.strictEqual(r.status, 400, 'overpaying the remaining 150.00 is rejected');
    r = await admin.get('/api/finance/outstanding'); assert.strictEqual(r.status, 200);
    const owed = r.body.data.items.find((i) => i.id === inv.id);
    assert.ok(owed, 'part-paid invoice is listed as outstanding'); assert.strictEqual(owed.total, '300.00'); assert.strictEqual(owed.paid, '150.00'); assert.strictEqual(owed.balance, '150.00');

    // mark-paid records ONLY the 150.00 still owed, so the ledger totals 300.00 (not 450.00)
    r = await admin.post(`/api/invoices/${inv.id}/mark-paid`, { method: 'CASH' }); assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    let invRows = await ledgerFor(inv.id);
    assert.strictEqual(invRows.length, 3); assert.strictEqual(fromCents(sumCents(invRows.map((x) => toCents(x.amount)))), '300.00');
    assert.strictEqual(fromCents(toCents(invRows[2].amount)), '150.00'); assert.strictEqual(await invStatus(inv.id), 'PAID');
    r = await admin.post(`/api/invoices/${inv.id}/mark-paid`, { method: 'CASH' }); assert.strictEqual(r.status, 200);
    assert.strictEqual((await ledgerFor(inv.id)).length, 3, 'marking a paid invoice paid again records nothing new');
    r = await payInv(inv.id, '1.00'); assert.strictEqual(r.status, 400, 'a fully paid invoice has no balance left');
    r = await admin.get('/api/finance/outstanding'); assert.ok(!r.body.data.items.some((i) => i.id === inv.id), 'paid invoice leaves outstanding');

    // voiding the settlement re-opens the balance
    r = await admin.post(`/api/finance/transactions/${invRows[2].id}/void`, { reason: 'settlement entered in error' }); assert.strictEqual(r.status, 200);
    assert.strictEqual(await invStatus(inv.id), 'PARTIAL', 'voiding a payment moves the invoice back to PARTIAL');
    r = await admin.get('/api/finance/outstanding'); assert.strictEqual(r.body.data.items.find((i) => i.id === inv.id).balance, '150.00');

    // refunding a payment on an invoice raises the balance again
    r = await admin.post('/api/finance/transactions', { type: 'REFUND', paidAt: DAY, amount: '40.00', relatedTransactionId: invRows[0].id, notes: `${TAG} refund`, method: 'CASH' });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    r = await admin.get('/api/finance/outstanding'); assert.strictEqual(r.body.data.items.find((i) => i.id === inv.id).balance, '190.00');

    // an invoice created already-PAID, and one switched to PAID later, each reach the ledger exactly once
    const paidInv = await newInvoice({ status: 'PAID', labour: [{ description: `${TAG}-INV paid up front`, quantity: 1, unitPrice: 80 }] });
    invRows = await ledgerFor(paidInv.id); assert.strictEqual(invRows.length, 1); assert.strictEqual(fromCents(toCents(invRows[0].amount)), '80.00');
    assert.strictEqual(invRows[0].type, 'PAYMENT'); assert.strictEqual(invRows[0].source, 'INVOICE');
    const laterInv = await newInvoice({ labour: [{ description: `${TAG}-INV paid later`, quantity: 2, unitPrice: 12.5 }] });
    r = await admin.put(`/api/invoices/${laterInv.id}`, { status: 'PAID', labour: [{ description: `${TAG}-INV paid later`, quantity: 2, unitPrice: 12.5 }] }); assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    invRows = await ledgerFor(laterInv.id); assert.strictEqual(invRows.length, 1); assert.strictEqual(fromCents(toCents(invRows[0].amount)), '25.00');
    r = await admin.put(`/api/invoices/${laterInv.id}`, { notes: 'edit only', labour: [{ description: `${TAG}-INV paid later`, quantity: 2, unitPrice: 12.5 }] }); assert.strictEqual(r.status, 200);
    assert.strictEqual((await ledgerFor(laterInv.id)).length, 1, 'editing a paid invoice does not record money twice');
    // a cancelled invoice cannot take payments
    const dead = await newInvoice({ status: 'CANCELLED' });
    r = await payInv(dead.id, '10.00'); assert.strictEqual(r.status, 400);

    // ---- tenant isolation
    otherBusinessId = `fin-iso-${Date.now()}`;
    await prisma.business.create({ data: { id: otherBusinessId, name: 'Finance Isolation Tenant', slug: otherBusinessId, currency: 'TTD' } });
    const foreign = await prisma.financialTransaction.create({ data: { businessId: otherBusinessId, reference: `ISO-${Date.now()}`, method: 'CASH', amount: '999.99', paidAt: new Date('2024-03-10T16:00:00Z'), notes: 'foreign tenant secret' } });
    const foreignExp = await prisma.expense.create({ data: { businessId: otherBusinessId, category: 'OTHER', amount: '888.88', expenseDate: new Date('2024-03-10T16:00:00Z'), description: 'foreign tenant expense' } });
    r = await admin.get(`/api/finance/transactions?${RANGE}&limit=100`); assert.ok(!JSON.stringify(r.body).includes('foreign tenant secret'), 'transactions never leak across tenants');
    r = await admin.get(`/api/finance/expenses?${RANGE}&limit=100`); assert.ok(!JSON.stringify(r.body).includes('foreign tenant expense'));
    s = (await admin.get(`/api/finance/summary?${RANGE}`)).body.data;
    assert.strictEqual(cents(s.totals.received) - cents(base0.received), 10010, 'foreign money not included in totals');
    r = await admin.get(`/api/finance/transactions/${foreign.id}/history`); assert.strictEqual(r.status, 404);
    r = await admin.post(`/api/finance/transactions/${foreign.id}/void`, { reason: 'attempted cross-tenant void' }); assert.strictEqual(r.status, 404);
    r = await admin.put(`/api/finance/expenses/${foreignExp.id}`, { amount: '1.00' }); assert.strictEqual(r.status, 404);
    r = await admin.del(`/api/finance/expenses/${foreignExp.id}`); assert.strictEqual(r.status, 404);
    r = await refund({ amount: '1', relatedTransactionId: foreign.id }); assert.strictEqual(r.status, 404, 'cannot refund another tenant\'s payment');
    r = await pay({ amount: '1', customerId: 'does-not-exist' }); assert.strictEqual(r.status, 400);
    r = await pay({ amount: '1', invoiceId: 'does-not-exist' }); assert.strictEqual(r.status, 400);
  } finally {
    await cleanup().catch((e) => console.error('cleanup failed', e.message));
    server.close(); await prisma.$disconnect();
  }
}

(async () => {
  unitMoney(); unitPeriods(); console.log('✓ finance unit tests (money, periods)');
  await api(); console.log('✓ finance API tests (validation, ledger, refunds, voids, expenses, CSV, receipts, POS, tenant isolation)');
  console.log('Finance tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
