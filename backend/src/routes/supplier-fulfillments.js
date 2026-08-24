/**
 * Supplier fulfilment / dropshipping API.
 *
 *   GET    /api/supplier-fulfillments                     list + filters
 *   GET    /api/supplier-fulfillments/for-order/:orderId  an order's fulfilments
 *   POST   /api/supplier-fulfillments/ensure              raise fulfilments for an order
 *   GET    /api/supplier-fulfillments/:id                 detail
 *   POST   /api/supplier-fulfillments/:id/submit          transmit the purchase order
 *   PATCH  /api/supplier-fulfillments/:id/status          lifecycle transition
 *   POST   /api/supplier-fulfillments/:id/tracking        record tracking
 *   POST   /api/supplier-fulfillments/:id/refresh         poll the supplier
 *   POST   /api/supplier-fulfillments/:id/cancel          cancel
 *
 * This module never creates a customer order and never touches checkout or
 * payments — it consumes an existing `Order` and reports back into it.
 */
const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/supplierPermissions');
const { scopeTenant, tenantOf } = require('../lib/suppliers/tenant');
const { paginationSchema, buildOrderBy, meta } = require('../lib/pagination');
const { notFound } = require('../lib/errors');
const { audit, activity } = require('../lib/audit');
const fulfillment = require('../lib/suppliers/fulfillment');
const cache = require('../lib/cache');

const router = express.Router();
const SORTABLE = ['createdAt', 'updatedAt', 'status', 'submittedAt', 'shippedAt', 'deliveredAt'];

const include = {
  supplier: { select: { id: true, name: true, code: true, country: true, currency: true } },
  order: {
    select: {
      id: true, reference: true, status: true, paymentStatus: true, total: true, createdAt: true,
      customer: { select: { id: true, name: true, email: true } },
      shippingName: true, shippingCity: true, shippingCountry: true,
    },
  },
  items: { include: { supplierProduct: { select: { id: true, supplierSku: true, name: true, restricted: true, restrictionType: true } } } },
};

const shape = (f) => ({
  ...f,
  shipTo: (() => { try { return JSON.parse(f.shipTo || '{}'); } catch { return {}; } })(),
});

router.use(protect, scopeTenant);

// GET /api/supplier-fulfillments
router.get('/', requirePermission('suppliers.view'), validate(paginationSchema.extend({
  supplierId: z.string().optional(),
  orderId: z.string().optional(),
  status: z.string().optional(),
  transmissionStatus: z.string().optional(),
}), 'query'), asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const tenantId = tenantOf(req);
  const where = { tenantId };
  if (q.supplierId) where.supplierId = q.supplierId;
  if (q.orderId) where.orderId = q.orderId;
  if (q.status) where.status = { in: q.status.split(',').map((s) => s.toUpperCase()).filter((s) => fulfillment.STATUSES.includes(s)) };
  if (q.transmissionStatus) where.transmissionStatus = q.transmissionStatus.toUpperCase();
  if (q.search) {
    where.OR = [
      { supplierOrderId: { contains: q.search } },
      { trackingNumber: { contains: q.search } },
      { order: { reference: { contains: q.search.toUpperCase() } } },
    ];
  }

  const orderBy = buildOrderBy(q.sort, q.order, SORTABLE);
  const [items, total, counts] = await Promise.all([
    prisma.supplierFulfillment.findMany({ where, orderBy, skip: (q.page - 1) * q.limit, take: q.limit, include }),
    prisma.supplierFulfillment.count({ where }),
    prisma.supplierFulfillment.groupBy({ by: ['status'], where: { tenantId }, _count: { _all: true } }),
  ]);

  res.json({
    success: true,
    data: items.map(shape),
    meta: { ...meta(total, q.page, q.limit), summary: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) },
  });
}));

// GET /api/supplier-fulfillments/for-order/:orderId
router.get('/for-order/:orderId', requirePermission('suppliers.view'), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const items = await fulfillment.forOrder({ tenantId, orderId: req.params.orderId });
  res.json({ success: true, data: items.map(shape) });
}));

// POST /api/supplier-fulfillments/ensure
router.post('/ensure', requirePermission('fulfillment.manage'), validate(z.object({
  orderId: z.string().uuid(), reason: z.string().trim().max(400).optional(),
})), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const result = await fulfillment.ensureForOrder({ tenantId, orderId: req.body.orderId, actorId: req.user.id, reason: req.body.reason });
  cache.invalidate('stats');
  if (result.fulfillments.length) {
    await audit(req, 'FULFILLMENT_CREATE', 'SupplierFulfillment', null, {
      orderId: req.body.orderId, created: result.fulfillments.length, skipped: result.skipped.length,
    });
    await activity(req.user.id, 'supplier', `${req.user.name} raised ${result.fulfillments.length} supplier fulfilment(s)`);
  }
  res.status(201).json({
    success: true,
    data: { fulfillments: result.fulfillments.map(shape), skipped: result.skipped },
    message: result.fulfillments.length
      ? `${result.fulfillments.length} fulfilment(s) ready for supplier submission.`
      : (result.skipped.length
        ? 'No supplier fulfilment could be raised.'
        : 'Every line in this order is covered by N&D stock — no supplier fulfilment needed.'),
  });
}));

// GET /api/supplier-fulfillments/:id
router.get('/:id', requirePermission('suppliers.view'), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const record = await prisma.supplierFulfillment.findFirst({ where: { id: req.params.id, tenantId }, include });
  if (!record) throw notFound('Fulfilment not found');
  res.json({ success: true, data: shape(record) });
}));

// POST /api/supplier-fulfillments/:id/submit
router.post('/:id/submit', requirePermission('fulfillment.manage'), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const result = await fulfillment.submit({ tenantId, fulfillmentId: req.params.id, actorId: req.user.id });
  cache.invalidate('stats');
  await audit(req, 'FULFILLMENT_SUBMIT', 'SupplierFulfillment', req.params.id, {
    sent: result.sent, status: result.status, method: result.method || null,
  });
  res.json({ success: true, data: result, message: result.message });
}));

// PATCH /api/supplier-fulfillments/:id/status
router.patch('/:id/status', requirePermission('fulfillment.manage'), validate(z.object({
  status: z.enum(fulfillment.STATUSES),
  note: z.string().trim().max(1000).optional().nullable(),
  supplierOrderId: z.string().trim().max(120).optional().nullable(),
  trackingNumber: z.string().trim().max(120).optional().nullable(),
  carrier: z.string().trim().max(120).optional().nullable(),
  trackingUrl: z.string().trim().max(400).optional().nullable(),
})), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const body = req.body;
  if (body.supplierOrderId) {
    await prisma.supplierFulfillment.update({ where: { id: req.params.id }, data: { supplierOrderId: body.supplierOrderId } });
  }
  const updated = await fulfillment.setStatus({
    tenantId, fulfillmentId: req.params.id, status: body.status, actorId: req.user.id, note: body.note,
    tracking: body.trackingNumber ? { trackingNumber: body.trackingNumber, carrier: body.carrier, trackingUrl: body.trackingUrl } : null,
  });
  cache.invalidate('stats');
  await audit(req, 'FULFILLMENT_STATUS', 'SupplierFulfillment', req.params.id, { status: body.status });
  res.json({ success: true, data: shape(updated) });
}));

// POST /api/supplier-fulfillments/:id/tracking
router.post('/:id/tracking', requirePermission('fulfillment.manage'), validate(z.object({
  trackingNumber: z.string().trim().min(2).max(120),
  carrier: z.string().trim().max(120).optional().nullable(),
  trackingUrl: z.string().trim().max(400).optional().nullable(),
  status: z.enum(fulfillment.STATUSES).default('SHIPPED'),
})), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const updated = await fulfillment.recordTracking({ tenantId, fulfillmentId: req.params.id, actorId: req.user.id, ...req.body });
  cache.invalidate('stats');
  await audit(req, 'FULFILLMENT_TRACKING', 'SupplierFulfillment', req.params.id, {
    trackingNumber: req.body.trackingNumber, carrier: req.body.carrier,
  });
  await activity(req.user.id, 'supplier', `Tracking ${req.body.trackingNumber} recorded (${req.body.carrier || 'carrier not specified'})`);
  res.json({ success: true, data: shape(updated) });
}));

// POST /api/supplier-fulfillments/:id/refresh
router.post('/:id/refresh', requirePermission('fulfillment.manage'), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const result = await fulfillment.refreshFromSupplier({ tenantId, fulfillmentId: req.params.id });
  res.json({ success: true, data: result });
}));

// POST /api/supplier-fulfillments/:id/cancel
router.post('/:id/cancel', requirePermission('fulfillment.manage'), validate(z.object({
  reason: z.string().trim().min(2).max(400),
})), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const result = await fulfillment.cancel({ tenantId, fulfillmentId: req.params.id, reason: req.body.reason, actorId: req.user.id });
  cache.invalidate('stats');
  await audit(req, 'FULFILLMENT_CANCEL', 'SupplierFulfillment', req.params.id, {
    reason: req.body.reason, supplierNotified: result.supplierNotified,
  });
  // The caller must be able to tell whether the supplier was actually told —
  // a locally cancelled fulfilment that never reached the supplier is not the
  // same thing as a cancelled purchase order.
  res.json({
    success: true,
    data: {
      fulfillment: shape(result.fulfillment),
      supplierNotified: result.supplierNotified,
      supplierMessage: result.supplierMessage,
    },
    message: result.supplierMessage,
  });
}));

module.exports = router;
