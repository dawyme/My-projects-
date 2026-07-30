const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect, adminOnly } = require('../middleware/auth');
const { paginationSchema, meta } = require('../lib/pagination');
const { badRequest, notFound } = require('../lib/errors');
const { audit, activity } = require('../lib/audit');
const cache = require('../lib/cache');

const router = express.Router();
const STATUSES = ['PENDING', 'PAID', 'SHIPPED', 'COMPLETED', 'CANCELLED'];
const round = (n) => Math.round(n * 100) / 100;
const reference = () => `OR-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

const include = { customer: true, items: { include: { product: { select: { id: true, name: true, sku: true, imageUrl: true } } } } };

// GET /api/orders
router.get('/', protect, validate(paginationSchema.extend({ status: z.string().optional(), customerId: z.string().optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const q = req.validatedQuery;
    const where = {};
    if (q.status) where.status = { in: q.status.split(',').map((s) => s.toUpperCase()).filter((s) => STATUSES.includes(s)) };
    if (q.customerId) where.customerId = q.customerId;
    if (q.search) where.OR = [{ reference: { contains: q.search } }, { customer: { name: { contains: q.search } } }, { customer: { email: { contains: q.search } } }];
    const [items, total] = await Promise.all([
      prisma.order.findMany({ where, orderBy: { createdAt: q.order }, skip: (q.page - 1) * q.limit, take: q.limit, include }),
      prisma.order.count({ where }),
    ]);
    res.json({ success: true, data: items, meta: meta(total, q.page, q.limit) });
  }));

// GET /api/orders/:id
router.get('/:id', protect, asyncHandler(async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id }, include });
  if (!order) throw notFound('Order not found');
  res.json({ success: true, data: order });
}));

// POST /api/orders — creating an order decrements stock atomically
router.post('/', protect, validate(z.object({
  customerId: z.string().uuid(),
  status: z.enum(STATUSES).default('PENDING'),
  taxRate: z.coerce.number().min(0).max(100).default(0),
  items: z.array(z.object({
    productId: z.string().uuid(),
    quantity: z.coerce.number().int().min(1),
    unitPrice: z.coerce.number().min(0).optional(),
  })).min(1),
})), asyncHandler(async (req, res) => {
  const { customerId, status, taxRate, items } = req.body;
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) throw badRequest('Customer not found');

  const products = await prisma.product.findMany({ where: { id: { in: items.map((i) => i.productId) } } });
  const lines = items.map((i) => {
    const p = products.find((x) => x.id === i.productId);
    if (!p) throw badRequest(`Product ${i.productId} not found`);
    if (p.quantity < i.quantity) throw badRequest(`Insufficient stock for ${p.name} (${p.quantity} available)`);
    const unitPrice = i.unitPrice ?? p.price;
    return { productId: p.id, quantity: i.quantity, unitPrice, total: round(unitPrice * i.quantity) };
  });
  const subtotal = round(lines.reduce((s, l) => s + l.total, 0));
  const tax = round(subtotal * (taxRate / 100));

  const order = await prisma.$transaction(async (tx) => {
    const created = await tx.order.create({
      data: { reference: reference(), customerId, status, subtotal, tax, total: round(subtotal + tax), items: { create: lines } },
      include,
    });
    for (const l of lines) {
      await tx.product.update({ where: { id: l.productId }, data: { quantity: { decrement: l.quantity } } });
    }
    return created;
  });
  cache.invalidate('stats');
  await audit(req, 'CREATE', 'Order', order.id, { reference: order.reference, total: order.total });
  await activity(req.user.id, 'order', `${req.user.name} created order ${order.reference}`);
  res.status(201).json({ success: true, data: order });
}));

// PATCH /api/orders/:id/status
router.patch('/:id/status', protect, validate(z.object({ status: z.enum(STATUSES) })), asyncHandler(async (req, res) => {
  const existing = await prisma.order.findUnique({ where: { id: req.params.id }, include: { items: true } });
  if (!existing) throw notFound('Order not found');
  const order = await prisma.$transaction(async (tx) => {
    // Cancelling an order returns reserved stock.
    if (req.body.status === 'CANCELLED' && existing.status !== 'CANCELLED') {
      for (const item of existing.items) {
        await tx.product.update({ where: { id: item.productId }, data: { quantity: { increment: item.quantity } } });
      }
    }
    return tx.order.update({ where: { id: existing.id }, data: { status: req.body.status }, include });
  });
  cache.invalidate('stats');
  await audit(req, 'STATUS_CHANGE', 'Order', order.id, { from: existing.status, to: order.status });
  res.json({ success: true, data: order });
}));

// DELETE /api/orders/:id
router.delete('/:id', protect, adminOnly, asyncHandler(async (req, res) => {
  const existing = await prisma.order.findUnique({ where: { id: req.params.id }, include: { items: true } });
  if (!existing) throw notFound('Order not found');
  await prisma.$transaction(async (tx) => {
    if (existing.status !== 'CANCELLED') {
      for (const item of existing.items) {
        await tx.product.update({ where: { id: item.productId }, data: { quantity: { increment: item.quantity } } });
      }
    }
    await tx.order.delete({ where: { id: existing.id } });
  });
  cache.invalidate('stats');
  await audit(req, 'DELETE', 'Order', req.params.id);
  res.json({ success: true, message: 'Order deleted and stock restored' });
}));

module.exports = router;
