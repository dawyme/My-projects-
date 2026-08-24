/**
 * Supplier integrations / plugins API.
 *
 *   GET    /api/supplier-integrations                list
 *   GET    /api/supplier-integrations/connectors     installable connectors
 *   GET    /api/supplier-integrations/:id            detail (secrets masked)
 *   POST   /api/supplier-integrations                create + store credentials
 *   PUT    /api/supplier-integrations/:id            update
 *   POST   /api/supplier-integrations/:id/test       real connection test
 *   POST   /api/supplier-integrations/:id/connect    establish session
 *   POST   /api/supplier-integrations/:id/disconnect tear down
 *   PATCH  /api/supplier-integrations/:id/enabled    enable / disable
 *   PATCH  /api/supplier-integrations/:id/schedule   schedule settings
 *   POST   /api/supplier-integrations/:id/suggest-mapping  auto field mapping
 *   DELETE /api/supplier-integrations/:id            remove
 *
 * Credential handling — the whole point of this file:
 *   • secrets arrive in the request body and are encrypted immediately
 *   • they are stored ONLY in `credentialsCipher` (AES-256-GCM)
 *   • responses carry `credentialFields` — name + masked fingerprint + when it
 *     was set. The plaintext is never serialised, never logged, never returned.
 *   • on update, omitting a field keeps the stored secret; sending `null`
 *     clears it.
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
const { audit, activity } = require('../lib/audit');
const registry = require('../lib/suppliers/registry');
const connections = require('../lib/suppliers/connections');
const syncEngine = require('../lib/suppliers/sync-engine');
const credentials = require('../lib/suppliers/credentials');
const { safeIntegration } = require('./suppliers');
const cache = require('../lib/cache');

const router = express.Router();

const integrationBody = z.object({
  supplierId: z.string().uuid(),
  name: z.string().trim().min(2).max(140),
  connectorType: z.string().trim().max(40).toUpperCase(),
  baseUrl: z.string().trim().max(400).optional().nullable(),
  authType: z.enum(['NONE', 'API_KEY', 'BASIC', 'BEARER', 'OAUTH2', 'SFTP']).default('NONE'),
  config: z.record(z.any()).optional().nullable(),
  capabilities: z.array(z.string()).optional().nullable(),
  credentials: z.record(z.union([z.string(), z.null()])).optional().nullable(),
  syncEnabled: z.coerce.boolean().default(false),
  syncIntervalMinutes: z.coerce.number().int().min(0).max(10080).default(0),
  syncTypes: z.array(z.enum(['CATALOG', 'PRODUCTS', 'INVENTORY', 'PRICING', 'FULL'])).optional().nullable(),
});

const updateBody = integrationBody.partial().omit({ supplierId: true });

router.use(protect, scopeTenant);

/** Recomputes + persists the capability snapshot for an integration. */
async function refreshCapabilities(tenantId, integration) {
  try {
    const detected = await connections.detectCapabilities({ tenantId, integrationId: integration.id });
    return prisma.supplierIntegration.update({
      where: { id: integration.id },
      data: { capabilities: JSON.stringify(detected.capabilities.filter((c) => c.available).map((c) => c.id)) },
    });
  } catch (err) {
    return prisma.supplierIntegration.update({
      where: { id: integration.id },
      data: { capabilities: JSON.stringify([]), lastError: err.message.slice(0, 400) },
    });
  }
}

/**
 * Merges an incoming `credentials` object with what is already stored.
 * Omitted keys keep their secret; explicit null clears it; '' is treated as
 * "no change" so a form that re-submits a masked field cannot wipe a secret.
 */
function mergeSecrets(existingPlain, incoming) {
  const next = { ...existingPlain };
  const submitted = {};
  for (const [key, value] of Object.entries(incoming || {})) {
    if (value === undefined || value === '') continue;
    if (value === null) { delete next[key]; continue; }
    next[key] = String(value);
    submitted[key] = String(value);
  }
  return { next, submitted };
}

// GET /api/supplier-integrations
router.get('/', requirePermission('suppliers.view'), validate(paginationSchema.extend({
  supplierId: z.string().optional(), status: z.string().optional(), connectorType: z.string().optional(),
}), 'query'), asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const tenantId = tenantOf(req);
  const where = { tenantId };
  if (q.supplierId) where.supplierId = q.supplierId;
  if (q.status) where.status = q.status.toUpperCase();
  if (q.connectorType) where.connectorType = q.connectorType.toUpperCase();
  if (q.search) where.OR = [{ name: { contains: q.search } }, { supplier: { name: { contains: q.search } } }];

  const [items, total] = await Promise.all([
    prisma.supplierIntegration.findMany({
      where, orderBy: { createdAt: q.order }, skip: (q.page - 1) * q.limit, take: q.limit,
      include: { supplier: { select: { id: true, name: true, code: true, status: true, country: true } } },
    }),
    prisma.supplierIntegration.count({ where }),
  ]);
  res.json({
    success: true,
    data: items.map((i) => ({
      ...safeIntegration(i),
      connector: registry.get(i.connectorType)
        ? { id: i.connectorType, label: registry.get(i.connectorType).label, transport: registry.get(i.connectorType).transport }
        : null,
    })),
    meta: meta(total, q.page, q.limit),
  });
}));

// GET /api/supplier-integrations/connectors
router.get('/connectors', requirePermission('suppliers.view'), asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: registry.list(),
    meta: { capabilities: registry.capabilities() },
  });
}));

// GET /api/supplier-integrations/:id
router.get('/:id', requirePermission('suppliers.view'), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const integration = await prisma.supplierIntegration.findFirst({
    where: { id: req.params.id, tenantId },
    include: {
      supplier: true,
      syncs: { orderBy: { startedAt: 'desc' }, take: 5 },
      imports: { orderBy: { createdAt: 'desc' }, take: 5 },
    },
  });
  if (!integration) throw notFound('Integration not found');

  const detected = await connections.detectCapabilities({ tenantId, integrationId: integration.id }).catch(() => null);
  const connector = registry.get(integration.connectorType);

  res.json({
    success: true,
    data: {
      ...safeIntegration(integration),
      connector: connector ? connector.describe() : null,
      capabilityMatrix: detected?.capabilities || [],
      missingCredentials: detected?.missingCredentials ?? true,
      dedicatedCredentialKey: credentials.dedicatedKeyConfigured(),
    },
  });
}));

// POST /api/supplier-integrations
router.post('/', requirePermission('integrations.manage'), validate(integrationBody), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const body = req.body;

  const Connector = registry.get(body.connectorType);
  if (!Connector) throw badRequest(`Unknown connector type "${body.connectorType}"`, [{ field: 'connectorType', message: 'Select one of the registered connectors' }]);
  if (!Connector.authTypes.includes(body.authType)) {
    throw badRequest(`${Connector.label} does not support ${body.authType} authentication`, [{ field: 'authType', message: `Supported: ${Connector.authTypes.join(', ')}` }]);
  }

  const supplier = await prisma.supplier.findFirst({ where: { id: body.supplierId, tenantId } });
  if (!supplier) throw badRequest('Supplier not found', [{ field: 'supplierId', message: 'Supplier not found' }]);

  const existing = await prisma.supplierIntegration.findFirst({ where: { supplierId: supplier.id } });
  if (existing) throw badRequest(`${supplier.name} already has an integration — edit it instead`, [{ field: 'supplierId', message: 'An integration already exists for this supplier' }]);

  const plain = {};
  for (const [key, value] of Object.entries(body.credentials || {})) {
    if (value !== null && value !== undefined && value !== '') plain[key] = String(value);
  }

  const integration = await prisma.supplierIntegration.create({
    data: {
      tenantId,
      supplierId: supplier.id,
      name: body.name,
      connectorType: body.connectorType,
      baseUrl: body.baseUrl || null,
      authType: body.authType,
      config: body.config ? JSON.stringify(body.config) : null,
      credentialsCipher: credentials.encryptSecrets(plain),
      credentialFields: JSON.stringify(credentials.describeFields(plain)),
      capabilities: JSON.stringify([]),
      // Nothing is ever reported as connected before a real test succeeds.
      status: Object.keys(plain).length ? 'CONFIGURED' : 'NOT_CONNECTED',
      syncEnabled: false,
      syncIntervalMinutes: body.syncIntervalMinutes,
      syncTypes: body.syncTypes ? JSON.stringify(body.syncTypes) : null,
    },
  });

  const refreshed = await refreshCapabilities(tenantId, integration);
  cache.invalidate('supplier');
  await audit(req, 'CREATE', 'SupplierIntegration', integration.id, {
    connectorType: integration.connectorType, supplier: supplier.name,
    credentialFields: Object.keys(plain), // names only — never values
  });
  await activity(req.user.id, 'supplier', `${req.user.name} added the ${Connector.label} integration for ${supplier.name}`);
  res.status(201).json({ success: true, data: safeIntegration(refreshed) });
}));

// PUT /api/supplier-integrations/:id
router.put('/:id', requirePermission('integrations.manage'), validate(updateBody), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const integration = await prisma.supplierIntegration.findFirst({ where: { id: req.params.id, tenantId } });
  if (!integration) throw notFound('Integration not found');
  const body = req.body;

  const data = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.baseUrl !== undefined) data.baseUrl = body.baseUrl || null;
  if (body.authType !== undefined) data.authType = body.authType;
  if (body.config !== undefined) data.config = body.config ? JSON.stringify(body.config) : null;
  if (body.syncIntervalMinutes !== undefined) data.syncIntervalMinutes = body.syncIntervalMinutes;
  if (body.syncTypes !== undefined) data.syncTypes = body.syncTypes ? JSON.stringify(body.syncTypes) : null;
  if (body.syncEnabled !== undefined) data.syncEnabled = Boolean(body.syncEnabled);
  if (body.connectorType !== undefined && body.connectorType !== integration.connectorType) {
    if (!registry.get(body.connectorType)) throw badRequest(`Unknown connector type "${body.connectorType}"`);
    data.connectorType = body.connectorType;
    // Changing transport invalidates any established session.
    data.status = 'NOT_CONNECTED';
    data.lastConnectedAt = null;
  }

  let secretNames = [];
  if (body.credentials !== undefined && body.credentials !== null) {
    let existingPlain = {};
    try { existingPlain = credentials.decryptSecrets(integration.credentialsCipher); } catch { existingPlain = {}; }
    const { next, submitted } = mergeSecrets(existingPlain, body.credentials);
    data.credentialsCipher = credentials.encryptSecrets(next);
    data.credentialFields = JSON.stringify(credentials.describeFields(next, JSON.parse(integration.credentialFields || '[]')));
    secretNames = Object.keys(submitted);
    // A credential change invalidates the previous "connected" claim.
    if (secretNames.length && data.status === undefined) data.status = 'CONFIGURED';
  }

  let updated = await prisma.supplierIntegration.update({ where: { id: integration.id }, data });
  updated = await refreshCapabilities(tenantId, updated);
  cache.invalidate('supplier');
  await audit(req, 'UPDATE', 'SupplierIntegration', integration.id, {
    fields: Object.keys(data).filter((k) => !k.startsWith('credential')),
    credentialFieldsChanged: secretNames, // names only
  });
  await activity(req.user.id, 'supplier', `${req.user.name} updated the integration for ${integration.name}`);
  res.json({ success: true, data: safeIntegration(updated) });
}));

// POST /api/supplier-integrations/:id/test
router.post('/:id/test', requirePermission('integrations.manage'), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const result = await connections.testConnection({ tenantId, integrationId: req.params.id, actorId: req.user.id, req });
  cache.invalidate('supplier');
  res.json({ success: true, data: result });
}));

// POST /api/supplier-integrations/:id/connect
router.post('/:id/connect', requirePermission('integrations.manage'), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const result = await connections.connect({ tenantId, integrationId: req.params.id, actorId: req.user.id, req });
  cache.invalidate('supplier');
  res.json({ success: true, data: result });
}));

// POST /api/supplier-integrations/:id/disconnect
router.post('/:id/disconnect', requirePermission('integrations.manage'), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const result = await connections.disconnect({ tenantId, integrationId: req.params.id, req });
  cache.invalidate('supplier');
  res.json({ success: true, data: safeIntegration(result.integration), message: result.message });
}));

// PATCH /api/supplier-integrations/:id/enabled
router.patch('/:id/enabled', requirePermission('integrations.manage'),
  validate(z.object({ enabled: z.coerce.boolean() })),
  asyncHandler(async (req, res) => {
    const tenantId = tenantOf(req);
    const updated = await connections.setEnabled({ tenantId, integrationId: req.params.id, enabled: req.body.enabled });
    cache.invalidate('supplier');
    await audit(req, req.body.enabled ? 'ENABLE' : 'DISABLE', 'SupplierIntegration', updated.id);
    res.json({ success: true, data: safeIntegration(updated) });
  }));

// PATCH /api/supplier-integrations/:id/schedule
router.patch('/:id/schedule', requirePermission('sync.manage'),
  validate(z.object({
    syncEnabled: z.coerce.boolean(),
    syncIntervalMinutes: z.coerce.number().int().min(0).max(10080),
    syncTypes: z.array(z.enum(['CATALOG', 'PRODUCTS', 'INVENTORY', 'PRICING', 'FULL'])).min(1),
  })),
  asyncHandler(async (req, res) => {
    const tenantId = tenantOf(req);
    const integration = await prisma.supplierIntegration.findFirst({ where: { id: req.params.id, tenantId } });
    if (!integration) throw notFound('Integration not found');
    if (req.body.syncEnabled && integration.status === 'NOT_CONNECTED') {
      throw badRequest('Connect the integration before scheduling synchronisation');
    }
    const updated = await prisma.supplierIntegration.update({
      where: { id: integration.id },
      data: {
        syncEnabled: req.body.syncEnabled,
        syncIntervalMinutes: req.body.syncIntervalMinutes,
        syncTypes: JSON.stringify(req.body.syncTypes),
      },
    });
    cache.invalidate('supplier');
    await audit(req, 'SCHEDULE', 'SupplierIntegration', integration.id, {
      syncEnabled: req.body.syncEnabled, interval: req.body.syncIntervalMinutes, types: req.body.syncTypes,
    });
    res.json({ success: true, data: safeIntegration(updated) });
  }));

// POST /api/supplier-integrations/:id/suggest-mapping
router.post('/:id/suggest-mapping', requirePermission('imports.manage'), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const integration = await prisma.supplierIntegration.findFirst({
    where: { id: req.params.id, tenantId }, include: { supplier: true },
  });
  if (!integration) throw notFound('Integration not found');
  const adapter = await syncEngine.adapterFor(integration, integration.supplier);
  if (typeof adapter.suggestColumnMap !== 'function') {
    throw badRequest(`${integration.connectorType} does not support automatic field mapping — map the fields manually`);
  }
  const result = await adapter.suggestColumnMap();
  res.json({ success: true, data: result });
}));

// DELETE /api/supplier-integrations/:id
router.delete('/:id', requirePermission('integrations.manage'), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const integration = await prisma.supplierIntegration.findFirst({ where: { id: req.params.id, tenantId } });
  if (!integration) throw notFound('Integration not found');
  await prisma.supplierIntegration.delete({ where: { id: integration.id } });
  cache.invalidate('supplier');
  await audit(req, 'DELETE', 'SupplierIntegration', integration.id, { name: integration.name });
  await activity(req.user.id, 'supplier', `${req.user.name} removed the integration ${integration.name}`);
  res.json({ success: true, message: 'Integration removed. Stored credentials were destroyed with it.' });
}));

module.exports = router;
