const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { protect, adminOnly } = require('../middleware/auth');
const { tenantWhere } = require('../lib/tenant');
const { notFound, badRequest, unauthorized } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { sendBookingReminderEmail, sendRecurringMaintenanceReminderEmail } = require('../lib/mailer');

const router = express.Router();

function reminderDateKey(scheduledAt) {
  return new Date(scheduledAt).toISOString().slice(0, 16);
}

async function alreadySent(booking) {
  const key = reminderDateKey(booking.scheduledAt);
  return prisma.auditLog.findFirst({
    where: {
      businessId: booking.businessId,
      entity: 'Booking',
      entityId: booking.id,
      action: 'REMINDER_SENT',
      data: { contains: `\"scheduledKey\":\"${key}\"` },
    },
    select: { id: true },
  });
}

async function deliver(booking, req) {
  if (!booking.customer?.email) throw badRequest('Customer email is required to send a reminder');
  if (await alreadySent(booking)) return { sent: false, alreadySent: true };
  await sendBookingReminderEmail(booking, booking.customer);
  await audit(req || { tenantId: booking.businessId, user: null, ip: null, get: () => '' }, 'REMINDER_SENT', 'Booking', booking.id, { scheduledKey: reminderDateKey(booking.scheduledAt) });
  return { sent: true, alreadySent: false };
}

router.post('/bookings/:id', protect, adminOnly, asyncHandler(async (req, res) => {
  const booking = await prisma.booking.findFirst({
    where: tenantWhere(req, { id: req.params.id }),
    include: { customer: true, technician: { select: { id: true, name: true } } },
  });
  if (!booking) throw notFound('Booking not found');
  const result = await deliver(booking, req);
  res.json({ success: true, data: { bookingId: booking.id, ...result } });
}));

router.get('/run', asyncHandler(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const supplied = req.get('authorization')?.replace(/^Bearer\s+/i, '') || req.get('x-cron-secret');
  if (!secret || supplied !== secret) throw unauthorized('Invalid cron authorization');

  const now = Date.now();
  const from = new Date(now + 12 * 60 * 60 * 1000);
  const to = new Date(now + 36 * 60 * 60 * 1000);
  const bookings = await prisma.booking.findMany({
    where: {
      scheduledAt: { gte: from, lt: to },
      status: { in: ['PENDING', 'CONFIRMED'] },
    },
    include: { customer: true, technician: { select: { id: true, name: true } } },
    orderBy: { scheduledAt: 'asc' },
  });
  const results = [];
  for (const booking of bookings) {
    try { results.push({ id: booking.id, ...(await deliver(booking, null)) }); }
    catch (error) { results.push({ id: booking.id, sent: false, error: error.message }); }
  }
  res.json({ success: true, data: { scanned: bookings.length, results } });
}));

module.exports = router;
const STALE_REMINDER_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

async function processRecurringReminders() {
  const now = new Date();
  const due = await prisma.recurringMaintenanceReminder.findMany({
    where: { scheduledFor: { lte: now }, status: { in: ['PENDING', 'FAILED'] } },
    include: {
      occurrence: { include: { booking: true, series: true } },
    },
    orderBy: { scheduledFor: 'asc' },
    take: 200,
  });
  const results = [];
  for (const reminder of due) {
    if (now.getTime() - new Date(reminder.scheduledFor).getTime() > STALE_REMINDER_THRESHOLD_MS) {
      await prisma.recurringMaintenanceReminder.update({ where: { id: reminder.id }, data: { status: 'FAILED', error: 'Reminder is stale (more than 3 days overdue) and was skipped' } });
      results.push({ id: reminder.id, sent: false, skipped: 'stale' });
      continue;
    }
    if (reminder.occurrence.status !== 'SCHEDULED' || reminder.occurrence.booking.status === 'CANCELLED') {
      await prisma.recurringMaintenanceReminder.update({ where: { id: reminder.id }, data: { status: 'FAILED', error: 'Occurrence is no longer scheduled' } });
      continue;
    }
    const customer = await prisma.customer.findFirst({ where: { id: reminder.occurrence.booking.customerId, businessId: reminder.businessId } });
    if (!customer?.email) {
      await prisma.recurringMaintenanceReminder.update({ where: { id: reminder.id }, data: { status: 'FAILED', error: 'Customer email is missing' } });
      continue;
    }
    try {
      const sent = await sendRecurringMaintenanceReminderEmail(reminder.occurrence, customer, reminder.occurrence.series);
      await prisma.recurringMaintenanceReminder.update({ where: { id: reminder.id }, data: { status: 'SENT', sentAt: new Date(), providerId: sent?.id || null, error: null } });
      results.push({ id: reminder.id, sent: true });
    } catch (error) {
      await prisma.recurringMaintenanceReminder.update({ where: { id: reminder.id }, data: { status: 'FAILED', error: String(error.message || error).slice(0, 1000) } });
      results.push({ id: reminder.id, sent: false, error: error.message });
    }
  }
  return { scanned: due.length, results };
}

router.get('/recurring/run', asyncHandler(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const supplied = req.get('authorization')?.replace(/^Bearer\s+/i, '') || req.get('x-cron-secret');
  if (!secret || supplied !== secret) throw unauthorized('Invalid cron authorization');
  res.json({ success: true, data: await processRecurringReminders() });
}));


module.exports = router;
