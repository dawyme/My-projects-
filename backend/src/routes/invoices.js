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
const cache = require('../lib/cache');

const router = express.Router();

const STATUSES = ['PENDING', 'PARTIAL', 'PAID', 'OVERDUE', 'CANCELLED'];
const SORTABLE = ['createdAt', 'updatedAt', 'reference', 'total', 'status', 'dueDate'];

const reference = () => `INV-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

const line = z.object({
  description: z.string().trim().min(1).max(300),
  quantity: z.coerce.number().min(0).default(1),
  unitPrice: z.coerce.number().min(0).default(0),
  amount: z.coerce.number().min(0).optional(),
});

const body = z.object({
  customerId: z.string().uuid('A valid customer is required'),
  status: z.enum(STATUSES).default('PENDING'),
  labour: z.array(line).max(100).optional().nullable(),
  parts: z.array(line).max(200).optional().nullable(),
  taxRate: z.coerce.number().min(0).max(100).default(0),
  discount: z.coerce.number().min(0).default(0),
  dueDate: z.union([z.coerce.date(), z.literal(''), z.null()]).transform((v) => (v === '' ? null : v)).optional(),
  notes: z.string().trim().max(4000).optional().nullable(),
});

const lineTotal = (l) => round(l.amount !== undefined && l.amount !== null ? l.amount : (l.quantity || 0) * (l.unitPrice || 0));

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

// GET /api/invoices
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
  const orderBy = SORTABLE.includes(q.sort) ? { [q.sort]: q.order } : { createdAt: q.order };

  if (q.format === 'csv') {
    const rows = await prisma.invoice.findMany({ where, orderBy, include: { customer: { select: { name: true, email: true } } } });
    res.header('Content-Type', 'text/csv');
    res.attachment('invoices.csv');
    return res.send(toCsv(rows, [
      { label: 'Reference', value: 'reference' },
      { label: 'Customer', value: (r) => r.customer?.name },
      { label: 'Status', value: 'status' }, { label: 'Subtotal', value: 'subtotal' },
      { label: 'Tax', value: 'tax' }, { label: 'Total', value: 'total' },
      { label: 'Due', value: 'dueDate' }, { label: 'Paid At', value: 'paidAt' },
      { label: 'Created', value: 'createdAt' },
    ]));
  }

  const [items, total, agg] = await Promise.all([
    prisma.invoice.findMany({
      where, orderBy, skip: (q.page - 1) * q.limit, take: q.limit,
      include: { customer: { select: { id: true, name: true, email: true, phone: true } } },
    }),
    prisma.invoice.count({ where }),
    prisma.invoice.groupBy({ by: ['status'], _sum: { total: true }, _count: { _all: true }, where }),
  ]);
  const summary = Object.fromEntries(STATUSES.map((s) => [s, {
    count: agg.find((a) => a.status === s)?._count._all || 0,
    total: round(agg.find((a) => a.status === s)?._sum.total || 0),
  }]));
  res.json({ success: true, data: items.map(decorate), meta: { ...meta(total, q.page, q.limit), summary } });
}));

// GET /api/invoices/:id
router.get('/:id', protect, asyncHandler(async (req, res) => {
  const invoice = await prisma.invoice.findFirst({
    where: tenantWhere(req, { id: req.params.id }),
    include: { customer: { select: { id: true, name: true, email: true, phone: true, address: true } } },
  });
  if (!invoice) throw notFound('Invoice not found');
  res.json({ success: true, data: decorate(invoice) });
}));

// POST /api/invoices
router.post('/', protect, validate(body), asyncHandler(async (req, res) => {
  await resolveCustomer(req, req.body.customerId);
  const invoice = await prisma.invoice.create({
    data: { ...withTotals(req.body), reference: reference(), businessId: req.tenantId },
    include: { customer: { select: { id: true, name: true, email: true } } },
  });
  await audit(req, 'CREATE', 'Invoice', invoice.id, { reference: invoice.reference, total: invoice.total });
  await activity(req.user.id, 'invoice', `${req.user.name} created invoice ${invoice.reference}`);
  res.status(201).json({ success: true, data: decorate(invoice) });
}));

// PUT /api/invoices/:id
router.put('/:id', protect, validate(body.partial()), asyncHandler(async (req, res) => {
  const existing = await prisma.invoice.findFirst({ where: tenantWhere(req, { id: req.params.id }) });
  if (!existing) throw notFound('Invoice not found');
  if (req.body.customerId) await resolveCustomer(req, req.body.customerId);
  const data = withTotals(req.body, existing);
  if (data.status === 'PAID' && existing.status !== 'PAID') data.paidAt = existing.paidAt || new Date();
  if (data.status && data.status !== 'PAID') data.paidAt = null;
  const invoice = await prisma.invoice.update({ where: { id: existing.id }, data });
  await audit(req, 'UPDATE', 'Invoice', invoice.id, req.body);
  res.json({ success: true, data: decorate(invoice) });
}));

// POST /api/invoices/:id/mark-paid — record a payment against the invoice
router.post('/:id/mark-paid', protect, asyncHandler(async (req, res) => {
  const existing = await prisma.invoice.findFirst({ where: tenantWhere(req, { id: req.params.id }) });
  if (!existing) throw notFound('Invoice not found');
  if (existing.status === 'CANCELLED') throw badRequest('A cancelled invoice cannot be marked as paid');
  if (existing.status === 'PAID') return res.json({ success: true, data: decorate(existing), message: 'Invoice was already paid' });
  const invoice = await prisma.invoice.update({ where: { id: existing.id }, data: { status: 'PAID', paidAt: new Date() } });
  cache.invalidate('stats');
  await audit(req, 'PAYMENT', 'Invoice', invoice.id, { total: invoice.total });
  await activity(req.user.id, 'invoice', `${req.user.name} recorded payment for ${invoice.reference}`);
  res.json({ success: true, data: decorate(invoice), message: `Invoice ${invoice.reference} marked as paid` });
}));

// DELETE /api/invoices/:id
router.delete('/:id', protect, adminOnly, asyncHandler(async (req, res) => {
  const existing = await prisma.invoice.findFirst({ where: tenantWhere(req, { id: req.params.id }) });
  if (!existing) throw notFound('Invoice not found');
  if (existing.status === 'PAID') throw badRequest('Paid invoices are financial records and cannot be deleted — cancel it instead');
  await prisma.invoice.delete({ where: { id: existing.id } });
  await audit(req, 'DELETE', 'Invoice', existing.id);
  res.json({ success: true, message: 'Invoice deleted' });
}));

module.exports = router;
