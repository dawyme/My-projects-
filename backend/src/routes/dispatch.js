const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect, adminOnly } = require('../middleware/auth');
const { paginationSchema, meta } = require('../lib/pagination');
const { tenantWhere } = require('../lib/tenant');
const { badRequest, notFound } = require('../lib/errors');
const { audit } = require('../lib/audit');

const router = express.Router();

const JOB_STATUSES = ['NEW', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];

/** Resolves the tenant-owned booking a job status row attaches to. */
async function resolveBooking(req, bookingId) {
  const booking = await prisma.booking.findFirst({ where: tenantWhere(req, { id: bookingId }) });
  if (!booking) throw badRequest('Booking not found');
  return booking;
}

// GET /api/dispatch — job board for bookings
router.get('/', protect, validate(paginationSchema.extend({
  search: z.string().optional(),
  status: z.string().optional(),
}), 'query'), asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const where = tenantWhere(req);
  if (q.search) where.bookingId = { contains: q.search };
  if (q.status) where.status = { in: q.status.split(',').map((s) => s.trim().toUpperCase()).filter((s) => JOB_STATUSES.includes(s)) };
  const [items, total] = await Promise.all([
    prisma.jobStatus.findMany({
      where, skip: (q.page - 1) * q.limit, take: q.limit,
      orderBy: { updatedAt: 'desc' },
      include: { booking: { select: { reference: true, scheduledAt: true, status: true } } },
    }),
    prisma.jobStatus.count({ where }),
  ]);
  res.json({ success: true, data: items, meta: meta(total, q.page, q.limit) });
}));

router.post('/', protect, adminOnly, validate(z.object({
  bookingId: z.string().uuid(),
  status: z.enum(JOB_STATUSES).default('NEW'),
  technicianId: z.string().uuid().nullable().optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
})), asyncHandler(async (req, res) => {
  const booking = await resolveBooking(req, req.body.bookingId);
  const existing = await prisma.jobStatus.findFirst({ where: tenantWhere(req, { bookingId: booking.id }) });
  if (existing) throw badRequest('This booking already has a job record');
  const job = await prisma.jobStatus.create({
    data: {
      businessId: req.tenantId,
      bookingId: booking.id,
      status: req.body.status,
      technicianId: req.body.technicianId || null,
      priority: req.body.priority,
    },
  });
  await audit(req, 'CREATE', 'JobStatus', job.id, { bookingId: booking.id });
  res.status(201).json({ success: true, data: job });
}));

router.put('/:id', protect, adminOnly, validate(z.object({
  status: z.enum(JOB_STATUSES).optional(),
  technicianId: z.string().uuid().nullable().optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(),
})), asyncHandler(async (req, res) => {
  const job = await prisma.jobStatus.findFirst({ where: tenantWhere(req, { id: req.params.id }) });
  if (!job) throw notFound('Job not found');
  const updated = await prisma.jobStatus.update({ where: { id: job.id }, data: req.body });
  await audit(req, 'UPDATE', 'JobStatus', job.id, req.body);
  res.json({ success: true, data: updated });
}));

router.delete('/:id', protect, adminOnly, asyncHandler(async (req, res) => {
  const job = await prisma.jobStatus.findFirst({ where: tenantWhere(req, { id: req.params.id }) });
  if (!job) throw notFound('Job not found');
  await prisma.jobStatus.delete({ where: { id: job.id } });
  await audit(req, 'DELETE', 'JobStatus', job.id);
  res.json({ success: true });
}));

module.exports = router;
