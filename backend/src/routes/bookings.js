const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect, adminOnly } = require('../middleware/auth');
const { paginationSchema, buildOrderBy, meta, toCsv } = require('../lib/pagination');
const { badRequest, notFound } = require('../lib/errors');
const { audit, activity } = require('../lib/audit');
const { sendBookingStatusEmail } = require('../lib/mailer');
const cache = require('../lib/cache');

const router = express.Router();
const STATUSES = ['PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
const SORTABLE = ['scheduledAt', 'createdAt', 'status', 'price'];

const reference = () => `BK-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

const createBody = z.object({
  customerId: z.string().uuid().optional(),
  customer: z.object({
    name: z.string().trim().min(2).max(120),
    email: z.string().email().max(180),
    phone: z.string().trim().max(40).optional().nullable(),
    address: z.string().trim().max(300).optional().nullable(),
  }).optional(),
  serviceId: z.string().uuid().optional().nullable(),
  technicianId: z.string().uuid().optional().nullable(),
  scheduledAt: z.coerce.date(),
  status: z.enum(STATUSES).default('PENDING'),
  priority: z.enum(PRIORITIES).default('NORMAL'),
  address: z.string().trim().max(300).optional().nullable(),
  description: z.string().trim().max(2000).optional().nullable(),
  price: z.coerce.number().min(0).default(0),
}).refine((d) => d.customerId || d.customer, { message: 'customerId or customer details are required' });

const include = {
  customer: true,
  service: { select: { id: true, name: true, basePrice: true } },
  technician: { select: { id: true, name: true, email: true } },
  notes: { orderBy: { createdAt: 'desc' }, include: { user: { select: { name: true } } } },
};

async function resolveCustomer(input) {
  if (input.customerId) {
    const c = await prisma.customer.findUnique({ where: { id: input.customerId } });
    if (!c) throw badRequest('Customer not found');
    return c;
  }
  const email = input.customer.email.toLowerCase();
  const existing = await prisma.customer.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.customer.create({ data: { ...input.customer, email } });
}

const listQuery = paginationSchema.extend({
  status: z.string().optional(),
  technicianId: z.string().optional(),
  customerId: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  format: z.enum(['json', 'csv']).default('json'),
});

// GET /api/bookings
router.get('/', protect, validate(listQuery, 'query'), asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const where = {};
  if (q.status) where.status = { in: q.status.split(',').map((s) => s.trim().toUpperCase()).filter((s) => STATUSES.includes(s)) };
  if (q.technicianId) where.technicianId = q.technicianId === 'unassigned' ? null : q.technicianId;
  if (q.customerId) where.customerId = q.customerId;
  if (q.from || q.to) {
    where.scheduledAt = {};
    if (q.from) where.scheduledAt.gte = q.from;
    if (q.to) where.scheduledAt.lte = q.to;
  }
  if (q.search) {
    where.OR = [
      { reference: { contains: q.search } },
      { description: { contains: q.search } },
      { address: { contains: q.search } },
      { customer: { name: { contains: q.search } } },
      { customer: { email: { contains: q.search } } },
    ];
  }
  const orderBy = buildOrderBy(q.sort, q.order, SORTABLE, 'scheduledAt');

  if (q.format === 'csv') {
    const rows = await prisma.booking.findMany({ where, orderBy, include });
    res.header('Content-Type', 'text/csv');
    res.attachment('bookings.csv');
    return res.send(toCsv(rows, [
      { label: 'Reference', value: 'reference' },
      { label: 'Customer', value: (r) => r.customer?.name },
      { label: 'Email', value: (r) => r.customer?.email },
      { label: 'Service', value: (r) => r.service?.name },
      { label: 'Technician', value: (r) => r.technician?.name || 'Unassigned' },
      { label: 'Scheduled', value: 'scheduledAt' },
      { label: 'Status', value: 'status' }, { label: 'Priority', value: 'priority' },
      { label: 'Price', value: 'price' },
    ]));
  }

  const [items, total] = await Promise.all([
    prisma.booking.findMany({
      where, orderBy, skip: (q.page - 1) * q.limit, take: q.limit,
      include: { ...include, notes: false, _count: { select: { notes: true } } },
    }),
    prisma.booking.count({ where }),
  ]);
  res.json({ success: true, data: items, meta: meta(total, q.page, q.limit) });
}));

// GET /api/bookings/calendar?month=YYYY-MM
router.get('/calendar', protect, asyncHandler(async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : new Date().toISOString().slice(0, 7);
  const start = new Date(`${month}-01T00:00:00.000Z`);
  const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1);
  const allowedStatuses = new Set(STATUSES);
  const status = String(req.query.status || '').toUpperCase();
  const where = { scheduledAt: { gte: start, lt: end } };
  if (req.query.technicianId) where.technicianId = req.query.technicianId === 'unassigned' ? null : req.query.technicianId;
  if (allowedStatuses.has(status)) where.status = status;
  const bookings = await prisma.booking.findMany({
    where,
    orderBy: { scheduledAt: 'asc' },
    include: { customer: { select: { name: true } }, service: { select: { name: true } }, technician: { select: { name: true } } },
  });
  const days = {};
  for (const b of bookings) {
    const key = b.scheduledAt.toISOString().slice(0, 10);
    (days[key] = days[key] || []).push({
      id: b.id, reference: b.reference, status: b.status, priority: b.priority,
      time: b.scheduledAt.toISOString().slice(11, 16),
      customer: b.customer?.name, service: b.service?.name, technician: b.technician?.name || null,
    });
  }
  res.json({ success: true, data: { month, days, total: bookings.length } });
}));

// GET /api/bookings/:id
router.get('/:id', protect, asyncHandler(async (req, res) => {
  const booking = await prisma.booking.findUnique({ where: { id: req.params.id }, include });
  if (!booking) throw notFound('Booking not found');
  const history = await prisma.booking.findMany({
    where: { customerId: booking.customerId, NOT: { id: booking.id } },
    orderBy: { scheduledAt: 'desc' }, take: 10,
    select: { id: true, reference: true, status: true, scheduledAt: true, price: true },
  });
  res.json({ success: true, data: { ...booking, customerHistory: history } });
}));

// POST /api/bookings
router.post('/', protect, validate(createBody), asyncHandler(async (req, res) => {
  const customer = await resolveCustomer(req.body);
  const booking = await prisma.booking.create({
    data: {
      reference: reference(),
      customerId: customer.id,
      serviceId: req.body.serviceId || null,
      technicianId: req.body.technicianId || null,
      scheduledAt: req.body.scheduledAt,
      status: req.body.status,
      priority: req.body.priority,
      address: req.body.address || customer.address || null,
      description: req.body.description || null,
      price: req.body.price,
    },
    include,
  });
  cache.invalidate('stats');
  await audit(req, 'CREATE', 'Booking', booking.id, { reference: booking.reference });
  await activity(req.user.id, 'booking', `${req.user.name} created booking ${booking.reference}`);
  sendBookingStatusEmail(booking, customer).catch(() => {});
  res.status(201).json({ success: true, data: booking });
}));

// PUT /api/bookings/:id
const updateBody = z.object({
  serviceId: z.string().uuid().nullable().optional(),
  technicianId: z.string().uuid().nullable().optional(),
  scheduledAt: z.coerce.date().optional(),
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  address: z.string().trim().max(300).nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  price: z.coerce.number().min(0).optional(),
  notify: z.coerce.boolean().default(true),
});
router.put('/:id', protect, validate(updateBody), asyncHandler(async (req, res) => {
  const existing = await prisma.booking.findUnique({ where: { id: req.params.id }, include: { customer: true } });
  if (!existing) throw notFound('Booking not found');
  const { notify, ...data } = req.body;
  if (data.status === 'COMPLETED' && existing.status !== 'COMPLETED') data.completedAt = new Date();
  if (data.status && data.status !== 'COMPLETED') data.completedAt = null;

  const booking = await prisma.booking.update({ where: { id: existing.id }, data, include });
  cache.invalidate('stats');
  await audit(req, 'UPDATE', 'Booking', booking.id, data);
  if (data.status && data.status !== existing.status) {
    await activity(req.user.id, 'booking', `${req.user.name} set ${booking.reference} to ${data.status.replace('_', ' ')}`);
    if (notify) sendBookingStatusEmail(booking, booking.customer).catch(() => {});
  }
  res.json({ success: true, data: booking });
}));

// PATCH /api/bookings/:id/status
router.patch('/:id/status', protect,
  validate(z.object({ status: z.enum(STATUSES), notify: z.coerce.boolean().default(true) })),
  asyncHandler(async (req, res) => {
    const existing = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Booking not found');
    const booking = await prisma.booking.update({
      where: { id: existing.id },
      data: {
        status: req.body.status,
        completedAt: req.body.status === 'COMPLETED' ? new Date() : null,
      },
      include,
    });
    cache.invalidate('stats');
    await audit(req, 'STATUS_CHANGE', 'Booking', booking.id, { from: existing.status, to: booking.status });
    await activity(req.user.id, 'booking', `${req.user.name} set ${booking.reference} to ${booking.status.replace('_', ' ')}`);
    if (req.body.notify) sendBookingStatusEmail(booking, booking.customer).catch(() => {});
    res.json({ success: true, data: booking });
  }));

// PATCH /api/bookings/:id/assign
router.patch('/:id/assign', protect,
  validate(z.object({ technicianId: z.string().uuid().nullable() })),
  asyncHandler(async (req, res) => {
    if (req.body.technicianId) {
      const tech = await prisma.user.findUnique({ where: { id: req.body.technicianId } });
      if (!tech || !tech.isActive) throw badRequest('Technician not found or inactive');
    }
    const booking = await prisma.booking.update({
      where: { id: req.params.id }, data: { technicianId: req.body.technicianId }, include,
    });
    await audit(req, 'ASSIGN', 'Booking', booking.id, { technicianId: req.body.technicianId });
    await activity(req.user.id, 'booking',
      `${req.user.name} ${booking.technician ? `assigned ${booking.technician.name} to` : 'unassigned'} ${booking.reference}`);
    res.json({ success: true, data: booking });
  }));

// POST /api/bookings/:id/notes
router.post('/:id/notes', protect,
  validate(z.object({ body: z.string().trim().min(1).max(2000) })),
  asyncHandler(async (req, res) => {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) throw notFound('Booking not found');
    const note = await prisma.bookingNote.create({
      data: { bookingId: booking.id, userId: req.user.id, body: req.body.body },
      include: { user: { select: { name: true } } },
    });
    await audit(req, 'NOTE', 'Booking', booking.id);
    res.status(201).json({ success: true, data: note });
  }));

// DELETE /api/bookings/:id/notes/:noteId
router.delete('/:id/notes/:noteId', protect, asyncHandler(async (req, res) => {
  await prisma.bookingNote.delete({ where: { id: req.params.noteId } });
  await audit(req, 'NOTE_DELETE', 'Booking', req.params.id);
  res.json({ success: true, message: 'Note deleted' });
}));

// DELETE /api/bookings/:id
router.delete('/:id', protect, adminOnly, asyncHandler(async (req, res) => {
  await prisma.booking.delete({ where: { id: req.params.id } });
  cache.invalidate('stats');
  await audit(req, 'DELETE', 'Booking', req.params.id);
  res.json({ success: true, message: 'Booking deleted' });
}));

module.exports = router;
