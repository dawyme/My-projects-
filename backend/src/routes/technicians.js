const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect, adminOnly } = require('../middleware/auth');
const { paginationSchema, meta } = require('../lib/pagination');
const { tenantWhere } = require('../lib/tenant');
const { badRequest, notFound } = require('../lib/errors');
const { audit, activity } = require('../lib/audit');

const router = express.Router();
const STATUSES = ['ACTIVE', 'ON_LEAVE', 'INACTIVE', 'TERMINATED'];

const body = z.object({
  employeeId: z.string().trim().min(2).max(40),
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().max(40).optional().nullable(),
  email: z.string().trim().email().max(180).optional().nullable(),
  profilePhoto: z.string().trim().max(400).optional().nullable(),
  skills: z.string().trim().max(1000).optional().nullable(),
  certifications: z.string().trim().max(1000).optional().nullable(),
  serviceAreas: z.string().trim().max(500).optional().nullable(),
  employmentStatus: z.enum(STATUSES).default('ACTIVE'),
  availability: z.string().trim().max(500).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
});

// GET /api/technicians — field technician roster
router.get('/', protect, validate(paginationSchema.extend({ search: z.string().optional(), status: z.string().optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const q = req.validatedQuery;
    const where = tenantWhere(req);
    if (q.search) {
      where.OR = [
        { name: { contains: q.search } }, { employeeId: { contains: q.search } },
        { email: { contains: q.search } }, { skills: { contains: q.search } },
      ];
    }
    if (q.status) where.employmentStatus = q.status.toUpperCase();
    const [items, total] = await Promise.all([
      prisma.technician.findMany({
        where, skip: (q.page - 1) * q.limit, take: q.limit, orderBy: { name: 'asc' },
      }),
      prisma.technician.count({ where }),
    ]);
    res.json({ success: true, data: items, meta: meta(total, q.page, q.limit) });
  }));

router.post('/', protect, adminOnly, validate(body), asyncHandler(async (req, res) => {
  const duplicate = await prisma.technician.findFirst({ where: tenantWhere(req, { employeeId: req.body.employeeId }) });
  if (duplicate) throw badRequest('A technician with that employee ID already exists in this business');
  const technician = await prisma.technician.create({ data: { ...req.body, businessId: req.tenantId } });
  await audit(req, 'CREATE', 'Technician', technician.id, { employeeId: technician.employeeId });
  await activity(req.user.id, 'technician', `${req.user.name} added technician ${technician.name}`);
  res.status(201).json({ success: true, data: technician });
}));

router.put('/:id', protect, adminOnly, validate(body.partial()), asyncHandler(async (req, res) => {
  const existing = await prisma.technician.findFirst({ where: tenantWhere(req, { id: req.params.id }) });
  if (!existing) throw notFound('Technician not found');
  if (req.body.employeeId && req.body.employeeId !== existing.employeeId) {
    const duplicate = await prisma.technician.findFirst({ where: tenantWhere(req, { employeeId: req.body.employeeId, NOT: { id: existing.id } }) });
    if (duplicate) throw badRequest('A technician with that employee ID already exists in this business');
  }
  const technician = await prisma.technician.update({ where: { id: existing.id }, data: req.body });
  await audit(req, 'UPDATE', 'Technician', technician.id, req.body);
  res.json({ success: true, data: technician });
}));

router.delete('/:id', protect, adminOnly, asyncHandler(async (req, res) => {
  const existing = await prisma.technician.findFirst({ where: tenantWhere(req, { id: req.params.id }) });
  if (!existing) throw notFound('Technician not found');
  await prisma.technician.delete({ where: { id: existing.id } });
  await audit(req, 'DELETE', 'Technician', existing.id);
  res.json({ success: true, message: 'Technician deleted' });
}));

module.exports = router;
