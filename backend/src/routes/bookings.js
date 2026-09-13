const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect, adminOnly } = require('../middleware/auth');
const { requireFeature } = require('../lib/features');
const { paginationSchema, buildOrderBy, meta, toCsv } = require('../lib/pagination');
const { badRequest, notFound } = require('../lib/errors');
const { audit, activity } = require('../lib/audit');
const { sendBookingStatusEmail } = require('../lib/mailer');
const { tenantWhere } = require('../lib/tenant');
const {
  effectiveDurationMin,
  occupiedWindow,
  loadSchedulingContext,
  checkTechnicianConflicts,
  checkTimeOffConflicts,
  checkWorkingHours,
  checkBreaks,
  checkClosedDays,
  checkLeadTimeWindow,
  applyPolicy,
  validateAppointmentTimes,
  dateKey,
} = require('../lib/scheduling-rules');
const { emit } = require('../lib/scheduling-events');
const cache = require('../lib/cache');

const router = express.Router();
const STATUSES = ['PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
const SORTABLE = ['scheduledAt', 'createdAt', 'status', 'price'];
const VIEWS = ['day', '3day', 'week', 'month', 'agenda'];

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
  durationMin: z.coerce.number().int().min(5).max(1440).optional().nullable(),
  bufferMin: z.coerce.number().int().min(0).max(480).optional().nullable(),
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

/** Resolves or creates the booking customer strictly inside the tenant. */
async function resolveCustomer(req, input) {
  if (input.customerId) {
    const c = await prisma.customer.findFirst({ where: tenantWhere(req, { id: input.customerId }) });
    if (!c) throw badRequest('Customer not found');
    return c;
  }
  const email = input.customer.email.toLowerCase();
  const existing = await prisma.customer.findFirst({ where: tenantWhere(req, { email }) });
  if (existing) return existing;
  return prisma.customer.create({ data: { ...input.customer, email, businessId: req.tenantId } });
}

/** Validates that a referenced service belongs to the tenant. */
async function resolveService(req, serviceId) {
  if (!serviceId) return null;
  const service = await prisma.service.findFirst({ where: tenantWhere(req, { id: serviceId }) });
  if (!service) throw badRequest('Service not found');
  return service;
}

/** Validates that a technician user belongs to the tenant and is active. */
async function resolveTechnician(req, technicianId) {
  if (!technicianId) return null;
  const tech = await prisma.user.findFirst({
    where: { id: technicianId, isActive: true, OR: [{ businessId: req.tenantId }, { businessId: null }] },
  });
  if (!tech) throw badRequest('Technician not found or inactive');
  return tech;
}

/**
 * Server-side availability check for one candidate slot. Returns
 * { conflicts, warnings, blocked } according to the tenant scheduling policy.
 * `blocked` is true when the tenant policy says the request must be rejected.
 */
async function checkBookingConflicts(req, { ignoreBookingId, technicianId, serviceId, scheduledAt, durationMin = null, bufferMin = null }) {
  const service = serviceId
    ? await prisma.service.findFirst({ where: tenantWhere(req, { id: serviceId }), select: { durationMin: true } })
    : null;
  const duration = effectiveDurationMin({ durationMin }, service);
  const buffer = Number(bufferMin) || 0;
  const start = new Date(scheduledAt);
  const { start: occStart, end: occEnd } = occupiedWindow(start, duration, buffer);
  const ctx = await loadSchedulingContext({
    businessId: req.tenantId,
    technicianId: technicianId || undefined,
    from: start,
    to: occEnd,
  });
  const conflicts = [
    ...checkTechnicianConflicts({ start: occStart, end: occEnd, technicianId, ignoreBookingId, bookings: ctx.bookings }),
    ...checkTimeOffConflicts({ start: occStart, end: occEnd, technicianId, timeOffs: ctx.timeOffs }),
    ...checkLeadTimeWindow(start, new Date(), ctx.policy),
  ];
  const warnings = [
    ...checkWorkingHours(occStart, occEnd, ctx.hoursByDay),
    ...checkBreaks(occStart, occEnd, ctx.breaksByDay),
    ...checkClosedDays(occStart, occEnd, ctx.closedDays),
  ];
  return applyPolicy({ conflicts, warnings, policy: ctx.policy });
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
  const where = tenantWhere(req);
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
      { label: 'Phone', value: (r) => r.customer?.phone },
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

// ---------------------------------------------------------------------------
// Calendar — view=day|3day|week|month|agenda (default month).
// Backward compatible: `?month=YYYY-MM` (no view) keeps the original shape.
// GET /api/bookings/calendar?view=&date=YYYY-MM-DD&month=&technicianId=&status=&serviceId=&customerId=&search=
// ---------------------------------------------------------------------------
router.get('/calendar', protect, requireFeature('calendar'), asyncHandler(async (req, res) => {
  const view = VIEWS.includes(req.query.view) ? req.query.view : 'month';
  const anchorDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : new Date().toISOString().slice(0, 10);
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : anchorDate.slice(0, 7);
  const dayMs = 864e5;
  let start;
  let end;
  if (view === 'month') {
    start = new Date(`${month}-01T00:00:00.000Z`);
    end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1);
  } else if (view === 'day') {
    start = new Date(`${anchorDate}T00:00:00.000Z`);
    end = new Date(start.getTime() + dayMs);
  } else if (view === '3day') {
    start = new Date(`${anchorDate}T00:00:00.000Z`);
    end = new Date(start.getTime() + 3 * dayMs);
  } else if (view === 'week') {
    start = new Date(`${anchorDate}T00:00:00.000Z`);
    const dow = (start.getUTCDay() + 6) % 7; // Monday-first
    start.setUTCDate(start.getUTCDate() - dow);
    end = new Date(start.getTime() + 7 * dayMs);
  } else {
    start = new Date(`${anchorDate}T00:00:00.000Z`);
    end = new Date(start.getTime() + 14 * dayMs);
  }

  const where = { ...tenantWhere(req), scheduledAt: { gte: start, lt: end } };
  if (req.query.technicianId) where.technicianId = req.query.technicianId === 'unassigned' ? null : String(req.query.technicianId);
  if (req.query.status) {
    const statuses = String(req.query.status).split(',').map((s) => s.trim().toUpperCase()).filter((s) => STATUSES.includes(s));
    if (statuses.length) where.status = { in: statuses };
  }
  if (req.query.serviceId) where.serviceId = String(req.query.serviceId);
  if (req.query.customerId) where.customerId = String(req.query.customerId);
  if (req.query.search) {
    where.OR = [
      { reference: { contains: req.query.search } },
      { description: { contains: req.query.search } },
      { address: { contains: req.query.search } },
      { customer: { name: { contains: req.query.search } } },
      { customer: { email: { contains: req.query.search } } },
    ];
  }

  const bookings = await prisma.booking.findMany({
    where,
    orderBy: { scheduledAt: 'asc' },
    include: {
      customer: { select: { id: true, name: true, phone: true } },
      service: { select: { id: true, name: true, durationMin: true } },
      technician: { select: { id: true, name: true } },
      workOrder: { select: { id: true, status: true } },
      recurringOccurrence: { select: { occurrenceNumber: true } },
    },
  });

  const events = bookings.map((b) => {
    const duration = effectiveDurationMin(b, b.service);
    const startAt = new Date(b.scheduledAt);
    const endAt = new Date(startAt.getTime() + duration * 60000);
    return {
      id: b.id,
      reference: b.reference,
      status: b.status,
      priority: b.priority,
      scheduledAt: b.scheduledAt.toISOString(),
      start: startAt.toISOString().slice(11, 16),
      end: endAt.toISOString().slice(11, 16),
      durationMin: duration,
      bufferMin: b.bufferMin || 0,
      customer: b.customer?.name,
      customerPhone: b.customer?.phone || null,
      customerId: b.customerId,
      service: b.service?.name,
      serviceId: b.serviceId,
      technician: b.technician?.name || null,
      technicianId: b.technicianId,
      workOrder: b.workOrder ? { id: b.workOrder.id, status: b.workOrder.status } : null,
      recurring: Boolean(b.recurringOccurrence),
    };
  });

  const days = {};
  for (const e of events) {
    const key = e.scheduledAt.slice(0, 10);
    (days[key] = days[key] || []).push(e);
  }
  res.json({
    success: true,
    data: {
      view,
      date: anchorDate,
      month,
      range: { start: start.toISOString(), end: end.toISOString() },
      days,
      items: view === 'agenda' ? events : undefined,
      total: bookings.length,
    },
  });
}));

// ---------------------------------------------------------------------------
// Pre-flight availability for one technician + slot (drives the UI conflict
// banner and is the building block for the online booking phase).
// GET /api/bookings/availability?technicianId=&date=&time=&durationMin=&serviceId=&bufferMin=&ignoreBookingId=
// ---------------------------------------------------------------------------
router.get('/availability', protect, requireFeature('calendar'), asyncHandler(async (req, res) => {
  const technicianId = String(req.query.technicianId || '');
  if (!technicianId) throw badRequest('technicianId is required');
  await resolveTechnician(req, technicianId);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : new Date().toISOString().slice(0, 10);
  const time = /^\d{1,2}:\d{2}$/.test(req.query.time || '') ? req.query.time : '09:00';
  const start = new Date(`${date}T${time.padStart(5, '0')}:00.000Z`);
  const serviceId = req.query.serviceId ? String(req.query.serviceId) : null;
  const service = await resolveService(req, serviceId);
  const durationMin = Number.isFinite(Number(req.query.durationMin)) && Number(req.query.durationMin) > 0
    ? Number(req.query.durationMin)
    : effectiveDurationMin({}, service);
  const bufferMin = Number.isFinite(Number(req.query.bufferMin)) ? Number(req.query.bufferMin) : 0;
  const ignoreBookingId = req.query.ignoreBookingId ? String(req.query.ignoreBookingId) : undefined;
  const result = await checkBookingConflicts(req, { ignoreBookingId, technicianId, serviceId, scheduledAt: start, durationMin, bufferMin });
  const end = new Date(start.getTime() + durationMin * 60000);
  res.json({
    success: true,
    data: {
      available: result.conflicts.length === 0,
      blocked: result.blocked,
      technicianId,
      start: start.toISOString(),
      end: end.toISOString(),
      durationMin,
      bufferMin,
      conflicts: result.conflicts,
      warnings: result.warnings,
    },
  });
}));

// GET /api/bookings/:id
router.get('/:id', protect, asyncHandler(async (req, res) => {
  const booking = await prisma.booking.findFirst({ where: tenantWhere(req, { id: req.params.id }), include });
  if (!booking) throw notFound('Booking not found');
  const history = await prisma.booking.findMany({
    where: { businessId: req.tenantId, customerId: booking.customerId, NOT: { id: booking.id } },
    orderBy: { scheduledAt: 'desc' }, take: 10,
    select: { id: true, reference: true, status: true, scheduledAt: true, price: true },
  });
  res.json({ success: true, data: { ...booking, customerHistory: history } });
}));

// POST /api/bookings
router.post('/', protect, validate(createBody), asyncHandler(async (req, res) => {
  const customer = await resolveCustomer(req, req.body);
  await resolveService(req, req.body.serviceId);
  await resolveTechnician(req, req.body.technicianId);
  try {
    validateAppointmentTimes({ scheduledAt: req.body.scheduledAt, durationMin: req.body.durationMin, bufferMin: req.body.bufferMin });
  } catch (e) { throw badRequest(e.message); }
  const result = await checkBookingConflicts(req, {
    technicianId: req.body.technicianId || null,
    serviceId: req.body.serviceId || null,
    scheduledAt: req.body.scheduledAt,
    durationMin: req.body.durationMin ?? null,
    bufferMin: req.body.bufferMin ?? null,
  });
  if (result.blocked) throw badRequest('This appointment conflicts with the existing schedule', { conflicts: result.conflicts, warnings: result.warnings });
  const booking = await prisma.booking.create({
    data: {
      reference: reference(),
      businessId: req.tenantId,
      customerId: customer.id,
      serviceId: req.body.serviceId || null,
      technicianId: req.body.technicianId || null,
      scheduledAt: req.body.scheduledAt,
      durationMin: req.body.durationMin ?? null,
      bufferMin: req.body.bufferMin ?? null,
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
  emit('booking.created', {
    bookingId: booking.id, reference: booking.reference, businessId: req.tenantId,
    actorId: req.user.id, actorName: req.user.name,
    details: { status: booking.status, scheduledAt: booking.scheduledAt, technicianId: booking.technicianId },
    warnings: result.warnings,
  });
  res.status(201).json({
    success: true,
    data: booking,
    ...(result.conflicts.length ? { conflicts: result.conflicts } : {}),
    ...(result.warnings.length ? { warnings: result.warnings } : {}),
  });
}));

// PUT /api/bookings/:id
const updateBody = z.object({
  serviceId: z.string().uuid().nullable().optional(),
  technicianId: z.string().uuid().nullable().optional(),
  scheduledAt: z.coerce.date().optional(),
  durationMin: z.coerce.number().int().min(5).max(1440).nullable().optional(),
  bufferMin: z.coerce.number().int().min(0).max(480).nullable().optional(),
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  address: z.string().trim().max(300).nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  price: z.coerce.number().min(0).optional(),
  notify: z.coerce.boolean().default(true),
});
router.put('/:id', protect, validate(updateBody), asyncHandler(async (req, res) => {
  const existing = await prisma.booking.findFirst({ where: tenantWhere(req, { id: req.params.id }), include: { customer: true } });
  if (!existing) throw notFound('Booking not found');
  const { notify, ...data } = req.body;
  if (data.serviceId !== undefined) await resolveService(req, data.serviceId);
  if (data.technicianId !== undefined) await resolveTechnician(req, data.technicianId);
  if (data.status === 'COMPLETED' && existing.status !== 'COMPLETED') data.completedAt = new Date();
  if (data.status && data.status !== 'COMPLETED') data.completedAt = null;

  const nextScheduledAt = data.scheduledAt !== undefined ? new Date(data.scheduledAt) : new Date(existing.scheduledAt);
  const nextTechnicianId = data.technicianId !== undefined ? (data.technicianId || null) : existing.technicianId;
  const nextServiceId = data.serviceId !== undefined ? (data.serviceId || null) : existing.serviceId;
  const nextDuration = data.durationMin !== undefined ? (data.durationMin ?? null) : existing.durationMin;
  const nextBuffer = data.bufferMin !== undefined ? (data.bufferMin ?? null) : existing.bufferMin;
  const scheduleChanged =
    nextScheduledAt.getTime() !== new Date(existing.scheduledAt).getTime()
    || nextTechnicianId !== existing.technicianId
    || nextServiceId !== existing.serviceId
    || nextDuration !== existing.durationMin
    || nextBuffer !== existing.bufferMin;
  let responseConflicts = [];
  let responseWarnings = [];
  if (scheduleChanged) {
    try {
      validateAppointmentTimes({ scheduledAt: nextScheduledAt, durationMin: nextDuration, bufferMin: nextBuffer });
    } catch (e) { throw badRequest(e.message); }
    const result = await checkBookingConflicts(req, {
      ignoreBookingId: existing.id,
      technicianId: nextTechnicianId,
      serviceId: nextServiceId,
      scheduledAt: nextScheduledAt,
      durationMin: nextDuration,
      bufferMin: nextBuffer,
    });
    if (result.blocked) throw badRequest('This appointment conflicts with the existing schedule', { conflicts: result.conflicts, warnings: result.warnings });
    responseConflicts = result.conflicts;
    responseWarnings = result.warnings;
  }

  const booking = await prisma.booking.update({ where: { id: existing.id }, data, include });
  cache.invalidate('stats');
  await audit(req, 'UPDATE', 'Booking', booking.id, data);
  const rescheduled = data.scheduledAt !== undefined && new Date(data.scheduledAt).getTime() !== new Date(existing.scheduledAt).getTime();
  if (data.status && data.status !== existing.status) {
    await activity(req.user.id, 'booking', `${req.user.name} set ${booking.reference} to ${data.status.replace('_', ' ')}`);
    if (notify) sendBookingStatusEmail(booking, booking.customer).catch(() => {});
    if (data.status === 'CANCELLED') emit('booking.cancelled', {
      bookingId: booking.id, reference: booking.reference, businessId: req.tenantId,
      actorId: req.user.id, actorName: req.user.name,
      details: { from: existing.status, scheduledAt: booking.scheduledAt, technicianId: booking.technicianId },
    });
  }
  if (rescheduled) emit('booking.rescheduled', {
    bookingId: booking.id, reference: booking.reference, businessId: req.tenantId,
    actorId: req.user.id, actorName: req.user.name,
    details: { from: existing.scheduledAt, to: booking.scheduledAt, technicianId: booking.technicianId },
    warnings: responseWarnings,
  });
  else if (Object.keys(data).length) emit('booking.updated', {
    bookingId: booking.id, reference: booking.reference, businessId: req.tenantId,
    actorId: req.user.id, actorName: req.user.name,
    details: { fields: Object.keys(data), status: booking.status, scheduledAt: booking.scheduledAt },
    warnings: responseWarnings,
  });
  res.json({
    success: true,
    data: booking,
    ...(responseConflicts.length ? { conflicts: responseConflicts } : {}),
    ...(responseWarnings.length ? { warnings: responseWarnings } : {}),
  });
}));

// PATCH /api/bookings/:id/status
router.patch('/:id/status', protect,
  validate(z.object({ status: z.enum(STATUSES), notify: z.coerce.boolean().default(true) })),
  asyncHandler(async (req, res) => {
    const existing = await prisma.booking.findFirst({ where: tenantWhere(req, { id: req.params.id }) });
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
    if (req.body.status === 'CANCELLED') emit('booking.cancelled', {
      bookingId: booking.id, reference: booking.reference, businessId: req.tenantId,
      actorId: req.user.id, actorName: req.user.name,
      details: { from: existing.status, scheduledAt: booking.scheduledAt, technicianId: booking.technicianId },
    });
    res.json({ success: true, data: booking });
  }));

// PATCH /api/bookings/:id/assign
router.patch('/:id/assign', protect,
  validate(z.object({ technicianId: z.string().uuid().nullable() })),
  asyncHandler(async (req, res) => {
    const existing = await prisma.booking.findFirst({ where: tenantWhere(req, { id: req.params.id }) });
    if (!existing) throw notFound('Booking not found');
    if (req.body.technicianId) await resolveTechnician(req, req.body.technicianId);
    let result = null;
    if (req.body.technicianId) {
      result = await checkBookingConflicts(req, {
        ignoreBookingId: existing.id,
        technicianId: req.body.technicianId,
        serviceId: existing.serviceId,
        scheduledAt: existing.scheduledAt,
        durationMin: existing.durationMin,
        bufferMin: existing.bufferMin,
      });
      if (result.blocked) throw badRequest('Technician has a scheduling conflict', { conflicts: result.conflicts, warnings: result.warnings });
    }
    const booking = await prisma.booking.update({
      where: { id: existing.id }, data: { technicianId: req.body.technicianId }, include,
    });
    await audit(req, 'ASSIGN', 'Booking', booking.id, { technicianId: req.body.technicianId });
    await activity(req.user.id, 'booking',
      `${req.user.name} ${booking.technician ? `assigned ${booking.technician.name} to` : 'unassigned'} ${booking.reference}`);
    emit('booking.assigned', {
      bookingId: booking.id, reference: booking.reference, businessId: req.tenantId,
      actorId: req.user.id, actorName: req.user.name,
      details: { from: existing.technicianId, to: req.body.technicianId, scheduledAt: booking.scheduledAt },
      warnings: result ? result.warnings : [],
    });
    res.json({
      success: true,
      data: booking,
      ...(result && result.conflicts.length ? { conflicts: result.conflicts } : {}),
      ...(result && result.warnings.length ? { warnings: result.warnings } : {}),
    });
  }));

// POST /api/bookings/:id/notes
router.post('/:id/notes', protect,
  validate(z.object({ body: z.string().trim().min(1).max(2000) })),
  asyncHandler(async (req, res) => {
    const booking = await prisma.booking.findFirst({ where: tenantWhere(req, { id: req.params.id }) });
    if (!booking) throw notFound('Booking not found');
    const note = await prisma.bookingNote.create({
      data: { bookingId: booking.id, businessId: req.tenantId, userId: req.user.id, body: req.body.body },
      include: { user: { select: { name: true } } },
    });
    await audit(req, 'NOTE', 'Booking', booking.id);
    res.status(201).json({ success: true, data: note });
  }));

// DELETE /api/bookings/:id/notes/:noteId
router.delete('/:id/notes/:noteId', protect, asyncHandler(async (req, res) => {
  const booking = await prisma.booking.findFirst({ where: tenantWhere(req, { id: req.params.id }) });
  if (!booking) throw notFound('Booking not found');
  const note = await prisma.bookingNote.findFirst({ where: { id: req.params.noteId, bookingId: booking.id } });
  if (!note) throw notFound('Note not found');
  await prisma.bookingNote.delete({ where: { id: note.id } });
  await audit(req, 'NOTE_DELETE', 'Booking', booking.id);
  res.json({ success: true, message: 'Note deleted' });
}));

// DELETE /api/bookings/:id
router.delete('/:id', protect, adminOnly, asyncHandler(async (req, res) => {
  const existing = await prisma.booking.findFirst({ where: tenantWhere(req, { id: req.params.id }) });
  if (!existing) throw notFound('Booking not found');
  await prisma.booking.delete({ where: { id: existing.id } });
  cache.invalidate('stats');
  await audit(req, 'DELETE', 'Booking', existing.id);
  res.json({ success: true, message: 'Booking deleted' });
}));

module.exports = router;
