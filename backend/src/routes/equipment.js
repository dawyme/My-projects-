const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect, adminOnly } = require('../middleware/auth');
const { paginationSchema, buildOrderBy, meta } = require('../lib/pagination');
const { tenantWhere } = require('../lib/tenant');
const { badRequest, notFound } = require('../lib/errors');
const { audit, activity } = require('../lib/audit');

const router = express.Router();
const SORTABLE = ['createdAt', 'type', 'brand', 'warrantyExp'];

const dateOrUndef = z.union([z.coerce.date(), z.literal(''), z.null()]).transform((v) => (v === '' ? null : v)).optional();

const body = z.object({
  customerId: z.string().uuid('A valid customer is required'),
  type: z.string().trim().min(2).max(120),
  brand: z.string().trim().max(80).optional().nullable(),
  model: z.string().trim().max(80).optional().nullable(),
  serialNumber: z.string().trim().max(80).optional().nullable(),
  installDate: dateOrUndef,
  warrantyExp: dateOrUndef,
  refrigerant: z.string().trim().max(40).optional().nullable(),
  voltage: z.string().trim().max(40).optional().nullable(),
  filterSize: z.string().trim().max(40).optional().nullable(),
  location: z.string().trim().max(160).optional().nullable(),
  photos: z.string().trim().max(4000).optional().nullable(),
  manuals: z.string().trim().max(4000).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
});

const listQuery = paginationSchema.extend({
  customerId: z.string().optional(),
  search: z.string().optional(),
  format: z.enum(['json', 'csv']).default('json'),
});

// GET /api/equipment — installed equipment registry
router.get('/', protect, validate(listQuery, 'query'), asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const where = tenantWhere(req);
  if (q.customerId) where.customerId = q.customerId;
  if (q.search) {
    where.OR = [
      { type: { contains: q.search } }, { brand: { contains: q.search } },
      { model: { contains: q.search } }, { serialNumber: { contains: q.search } },
      { location: { contains: q.search } },
      { customer: { name: { contains: q.search } } },
    ];
  }
  const orderBy = buildOrderBy(q.sort, q.order, SORTABLE, 'createdAt');

  if (q.format === 'csv') {
    const rows = await prisma.equipment.findMany({ where, orderBy, include: { customer: { select: { name: true } } } });
    return res.json({ success: true, data: rows });
  }

  const [items, total] = await Promise.all([
    prisma.equipment.findMany({
      where, orderBy, skip: (q.page - 1) * q.limit, take: q.limit,
      include: { customer: { select: { id: true, name: true, email: true, phone: true } } },
    }),
    prisma.equipment.count({ where }),
  ]);
  res.json({ success: true, data: items, meta: meta(total, q.page, q.limit) });
}));

// GET /api/equipment/:id — equipment with its full service history
router.get('/:id', protect, asyncHandler(async (req, res) => {
  const equipment = await prisma.equipment.findFirst({
    where: tenantWhere(req, { id: req.params.id }),
    include: {
      customer: { select: { id: true, name: true, email: true, phone: true, address: true } },
      serviceHistory: { orderBy: { serviceDate: 'desc' }, include: { technician: { select: { id: true, name: true } } } },
    },
  });
  if (!equipment) throw notFound('Equipment not found');
  res.json({ success: true, data: equipment });
}));

/** Validates that the referenced customer belongs to the tenant. */
async function resolveCustomer(req, customerId) {
  const customer = await prisma.customer.findFirst({ where: tenantWhere(req, { id: customerId }), select: { id: true } });
  if (!customer) throw badRequest('Customer not found');
}

// POST /api/equipment
router.post('/', protect, validate(body), asyncHandler(async (req, res) => {
  await resolveCustomer(req, req.body.customerId);
  const equipment = await prisma.equipment.create({ data: { ...req.body, businessId: req.tenantId } });
  await audit(req, 'CREATE', 'Equipment', equipment.id, { type: equipment.type });
  await activity(req.user.id, 'equipment', `${req.user.name} registered equipment (${equipment.type})`);
  res.status(201).json({ success: true, data: equipment });
}));

// PUT /api/equipment/:id
router.put('/:id', protect, validate(body.partial()), asyncHandler(async (req, res) => {
  const existing = await prisma.equipment.findFirst({ where: tenantWhere(req, { id: req.params.id }) });
  if (!existing) throw notFound('Equipment not found');
  if (req.body.customerId) await resolveCustomer(req, req.body.customerId);
  const equipment = await prisma.equipment.update({ where: { id: existing.id }, data: req.body });
  await audit(req, 'UPDATE', 'Equipment', equipment.id, req.body);
  res.json({ success: true, data: equipment });
}));

// DELETE /api/equipment/:id
router.delete('/:id', protect, adminOnly, asyncHandler(async (req, res) => {
  const existing = await prisma.equipment.findFirst({ where: tenantWhere(req, { id: req.params.id }) });
  if (!existing) throw notFound('Equipment not found');
  await prisma.equipment.delete({ where: { id: existing.id } });
  await audit(req, 'DELETE', 'Equipment', existing.id);
  res.json({ success: true, message: 'Equipment deleted' });
}));

// POST /api/equipment/:id/service-history — record a service visit
const historyBody = z.object({
  serviceDate: z.coerce.date().default(() => new Date()),
  description: z.string().trim().min(2).max(2000),
  technicianId: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(2000).optional().nullable(),
});
router.post('/:id/service-history', protect, validate(historyBody), asyncHandler(async (req, res) => {
  const equipment = await prisma.equipment.findFirst({ where: tenantWhere(req, { id: req.params.id }) });
  if (!equipment) throw notFound('Equipment not found');
  const record = await prisma.serviceHistory.create({
    data: {
      businessId: req.tenantId,
      equipmentId: equipment.id,
      serviceDate: req.body.serviceDate,
      description: req.body.description,
      technicianId: req.body.technicianId || null,
      notes: req.body.notes || null,
    },
    include: { technician: { select: { id: true, name: true } } },
  });
  await audit(req, 'CREATE', 'ServiceHistory', record.id, { equipmentId: equipment.id });
  res.status(201).json({ success: true, data: record });
}));

module.exports = router;
