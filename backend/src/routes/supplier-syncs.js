/**
 * Synchronisation API — the sync engine's control surface plus its logs.
 *
 *   GET    /api/supplier-syncs                    run history
 *   POST   /api/supplier-syncs                    start a run (non-blocking)
 *   GET    /api/supplier-syncs/automation         scheduler status
 *   PATCH  /api/supplier-syncs/automation         enable / interval / concurrency
 *   POST   /api/supplier-syncs/automation/run-now trigger one sweep immediately
 *   POST   /api/supplier-syncs/sync-all           queue every enabled supplier
 *   GET    /api/supplier-syncs/:id                run detail (live progress)
 *   GET    /api/supplier-syncs/:id/logs           per-record log lines
 *   POST   /api/supplier-syncs/:id/retry          re-run a failed/partial sync
 *   POST   /api/supplier-syncs/:id/cancel         stop a queued/running sync
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
const { notFound } = require('../lib/errors');
const { audit, activity } = require('../lib/audit');
const syncEngine = require('../lib/suppliers/sync-engine');
const scheduler = require('../lib/suppliers/scheduler');
const marketplaceSettings = require('../lib/suppliers/settings');
const cache = require('../lib/cache');

const router = express.Router();

const parseErrors = (value) => { try { return JSON.parse(value || '[]'); } catch { return []; } };

router.use(protect, scopeTenant);

// GET /api/supplier-syncs
router.get('/', requirePermission('suppliers.view'), validate(paginationSchema.extend({
  supplierId: z.string().optional(),
  status: z.string().optional(),
  type: z.string().optional(),
  trigger: z.string().optional(),
}), 'query'), asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const tenantId = tenantOf(req);
  const where = { tenantId };
  if (q.supplierId) where.supplierId = q.supplierId;
  if (q.status) {
    const list = q.status.split(',').map((v) => v.trim().toUpperCase()).filter(Boolean);
    if (list.length) where.status = { in: list };
  }
  if (q.type) where.type = q.type.toUpperCase();
  if (q.trigger) where.trigger = q.trigger.toUpperCase();

  const [items, total, counts] = await Promise.all([
    prisma.supplierSync.findMany({
      where, orderBy: { startedAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit,
      include: { supplier: { select: { id: true, name: true, code: true } }, integration: { select: { id: true, name: true, connectorType: true } } },
    }),
    prisma.supplierSync.count({ where }),
    prisma.supplierSync.groupBy({ by: ['status'], where: { tenantId }, _count: { _all: true } }),
  ]);

  res.json({
    success: true,
    data: items.map((s) => ({ ...s, errors: parseErrors(s.errorLog) })),
    meta: { ...meta(total, q.page, q.limit), summary: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) },
  });
}));

// POST /api/supplier-syncs
router.post('/', requirePermission('sync.manage'), validate(z.object({
  supplierId: z.string().uuid(),
  type: z.enum(syncEngine.SYNC_TYPES).default('FULL'),
  trigger: z.enum(['MANUAL']).default('MANUAL'),
  wait: z.coerce.boolean().default(false),
})), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const sync = await syncEngine.start({
    tenantId, supplierId: req.body.supplierId, type: req.body.type,
    trigger: req.body.trigger, actorId: req.user.id, waitFor: req.body.wait,
  });
  await audit(req, 'SYNC_START', 'SupplierSync', sync.id, { type: sync.type, supplierId: sync.supplierId });
  if (!req.body.wait) await activity(req.user.id, 'supplier', `${req.user.name} started a ${req.body.type} synchronisation`);
  res.status(202).json({
    success: true,
    data: sync,
    message: req.body.wait ? 'Synchronisation finished.' : 'Synchronisation queued — progress appears in Sync Logs.',
  });
}));

// GET /api/supplier-syncs/automation
router.get('/automation', requirePermission('sync.manage'), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const [status, scheduled] = await Promise.all([
    scheduler.status(),
    prisma.supplierIntegration.findMany({
      where: { tenantId },
      select: {
        id: true, name: true, syncEnabled: true, syncIntervalMinutes: true, syncTypes: true,
        lastSyncAt: true, lastSyncStatus: true, status: true,
        supplier: { select: { id: true, name: true, status: true } },
      },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  res.json({
    success: true,
    data: {
      scheduler: status,
      integrations: scheduled.map((i) => ({
        ...i,
        syncTypes: (() => { try { return JSON.parse(i.syncTypes || '["FULL"]'); } catch { return ['FULL']; } })(),
      })),
    },
  });
}));

// PATCH /api/supplier-syncs/automation
router.patch('/automation', requirePermission('sync.manage'), validate(z.object({
  autoSyncEnabled: z.coerce.boolean(),
  syncIntervalMinutes: z.coerce.number().int().min(5).max(10080).optional(),
  syncConcurrency: z.coerce.number().int().min(1).max(8).optional(),
  batchSize: z.coerce.number().int().min(10).max(1000).optional(),
  maxSyncAttempts: z.coerce.number().int().min(1).max(10).optional(),
})), asyncHandler(async (req, res) => {
  const patch = { autoSyncEnabled: req.body.autoSyncEnabled };
  for (const key of ['syncIntervalMinutes', 'syncConcurrency', 'batchSize', 'maxSyncAttempts']) {
    if (req.body[key] !== undefined) patch[key] = req.body[key];
  }
  const settings = await marketplaceSettings.write(patch, req.tenantId);
  if (settings.autoSyncEnabled) scheduler.start();
  cache.invalidate('supplier');
  await audit(req, 'AUTOMATION', 'SupplierSettings', null, patch);
  res.json({ success: true, data: { settings: publicSettings(settings), scheduler: await scheduler.status() } });
}));

// POST /api/supplier-syncs/automation/run-now
router.post('/automation/run-now', requirePermission('sync.manage'), asyncHandler(async (req, res) => {
  const result = await scheduler.runNow();
  await audit(req, 'AUTOMATION_RUN', 'SupplierSettings', null, result.lastResult || {});
  res.json({ success: true, data: result });
}));

// POST /api/supplier-syncs/sync-all
router.post('/sync-all', requirePermission('sync.manage'), validate(z.object({
  type: z.enum(syncEngine.SYNC_TYPES).default('FULL'),
}).optional()), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const type = req.body?.type || 'FULL';
  const suppliers = await prisma.supplier.findMany({
    // `is` requires the relation to exist, so this is also the "has an
    // integration" filter — a supplier with no connector cannot be synced.
    where: { tenantId, status: 'ACTIVE', integration: { is: { status: { not: 'DISABLED' } } } },
    select: { id: true, name: true },
  });
  const queued = [];
  const skipped = [];
  for (const supplier of suppliers) {
    try {
      const sync = await syncEngine.start({ tenantId, supplierId: supplier.id, type, trigger: 'MANUAL', actorId: req.user.id });
      queued.push({ supplierId: supplier.id, name: supplier.name, syncId: sync.id });
    } catch (err) {
      skipped.push({ supplierId: supplier.id, name: supplier.name, reason: err.message });
    }
  }
  await audit(req, 'SYNC_ALL', 'SupplierSync', null, { queued: queued.length, skipped: skipped.length, type });
  await activity(req.user.id, 'supplier', `${req.user.name} queued a ${type} synchronisation for ${queued.length} supplier(s)`);
  res.status(202).json({ success: true, data: { queued, skipped } });
}));

// GET /api/supplier-syncs/:id
router.get('/:id', requirePermission('suppliers.view'), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const sync = await prisma.supplierSync.findFirst({
    where: { id: req.params.id, tenantId },
    include: {
      supplier: { select: { id: true, name: true, code: true } },
      integration: { select: { id: true, name: true, connectorType: true } },
      logs: { orderBy: { createdAt: 'desc' }, take: 100 },
    },
  });
  if (!sync) throw notFound('Sync not found');
  res.json({ success: true, data: { ...sync, errors: parseErrors(sync.errorLog) } });
}));

// GET /api/supplier-syncs/:id/logs
router.get('/:id/logs', requirePermission('suppliers.view'), validate(paginationSchema.extend({
  action: z.enum(['CREATE', 'UPDATE', 'SKIP', 'ERROR']).optional(),
}), 'query'), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const q = req.validatedQuery;
  const sync = await prisma.supplierSync.findFirst({ where: { id: req.params.id, tenantId } });
  if (!sync) throw notFound('Sync not found');
  const where = { syncId: sync.id };
  if (q.action) where.action = q.action;
  const [items, total, counts] = await Promise.all([
    prisma.supplierSyncLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }),
    prisma.supplierSyncLog.count({ where }),
    prisma.supplierSyncLog.groupBy({ by: ['action'], where: { syncId: sync.id }, _count: { _all: true } }),
  ]);
  res.json({
    success: true, data: items,
    meta: { ...meta(total, q.page, q.limit), summary: Object.fromEntries(counts.map((c) => [c.action, c._count._all])) },
  });
}));

// POST /api/supplier-syncs/:id/retry
router.post('/:id/retry', requirePermission('sync.manage'), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const sync = await syncEngine.retry({ tenantId, syncId: req.params.id, actorId: req.user.id });
  await audit(req, 'SYNC_RETRY', 'SupplierSync', sync.id, { parent: req.params.id, attempt: sync.attempt });
  res.status(202).json({ success: true, data: sync, message: `Retry ${sync.attempt} queued.` });
}));

// POST /api/supplier-syncs/:id/cancel
router.post('/:id/cancel', requirePermission('sync.manage'), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const sync = await syncEngine.cancel({ tenantId, syncId: req.params.id });
  await audit(req, 'SYNC_CANCEL', 'SupplierSync', sync.id);
  res.json({ success: true, data: sync, message: 'Synchronisation cancelled.' });
}));

function publicSettings(settings) {
  const { permissions, ...rest } = settings;
  return rest;
}

module.exports = router;
module.exports.publicSettings = publicSettings;
