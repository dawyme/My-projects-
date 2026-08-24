/**
 * Supplier products API — the catalogue as the supplier advertises it, kept
 * separate from N&D's own product records until an operator publishes.
 *
 *   GET    /api/supplier-products                 list (supplier cost / price /
 *                                                 stock / mapping / sync state)
 *   GET    /api/supplier-products/price-preview   what the markup engine will do
 *   GET    /api/supplier-products/:id             detail
 *   PATCH  /api/supplier-products/:id/pricing     override or clear the price
 *   POST   /api/supplier-products/:id/publish     publish to the storefront
 *   POST   /api/supplier-products/:id/unpublish   withdraw
 *   PATCH  /api/supplier-products/:id/status      enable / disable
 *   POST   /api/supplier-products/map             manual SKU → product mapping
 *   DELETE /api/supplier-products/:id/mapping     remove a mapping
 *   GET    /api/supplier-products/:id/history     per-record sync history
 *   POST   /api/supplier-products/bulk-publish    publish many at once
 *   POST   /api/supplier-products/bulk-unpublish
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
const { badRequest, notFound } = require('../lib/errors');
const { audit, activity } = require('../lib/audit');
const catalogue = require('../lib/suppliers/catalogue');
const { priceFor } = require('../lib/suppliers/markup');
const marketplaceSettings = require('../lib/suppliers/settings');
const { evaluateCountryAccess } = require('../lib/suppliers/countries');
const cache = require('../lib/cache');

const router = express.Router();
const SORTABLE = ['createdAt', 'updatedAt', 'supplierSku', 'name', 'supplierCost', 'sellingPrice', 'stock'];

const include = {
  supplier: { select: { id: true, name: true, code: true, country: true, currency: true, status: true, fulfillmentType: true, countriesServed: true, blockedCountries: true } },
  mapping: { include: { product: { select: { id: true, sku: true, name: true, price: true, quantity: true, supplierStock: true, fulfillmentType: true, isActive: true, slug: true } } } },
};

const parseJson = (value, fallback) => { try { return JSON.parse(value || 'null') ?? fallback; } catch { return fallback; } };

/** Shapes one row for the Supplier Products table. */
function row(sp) {
  const product = sp.mapping?.product || null;
  const localStock = product ? Math.max(0, Number(product.quantity) || 0) : 0;
  const supplierStock = Math.max(0, Number(sp.stock) || 0);
  const fulfillmentType = sp.fulfillmentType || sp.supplier?.fulfillmentType || 'LOCAL';
  const usesSupplier = fulfillmentType === 'SUPPLIER_FULFILLED' || fulfillmentType === 'HYBRID';
  const available = fulfillmentType === 'LOCAL' ? localStock : localStock + supplierStock;
  const markup = sp.supplierCost > 0 ? Math.round(((sp.sellingPrice - sp.supplierCost) / sp.supplierCost) * 1000) / 10 : 0;

  return {
    id: sp.id,
    supplierId: sp.supplierId,
    supplierName: sp.supplier?.name || null,
    supplierCode: sp.supplier?.code || null,
    supplierSku: sp.supplierSku,
    internalSku: product?.sku || null,
    name: sp.name,
    brand: sp.brand,
    categoryText: sp.categoryText,
    supplierCost: sp.supplierCost,
    sellingPrice: sp.sellingPrice,
    priceOverride: sp.priceOverride,
    markupPercent: markup,
    markupApplied: parseJson(sp.markupApplied, null),
    supplierStock,
    localStock,
    availableStock: available,
    fulfillmentType,
    syncStatus: sp.syncStatus,
    lastSyncedAt: sp.lastSyncedAt,
    lastSyncError: sp.lastSyncError,
    mappingStatus: sp.mappingStatus,
    productId: product?.id || null,
    productName: product?.name || null,
    published: sp.published,
    isActive: sp.isActive,
    restricted: sp.restricted,
    restrictionType: sp.restrictionType,
    currency: sp.currency,
    msrp: sp.msrp,
    imageUrl: sp.imageUrl,
    stockStatus: sp.stockStatus,
  };
}

router.use(protect, scopeTenant);

// GET /api/supplier-products
router.get('/', requirePermission('suppliers.view'), validate(paginationSchema.extend({
  supplierId: z.string().optional(),
  published: z.enum(['true', 'false']).optional(),
  mapping: z.enum(['MAPPED', 'UNMAPPED', 'AUTO', 'MANUAL']).optional(),
  syncStatus: z.enum(['NEW', 'OK', 'CHANGED', 'ERROR']).optional(),
  fulfillmentType: z.enum(['LOCAL', 'SUPPLIER_FULFILLED', 'HYBRID']).optional(),
  restricted: z.enum(['true', 'false']).optional(),
  active: z.enum(['true', 'false']).optional(),
  minCost: z.coerce.number().optional(),
  maxCost: z.coerce.number().optional(),
}), 'query'), asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const tenantId = tenantOf(req);
  const where = { tenantId };
  if (q.supplierId) where.supplierId = q.supplierId;
  if (q.published) where.published = q.published === 'true';
  if (q.mapping === 'UNMAPPED') where.mappingStatus = 'UNMAPPED';
  else if (q.mapping === 'MAPPED') where.mappingStatus = { not: 'UNMAPPED' };
  else if (q.mapping) where.mappingStatus = q.mapping;
  if (q.syncStatus) where.syncStatus = q.syncStatus;
  if (q.fulfillmentType) where.OR = [{ fulfillmentType: q.fulfillmentType }, { fulfillmentType: null, supplier: { fulfillmentType: q.fulfillmentType } }];
  if (q.restricted) where.restricted = q.restricted === 'true';
  if (q.active !== undefined) where.isActive = q.active === 'true';
  if (q.minCost !== undefined || q.maxCost !== undefined) {
    where.supplierCost = {};
    if (q.minCost !== undefined) where.supplierCost.gte = q.minCost;
    if (q.maxCost !== undefined) where.supplierCost.lte = q.maxCost;
  }
  if (q.search) {
    where.AND = [{
      OR: [
        { supplierSku: { contains: q.search } },
        { name: { contains: q.search } },
        { brand: { contains: q.search } },
        { manufacturerPart: { contains: q.search } },
        { upc: { contains: q.search } },
      ],
    }];
  }

  const orderBy = buildOrderBy(q.sort, q.order, SORTABLE);
  const [items, total] = await Promise.all([
    prisma.supplierProduct.findMany({
      where, orderBy, skip: (q.page - 1) * q.limit, take: q.limit, include,
    }),
    prisma.supplierProduct.count({ where }),
  ]);

  res.json({ success: true, data: items.map(row), meta: meta(total, q.page, q.limit) });
}));

// GET /api/supplier-products/price-preview
router.get('/price-preview', requirePermission('pricing.manage'), validate(z.object({
  supplierProductId: z.string().uuid().optional(),
  supplierId: z.string().uuid().optional(),
  cost: z.coerce.number().min(0).optional(),
  markupType: z.enum(['PERCENT', 'FIXED']).optional(),
  markupValue: z.coerce.number().optional(),
}), 'query'), asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const tenantId = tenantOf(req);
  const globalRule = await marketplaceSettings.globalMarkupRule();

  let supplierProduct = null;
  let supplier = null;
  if (q.supplierProductId) {
    supplierProduct = await prisma.supplierProduct.findFirst({ where: { id: q.supplierProductId, tenantId }, include: { supplier: true } });
    if (!supplierProduct) throw notFound('Supplier product not found');
    supplier = supplierProduct.supplier;
  } else if (q.supplierId) {
    supplier = await prisma.supplier.findFirst({ where: { id: q.supplierId, tenantId } });
    if (!supplier) throw notFound('Supplier not found');
  }

  const categoryRules = supplierProduct?.categoryId
    ? await prisma.supplierMarkupRule.findMany({ where: { tenantId, scope: 'CATEGORY', categoryId: supplierProduct.categoryId, isActive: true } })
    : [];

  const probe = {
    ...(supplierProduct || {}),
    supplierCost: q.cost !== undefined ? q.cost : (supplierProduct?.supplierCost ?? 0),
    markupOverrideType: q.markupType !== undefined ? q.markupType : supplierProduct?.markupOverrideType,
    markupOverrideValue: q.markupValue !== undefined ? q.markupValue : supplierProduct?.markupOverrideValue,
  };

  const result = priceFor({ supplierProduct: probe, supplier: supplier || {}, categoryRules, globalRule });
  res.json({
    success: true,
    data: {
      cost: result.cost, price: result.price, margin: result.margin, marginPercent: result.marginPercent,
      rule: result.rule, overridden: result.overridden,
      chain: {
        product: supplierProduct?.markupOverrideType
          ? { type: supplierProduct.markupOverrideType, value: supplierProduct.markupOverrideValue }
          : null,
        category: categoryRules[0] ? { type: categoryRules[0].markupType, value: categoryRules[0].markupValue } : null,
        supplier: supplier?.markupType ? { type: supplier.markupType, value: supplier.markupValue } : null,
        global: { type: globalRule.markupType, value: globalRule.markupValue },
      },
    },
  });
}));

// GET /api/supplier-products/:id
router.get('/:id', requirePermission('suppliers.view'), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const sp = await prisma.supplierProduct.findFirst({
    where: { id: req.params.id, tenantId },
    include: {
      ...include,
      fulfillments: { include: { fulfillment: { select: { id: true, status: true, order: { select: { reference: true } } } } }, take: 10 },
      shippingRules: { take: 10 },
    },
  });
  if (!sp) throw notFound('Supplier product not found');

  const logs = await prisma.supplierSyncLog.findMany({
    where: { supplierProductId: sp.id }, orderBy: { createdAt: 'desc' }, take: 20,
    include: { sync: { select: { id: true, type: true, trigger: true, status: true, startedAt: true } } },
  });

  const access = evaluateCountryAccess({ destination: 'TT', supplier: sp.supplier, supplierProduct: sp });
  const parsed = (v) => parseJson(v, []);

  res.json({
    success: true,
    data: {
      ...row(sp),
      description: sp.description,
      manufacturerPart: sp.manufacturerPart,
      upc: sp.upc,
      gallery: parsed(sp.gallery),
      specs: parseJson(sp.specs, {}),
      weightKg: sp.weightKg, lengthCm: sp.lengthCm, widthCm: sp.widthCm, heightCm: sp.heightCm,
      restrictionNotes: sp.restrictionNotes,
      documentationRequired: parsed(sp.documentationRequired),
      allowedCountries: parsed(sp.allowedCountries),
      blockedCountries: parsed(sp.blockedCountries),
      allowedShippingMethods: parsed(sp.allowedShippingMethods),
      markupOverrideType: sp.markupOverrideType,
      markupOverrideValue: sp.markupOverrideValue,
      fulfillment: sp.fulfillments,
      shippingRules: sp.shippingRules,
      syncHistory: logs,
      shippingCheck: { country: 'TT', ...access },
    },
  });
}));

// PATCH /api/supplier-products/:id/pricing
router.patch('/:id/pricing', requirePermission('pricing.manage'), validate(z.object({
  priceOverride: z.coerce.number().min(0).nullable().optional(),
  markupOverrideType: z.enum(['PERCENT', 'FIXED']).nullable().optional(),
  markupOverrideValue: z.coerce.number().min(-100).max(100000).nullable().optional(),
  publish: z.coerce.boolean().optional(),
}),), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const sp = await prisma.supplierProduct.findFirst({ where: { id: req.params.id, tenantId }, include: { supplier: true } });
  if (!sp) throw notFound('Supplier product not found');

  const data = {};
  if (req.body.priceOverride !== undefined) data.priceOverride = req.body.priceOverride;
  if (req.body.markupOverrideType !== undefined) data.markupOverrideType = req.body.markupOverrideType;
  if (req.body.markupOverrideValue !== undefined) data.markupOverrideValue = req.body.markupOverrideValue;

  if ((data.markupOverrideType && data.markupOverrideValue === undefined && sp.markupOverrideValue === null)
    || (data.markupOverrideValue !== undefined && data.markupOverrideValue !== null && !data.markupOverrideType && !sp.markupOverrideType)) {
    throw badRequest('A markup override needs both a type and a value');
  }

  const patched = await prisma.supplierProduct.update({ where: { id: sp.id }, data });
  const price = await catalogue.reprice(sp.id, { tenantId });
  const updated = await prisma.supplierProduct.findFirst({ where: { id: sp.id }, include });

  if (req.body.publish && updated.mapping?.product) {
    await prisma.product.update({ where: { id: updated.mapping.product.id }, data: { price: price.price } });
    cache.invalidate('stats');
  }

  await audit(req, 'PRICING', 'SupplierProduct', sp.id, {
    priceOverride: req.body.priceOverride ?? null,
    markup: req.body.markupOverrideType ? `${req.body.markupOverrideType}:${req.body.markupOverrideValue}` : null,
  });
  res.json({ success: true, data: { ...row(updated), computedPrice: price.price, rule: price.rule } });
}));

// POST /api/supplier-products/:id/publish
router.post('/:id/publish', requirePermission('products.publish'), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const result = await catalogue.publish({ tenantId, supplierProductId: req.params.id, actorId: req.user.id });
  cache.invalidate('stats');
  await audit(req, 'PUBLISH', 'SupplierProduct', req.params.id, { productSku: result.product.sku, created: result.createdProduct });
  await activity(req.user.id, 'supplier', `${req.user.name} published ${result.product.name} from the supplier catalogue`);
  res.json({
    success: true,
    data: {
      productId: result.product.id, sku: result.product.sku, slug: result.product.slug,
      price: result.price.price, cost: result.price.cost, createdProduct: result.createdProduct,
      rule: result.price.rule,
    },
    message: result.createdProduct
      ? `Created catalogue product ${result.product.sku} and published it to the storefront.`
      : `Updated catalogue product ${result.product.sku} and published it to the storefront.`,
  });
}));

// POST /api/supplier-products/:id/unpublish
router.post('/:id/unpublish', requirePermission('products.publish'), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  await catalogue.unpublish({ tenantId, supplierProductId: req.params.id });
  cache.invalidate('stats');
  await audit(req, 'UNPUBLISH', 'SupplierProduct', req.params.id);
  await activity(req.user.id, 'supplier', `${req.user.name} unpublished a supplier product`);
  res.json({ success: true, message: 'Withdrawn from the storefront. N&D-owned stock on any pre-existing product was left untouched.' });
}));

// PATCH /api/supplier-products/:id/status
router.patch('/:id/status', requirePermission('suppliers.manage'), validate(z.object({
  isActive: z.coerce.boolean(), fulfillmentType: z.enum(['LOCAL', 'SUPPLIER_FULFILLED', 'HYBRID']).nullable().optional(),
})), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const sp = await prisma.supplierProduct.findFirst({ where: { id: req.params.id, tenantId } });
  if (!sp) throw notFound('Supplier product not found');
  const data = { isActive: req.body.isActive };
  if (req.body.fulfillmentType !== undefined) data.fulfillmentType = req.body.fulfillmentType;
  const updated = await prisma.supplierProduct.update({ where: { id: sp.id }, data, include });
  if (!req.body.isActive && sp.published) await catalogue.unpublish({ tenantId, supplierProductId: sp.id });
  cache.invalidate('stats');
  await audit(req, req.body.isActive ? 'ENABLE' : 'DISABLE', 'SupplierProduct', sp.id, { sku: sp.supplierSku });
  res.json({ success: true, data: row(updated) });
}));

// POST /api/supplier-products/map — manual supplier SKU → platform product
router.post('/map', requirePermission('products.publish'), validate(z.object({
  supplierProductId: z.string().uuid(), productId: z.string().uuid(),
})), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const mapping = await catalogue.mapToProduct({ tenantId, ...req.body });
  cache.invalidate('stats');
  await audit(req, 'MAP', 'SupplierProduct', req.body.supplierProductId, { productId: req.body.productId });
  await activity(req.user.id, 'supplier', `${req.user.name} mapped supplier SKU ${mapping.supplierSku} to ${mapping.product.sku}`);
  res.json({ success: true, data: mapping, message: `Mapped ${mapping.supplierSku} → ${mapping.product.sku}. The link persists through future synchronisations.` });
}));

// DELETE /api/supplier-products/:id/mapping
router.delete('/:id/mapping', requirePermission('products.publish'), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const result = await catalogue.unmap({ tenantId, supplierProductId: req.params.id });
  await audit(req, 'UNMAP', 'SupplierProduct', req.params.id);
  res.json({ success: true, data: result, message: `Unmapped from ${result.productSku}` });
}));

// GET /api/supplier-products/:id/history
router.get('/:id/history', requirePermission('suppliers.view'), validate(paginationSchema, 'query'),
  asyncHandler(async (req, res) => {
    const tenantId = tenantOf(req);
    const q = req.validatedQuery;
    const sp = await prisma.supplierProduct.findFirst({ where: { id: req.params.id, tenantId } });
    if (!sp) throw notFound('Supplier product not found');
    const where = { supplierProductId: sp.id };
    const [items, total] = await Promise.all([
      prisma.supplierSyncLog.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit,
        include: { sync: { select: { id: true, type: true, trigger: true, status: true, startedAt: true, finishedAt: true } } },
      }),
      prisma.supplierSyncLog.count({ where }),
    ]);
    res.json({ success: true, data: items, meta: meta(total, q.page, q.limit) });
  }));

// POST /api/supplier-products/bulk-publish
router.post('/bulk-publish', requirePermission('products.publish'),
  validate(z.object({ ids: z.array(z.string().uuid()).min(1).max(200) })),
  asyncHandler(async (req, res) => {
    const tenantId = tenantOf(req);
    const results = { published: 0, failed: 0, errors: [] };
    for (const id of req.body.ids) {
      try {
        await catalogue.publish({ tenantId, supplierProductId: id, actorId: req.user.id });
        results.published++;
      } catch (err) {
        results.failed++;
        if (results.errors.length < 20) results.errors.push({ id, message: err.message });
      }
    }
    cache.invalidate('stats');
    await audit(req, 'BULK_PUBLISH', 'SupplierProduct', null, { published: results.published, failed: results.failed });
    await activity(req.user.id, 'supplier', `${req.user.name} published ${results.published} supplier product(s)`);
    res.json({ success: true, data: results });
  }));

// POST /api/supplier-products/bulk-unpublish
router.post('/bulk-unpublish', requirePermission('products.publish'),
  validate(z.object({ ids: z.array(z.string().uuid()).min(1).max(200) })),
  asyncHandler(async (req, res) => {
    const tenantId = tenantOf(req);
    const results = { unpublished: 0, failed: 0, errors: [] };
    for (const id of req.body.ids) {
      try { await catalogue.unpublish({ tenantId, supplierProductId: id }); results.unpublished++; }
      catch (err) { results.failed++; if (results.errors.length < 20) results.errors.push({ id, message: err.message }); }
    }
    cache.invalidate('stats');
    await audit(req, 'BULK_UNPUBLISH', 'SupplierProduct', null, results);
    res.json({ success: true, data: results });
  }));

module.exports = router;
module.exports.row = row;
