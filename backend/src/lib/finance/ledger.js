'use strict';
/**
 * Unified money ledger service. Every code path that records money received or
 * returned (manual entry, online order capture, gateway webhooks, POS sales and
 * refunds, invoice payments) goes through recordInTx() so there is exactly one
 * place that enforces: integer-cent math, one row per real payment (idempotency
 * keys + a unique gateway/reference), tenant stamping, and an audit row written
 * in the SAME database transaction as the money.
 */
const crypto = require('crypto');
const { fromCents, toCents, sumCents } = require('./money');
const { AppError } = require('../errors');

const METHODS = ['CASH', 'BANK_TRANSFER', 'CARD', 'PAYPAL', 'STRIPE', 'WIPAY', 'TILOPAY', 'OTHER'];
const GATEWAYS = ['STRIPE', 'PAYPAL', 'WIPAY', 'TILOPAY'];
const TX_TYPES = ['PAYMENT', 'REFUND'];
const PAYMENT_KINDS = ['FULL', 'DEPOSIT', 'PARTIAL'];
const BASE_CURRENCY = 'TTD';

const EXPENSE_CATEGORIES = Object.freeze({
  REFRIGERANT_GAS: 'Refrigerant and gas',
  PARTS_MATERIALS: 'Parts and materials',
  FUEL_TRANSPORT: 'Fuel and transportation',
  TOOLS_EQUIPMENT: 'Tools and equipment',
  REPAIRS_MAINTENANCE: 'Repairs and maintenance',
  WAGES_LABOUR: 'Wages and labour',
  UTILITIES: 'Electricity and utilities',
  INTERNET_PHONE: 'Internet and phone',
  ADVERTISING: 'Advertising and marketing',
  OFFICE: 'Office expenses',
  OTHER: 'Other expenses',
});

// Storefront Order.paymentMethod → ledger method
const ORDER_METHOD = { CASH_ON_DELIVERY: 'CASH', BANK_TRANSFER: 'BANK_TRANSFER', STRIPE: 'STRIPE', PAYPAL: 'PAYPAL', WIPAY: 'WIPAY', TILOPAY: 'TILOPAY' };

const normalizeMethod = (m) => { const v = String(m || '').toUpperCase(); return METHODS.includes(v) ? v : (ORDER_METHOD[v] || 'OTHER'); };
const reference = (prefix = 'TX') => `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

/** API shape: amounts are exact strings, never floats. */
function serialize(row) {
  if (!row) return row;
  return { ...row, amount: fromCents(toCents(row.amount)) };
}

/** What a payment is "about", used for the revenue split. Product = POS/online orders, service = invoices/jobs. */
function sourceOf(row) {
  if (row.saleId) return 'POS';
  if (row.orderId) return 'ONLINE';
  if (row.invoiceId) return 'INVOICE';
  if (row.bookingId) return 'JOB';
  return 'MANUAL';
}
const REVENUE_CLASS = { POS: 'product', ONLINE: 'product', INVOICE: 'service', JOB: 'service', MANUAL: 'other' };

async function audit(tx, { businessId, userId, entity, entityId, action, before = null, after = null }) {
  return tx.financeAuditLog.create({
    data: {
      businessId, userId: userId || null, entity, entityId: String(entityId), action,
      before: before ? JSON.stringify(before) : null,
      after: after ? JSON.stringify(after) : null,
    },
  });
}

/**
 * Records one transaction INSIDE the caller's database transaction. Idempotent:
 * an existing row with the same idempotencyKey (or gateway + externalReference)
 * is returned untouched, so replays and duplicate webhooks cannot double-record.
 * @returns {{ record: object, created: boolean }}
 */
async function recordInTx(tx, input) {
  const {
    businessId, type = 'PAYMENT', kind, method, gateway = null, externalReference = null, idempotencyKey = null,
    amountCents, currency = BASE_CURRENCY, paidAt = new Date(), source = 'MANUAL', estimatedDate = false,
    customerId = null, invoiceId = null, orderId = null, saleId = null, bookingId = null, relatedTransactionId = null,
    notes = null, createdById = null,
  } = input;
  if (!businessId) throw new Error('businessId is required');
  if (!TX_TYPES.includes(type)) throw new Error(`Invalid transaction type ${type}`);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new RangeError('Transaction amount must be a positive number of cents');

  if (idempotencyKey) {
    const dupe = await tx.financialTransaction.findFirst({ where: { businessId, idempotencyKey } });
    if (dupe) return { record: dupe, created: false };
  }
  if (gateway && externalReference) {
    const dupe = await tx.financialTransaction.findFirst({ where: { businessId, gateway, externalReference } });
    if (dupe) {
      // Same reference but a DIFFERENT logical payment would silently lose money — refuse loudly instead.
      if (idempotencyKey && dupe.idempotencyKey && dupe.idempotencyKey !== idempotencyKey) {
        throw new AppError(409, `Reference ${externalReference} was already recorded for another payment`);
      }
      return { record: dupe, created: false };
    }
  }

  const record = await tx.financialTransaction.create({
    data: {
      businessId, reference: reference(type === 'REFUND' ? 'RF' : 'TX'), type,
      kind: type === 'REFUND' ? 'REFUND' : (PAYMENT_KINDS.includes(kind) ? kind : 'FULL'),
      method: normalizeMethod(method), gateway, externalReference: externalReference || null, idempotencyKey,
      amount: fromCents(amountCents), currency, paidAt, source, estimatedDate,
      customerId, invoiceId, orderId, saleId, bookingId, relatedTransactionId, notes, createdById,
    },
  });
  await audit(tx, { businessId, userId: createdById, entity: 'TRANSACTION', entityId: record.id, action: 'CREATE', after: serialize(record) });
  return { record, created: true };
}

/** Net money (payments - refunds, RECORDED only) for a set of ledger rows, in cents. */
function netCents(rows) {
  return sumCents(rows.map((r) => (r.status === 'VOIDED' ? 0 : (r.type === 'REFUND' ? -toCents(r.amount) : toCents(r.amount)))));
}

/** Payments recorded against an invoice: { totalCents, paidCents (net of refunds), balanceCents }. */
async function invoiceBalance(client, businessId, invoice) {
  const rows = await client.financialTransaction.findMany({
    where: { businessId, invoiceId: invoice.id, status: 'RECORDED' },
    select: { type: true, status: true, amount: true, paidAt: true },
  });
  const totalCents = toCents(invoice.total);
  const paidCents = netCents(rows);
  return { totalCents, paidCents, balanceCents: Math.max(0, totalCents - paidCents), rows };
}

/**
 * Keeps Invoice.status/paidAt consistent with the ledger (PENDING ↔ PARTIAL ↔ PAID).
 * CANCELLED invoices and zero-value invoices are never touched.
 */
async function syncInvoiceStatus(tx, businessId, invoiceId) {
  const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, businessId } });
  if (!invoice || invoice.status === 'CANCELLED' || toCents(invoice.total) <= 0) return invoice;
  const { totalCents, paidCents, rows } = await invoiceBalance(tx, businessId, invoice);
  let status = invoice.status;
  let paidAt = invoice.paidAt;
  if (paidCents >= totalCents) {
    status = 'PAID';
    paidAt = invoice.paidAt || rows.filter((r) => r.type === 'PAYMENT').map((r) => r.paidAt).sort((a, b) => b - a)[0] || new Date();
  } else if (paidCents > 0) {
    status = 'PARTIAL'; paidAt = null;
  } else if (['PAID', 'PARTIAL'].includes(invoice.status)) {
    status = 'PENDING'; paidAt = null;
  }
  if (status === invoice.status && String(paidAt) === String(invoice.paidAt)) return invoice;
  return tx.invoice.update({ where: { id: invoice.id }, data: { status, paidAt } });
}

/** Serialises concurrent writes against one invoice (row lock on PostgreSQL; SQLite already serialises writers). */
const lockInvoice = (tx, businessId, invoiceId) =>
  tx.invoice.updateMany({ where: { id: invoiceId, businessId }, data: { updatedAt: new Date() } });

/* ---------------------------------------------------------------- legacy-flow adapters */

/** Money received for a storefront order (idempotent; one row per order). */
async function recordOrderPayment(tx, order, { createdById = null, estimated = false } = {}) {
  const amountCents = toCents(order.total);
  if (amountCents <= 0) return null;
  const method = ORDER_METHOD[order.paymentMethod] || normalizeMethod(order.paymentMethod);
  const gateway = GATEWAYS.includes(method) ? method : null;
  return recordInTx(tx, {
    businessId: order.businessId, type: 'PAYMENT', kind: 'FULL', method, gateway,
    externalReference: order.paymentReference || null, idempotencyKey: `order:${order.id}:payment`,
    amountCents, paidAt: order.paidAt || order.createdAt || new Date(), estimatedDate: estimated && !order.paidAt,
    source: gateway ? 'GATEWAY' : 'ORDER', customerId: order.customerId, orderId: order.id, createdById,
    notes: `Online order ${order.reference}`,
  });
}

/** Full refund of a storefront order. Makes sure the original payment row exists first so net receipts stay correct. */
async function recordOrderRefund(tx, order, { createdById = null, at = null } = {}) {
  const payment = await recordOrderPayment(tx, order, { createdById, estimated: true });
  if (!payment) return null;
  return recordInTx(tx, {
    businessId: order.businessId, type: 'REFUND', method: payment.record.method, idempotencyKey: `order:${order.id}:refund`,
    amountCents: toCents(order.total), paidAt: at || new Date(), estimatedDate: Boolean(at), source: payment.record.source, customerId: order.customerId,
    orderId: order.id, relatedTransactionId: payment.record.id, createdById, notes: `Refund of online order ${order.reference}`,
  });
}

/** Money received for a POS sale. The cashier's reference goes in notes (it is not a unique gateway id). */
async function recordSalePayment(tx, sale, { createdById = null } = {}) {
  const amountCents = toCents(sale.total);
  if (amountCents <= 0) return null;
  return recordInTx(tx, {
    businessId: sale.businessId, type: 'PAYMENT', kind: 'FULL', method: sale.paymentMethod, idempotencyKey: `sale:${sale.id}:payment`,
    amountCents, paidAt: sale.createdAt || new Date(), source: 'POS', customerId: sale.customerId || null, saleId: sale.id, createdById,
    notes: `POS sale ${sale.saleNumber}${sale.paymentReference ? ` · ref ${sale.paymentReference}` : ''}`,
  });
}

async function recordSaleRefund(tx, sale, refund, { createdById = null } = {}) {
  const payment = await recordSalePayment(tx, sale, { createdById });
  const amountCents = toCents(refund.amount);
  if (!payment || amountCents <= 0) return null;
  return recordInTx(tx, {
    businessId: sale.businessId, type: 'REFUND', method: payment.record.method, idempotencyKey: `sale-refund:${refund.id}`,
    amountCents, paidAt: refund.createdAt || new Date(), source: 'POS', customerId: sale.customerId || null, saleId: sale.id,
    relatedTransactionId: payment.record.id, createdById, notes: `POS refund ${refund.refundNumber}`,
  });
}

/**
 * Records the unpaid balance of an invoice as paid (used by "mark paid" and by
 * setting an invoice's status to PAID). No-op when nothing is outstanding.
 */
async function recordInvoiceSettlement(tx, invoice, { method = 'OTHER', createdById = null } = {}) {
  await lockInvoice(tx, invoice.businessId, invoice.id);
  const bal = await invoiceBalance(tx, invoice.businessId, invoice);
  if (bal.balanceCents <= 0 || bal.totalCents <= 0) return null;
  return recordInTx(tx, {
    businessId: invoice.businessId, type: 'PAYMENT', kind: bal.paidCents > 0 ? 'PARTIAL' : 'FULL', method,
    amountCents: bal.balanceCents, paidAt: new Date(), source: 'INVOICE', customerId: invoice.customerId, invoiceId: invoice.id,
    createdById, notes: `Invoice ${invoice.reference} marked as paid`,
  });
}

/** One-off: an invoice already marked PAID before the ledger existed. */
async function recordLegacyInvoicePayment(tx, invoice) {
  const amountCents = toCents(invoice.total);
  if (amountCents <= 0) return null;
  return recordInTx(tx, {
    businessId: invoice.businessId, type: 'PAYMENT', kind: 'FULL', method: 'OTHER', idempotencyKey: `invoice:${invoice.id}:legacy-paid`,
    amountCents, paidAt: invoice.paidAt || invoice.updatedAt || invoice.createdAt, estimatedDate: !invoice.paidAt, source: 'BACKFILL',
    customerId: invoice.customerId, invoiceId: invoice.id, notes: `Invoice ${invoice.reference} (paid before the ledger existed)`,
  });
}

module.exports = {
  recordLegacyInvoicePayment,
  recordOrderPayment, recordOrderRefund, recordSalePayment, recordSaleRefund, recordInvoiceSettlement,
  METHODS, GATEWAYS, TX_TYPES, PAYMENT_KINDS, BASE_CURRENCY, EXPENSE_CATEGORIES, ORDER_METHOD,
  normalizeMethod, reference, serialize, sourceOf, REVENUE_CLASS, audit, recordInTx, netCents,
  invoiceBalance, syncInvoiceStatus, lockInvoice,
};
