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

const router = express.Router();
const round = (n) => Math.round(Number(n) * 100) / 100;
const saleNumber = () => `POS-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
const refundNumber = () => `REF-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

const paymentMethods = ['CASH','CARD','BANK_TRANSFER','STRIPE','PAYPAL','WIPAY','TILOPAY','OTHER'];

router.get('/products', protect, asyncHandler(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 50);
  const where = tenantWhere(req, { isActive: true });
  if (q) where.OR = [
    { name: { contains: q } },
    { sku: { contains: q } },
    { brand: { contains: q } },
  ];
  const products = await prisma.product.findMany({
    where, take: limit, orderBy: { name: 'asc' },
    select: { id: true, name: true, sku: true, brand: true, price: true, quantity: true, lowStockLevel: true, imageUrl: true, unit: true },
  });
  res.json({ success: true, data: products });
}));

router.get('/sales', protect, validate(paginationSchema.extend({ status: z.string().optional(), search: z.string().optional() }), 'query'), asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const where = tenantWhere(req);
  if (q.status) where.status = { in: q.status.split(',').filter(Boolean) };
  if (q.search) where.saleNumber = { contains: q.search };
  const [data, total] = await Promise.all([
    prisma.sale.findMany({ where, orderBy: { createdAt: q.order }, skip: (q.page - 1) * q.limit, take: q.limit,
      include: { customer: { select: { id: true, name: true, phone: true, email: true } }, cashier: { select: { id: true, name: true } }, lineItems: { include: { product: { select: { id: true, name: true, sku: true } } } } } }),
    prisma.sale.count({ where }),
  ]);
  res.json({ success: true, data, meta: meta(total, q.page, q.limit) });
}));

router.get('/sales/:id', protect, asyncHandler(async (req, res) => {
  const sale = await prisma.sale.findFirst({ where: tenantWhere(req, { id: req.params.id }), include: {
    customer: true, cashier: { select: { id: true, name: true, email: true } },
    lineItems: { include: { product: { select: { id: true, name: true, sku: true, price: true } }, refundLines: true } },
    refunds: { include: { createdBy: { select: { id: true, name: true } }, lineItems: true }, orderBy: { createdAt: 'desc' } },
  } });
  if (!sale) throw notFound('Sale not found');
  res.json({ success: true, data: sale });
}));

const saleSchema = z.object({
  customerId: z.string().uuid().nullable().optional(),
  items: z.array(z.object({ productId: z.string().uuid(), quantity: z.coerce.number().int().min(1) })).min(1),
  discount: z.coerce.number().min(0).default(0),
  taxRate: z.coerce.number().min(0).max(100).optional(),
  paymentMethod: z.enum(paymentMethods),
  paymentReference: z.string().trim().max(180).nullable().optional(),
  location: z.string().trim().max(120).nullable().optional(),
});

router.post('/sales', protect, validate(saleSchema), asyncHandler(async (req, res) => {
  const businessId = req.tenantId;
  const { customerId, items, discount, paymentMethod, paymentReference, location } = req.body;
  const business = await prisma.business.findUnique({ where: { id: businessId }, select: { taxRate: true } });
  if (!business) throw notFound('Business not found');
  if (customerId) {
    const customer = await prisma.customer.findFirst({ where: tenantWhere(req, { id: customerId }) });
    if (!customer) throw badRequest('Customer not found for this business');
  }
  const taxRate = req.body.taxRate == null ? Number(business.taxRate || 0) : Number(req.body.taxRate);
  const grouped = new Map();
  for (const item of items) grouped.set(item.productId, (grouped.get(item.productId) || 0) + item.quantity);
  const ids = [...grouped.keys()];

  let created;
  for (let attempt = 0; attempt < 5 && !created; attempt++) {
    try {
      const number = saleNumber();
      created = await prisma.$transaction(async (tx) => {
        const products = await tx.product.findMany({ where: tenantWhere(req, { id: { in: ids }, isActive: true }) });
        if (products.length !== ids.length) throw badRequest('One or more products are unavailable for this business');
        const byId = new Map(products.map((p) => [p.id, p]));
        const lines = [];
        for (const [productId, quantity] of grouped) {
          const p = byId.get(productId);
          if (p.quantity < quantity) throw badRequest(`Insufficient stock for ${p.name}: ${p.quantity} available`);
          const unitPrice = round(p.price);
          lines.push({ productId, quantity, unitPrice, total: round(unitPrice * quantity), before: p.quantity });
        }
        const subtotal = round(lines.reduce((s, l) => s + l.total, 0));
        const appliedDiscount = round(Math.min(Number(discount || 0), subtotal));
        const tax = round((subtotal - appliedDiscount) * (taxRate / 100));
        const total = round(subtotal - appliedDiscount + tax);
        for (const line of lines) {
          const updated = await tx.product.updateMany({ where: { id: line.productId, businessId, quantity: { gte: line.quantity } }, data: { quantity: { decrement: line.quantity } } });
          if (updated.count !== 1) throw badRequest(`Stock changed while completing ${byId.get(line.productId).name}; please retry`);
          await tx.inventoryAdjustment.create({ data: { productId: line.productId, businessId, userId: req.user.id, change: -line.quantity, before: line.before, after: line.before - line.quantity, reason: `POS sale ${number}` } });
        }
        const sale = await tx.sale.create({ data: { businessId, saleNumber: number, customerId: customerId || null, cashierId: req.user.id, status: 'COMPLETED', paymentMethod, paymentReference: paymentReference || null, subtotal, tax, discount: appliedDiscount, total, location: location || null, lineItems: { create: lines.map((l) => ({ businessId, productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice, total: l.total })) } } });
        return sale;
      });
    } catch (e) {
      if (e?.code === 'P2002') continue;
      throw e;
    }
  }
  if (!created) throw badRequest('Could not allocate a unique sale number');
  await audit(req, 'CREATE', 'Sale', created.id, { saleNumber: created.saleNumber, total: created.total });
  await activity(req.user.id, 'pos', `${req.user.name} completed POS sale ${created.saleNumber}`);
  const sale = await prisma.sale.findFirst({ where: tenantWhere(req, { id: created.id }), include: { lineItems: { include: { product: { select: { name: true, sku: true } } } }, customer: true } });
  res.status(201).json({ success: true, data: sale });
}));

router.get('/sales/:id/refunds', protect, asyncHandler(async (req, res) => {
  const sale = await prisma.sale.findFirst({ where: tenantWhere(req, { id: req.params.id }), select: { id: true } });
  if (!sale) throw notFound('Sale not found');
  const data = await prisma.saleRefund.findMany({ where: tenantWhere(req, { saleId: sale.id }), include: { lineItems: true, createdBy: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' } });
  res.json({ success: true, data });
}));

const refundSchema = z.object({ saleId: z.string().uuid(), items: z.array(z.object({ saleLineItemId: z.string().uuid(), quantity: z.coerce.number().int().min(1) })).min(1), reason: z.string().trim().max(300).nullable().optional() });
router.post('/refunds', protect, adminOnly, validate(refundSchema), asyncHandler(async (req, res) => {
  const businessId = req.tenantId;
  const sale = await prisma.sale.findFirst({ where: tenantWhere(req, { id: req.body.saleId }), include: { lineItems: true } });
  if (!sale) throw notFound('Sale not found');
  if (sale.status === 'VOIDED') throw badRequest('Voided sales cannot be refunded');
  const requested = new Map();
  for (const x of req.body.items) requested.set(x.saleLineItemId, (requested.get(x.saleLineItemId) || 0) + x.quantity);
  const lineMap = new Map(sale.lineItems.map((x) => [x.id, x]));
  const refundLines = [];
  for (const [id, qty] of requested) {
    const line = lineMap.get(id);
    if (!line) throw badRequest('Refund line does not belong to this sale');
    const available = line.quantity - line.refundedQty;
    if (qty > available) throw badRequest(`Only ${available} unit(s) remain refundable for this item`);
    refundLines.push({ line, quantity: qty, amount: round(line.unitPrice * qty) });
  }
  const amount = round(refundLines.reduce((s, x) => s + x.amount, 0));
  let refund;
  for (let attempt = 0; attempt < 5 && !refund; attempt++) {
    try {
      const number = refundNumber();
      refund = await prisma.$transaction(async (tx) => {
        for (const x of refundLines) {
          const current = await tx.saleLineItem.findFirst({ where: { id: x.line.id, businessId, saleId: sale.id } });
          if (!current || current.refundedQty + x.quantity > current.quantity) throw badRequest('Refund quantity changed; please retry');
          const p = await tx.product.findFirst({ where: { id: current.productId, businessId } });
          if (!p) throw badRequest('Product no longer belongs to this business');
          await tx.product.update({ where: { id: p.id }, data: { quantity: { increment: x.quantity } } });
          await tx.inventoryAdjustment.create({ data: { productId: p.id, businessId, userId: req.user.id, change: x.quantity, before: p.quantity, after: p.quantity + x.quantity, reason: `POS refund ${number}` } });
          await tx.saleLineItem.update({ where: { id: current.id }, data: { refundedQty: { increment: x.quantity } } });
        }
        const created = await tx.saleRefund.create({ data: { businessId, saleId: sale.id, refundNumber: number, amount, reason: req.body.reason || null, createdById: req.user.id, lineItems: { create: refundLines.map((x) => ({ businessId, saleLineItemId: x.line.id, quantity: x.quantity, amount: x.amount })) } } });
        const fresh = await tx.saleLineItem.findMany({ where: { saleId: sale.id, businessId: businessId } });
        const fully = fresh.every((x) => x.refundedQty >= x.quantity);
        await tx.sale.update({ where: { id: sale.id }, data: { status: fully ? 'REFUNDED' : 'PARTIALLY_REFUNDED' } });
        return created;
      });
    } catch (e) { if (e?.code === 'P2002') continue; throw e; }
  }
  if (!refund) throw badRequest('Could not allocate a unique refund number');
  await audit(req, 'REFUND', 'Sale', sale.id, { refundId: refund.id, amount });
  await activity(req.user.id, 'pos', `${req.user.name} refunded ${refund.refundNumber}`);
  res.status(201).json({ success: true, data: refund });
}));

router.get('/reports/summary', protect, asyncHandler(async (req, res) => {
  const where = tenantWhere(req);
  if (req.query.from || req.query.to) where.createdAt = {};
  if (req.query.from) { const d = new Date(req.query.from); if (Number.isNaN(d.getTime())) throw badRequest('Invalid from date'); where.createdAt.gte = d; }
  if (req.query.to) { const d = new Date(req.query.to); if (Number.isNaN(d.getTime())) throw badRequest('Invalid to date'); where.createdAt.lte = d; }
  const [count, grouped, refundAgg] = await Promise.all([
    prisma.sale.count({ where }),
    prisma.sale.groupBy({ by: ['status'], where, _count: { _all: true }, _sum: { total: true, subtotal: true, tax: true, discount: true } }),
    prisma.saleRefund.aggregate({ where: tenantWhere(req), _sum: { amount: true }, _count: { _all: true } }),
  ]);
  const gross = round(grouped.filter((x) => x.status === 'COMPLETED').reduce((s, x) => s + Number(x._sum.total || 0), 0));
  const refunds = round(Number(refundAgg._sum.amount || 0));
  res.json({ success: true, data: { saleCount: count, grossSales: gross, refundSales: refunds, refundCount: refundAgg._count._all, netSales: round(gross - refunds), byStatus: grouped } });
}));

module.exports = router;
