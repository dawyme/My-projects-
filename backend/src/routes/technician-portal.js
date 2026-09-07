const express = require('express');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { protect, authorize } = require('../middleware/auth');
const { tenantWhere } = require('../lib/tenant');

const router = express.Router();
router.use(protect, authorize('TECHNICIAN'));

router.get('/overview', asyncHandler(async (req, res) => {
  const scope = tenantWhere(req, { technicianId: req.user.id });
  const now = new Date();
  const [jobs, upcoming, completed, inProgress] = await Promise.all([
    prisma.booking.findMany({ where: scope, orderBy: { scheduledAt: 'desc' }, take: 30, include: { customer: { select: { name: true, phone: true } }, service: { select: { name: true } } } }),
    prisma.booking.findMany({ where: { ...scope, scheduledAt: { gte: now }, status: { in: ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] } }, orderBy: { scheduledAt: 'asc' }, take: 8, include: { customer: { select: { name: true, phone: true } }, service: { select: { name: true } } } }),
    prisma.booking.count({ where: { ...scope, status: 'COMPLETED' } }),
    prisma.booking.count({ where: { ...scope, status: 'IN_PROGRESS' } }),
  ]);
  res.json({ success: true, data: { jobs, upcoming, counts: { total: jobs.length, upcoming: upcoming.length, completed, inProgress } } });
}));

module.exports = router;
