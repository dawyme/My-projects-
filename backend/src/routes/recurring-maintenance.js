const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect, authorize } = require('../middleware/auth');
const { tenantWhere } = require('../lib/tenant');
const { badRequest, notFound } = require('../lib/errors');
const { requireFeature } = require('../lib/features');
const { audit, activity } = require('../lib/audit');
const {
  DEFAULT_REMINDER_OFFSETS_DAYS,
  addMonthsClamped,
  normalizeRecurrence,
  normalizeReminderOffsets,
  buildReminderSchedule,
  parseReminderOffsets,
} = require('../lib/recurring-maintenance');

const router = express.Router();
const STATUS = ['ACTIVE', 'PAUSED', 'CANCELLED', 'COMPLETED'];

const dateOptional = z.coerce.date().optional().nullable();
const createBody = z.object({
  customerId: z.string().uuid(),
  equipmentId: z.string().uuid().optional().nullable(),
  serviceId: z.string().uuid().optional().nullable(),
  technicianId: z.string().uuid().optional().nullable(),
  intervalMonths: z.coerce.number().int().positive(),
  startDate: z.coerce.date(),
  endDate: dateOptional,
  maxOccurrences: z.coerce.number().int().positive().optional().nullable(),
  reminderOffsets: z.array(z.coerce.number().int().min(0)).optional(),
  serviceLabel: z.string().trim().max(160).optional().nullable(),
  notes: z.string().trim().max(4000).optional().nullable(),
});

const updateBody = z.object({
  intervalMonths: z.coerce.number().int().positive().optional(),
  nextOccurrenceAt: dateOptional,
  endDate: dateOptional,
  maxOccurrences: z.coerce.number().int().positive().optional().nullable(),
  technicianId: z.string().uuid().optional().nullable(),
  reminderOffsets: z.array(z.coerce.number().int().min(0)).optional(),
  serviceLabel: z.string().trim().max(160).optional().nullable(),
  notes: z.string().trim().max(4000).optional().nullable(),
});

function parseDate(value) { return value ? new Date(value) : null; }
function reference() { return `RM-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`; }

async function resolveOwned(req, model, id, label) {
  if (!id) return null;
  const row = await prisma[model].findFirst({ where: tenantWhere(req, { id }) });
  if (!row) throw badRequest(`${label} not found in this business`);
  return row;
}

async function resolveTechnician(req, id) {
  if (!id) return null;
  const row = await prisma.user.findFirst({ where: { id, isActive: true, businessId: req.tenantId } });
  if (!row) throw badRequest('Technician not found or inactive in this business');
  return row;
}

async function assertBookingConflict(tx, businessId, technicianId, scheduledAt, serviceId, ignoreBookingId) {
  if (!technicianId) return;
  const service = serviceId ? await tx.service.findFirst({ where: { id: serviceId, businessId }, select: { durationMin: true } }) : null;
  const duration = (service?.durationMin || 60) * 60 * 1000;
  const start = new Date(scheduledAt);
  const from = new Date(start.getTime() - 24 * 60 * 60 * 1000);
  const to = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const candidates = await tx.booking.findMany({
    where: { businessId, technicianId, status: { not: 'CANCELLED' }, scheduledAt: { gte: from, lte: to }, ...(ignoreBookingId ? { id: { not: ignoreBookingId } } : {}) },
    include: { service: { select: { durationMin: true } } },
  });
  const conflict = candidates.find((b) => {
    const bStart = new Date(b.scheduledAt);
    const bEnd = new Date(bStart.getTime() + (b.service?.durationMin || 60) * 60 * 1000);
    return bStart < new Date(start.getTime() + duration) && bEnd > start;
  });
  if (conflict) throw badRequest(`Technician has a scheduling conflict with booking ${conflict.reference}`);
}

async function createOccurrence(tx, series, scheduledAt, occurrenceNumber) {
  if (series.endDate && scheduledAt > series.endDate) return null;
  if (series.maxOccurrences && occurrenceNumber > series.maxOccurrences) return null;
  await assertBookingConflict(tx, series.businessId, series.technicianId, scheduledAt, series.serviceId);
  const service = series.serviceId ? await tx.service.findUnique({ where: { id: series.serviceId }, select: { basePrice: true, durationMin: true, name: true } }) : null;
  const customer = await tx.customer.findUnique({ where: { id: series.customerId }, select: { address: true } });
  const booking = await tx.booking.create({
    data: {
      businessId: series.businessId,
      reference: reference(),
      customerId: series.customerId,
      serviceId: series.serviceId,
      technicianId: series.technicianId,
      scheduledAt,
      status: 'CONFIRMED',
      priority: 'NORMAL',
      address: customer?.address || null,
      description: series.serviceLabel || service?.name || 'Recurring maintenance',
      price: service?.basePrice || 0,
    },
  });
  const occurrence = await tx.recurringMaintenanceOccurrence.create({
    data: { businessId: series.businessId, seriesId: series.id, bookingId: booking.id, occurrenceNumber, scheduledAt },
    include: { booking: true },
  });
  const reminders = buildReminderSchedule(scheduledAt, parseReminderOffsets(series.reminderOffsets));
  await tx.recurringMaintenanceReminder.createMany({
    data: reminders.map((r) => ({ businessId: series.businessId, occurrenceId: occurrence.id, offsetDays: r.offsetDays, channel: r.channel, scheduledFor: r.scheduledFor })),
  });
  return occurrence;
}

async function getSeries(req, id) {
  const series = await prisma.recurringMaintenanceSeries.findFirst({
    where: tenantWhere(req, { id }),
    include: {
      customer: { select: { id: true, name: true, email: true, phone: true } },
      equipment: { select: { id: true, type: true, brand: true, model: true, serialNumber: true } },
      service: { select: { id: true, name: true, durationMin: true, basePrice: true } },
      technician: { select: { id: true, name: true, email: true } },
      occurrences: { orderBy: { occurrenceNumber: 'desc' }, take: 12, include: { booking: true, reminders: true } },
    },
  });
  if (!series) throw notFound('Recurring maintenance series not found');
  return series;
}

router.get('/', protect, requireFeature('recurring-maintenance'), asyncHandler(async (req, res) => {
  const where = tenantWhere(req);
  if (req.query.status && STATUS.includes(String(req.query.status).toUpperCase())) where.status = String(req.query.status).toUpperCase();
  const data = await prisma.recurringMaintenanceSeries.findMany({
    where,
    orderBy: { nextOccurrenceAt: 'asc' },
    include: {
      customer: { select: { id: true, name: true, email: true, phone: true } },
      equipment: { select: { id: true, type: true, brand: true, model: true, serialNumber: true } },
      service: { select: { id: true, name: true } },
      technician: { select: { id: true, name: true } },
      occurrences: { orderBy: { occurrenceNumber: 'desc' }, take: 1, include: { booking: true } },
    },
  });
  res.json({ success: true, data });
}));

router.get('/:id', protect, requireFeature('recurring-maintenance'), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await getSeries(req, req.params.id) });
}));

router.post('/', protect, authorize('ADMIN', 'STAFF'), requireFeature('recurring-maintenance'), validate(createBody), asyncHandler(async (req, res) => {
  normalizeRecurrence(req.body);
  const customer = await resolveOwned(req, 'customer', req.body.customerId, 'Customer');
  const equipment = await resolveOwned(req, 'equipment', req.body.equipmentId, 'Equipment');
  if (equipment && equipment.customerId !== customer.id) throw badRequest('Equipment does not belong to the selected customer');
  const service = await resolveOwned(req, 'service', req.body.serviceId, 'Service');
  const technician = await resolveTechnician(req, req.body.technicianId);
  const startDate = parseDate(req.body.startDate);
  const endDate = parseDate(req.body.endDate);
  if (endDate && endDate < startDate) throw badRequest('End date must be on or after the start date');
  const offsets = normalizeReminderOffsets(req.body.reminderOffsets || DEFAULT_REMINDER_OFFSETS_DAYS);
  const series = await prisma.$transaction(async (tx) => {
    const created = await tx.recurringMaintenanceSeries.create({
      data: {
        businessId: req.tenantId,
        customerId: customer.id,
        equipmentId: equipment?.id || null,
        serviceId: service?.id || null,
        technicianId: technician?.id || null,
        intervalMonths: req.body.intervalMonths,
        startDate,
        endDate,
        maxOccurrences: req.body.maxOccurrences || null,
        occurrenceCount: 0,
        nextOccurrenceAt: startDate,
        status: 'ACTIVE',
        reminderOffsets: JSON.stringify(offsets),
        serviceLabel: req.body.serviceLabel || service?.name || null,
        notes: req.body.notes || null,
      },
    });
    const occurrence = await createOccurrence(tx, created, startDate, 1);
    if (!occurrence) throw badRequest('The first occurrence is outside the series limits');
    return tx.recurringMaintenanceSeries.update({ where: { id: created.id }, data: { occurrenceCount: 1, nextOccurrenceAt: addMonthsClamped(startDate, req.body.intervalMonths) } });
  });
  await audit(req, 'CREATE', 'RecurringMaintenanceSeries', series.id, { intervalMonths: series.intervalMonths });
  await activity(req.user.id, 'recurring-maintenance', `${req.user.name} created a recurring maintenance schedule`, undefined, req);
  res.status(201).json({ success: true, data: await getSeries(req, series.id) });
}));

router.put('/:id', protect, authorize('ADMIN', 'STAFF'), requireFeature('recurring-maintenance'), validate(updateBody), asyncHandler(async (req, res) => {
  const existing = await getSeries(req, req.params.id);
  if (existing.status === 'CANCELLED' || existing.status === 'COMPLETED') throw badRequest('A completed or cancelled series cannot be edited');
  if (req.body.technicianId) await resolveTechnician(req, req.body.technicianId);
  if (req.body.intervalMonths) normalizeRecurrence(req.body);
  const data = {};
  for (const key of ['intervalMonths', 'maxOccurrences', 'serviceLabel', 'notes', 'technicianId']) if (req.body[key] !== undefined) data[key] = req.body[key];
  if (req.body.endDate !== undefined) data.endDate = req.body.endDate;
  if (req.body.nextOccurrenceAt !== undefined) data.nextOccurrenceAt = req.body.nextOccurrenceAt;
  if (req.body.reminderOffsets) data.reminderOffsets = JSON.stringify(normalizeReminderOffsets(req.body.reminderOffsets));
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.recurringMaintenanceSeries.update({ where: { id: existing.id }, data });
    const future = existing.occurrences.find((o) => o.status === 'SCHEDULED');
    if (future && (data.nextOccurrenceAt || data.technicianId || data.reminderOffsets)) {
      if (data.technicianId !== undefined || data.nextOccurrenceAt) {
        await assertBookingConflict(tx, result.businessId, result.technicianId, data.nextOccurrenceAt || future.scheduledAt, result.serviceId, future.bookingId);
        const nextScheduledAt = data.nextOccurrenceAt || future.scheduledAt;
        await tx.booking.update({ where: { id: future.bookingId }, data: { technicianId: result.technicianId, scheduledAt: nextScheduledAt } });
        await tx.recurringMaintenanceOccurrence.update({ where: { id: future.id }, data: { scheduledAt: nextScheduledAt } });
      }
      if (data.reminderOffsets) {
        await tx.recurringMaintenanceReminder.deleteMany({ where: { occurrenceId: future.id, status: 'PENDING' } });
        const reminders = buildReminderSchedule(future.scheduledAt, parseReminderOffsets(result.reminderOffsets));
        await tx.recurringMaintenanceReminder.createMany({ data: reminders.map((r) => ({ businessId: result.businessId, occurrenceId: future.id, offsetDays: r.offsetDays, channel: r.channel, scheduledFor: r.scheduledFor })) });
      }
    }
    return result;
  });
  res.json({ success: true, data: await getSeries(req, updated.id) });
}));

async function setLifecycle(req, res, status) {
  const existing = await getSeries(req, req.params.id);
  if (existing.status === 'CANCELLED' && status !== 'CANCELLED') throw badRequest('A cancelled series cannot be resumed');
  if (status === 'PAUSED' && existing.status !== 'ACTIVE') throw badRequest('Only an active series can be paused');
  if (status === 'ACTIVE' && existing.status !== 'PAUSED') throw badRequest('Only a paused series can be resumed');
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.recurringMaintenanceSeries.update({ where: { id: existing.id }, data: { status } });
    if (status === 'PAUSED' || status === 'CANCELLED') {
      await tx.booking.updateMany({ where: { id: { in: existing.occurrences.filter((o) => o.status === 'SCHEDULED').map((o) => o.bookingId) }, status: { in: ['PENDING', 'CONFIRMED'] } }, data: { status: 'CANCELLED' } });
      await tx.recurringMaintenanceOccurrence.updateMany({ where: { seriesId: existing.id, status: 'SCHEDULED' }, data: { status: 'CANCELLED' } });
    }
    return result;
  });
  await audit(req, status === 'CANCELLED' ? 'CANCEL' : status === 'PAUSED' ? 'PAUSE' : 'RESUME', 'RecurringMaintenanceSeries', updated.id);
  res.json({ success: true, data: await getSeries(req, updated.id) });
}

router.post('/:id/pause', protect, authorize('ADMIN', 'STAFF'), requireFeature('recurring-maintenance'), asyncHandler((req, res) => setLifecycle(req, res, 'PAUSED')));
router.post('/:id/resume', protect, authorize('ADMIN', 'STAFF'), requireFeature('recurring-maintenance'), asyncHandler(async (req, res) => {
  const existing = await getSeries(req, req.params.id);
  if (existing.status !== 'PAUSED') throw badRequest('Only a paused series can be resumed');
  const future = existing.occurrences.find((o) => o.status === 'CANCELLED' && new Date(o.scheduledAt) >= new Date());
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.recurringMaintenanceSeries.update({ where: { id: existing.id }, data: { status: 'ACTIVE' } });
    const next = result.nextOccurrenceAt && new Date(result.nextOccurrenceAt) >= new Date() ? new Date(result.nextOccurrenceAt) : addMonthsClamped(existing.startDate, Math.max(1, result.occurrenceCount + 1) * result.intervalMonths);
    if (future) {
      await tx.recurringMaintenanceOccurrence.update({ where: { id: future.id }, data: { status: 'SCHEDULED', scheduledAt: next, completedAt: null } });
      await tx.booking.update({ where: { id: future.bookingId }, data: { status: 'CONFIRMED', scheduledAt: next, technicianId: result.technicianId } });
      await tx.recurringMaintenanceReminder.deleteMany({ where: { occurrenceId: future.id } });
      const reminders = buildReminderSchedule(next, parseReminderOffsets(result.reminderOffsets));
      await tx.recurringMaintenanceReminder.createMany({ data: reminders.map((r) => ({ businessId: result.businessId, occurrenceId: future.id, offsetDays: r.offsetDays, channel: r.channel, scheduledFor: r.scheduledFor })) });
    } else {
      await createOccurrence(tx, result, next, result.occurrenceCount + 1);
      await tx.recurringMaintenanceSeries.update({ where: { id: result.id }, data: { occurrenceCount: { increment: 1 }, nextOccurrenceAt: addMonthsClamped(next, result.intervalMonths) } });
    }
    return result;
  });
  res.json({ success: true, data: await getSeries(req, updated.id) });
}));
router.post('/:id/cancel', protect, authorize('ADMIN', 'STAFF'), requireFeature('recurring-maintenance'), asyncHandler((req, res) => setLifecycle(req, res, 'CANCELLED')));

router.delete('/:id', protect, authorize('ADMIN', 'STAFF'), requireFeature('recurring-maintenance'), asyncHandler(async (req, res) => {
  const existing = await getSeries(req, req.params.id);
  if (existing.occurrences.some((occurrence) => occurrence.status === 'COMPLETED')) {
    throw badRequest('A recurring maintenance series with completed history cannot be deleted');
  }
  await prisma.$transaction(async (tx) => {
    await tx.recurringMaintenanceSeries.delete({ where: { id: existing.id } });
  });
  await audit(req, 'DELETE', 'RecurringMaintenanceSeries', existing.id, { removedGeneratedAppointments: existing.occurrences.length });
  await activity(req.user.id, 'recurring-maintenance', `${req.user.name} deleted a recurring maintenance schedule`, undefined, req);
  res.json({ success: true, data: { id: existing.id, deleted: true } });
}));

router.post('/:id/generate-next', protect, authorize('ADMIN', 'STAFF'), requireFeature('recurring-maintenance'), asyncHandler(async (req, res) => {
  const existing = await getSeries(req, req.params.id);
  if (existing.status !== 'ACTIVE') throw badRequest('Only an active series can generate the next occurrence');
  const nextNumber = existing.occurrenceCount + 1;
  const nextDate = existing.nextOccurrenceAt ? new Date(existing.nextOccurrenceAt) : addMonthsClamped(existing.startDate, existing.intervalMonths * nextNumber);
  const occurrence = await prisma.$transaction(async (tx) => {
    const generated = await createOccurrence(tx, existing, nextDate, nextNumber);
    if (!generated) throw badRequest('The series has reached its configured end condition');
    await tx.recurringMaintenanceSeries.update({ where: { id: existing.id }, data: { occurrenceCount: nextNumber, nextOccurrenceAt: addMonthsClamped(nextDate, existing.intervalMonths) } });
    return generated;
  });
  res.status(201).json({ success: true, data: occurrence });
}));


async function advanceFromCompletedBooking(businessId, bookingId) {
  const occurrence = await prisma.recurringMaintenanceOccurrence.findFirst({ where: { businessId, bookingId }, include: { series: true } });
  if (!occurrence || occurrence.status === 'COMPLETED') return null;
  return prisma.$transaction(async (tx) => {
    await tx.recurringMaintenanceOccurrence.update({ where: { id: occurrence.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
    const series = await tx.recurringMaintenanceSeries.findUnique({ where: { id: occurrence.seriesId } });
    if (!series || series.status !== 'ACTIVE') return null;
    const nextNumber = occurrence.occurrenceNumber + 1;
    const nextDate = addMonthsClamped(occurrence.scheduledAt, series.intervalMonths);
    if ((series.endDate && nextDate > series.endDate) || (series.maxOccurrences && nextNumber > series.maxOccurrences)) {
      await tx.recurringMaintenanceSeries.update({ where: { id: series.id }, data: { status: 'COMPLETED', nextOccurrenceAt: null } });
      return null;
    }
    const next = await createOccurrence(tx, series, nextDate, nextNumber);
    if (!next) return null;
    await tx.recurringMaintenanceSeries.update({ where: { id: series.id }, data: { occurrenceCount: nextNumber, nextOccurrenceAt: addMonthsClamped(nextDate, series.intervalMonths) } });
    return next;
  });
}

module.exports = { router, createOccurrence, assertBookingConflict, advanceFromCompletedBooking };
