const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect, adminOnly } = require('../middleware/auth');
const { paginationSchema, meta, toCsv } = require('../lib/pagination');
const { tenantWhere } = require('../lib/tenant');
const { badRequest, notFound } = require('../lib/errors');
const { audit, activity } = require('../lib/audit');

const router = express.Router();

const STATUSES = ['DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED'];
const SORTABLE = ['createdAt', 'updatedAt', 'reference', 'total', 'status'];

const reference = () => `EST-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

const line = z.object({
  description: z.string().trim().min(1).max(300),
  quantity: z.coerce.number().min(0).default(1), // hours for labour
  unitPrice: z.coerce.number().min(0).default(0), // hourly rate / unit price
  amount: z.coerce.number().min(0).optional(), // optional explicit total
});

const body = z.object({
  customerId: z.string().uuid('A valid customer is required'),
  status: z.enum(STATUSES).default('DRAFT'),
  labour: z.array(line).max(100).optional().nullable(),
  parts: z.array(line).max(200).optional().nullable(),
  taxRate: z.coerce.number().min(0).max(100).default(0),
  discount: z.coerce.number().min(0).default(0),
  notes: z.string().trim().max(4000).optional().nullable(),
});

const lineTotal = (l) => round(l.amount !== undefined && l.amount !== null ? l.amount : (l.quantity || 0) * (l.unitPrice || 0));

/** Recomputes subtotal/tax/total from the labour + parts lines. */
function withTotals(data, base = {}) {
  const labour = data.labour !== undefined ? data.labour : base.labour;
  const parts = data.parts !== undefined ? data.parts : base.parts;
  const taxRate = data.taxRate !== undefined ? data.taxRate : base.taxRate ?? 0;
  const discount = data.discount !== undefined ? data.discount : base.discount ?? 0;
  const sum = (arr) => (Array.isArray(arr) ? arr.reduce((s, l) => s + lineTotal(l), 0) : 0);
  const subtotal = round(sum(labour) + sum(parts));
  const tax = round(subtotal * ((Number(taxRate) || 0) / 100));
  return {
    ...data,
    labour: labour === undefined ? undefined : JSON.stringify(labour || []),
    parts: parts === undefined ? undefined : JSON.stringify(parts || []),
    subtotal,
    tax,
    total: round(Math.max(0, subtotal + tax - (Number(discount) || 0))),
  };
}

async function resolveCustomer(req, customerId) {
  const customer = await prisma.customer.findFirst({ where: tenantWhere(req, { id: customerId }), select: { id: true } });
  if (!customer) throw badRequest('Customer not found');
}

const parseLines = (v) => { try { return v ? JSON.parse(v) : []; } catch { return []; } };
const decorate = (e) => ({ ...e, labour: parseLines(e.labour), parts: parseLines(e.parts) });

const listQuery = paginationSchema.extend({
  status: z.string().optional(),
  customerId: z.string().optional(),
  format: z.enum(['json', 'csv']).default('json'),
});

// GET /api/estimates
router.get('/', protect, validate(listQuery, 'query'), asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const where = tenantWhere(req);
  if (q.status) where.status = { in: q.status.split(',').map((s) => s.trim().toUpperCase()).filter((s) => STATUSES.includes(s)) };
  if (q.customerId) where.customerId = q.customerId;
  if (q.search) {
    where.OR = [
      { reference: { contains: q.search } }, { notes: { contains: q.search } },
      { customer: { name: { contains: q.search } } }, { customer: { email: { contains: q.search } } },
    ];
  }
  const orderBy = ['createdAt', 'reference', 'total', 'status', 'updatedAt'].includes(q.sort) ? { [q.sort]: q.order } : { createdAt: q.order };

  if (q.format === 'csv') {
    const rows = await prisma.estimate.findMany({ where, orderBy, include: { customer: { select: { name: true, email: true } } } });
    res.header('Content-Type', 'text/csv');
    res.attachment('estimates.csv');
    return res.send(toCsv(rows, [
      { label: 'Reference', value: 'reference' },
      { label: 'Customer', value: (r) => r.customer?.name },
      { label: 'Status', value: 'status' }, { label: 'Subtotal', value: 'subtotal' },
      { label: 'Tax', value: 'tax' }, { label: 'Discount', value: 'discount' },
      { label: 'Total', value: 'total' }, { label: 'Created', value: 'createdAt' },
    ]));
  }

  const [items, total] = await Promise.all([
    prisma.estimate.findMany({
      where, orderBy, skip: (q.page - 1) * q.limit, take: q.limit,
      include: { customer: { select: { id: true, name: true, email: true, phone: true } } },
    }),
    prisma.estimate.count({ where }),
  ]);
  res.json({ success: true, data: items.map(decorate), meta: meta(total, q.page, q.limit) });
}));

// GET /api/estimates/:id
router.get('/:id', protect, asyncHandler(async (req, res) => {
  const estimate = await prisma.estimate.findFirst({
    where: tenantWhere(req, { id: req.params.id }),
    include: { customer: { select: { id: true, name: true, email: true, phone: true, address: true } } },
  });
  if (!estimate) throw notFound('Estimate not found');
  res.json({ success: true, data: decorate(estimate) });
}));

// POST /api/estimates
router.post('/', protect, validate(body), asyncHandler(async (req, res) => {
  await resolveCustomer(req, req.body.customerId);
  const estimate = await prisma.estimate.create({
    data: { ...withTotals(req.body), reference: reference(), businessId: req.tenantId },
    include: { customer: { select: { id: true, name: true, email: true } } },
  });
  await audit(req, 'CREATE', 'Estimate', estimate.id, { reference: estimate.reference, total: estimate.total });
  await activity(req.user.id, 'estimate', `${req.user.name} created estimate ${estimate.reference}`);
  res.status(201).json({ success: true, data: decorate(estimate) });
}));

// PUT /api/estimates/:id
router.put('/:id', protect, validate(body.partial()), asyncHandler(async (req, res) => {
  const existing = await prisma.estimate.findFirst({ where: tenantWhere(req, { id: req.params.id }) });
  if (!existing) throw notFound('Estimate not found');
  if (req.body.customerId) await resolveCustomer(req, req.body.customerId);
  if (req.body.status && existing.status === 'ACCEPTED' && req.body.status !== 'ACCEPTED') {
    throw badRequest('An accepted estimate cannot be reopened — create a new estimate instead');
  }
  const estimate = await prisma.estimate.update({ where: { id: existing.id }, data: withTotals(req.body, existing) });
  await audit(req, 'UPDATE', 'Estimate', estimate.id, req.body);
  res.json({ success: true, data: decorate(estimate) });
}));

// POST /api/estimates/:id/convert — turn an accepted estimate into an invoice
router.post('/:id/convert', protect, asyncHandler(async (req, res) => {
  const existing = await prisma.estimate.findFirst({ where: tenantWhere(req, { id: req.params.id }) });
  if (!existing) throw notFound('Estimate not found');
  if (!['ACCEPTED', 'SENT', 'DRAFT'].includes(existing.status)) {
    throw badRequest(`Only a draft, sent or accepted estimate can be converted (status: ${existing.status})`);
  }
  const invoiceReference = existing.reference.replace(/^EST-/, 'INV-');
  const invoice = await prisma.$transaction(async (tx) => {
    const dupe = await tx.invoice.findFirst({ where: { businessId: req.tenantId, reference: invoiceReference } });
    if (dupe) return dupe;
    const created = await tx.invoice.create({
      data: {
        businessId: req.tenantId,
        reference: invoiceReference,
        customerId: existing.customerId,
        status: 'PENDING',
        subtotal: existing.subtotal,
        tax: existing.tax,
        total: existing.total,
        labour: existing.labour,
        parts: existing.parts,
      },
    });
    await tx.estimate.update({ where: { id: existing.id }, data: { status: 'ACCEPTED' } });
    return created;
  });
  await audit(req, 'CONVERT', 'Estimate', existing.id, { invoiceId: invoice.id });
  await activity(req.user.id, 'invoice', `${req.user.name} converted ${existing.reference} to invoice ${invoice.reference}`);
  res.status(201).json({ success: true, data: invoice, message: `Invoice ${invoice.reference} created` });
}));

// DELETE /api/estimates/:id
router.delete('/:id', protect, adminOnly, asyncHandler(async (req, res) => {
  const existing = await prisma.estimate.findFirst({ where: tenantWhere(req, { id: req.params.id }) });
  if (!existing) throw notFound('Estimate not found');
  await prisma.estimate.delete({ where: { id: existing.id } });
  await audit(req, 'DELETE', 'Estimate', existing.id);
  res.json({ success: true, message: 'Estimate deleted' });
}));

module.exports = router;
module.exports.parseLines = parseLines;
