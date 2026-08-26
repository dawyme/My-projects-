/**
 * Supplier catalogue importer.
 *
 * Pipeline:  transport → parse → normalise → validate → match → PREVIEW → COMMIT
 *
 * The preview step is not optional. Nothing is written to the catalogue until an
 * operator commits the import, and the preview carries the exact per-row verdict
 * (NEW / UPDATED / UNCHANGED / ERROR) that the Admin UI renders, so what the
 * operator reviews is precisely what will happen.
 *
 * Idempotency: committing the same file twice produces NEW 0 / UPDATED 0 /
 * UNCHANGED n, because every write is compared against the stored row first.
 */
const prisma = require('../prisma');
const { parseCsvObjects, guessColumnMap, MAX_BYTES } = require('./parsers/csv');
const { parseXml, selectNodes, flattenNode } = require('./parsers/xml');
const { normalizeRecord, getPath } = require('./connectors/base');
const { priceFor } = require('./markup');
const marketplaceSettings = require('./settings');

const PREVIEW_ROW_LIMIT = 500;   // rows kept for the UI preview
const MAX_IMPORT_ROWS = 20000;   // hard cap per import

const COMPARED_FIELDS = [
  'name', 'description', 'brand', 'categoryText', 'manufacturerPart', 'upc',
  'supplierCost', 'msrp', 'currency', 'stock', 'stockStatus', 'imageUrl',
  'weightKg', 'lengthCm', 'widthCm', 'heightCm', 'restricted', 'restrictionType',
  'restrictionNotes',
];

const jsonField = (value) => (value === null || value === undefined || value === ''
  ? null
  : (typeof value === 'string' ? value : JSON.stringify(value)));

const eq = (a, b) => {
  const na = a === null || a === undefined ? null : a;
  const nb = b === null || b === undefined ? null : b;
  if (typeof na === 'number' && typeof nb === 'number') return Math.abs(na - nb) < 1e-9;
  return String(na) === String(nb);
};

/* ------------------------------------------------------------------ parsing */

function detectFormat({ filename, mimetype, sample }) {
  const name = String(filename || '').toLowerCase();
  if (name.endsWith('.csv') || name.endsWith('.tsv') || mimetype === 'text/csv') return 'CSV';
  if (name.endsWith('.xml') || mimetype === 'text/xml' || mimetype === 'application/xml') return 'XML';
  if (name.endsWith('.json') || mimetype === 'application/json') return 'JSON';
  const head = String(sample || '').slice(0, 512).trim();
  if (head.startsWith('<?xml') || head.startsWith('<')) return 'XML';
  if (head.startsWith('{') || head.startsWith('[')) return 'JSON';
  return 'CSV';
}

/**
 * Turns raw file content into an array of raw records plus the header list the
 * mapping UI needs.
 */
function parseContent({ format, content, itemsPath, delimiter }) {
  if (format === 'XML') {
    const { root } = parseXml(content);
    const nodes = selectNodes(root, itemsPath);
    if (!nodes.length) {
      return {
        records: [], headers: [],
        error: itemsPath ? `No items found at "${itemsPath}"` : 'Set the item node path (for example catalog.product)',
      };
    }
    const flat = nodes.map((n) => flattenNode(n));
    return { records: flat, headers: flat.length ? Object.keys(flat[0]) : [] };
  }
  if (format === 'JSON') {
    let payload;
    try { payload = JSON.parse(content); } catch (e) { return { records: [], headers: [], error: `Invalid JSON: ${e.message}` }; }
    let items = Array.isArray(payload) ? payload : null;
    if (!items && itemsPath) {
      const found = getPath(payload, itemsPath);
      if (Array.isArray(found)) items = found;
    }
    if (!items) {
      for (const key of ['data', 'items', 'results', 'products', 'records']) {
        if (Array.isArray(payload?.[key])) { items = payload[key]; break; }
      }
    }
    if (!items) return { records: [], headers: [], error: 'Could not locate an item array — set the item node path' };
    return { records: items, headers: items.length ? Object.keys(items[0]) : [] };
  }
  const { records, headers, truncated } = parseCsvObjects(content, { delimiter: delimiter || undefined });
  if (truncated) return { records, headers, error: 'Row limit reached — the file was truncated' };
  return { records, headers };
}

/** Parses an uploaded file into normalised records ready for preview. */
function parseUpload({ filename, mimetype, content, columnMap, itemsPath, delimiter, format }) {
  const detected = format || detectFormat({ filename, mimetype, sample: content });
  const { records, headers, error } = parseContent({ format: detected, content, itemsPath, delimiter });
  const map = columnMap && Object.keys(columnMap).length ? columnMap : guessColumnMap(headers);
  const normalised = records.slice(0, MAX_IMPORT_ROWS).map((raw, index) => ({
    row: index + 2, // +2 because row 1 is the header
    ...normalizeRecord(raw, map),
  }));
  return {
    format: detected, headers, columnMap: map, suggestedColumnMap: guessColumnMap(headers),
    records: normalised, truncated: records.length > MAX_IMPORT_ROWS, parseError: error || null,
    rowsRead: records.length,
  };
}

/* ---------------------------------------------------------------- validation */

function validateRecord(record) {
  const errors = [];
  if (!record.supplierSku) errors.push({ field: 'supplierSku', message: 'Supplier SKU is required' });
  else if (String(record.supplierSku).length > 120) errors.push({ field: 'supplierSku', message: 'Supplier SKU is longer than 120 characters' });
  if (!record.name || String(record.name).length < 2) errors.push({ field: 'name', message: 'Product name is required' });
  else if (String(record.name).length > 180) errors.push({ field: 'name', message: 'Product name is longer than 180 characters' });
  if (record.supplierCost < 0) errors.push({ field: 'supplierCost', message: 'Supplier cost cannot be negative' });
  if (record.stock < 0) errors.push({ field: 'stock', message: 'Stock cannot be negative' });
  if (record.upc && !/^[\dA-Za-z-]{6,20}$/.test(String(record.upc))) {
    errors.push({ field: 'upc', message: 'UPC/EAN looks malformed' });
  }
  return errors;
}

/* ------------------------------------------------------------------ matching */

/**
 * Finds the platform Product a supplier record belongs to.
 * Order: supplier SKU → manufacturer part number → UPC/EAN.
 * @param {object} client prisma client or an interactive-transaction handle
 */
async function matchPlatformProduct(record, client = prisma, tenantId = 'default') {
  // Matching never crosses tenant boundaries.
  const candidates = [];
  if (record.supplierSku) candidates.push({ sku: record.supplierSku.toUpperCase(), matchKey: 'SKU', confidence: 95 });
  if (record.manufacturerPart) candidates.push({ model: record.manufacturerPart, matchKey: 'MPN', confidence: 80 });

  for (const candidate of candidates) {
    const { matchKey, confidence, ...where } = candidate;
    const found = await client.product.findFirst({ where: { businessId: tenantId, ...where }, select: { id: true, sku: true, name: true } });
    if (found) return { ...found, matchKey, confidence };
  }
  if (record.upc) {
    const found = await client.product.findFirst({
      where: { businessId: tenantId, OR: [{ sku: record.upc }, { specs: { contains: record.upc } }] },
      select: { id: true, sku: true, name: true },
    });
    if (found) return { ...found, matchKey: 'UPC', confidence: 70 };
  }
  return null;
}

/* ------------------------------------------------------------------- preview */

/**
 * Builds (and persists) an import preview. No catalogue rows are touched.
 */
async function buildPreview({ tenantId = 'default', supplierId, integrationId = null, source = 'UPLOAD', filename = null, records, createdBy = null }) {
  const supplier = await prisma.supplier.findFirst({ where: { id: supplierId, tenantId } });
  if (!supplier) throw Object.assign(new Error('Supplier not found'), { status: 404 });

  const settings = await marketplaceSettings.read(tenantId);
  const globalRule = await marketplaceSettings.globalMarkupRule(tenantId);
  const categoryRules = await prisma.supplierMarkupRule.findMany({ where: { tenantId, scope: 'CATEGORY', isActive: true } });

  const skus = records.map((r) => r.supplierSku).filter(Boolean);
  const existing = await prisma.supplierProduct.findMany({
    where: { tenantId, supplierId, supplierSku: { in: skus } },
    include: { mapping: { include: { product: { select: { id: true, sku: true, name: true } } } } },
  });
  const bySku = new Map(existing.map((p) => [p.supplierSku.toUpperCase(), p]));

  const previewRows = [];
  const errors = [];
  let counts = { NEW: 0, UPDATED: 0, UNCHANGED: 0, ERRORS: 0 };

  for (const record of records) {
    const rowErrors = validateRecord(record);
    const current = record.supplierSku ? bySku.get(record.supplierSku.toUpperCase()) : null;

    if (rowErrors.length) {
      counts.ERRORS++;
      errors.push({ row: record.row, sku: record.supplierSku || null, errors: rowErrors });
      if (previewRows.length < PREVIEW_ROW_LIMIT) {
        previewRows.push({ row: record.row, verdict: 'ERROR', record: stripRaw(record), errors: rowErrors });
      }
      continue;
    }

    const mapped = current?.mapping?.product || (current ? null : await matchPlatformProduct(record, prisma, tenantId));
    const changes = current ? diffAgainst(current, record) : null;

    const price = priceFor({
      supplierProduct: { ...record, categoryId: current?.categoryId || null },
      supplier,
      categoryRules,
      globalRule,
    });

    let verdict;
    if (!current) { verdict = 'NEW'; counts.NEW++; }
    else if (changes.length) { verdict = 'UPDATED'; counts.UPDATED++; }
    else { verdict = 'UNCHANGED'; counts.UNCHANGED++; }

    if (previewRows.length < PREVIEW_ROW_LIMIT) {
      previewRows.push({
        row: record.row,
        verdict,
        record: stripRaw(record),
        changes: changes || [],
        matchedProduct: mapped ? { id: mapped.id, sku: mapped.sku, name: mapped.name, matchKey: current?.mapping?.matchKey || mapped.matchKey } : null,
        price: { cost: price.cost, price: price.price, rule: price.rule, overridden: price.overridden },
      });
    }
  }

  const created = await prisma.supplierCatalogImport.create({
    data: {
      tenantId,
      supplierId,
      integrationId,
      source,
      filename,
      status: 'PREVIEWING',
      rowsRead: records.length,
      rowsFailed: counts.ERRORS,
      preview: JSON.stringify(previewRows),
      errorLog: JSON.stringify(errors.slice(0, 500)),
      createdBy,
    },
  });

  return {
    import: created,
    summary: { ...counts, total: records.length, skippedInPreview: Math.max(0, records.length - PREVIEW_ROW_LIMIT) },
    preview: previewRows,
    errors,
    autoPublish: settings.autoPublish,
  };
}

function stripRaw(record) {
  const { raw, ...rest } = record;
  return rest;
}

/** Which stored fields this incoming record would change. */
function diffAgainst(current, record) {
  const changes = [];
  for (const field of COMPARED_FIELDS) {
    const incoming = record[field];
    if (incoming === undefined || incoming === null || incoming === '') continue;
    if (!eq(current[field], incoming)) {
      changes.push({ field, from: current[field], to: incoming });
    }
  }
  const incomingGallery = jsonField(record.gallery);
  if (incomingGallery && !eq(current.gallery, incomingGallery)) changes.push({ field: 'gallery', from: current.gallery, to: incomingGallery });
  const incomingSpecs = jsonField(record.specs);
  if (incomingSpecs && !eq(current.specs, incomingSpecs)) changes.push({ field: 'specs', from: current.specs, to: incomingSpecs });
  const incomingAllowed = jsonField(record.allowedCountries);
  if (incomingAllowed && !eq(current.allowedCountries, incomingAllowed)) changes.push({ field: 'allowedCountries', from: current.allowedCountries, to: incomingAllowed });
  const incomingBlocked = jsonField(record.blockedCountries);
  if (incomingBlocked && !eq(current.blockedCountries, incomingBlocked)) changes.push({ field: 'blockedCountries', from: current.blockedCountries, to: incomingBlocked });
  const incomingDocs = jsonField(record.documentationRequired);
  if (incomingDocs && !eq(current.documentationRequired, incomingDocs)) changes.push({ field: 'documentationRequired', from: current.documentationRequired, to: incomingDocs });
  return changes;
}

/* -------------------------------------------------------------------- commit */

/**
 * Applies a previewed import. Safe to re-run: every write is a compared
 * upsert, so a second commit produces zero changes.
 */
async function commit({ tenantId = 'default', importId, publish = null, actorId = null }) {
  const record = await prisma.supplierCatalogImport.findFirst({ where: { id: importId, tenantId } });
  if (!record) throw Object.assign(new Error('Import not found'), { status: 404 });
  if (record.status === 'COMMITTED') throw Object.assign(new Error('This import has already been committed'), { status: 409 });
  if (record.status === 'CANCELLED') throw Object.assign(new Error('This import was cancelled'), { status: 409 });

  const preview = JSON.parse(record.preview || '[]');
  const settings = await marketplaceSettings.read(tenantId);
  const supplier = await prisma.supplier.findFirst({ where: { id: record.supplierId, tenantId } });
  if (!supplier) throw Object.assign(new Error('Supplier no longer exists'), { status: 404 });
  const globalRule = await marketplaceSettings.globalMarkupRule(tenantId);
  const categoryRules = await prisma.supplierMarkupRule.findMany({ where: { tenantId, scope: 'CATEGORY', isActive: true } });
  const categories = await prisma.category.findMany({ select: { id: true, name: true, slug: true } });

  const counts = { created: 0, updated: 0, unchanged: 0, failed: 0, mapped: 0, published: 0 };
  const errors = [];

  // One transaction per row: atomic per record, so a failure never rolls back
  // the rest of the import, and no single transaction has to hold a lock across
  // thousands of rows (which would blow the interactive-transaction timeout).
  for (const row of preview) {
    try {
      let outcome = null;
      let mapped = false;
      const result = await prisma.$transaction(async (tx) => {
        if (row.verdict === 'ERROR') return 'failed';
        const data = row.record;

        const categoryId = resolveCategory(categories, data.categoryText);
        const base = {
          name: data.name,
          description: data.description || null,
          brand: data.brand || null,
          categoryText: data.categoryText || null,
          categoryId: categoryId || null,
          manufacturerPart: data.manufacturerPart || null,
          upc: data.upc || null,
          supplierCost: Number(data.supplierCost) || 0,
          currency: data.currency || supplier.currency || settings.defaultCurrency,
          msrp: data.msrp ?? null,
          stock: Math.max(0, Math.trunc(Number(data.stock) || 0)),
          stockStatus: data.stockStatus || null,
          imageUrl: data.imageUrl || null,
          gallery: jsonField(data.gallery),
          specs: jsonField(data.specs),
          weightKg: data.weightKg ?? null,
          lengthCm: data.lengthCm ?? null,
          widthCm: data.widthCm ?? null,
          heightCm: data.heightCm ?? null,
          restricted: Boolean(data.restricted),
          restrictionType: data.restrictionType || null,
          restrictionNotes: data.restrictionNotes || null,
          documentationRequired: jsonField(data.documentationRequired),
          allowedCountries: jsonField(data.allowedCountries),
          blockedCountries: jsonField(data.blockedCountries),
          lastSyncedAt: new Date(),
          syncStatus: row.verdict === 'NEW' ? 'NEW' : 'CHANGED',
          lastSyncError: null,
        };

        let supplierProduct;
        if (row.verdict === 'NEW') {
          supplierProduct = await tx.supplierProduct.create({
            data: {
              tenantId, supplierId: record.supplierId, supplierSku: data.supplierSku,
              ...base, mappingStatus: 'UNMAPPED',
            },
          });
          outcome = 'created';
        } else if (row.verdict === 'UPDATED') {
          supplierProduct = await tx.supplierProduct.update({
            where: { tenantId_supplierId_supplierSku: { tenantId, supplierId: record.supplierId, supplierSku: data.supplierSku } },
            data: { ...base, syncStatus: 'CHANGED' },
          });
          outcome = 'updated';
        } else {
          supplierProduct = await tx.supplierProduct.findUnique({
            where: { tenantId_supplierId_supplierSku: { tenantId, supplierId: record.supplierId, supplierSku: data.supplierSku } },
          });
          outcome = 'unchanged';
        }

        if (!supplierProduct) return 'failed';

        // Re-price with the markup engine (unless the operator pinned a price).
        if (supplierProduct.priceOverride === null || supplierProduct.priceOverride === undefined) {
          const price = priceFor({
            supplierProduct: { ...supplierProduct, ...base, id: supplierProduct.id },
            supplier, categoryRules, globalRule,
          });
          if (!eq(supplierProduct.sellingPrice, price.price)) {
            supplierProduct = await tx.supplierProduct.update({
              where: { id: supplierProduct.id },
              data: { sellingPrice: price.price, markupApplied: JSON.stringify(price.rule) },
            });
          }
        }

        // Persist the SKU → platform product mapping so later syncs never
        // duplicate the product.
        const existingMapping = await tx.supplierProductMapping.findUnique({ where: { supplierProductId: supplierProduct.id } });
        if (!existingMapping) {
          const match = row.matchedProduct
            ? { id: row.matchedProduct.id, matchKey: row.matchedProduct.matchKey || 'SKU' }
            : await matchPlatformProduct(data, tx, tenantId);
          if (match) {
            const taken = await tx.supplierProductMapping.findFirst({ where: { tenantId, productId: match.id } });
            if (!taken) {
              await tx.supplierProductMapping.create({
                data: {
                  tenantId, supplierId: record.supplierId, supplierProductId: supplierProduct.id,
                  productId: match.id, supplierSku: data.supplierSku,
                  matchKey: match.matchKey || 'SKU', source: 'AUTO', confidence: match.confidence || 80,
                },
              });
              await tx.supplierProduct.update({ where: { id: supplierProduct.id }, data: { mappingStatus: 'AUTO' } });
              mapped = true;
            }
          }
        }

        return outcome;
      }, { timeout: 30000, maxWait: 10000 });

      // Counters only move once the row has actually committed, so a rolled-back
      // row can never inflate the reported totals.
      if (result === 'created') counts.created++;
      else if (result === 'updated') counts.updated++;
      else if (result === 'unchanged') counts.unchanged++;
      else counts.failed++;
      if (mapped) counts.mapped++;
      if ((publish === null ? settings.autoPublish : publish) && result !== 'failed') {
        const sp = await prisma.supplierProduct.findUnique({
          where: { tenantId_supplierId_supplierSku: { tenantId, supplierId: record.supplierId, supplierSku: row.record.supplierSku } },
        });
        if (sp && !sp.published) counts.published++;
      }
    } catch (err) {
      counts.failed++;
      errors.push({ row: row.row, sku: row.record?.supplierSku || null, errors: [{ field: 'commit', message: err.message }] });
    }
  }

  const finished = await prisma.supplierCatalogImport.update({
    where: { id: record.id },
    data: {
      status: 'COMMITTED',
      rowsCreated: counts.created,
      rowsUpdated: counts.updated,
      rowsUnchanged: counts.unchanged,
      rowsFailed: counts.failed,
      committedAt: new Date(),
    },
  });

  return {
    import: finished,
    summary: {
      NEW: counts.created, UPDATED: counts.updated, UNCHANGED: counts.unchanged,
      ERRORS: counts.failed, MAPPED: counts.mapped, PUBLISHED: counts.published,
    },
    errors,
    publishRequested: publish === null ? settings.autoPublish : publish,
  };
}

/** Matches a supplier's free-text category against the platform's categories. */
function resolveCategory(categories, text) {
  if (!text) return null;
  const needle = String(text).trim().toLowerCase();
  if (!needle) return null;
  const exact = categories.find((c) => c.name.toLowerCase() === needle || c.slug === needle);
  if (exact) return exact.id;
  const partial = categories.find((c) => needle.includes(c.name.toLowerCase()) || c.name.toLowerCase().includes(needle));
  return partial ? partial.id : null;
}

async function cancel({ tenantId = 'default', importId }) {
  const record = await prisma.supplierCatalogImport.findFirst({ where: { id: importId, tenantId } });
  if (!record) throw Object.assign(new Error('Import not found'), { status: 404 });
  if (record.status === 'COMMITTED') throw Object.assign(new Error('A committed import cannot be cancelled'), { status: 409 });
  return prisma.supplierCatalogImport.update({ where: { id: importId }, data: { status: 'CANCELLED' } });
}

module.exports = {
  parseUpload, parseContent, detectFormat, validateRecord, matchPlatformProduct,
  buildPreview, commit, cancel, diffAgainst, resolveCategory,
  MAX_BYTES, MAX_IMPORT_ROWS,
};
