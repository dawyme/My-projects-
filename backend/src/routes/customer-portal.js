const express = require('express');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { protect, authorize } = require('../middleware/auth');
const { tenantWhere } = require('../lib/tenant');
const { notFound } = require('../lib/errors');

const router = express.Router();
router.use(protect, authorize('CUSTOMER'));

router.get('/overview', asyncHandler(async (req, res) => {
  const customer = await prisma.customer.findFirst({
    where: tenantWhere(req, { email: req.user.email }),
    include: {
      bookings: { orderBy: { scheduledAt: 'desc' }, take: 30, include: { service: { select: { name: true } }, technician: { select: { name: true } } } },
      orders: { orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, reference: true, status: true, total: true, createdAt: true } },
    },
  });
  if (!customer) throw notFound('Customer profile not found');
  const now = new Date();
  const upcoming = customer.bookings.filter((b) => b.scheduledAt >= now && ['PENDING', 'CONFIRMED', 'IN_PROGRESS'].includes(b.status));
  const completed = customer.bookings.filter((b) => b.status === 'COMPLETED');
  res.json({ success: true, data: { bookings: customer.bookings, orders: customer.orders, counts: { bookings: customer.bookings.length, upcoming: upcoming.length, completed: completed.length, orders: customer.orders.length } } });
}));

module.exports = router;
