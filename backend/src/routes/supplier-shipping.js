/**
 * Supplier shipping rules API.
 *
 *   GET    /api/supplier-shipping            list rules
 *   POST   /api/supplier-shipping            create a rule
 *   PUT    /api/supplier-shipping/:id        update
 *   DELETE /api/supplier-shipping/:id        delete
 *   POST   /api/supplier-shipping/quote      test a shipment against the rules
 *   GET    /api/supplier-shipping/restrictions  restricted-product overview
 *
 * There is deliberately no default worldwide rate: if no rule matches a
 * destination, the quote endpoint says the item cannot ship there. Carrier API
 * integrations slot in later as another connector type without changing this
 * surface.
 */
const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/supplierPermissions');
const { scopeTenant, tenantOf } = require('../lib/suppliers/tenant');
const { paginationSchema, meta } = require('../lib/pagination');
const { badRequest, notFound } = require('../lib/errors');
const { audit } = require('../lib/audit');
const shipping = require('../lib/suppliers/shipping');
const { expandCountries } = require('../lib/suppliers/countries');
const cache = require('../lib/cache');

const router = express.Router();

const jsonList = z.array(z.string().trim().max(60)).max(300);

const ruleBody = z.object({
  scope: z.enum(['GLOBAL', 'CATEGORY', 'SUPPLIER', 'PRODUCT']).default('SUPPLIER'),
  name: z.string().trim().min(2).max(140),
  supplierId: z.string().uuid().nullable().optional(),
  supplierProductId: z.string().uuid().nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
  countries: jsonList.optional().nullable(),
  excludedCountries: jsonList.optional().nullable(),
  regions: jsonList.optional().nullable(),
  method: z.string().trim().max(40).toUpperCase().default('STANDARD'),
  methodName: z.string().trim().max(120).default('Standard shipping'),
  carrier: z.string().trim().max(120).optional().nullable(),
  baseCost: z.coerce.number().min(0).default(0),
  perKgCost: z.coerce.number().min(0).default(0),
  perItemCost: z.coerce.number().min(0).default(0),
  freeOverAmount: z.coerce.number().min(0).nullable().optional(),
  minDays: z.coerce.number().int().min(0).max(365).default(0),
  maxDays: z.coerce.number().int().min(0).max(365).default(0),
  restricted: z.coerce.boolean().default(false),
  restrictionNote: z.string().trim().max(400).optional().nullable(),
  isActive: z.coerce.boolean().default(true),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
});

const shape = (rule) => ({
  ...rule,
  countries: (() => { try { return JSON.parse(rule.countries || '[]'); } catch { return []; } })(),
  excludedCountries: (() => { try { return JSON.parse(rule.excludedCountries || '[]'); } catch { return []; } })(),
  regions: (() => { try { return JSON.parse(rule.regions || '[]'); } catch { return []; } })(),
  countriesExpanded: expandCountries((() => { try { return JSON.parse(rule.countries || '[]'); } catch { return []; } })()),
});

/** Cross-checks scope against the ids the rule needs. */
function assertScopeConsistent(body) {
  if (body.scope === 'SUPPLIER' && !body.supplierId) throw badRequest('A supplier-scoped rule needs a supplier', [{ field: 'supplierId', message: 'Required' }]);
  if (body.scope === 'PRODUCT' && !body.supplierProductId) throw badRequest('A product-scoped rule needs a supplier product', [{ field: 'supplierProductId', message: 'Required' }]);
  if (body.scope === 'CATEGORY' && !body.categoryId) throw badRequest('A category-scoped rule needs a category', [{ field: 'categoryId', message: 'Required' }]);
  if (body.maxDays && body.minDays > body.maxDays) throw badRequest('Minimum days cannot exceed maximum days', [{ field: 'maxDays', message: 'Must be ≥ minimum days' }]);
}

const jsonOrNull = (value) => (value && value.length ? JSON.stringify(value.map((v) => String(v).toUpperCase())) : null);

router.use(protect, scopeTenant);

// GET /api/supplier-shipping
router.get('/', requirePermission('suppliers.view'), validate(paginationSchema.extend({
  scope: z.enum(['GLOBAL', 'CATEGORY', 'SUPPLIER', 'PRODUCT']).optional(),
  supplierId: z.string().optional(),
  active: z.enum(['true', 'false']).optional(),
  restricted: z.enum(['true', 'false']).optional(),
}), 'query'), asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const tenantId = tenantOf(req);
  const where = { tenantId };
  if (q.scope) where.scope = q.scope;
  if (q.supplierId) where.supplierId = q.supplierId;
  if (q.active !== undefined) where.isActive = q.active === 'true';
  if (q.restricted) where.restricted = q.restricted === 'true';
  if (q.search) where.OR = [{ name: { contains: q.search } }, { methodName: { contains: q.search } }, { carrier: { contains: q.search } }];

  const [items, total] = await Promise.all([
    prisma.supplierShippingRule.findMany({
      where, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      skip: (q.page - 1) * q.limit, take: q.limit,
      include: {
        supplier: { select: { id: true, name: true, code: true } },
        supplierProduct: { select: { id: true, supplierSku: true, name: true } },
      },
    }),
    prisma.supplierShippingRule.count({ where }),
  ]);
  res.json({ success: true, data: items.map(shape), meta: meta(total, q.page, q.limit) });
}));

// POST /api/supplier-shipping/quote
router.post('/quote', requirePermission('suppliers.view'), validate(z.object({
  country: z.string().trim().length(2).toUpperCase(),
  supplierId: z.string().uuid().optional(),
  supplierProductId: z.string().uuid().optional(),
  weightKg: z.coerce.number().min(0).default(0),
  quantity: z.coerce.number().int().min(1).default(1),
  subtotal: z.coerce.number().min(0).default(0),
})), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const { country, supplierId, supplierProductId, weightKg, quantity, subtotal } = req.body;

  let supplierProduct = null;
  let categoryId = null;
  let supplier = null;
  if (supplierProductId) {
    supplierProduct = await prisma.supplierProduct.findFirst({
      where: { id: supplierProductId, tenantId }, include: { supplier: true },
    });
    if (!supplierProduct) throw notFound('Supplier product not found');
    categoryId = supplierProduct.categoryId;
    supplier = supplierProduct.supplier;
  } else if (supplierId) {
    supplier = await prisma.supplier.findFirst({ where: { id: supplierId, tenantId } });
    if (!supplier) throw notFound('Supplier not found');
  }

  const result = await shipping.quote({
    tenantId, country, supplier, supplierId: supplier?.id || null,
    supplierProduct, categoryId, weightKg, quantity, subtotal,
  });
  res.json({ success: true, data: result });
}));

// POST /api/supplier-shipping
router.post('/', requirePermission('shipping.manage'), validate(ruleBody), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  assertScopeConsistent(req.body);
  const body = req.body;

  if (body.supplierId) {
    const supplier = await prisma.supplier.findFirst({ where: { id: body.supplierId, tenantId } });
    if (!supplier) throw badRequest('Supplier not found', [{ field: 'supplierId', message: 'Supplier not found' }]);
  }
  if (body.supplierProductId) {
    const sp = await prisma.supplierProduct.findFirst({ where: { id: body.supplierProductId, tenantId } });
    if (!sp) throw badRequest('Supplier product not found', [{ field: 'supplierProductId', message: 'Supplier product not found' }]);
  }

  const rule = await prisma.supplierShippingRule.create({
    data: {
      tenantId,
      scope: body.scope, name: body.name,
      supplierId: body.supplierId || null, supplierProductId: body.supplierProductId || null,
      categoryId: body.categoryId || null,
      countries: jsonOrNull(body.countries), excludedCountries: jsonOrNull(body.excludedCountries),
      regions: jsonOrNull(body.regions),
      method: body.method, methodName: body.methodName, carrier: body.carrier || null,
      baseCost: body.baseCost, perKgCost: body.perKgCost, perItemCost: body.perItemCost,
      freeOverAmount: body.freeOverAmount ?? null,
      minDays: body.minDays, maxDays: body.maxDays,
      restricted: body.restricted, restrictionNote: body.restrictionNote || null,
      isActive: body.isActive, sortOrder: body.sortOrder,
    },
  });
  cache.invalidate('supplier');
  await audit(req, 'CREATE', 'SupplierShippingRule', rule.id, { scope: rule.scope, method: rule.method });
  res.status(201).json({ success: true, data: shape(rule) });
}));

// PUT /api/supplier-shipping/:id
router.put('/:id', requirePermission('shipping.manage'), validate(ruleBody.partial()), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const existing = await prisma.supplierShippingRule.findFirst({ where: { id: req.params.id, tenantId } });
  if (!existing) throw notFound('Shipping rule not found');
  const merged = { ...existing, ...req.body };
  assertScopeConsistent(merged);

  const body = req.body;
  const data = {};
  for (const field of ['scope', 'name', 'method', 'methodName', 'carrier', 'baseCost', 'perKgCost',
    'perItemCost', 'freeOverAmount', 'minDays', 'maxDays', 'restricted', 'restrictionNote', 'isActive',
    'sortOrder', 'supplierId', 'supplierProductId', 'categoryId']) {
    if (body[field] !== undefined) data[field] = body[field] === '' ? null : body[field];
  }
  for (const field of ['countries', 'excludedCountries', 'regions']) {
    if (body[field] !== undefined) data[field] = jsonOrNull(body[field]);
  }

  const rule = await prisma.supplierShippingRule.update({ where: { id: existing.id }, data, include: { supplier: true, supplierProduct: true } });
  cache.invalidate('supplier');
  await audit(req, 'UPDATE', 'SupplierShippingRule', rule.id, data);
  res.json({ success: true, data: shape(rule) });
}));

// DELETE /api/supplier-shipping/:id
router.delete('/:id', requirePermission('shipping.manage'), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const existing = await prisma.supplierShippingRule.findFirst({ where: { id: req.params.id, tenantId } });
  if (!existing) throw notFound('Shipping rule not found');
  await prisma.supplierShippingRule.delete({ where: { id: existing.id } });
  cache.invalidate('supplier');
  await audit(req, 'DELETE', 'SupplierShippingRule', existing.id);
  res.json({ success: true, message: 'Shipping rule deleted' });
}));

// GET /api/supplier-shipping/restrictions — restricted goods overview
router.get('/restrictions', requirePermission('suppliers.view'), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const restricted = await prisma.supplierProduct.findMany({
    where: { tenantId, restricted: true },
    select: {
      id: true, supplierSku: true, name: true, restrictionType: true, restrictionNotes: true,
      documentationRequired: true, allowedCountries: true, blockedCountries: true,
      allowedShippingMethods: true, published: true,
      supplier: { select: { id: true, name: true, country: true } },
    },
    orderBy: { name: 'asc' },
  });
  const rules = await prisma.supplierShippingRule.findMany({
    where: { tenantId, restricted: true, isActive: true },
    select: { id: true, name: true, method: true, methodName: true, restrictionNote: true, countries: true, supplierId: true },
  });
  res.json({
    success: true,
    data: {
      products: restricted.map((p) => ({
        ...p,
        documentationRequired: (() => { try { return JSON.parse(p.documentationRequired || '[]'); } catch { return []; } })(),
        allowedCountries: (() => { try { return JSON.parse(p.allowedCountries || '[]'); } catch { return []; } })(),
        blockedCountries: (() => { try { return JSON.parse(p.blockedCountries || '[]'); } catch { return []; } })(),
        allowedShippingMethods: (() => { try { return JSON.parse(p.allowedShippingMethods || '[]'); } catch { return []; } })(),
      })),
      rules: rules.map(shape),
    },
  });
}));

module.exports = router;
