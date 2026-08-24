/**
 * Supplier Marketplace settings API — pricing defaults, automation, permission
 * policy, markup rules and reference vocabularies.
 *
 *   GET    /api/supplier-settings                          everything the page needs
 *   PUT    /api/supplier-settings                          update marketplace settings
 *   GET    /api/supplier-settings/permissions              policy per role
 *   PUT    /api/supplier-settings/permissions              override a role's grants
 *   GET    /api/supplier-settings/markup-rules             category + global rules
 *   POST   /api/supplier-settings/markup-rules             create a rule
 *   PUT    /api/supplier-settings/markup-rules/:id         update
 *   DELETE /api/supplier-settings/markup-rules/:id         delete
 *   POST   /api/supplier-settings/markup-preview           what a rule would do
 *
 * Secrets never appear here: integrations expose masked fingerprints only.
 */
const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect, adminOnly } = require('../middleware/auth');
const { requirePermission, PERMISSIONS, PERMISSION_IDS, permissionsFor } = require('../middleware/supplierPermissions');
const { scopeTenant, tenantOf } = require('../lib/suppliers/tenant');
const { badRequest, notFound } = require('../lib/errors');
const { audit } = require('../lib/audit');
const marketplaceSettings = require('../lib/suppliers/settings');
const { applyMarkup, priceFor } = require('../lib/suppliers/markup');
const { COUNTRIES, REGIONS, CURRENCIES } = require('../lib/suppliers/countries');
const scheduler = require('../lib/suppliers/scheduler');
const credentials = require('../lib/suppliers/credentials');
const registry = require('../lib/suppliers/registry');
const cache = require('../lib/cache');
const { publicSettings } = require('./supplier-syncs');

const router = express.Router();

const settingsBody = z.object({
  defaultMarkupType: z.enum(['PERCENT', 'FIXED']).optional(),
  defaultMarkupValue: z.coerce.number().min(-100).max(100000).optional(),
  roundTo: z.coerce.number().min(0).nullable().optional(),
  defaultCurrency: z.string().trim().length(3).toUpperCase().optional(),
  fxRates: z.record(z.coerce.number()).optional(),
  autoCreateProducts: z.coerce.boolean().optional(),
  autoPublish: z.coerce.boolean().optional(),
  defaultFulfillmentType: z.enum(['LOCAL', 'SUPPLIER_FULFILLED', 'HYBRID']).optional(),
  defaultCountry: z.string().trim().length(2).toUpperCase().optional(),
  autoSyncEnabled: z.coerce.boolean().optional(),
  syncIntervalMinutes: z.coerce.number().int().min(5).max(10080).optional(),
  batchSize: z.coerce.number().int().min(10).max(1000).optional(),
  maxSyncAttempts: z.coerce.number().int().min(1).max(10).optional(),
  syncConcurrency: z.coerce.number().int().min(1).max(8).optional(),
  autoFulfillOnPaid: z.coerce.boolean().optional(),
  autoSubmitOrders: z.coerce.boolean().optional(),
  defaultShippingMethod: z.string().trim().max(40).optional(),
  blockedCountries: z.array(z.string().trim().length(2).toUpperCase()).max(300).optional(),
  restrictUnmapped: z.coerce.boolean().optional(),
  supplierTypes: z.array(z.string().trim().max(40).toUpperCase()).min(1).max(60).optional(),
  restrictionTypes: z.array(z.string().trim().max(40).toUpperCase()).min(1).max(60).optional(),
  shippingMethods: z.array(z.object({
    code: z.string().trim().max(40).toUpperCase(), name: z.string().trim().max(120),
  })).min(1).max(40).optional(),
});

const markupRuleBody = z.object({
  scope: z.enum(['GLOBAL', 'CATEGORY']).default('CATEGORY'),
  categoryId: z.string().uuid().nullable().optional(),
  markupType: z.enum(['PERCENT', 'FIXED']).default('PERCENT'),
  markupValue: z.coerce.number().min(-100).max(100000).default(0),
  roundTo: z.coerce.number().min(0).nullable().optional(),
  isActive: z.coerce.boolean().default(true),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
});

router.use(protect, scopeTenant);

// GET /api/supplier-settings
router.get('/', requirePermission('suppliers.view'), asyncHandler(async (req, res) => {
  const settings = await marketplaceSettings.read();
  const grants = await permissionsFor(req.user.role);
  res.json({
    success: true,
    data: {
      settings: publicSettings(settings),
      permissions: {
        role: req.user.role,
        grants,
        available: PERMISSION_IDS.map((id) => ({ id, ...PERMISSIONS[id], granted: grants.includes('*') || grants.includes(id) })),
      },
      security: {
        dedicatedCredentialKey: credentials.dedicatedKeyConfigured(),
        credentialKeySource: process.env.SUPPLIER_CREDENTIALS_KEY ? 'SUPPLIER_CREDENTIALS_KEY' : 'JWT_SECRET (set SUPPLIER_CREDENTIALS_KEY for a dedicated key)',
        connectors: registry.list().map((c) => ({ id: c.id, label: c.label, installed: c.installed })),
      },
      scheduler: await scheduler.status(),
      reference: {
        countries: COUNTRIES.length,
        regions: Object.entries(REGIONS).map(([code, name]) => ({ code, name })),
        currencies: Object.entries(CURRENCIES).map(([code, [name, symbol]]) => ({ code, name, symbol })),
      },
    },
  });
}));

// PUT /api/supplier-settings
// Changing global marketplace defaults is business configuration, so it stays
// with administrators even though STAFF may run the syncs those settings drive.
router.put('/', adminOnly, validate(settingsBody), asyncHandler(async (req, res) => {
  const patch = { ...req.body };
  if (patch.roundTo !== undefined && patch.roundTo !== null && patch.roundTo <= 0) patch.roundTo = null;
  const settings = await marketplaceSettings.write(patch);
  if (settings.autoSyncEnabled) scheduler.start(); else scheduler.stop();
  cache.invalidate('supplier');
  cache.invalidate('stats');
  await audit(req, 'UPDATE', 'SupplierSettings', null, patch);
  res.json({ success: true, data: { settings: publicSettings(settings) } });
}));

// GET /api/supplier-settings/permissions
router.get('/permissions', adminOnly, asyncHandler(async (req, res) => {
  const settings = await marketplaceSettings.read();
  const roles = ['ADMIN', 'STAFF'];
  const out = {};
  for (const role of roles) out[role] = await permissionsFor(role);
  res.json({
    success: true,
    data: {
      policy: out,
      defaults: marketplaceSettings.DEFAULTS.permissions,
      available: PERMISSION_IDS.map((id) => ({ id, ...PERMISSIONS[id] })),
      editable: settings.permissions,
    },
  });
}));

// PUT /api/supplier-settings/permissions
router.put('/permissions', adminOnly, validate(z.object({
  role: z.enum(['ADMIN', 'STAFF']),
  permissions: z.array(z.union([z.literal('*'), z.enum(PERMISSION_IDS)])).max(PERMISSION_IDS.length + 1),
})), asyncHandler(async (req, res) => {
  const settings = await marketplaceSettings.read();
  const next = { ...(settings.permissions || {}), [req.body.role]: req.body.permissions };
  await marketplaceSettings.write({ permissions: next });
  await audit(req, 'PERMISSIONS', 'SupplierSettings', null, { role: req.body.role, permissions: req.body.permissions });
  res.json({ success: true, data: { role: req.body.role, permissions: req.body.permissions } });
}));

// GET /api/supplier-settings/markup-rules
router.get('/markup-rules', requirePermission('suppliers.view'), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const rules = await prisma.supplierMarkupRule.findMany({
    where: { tenantId }, orderBy: [{ scope: 'asc' }, { sortOrder: 'asc' }],
  });
  const globalRule = await marketplaceSettings.globalMarkupRule();
  const settings = await marketplaceSettings.read();
  res.json({
    success: true,
    data: {
      rules,
      globalDefault: { ...globalRule, source: 'marketplace settings' },
      effectiveGlobal: { type: settings.defaultMarkupType, value: settings.defaultMarkupValue },
    },
  });
}));

// POST /api/supplier-settings/markup-rules
router.post('/markup-rules', requirePermission('pricing.manage'), validate(markupRuleBody), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const body = req.body;
  if (body.scope === 'CATEGORY' && !body.categoryId) {
    throw badRequest('A category markup rule needs a category', [{ field: 'categoryId', message: 'Required' }]);
  }
  if (body.scope === 'GLOBAL') {
    const existing = await prisma.supplierMarkupRule.findFirst({ where: { tenantId, scope: 'GLOBAL' } });
    if (existing) throw badRequest('A global markup rule already exists — set the default in Settings instead');
  }
  if (body.scope === 'CATEGORY') {
    const existing = await prisma.supplierMarkupRule.findFirst({ where: { tenantId, scope: 'CATEGORY', categoryId: body.categoryId } });
    if (existing) throw badRequest('A markup rule already exists for that category');
  }
  const rule = await prisma.supplierMarkupRule.create({
    data: {
      tenantId, scope: body.scope, categoryId: body.scope === 'CATEGORY' ? body.categoryId : null,
      markupType: body.markupType, markupValue: body.markupValue, roundTo: body.roundTo ?? null,
      isActive: body.isActive, sortOrder: body.sortOrder,
    },
  });
  cache.invalidate('supplier');
  await audit(req, 'CREATE', 'SupplierMarkupRule', rule.id, { scope: rule.scope, type: rule.markupType, value: rule.markupValue });
  res.status(201).json({ success: true, data: rule });
}));

// PUT /api/supplier-settings/markup-rules/:id
router.put('/markup-rules/:id', requirePermission('pricing.manage'), validate(markupRuleBody.partial()), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const existing = await prisma.supplierMarkupRule.findFirst({ where: { id: req.params.id, tenantId } });
  if (!existing) throw notFound('Markup rule not found');
  const data = {};
  for (const field of ['markupType', 'markupValue', 'roundTo', 'isActive', 'sortOrder', 'scope', 'categoryId']) {
    if (req.body[field] !== undefined) data[field] = req.body[field] === '' ? null : req.body[field];
  }
  if (data.scope === 'CATEGORY' && !data.categoryId && !existing.categoryId) {
    throw badRequest('A category markup rule needs a category', [{ field: 'categoryId', message: 'Required' }]);
  }
  const rule = await prisma.supplierMarkupRule.update({ where: { id: existing.id }, data });
  cache.invalidate('supplier');
  await audit(req, 'UPDATE', 'SupplierMarkupRule', rule.id, data);
  res.json({ success: true, data: rule });
}));

// DELETE /api/supplier-settings/markup-rules/:id
router.delete('/markup-rules/:id', requirePermission('pricing.manage'), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const existing = await prisma.supplierMarkupRule.findFirst({ where: { id: req.params.id, tenantId } });
  if (!existing) throw notFound('Markup rule not found');
  await prisma.supplierMarkupRule.delete({ where: { id: existing.id } });
  cache.invalidate('supplier');
  await audit(req, 'DELETE', 'SupplierMarkupRule', existing.id);
  res.json({ success: true, message: 'Markup rule deleted' });
}));

// POST /api/supplier-settings/markup-preview
router.post('/markup-preview', requirePermission('pricing.manage'), validate(z.object({
  cost: z.coerce.number().min(0),
  markupType: z.enum(['PERCENT', 'FIXED']).default('PERCENT'),
  markupValue: z.coerce.number().min(-100).max(100000).default(0),
  roundTo: z.coerce.number().min(0).nullable().optional(),
})), asyncHandler(async (req, res) => {
  const { cost, markupType, markupValue, roundTo } = req.body;
  const price = applyMarkup(cost, { markupType, markupValue, roundTo });
  const margin = Math.round((price - cost) * 100) / 100;
  res.json({
    success: true,
    data: {
      cost, price, margin,
      marginPercent: price > 0 ? Math.round((margin / price) * 1000) / 10 : 0,
      explanation: markupType === 'FIXED'
        ? `${cost.toFixed(2)} + ${markupValue.toFixed(2)} fixed = ${price.toFixed(2)}`
        : `${cost.toFixed(2)} × (1 + ${markupValue}%) = ${price.toFixed(2)}`,
    },
  });
}));

module.exports = router;
module.exports.priceFor = priceFor;
