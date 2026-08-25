const express = require('express');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { protect } = require('../middleware/auth');
const { tenantWhere } = require('../lib/tenant');
const cache = require('../lib/cache');

const router = express.Router();
const round = (n) => Math.round((n || 0) * 100) / 100;

// GET /api/dashboard/stats
router.get('/stats', protect, asyncHandler(async (req, res) => {
  const data = await cache.wrap(`stats:overview:${req.tenantId}`, 20000, async () => {
    const scope = tenantWhere(req);
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfPrevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const [
      totalProducts, activeProducts, totalBookings, bookingsThisMonth, bookingsPrevMonth,
      totalCustomers, customersThisMonth, customersPrevMonth, unreadMessages, totalMessages,
      pendingBookings, todayBookings, products, orderAgg, orderAggMonth, orderAggPrev,
      completedBookings, statusGroups,
    ] = await Promise.all([
      prisma.product.count({ where: scope }),
      prisma.product.count({ where: { ...scope, isActive: true } }),
      prisma.booking.count({ where: scope }),
      prisma.booking.count({ where: { ...scope, createdAt: { gte: startOfMonth } } }),
      prisma.booking.count({ where: { ...scope, createdAt: { gte: startOfPrevMonth, lt: startOfMonth } } }),
      prisma.customer.count({ where: scope }),
      prisma.customer.count({ where: { ...scope, createdAt: { gte: startOfMonth } } }),
      prisma.customer.count({ where: { ...scope, createdAt: { gte: startOfPrevMonth, lt: startOfMonth } } }),
      prisma.contactMessage.count({ where: { ...scope, status: 'UNREAD' } }),
      prisma.contactMessage.count({ where: scope }),
      prisma.booking.count({ where: { ...scope, status: 'PENDING' } }),
      prisma.booking.count({ where: { ...scope, scheduledAt: { gte: startOfToday, lt: new Date(startOfToday.getTime() + 864e5) } } }),
      prisma.product.findMany({ where: { ...scope, isActive: true }, select: { quantity: true, lowStockLevel: true, price: true, costPrice: true } }),
      prisma.order.aggregate({ _sum: { total: true }, where: { ...scope, status: { in: ['PAID', 'SHIPPED', 'COMPLETED'] } } }),
      prisma.order.aggregate({ _sum: { total: true }, where: { ...scope, status: { in: ['PAID', 'SHIPPED', 'COMPLETED'] }, createdAt: { gte: startOfMonth } } }),
      prisma.order.aggregate({ _sum: { total: true }, where: { ...scope, status: { in: ['PAID', 'SHIPPED', 'COMPLETED'] }, createdAt: { gte: startOfPrevMonth, lt: startOfMonth } } }),
      prisma.booking.aggregate({ _sum: { price: true }, where: { ...scope, status: 'COMPLETED' } }),
      prisma.booking.groupBy({ by: ['status'], _count: { _all: true }, where: scope }),
    ]);

    const lowStock = products.filter((p) => p.quantity <= p.lowStockLevel);
    const pct = (curr, prev) => (prev === 0 ? (curr > 0 ? 100 : 0) : round(((curr - prev) / prev) * 100));
    const revenueTotal = round((orderAgg._sum.total || 0) + (completedBookings._sum.price || 0));

    return {
      products: { total: totalProducts, active: activeProducts, inactive: totalProducts - activeProducts },
      bookings: {
        total: totalBookings, thisMonth: bookingsThisMonth, pending: pendingBookings, today: todayBookings,
        change: pct(bookingsThisMonth, bookingsPrevMonth),
        byStatus: Object.fromEntries(['PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']
          .map((s) => [s, statusGroups.find((g) => g.status === s)?._count._all || 0])),
      },
      customers: { total: totalCustomers, thisMonth: customersThisMonth, change: pct(customersThisMonth, customersPrevMonth) },
      messages: { total: totalMessages, unread: unreadMessages },
      inventory: {
        lowStockCount: lowStock.length,
        outOfStock: products.filter((p) => p.quantity === 0).length,
        stockValue: round(products.reduce((s, p) => s + p.quantity * p.costPrice, 0)),
        retailValue: round(products.reduce((s, p) => s + p.quantity * p.price, 0)),
      },
      revenue: {
        enabled: true,
        total: revenueTotal,
        thisMonth: round(orderAggMonth._sum.total || 0),
        change: pct(orderAggMonth._sum.total || 0, orderAggPrev._sum.total || 0),
        serviceRevenue: round(completedBookings._sum.price || 0),
        productRevenue: round(orderAgg._sum.total || 0),
      },
      generatedAt: new Date().toISOString(),
    };
  });
  res.json({ success: true, data });
}));

// GET /api/dashboard/activity
router.get('/activity', protect, asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '15', 10), 50);
  const activities = await prisma.activity.findMany({
    where: tenantWhere(req), orderBy: { createdAt: 'desc' }, take: limit,
    include: { user: { select: { name: true, avatarUrl: true } } },
  });
  res.json({ success: true, data: activities });
}));

// GET /api/dashboard/upcoming
router.get('/upcoming', protect, asyncHandler(async (req, res) => {
  const bookings = await prisma.booking.findMany({
    where: { ...tenantWhere(req), scheduledAt: { gte: new Date() }, status: { in: ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] } },
    orderBy: { scheduledAt: 'asc' }, take: 8,
    include: { customer: { select: { name: true, phone: true } }, service: { select: { name: true } }, technician: { select: { name: true } } },
  });
  res.json({ success: true, data: bookings });
}));

// GET /api/dashboard/low-stock
router.get('/low-stock', protect, asyncHandler(async (req, res) => {
  const products = await prisma.product.findMany({
    where: { ...tenantWhere(req), isActive: true }, include: { category: { select: { name: true } } }, orderBy: { quantity: 'asc' },
  });
  res.json({ success: true, data: products.filter((p) => p.quantity <= p.lowStockLevel).slice(0, 10) });
}));

module.exports = router;
