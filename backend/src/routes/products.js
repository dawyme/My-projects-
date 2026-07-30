const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect, adminOnly } = require('../middleware/auth');
const { upload, persistImage, removeImage } = require('../middleware/upload');
const { paginationSchema, buildOrderBy, meta, toCsv } = require('../lib/pagination');
const { badRequest, notFound } = require('../lib/errors');
const { audit, activity } = require('../lib/audit');
const cache = require('../lib/cache');

const router = express.Router();
const SORTABLE = ['createdAt', 'updatedAt', 'name', 'price', 'quantity', 'sku'];

const slugify = (s) => String(s).toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

async function uniqueSlug(base, ignoreId) {
  let slug = base || 'product';
  let n = 1;
  // Slug collisions get a numeric suffix.
  while (true) {
    const found = await prisma.product.findUnique({ where: { slug } });
    if (!found || found.id === ignoreId) return slug;
    slug = `${base}-${++n}`;
  }
}

const numeric = z.coerce.number();
const productBody = z.object({
  sku: z.string().trim().min(2).max(60),
  name: z.string().trim().min(2).max(180),
  description: z.string().trim().max(5000).optional().nullable(),
  brand: z.string().trim().max(80).optional().nullable(),
  model: z.string().trim().max(80).optional().nullable(),
  categoryId: z.string().uuid('A valid category is required'),
  price: numeric.min(0).default(0),
  costPrice: numeric.min(0).default(0),
  quantity: z.coerce.number().int().min(0).default(0),
  lowStockLevel: z.coerce.number().int().min(0).default(5),
  unit: z.string().trim().max(20).default('unit'),
  imageUrl: z.string().trim().max(400).optional().nullable(),
  gallery: z.union([z.string(), z.array(z.string())]).optional().nullable(),
  specs: z.union([z.string(), z.record(z.any())]).optional().nullable(),
  featured: z.coerce.boolean().default(false),
  isActive: z.coerce.boolean().default(true),
});

const toJsonString = (v) => (v === undefined || v === null || v === '') ? null : (typeof v === 'string' ? v : JSON.stringify(v));

const listQuery = paginationSchema.extend({
  category: z.string().optional(),
  featured: z.enum(['true', 'false']).optional(),
  active: z.enum(['true', 'false']).optional(),
  lowStock: z.enum(['true', 'false']).optional(),
  minPrice: z.coerce.number().optional(),
  maxPrice: z.coerce.number().optional(),
  format: z.enum(['json', 'csv']).default('json'),
});

function buildWhere(q) {
  const where = {};
  if (q.search) {
    where.OR = [
      { name: { contains: q.search } },
      { sku: { contains: q.search } },
      { brand: { contains: q.search } },
      { model: { contains: q.search } },
      { description: { contains: q.search } },
    ];
  }
  if (q.category) where.category = { OR: [{ id: q.category }, { slug: q.category }] };
  if (q.featured) where.featured = q.featured === 'true';
  if (q.active) where.isActive = q.active === 'true';
  if (q.minPrice !== undefined || q.maxPrice !== undefined) {
    where.price = {};
    if (q.minPrice !== undefined) where.price.gte = q.minPrice;
    if (q.maxPrice !== undefined) where.price.lte = q.maxPrice;
  }
  return where;
}

// GET /api/products
router.get('/', protect, validate(listQuery, 'query'), asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const where = buildWhere(q);
  const orderBy = buildOrderBy(q.sort, q.order, SORTABLE);

  if (q.format === 'csv') {
    const all = await prisma.product.findMany({ where, orderBy, include: { category: true } });
    const rows = q.lowStock === 'true' ? all.filter((p) => p.quantity <= p.lowStockLevel) : all;
    res.header('Content-Type', 'text/csv');
    res.attachment('products.csv');
    return res.send(toCsv(rows, [
      { label: 'SKU', value: 'sku' }, { label: 'Name', value: 'name' },
      { label: 'Category', value: (r) => r.category?.name },
      { label: 'Brand', value: 'brand' }, { label: 'Price', value: 'price' },
      { label: 'Quantity', value: 'quantity' }, { label: 'Low Stock Level', value: 'lowStockLevel' },
      { label: 'Featured', value: 'featured' }, { label: 'Active', value: 'isActive' },
    ]));
  }

  // Low-stock is a row-level comparison SQLite/Prisma cannot express in `where`,
  // so it is applied after fetching a bounded candidate set.
  if (q.lowStock === 'true') {
    const all = await prisma.product.findMany({ where, orderBy, include: { category: true } });
    const filtered = all.filter((p) => p.quantity <= p.lowStockLevel);
    const start = (q.page - 1) * q.limit;
    return res.json({ success: true, data: filtered.slice(start, start + q.limit), meta: meta(filtered.length, q.page, q.limit) });
  }

  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where, orderBy, skip: (q.page - 1) * q.limit, take: q.limit,
      include: { category: { select: { id: true, name: true, slug: true } } },
    }),
    prisma.product.count({ where }),
  ]);
  res.json({ success: true, data: items, meta: meta(total, q.page, q.limit) });
}));

// GET /api/products/:id
router.get('/:id', protect, asyncHandler(async (req, res) => {
  const product = await prisma.product.findUnique({
    where: { id: req.params.id },
    include: {
      category: true,
      restocks: { orderBy: { receivedAt: 'desc' }, take: 10 },
      adjustments: { orderBy: { createdAt: 'desc' }, take: 10, include: { user: { select: { name: true } } } },
    },
  });
  if (!product) throw notFound('Product not found');
  res.json({ success: true, data: product });
}));

// POST /api/products
router.post('/', protect, validate(productBody), asyncHandler(async (req, res) => {
  const body = req.body;
  const category = await prisma.category.findUnique({ where: { id: body.categoryId } });
  if (!category) throw badRequest('Category does not exist');
  const product = await prisma.product.create({
    data: {
      ...body,
      sku: body.sku.toUpperCase(),
      slug: await uniqueSlug(slugify(body.name)),
      gallery: toJsonString(body.gallery),
      specs: toJsonString(body.specs),
    },
    include: { category: true },
  });
  cache.invalidate('stats');
  await audit(req, 'CREATE', 'Product', product.id, { sku: product.sku });
  await activity(req.user.id, 'product', `${req.user.name} created product ${product.name}`);
  res.status(201).json({ success: true, data: product });
}));

// PUT /api/products/:id
router.put('/:id', protect, validate(productBody.partial()), asyncHandler(async (req, res) => {
  const existing = await prisma.product.findUnique({ where: { id: req.params.id } });
  if (!existing) throw notFound('Product not found');
  const data = { ...req.body };
  if (data.sku) data.sku = data.sku.toUpperCase();
  if (data.name && data.name !== existing.name) data.slug = await uniqueSlug(slugify(data.name), existing.id);
  if ('gallery' in data) data.gallery = toJsonString(data.gallery);
  if ('specs' in data) data.specs = toJsonString(data.specs);

  const product = await prisma.product.update({ where: { id: existing.id }, data, include: { category: true } });
  cache.invalidate('stats');
  await audit(req, 'UPDATE', 'Product', product.id, data);
  await activity(req.user.id, 'product', `${req.user.name} updated product ${product.name}`);
  res.json({ success: true, data: product });
}));

// DELETE /api/products/:id
router.delete('/:id', protect, adminOnly, asyncHandler(async (req, res) => {
  const product = await prisma.product.findUnique({ where: { id: req.params.id }, include: { orderItems: true } });
  if (!product) throw notFound('Product not found');
  if (product.orderItems.length) {
    // Preserve order history: archive instead of hard delete.
    await prisma.product.update({ where: { id: product.id }, data: { isActive: false } });
    await audit(req, 'ARCHIVE', 'Product', product.id);
    return res.json({ success: true, message: 'Product has sales history and was archived instead of deleted' });
  }
  await prisma.product.delete({ where: { id: product.id } });
  removeImage(product.imageUrl);
  cache.invalidate('stats');
  await audit(req, 'DELETE', 'Product', product.id, { sku: product.sku });
  await activity(req.user.id, 'product', `${req.user.name} deleted product ${product.name}`);
  res.json({ success: true, message: 'Product deleted' });
}));

// POST /api/products/bulk-delete
router.post('/bulk-delete', protect, adminOnly,
  validate(z.object({ ids: z.array(z.string().uuid()).min(1).max(200) })),
  asyncHandler(async (req, res) => {
    const withHistory = await prisma.orderItem.findMany({
      where: { productId: { in: req.body.ids } }, select: { productId: true }, distinct: ['productId'],
    });
    const protectedIds = withHistory.map((i) => i.productId);
    const deletable = req.body.ids.filter((id) => !protectedIds.includes(id));
    const products = await prisma.product.findMany({ where: { id: { in: deletable } }, select: { imageUrl: true } });
    const [{ count }] = await Promise.all([
      prisma.product.deleteMany({ where: { id: { in: deletable } } }),
      protectedIds.length
        ? prisma.product.updateMany({ where: { id: { in: protectedIds } }, data: { isActive: false } })
        : Promise.resolve(),
    ]);
    products.forEach((p) => removeImage(p.imageUrl));
    cache.invalidate('stats');
    await audit(req, 'BULK_DELETE', 'Product', null, { deleted: count, archived: protectedIds.length });
    await activity(req.user.id, 'product', `${req.user.name} bulk-deleted ${count} product(s)`);
    res.json({ success: true, data: { deleted: count, archived: protectedIds.length } });
  }));

// POST /api/products/bulk-update
const bulkUpdate = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  updates: z.object({
    categoryId: z.string().uuid().optional(),
    featured: z.coerce.boolean().optional(),
    isActive: z.coerce.boolean().optional(),
    priceAdjustPercent: z.coerce.number().min(-90).max(500).optional(),
    price: numeric.min(0).optional(),
    quantity: z.coerce.number().int().min(0).optional(),
    lowStockLevel: z.coerce.number().int().min(0).optional(),
    brand: z.string().trim().max(80).optional(),
  }).refine((o) => Object.keys(o).length > 0, 'At least one field must be provided'),
});
router.post('/bulk-update', protect, validate(bulkUpdate), asyncHandler(async (req, res) => {
  const { ids, updates } = req.body;
  const { priceAdjustPercent, ...direct } = updates;
  let updated = 0;

  if (Object.keys(direct).length) {
    const r = await prisma.product.updateMany({ where: { id: { in: ids } }, data: direct });
    updated = r.count;
  }
  if (priceAdjustPercent !== undefined) {
    const products = await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, price: true } });
    await prisma.$transaction(products.map((p) => prisma.product.update({
      where: { id: p.id },
      data: { price: Math.max(0, Math.round(p.price * (1 + priceAdjustPercent / 100) * 100) / 100) },
    })));
    updated = Math.max(updated, products.length);
  }
  cache.invalidate('stats');
  await audit(req, 'BULK_UPDATE', 'Product', null, { count: updated, updates });
  await activity(req.user.id, 'product', `${req.user.name} bulk-updated ${updated} product(s)`);
  res.json({ success: true, data: { updated } });
}));

// POST /api/products/:id/image
router.post('/:id/image', protect, upload.single('image'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No image uploaded (field name: image)');
  const existing = await prisma.product.findUnique({ where: { id: req.params.id } });
  if (!existing) throw notFound('Product not found');
  const imageUrl = await persistImage(req.file);
  if (existing.imageUrl) removeImage(existing.imageUrl);
  const product = await prisma.product.update({ where: { id: existing.id }, data: { imageUrl } });
  await audit(req, 'UPLOAD_IMAGE', 'Product', product.id, { imageUrl });
  res.json({ success: true, data: product });
}));

// POST /api/products/:id/gallery
router.post('/:id/gallery', protect, upload.array('images', 8), asyncHandler(async (req, res) => {
  if (!req.files?.length) throw badRequest('No images uploaded (field name: images)');
  const existing = await prisma.product.findUnique({ where: { id: req.params.id } });
  if (!existing) throw notFound('Product not found');
  const urls = [];
  for (const f of req.files) urls.push(await persistImage(f));
  const current = existing.gallery ? JSON.parse(existing.gallery) : [];
  const product = await prisma.product.update({
    where: { id: existing.id }, data: { gallery: JSON.stringify([...current, ...urls].slice(0, 12)) },
  });
  await audit(req, 'UPLOAD_GALLERY', 'Product', product.id, { count: urls.length });
  res.json({ success: true, data: product });
}));

module.exports = router;
