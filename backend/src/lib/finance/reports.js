'use strict';
/**
 * Read-side finance reporting. Totals are computed in integer cents from the
 * ledger (payments/refunds RECORDED in the period, by payment date) and the
 * Expense table — never from order/booking creation dates or job prices.
 */
const prisma = require('../prisma');
const { toCents, fromCents, sumCents } = require('./money');
const { TIMEZONE, periodRange, monthKey, monthKeysBetween, localMidnight } = require('./periods');
const { BASE_CURRENCY, EXPENSE_CATEGORIES, sourceOf, REVENUE_CLASS, serialize } = require('./ledger');

const money = fromCents;
const monthLabel = (key) => { const [y, m] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en', { month: 'short', year: '2-digit', timeZone: 'UTC' }); };

const OPEN_INVOICE = ['PENDING', 'PARTIAL', 'OVERDUE'];

/** Balances still owed: unpaid/partial invoices, unpaid online orders, and part-paid jobs. */
async function outstanding(businessId, { detail = false } = {}) {
  const [invoices, orders] = await Promise.all([
    prisma.invoice.findMany({
      where: { businessId, status: { in: OPEN_INVOICE } },
      select: { id: true, reference: true, total: true, status: true, dueDate: true, customerId: true, customer: { select: { name: true } } },
    }),
    prisma.order.findMany({
      where: { businessId, paymentStatus: 'PENDING', status: { not: 'CANCELLED' } },
      select: { id: true, reference: true, total: true, paymentMethod: true, customerId: true, customer: { select: { name: true } } },
    }),
  ]);

  const invoiceIds = invoices.map((i) => i.id);
  const invRows = invoiceIds.length
    ? await prisma.financialTransaction.findMany({ where: { businessId, status: 'RECORDED', invoiceId: { in: invoiceIds } }, select: { invoiceId: true, type: true, amount: true } })
    : [];
  const paidByInvoice = new Map();
  for (const r of invRows) paidByInvoice.set(r.invoiceId, (paidByInvoice.get(r.invoiceId) || 0) + (r.type === 'REFUND' ? -1 : 1) * toCents(r.amount));
  const invoiceItems = invoices.map((i) => {
    const total = toCents(i.total); const paid = paidByInvoice.get(i.id) || 0;
    return { kind: 'INVOICE', id: i.id, reference: i.reference, customer: i.customer?.name || null, status: i.status, dueDate: i.dueDate, total, paid, balance: Math.max(0, total - paid) };
  }).filter((i) => i.balance > 0);

  // Jobs: bookings that have money recorded directly against them (a deposit) and are not owned by an invoice.
  const jobRows = await prisma.financialTransaction.findMany({
    where: { businessId, status: 'RECORDED', bookingId: { not: null } },
    select: { bookingId: true, invoiceId: true, type: true, amount: true },
  });
  const invoiced = new Set(jobRows.filter((r) => r.invoiceId).map((r) => r.bookingId));
  const paidByJob = new Map();
  for (const r of jobRows) if (!invoiced.has(r.bookingId)) paidByJob.set(r.bookingId, (paidByJob.get(r.bookingId) || 0) + (r.type === 'REFUND' ? -1 : 1) * toCents(r.amount));
  const bookings = paidByJob.size
    ? await prisma.booking.findMany({ where: { businessId, id: { in: [...paidByJob.keys()] }, status: { not: 'CANCELLED' } }, select: { id: true, reference: true, price: true, status: true, customer: { select: { name: true } }, service: { select: { name: true } } } })
    : [];
  const jobItems = bookings.map((b) => {
    const total = toCents(b.price); const paid = paidByJob.get(b.id) || 0;
    return { kind: 'JOB', id: b.id, reference: b.reference, customer: b.customer?.name || null, service: b.service?.name || null, status: b.status, total, paid, balance: Math.max(0, total - paid) };
  }).filter((j) => j.balance > 0);

  const orderItems = orders.map((o) => ({ kind: 'ORDER', id: o.id, reference: o.reference, customer: o.customer?.name || null, status: 'UNPAID', method: o.paymentMethod, total: toCents(o.total), paid: 0, balance: toCents(o.total) }));

  const group = (items) => ({ count: items.length, total: money(sumCents(items.map((i) => i.balance))) });
  const out = {
    invoices: group(invoiceItems), jobs: group(jobItems), orders: group(orderItems),
    total: money(sumCents([...invoiceItems, ...jobItems, ...orderItems].map((i) => i.balance))),
  };
  if (detail) {
    const fmt = (i) => ({ ...i, total: money(i.total), paid: money(i.paid), balance: money(i.balance) });
    out.items = [...invoiceItems, ...jobItems, ...orderItems].sort((a, b) => b.balance - a.balance).map(fmt);
  }
  return out;
}

/** Trailing 12 local months of income vs expenses (chart series). */
async function monthlyTrend(businessId, now = new Date()) {
  const end = periodRange('month', { now }).to;
  const endParts = new Date(end.getTime() - 1);
  const p = { y: Number(monthKey(endParts).slice(0, 4)), m: Number(monthKey(endParts).slice(5)) - 1 };
  const from = localMidnight(p.y, p.m - 11, 1);
  const [tx, ex] = await Promise.all([
    prisma.financialTransaction.findMany({ where: { businessId, status: 'RECORDED', currency: BASE_CURRENCY, paidAt: { gte: from, lt: end } }, select: { type: true, amount: true, paidAt: true } }),
    prisma.expense.findMany({ where: { businessId, deletedAt: null, expenseDate: { gte: from, lt: end } }, select: { amount: true, expenseDate: true } }),
  ]);
  const keys = monthKeysBetween(from, end);
  const rows = new Map(keys.map((k) => [k, { received: 0, refunds: 0, expenses: 0 }]));
  for (const t of tx) { const r = rows.get(monthKey(t.paidAt)); if (r) r[t.type === 'REFUND' ? 'refunds' : 'received'] += toCents(t.amount); }
  for (const e of ex) { const r = rows.get(monthKey(e.expenseDate)); if (r) r.expenses += toCents(e.amount); }
  return keys.map((k) => { const r = rows.get(k); return { month: k, label: monthLabel(k), received: money(r.received), refunds: money(r.refunds), expenses: money(r.expenses), net: money(r.received - r.refunds - r.expenses) }; });
}

/** The full dashboard payload for one period. */
async function summary(businessId, { period = 'month', from, to, now = new Date() } = {}) {
  const range = periodRange(period, { now, from, to });
  const [tx, ex, business, out, trend] = await Promise.all([
    prisma.financialTransaction.findMany({
      where: { businessId, status: 'RECORDED', paidAt: { gte: range.from, lt: range.to } },
      orderBy: { paidAt: 'desc' },
    }),
    prisma.expense.findMany({ where: { businessId, deletedAt: null, expenseDate: { gte: range.from, lt: range.to } }, select: { amount: true, category: true } }),
    prisma.business.findUnique({ where: { id: businessId }, select: { currency: true } }),
    outstanding(businessId),
    monthlyTrend(businessId, now),
  ]);

  const warnings = [];
  const foreign = tx.filter((t) => t.currency !== BASE_CURRENCY);
  if (foreign.length) {
    const byCur = {};
    for (const t of foreign) byCur[t.currency] = (byCur[t.currency] || 0) + 1;
    warnings.push({ code: 'FOREIGN_CURRENCY', message: `${foreign.length} transaction(s) are not in ${BASE_CURRENCY} and are excluded from totals`, detail: byCur });
  }
  if (business?.currency && business.currency !== BASE_CURRENCY) {
    warnings.push({ code: 'BUSINESS_CURRENCY', message: `This business currency setting is ${business.currency}; ledger amounts are treated as ${BASE_CURRENCY}` });
  }
  const estimated = tx.filter((t) => t.estimatedDate).length;
  if (estimated) warnings.push({ code: 'ESTIMATED_DATES', message: `${estimated} backfilled transaction(s) use an estimated payment date` });

  const counted = tx.filter((t) => t.currency === BASE_CURRENCY);
  let received = 0, refunds = 0;
  const method = new Map(), sources = new Map(), split = { product: 0, service: 0, other: 0 };
  for (const t of counted) {
    const c = toCents(t.amount); const isRefund = t.type === 'REFUND';
    if (isRefund) refunds += c; else received += c;
    const m = method.get(t.method) || { received: 0, refunds: 0 }; m[isRefund ? 'refunds' : 'received'] += c; method.set(t.method, m);
    const src = sourceOf(t); const s = sources.get(src) || { received: 0, refunds: 0 }; s[isRefund ? 'refunds' : 'received'] += c; sources.set(src, s);
    split[REVENUE_CLASS[src]] += isRefund ? -c : c;
  }

  // Revenue by service: payments linked to a job, grouped by the booked service name.
  const bookingIds = [...new Set(counted.filter((t) => t.bookingId && t.type === 'PAYMENT').map((t) => t.bookingId))];
  const byService = new Map();
  if (bookingIds.length) {
    const bookings = await prisma.booking.findMany({ where: { businessId, id: { in: bookingIds } }, select: { id: true, service: { select: { name: true } } } });
    const nameOf = new Map(bookings.map((b) => [b.id, b.service?.name || 'Other service']));
    for (const t of counted) if (t.bookingId && t.type === 'PAYMENT') byService.set(nameOf.get(t.bookingId) || 'Other service', (byService.get(nameOf.get(t.bookingId) || 'Other service') || 0) + toCents(t.amount));
  }

  const expenses = sumCents(ex.map((e) => toCents(e.amount)));
  const byCategory = new Map();
  for (const e of ex) { const c = byCategory.get(e.category) || { total: 0, count: 0 }; c.total += toCents(e.amount); c.count++; byCategory.set(e.category, c); }

  return {
    period: { key: period, label: range.label, from: range.from.toISOString(), to: range.to.toISOString(), timezone: TIMEZONE },
    currency: BASE_CURRENCY,
    totals: {
      received: money(received), refunds: money(refunds), netReceipts: money(received - refunds),
      expenses: money(expenses), netCashMovement: money(received - refunds - expenses),
      transactionCount: counted.length, expenseCount: ex.length,
    },
    outstanding: out,
    byMethod: [...method].map(([m, v]) => ({ method: m, received: money(v.received), refunds: money(v.refunds), net: money(v.received - v.refunds) })).sort((a, b) => Number(b.net) - Number(a.net)),
    bySource: [...sources].map(([s, v]) => ({ source: s, class: REVENUE_CLASS[s], received: money(v.received), refunds: money(v.refunds), net: money(v.received - v.refunds) })),
    revenueSplit: { product: money(split.product), service: money(split.service), other: money(split.other) },
    byService: [...byService].map(([name, c]) => ({ name, received: money(c) })).sort((a, b) => Number(b.received) - Number(a.received)),
    expenseByCategory: [...byCategory].map(([category, v]) => ({ category, label: EXPENSE_CATEGORIES[category] || category, total: money(v.total), count: v.count })).sort((a, b) => Number(b.total) - Number(a.total)),
    monthly: trend,
    recent: tx.slice(0, 10).map(serialize),
    warnings,
  };
}

module.exports = { summary, outstanding, monthlyTrend };
