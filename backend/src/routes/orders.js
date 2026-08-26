const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect, adminOnly } = require('../middleware/auth');
const { paginationSchema, meta } = require('../lib/pagination');
const { badRequest, notFound } = require('../lib/errors');
const { audit, activity } = require('../lib/audit');
const { tenantWhere } = require('../lib/tenant');
const cache = require('../lib/cache');
const orderFlow = require('../lib/order-flow');
const { availableStock, allocate } = require('../lib/suppliers/inventory');
const { tenantOf } = require('../lib/suppliers/tenant');

const router = express.Router();
const STATUSES = ['PENDING', 'PAID', 'SHIPPED', 'COMPLETED', 'CANCELLED'];
const round = (n) => Math.round(n * 100) / 100;
const reference = () => `OR-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

const include = { customer: true, items: { include: { product: { select: { id: true, name: true, sku: true, imageUrl: true } } } } };

// GET /api/orders
router.get('/', protect, validate(paginationSchema.extend({ status: z.string().optional(), customerId: z.string().optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const q = req.validatedQuery;
    const where = tenantWhere(req);
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
  const order = await prisma.order.findFirst({ where: tenantWhere(req, { id: req.params.id }), include });
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
  const customer = await prisma.customer.findFirst({ where: tenantWhere(req, { id: customerId }) });
  if (!customer) throw badRequest('Customer not found');

  const products = await prisma.product.findMany({ where: tenantWhere(req, { id: { in: items.map((i) => i.productId) } }) });
  // Availability = N&D stock plus, when the product opts in, its supplier's
  // advertised stock. Supplier units are never written into Product.quantity.
  const allocations = {};
  const lines = items.map((i) => {
    const p = products.find((x) => x.id === i.productId);
    if (!p) throw badRequest(`Product ${i.productId} not found`);
    const available = availableStock(p);
    if (available < i.quantity) throw badRequest(`Insufficient stock for ${p.name} (${available} available)`);
    allocations[p.id] = allocate(p, i.quantity);
    const unitPrice = i.unitPrice ?? p.price;
    return {
      productId: p.id, quantity: i.quantity, unitPrice,
      total: round(unitPrice * i.quantity), localQuantity: allocations[p.id].local,
    };
  });
  const subtotal = round(lines.reduce((s, l) => s + l.total, 0));
  const tax = round(subtotal * (taxRate / 100));

  const order = await prisma.$transaction(async (tx) => {
    const created = await tx.order.create({
      data: { reference: reference(), businessId: req.tenantId, customerId, status, subtotal, tax, total: round(subtotal + tax), items: { create: lines.map((l) => ({ ...l, businessId: req.tenantId })) } },
      include,
    });
    for (const l of lines) {
      const local = allocations[l.productId]?.local ?? l.quantity;
      if (local > 0) {
        await tx.product.update({ where: { id: l.productId }, data: { quantity: { decrement: local } } });
      }
    }
    return created;
  });
  cache.invalidate('stats');
  await audit(req, 'CREATE', 'Order', order.id, { reference: order.reference, total: order.total });
  await activity(req.user.id, 'order', `${req.user.name} created order ${order.reference}`);
  const supplierFlow = await orderFlow.afterOrderCreated({ req, orderId: order.id });
  res.status(201).json({
    success: true, data: order,
    supplierFulfillments: supplierFlow.fulfillments.map((f) => ({
      id: f.id, supplierId: f.supplierId, status: f.status, transmissionMethod: f.transmissionMethod,
    })),
  });
}));

// PATCH /api/orders/:id/status
router.patch('/:id/status', protect, validate(z.object({ status: z.enum(STATUSES) })), asyncHandler(async (req, res) => {
  const existing = await prisma.order.findFirst({ where: tenantWhere(req, { id: req.params.id }), include: { items: true } });
  if (!existing) throw notFound('Order not found');
  // Units a supplier is shipping were never taken from owned stock, so they
  // must not be returned to it when the order is cancelled.
  const restock = await orderFlow.restockableQuantities({
    tenantId: tenantOf(req), orderId: existing.id, items: existing.items,
  });
  const order = await prisma.$transaction(async (tx) => {
    // Cancelling an order returns reserved stock.
    if (req.body.status === 'CANCELLED' && existing.status !== 'CANCELLED') {
      for (const item of existing.items) {
        const back = restock.get(item.productId) ?? item.quantity;
        if (back > 0) await tx.product.update({ where: { id: item.productId }, data: { quantity: { increment: back } } });
      }
    }
    // Marking an order paid also records the payment if it was still pending.
    const paymentPatch = req.body.status === 'PAID' && existing.paymentStatus === 'PENDING'
      ? { paymentStatus: 'PAID', paidAt: existing.paidAt || new Date() }
      : {};
    return tx.order.update({
      where: { id: existing.id },
      data: { status: req.body.status, ...paymentPatch },
      include,
    });
  });
  cache.invalidate('stats');
  await audit(req, 'STATUS_CHANGE', 'Order', order.id, { from: existing.status, to: order.status });
  res.json({ success: true, data: order });
}));

// DELETE /api/orders/:id
router.delete('/:id', protect, adminOnly, asyncHandler(async (req, res) => {
  const existing = await prisma.order.findFirst({ where: tenantWhere(req, { id: req.params.id }), include: { items: true } });
  if (!existing) throw notFound('Order not found');
  const restockOnDelete = await orderFlow.restockableQuantities({
    tenantId: tenantOf(req), orderId: existing.id, items: existing.items,
  });
  await prisma.$transaction(async (tx) => {
    if (existing.status !== 'CANCELLED') {
      for (const item of existing.items) {
        const back = restockOnDelete.get(item.productId) ?? item.quantity;
        if (back > 0) await tx.product.update({ where: { id: item.productId }, data: { quantity: { increment: back } } });
      }
    }
    await tx.order.delete({ where: { id: existing.id } });
  });
  cache.invalidate('stats');
  await audit(req, 'DELETE', 'Order', req.params.id);
  res.json({ success: true, message: 'Order deleted and stock restored' });
}));

module.exports = router;
