/**
 * Supplier management API.
 *
 *   GET    /api/suppliers                 list / search / filter / paginate
 *   GET    /api/suppliers/stats           marketplace dashboard aggregates
 *   GET    /api/suppliers/connectors      registered connector catalogue
 *   GET    /api/suppliers/types           supplier-type + shipping vocabulary
 *   GET    /api/suppliers/:id             supplier detail with live counters
 *   POST   /api/suppliers                 create
 *   PUT    /api/suppliers/:id             update
 *   PATCH  /api/suppliers/:id/status      ACTIVE | DISABLED
 *   POST   /api/suppliers/:id/archive     archive (soft, reversible)
 *   POST   /api/suppliers/:id/restore     restore from archive
 *   DELETE /api/suppliers/:id             delete when nothing depends on it
 *   GET    /api/suppliers/:id/products    its catalogue
 *   GET    /api/suppliers/:id/syncs       its synchronisation history
 *   GET    /api/suppliers/:id/fulfillments its dropship fulfilments
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
const registry = require('../lib/suppliers/registry');
const marketplaceSettings = require('../lib/suppliers/settings');
const { COUNTRIES, REGIONS, CURRENCIES, expandCountries } = require('../lib/suppliers/countries');
const { FULFILLMENT_TYPES, FULFILLMENT_LABELS, FULFILLMENT_DESCRIPTIONS } = require('../lib/suppliers/inventory');
const cache = require('../lib/cache');

const router = express.Router();
const SORTABLE = ['createdAt', 'updatedAt', 'name', 'code', 'country', 'status', 'type'];

const slugCode = (name) => String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'SUP';

const jsonList = z.array(z.string().trim().max(60)).max(300);

const supplierBody = z.object({
  name: z.string().trim().min(2).max(140),
  code: z.string().trim().max(24).optional(),
  country: z.string().trim().length(2).toUpperCase().optional().or(z.literal('')),
  currency: z.string().trim().length(3).toUpperCase().default('USD'),
  website: z.string().trim().max(300).optional().nullable(),
  email: z.string().trim().email().optional().nullable().or(z.literal('')),
  phone: z.string().trim().max(40).optional().nullable(),
  contactName: z.string().trim().max(140).optional().nullable(),
  accountRef: z.string().trim().max(80).optional().nullable(),
  type: z.string().trim().max(40).toUpperCase().default('GENERAL'),
  fulfillmentType: z.enum(FULFILLMENT_TYPES).default('HYBRID'),
  countriesServed: jsonList.optional().nullable(),
  blockedCountries: jsonList.optional().nullable(),
  shippingMethods: jsonList.optional().nullable(),
  leadTimeDays: z.coerce.number().int().min(0).max(365).default(0),
  minOrderValue: z.coerce.number().min(0).default(0),
  paymentTerms: z.string().trim().max(200).optional().nullable(),
  dropshipEnabled: z.coerce.boolean().default(true),
  markupType: z.enum(['PERCENT', 'FIXED']).optional().nullable(),
  markupValue: z.coerce.number().min(-100).max(100000).optional().nullable(),
  notes: z.string().trim().max(4000).optional().nullable(),
});

const listQuery = paginationSchema.extend({
  status: z.enum(['ACTIVE', 'DISABLED', 'ARCHIVED', 'ALL']).default('ACTIVE'),
  type: z.string().optional(),
  country: z.string().optional(),
  fulfillmentType: z.enum(FULFILLMENT_TYPES).optional(),
  connected: z.enum(['true', 'false']).optional(),
});

/** Strips everything that must never reach the browser. */
function safeIntegration(integration) {
  if (!integration) return null;
  let credentialFields = [];
  try { credentialFields = JSON.parse(integration.credentialFields || '[]'); } catch { credentialFields = []; }
  let capabilities = [];
  try { capabilities = JSON.parse(integration.capabilities || '[]'); } catch { capabilities = []; }
  const { credentialsCipher, ...rest } = integration;
  return { ...rest, credentialFields, capabilities, hasCredentials: credentialFields.length > 0 };
}

function safeSupplier(supplier) {
  const parse = (v) => { try { return JSON.parse(v || '[]'); } catch { return []; } };
  return {
    ...supplier,
    countriesServed: parse(supplier.countriesServed),
    blockedCountries: parse(supplier.blockedCountries),
    shippingMethods: parse(supplier.shippingMethods),
    integration: supplier.integration === undefined ? undefined : safeIntegration(supplier.integration),
  };
}

async function uniqueCode(tenantId, code, ignoreId) {
  let candidate = code;
  let n = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const found = await prisma.supplier.findFirst({ where: { tenantId, code: candidate } });
    if (!found || found.id === ignoreId) return candidate;
    candidate = `${code}-${++n}`.slice(0, 24);
  }
}

router.use(protect, scopeTenant);

/* ------------------------------------------------------------------ lists */

// GET /api/suppliers
router.get('/', requirePermission('suppliers.view'), validate(listQuery, 'query'), asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const tenantId = tenantOf(req);
  const where = { tenantId };
  if (q.status !== 'ALL') where.status = q.status;
  if (q.type) where.type = q.type;
  if (q.country) where.country = q.country.toUpperCase();
  if (q.fulfillmentType) where.fulfillmentType = q.fulfillmentType;
  if (q.search) {
    where.OR = [
      { name: { contains: q.search } },
      { code: { contains: q.search.toUpperCase() } },
      { email: { contains: q.search } },
      { contactName: { contains: q.search } },
      { accountRef: { contains: q.search } },
    ];
  }
  if (q.connected === 'true') where.integration = { status: 'CONNECTED' };
  if (q.connected === 'false') where.OR = [{ integration: null }, { integration: { status: { not: 'CONNECTED' } } }];

  const orderBy = buildOrderBy(q.sort, q.order, SORTABLE);
  const [items, total] = await Promise.all([
    prisma.supplier.findMany({
      where, orderBy, skip: (q.page - 1) * q.limit, take: q.limit,
      include: {
        integration: true,
        _count: { select: { products: true, fulfillments: true, syncs: true, shippingRules: true } },
      },
    }),
    prisma.supplier.count({ where }),
  ]);

  // Live counters the list view needs, in one pass.
  const ids = items.map((s) => s.id);
  const [published, mapped, syncIssues] = await Promise.all([
    prisma.supplierProduct.groupBy({ by: ['supplierId'], where: { supplierId: { in: ids }, published: true }, _count: { _all: true } }),
    prisma.supplierProduct.groupBy({ by: ['supplierId'], where: { supplierId: { in: ids }, mappingStatus: { not: 'UNMAPPED' } }, _count: { _all: true } }),
    prisma.supplierSync.groupBy({ by: ['supplierId'], where: { supplierId: { in: ids }, status: { in: ['FAILED', 'PARTIAL'] } }, _count: { _all: true } }),
  ]);
  const countOf = (rows, id) => rows.find((r) => r.supplierId === id)?._count?._all || 0;

  res.json({
    success: true,
    data: items.map((s) => ({
      ...safeSupplier(s),
      counts: {
        products: s._count.products,
        published: countOf(published, s.id),
        mapped: countOf(mapped, s.id),
        fulfillments: s._count.fulfillments,
        syncs: s._count.syncs,
        shippingRules: s._count.shippingRules,
        syncIssues: countOf(syncIssues, s.id),
      },
    })),
    meta: meta(total, q.page, q.limit),
  });
}));

// GET /api/suppliers/stats — Supplier Marketplace dashboard
router.get('/stats', requirePermission('suppliers.view'), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const data = await cache.wrap(`supplier:stats:${tenantId}`, 15000, async () => {
    const [
      suppliers, active, disabled, archived, integrations, connected,
      supplierProducts, published, unmapped, syncError,
      fulfillments, pendingFulfillments, shippedFulfillments, failedFulfillments,
      lastSync, shippingRules,
    ] = await Promise.all([
      prisma.supplier.count({ where: { tenantId } }),
      prisma.supplier.count({ where: { tenantId, status: 'ACTIVE' } }),
      prisma.supplier.count({ where: { tenantId, status: 'DISABLED' } }),
      prisma.supplier.count({ where: { tenantId, status: 'ARCHIVED' } }),
      prisma.supplierIntegration.count({ where: { tenantId } }),
      prisma.supplierIntegration.count({ where: { tenantId, status: 'CONNECTED' } }),
      prisma.supplierProduct.count({ where: { tenantId } }),
      prisma.supplierProduct.count({ where: { tenantId, published: true } }),
      prisma.supplierProduct.count({ where: { tenantId, mappingStatus: 'UNMAPPED' } }),
      prisma.supplierProduct.count({ where: { tenantId, syncStatus: 'ERROR' } }),
      prisma.supplierFulfillment.count({ where: { tenantId } }),
      prisma.supplierFulfillment.count({ where: { tenantId, status: { in: ['PENDING', 'READY'] } } }),
      prisma.supplierFulfillment.count({ where: { tenantId, status: { in: ['SHIPPED', 'PARTIALLY_SHIPPED', 'DELIVERED'] } } }),
      prisma.supplierFulfillment.count({ where: { tenantId, status: 'FAILED' } }),
      prisma.supplierSync.findFirst({ where: { tenantId }, orderBy: { startedAt: 'desc' } }),
      prisma.supplierShippingRule.count({ where: { tenantId, isActive: true } }),
    ]);

    const recentSyncs = await prisma.supplierSync.findMany({
      where: { tenantId }, orderBy: { startedAt: 'desc' }, take: 6,
      include: { supplier: { select: { id: true, name: true, code: true } } },
    });
    const supplierStockValue = await prisma.supplierProduct.aggregate({
      where: { tenantId, isActive: true }, _sum: { supplierCost: true }, _count: { _all: true },
    });
    const supplierUnits = await prisma.supplierProduct.aggregate({ where: { tenantId, isActive: true }, _sum: { stock: true } });

    return {
      suppliers: { total: suppliers, active, disabled, archived },
      integrations: { total: integrations, connected, notConnected: integrations - connected },
      products: { total: supplierProducts, published, unpublished: supplierProducts - published, unmapped, syncErrors: syncError },
      inventory: {
        supplierUnits: supplierUnits._sum.stock || 0,
        supplierCostValue: Math.round((supplierStockValue._sum.supplierCost || 0) * 100) / 100,
      },
      fulfillment: { total: fulfillments, pending: pendingFulfillments, shipped: shippedFulfillments, failed: failedFulfillments },
      shipping: { activeRules: shippingRules },
      lastSync: lastSync ? { id: lastSync.id, status: lastSync.status, type: lastSync.type, startedAt: lastSync.startedAt, finishedAt: lastSync.finishedAt } : null,
      recentSyncs,
    };
  });
  res.json({ success: true, data });
}));

// GET /api/suppliers/connectors — what can be installed
router.get('/connectors', requirePermission('suppliers.view'), asyncHandler(async (req, res) => {
  res.json({ success: true, data: registry.list(), meta: { capabilities: registry.capabilities() } });
}));

// GET /api/suppliers/types — vocabularies the forms need
router.get('/types', requirePermission('suppliers.view'), asyncHandler(async (req, res) => {
  const settings = await marketplaceSettings.read();
  res.json({
    success: true,
    data: {
      supplierTypes: settings.supplierTypes,
      fulfillmentTypes: FULFILLMENT_TYPES.map((id) => ({ id, label: FULFILLMENT_LABELS[id], description: FULFILLMENT_DESCRIPTIONS[id] })),
      shippingMethods: settings.shippingMethods,
      restrictionTypes: settings.restrictionTypes,
      countries: COUNTRIES,
      regions: Object.entries(REGIONS).map(([code, name]) => ({ code, name, countries: expandCountries([code]).length })),
      currencies: Object.entries(CURRENCIES).map(([code, [name, symbol]]) => ({ code, name, symbol })),
    },
  });
}));

/* ------------------------------------------------------------------ detail */

// GET /api/suppliers/:id
router.get('/:id', requirePermission('suppliers.view'), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const supplier = await prisma.supplier.findFirst({
    where: { id: req.params.id, tenantId },
    include: {
      integration: true,
      _count: { select: { products: true, fulfillments: true, syncs: true, imports: true, shippingRules: true, mappings: true } },
    },
  });
  if (!supplier) throw notFound('Supplier not found');

  const [published, syncSummary, fulfillmentSummary, recentSyncs] = await Promise.all([
    prisma.supplierProduct.count({ where: { supplierId: supplier.id, published: true } }),
    prisma.supplierSync.groupBy({ by: ['status'], where: { supplierId: supplier.id }, _count: { _all: true } }),
    prisma.supplierFulfillment.groupBy({ by: ['status'], where: { supplierId: supplier.id }, _count: { _all: true } }),
    prisma.supplierSync.findMany({ where: { supplierId: supplier.id }, orderBy: { startedAt: 'desc' }, take: 5 }),
  ]);

  res.json({
    success: true,
    data: {
      ...safeSupplier(supplier),
      publishedProducts: published,
      syncSummary: Object.fromEntries(syncSummary.map((r) => [r.status, r._count._all])),
      fulfillmentSummary: Object.fromEntries(fulfillmentSummary.map((r) => [r.status, r._count._all])),
      recentSyncs,
    },
  });
}));

/* ------------------------------------------------------------------ create */

// POST /api/suppliers
router.post('/', requirePermission('suppliers.manage'), validate(supplierBody), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const body = req.body;
  const code = await uniqueCode(tenantId, (body.code || slugCode(body.name)).toUpperCase());

  // `type` is intentionally a free-form string rather than an enum: the
  // vocabulary in settings.supplierTypes is offered by the UI, but a business
  // can introduce a new trade ("SOLAR", "ELEVATORS") without a code change.

  const supplier = await prisma.supplier.create({
    data: {
      tenantId,
      name: body.name,
      code,
      country: (body.country || '').toUpperCase(),
      currency: body.currency,
      website: body.website || null,
      email: body.email || null,
      phone: body.phone || null,
      contactName: body.contactName || null,
      accountRef: body.accountRef || null,
      type: body.type,
      fulfillmentType: body.fulfillmentType,
      status: 'ACTIVE',
      countriesServed: body.countriesServed ? JSON.stringify(body.countriesServed.map((c) => c.toUpperCase())) : null,
      blockedCountries: body.blockedCountries ? JSON.stringify(body.blockedCountries.map((c) => c.toUpperCase())) : null,
      shippingMethods: body.shippingMethods ? JSON.stringify(body.shippingMethods.map((c) => c.toUpperCase())) : null,
      leadTimeDays: body.leadTimeDays,
      minOrderValue: body.minOrderValue,
      paymentTerms: body.paymentTerms || null,
      dropshipEnabled: body.dropshipEnabled,
      markupType: body.markupType || null,
      markupValue: body.markupValue ?? null,
      notes: body.notes || null,
    },
  });
  cache.invalidate('supplier');
  cache.invalidate('stats');
  await audit(req, 'CREATE', 'Supplier', supplier.id, { name: supplier.name, code });
  await activity(req.user.id, 'supplier', `${req.user.name} added supplier ${supplier.name}`);
  res.status(201).json({ success: true, data: safeSupplier(supplier) });
}));

/* ------------------------------------------------------------------ update */

// PUT /api/suppliers/:id
router.put('/:id', requirePermission('suppliers.manage'), validate(supplierBody.partial()), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const existing = await prisma.supplier.findFirst({ where: { id: req.params.id, tenantId } });
  if (!existing) throw notFound('Supplier not found');
  const body = req.body;

  const data = {};
  for (const field of ['name', 'currency', 'website', 'email', 'phone', 'contactName', 'accountRef',
    'type', 'fulfillmentType', 'leadTimeDays', 'minOrderValue', 'paymentTerms', 'dropshipEnabled', 'notes']) {
    if (body[field] !== undefined) data[field] = body[field] === '' ? null : body[field];
  }
  if (body.country !== undefined) data.country = String(body.country || '').toUpperCase();
  if (body.code !== undefined && body.code) data.code = await uniqueCode(tenantId, body.code.toUpperCase(), existing.id);
  if (body.markupType !== undefined) data.markupType = body.markupType || null;
  if (body.markupValue !== undefined) data.markupValue = body.markupValue ?? null;
  for (const field of ['countriesServed', 'blockedCountries', 'shippingMethods']) {
    if (body[field] !== undefined) {
      data[field] = body[field] && body[field].length
        ? JSON.stringify(body[field].map((c) => String(c).toUpperCase()))
        : null;
    }
  }

  const supplier = await prisma.supplier.update({ where: { id: existing.id }, data, include: { integration: true } });

  // A supplier-level markup change must flow through to the products that rely
  // on it, otherwise the storefront would keep the stale price.
  if (body.markupType !== undefined || body.markupValue !== undefined) {
    const repriced = await repriceSupplierProducts(tenantId, supplier.id);
    if (repriced) await activity(req.user.id, 'supplier', `Repriced ${repriced} product(s) for ${supplier.name}`);
  }

  cache.invalidate('supplier');
  cache.invalidate('stats');
  await audit(req, 'UPDATE', 'Supplier', supplier.id, data);
  await activity(req.user.id, 'supplier', `${req.user.name} updated supplier ${supplier.name}`);
  res.json({ success: true, data: safeSupplier(supplier) });
}));

async function repriceSupplierProducts(tenantId, supplierId) {
  const { reprice } = require('../lib/suppliers/catalogue');
  const products = await prisma.supplierProduct.findMany({
    where: { tenantId, supplierId, priceOverride: null }, select: { id: true },
  });
  for (const p of products) await reprice(p.id, { tenantId });
  return products.length;
}

// PATCH /api/suppliers/:id/status
router.patch('/:id/status', requirePermission('suppliers.manage'),
  validate(z.object({ status: z.enum(['ACTIVE', 'DISABLED']) })),
  asyncHandler(async (req, res) => {
    const tenantId = tenantOf(req);
    const existing = await prisma.supplier.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw notFound('Supplier not found');
    if (existing.status === 'ARCHIVED') throw badRequest('Restore the supplier from the archive before changing its status');

    if (req.body.status === 'DISABLED') {
      await prisma.supplierIntegration.updateMany({ where: { supplierId: existing.id }, data: { syncEnabled: false } });
    }
    const supplier = await prisma.supplier.update({
      where: { id: existing.id }, data: { status: req.body.status }, include: { integration: true },
    });
    cache.invalidate('supplier');
    await audit(req, 'STATUS_CHANGE', 'Supplier', supplier.id, { from: existing.status, to: supplier.status });
    await activity(req.user.id, 'supplier', `${req.user.name} ${req.body.status === 'DISABLED' ? 'disabled' : 'enabled'} supplier ${supplier.name}`);
    res.json({ success: true, data: safeSupplier(supplier) });
  }));

// POST /api/suppliers/:id/archive
router.post('/:id/archive', requirePermission('suppliers.manage'), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const existing = await prisma.supplier.findFirst({ where: { id: req.params.id, tenantId } });
  if (!existing) throw notFound('Supplier not found');
  if (existing.status === 'ARCHIVED') throw badRequest('Supplier is already archived');

  const supplier = await prisma.supplier.update({
    where: { id: existing.id },
    data: { status: 'ARCHIVED', archivedAt: new Date() },
    include: { integration: true },
  });
  await prisma.supplierIntegration.updateMany({ where: { supplierId: existing.id }, data: { syncEnabled: false } });
  cache.invalidate('supplier');
  await audit(req, 'ARCHIVE', 'Supplier', supplier.id);
  await activity(req.user.id, 'supplier', `${req.user.name} archived supplier ${supplier.name}`);
  res.json({ success: true, data: safeSupplier(supplier), message: `${supplier.name} archived — its catalogue stays intact and can be restored.` });
}));

// POST /api/suppliers/:id/restore
router.post('/:id/restore', requirePermission('suppliers.manage'), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const existing = await prisma.supplier.findFirst({ where: { id: req.params.id, tenantId } });
  if (!existing) throw notFound('Supplier not found');
  if (existing.status !== 'ARCHIVED') throw badRequest('Supplier is not archived');
  const supplier = await prisma.supplier.update({
    where: { id: existing.id }, data: { status: 'ACTIVE', archivedAt: null }, include: { integration: true },
  });
  cache.invalidate('supplier');
  await audit(req, 'RESTORE', 'Supplier', supplier.id);
  await activity(req.user.id, 'supplier', `${req.user.name} restored supplier ${supplier.name}`);
  res.json({ success: true, data: safeSupplier(supplier) });
}));

// DELETE /api/suppliers/:id
router.delete('/:id', requirePermission('suppliers.manage'), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const existing = await prisma.supplier.findFirst({
    where: { id: req.params.id, tenantId }, include: { _count: { select: { products: true, fulfillments: true } } },
  });
  if (!existing) throw notFound('Supplier not found');
  if (existing._count.fulfillments > 0) {
    // Fulfilment history is financial record — archive instead of deleting.
    const supplier = await prisma.supplier.update({
      where: { id: existing.id }, data: { status: 'ARCHIVED', archivedAt: new Date() },
    });
    await audit(req, 'ARCHIVE', 'Supplier', supplier.id, { reason: 'has fulfilment history' });
    return res.json({ success: true, message: 'This supplier has fulfilment history and was archived instead of deleted', data: safeSupplier(supplier) });
  }
  await prisma.supplier.delete({ where: { id: existing.id } });
  cache.invalidate('supplier');
  cache.invalidate('stats');
  await audit(req, 'DELETE', 'Supplier', existing.id, { name: existing.name });
  await activity(req.user.id, 'supplier', `${req.user.name} deleted supplier ${existing.name}`);
  res.json({ success: true, message: 'Supplier deleted' });
}));

/* ------------------------------------------------------- related collections */

// GET /api/suppliers/:id/products
router.get('/:id/products', requirePermission('suppliers.view'), validate(paginationSchema, 'query'),
  asyncHandler(async (req, res) => {
    const tenantId = tenantOf(req);
    const q = req.validatedQuery;
    const where = { tenantId, supplierId: req.params.id };
    if (q.search) where.OR = [{ supplierSku: { contains: q.search } }, { name: { contains: q.search } }, { brand: { contains: q.search } }];
    const [items, total] = await Promise.all([
      prisma.supplierProduct.findMany({
        where, orderBy: { createdAt: q.order }, skip: (q.page - 1) * q.limit, take: q.limit,
        include: { mapping: { include: { product: { select: { id: true, sku: true, name: true, quantity: true, price: true } } } } },
      }),
      prisma.supplierProduct.count({ where }),
    ]);
    res.json({ success: true, data: items, meta: meta(total, q.page, q.limit) });
  }));

// GET /api/suppliers/:id/syncs
router.get('/:id/syncs', requirePermission('suppliers.view'), validate(paginationSchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.validatedQuery;
    const where = { tenantId: tenantOf(req), supplierId: req.params.id };
    const [items, total] = await Promise.all([
      prisma.supplierSync.findMany({ where, orderBy: { startedAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }),
      prisma.supplierSync.count({ where }),
    ]);
    res.json({ success: true, data: items, meta: meta(total, q.page, q.limit) });
  }));

// GET /api/suppliers/:id/fulfillments
router.get('/:id/fulfillments', requirePermission('suppliers.view'), validate(paginationSchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.validatedQuery;
    const where = { tenantId: tenantOf(req), supplierId: req.params.id };
    const [items, total] = await Promise.all([
      prisma.supplierFulfillment.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit,
        include: {
          order: { select: { id: true, reference: true, status: true, total: true } },
          items: { select: { supplierSku: true, name: true, quantity: true } },
        },
      }),
      prisma.supplierFulfillment.count({ where }),
    ]);
    res.json({ success: true, data: items, meta: meta(total, q.page, q.limit) });
  }));

module.exports = router;
module.exports.safeSupplier = safeSupplier;
module.exports.safeIntegration = safeIntegration;
