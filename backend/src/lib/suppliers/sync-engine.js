/**
 * Central synchronisation engine.
 *
 *     Sync Engine ──▶ Supplier A connector
 *                 ──▶ Supplier B connector
 *                 ──▶ Supplier C connector
 *
 * The engine owns the lifecycle; connectors only produce records. That keeps
 * batching, progress, retries, locking, change counting and logging in one
 * place and identical for every supplier.
 *
 * Guarantees:
 *   • at most one RUNNING sync per supplier (no overlapping jobs)
 *   • a global concurrency cap so a big catalogue cannot starve the API
 *   • batched, paginated reads — a 50k-line catalogue never loads at once
 *   • idempotent writes — re-running a sync with no upstream change reports
 *     processed=N, created=0, updated=0
 *   • per-record failures are logged and skipped, never fatal to the run
 */
const prisma = require('../prisma');
const registry = require('./registry');
const marketplaceSettings = require('./settings');
const { decryptSecrets, redactString } = require('./credentials');
const catalogue = require('./catalogue');
const { priceFor } = require('./markup');
const { FULFILLMENT_TYPES } = require('./inventory');

const SYNC_TYPES = ['CATALOG', 'PRODUCTS', 'INVENTORY', 'PRICING', 'FULL'];

const jsonField = (value) => (value === null || value === undefined || value === ''
  ? null : (typeof value === 'string' ? value : JSON.stringify(value)));

const eq = (a, b) => {
  const na = a === null || a === undefined ? null : a;
  const nb = b === null || b === undefined ? null : b;
  if (typeof na === 'number' && typeof nb === 'number') return Math.abs(na - nb) < 1e-9;
  return String(na) === String(nb);
};

/** Builds the adapter for an integration, decrypting its secrets in memory. */
async function adapterFor(integration, supplier, { settings } = {}) {
  if (!integration) {
    throw Object.assign(new Error('This supplier has no integration configured'), { status: 400, code: 'NO_INTEGRATION' });
  }
  const Connector = registry.get(integration.connectorType);
  if (!Connector) {
    throw Object.assign(new Error(`Unknown connector type "${integration.connectorType}"`), { status: 400, code: 'UNKNOWN_CONNECTOR' });
  }
  let secrets = {};
  try { secrets = decryptSecrets(integration.credentialsCipher); }
  catch (e) { throw Object.assign(new Error(`Stored credentials could not be decrypted (${e.message}) — re-enter them`), { status: 400, code: 'CREDENTIALS_UNREADABLE' }); }
  let config = {};
  try { config = integration.config ? JSON.parse(integration.config) : {}; } catch { config = {}; }
  const adapter = new Connector({
    supplier, integration, secrets, config, settings: settings || (await marketplaceSettings.read()),
  });
  adapter.logger = () => {};
  return adapter;
}

/** True when a sync of this shape is already running for the supplier. */
async function isRunning(tenantId, supplierId) {
  const active = await prisma.supplierSync.count({
    where: { tenantId, supplierId, status: { in: ['QUEUED', 'RUNNING'] } },
  });
  return active > 0;
}

async function runningCount(tenantId) {
  return prisma.supplierSync.count({ where: { tenantId, status: { in: ['QUEUED', 'RUNNING'] } } });
}

/**
 * Queues (and optionally awaits) a synchronisation run.
 * @returns the SupplierSync row
 */
async function start({ tenantId = 'default', supplierId, type = 'FULL', trigger = 'MANUAL', actorId = null, waitFor = false }) {
  if (!SYNC_TYPES.includes(type)) throw Object.assign(new Error(`Unknown sync type "${type}"`), { status: 400 });

  const supplier = await prisma.supplier.findFirst({
    where: { id: supplierId, tenantId }, include: { integration: true },
  });
  if (!supplier) throw Object.assign(new Error('Supplier not found'), { status: 404 });
  if (supplier.status === 'ARCHIVED') throw Object.assign(new Error('Archived suppliers cannot be synchronised'), { status: 409 });
  if (supplier.status === 'DISABLED') throw Object.assign(new Error('This supplier is disabled — enable it before synchronising'), { status: 409 });

  if (await isRunning(tenantId, supplierId)) {
    throw Object.assign(new Error(`A synchronisation is already running for ${supplier.name}`), { status: 409, code: 'SYNC_IN_PROGRESS' });
  }
  const settings = await marketplaceSettings.read();
  if (await runningCount(tenantId) >= (settings.syncConcurrency || 2)) {
    throw Object.assign(new Error('The synchronisation queue is full — try again shortly'), { status: 429, code: 'SYNC_QUEUE_FULL' });
  }

  const sync = await prisma.supplierSync.create({
    data: {
      tenantId, supplierId, integrationId: supplier.integration?.id || null,
      type, trigger, status: 'QUEUED', batch: settings.batchSize || 100,
      maxAttempts: settings.maxSyncAttempts || 3,
      message: actorId ? `Started by user ${actorId}` : `Started by ${trigger.toLowerCase()}`,
    },
  });

  if (waitFor) return run(sync.id);

  // Fire and forget — the Admin UI polls the sync row for progress, so a large
  // catalogue never blocks the request that started it.
  setImmediate(() => { run(sync.id).catch((e) => console.error('[supplier-sync] unhandled', e.message)); });
  return sync;
}

/** Executes a queued sync. Safe to call once per sync id. */
async function run(syncId) {
  const sync = await prisma.supplierSync.findUnique({ where: { id: syncId } });
  if (!sync) throw Object.assign(new Error('Sync not found'), { status: 404 });
  if (['COMPLETED', 'CANCELLED'].includes(sync.status)) return sync;

  const startedAt = new Date();
  const supplier = await prisma.supplier.findFirst({
    where: { id: sync.supplierId, tenantId: sync.tenantId }, include: { integration: true },
  });

  if (!supplier) return finish(syncId, { status: 'FAILED', message: 'Supplier no longer exists' });

  const settings = await marketplaceSettings.read();
  const globalRule = await marketplaceSettings.globalMarkupRule();
  const categoryRules = await prisma.supplierMarkupRule.findMany({
    where: { tenantId: sync.tenantId, scope: 'CATEGORY', isActive: true },
  });

  await prisma.supplierSync.update({
    where: { id: syncId },
    data: { status: 'RUNNING', startedAt, message: 'Connecting to supplier…' },
  });

  const counters = { processed: 0, created: 0, updated: 0, skipped: 0, inventoryUpdates: 0, priceUpdates: 0, errorCount: 0 };
  const errors = [];
  const logBuffer = [];

  const flushLogs = async () => {
    if (!logBuffer.length) return;
    await prisma.supplierSyncLog.createMany({ data: logBuffer.splice(0, logBuffer.length) });
  };

  const recordError = (sku, message, field = null) => {
    counters.errorCount++;
    if (errors.length < 200) errors.push({ sku: sku || null, message: String(message).slice(0, 400) });
    if (logBuffer.length < 2000) {
      logBuffer.push({
        tenantId: sync.tenantId, syncId, supplierId: sync.supplierId,
        sku: sku || null, action: 'ERROR', field, message: String(message).slice(0, 400),
      });
    }
  };

  try {
    const adapter = await adapterFor(supplier.integration, supplier, { settings });

    if (!adapter.hasCredentials()) {
      throw Object.assign(new Error('Not connected — credentials required'), { code: 'NOT_CONNECTED' });
    }

    const phases = phasesFor(sync.type, adapter);
    if (!phases.length) {
      throw Object.assign(new Error('The configured connector offers no synchronisation capability'), { code: 'NO_CAPABILITY' });
    }

    for (const phase of phases) {
      await prisma.supplierSync.update({ where: { id: syncId }, data: { message: `Running ${phase}…` } });
      const iterator = iteratorFor(adapter, phase, { limit: sync.batch });
      for await (const batch of iterator) {
        await applyBatch({
          phase, batch, sync, supplier, counters, recordError, settings, globalRule, categoryRules, logBuffer,
        });
        await prisma.supplierSync.update({
          where: { id: syncId },
          data: {
            processed: counters.processed, created: counters.created, updated: counters.updated,
            skipped: counters.skipped, inventoryUpdates: counters.inventoryUpdates,
            priceUpdates: counters.priceUpdates, errorCount: counters.errorCount,
            cursor: batch.cursor || null,
            errorLog: errors.length ? JSON.stringify(errors.slice(-200)) : null,
            message: `${phase}: ${counters.processed} record(s) processed`,
          },
        });
        if (batch.done) break;
      }
    }

    await flushLogs();

    const status = counters.errorCount > 0
      ? (counters.processed > counters.errorCount ? 'PARTIAL' : 'FAILED')
      : 'COMPLETED';

    await prisma.supplierIntegration.updateMany({
      where: { id: supplier.integration.id },
      data: {
        lastSyncAt: new Date(), lastSyncStatus: status,
        status: status === 'FAILED' ? 'ERROR' : (supplier.integration.status === 'NOT_CONNECTED' ? 'CONFIGURED' : 'CONNECTED'),
        lastError: status === 'FAILED' ? (errors[0]?.message || 'Synchronisation failed') : null,
      },
    }).catch(() => {});

    return finish(syncId, {
      status, counters, errors,
      message: status === 'COMPLETED'
        ? `Synchronised ${counters.processed} record(s)`
        : `${counters.errorCount} error(s) during synchronisation`,
    });
  } catch (err) {
    await flushLogs();
    const secretValues = (() => {
      try { return Object.values(decryptSecrets(supplier.integration?.credentialsCipher)); } catch { return []; }
    })();
    const message = redactString(err.message || 'Synchronisation failed', secretValues);
    const code = err.code || 'SYNC_FAILED';

    if (code === 'NOT_CONNECTED') {
      await prisma.supplierIntegration.updateMany({
        where: { id: supplier.integration?.id },
        data: { status: 'NOT_CONNECTED', lastError: message, lastTestedAt: new Date() },
      }).catch(() => {});
    } else {
      await prisma.supplierIntegration.updateMany({
        where: { id: supplier.integration?.id },
        data: { status: 'ERROR', lastError: message.slice(0, 400), lastSyncAt: new Date(), lastSyncStatus: 'FAILED' },
      }).catch(() => {});
    }
    return finish(syncId, { status: 'FAILED', counters, errors: [{ sku: null, message }], message });
  }
}

function phasesFor(type, adapter) {
  const phases = [];
  if ((type === 'FULL' || type === 'CATALOG' || type === 'PRODUCTS') && adapter.supports('importCatalog')) phases.push('CATALOG');
  if ((type === 'FULL' || type === 'INVENTORY') && adapter.supports('syncInventory')) phases.push('INVENTORY');
  if ((type === 'FULL' || type === 'PRICING') && adapter.supports('syncPricing')) phases.push('PRICING');
  return phases;
}

function iteratorFor(adapter, phase, { limit }) {
  if (phase === 'INVENTORY') return adapter.fetchInventory({ limit });
  if (phase === 'PRICING') return adapter.fetchPricing({ limit });
  return adapter.fetchCatalog({ limit });
}

/* ------------------------------------------------------------- batch writer */

async function applyBatch({ phase, batch, sync, supplier, counters, recordError, settings, globalRule, categoryRules, logBuffer }) {
  const records = (batch.records || []).filter((r) => r && r.supplierSku);
  for (const record of batch.records || []) {
    if (!record || !record.supplierSku) { recordError(null, 'Record is missing a supplier SKU'); counters.processed++; continue; }
  }

  for (const record of records) {
    counters.processed++;
    const sku = record.supplierSku.toUpperCase();
    try {
      if (phase === 'INVENTORY') await applyInventory({ record, sku, sync, supplier, counters, logBuffer });
      else if (phase === 'PRICING') await applyPricing({ record, sku, sync, supplier, counters, logBuffer, settings, globalRule, categoryRules });
      else await applyCatalog({ record, sku, sync, supplier, counters, logBuffer, settings, globalRule, categoryRules });
    } catch (err) {
      recordError(record.supplierSku, err.message);
    }
  }
}

async function applyCatalog({ record, sku, sync, supplier, counters, logBuffer, settings, globalRule, categoryRules }) {
  const existing = await prisma.supplierProduct.findUnique({
    where: {
      tenantId_supplierId_supplierSku: { tenantId: sync.tenantId, supplierId: supplier.id, supplierSku: sku },
    },
  });

  const data = {
    name: record.name || existing?.name || sku,
    description: record.description ?? existing?.description ?? null,
    brand: record.brand ?? existing?.brand ?? null,
    categoryText: record.categoryText ?? existing?.categoryText ?? null,
    manufacturerPart: record.manufacturerPart ?? existing?.manufacturerPart ?? null,
    upc: record.upc ?? existing?.upc ?? null,
    supplierCost: Number(record.supplierCost) || 0,
    currency: record.currency || supplier.currency || settings.defaultCurrency,
    msrp: record.msrp ?? existing?.msrp ?? null,
    stock: Math.max(0, Math.trunc(Number(record.stock) || 0)),
    stockStatus: record.stockStatus ?? existing?.stockStatus ?? null,
    imageUrl: record.imageUrl ?? existing?.imageUrl ?? null,
    gallery: jsonField(record.gallery) ?? existing?.gallery ?? null,
    specs: jsonField(record.specs) ?? existing?.specs ?? null,
    weightKg: record.weightKg ?? existing?.weightKg ?? null,
    lengthCm: record.lengthCm ?? existing?.lengthCm ?? null,
    widthCm: record.widthCm ?? existing?.widthCm ?? null,
    heightCm: record.heightCm ?? existing?.heightCm ?? null,
    restricted: Boolean(record.restricted),
    restrictionType: record.restrictionType ?? existing?.restrictionType ?? null,
    restrictionNotes: record.restrictionNotes ?? existing?.restrictionNotes ?? null,
    documentationRequired: jsonField(record.documentationRequired) ?? existing?.documentationRequired ?? null,
    allowedCountries: jsonField(record.allowedCountries) ?? existing?.allowedCountries ?? null,
    blockedCountries: jsonField(record.blockedCountries) ?? existing?.blockedCountries ?? null,
    allowedShippingMethods: jsonField(record.allowedShippingMethods) ?? existing?.allowedShippingMethods ?? null,
    lastSyncedAt: new Date(),
    lastSyncError: null,
    syncStatus: existing ? 'OK' : 'NEW',
  };

  let supplierProduct;
  if (!existing) {
    supplierProduct = await prisma.supplierProduct.create({
      data: { tenantId: sync.tenantId, supplierId: supplier.id, supplierSku: sku, ...data },
    });
    counters.created++;
    logBuffer.push({
      tenantId: sync.tenantId, syncId: sync.id, supplierId: supplier.id,
      supplierProductId: supplierProduct.id, sku, action: 'CREATE', message: `Created ${sku}`,
    });
  } else {
    // Bookkeeping columns change on every run by definition; counting them as
    // content changes would make every sync report "updated" and hide real
    // diffs. Only compare the data the supplier actually sent.
    const BOOKKEEPING = ['lastSyncedAt', 'lastSyncError', 'syncStatus'];
    const changed = Object.keys(data).filter((k) => !BOOKKEEPING.includes(k) && !eq(existing[k], data[k]));
    if (!changed.length) {
      counters.skipped++;
      supplierProduct = existing;
    } else {
      supplierProduct = await prisma.supplierProduct.update({ where: { id: existing.id }, data });
      counters.updated++;
      if (changed.includes('stock')) counters.inventoryUpdates++;
      if (changed.includes('supplierCost') || changed.includes('msrp')) counters.priceUpdates++;
      logBuffer.push({
        tenantId: sync.tenantId, syncId: sync.id, supplierId: supplier.id,
        supplierProductId: existing.id, sku, action: 'UPDATE',
        field: changed.join(','), message: `Updated ${changed.join(', ')}`,
      });
    }
  }

  // Re-price unless an operator pinned the price by hand.
  if (supplierProduct.priceOverride === null || supplierProduct.priceOverride === undefined) {
    const price = priceFor({
      supplierProduct: { ...supplierProduct, ...data, id: supplierProduct.id },
      supplier, categoryRules, globalRule,
    });
    if (!eq(supplierProduct.sellingPrice, price.price)) {
      await prisma.supplierProduct.update({
        where: { id: supplierProduct.id },
        data: { sellingPrice: price.price, markupApplied: JSON.stringify(price.rule) },
      });
      counters.priceUpdates++;
    }
    supplierProduct.sellingPrice = price.price;
  }

  if (supplierProduct.published) {
    await catalogue.mirrorToProduct({ tenantId: sync.tenantId, supplierProduct: { ...supplierProduct, ...data }, supplier });
  }
}

async function applyInventory({ record, sku, sync, supplier, counters, logBuffer }) {
  const existing = await prisma.supplierProduct.findUnique({
    where: { tenantId_supplierId_supplierSku: { tenantId: sync.tenantId, supplierId: supplier.id, supplierSku: sku } },
  });
  if (!existing) {
    counters.skipped++;
    logBuffer.push({
      tenantId: sync.tenantId, syncId: sync.id, supplierId: supplier.id, sku,
      action: 'SKIP', message: 'No matching supplier product — run a catalogue sync first',
    });
    return;
  }
  const stock = Math.max(0, Math.trunc(Number(record.stock) || 0));
  if (eq(existing.stock, stock) && eq(existing.stockStatus, record.stockStatus ?? existing.stockStatus)) {
    counters.skipped++;
    return;
  }
  const updated = await prisma.supplierProduct.update({
    where: { id: existing.id },
    data: {
      stock,
      stockStatus: record.stockStatus ?? existing.stockStatus ?? null,
      lastSyncedAt: new Date(),
      syncStatus: 'OK',
      lastSyncError: null,
    },
  });
  counters.inventoryUpdates++;
  counters.updated++;
  logBuffer.push({
    tenantId: sync.tenantId, syncId: sync.id, supplierId: supplier.id,
    supplierProductId: existing.id, sku, action: 'UPDATE', field: 'stock',
    message: `Stock ${existing.stock} → ${stock}`,
  });
  if (updated.published) await catalogue.mirrorToProduct({ tenantId: sync.tenantId, supplierProduct: updated, supplier });
}

async function applyPricing({ record, sku, sync, supplier, counters, logBuffer, settings, globalRule, categoryRules }) {
  const existing = await prisma.supplierProduct.findUnique({
    where: { tenantId_supplierId_supplierSku: { tenantId: sync.tenantId, supplierId: supplier.id, supplierSku: sku } },
  });
  if (!existing) {
    counters.skipped++;
    logBuffer.push({
      tenantId: sync.tenantId, syncId: sync.id, supplierId: supplier.id, sku,
      action: 'SKIP', message: 'No matching supplier product — run a catalogue sync first',
    });
    return;
  }
  const cost = Number(record.supplierCost) || 0;
  if (eq(existing.supplierCost, cost) && eq(existing.msrp, record.msrp ?? existing.msrp)) {
    counters.skipped++;
    return;
  }
  const price = priceFor({
    supplierProduct: { ...existing, supplierCost: cost, msrp: record.msrp ?? existing.msrp },
    supplier, categoryRules, globalRule,
  });
  await prisma.supplierProduct.update({
    where: { id: existing.id },
    data: {
      supplierCost: cost,
      msrp: record.msrp ?? existing.msrp ?? null,
      currency: record.currency || existing.currency || settings.defaultCurrency,
      sellingPrice: price.price,
      markupApplied: JSON.stringify(price.rule),
      lastSyncedAt: new Date(),
      syncStatus: 'OK',
      lastSyncError: null,
    },
  });
  counters.priceUpdates++;
  counters.updated++;
  logBuffer.push({
    tenantId: sync.tenantId, syncId: sync.id, supplierId: supplier.id,
    supplierProductId: existing.id, sku, action: 'UPDATE', field: 'supplierCost',
    message: `Cost ${existing.supplierCost} → ${cost}, selling ${price.price}`,
  });
  if (existing.published) {
    await catalogue.mirrorToProduct({
      tenantId: sync.tenantId,
      supplierProduct: { ...existing, supplierCost: cost, sellingPrice: price.price },
      supplier,
    });
  }
}

async function finish(syncId, { status, counters = {}, errors = [], message = null }) {
  const finishedAt = new Date();
  const sync = await prisma.supplierSync.findUnique({ where: { id: syncId } });
  return prisma.supplierSync.update({
    where: { id: syncId },
    data: {
      status,
      finishedAt,
      durationMs: sync ? finishedAt.getTime() - new Date(sync.startedAt).getTime() : null,
      processed: counters.processed ?? 0,
      created: counters.created ?? 0,
      updated: counters.updated ?? 0,
      skipped: counters.skipped ?? 0,
      inventoryUpdates: counters.inventoryUpdates ?? 0,
      priceUpdates: counters.priceUpdates ?? 0,
      errorCount: counters.errorCount ?? errors.length,
      errorLog: errors.length ? JSON.stringify(errors.slice(-200)) : null,
      message: message || status,
    },
  });
}

/** Re-runs a failed or partial sync as a NEW run linked to the original. */
async function retry({ tenantId = 'default', syncId, actorId = null }) {
  const original = await prisma.supplierSync.findFirst({ where: { id: syncId, tenantId } });
  if (!original) throw Object.assign(new Error('Sync not found'), { status: 404 });
  if (['QUEUED', 'RUNNING'].includes(original.status)) {
    throw Object.assign(new Error('That synchronisation is still running'), { status: 409 });
  }
  const attempt = original.attempt + 1;
  if (attempt > original.maxAttempts) {
    throw Object.assign(new Error(`Maximum retry attempts (${original.maxAttempts}) reached for this run`), { status: 409 });
  }
  if (await isRunning(tenantId, original.supplierId)) {
    throw Object.assign(new Error('A synchronisation is already running for this supplier'), { status: 409, code: 'SYNC_IN_PROGRESS' });
  }
  const sync = await prisma.supplierSync.create({
    data: {
      tenantId, supplierId: original.supplierId, integrationId: original.integrationId,
      type: original.type, trigger: 'RETRY', status: 'QUEUED',
      attempt, maxAttempts: original.maxAttempts, parentSyncId: original.id,
      batch: original.batch, message: `Retry ${attempt} of run ${original.id.slice(0, 8)}${actorId ? ` by ${actorId}` : ''}`,
    },
  });
  setImmediate(() => { run(sync.id).catch((e) => console.error('[supplier-sync] retry failed', e.message)); });
  return sync;
}

async function cancel({ tenantId = 'default', syncId }) {
  const sync = await prisma.supplierSync.findFirst({ where: { id: syncId, tenantId } });
  if (!sync) throw Object.assign(new Error('Sync not found'), { status: 404 });
  if (!['QUEUED', 'RUNNING'].includes(sync.status)) {
    throw Object.assign(new Error('Only a queued or running synchronisation can be cancelled'), { status: 409 });
  }
  return finish(syncId, { status: 'CANCELLED', message: 'Cancelled by an administrator' });
}

/**
 * Runs every supplier whose integration has scheduled sync enabled.
 * Called by the in-process scheduler; sequential per supplier and bounded by
 * the same concurrency cap as manual runs.
 */
async function runScheduled({ tenantId = 'default' } = {}) {
  const settings = await marketplaceSettings.read();
  if (!settings.autoSyncEnabled) return { skipped: true, reason: 'Automatic synchronisation is disabled' };

  const integrations = await prisma.supplierIntegration.findMany({
    where: { tenantId, syncEnabled: true, status: { not: 'DISABLED' }, supplier: { status: 'ACTIVE' } },
    include: { supplier: true },
  });

  const results = [];
  for (const integration of integrations) {
    const interval = integration.syncIntervalMinutes || settings.syncIntervalMinutes || 60;
    const due = !integration.lastSyncAt
      || (Date.now() - new Date(integration.lastSyncAt).getTime()) >= interval * 60000;
    if (!due) continue;
    if (await isRunning(tenantId, integration.supplierId)) {
      results.push({ supplierId: integration.supplierId, skipped: 'already running' });
      continue;
    }
    const types = (() => {
      try { return JSON.parse(integration.syncTypes || '["FULL"]'); } catch { return ['FULL']; }
    })();
    for (const type of (Array.isArray(types) && types.length ? types : ['FULL'])) {
      try {
        const sync = await start({ tenantId, supplierId: integration.supplierId, type, trigger: 'SCHEDULED' });
        results.push({ supplierId: integration.supplierId, syncId: sync.id, type });
      } catch (err) {
        results.push({ supplierId: integration.supplierId, type, error: err.message });
      }
    }
  }
  return { started: results.length, results };
}

/** Marks runs left RUNNING by a crashed process as failed (failure recovery). */
async function recoverStale({ tenantId = 'default', olderThanMinutes = 30 } = {}) {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60000);
  const stale = await prisma.supplierSync.findMany({
    where: { tenantId, status: { in: ['QUEUED', 'RUNNING'] }, startedAt: { lt: cutoff } },
  });
  for (const sync of stale) {
    await finish(sync.id, {
      status: 'FAILED',
      message: `Recovered: the run did not finish within ${olderThanMinutes} minutes (process restart?)`,
    });
  }
  return stale.length;
}

module.exports = {
  SYNC_TYPES, start, run, retry, cancel, runScheduled, recoverStale,
  adapterFor, isRunning, phasesFor,
  FULFILLMENT_TYPES,
};
