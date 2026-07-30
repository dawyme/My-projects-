const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { protect } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const cache = require('../lib/cache');

const router = express.Router();
const round = (n) => Math.round((n || 0) * 100) / 100;

function monthBuckets(months) {
  const now = new Date();
  const out = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleString('en', { month: 'short', year: '2-digit' }),
      start: d,
      end: new Date(d.getFullYear(), d.getMonth() + 1, 1),
    });
  }
  return out;
}
const bucketKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

const rangeQuery = z.object({ months: z.coerce.number().int().min(1).max(24).default(12) });

// GET /api/analytics/overview — every chart series in one payload
router.get('/overview', protect, validate(rangeQuery, 'query'), asyncHandler(async (req, res) => {
  const months = req.validatedQuery.months;
  const data = await cache.wrap(`stats:analytics:${months}`, 30000, async () => {
    const buckets = monthBuckets(months);
    const since = buckets[0].start;

    const [bookings, orders, customers, orderItems, categories] = await Promise.all([
      prisma.booking.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true, status: true, price: true } }),
      prisma.order.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true, total: true, status: true } }),
      prisma.customer.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true } }),
      prisma.orderItem.findMany({ include: { product: { select: { name: true, sku: true, categoryId: true } }, order: { select: { createdAt: true, status: true } } } }),
      prisma.category.findMany({ select: { id: true, name: true } }),
    ]);

    const empty = () => Object.fromEntries(buckets.map((b) => [b.key, 0]));
    const bookingSeries = empty();
    const completedSeries = empty();
    const cancelledSeries = empty();
    const serviceRevenue = empty();
    const salesSeries = empty();
    const salesRevenue = empty();
    const customerSeries = empty();

    for (const b of bookings) {
      const k = bucketKey(b.createdAt);
      if (!(k in bookingSeries)) continue;
      bookingSeries[k]++;
      if (b.status === 'COMPLETED') { completedSeries[k]++; serviceRevenue[k] = round(serviceRevenue[k] + b.price); }
      if (b.status === 'CANCELLED') cancelledSeries[k]++;
    }
    for (const o of orders) {
      const k = bucketKey(o.createdAt);
      if (!(k in salesSeries)) continue;
      salesSeries[k]++;
      if (['PAID', 'SHIPPED', 'COMPLETED'].includes(o.status)) salesRevenue[k] = round(salesRevenue[k] + o.total);
    }
    for (const c of customers) {
      const k = bucketKey(c.createdAt);
      if (k in customerSeries) customerSeries[k]++;
    }

    // cumulative customer growth
    const baseCustomers = await prisma.customer.count({ where: { createdAt: { lt: since } } });
    let running = baseCustomers;
    const cumulative = buckets.map((b) => (running += customerSeries[b.key]));

    // product performance
    const perProduct = new Map();
    const perCategory = new Map();
    for (const item of orderItems) {
      if (!['PAID', 'SHIPPED', 'COMPLETED'].includes(item.order?.status)) continue;
      const key = item.product?.sku || item.productId;
      const rec = perProduct.get(key) || { sku: key, name: item.product?.name || 'Unknown', units: 0, revenue: 0 };
      rec.units += item.quantity; rec.revenue = round(rec.revenue + item.total);
      perProduct.set(key, rec);
      const cid = item.product?.categoryId;
      if (cid) {
        const c = perCategory.get(cid) || { name: categories.find((x) => x.id === cid)?.name || 'Other', units: 0, revenue: 0 };
        c.units += item.quantity; c.revenue = round(c.revenue + item.total);
        perCategory.set(cid, c);
      }
    }

    const labels = buckets.map((b) => b.label);
    const values = (obj) => buckets.map((b) => round(obj[b.key]));

    return {
      labels,
      monthlyBookings: { total: values(bookingSeries), completed: values(completedSeries), cancelled: values(cancelledSeries) },
      sales: { orders: values(salesSeries), revenue: values(salesRevenue) },
      revenueTrend: {
        product: values(salesRevenue),
        service: values(serviceRevenue),
        total: buckets.map((b) => round(salesRevenue[b.key] + serviceRevenue[b.key])),
      },
      customerGrowth: { new: values(customerSeries), cumulative },
      productPerformance: [...perProduct.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 10),
      categoryPerformance: [...perCategory.values()].sort((a, b) => b.revenue - a.revenue),
      totals: {
        bookings: bookings.length,
        revenue: round(buckets.reduce((s, b) => s + salesRevenue[b.key] + serviceRevenue[b.key], 0)),
        newCustomers: customers.length,
        avgOrderValue: orders.length ? round(orders.reduce((s, o) => s + o.total, 0) / orders.length) : 0,
      },
    };
  });
  res.json({ success: true, data });
}));

// GET /api/analytics/technicians
router.get('/technicians', protect, asyncHandler(async (req, res) => {
  const techs = await prisma.user.findMany({
    where: { isActive: true },
    select: { id: true, name: true, role: true, bookings: { select: { status: true, price: true } } },
  });
  const data = techs.map((t) => ({
    id: t.id, name: t.name, role: t.role,
    assigned: t.bookings.length,
    completed: t.bookings.filter((b) => b.status === 'COMPLETED').length,
    revenue: round(t.bookings.filter((b) => b.status === 'COMPLETED').reduce((s, b) => s + b.price, 0)),
  })).sort((a, b) => b.completed - a.completed);
  res.json({ success: true, data });
}));

module.exports = router;
