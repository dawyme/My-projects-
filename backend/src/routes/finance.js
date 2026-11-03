'use strict';
/**
 * /api/finance — Financial Management (admin only).
 * Mounted behind featureProtectedRoute('financials'); every handler additionally
 * requires finance.read / finance.manage. Tenant scope always comes from the
 * authenticated user (tenantWhere / req.tenantId), never from client input.
 */
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { requirePermission } = require('../middleware/auth');
const { paginationSchema, meta, toCsv } = require('../lib/pagination');
const { badRequest, notFound, conflict, AppError } = require('../lib/errors');
const { getSupabaseClient } = require('../lib/supabase');
const { parseMoney, toCents, fromCents } = require('../lib/finance/money');
const { PERIODS, periodRange, parseLocalDate, TIMEZONE } = require('../lib/finance/periods');
const L = require('../lib/finance/ledger');
const reports = require('../lib/finance/reports');

const router = express.Router();
const read = requirePermission('finance.read');
const manage = requirePermission('finance.manage');

/* ------------------------------------------------------------------ helpers */
const moneyInput = z.union([z.number(), z.string()]).transform((v, ctx) => {
  try { return parseMoney(v); } catch (e) { ctx.addIssue({ code: 'custom', message: e.message }); return z.NEVER; }
});
const positiveMoney = moneyInput.refine((c) => c > 0, 'Amount must be greater than zero');
const dateInput = z.union([z.string(), z.date()]).transform((v, ctx) => {
  // A bare YYYY-MM-DD is a calendar day in Trinidad: store local noon so it never slips to the previous/next day.
  let d;
  try { d = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(parseLocalDate(v).getTime() + 12 * 36e5) : (v instanceof Date ? v : new Date(v)); }
  catch (e) { ctx.addIssue({ code: 'custom', message: e.message }); return z.NEVER; }
  if (Number.isNaN(d.getTime())) { ctx.addIssue({ code: 'custom', message: 'Invalid date' }); return z.NEVER; }
  return d;
}).refine((d) => d.getTime() <= Date.now() + 36e5 * 24, 'Date cannot be in the future');
const optText = (max) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));
const id = z.string().trim().min(1).max(64);

const rangeQuery = z.object({
  period: z.enum(PERIODS).default('month'),
  from: z.string().optional(),
  to: z.string().optional(),
});
function rangeOf(q) {
  try { return periodRange(q.period, { from: q.from, to: q.to }); } catch (e) { throw badRequest(e.message); }
}

/** CSV cells starting with = + - @ are executed as formulas by spreadsheet apps; neutralise them. */
const safeCell = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
const csvCols = (cols) => cols.map((c) => ({ label: c.label, value: (r) => safeCell(typeof c.value === 'function' ? c.value(r) : r[c.value]) }));
const sendCsv = (res, name, rows, cols) => { res.header('Content-Type', 'text/csv; charset=utf-8'); res.attachment(name); return res.send(toCsv(rows, csvCols(cols))); };
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

/* ------------------------------------------------------------------ meta */
router.get('/meta', read, (req, res) => {
  res.json({ success: true, data: {
    currency: L.BASE_CURRENCY, timezone: TIMEZONE, periods: PERIODS, methods: L.METHODS,
    expenseCategories: Object.entries(L.EXPENSE_CATEGORIES).map(([key, label]) => ({ key, label })),
    receipts: { maxBytes: RECEIPT_MAX, types: [...RECEIPT_TYPES.keys()] },
  } });
});

/* ------------------------------------------------------------------ summary / outstanding */
router.get('/summary', read, validate(rangeQuery, 'query'), asyncHandler(async (req, res) => {
  const q = req.validatedQuery; rangeOf(q);
  const data = await reports.summary(req.tenantId, { period: q.period, from: q.from, to: q.to });
  res.json({ success: true, data });
}));

router.get('/outstanding', read, asyncHandler(async (req, res) => {
  res.json({ success: true, data: await reports.outstanding(req.tenantId, { detail: true }) });
}));

/* ------------------------------------------------------------------ transactions */
const txListQuery = paginationSchema.merge(rangeQuery).extend({
  type: z.enum(['PAYMENT', 'REFUND']).optional(),
  method: z.enum(L.METHODS).optional(),
  status: z.enum(['RECORDED', 'VOIDED']).optional(),
  invoiceId: id.optional(),
  format: z.enum(['json', 'csv']).default('json'),
});

router.get('/transactions', read, validate(txListQuery, 'query'), asyncHandler(async (req, res) => {
  const q = req.validatedQuery; const range = rangeOf(q);
  const where = { businessId: req.tenantId, paidAt: { gte: range.from, lt: range.to } };
  if (q.type) where.type = q.type;
  if (q.method) where.method = q.method;
  if (q.status) where.status = q.status;
  if (q.invoiceId) where.invoiceId = q.invoiceId;
  if (q.search) where.OR = [{ reference: { contains: q.search } }, { externalReference: { contains: q.search } }, { notes: { contains: q.search } }];

  if (q.format === 'csv') {
    const rows = await prisma.financialTransaction.findMany({ where, orderBy: { paidAt: 'desc' }, take: 20000 });
    return sendCsv(res, 'transactions.csv', rows.map(L.serialize), [
      { label: 'Reference', value: 'reference' }, { label: 'Date', value: (r) => day(r.paidAt) }, { label: 'Type', value: 'type' },
      { label: 'Kind', value: 'kind' }, { label: 'Method', value: 'method' }, { label: 'Amount (TTD)', value: 'amount' },
      { label: 'Status', value: 'status' }, { label: 'Source', value: (r) => L.sourceOf(r) }, { label: 'Gateway ref', value: 'externalReference' },
      { label: 'Notes', value: 'notes' }, { label: 'Estimated date', value: (r) => (r.estimatedDate ? 'yes' : '') },
    ]);
  }
  const [rows, total] = await Promise.all([
    prisma.financialTransaction.findMany({ where, orderBy: { paidAt: q.order }, skip: (q.page - 1) * q.limit, take: q.limit }),
    prisma.financialTransaction.count({ where }),
  ]);
  res.json({ success: true, data: rows.map((r) => ({ ...L.serialize(r), sourceLabel: L.sourceOf(r) })), meta: meta(total, q.page, q.limit) });
}));

const manualTxBody = z.object({
  type: z.enum(['PAYMENT', 'REFUND']).default('PAYMENT'),
  kind: z.enum(L.PAYMENT_KINDS).optional(),
  method: z.enum(L.METHODS).optional(),
  amount: positiveMoney,
  paidAt: dateInput.optional(),
  reference: optText(120),
  notes: optText(1000),
  customerId: id.optional().nullable(),
  invoiceId: id.optional().nullable(),
  bookingId: id.optional().nullable(),
  relatedTransactionId: id.optional().nullable(),
}).strict();

router.post('/transactions', manage, validate(manualTxBody), asyncHandler(async (req, res) => {
  const b = req.body; const businessId = req.tenantId;
  const result = await prisma.$transaction(async (tx) => {
    let { customerId, invoiceId, bookingId } = b;
    let orderId = null, saleId = null, method = b.method, relatedTransactionId = null;
    let kind = b.kind;

    if (b.type === 'REFUND') {
      if (!b.relatedTransactionId) throw badRequest('A refund must reference the payment it reverses (relatedTransactionId)');
      const original = await tx.financialTransaction.findFirst({ where: { id: b.relatedTransactionId, businessId } });
      if (!original || original.type !== 'PAYMENT' || original.status !== 'RECORDED') throw notFound('Original payment not found');
      if (original.invoiceId) await L.lockInvoice(tx, businessId, original.invoiceId);
      const refunded = L.netCents(await tx.financialTransaction.findMany({ where: { businessId, relatedTransactionId: original.id, status: 'RECORDED' } })) * -1;
      if (b.amount > toCents(original.amount) - refunded) throw badRequest('Refund exceeds the amount still refundable on the original payment');
      ({ customerId, invoiceId, bookingId, orderId, saleId } = original); method = method || original.method; relatedTransactionId = original.id;
    } else {
      if (!b.method) throw badRequest('Payment method is required');
      if (customerId && !(await tx.customer.findFirst({ where: { id: customerId, businessId }, select: { id: true } }))) throw badRequest('Customer not found');
      if (bookingId && !(await tx.booking.findFirst({ where: { id: bookingId, businessId }, select: { id: true, status: true } }))) throw badRequest('Booking not found');
      if (invoiceId) {
        await L.lockInvoice(tx, businessId, invoiceId);
        const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, businessId } });
        if (!invoice) throw badRequest('Invoice not found');
        if (invoice.status === 'CANCELLED') throw badRequest('Cannot record a payment against a cancelled invoice');
        const bal = await L.invoiceBalance(tx, businessId, invoice);
        if (b.amount > bal.balanceCents) throw badRequest(`Payment exceeds the outstanding balance (${fromCents(bal.balanceCents)})`);
        customerId = customerId || invoice.customerId;
        kind = kind || (b.amount < bal.balanceCents ? (bal.paidCents === 0 ? 'DEPOSIT' : 'PARTIAL') : 'FULL');
      }
    }

    const external = b.reference || null;
    const out = await L.recordInTx(tx, {
      businessId, type: b.type, kind, method, gateway: external ? 'MANUAL' : null, externalReference: external,
      amountCents: b.amount, paidAt: b.paidAt || new Date(), source: invoiceId ? 'INVOICE' : 'MANUAL',
      customerId: customerId || null, invoiceId: invoiceId || null, orderId, saleId, bookingId: bookingId || null,
      relatedTransactionId, notes: b.notes, createdById: req.user.id,
    });
    if (!out.created) throw conflict('A transaction with this reference already exists');
    if (out.record.invoiceId) await L.syncInvoiceStatus(tx, businessId, out.record.invoiceId);
    return out.record;
  });
  res.status(201).json({ success: true, data: L.serialize(result) });
}));

router.post('/transactions/:id/void', manage, validate(z.object({ reason: z.string().trim().min(3).max(300) }).strict()), asyncHandler(async (req, res) => {
  const businessId = req.tenantId;
  const row = await prisma.$transaction(async (tx) => {
    const existing = await tx.financialTransaction.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) throw notFound('Transaction not found');
    if (existing.status === 'VOIDED') throw conflict('Transaction is already voided');
    if (existing.invoiceId) await L.lockInvoice(tx, businessId, existing.invoiceId);
    if (existing.type === 'PAYMENT') {
      const live = await tx.financialTransaction.count({ where: { businessId, relatedTransactionId: existing.id, status: 'RECORDED' } });
      if (live) throw badRequest('Void the refund(s) on this payment first');
    }
    const updated = await tx.financialTransaction.update({
      where: { id: existing.id },
      data: { status: 'VOIDED', voidedAt: new Date(), voidedById: req.user.id, voidReason: req.body.reason },
    });
    await L.audit(tx, { businessId, userId: req.user.id, entity: 'TRANSACTION', entityId: existing.id, action: 'VOID', before: L.serialize(existing), after: L.serialize(updated) });
    if (existing.invoiceId) await L.syncInvoiceStatus(tx, businessId, existing.invoiceId);
    return updated;
  });
  res.json({ success: true, data: L.serialize(row) });
}));

router.get('/transactions/:id/history', read, asyncHandler(async (req, res) => {
  const tx = await prisma.financialTransaction.findFirst({ where: { id: req.params.id, businessId: req.tenantId }, select: { id: true } });
  if (!tx) throw notFound('Transaction not found');
  const data = await prisma.financeAuditLog.findMany({ where: { businessId: req.tenantId, entity: 'TRANSACTION', entityId: tx.id }, orderBy: { createdAt: 'asc' } });
  res.json({ success: true, data });
}));

/* ------------------------------------------------------------------ expenses */
const categoryEnum = z.enum(Object.keys(L.EXPENSE_CATEGORIES));
const expenseBody = z.object({
  category: categoryEnum,
  amount: positiveMoney,
  expenseDate: dateInput,
  method: z.enum(L.METHODS).default('CASH'),
  description: z.string().trim().min(1).max(300),
  payee: optText(160),
  referenceNumber: optText(120),
}).strict();

const expenseView = (e) => ({ ...e, amount: fromCents(toCents(e.amount)), hasReceipt: Boolean(e.receiptPath), receiptPath: undefined });
const expenseSnapshot = (e) => ({ ...e, amount: fromCents(toCents(e.amount)) });

const expListQuery = paginationSchema.merge(rangeQuery).extend({
  category: categoryEnum.optional(),
  format: z.enum(['json', 'csv']).default('json'),
});

router.get('/expenses', read, validate(expListQuery, 'query'), asyncHandler(async (req, res) => {
  const q = req.validatedQuery; const range = rangeOf(q);
  const where = { businessId: req.tenantId, deletedAt: null, expenseDate: { gte: range.from, lt: range.to } };
  if (q.category) where.category = q.category;
  if (q.search) where.OR = [{ description: { contains: q.search } }, { payee: { contains: q.search } }, { referenceNumber: { contains: q.search } }];
  if (q.format === 'csv') {
    const rows = await prisma.expense.findMany({ where, orderBy: { expenseDate: 'desc' }, take: 20000 });
    return sendCsv(res, 'expenses.csv', rows.map(expenseView), [
      { label: 'Date', value: (r) => day(r.expenseDate) }, { label: 'Category', value: (r) => L.EXPENSE_CATEGORIES[r.category] || r.category },
      { label: 'Description', value: 'description' }, { label: 'Payee', value: 'payee' }, { label: 'Method', value: 'method' },
      { label: 'Reference', value: 'referenceNumber' }, { label: 'Amount (TTD)', value: 'amount' }, { label: 'Receipt', value: (r) => (r.hasReceipt ? 'yes' : '') },
    ]);
  }
  const [rows, total, all] = await Promise.all([
    prisma.expense.findMany({ where, orderBy: { expenseDate: q.order }, skip: (q.page - 1) * q.limit, take: q.limit }),
    prisma.expense.count({ where }),
    prisma.expense.findMany({ where, select: { amount: true } }),
  ]);
  res.json({ success: true, data: rows.map(expenseView), meta: { ...meta(total, q.page, q.limit), totalAmount: fromCents(all.reduce((s, e) => s + toCents(e.amount), 0)) } });
}));

router.post('/expenses', manage, validate(expenseBody), asyncHandler(async (req, res) => {
  const b = req.body; const businessId = req.tenantId;
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.expense.create({ data: {
      businessId, category: b.category, amount: fromCents(b.amount), expenseDate: b.expenseDate, method: b.method,
      description: b.description, payee: b.payee, referenceNumber: b.referenceNumber, createdById: req.user.id,
    } });
    await L.audit(tx, { businessId, userId: req.user.id, entity: 'EXPENSE', entityId: created.id, action: 'CREATE', after: expenseSnapshot(created) });
    return created;
  });
  res.status(201).json({ success: true, data: expenseView(row) });
}));

router.put('/expenses/:id', manage, validate(expenseBody.partial()), asyncHandler(async (req, res) => {
  const b = req.body; const businessId = req.tenantId;
  const row = await prisma.$transaction(async (tx) => {
    const existing = await tx.expense.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) throw notFound('Expense not found');
    const data = { ...b }; if (b.amount !== undefined) data.amount = fromCents(b.amount);
    const updated = await tx.expense.update({ where: { id: existing.id }, data });
    await L.audit(tx, { businessId, userId: req.user.id, entity: 'EXPENSE', entityId: existing.id, action: 'UPDATE', before: expenseSnapshot(existing), after: expenseSnapshot(updated) });
    return updated;
  });
  res.json({ success: true, data: expenseView(row) });
}));

// Soft delete: the row and its history stay; it just stops counting.
router.delete('/expenses/:id', manage, asyncHandler(async (req, res) => {
  const businessId = req.tenantId;
  await prisma.$transaction(async (tx) => {
    const existing = await tx.expense.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) throw notFound('Expense not found');
    const updated = await tx.expense.update({ where: { id: existing.id }, data: { deletedAt: new Date(), deletedById: req.user.id } });
    await L.audit(tx, { businessId, userId: req.user.id, entity: 'EXPENSE', entityId: existing.id, action: 'DELETE', before: expenseSnapshot(existing), after: { deletedAt: updated.deletedAt } });
  });
  res.json({ success: true, message: 'Expense deleted (kept in the audit history)' });
}));

router.get('/expenses/:id/history', read, asyncHandler(async (req, res) => {
  const e = await prisma.expense.findFirst({ where: { id: req.params.id, businessId: req.tenantId }, select: { id: true } });
  if (!e) throw notFound('Expense not found');
  const data = await prisma.financeAuditLog.findMany({ where: { businessId: req.tenantId, entity: 'EXPENSE', entityId: e.id }, orderBy: { createdAt: 'asc' } });
  res.json({ success: true, data });
}));

/* ------------------------------------------------------------------ receipts (private Supabase Storage) */
const RECEIPT_MAX = 5 * 1024 * 1024;
const RECEIPT_TYPES = new Map([['application/pdf', 'pdf'], ['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp']]);
const RECEIPT_BUCKET = () => process.env.FINANCE_RECEIPTS_BUCKET || 'finance-receipts';
const receiptUpload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: RECEIPT_MAX, files: 1 },
  fileFilter: (req, file, cb) => (RECEIPT_TYPES.has(file.mimetype) ? cb(null, true) : cb(badRequest('Receipts must be a PDF, JPG, PNG or WebP file'))),
});
/** Content sniffing: the declared mime type must match the file's real magic bytes. */
function sniffMatches(mime, buf) {
  if (!buf || buf.length < 12) return false;
  if (mime === 'application/pdf') return buf.subarray(0, 4).toString() === '%PDF';
  if (mime === 'image/png') return buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'image/jpeg') return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (mime === 'image/webp') return buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP';
  return false;
}
const storageClient = () => {
  const client = getSupabaseClient(true);
  if (!client) throw new AppError(503, 'Receipt storage is not configured (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required)');
  return client;
};

router.post('/expenses/:id/receipt', manage, (req, res, next) => receiptUpload.single('file')(req, res, (err) => {
  if (!err) return next();
  next(err.code === 'LIMIT_FILE_SIZE' ? badRequest('Receipt is larger than 5MB') : err);
}), asyncHandler(async (req, res) => {
  const businessId = req.tenantId;
  const expense = await prisma.expense.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
  if (!expense) throw notFound('Expense not found');
  if (!req.file) throw badRequest('Attach the receipt as the "file" field');
  if (!sniffMatches(req.file.mimetype, req.file.buffer)) throw badRequest('The file content does not match its type');
  const client = storageClient();
  // businessId prefix keeps tenants apart even inside one bucket.
  const path = `${businessId}/${expense.id}/${crypto.randomBytes(8).toString('hex')}.${RECEIPT_TYPES.get(req.file.mimetype)}`;
  const up = await client.storage.from(RECEIPT_BUCKET()).upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
  if (up.error) throw new AppError(503, /not found/i.test(up.error.message) ? `Receipt bucket "${RECEIPT_BUCKET()}" does not exist — create it as a PRIVATE bucket` : 'Receipt upload failed');
  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.expense.update({ where: { id: expense.id }, data: { receiptPath: path, receiptMime: req.file.mimetype } });
    await L.audit(tx, { businessId, userId: req.user.id, entity: 'EXPENSE', entityId: expense.id, action: 'RECEIPT', before: { hasReceipt: Boolean(expense.receiptPath) }, after: { hasReceipt: true } });
    return updated;
  });
  if (expense.receiptPath) client.storage.from(RECEIPT_BUCKET()).remove([expense.receiptPath]).catch(() => {});
  res.status(201).json({ success: true, data: expenseView(row) });
}));

router.get('/expenses/:id/receipt', read, asyncHandler(async (req, res) => {
  const expense = await prisma.expense.findFirst({ where: { id: req.params.id, businessId: req.tenantId, deletedAt: null } });
  if (!expense) throw notFound('Expense not found');
  if (!expense.receiptPath) throw notFound('This expense has no receipt');
  const { data, error } = await storageClient().storage.from(RECEIPT_BUCKET()).createSignedUrl(expense.receiptPath, 300);
  if (error || !data?.signedUrl) throw new AppError(503, 'Could not create a receipt link');
  res.json({ success: true, data: { url: data.signedUrl, expiresInSeconds: 300, mime: expense.receiptMime } });
}));

module.exports = router;
