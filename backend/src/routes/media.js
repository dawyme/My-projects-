const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { protect, adminOnly } = require('../middleware/auth');
const { upload, persistMedia, removeImage } = require('../middleware/upload');
const { badRequest, notFound } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { tenantWhere } = require('../lib/tenant');
const cache = require('../lib/cache');

const router = express.Router();

function meta(total, page, limit) {
  return { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)), hasNext: page * limit < total, hasPrev: page > 1 };
}

// GET /api/media — list/search/filter the media library
router.get('/', protect, asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '24', 10)));
  const where = { businessId: req.tenantId };
  if (req.query.folder) where.folder = String(req.query.folder);
  if (req.query.type) where.mimeType = { contains: String(req.query.type) };
  if (req.query.search) {
    const s = String(req.query.search).slice(0, 120);
    where.OR = [{ filename: { contains: s } }, { alt: { contains: s } }];
  }
  const [items, total] = await Promise.all([
    prisma.mediaAsset.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.mediaAsset.count({ where }),
  ]);
  const folders = await prisma.mediaAsset.groupBy({ by: ['folder'], _count: { _all: true }, where: { businessId: req.tenantId } });
  res.json({ success: true, data: items, folders: folders.map((f) => ({ folder: f.folder, count: f._count._all })), meta: meta(total, page, limit) });
}));

// GET /api/media/:id
router.get('/:id', protect, asyncHandler(async (req, res) => {
  const asset = await prisma.mediaAsset.findFirst({ where: tenantWhere(req, { id: req.params.id }) });
  if (!asset) throw notFound('Media asset not found');
  res.json({ success: true, data: asset });
}));

// POST /api/media/upload — upload one or more images
router.post('/upload', protect, upload.array('images', 8), asyncHandler(async (req, res) => {
  if (!req.files || !req.files.length) throw badRequest('No images uploaded (field name: images)');
  const folder = req.body.folder && String(req.body.folder).startsWith('/') ? String(req.body.folder) : '/';
  const assets = [];
  for (const file of req.files) {
    const meta = await persistMedia(file, { folder });
    const asset = await prisma.mediaAsset.create({ data: { ...meta, businessId: req.tenantId, alt: req.body.alt || null } });
    assets.push(asset);
  }
  cache.invalidate(`public:media:${req.tenantId}`);
  await audit(req, 'UPLOAD_MEDIA', 'MediaAsset', assets[0].id, { count: assets.length, folder });
  res.status(201).json({ success: true, data: assets });
}));

// PATCH /api/media/:id — update metadata (alt, folder)
router.patch('/:id', protect, asyncHandler(async (req, res) => {
  const parsed = z.object({
    alt: z.string().trim().max(300).optional().nullable(),
    folder: z.string().trim().max(200).optional(),
    filename: z.string().trim().max(200).optional(),
  }).safeParse(req.body);
  if (!parsed.success) throw badRequest('Validation failed', parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
  const asset = await prisma.mediaAsset.findFirst({ where: tenantWhere(req, { id: req.params.id }) });
  if (!asset) throw notFound('Media asset not found');
  const updated = await prisma.mediaAsset.update({ where: { id: asset.id }, data: parsed.data });
  cache.invalidate(`public:media:${req.tenantId}`);
  await audit(req, 'UPDATE_MEDIA', 'MediaAsset', updated.id, parsed.data);
  res.json({ success: true, data: updated });
}));

// POST /api/media/:id/replace — replace the file, keep the id
router.post('/:id/replace', protect, upload.single('image'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No image uploaded (field name: image)');
  const asset = await prisma.mediaAsset.findFirst({ where: tenantWhere(req, { id: req.params.id }) });
  if (!asset) throw notFound('Media asset not found');
  removeImage(asset.url);
  if (asset.thumbUrl) removeImage(asset.thumbUrl);
  const meta = await persistMedia(req.file, { folder: asset.folder || '/' });
  const updated = await prisma.mediaAsset.update({ where: { id: asset.id }, data: meta });
  cache.invalidate(`public:media:${req.tenantId}`);
  await audit(req, 'REPLACE_MEDIA', 'MediaAsset', updated.id);
  res.json({ success: true, data: updated });
}));

// DELETE /api/media/:id — admin only
router.delete('/:id', protect, adminOnly, asyncHandler(async (req, res) => {
  const asset = await prisma.mediaAsset.findFirst({ where: tenantWhere(req, { id: req.params.id }) });
  if (!asset) throw notFound('Media asset not found');
  removeImage(asset.url);
  if (asset.thumbUrl) removeImage(asset.thumbUrl);
  await prisma.mediaAsset.delete({ where: { id: asset.id } });
  cache.invalidate(`public:media:${req.tenantId}`);
  await audit(req, 'DELETE_MEDIA', 'MediaAsset', req.params.id);
  res.json({ success: true, message: 'Media asset deleted' });
}));

module.exports = router;
