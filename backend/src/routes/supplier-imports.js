/**
 * Supplier catalogue import API.
 *
 *   GET    /api/supplier-imports                       import history
 *   GET    /api/supplier-imports/template.csv          a correctly shaped sample
 *   POST   /api/supplier-imports/preview               preview from a pasted/uploaded feed
 *   POST   /api/supplier-imports/preview-file          multipart upload → preview
 *   POST   /api/supplier-imports/preview-integration   pull from the connector → preview
 *   GET    /api/supplier-imports/:id                   preview detail
 *   POST   /api/supplier-imports/:id/commit            apply it
 *   POST   /api/supplier-imports/:id/cancel            throw it away
 *   GET    /api/supplier-imports/:id/errors.csv        download the error report
 *
 * Nothing touches the catalogue until /commit. The preview is computed from the
 * same code path the commit uses, so the NEW / UPDATED / UNCHANGED / ERRORS
 * counts the operator reviews are the counts they get.
 */
const express = require('express');
const { z } = require('zod');
const multer = require('multer');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/supplierPermissions');
const { scopeTenant, tenantOf } = require('../lib/suppliers/tenant');
const { paginationSchema, meta } = require('../lib/pagination');
const { badRequest, notFound } = require('../lib/errors');
const { audit, activity } = require('../lib/audit');
const importer = require('../lib/suppliers/importer');
const catalogue = require('../lib/suppliers/catalogue');
const syncEngine = require('../lib/suppliers/sync-engine');
const { parseCsvObjects, toCsv, MAX_BYTES } = require('../lib/suppliers/parsers/csv');
const { sanitizeCell } = require('../lib/suppliers/parsers/csv');
const cache = require('../lib/cache');

const router = express.Router();

const FEED_TYPES = new Set([
  'text/csv', 'text/plain', 'text/tab-separated-values',
  'application/json', 'application/xml', 'text/xml',
  'application/octet-stream', '',
]);

const feedUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const name = String(file.originalname || '').toLowerCase();
    const okType = FEED_TYPES.has(file.mimetype);
    const okExt = /\.(csv|tsv|txt|xml|json)$/i.test(name);
    if (!okType || !okExt) return cb(badRequest('Only .csv, .tsv, .xml and .json feed files are accepted'));
    if (/\.(exe|sh|bat|js|svg|html?)$/i.test(name)) return cb(badRequest('Executable or markup files are not accepted'));
    cb(null, true);
  },
});

const TEMPLATE = `sku,mpn,upc,name,description,brand,category,cost,msrp,currency,stock,stock_status,image,weight_kg,restricted,restriction_type,allowed_countries
AC-SPLIT-12K-INV,DC-INV-12000,8901234567890,12000 BTU Inverter Split Air Conditioner,"12,000 BTU wall-mounted inverter split system, R-32 refrigerant",CoolTech,Split Air Conditioners,412.50,649.00,USD,48,IN_STOCK,https://cdn.supplier.example/img/ac-split-12k.jpg,38.5,false,,
COMP-SCROLL-5T,CS-0500-R410A,8901234567891,5 Ton Scroll Compressor R-410A,Hermetic scroll compressor for 5 ton condensing units,CoolTech,Compressors,745.00,1180.00,USD,6,LOW_STOCK,https://cdn.supplier.example/img/compressor-5t.jpg,52.0,false,,
REF-R410A-25LB,R410A-25,8901234567892,R-410A Refrigerant 25 lb,"Pre-charged R-410A cylinder, 25 lb net",ChillGas,Refrigerants,128.00,189.00,USD,20,IN_STOCK,,13.2,true,REFRIGERANT,TT|JM|BB
`;

router.use(protect, scopeTenant);

// GET /api/supplier-imports
router.get('/', requirePermission('suppliers.view'), validate(paginationSchema.extend({
  supplierId: z.string().optional(), status: z.string().optional(),
}), 'query'), asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const tenantId = tenantOf(req);
  const where = { tenantId };
  if (q.supplierId) where.supplierId = q.supplierId;
  if (q.status) where.status = q.status.toUpperCase();
  const [items, total] = await Promise.all([
    prisma.supplierCatalogImport.findMany({
      where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit,
      select: {
        id: true, tenantId: true, supplierId: true, integrationId: true, source: true, filename: true,
        status: true, rowsRead: true, rowsCreated: true, rowsUpdated: true, rowsUnchanged: true,
        rowsFailed: true, committedAt: true, createdBy: true, createdAt: true, updatedAt: true,
        supplier: { select: { id: true, name: true, code: true } },
      },
    }),
    prisma.supplierCatalogImport.count({ where }),
  ]);
  res.json({ success: true, data: items, meta: meta(total, q.page, q.limit) });
}));

// GET /api/supplier-imports/template.csv
router.get('/template.csv', requirePermission('imports.manage'), (req, res) => {
  res.header('Content-Type', 'text/csv; charset=utf-8');
  res.attachment('supplier-catalogue-template.csv');
  res.send(TEMPLATE);
});

/** Shared preview builder used by all three entry points. */
/** Feed parse failures are the caller's problem, not a server fault. */
function guardParse(fn) {
  return (...args) => {
    try { return fn(...args); }
    catch (err) {
      if (err.name === 'XmlError' || err.name === 'CsvError') {
        throw badRequest(`The feed could not be parsed: ${err.message}`, [{ field: 'file', message: err.message }]);
      }
      throw err;
    }
  };
}

async function previewFromRecords({ tenantId, supplierId, integrationId, source, filename, parsed, userId }) {
  const supplier = await prisma.supplier.findFirst({ where: { id: supplierId, tenantId } });
  if (!supplier) throw badRequest('Supplier not found', [{ field: 'supplierId', message: 'Supplier not found' }]);
  if (supplier.status === 'ARCHIVED') throw badRequest('Archived suppliers cannot be imported into');
  if (!parsed.records.length) {
    throw badRequest(parsed.parseError || 'The feed contained no rows');
  }
  return importer.buildPreview({
    tenantId, supplierId, integrationId, source, filename,
    records: parsed.records, createdBy: userId,
  });
}

// POST /api/supplier-imports/preview — raw content posted as text
router.post('/preview', requirePermission('imports.manage'), validate(z.object({
  supplierId: z.string().uuid(),
  filename: z.string().trim().max(200).optional(),
  format: z.enum(['CSV', 'XML', 'JSON']).optional(),
  content: z.string().min(1).max(MAX_BYTES),
  itemsPath: z.string().trim().max(200).optional(),
  delimiter: z.string().trim().max(2).optional(),
  columnMap: z.record(z.string()).optional(),
})), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const body = req.body;
  const parsed = guardParse(importer.parseUpload)({
    filename: body.filename, content: body.content, columnMap: body.columnMap,
    itemsPath: body.itemsPath, delimiter: body.delimiter, format: body.format,
  });
  const result = await previewFromRecords({
    tenantId, supplierId: body.supplierId, integrationId: null,
    source: 'UPLOAD', filename: body.filename || null, parsed, userId: req.user.id,
  });
  res.status(201).json({
    success: true,
    data: {
      importId: result.import.id,
      summary: result.summary,
      format: parsed.format,
      headers: parsed.headers,
      columnMap: parsed.columnMap,
      suggestedColumnMap: parsed.suggestedColumnMap,
      preview: result.preview,
      errors: result.errors,
      truncated: parsed.truncated,
    },
    message: `Preview ready — ${result.summary.NEW} new, ${result.summary.UPDATED} updated, ${result.summary.UNCHANGED} unchanged, ${result.summary.ERRORS} error(s). Nothing has been written yet.`,
  });
}));

// POST /api/supplier-imports/preview-file — multipart upload
router.post('/preview-file', requirePermission('imports.manage'), feedUpload.single('file'),
  asyncHandler(async (req, res) => {
    const tenantId = tenantOf(req);
    if (!req.file) throw badRequest('No file uploaded (field name: file)');
    const supplierId = req.body.supplierId;
    if (!supplierId) throw badRequest('supplierId is required');

    const content = req.file.buffer.toString('utf8');
    const parsed = guardParse(importer.parseUpload)({
      filename: req.file.originalname, mimetype: req.file.mimetype, content,
      itemsPath: req.body.itemsPath || undefined,
      delimiter: req.body.delimiter || undefined,
      format: req.body.format || undefined,
      columnMap: req.body.columnMap ? JSON.parse(req.body.columnMap) : undefined,
    });
    const result = await previewFromRecords({
      tenantId, supplierId, integrationId: null, source: 'UPLOAD',
      filename: req.file.originalname, parsed, userId: req.user.id,
    });
    await audit(req, 'IMPORT_PREVIEW', 'SupplierCatalogImport', result.import.id, {
      filename: req.file.originalname, rows: parsed.records.length, format: parsed.format,
    });
    res.status(201).json({
      success: true,
      data: {
        importId: result.import.id, summary: result.summary, format: parsed.format,
        headers: parsed.headers, columnMap: parsed.columnMap,
        suggestedColumnMap: parsed.suggestedColumnMap,
        preview: result.preview, errors: result.errors, truncated: parsed.truncated,
      },
      message: `Preview ready — ${result.summary.NEW} new, ${result.summary.UPDATED} updated, ${result.summary.UNCHANGED} unchanged, ${result.summary.ERRORS} error(s). Nothing has been written yet.`,
    });
  }));

// POST /api/supplier-imports/preview-integration — pull the live feed first
router.post('/preview-integration', requirePermission('imports.manage'),
  validate(z.object({ supplierId: z.string().uuid(), limit: z.coerce.number().int().min(1).max(5000).default(500) })),
  asyncHandler(async (req, res) => {
    const tenantId = tenantOf(req);
    const supplier = await prisma.supplier.findFirst({ where: { id: req.body.supplierId, tenantId }, include: { integration: true } });
    if (!supplier) throw notFound('Supplier not found');
    if (!supplier.integration) throw badRequest('This supplier has no integration configured — use file upload instead');

    const adapter = await syncEngine.adapterFor(supplier.integration, supplier);
    if (!adapter.supports('importCatalog')) {
      throw badRequest(`${supplier.integration.connectorType} cannot import a catalogue — use file upload instead`);
    }
    if (!adapter.hasCredentials()) {
      throw badRequest('Not connected — credentials required. Add them under Supplier Integrations before importing.');
    }

    const records = [];
    const columnMap = (() => {
      try { return JSON.parse(supplier.integration.config || '{}').columnMap; } catch { return undefined; }
    })();
    for await (const batch of adapter.fetchCatalog({ limit: Math.min(500, req.body.limit) })) {
      records.push(...batch.records);
      if (records.length >= req.body.limit || batch.done) break;
    }

    const parsed = {
      records: records.slice(0, req.body.limit),
      headers: records.length ? Object.keys(records[0].raw || records[0]) : [],
      columnMap: columnMap || {}, suggestedColumnMap: columnMap || {},
      truncated: records.length > req.body.limit, parseError: records.length ? null : 'The supplier feed returned no records',
    };

    const result = await previewFromRecords({
      tenantId, supplierId: supplier.id, integrationId: supplier.integration.id,
      source: supplier.integration.connectorType.includes('FEED') ? 'API' : 'API',
      filename: null, parsed, userId: req.user.id,
    });
    await audit(req, 'IMPORT_PREVIEW', 'SupplierCatalogImport', result.import.id, {
      supplier: supplier.name, rows: records.length, source: 'integration',
    });
    res.status(201).json({
      success: true,
      data: { importId: result.import.id, summary: result.summary, preview: result.preview, errors: result.errors, truncated: parsed.truncated },
      message: `Pulled ${records.length} record(s) from ${supplier.name} — ${result.summary.NEW} new, ${result.summary.UPDATED} updated, ${result.summary.UNCHANGED} unchanged, ${result.summary.ERRORS} error(s).`,
    });
  }));

// GET /api/supplier-imports/:id
router.get('/:id', requirePermission('suppliers.view'), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const record = await prisma.supplierCatalogImport.findFirst({
    where: { id: req.params.id, tenantId }, include: { supplier: { select: { id: true, name: true, code: true } } },
  });
  if (!record) throw notFound('Import not found');
  res.json({
    success: true,
    data: {
      ...record,
      preview: JSON.parse(record.preview || '[]'),
      errorLog: JSON.parse(record.errorLog || '[]'),
      summary: {
        NEW: record.rowsCreated, UPDATED: record.rowsUpdated,
        UNCHANGED: record.rowsUnchanged, ERRORS: record.rowsFailed,
        total: record.rowsRead,
      },
    },
  });
}));

// POST /api/supplier-imports/:id/commit
router.post('/:id/commit', requirePermission('imports.manage'), validate(z.object({
  publish: z.coerce.boolean().optional(),
}).optional()), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const publish = req.body?.publish ?? null;
  const result = await importer.commit({ tenantId, importId: req.params.id, publish, actorId: req.user.id });

  if (result.publishRequested) {
    const pending = await prisma.supplierProduct.findMany({
      where: { tenantId, supplierId: result.import.supplierId, published: false, isActive: true },
      select: { id: true },
    });
    let published = 0;
    for (const p of pending) {
      try { await catalogue.publish({ tenantId, supplierProductId: p.id, actorId: req.user.id }); published++; }
      catch (_) { /* surfaced on the Supplier Products page */ }
    }
    result.summary.PUBLISHED = published;
  }

  cache.invalidate('stats');
  await audit(req, 'IMPORT_COMMIT', 'SupplierCatalogImport', result.import.id, result.summary);
  await activity(req.user.id, 'supplier', `${req.user.name} committed an import for ${result.import.supplierId.slice(0, 8)} — ${result.summary.NEW} new, ${result.summary.UPDATED} updated`);
  res.json({
    success: true,
    data: { import: { id: result.import.id, status: result.import.status }, summary: result.summary },
    message: `Import committed — ${result.summary.NEW} created, ${result.summary.UPDATED} updated, ${result.summary.UNCHANGED} unchanged, ${result.summary.ERRORS} error(s).`,
  });
}));

// POST /api/supplier-imports/:id/cancel
router.post('/:id/cancel', requirePermission('imports.manage'), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const updated = await importer.cancel({ tenantId, importId: req.params.id });
  await audit(req, 'IMPORT_CANCEL', 'SupplierCatalogImport', updated.id);
  res.json({ success: true, data: { id: updated.id, status: updated.status }, message: 'Import discarded — no catalogue changes were made.' });
}));

// GET /api/supplier-imports/:id/errors.csv
router.get('/:id/errors.csv', requirePermission('imports.manage'), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const record = await prisma.supplierCatalogImport.findFirst({ where: { id: req.params.id, tenantId } });
  if (!record) throw notFound('Import not found');
  const errors = JSON.parse(record.errorLog || '[]');
  const rows = [];
  for (const entry of errors) {
    for (const err of entry.errors || []) {
      rows.push({ row: entry.row, sku: entry.sku || '', field: err.field, message: sanitizeCell(err.message) });
    }
  }
  res.header('Content-Type', 'text/csv; charset=utf-8');
  res.attachment(`import-errors-${record.id.slice(0, 8)}.csv`);
  res.send(toCsv(rows, [
    { label: 'Row', value: 'row' }, { label: 'Supplier SKU', value: 'sku' },
    { label: 'Field', value: 'field' }, { label: 'Problem', value: 'message' },
  ]));
}));

module.exports = router;
module.exports.parseCsvObjects = parseCsvObjects;
