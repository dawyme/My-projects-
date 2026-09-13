/**
 * Technician scheduling data (Phase C): weekly working hours, time off /
 * holidays, daily breaks and specific closed days, plus a technician roster
 * with availability summaries.
 *
 * Mounted at /api/scheduling behind featureProtectedRoute('calendar') and
 * scoped strictly to the caller's tenant via tenantWhere — a client-supplied
 * businessId is never trusted. Mutations require an active tenant user
 * (ADMIN/STAFF) and validate that every referenced user belongs to the same
 * tenant.
 */
const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect, authorize } = require('../middleware/auth');
const { badRequest, notFound } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { tenantWhere } = require('../lib/tenant');
const { parseHhMm, parseDayHours } = require('../lib/scheduling-rules');

const router = express.Router();

const HHMM = z.string().regex(/^\d{1,2}:\d{2}$/, 'Use the HH:mm format').refine((v) => parseHhMm(v) !== null, { message: 'Invalid HH:mm time' });
const DAY = z.coerce.number().int().min(1).max(7);
const HOURS_PAIR_SHAPE = { start: HHMM, end: HHMM };
/** Adds the start<end check to a schema that already contains start/end. */
function requireStartBeforeEnd(schema) {
  return schema.refine((v) => {
    const s = parseHhMm(v.start);
    const e = parseHhMm(v.end);
    return s !== null && e !== null && s < e;
  }, { message: 'start must be before end' });
}

/** Resolves a user strictly inside the caller's tenant (active). */
async function resolveTenantUser(req, userId) {
  const user = await prisma.user.findFirst({ where: tenantWhere(req, { id: userId }), select: { id: true, name: true, email: true, role: true, isActive: true } });
  if (!user) throw badRequest('User not found in this business');
  return user;
}

// ---------------------------------------------------------------------------
// Technicians roster with availability summary (drives the staff/technician
// calendar views and the assignment pickers).
// ---------------------------------------------------------------------------
router.get('/technicians', protect, asyncHandler(async (req, res) => {
  const users = await prisma.user.findMany({
    where: tenantWhere(req, { role: { in: ['STAFF', 'ADMIN'] }, isActive: true }),
    select: { id: true, name: true, email: true, phone: true, role: true },
    orderBy: { name: 'asc' },
  });
  const ids = users.map((u) => u.id);
  const [workingHours, timeOffs] = await Promise.all([
    prisma.workingHours.findMany({ where: { businessId: req.tenantId, userId: { in: ids } }, orderBy: { day: 'asc' } }),
    prisma.timeOff.findMany({ where: { businessId: req.tenantId, userId: { in: ids }, status: 'APPROVED', endsAt: { gte: new Date() } }, orderBy: { startsAt: 'asc' } }),
  ]);
  let hoursSetting = {};
  try {
    const row = await prisma.setting.findUnique({ where: { businessId_key: { businessId: req.tenantId, key: 'hours' } } });
    hoursSetting = row ? JSON.parse(row.value) : {};
  } catch (_) { hoursSetting = {}; }
  const data = users.map((u) => ({
    ...u,
    workingHours: workingHours.filter((w) => w.userId === u.id).map((w) => ({ id: w.id, day: w.day, start: w.start, end: w.end })),
    upcomingTimeOff: timeOffs.filter((t) => t.userId === u.id).map((t) => ({ id: t.id, startsAt: t.startsAt, endsAt: t.endsAt, reason: t.reason, status: t.status })),
  }));
  res.json({ success: true, data, businessHours: hoursSetting });
}));

// ---------------------------------------------------------------------------
// Working hours (per technician, per weekday)
// ---------------------------------------------------------------------------
router.get('/working-hours', protect, asyncHandler(async (req, res) => {
  const where = tenantWhere(req);
  if (req.query.userId) {
    await resolveTenantUser(req, String(req.query.userId));
    where.userId = String(req.query.userId);
  }
  const rows = await prisma.workingHours.findMany({ where, orderBy: [{ userId: 'asc' }, { day: 'asc' }] });
  res.json({ success: true, data: rows });
}));

router.put('/working-hours', protect, authorize('ADMIN', 'STAFF'),
  validate(requireStartBeforeEnd(z.object({ userId: z.string().uuid(), day: DAY, ...HOURS_PAIR_SHAPE }))),
  asyncHandler(async (req, res) => {
    await resolveTenantUser(req, req.body.userId);
    const { userId, day, start, end } = req.body;
    const row = await prisma.workingHours.upsert({
      where: { businessId_userId_day: { businessId: req.tenantId, userId, day } },
      create: { businessId: req.tenantId, userId, day, start, end },
      update: { start, end },
    });
    await audit(req, 'UPSERT', 'WorkingHours', row.id, { userId, day, start, end });
    res.json({ success: true, data: row });
  }));

router.delete('/working-hours/:id', protect, authorize('ADMIN', 'STAFF'), asyncHandler(async (req, res) => {
  const row = await prisma.workingHours.findFirst({ where: tenantWhere(req, { id: req.params.id }) });
  if (!row) throw notFound('Working hours entry not found');
  await prisma.workingHours.delete({ where: { id: row.id } });
  await audit(req, 'DELETE', 'WorkingHours', row.id, { userId: row.userId, day: row.day });
  res.json({ success: true, message: 'Working hours entry deleted' });
}));

// ---------------------------------------------------------------------------
// Time off / holidays (per technician)
// ---------------------------------------------------------------------------
router.get('/time-off', protect, asyncHandler(async (req, res) => {
  const where = tenantWhere(req);
  if (req.query.userId) {
    await resolveTenantUser(req, String(req.query.userId));
    where.userId = String(req.query.userId);
  }
  if (req.query.status) {
    const statuses = String(req.query.status).split(',').map((s) => s.trim().toUpperCase()).filter((s) => ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].includes(s));
    if (statuses.length) where.status = { in: statuses };
  }
  const rows = await prisma.timeOff.findMany({ where, orderBy: { startsAt: 'desc' } });
  res.json({ success: true, data: rows });
}));

router.post('/time-off', protect, authorize('ADMIN', 'STAFF'),
  validate(z.object({
    userId: z.string().uuid(),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    reason: z.string().trim().max(200).optional().nullable(),
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
  }).refine((d) => d.endsAt > d.startsAt, { message: 'endsAt must be after startsAt' })),
  asyncHandler(async (req, res) => {
    await resolveTenantUser(req, req.body.userId);
    // Staff may request (PENDING) their own time off; anything else is an
    // administrative decision recorded as APPROVED.
    const isSelf = req.user.id === req.body.userId;
    const status = req.body.status || (isSelf && req.user.role !== 'ADMIN' ? 'PENDING' : 'APPROVED');
    const row = await prisma.timeOff.create({
      data: { businessId: req.tenantId, userId: req.body.userId, startsAt: req.body.startsAt, endsAt: req.body.endsAt, reason: req.body.reason || null, status },
    });
    await audit(req, 'CREATE', 'TimeOff', row.id, { userId: row.userId, status });
    res.status(201).json({ success: true, data: row });
  }));

router.patch('/time-off/:id', protect, authorize('ADMIN', 'STAFF'),
  validate(z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']) })),
  asyncHandler(async (req, res) => {
    const row = await prisma.timeOff.findFirst({ where: tenantWhere(req, { id: req.params.id }) });
    if (!row) throw notFound('Time off entry not found');
    const updated = await prisma.timeOff.update({ where: { id: row.id }, data: { status: req.body.status } });
    await audit(req, 'TIME_OFF_STATUS', 'TimeOff', row.id, { from: row.status, to: req.body.status });
    res.json({ success: true, data: updated });
  }));

router.delete('/time-off/:id', protect, authorize('ADMIN', 'STAFF'), asyncHandler(async (req, res) => {
  const row = await prisma.timeOff.findFirst({ where: tenantWhere(req, { id: req.params.id }) });
  if (!row) throw notFound('Time off entry not found');
  const isSelf = req.user.id === row.userId;
  if (!isSelf && req.user.role !== 'ADMIN') throw badRequest('Only the requester or an administrator can delete this entry');
  await prisma.timeOff.delete({ where: { id: row.id } });
  await audit(req, 'DELETE', 'TimeOff', row.id, { userId: row.userId });
  res.json({ success: true, message: 'Time off entry deleted' });
}));

// ---------------------------------------------------------------------------
// Break periods (per weekday; business-wide when userId is omitted)
// ---------------------------------------------------------------------------
router.get('/breaks', protect, asyncHandler(async (req, res) => {
  const where = tenantWhere(req);
  if (req.query.userId) {
    await resolveTenantUser(req, String(req.query.userId));
    where.userId = String(req.query.userId);
  }
  const rows = await prisma.breakPeriod.findMany({ where, orderBy: [{ day: 'asc' }, { start: 'asc' }] });
  res.json({ success: true, data: rows });
}));

router.put('/breaks', protect, authorize('ADMIN', 'STAFF'),
  validate(requireStartBeforeEnd(z.object({ userId: z.string().uuid().optional().nullable(), day: DAY, ...HOURS_PAIR_SHAPE }))),
  asyncHandler(async (req, res) => {
    const userId = req.body.userId || null;
    if (userId) await resolveTenantUser(req, userId);
    const { day, start, end } = req.body;
    const existing = await prisma.breakPeriod.findFirst({ where: tenantWhere(req, { userId, day }) });
    const row = existing
      ? await prisma.breakPeriod.update({ where: { id: existing.id }, data: { start, end } })
      : await prisma.breakPeriod.create({ data: { businessId: req.tenantId, userId, day, start, end } });
    await audit(req, existing ? 'UPDATE' : 'CREATE', 'BreakPeriod', row.id, { userId, day, start, end });
    res.json({ success: true, data: row });
  }));

router.delete('/breaks/:id', protect, authorize('ADMIN', 'STAFF'), asyncHandler(async (req, res) => {
  const row = await prisma.breakPeriod.findFirst({ where: tenantWhere(req, { id: req.params.id }) });
  if (!row) throw notFound('Break period not found');
  await prisma.breakPeriod.delete({ where: { id: row.id } });
  await audit(req, 'DELETE', 'BreakPeriod', row.id, { day: row.day });
  res.json({ success: true, message: 'Break period deleted' });
}));

// ---------------------------------------------------------------------------
// Closed days (specific dates, e.g. public holidays)
// ---------------------------------------------------------------------------
router.get('/closed-days', protect, asyncHandler(async (req, res) => {
  const where = tenantWhere(req);
  if (req.query.year) where.date = { gte: new Date(`${req.query.year}-01-01T00:00:00.000Z`), lt: new Date(`${Number(req.query.year) + 1}-01-01T00:00:00.000Z`) };
  const rows = await prisma.closedDay.findMany({ where, orderBy: { date: 'asc' } });
  res.json({ success: true, data: rows });
}));

router.post('/closed-days', protect, authorize('ADMIN', 'STAFF'),
  validate(z.object({ date: z.coerce.date(), reason: z.string().trim().max(200).optional().nullable() })),
  asyncHandler(async (req, res) => {
    const date = new Date(Date.UTC(req.body.date.getUTCFullYear(), req.body.date.getUTCMonth(), req.body.date.getUTCDate()));
    const row = await prisma.closedDay.upsert({
      where: { businessId_date: { businessId: req.tenantId, date } },
      create: { businessId: req.tenantId, date, reason: req.body.reason || null },
      update: { reason: req.body.reason || null },
    });
    await audit(req, 'UPSERT', 'ClosedDay', row.id, { date: row.date });
    res.status(201).json({ success: true, data: row });
  }));

router.delete('/closed-days/:id', protect, authorize('ADMIN', 'STAFF'), asyncHandler(async (req, res) => {
  const row = await prisma.closedDay.findFirst({ where: tenantWhere(req, { id: req.params.id }) });
  if (!row) throw notFound('Closed day not found');
  await prisma.closedDay.delete({ where: { id: row.id } });
  await audit(req, 'DELETE', 'ClosedDay', row.id, { date: row.date });
  res.json({ success: true, message: 'Closed day deleted' });
}));

module.exports = router;
