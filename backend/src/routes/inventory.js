const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect } = require('../middleware/auth');
const { paginationSchema, meta, toCsv } = require('../lib/pagination');
const { badRequest, notFound } = require('../lib/errors');
const { audit, activity } = require('../lib/audit');
const cache = require('../lib/cache');

const router = express.Router();

// GET /api/inventory — stock levels
router.get('/', protect, validate(paginationSchema.extend({
  status: z.enum(['all', 'low', 'out', 'ok']).default('all'),
  categoryId: z.string().optional(),
}), 'query'), asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const where = { isActive: true };
  if (q.categoryId) where.categoryId = q.categoryId;
  if (q.search) where.OR = [{ name: { contains: q.search } }, { sku: { contains: q.search } }];

  const all = await prisma.product.findMany({
    where,
    include: { category: { select: { name: true } } },
    orderBy: { quantity: 'asc' },
  });
  const decorated = all.map((p) => ({
    ...p,
    stockStatus: p.quantity === 0 ? 'out' : p.quantity <= p.lowStockLevel ? 'low' : 'ok',
    stockValue: Math.round(p.quantity * p.costPrice * 100) / 100,
  }));
  const filtered = q.status === 'all' ? decorated : decorated.filter((p) => p.stockStatus === q.status);
  const start = (q.page - 1) * q.limit;
  res.json({
    success: true,
    data: filtered.slice(start, start + q.limit),
    meta: {
      ...meta(filtered.length, q.page, q.limit),
      summary: {
        totalSkus: decorated.length,
        outOfStock: decorated.filter((p) => p.stockStatus === 'out').length,
        lowStock: decorated.filter((p) => p.stockStatus === 'low').length,
        totalUnits: decorated.reduce((s, p) => s + p.quantity, 0),
        stockValue: Math.round(decorated.reduce((s, p) => s + p.quantity * p.costPrice, 0) * 100) / 100,
        retailValue: Math.round(decorated.reduce((s, p) => s + p.quantity * p.price, 0) * 100) / 100,
      },
    },
  });
}));

// GET /api/inventory/alerts
router.get('/alerts', protect, asyncHandler(async (req, res) => {
  const products = await prisma.product.findMany({
    where: { isActive: true }, include: { category: { select: { name: true } } }, orderBy: { quantity: 'asc' },
  });
  const alerts = products
    .filter((p) => p.quantity <= p.lowStockLevel)
    .map((p) => ({
      id: p.id, sku: p.sku, name: p.name, category: p.category?.name,
      quantity: p.quantity, lowStockLevel: p.lowStockLevel,
      severity: p.quantity === 0 ? 'critical' : 'warning',
    }));
  res.json({ success: true, data: alerts, meta: { total: alerts.length } });
}));

// POST /api/inventory/adjust
router.post('/adjust', protect, validate(z.object({
  productId: z.string().uuid(),
  change: z.coerce.number().int().refine((n) => n !== 0, 'Change cannot be zero'),
  reason: z.string().trim().min(2).max(200),
})), asyncHandler(async (req, res) => {
  const { productId, change, reason } = req.body;
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) throw notFound('Product not found');
  const after = product.quantity + change;
  if (after < 0) throw badRequest(`Adjustment would make stock negative (current ${product.quantity})`);

  const [updated, adjustment] = await prisma.$transaction([
    prisma.product.update({ where: { id: productId }, data: { quantity: after } }),
    prisma.inventoryAdjustment.create({
      data: { productId, userId: req.user.id, change, before: product.quantity, after, reason },
    }),
  ]);
  cache.invalidate('stats');
  await audit(req, 'ADJUST_STOCK', 'Product', productId, { change, reason });
  await activity(req.user.id, 'inventory', `${req.user.name} adjusted ${product.name} by ${change > 0 ? '+' : ''}${change}`);
  res.json({ success: true, data: { product: updated, adjustment } });
}));

// POST /api/inventory/restock
router.post('/restock', protect, validate(z.object({
  productId: z.string().uuid(),
  quantity: z.coerce.number().int().min(1),
  unitCost: z.coerce.number().min(0).default(0),
  supplier: z.string().trim().max(120).optional().nullable(),
  reference: z.string().trim().max(80).optional().nullable(),
})), asyncHandler(async (req, res) => {
  const { productId, quantity, unitCost, supplier, reference } = req.body;
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) throw notFound('Product not found');

  const [updated, restock] = await prisma.$transaction([
    prisma.product.update({
      where: { id: productId },
      data: { quantity: product.quantity + quantity, ...(unitCost > 0 ? { costPrice: unitCost } : {}) },
    }),
    prisma.restock.create({ data: { productId, quantity, unitCost, supplier: supplier || null, reference: reference || null } }),
  ]);
  await prisma.inventoryAdjustment.create({
    data: { productId, userId: req.user.id, change: quantity, before: product.quantity, after: product.quantity + quantity, reason: `Restock${supplier ? ` from ${supplier}` : ''}` },
  });
  cache.invalidate('stats');
  await audit(req, 'RESTOCK', 'Product', productId, { quantity, supplier });
  await activity(req.user.id, 'inventory', `${req.user.name} restocked ${product.name} (+${quantity})`);
  res.status(201).json({ success: true, data: { product: updated, restock } });
}));

// GET /api/inventory/restocks
router.get('/restocks', protect, validate(paginationSchema.extend({ productId: z.string().optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const q = req.validatedQuery;
    const where = q.productId ? { productId: q.productId } : {};
    const [items, total] = await Promise.all([
      prisma.restock.findMany({
        where, orderBy: { receivedAt: q.order }, skip: (q.page - 1) * q.limit, take: q.limit,
        include: { product: { select: { name: true, sku: true } } },
      }),
      prisma.restock.count({ where }),
    ]);
    res.json({ success: true, data: items, meta: meta(total, q.page, q.limit) });
  }));

// GET /api/inventory/adjustments
router.get('/adjustments', protect, validate(paginationSchema.extend({ productId: z.string().optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const q = req.validatedQuery;
    const where = q.productId ? { productId: q.productId } : {};
    const [items, total] = await Promise.all([
      prisma.inventoryAdjustment.findMany({
        where, orderBy: { createdAt: q.order }, skip: (q.page - 1) * q.limit, take: q.limit,
        include: { product: { select: { name: true, sku: true } }, user: { select: { name: true } } },
      }),
      prisma.inventoryAdjustment.count({ where }),
    ]);
    res.json({ success: true, data: items, meta: meta(total, q.page, q.limit) });
  }));

// GET /api/inventory/report?format=json|csv
router.get('/report', protect, asyncHandler(async (req, res) => {
  const products = await prisma.product.findMany({
    where: { isActive: true }, include: { category: { select: { name: true } } }, orderBy: { name: 'asc' },
  });
  const rows = products.map((p) => ({
    sku: p.sku, name: p.name, category: p.category?.name || '',
    quantity: p.quantity, lowStockLevel: p.lowStockLevel,
    costPrice: p.costPrice, price: p.price,
    stockValue: Math.round(p.quantity * p.costPrice * 100) / 100,
    retailValue: Math.round(p.quantity * p.price * 100) / 100,
    status: p.quantity === 0 ? 'OUT OF STOCK' : p.quantity <= p.lowStockLevel ? 'LOW' : 'OK',
  }));
  if (req.query.format === 'csv') {
    res.header('Content-Type', 'text/csv');
    res.attachment('inventory-report.csv');
    return res.send(toCsv(rows, [
      { label: 'SKU', value: 'sku' }, { label: 'Product', value: 'name' }, { label: 'Category', value: 'category' },
      { label: 'Qty', value: 'quantity' }, { label: 'Reorder At', value: 'lowStockLevel' },
      { label: 'Cost', value: 'costPrice' }, { label: 'Price', value: 'price' },
      { label: 'Stock Value', value: 'stockValue' }, { label: 'Retail Value', value: 'retailValue' },
      { label: 'Status', value: 'status' },
    ]));
  }
  const byCategory = {};
  for (const r of rows) {
    const c = (byCategory[r.category] = byCategory[r.category] || { skus: 0, units: 0, stockValue: 0 });
    c.skus++; c.units += r.quantity; c.stockValue = Math.round((c.stockValue + r.stockValue) * 100) / 100;
  }
  res.json({ success: true, data: { rows, byCategory, totals: {
    skus: rows.length,
    units: rows.reduce((s, r) => s + r.quantity, 0),
    stockValue: Math.round(rows.reduce((s, r) => s + r.stockValue, 0) * 100) / 100,
    retailValue: Math.round(rows.reduce((s, r) => s + r.retailValue, 0) * 100) / 100,
  } } });
}));

module.exports = router;
