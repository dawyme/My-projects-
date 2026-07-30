const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect, adminOnly } = require('../middleware/auth');
const { paginationSchema, buildOrderBy, meta, toCsv } = require('../lib/pagination');
const { notFound } = require('../lib/errors');
const { audit, activity } = require('../lib/audit');

const router = express.Router();
const SORTABLE = ['createdAt', 'name', 'email', 'city'];

const body = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().email().max(180),
  phone: z.string().trim().max(40).optional().nullable(),
  company: z.string().trim().max(120).optional().nullable(),
  address: z.string().trim().max(300).optional().nullable(),
  city: z.string().trim().max(80).optional().nullable(),
  state: z.string().trim().max(80).optional().nullable(),
  postalCode: z.string().trim().max(20).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
});

const listQuery = paginationSchema.extend({
  city: z.string().optional(),
  format: z.enum(['json', 'csv']).default('json'),
});

// GET /api/customers
router.get('/', protect, validate(listQuery, 'query'), asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const where = {};
  if (q.search) {
    where.OR = [
      { name: { contains: q.search } }, { email: { contains: q.search } },
      { phone: { contains: q.search } }, { company: { contains: q.search } },
    ];
  }
  if (q.city) where.city = q.city;
  const orderBy = buildOrderBy(q.sort, q.order, SORTABLE);

  if (q.format === 'csv') {
    const rows = await prisma.customer.findMany({ where, orderBy });
    res.header('Content-Type', 'text/csv');
    res.attachment('customers.csv');
    return res.send(toCsv(rows, [
      { label: 'Name', value: 'name' }, { label: 'Email', value: 'email' },
      { label: 'Phone', value: 'phone' }, { label: 'Company', value: 'company' },
      { label: 'Address', value: 'address' }, { label: 'City', value: 'city' },
      { label: 'State', value: 'state' }, { label: 'Postal Code', value: 'postalCode' },
      { label: 'Created', value: 'createdAt' },
    ]));
  }

  const [items, total] = await Promise.all([
    prisma.customer.findMany({
      where, orderBy, skip: (q.page - 1) * q.limit, take: q.limit,
      include: { _count: { select: { bookings: true, orders: true, messages: true } } },
    }),
    prisma.customer.count({ where }),
  ]);
  res.json({ success: true, data: items, meta: meta(total, q.page, q.limit) });
}));

// GET /api/customers/:id — full profile with booking + purchase history
router.get('/:id', protect, asyncHandler(async (req, res) => {
  const customer = await prisma.customer.findUnique({
    where: { id: req.params.id },
    include: {
      bookings: {
        orderBy: { scheduledAt: 'desc' },
        include: { service: { select: { name: true } }, technician: { select: { name: true } } },
      },
      orders: { orderBy: { createdAt: 'desc' }, include: { items: { include: { product: { select: { name: true, sku: true } } } } } },
      messages: { orderBy: { createdAt: 'desc' }, take: 20 },
    },
  });
  if (!customer) throw notFound('Customer not found');
  const lifetimeValue = customer.orders.reduce((s, o) => s + o.total, 0)
    + customer.bookings.filter((b) => b.status === 'COMPLETED').reduce((s, b) => s + b.price, 0);
  res.json({ success: true, data: { ...customer, stats: {
    lifetimeValue: Math.round(lifetimeValue * 100) / 100,
    totalBookings: customer.bookings.length,
    completedBookings: customer.bookings.filter((b) => b.status === 'COMPLETED').length,
    totalOrders: customer.orders.length,
  } } });
}));

// POST /api/customers
router.post('/', protect, validate(body), asyncHandler(async (req, res) => {
  const customer = await prisma.customer.create({ data: { ...req.body, email: req.body.email.toLowerCase() } });
  await audit(req, 'CREATE', 'Customer', customer.id, { email: customer.email });
  await activity(req.user.id, 'customer', `${req.user.name} added customer ${customer.name}`);
  res.status(201).json({ success: true, data: customer });
}));

// PUT /api/customers/:id
router.put('/:id', protect, validate(body.partial()), asyncHandler(async (req, res) => {
  const data = { ...req.body };
  if (data.email) data.email = data.email.toLowerCase();
  const customer = await prisma.customer.update({ where: { id: req.params.id }, data });
  await audit(req, 'UPDATE', 'Customer', customer.id, data);
  res.json({ success: true, data: customer });
}));

// DELETE /api/customers/:id
router.delete('/:id', protect, adminOnly, asyncHandler(async (req, res) => {
  await prisma.customer.delete({ where: { id: req.params.id } });
  await audit(req, 'DELETE', 'Customer', req.params.id);
  await activity(req.user.id, 'customer', `${req.user.name} deleted a customer record`);
  res.json({ success: true, message: 'Customer deleted' });
}));

module.exports = router;
