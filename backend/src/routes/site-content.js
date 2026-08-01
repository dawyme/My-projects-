const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { protect, adminOnly } = require('../middleware/auth');
const { badRequest, notFound } = require('../lib/errors');
const { audit } = require('../lib/audit');
const cache = require('../lib/cache');

const router = express.Router();

const slugify = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
const ref = { DRAFT: 'DRAFT', PUBLISHED: 'PUBLISHED' };

/** Per-collection configuration: prisma model, validation and list options. */
const COLLECTIONS = {
  services: {
    model: 'serviceItem',
    allowedSort: ['sortOrder', 'name', 'createdAt', 'updatedAt'],
    defaultSort: 'sortOrder',
    searchFields: ['name', 'description', 'content'],
    schema: z.object({
      name: z.string().trim().min(2).max(160),
      icon: z.string().trim().max(120).optional().nullable(),
      imageUrl: z.string().trim().max(400).optional().nullable(),
      description: z.string().trim().max(2000).optional().nullable(),
      content: z.string().trim().max(50000).optional().nullable(),
      sortOrder: z.coerce.number().int().default(0),
      featured: z.coerce.boolean().default(false),
      status: z.enum([ref.DRAFT, ref.PUBLISHED]).optional(),
    }),
  },
  testimonials: {
    model: 'testimonial',
    allowedSort: ['sortOrder', 'name', 'rating', 'createdAt'],
    defaultSort: 'sortOrder',
    searchFields: ['name', 'company', 'review'],
    schema: z.object({
      name: z.string().trim().min(2).max(120),
      company: z.string().trim().max(160).optional().nullable(),
      review: z.string().trim().min(3).max(4000),
      rating: z.coerce.number().int().min(1).max(5).default(5),
      photoUrl: z.string().trim().max(400).optional().nullable(),
      sortOrder: z.coerce.number().int().default(0),
      status: z.enum([ref.DRAFT, ref.PUBLISHED]).optional(),
    }),
  },
  gallery: {
    model: 'galleryItem',
    allowedSort: ['sortOrder', 'category', 'title', 'createdAt'],
    defaultSort: 'sortOrder',
    searchFields: ['title', 'alt', 'category'],
    filterFields: ['category'],
    schema: z.object({
      title: z.string().trim().max(200).optional().nullable(),
      alt: z.string().trim().max(300).optional().nullable(),
      category: z.string().trim().max(120).optional().nullable(),
      imageUrl: z.string().trim().min(1).max(500),
      thumbUrl: z.string().trim().max(500).optional().nullable(),
      sortOrder: z.coerce.number().int().default(0),
      status: z.enum([ref.DRAFT, ref.PUBLISHED]).optional(),
    }),
  },
  faqs: {
    model: 'faqItem',
    allowedSort: ['sortOrder', 'question', 'category', 'createdAt'],
    defaultSort: 'sortOrder',
    searchFields: ['question', 'answer'],
    filterFields: ['category'],
    schema: z.object({
      question: z.string().trim().min(3).max(400),
      answer: z.string().trim().min(3).max(10000),
      category: z.string().trim().max(120).optional().nullable(),
      sortOrder: z.coerce.number().int().default(0),
      status: z.enum([ref.DRAFT, ref.PUBLISHED]).optional(),
    }),
  },
  promotions: {
    model: 'promotionItem',
    allowedSort: ['sortOrder', 'title', 'createdAt', 'endAt'],
    defaultSort: 'sortOrder',
    searchFields: ['title', 'body', 'badge'],
    schema: z.object({
      title: z.string().trim().min(2).max(200),
      body: z.string().trim().max(4000).optional().nullable(),
      imageUrl: z.string().trim().max(500).optional().nullable(),
      link: z.string().trim().max(500).optional().nullable(),
      badge: z.string().trim().max(80).optional().nullable(),
      sortOrder: z.coerce.number().int().default(0),
      status: z.enum([ref.DRAFT, ref.PUBLISHED]).optional(),
      startAt: z.coerce.date().optional().nullable(),
      endAt: z.coerce.date().optional().nullable(),
    }),
  },
  team: {
    model: 'teamMember',
    allowedSort: ['sortOrder', 'name', 'createdAt'],
    defaultSort: 'sortOrder',
    searchFields: ['name', 'role', 'bio'],
    schema: z.object({
      name: z.string().trim().min(2).max(120),
      role: z.string().trim().max(160).optional().nullable(),
      bio: z.string().trim().max(3000).optional().nullable(),
      photoUrl: z.string().trim().max(500).optional().nullable(),
      sortOrder: z.coerce.number().int().default(0),
      status: z.enum([ref.DRAFT, ref.PUBLISHED]).optional(),
    }),
  },
};

function paginateMeta(total, page, limit) {
  return { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)), hasNext: page * limit < total, hasPrev: page > 1 };
}

function listConfig(name) {
  const c = COLLECTIONS[name];
  if (!c) return null;
  return { c, db: prisma[c.model] };
}

function parse(body, schema) {
  const res = schema.safeParse(body);
  if (!res.success) {
    throw badRequest('Validation failed', res.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
  }
  return res.data;
}

// GET /api/site-content/:collection — list with pagination, search, filter & sort
router.get('/:collection', protect, asyncHandler(async (req, res) => {
  const conf = listConfig(req.params.collection);
  if (!conf) throw notFound(`Unknown collection '${req.params.collection}'`);
  const { c, db } = conf;
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
  const where = {};
  if (req.query.status) where.status = String(req.query.status).toUpperCase();
  if (req.query.featured === 'true' && 'featured' in c) where.featured = true;
  for (const f of c.filterFields || []) {
    if (req.query[f]) where[f] = String(req.query[f]);
  }
  if (req.query.search) {
    const s = String(req.query.search).slice(0, 120);
    where.OR = c.searchFields.map((f) => ({ [f]: { contains: s } }));
  }
  const sort = req.query.sort && c.allowedSort.includes(req.query.sort) ? req.query.sort : c.defaultSort;
  const order = req.query.order === 'desc' ? 'desc' : (sort === 'sortOrder' ? 'asc' : 'desc');
  const [items, total] = await Promise.all([
    db.findMany({ where, orderBy: [{ [sort]: order }, { createdAt: 'asc' }], skip: (page - 1) * limit, take: limit }),
    db.count({ where }),
  ]);
  res.json({ success: true, data: items, meta: paginateMeta(total, page, limit) });
}));

// GET /api/site-content/:collection/:id — single item
router.get('/:collection/:id', protect, asyncHandler(async (req, res) => {
  const conf = listConfig(req.params.collection);
  if (!conf) throw notFound(`Unknown collection '${req.params.collection}'`);
  const item = await conf.db.findUnique({ where: { id: req.params.id } });
  if (!item) throw notFound(`${req.params.collection} item not found`);
  res.json({ success: true, data: item });
}));

// POST /api/site-content/:collection — create
router.post('/:collection', protect, asyncHandler(async (req, res) => {
  const conf = listConfig(req.params.collection);
  if (!conf) throw notFound(`Unknown collection '${req.params.collection}'`);
  const data = parse(req.body, conf.c.schema);
  if (conf.c.model === 'serviceItem' && data.name) data.slug = slugify(data.name) || undefined;
  const item = await conf.db.create({ data });
  cache.invalidate('public:content');
  await audit(req, 'CREATE', conf.c.model, item.id, { name: item.name || item.title || item.question });
  res.status(201).json({ success: true, data: item });
}));

// PUT /api/site-content/:collection/:id — update
router.put('/:collection/:id', protect, asyncHandler(async (req, res) => {
  const conf = listConfig(req.params.collection);
  if (!conf) throw notFound(`Unknown collection '${req.params.collection}'`);
  const existing = await conf.db.findUnique({ where: { id: req.params.id } });
  if (!existing) throw notFound(`${req.params.collection} item not found`);
  const data = parse(req.body, conf.c.schema.partial());
  if (conf.c.model === 'serviceItem' && data.name) data.slug = slugify(data.name) || undefined;
  const item = await conf.db.update({ where: { id: req.params.id }, data });
  cache.invalidate('public:content');
  await audit(req, 'UPDATE', conf.c.model, item.id, data);
  res.json({ success: true, data: item });
}));

// DELETE /api/site-content/:collection/:id — admin only
router.delete('/:collection/:id', protect, adminOnly, asyncHandler(async (req, res) => {
  const conf = listConfig(req.params.collection);
  if (!conf) throw notFound(`Unknown collection '${req.params.collection}'`);
  const existing = await conf.db.findUnique({ where: { id: req.params.id } });
  if (!existing) throw notFound(`${req.params.collection} item not found`);
  await conf.db.delete({ where: { id: req.params.id } });
  cache.invalidate('public:content');
  await audit(req, 'DELETE', conf.c.model, req.params.id);
  res.json({ success: true, message: `${req.params.collection} item deleted` });
}));

// POST /api/site-content/:collection/:id/publish — set published
router.post('/:collection/:id/publish', protect, adminOnly, asyncHandler(async (req, res) => {
  const conf = listConfig(req.params.collection);
  if (!conf) throw notFound(`Unknown collection '${req.params.collection}'`);
  const existing = await conf.db.findUnique({ where: { id: req.params.id } });
  if (!existing) throw notFound(`${req.params.collection} item not found`);
  const item = await conf.db.update({ where: { id: req.params.id }, data: { status: 'PUBLISHED', publishedAt: new Date() } });
  cache.invalidate('public:content');
  await audit(req, 'PUBLISH', conf.c.model, item.id);
  res.json({ success: true, data: item });
}));

// POST /api/site-content/:collection/:id/draft — revert to draft
router.post('/:collection/:id/draft', protect, adminOnly, asyncHandler(async (req, res) => {
  const conf = listConfig(req.params.collection);
  if (!conf) throw notFound(`Unknown collection '${req.params.collection}'`);
  const existing = await conf.db.findUnique({ where: { id: req.params.id } });
  if (!existing) throw notFound(`${req.params.collection} item not found`);
  const item = await conf.db.update({ where: { id: req.params.id }, data: { status: 'DRAFT' } });
  cache.invalidate('public:content');
  await audit(req, 'UNPUBLISH', conf.c.model, item.id);
  res.json({ success: true, data: item });
}));

// POST /api/site-content/:collection/reorder — bulk ordering { items: [{id, sortOrder}] }
router.post('/:collection/reorder', protect, adminOnly, asyncHandler(async (req, res) => {
  const conf = listConfig(req.params.collection);
  if (!conf) throw notFound(`Unknown collection '${req.params.collection}'`);
  const parsed = parse(req.body, z.object({
    items: z.array(z.object({ id: z.string(), sortOrder: z.coerce.number().int() })).min(1),
  }));
  await prisma.$transaction(parsed.items.map((it) => conf.db.update({ where: { id: it.id }, data: { sortOrder: it.sortOrder } })));
  cache.invalidate('public:content');
  await audit(req, 'REORDER', conf.c.model, req.params.collection, { count: parsed.items.length });
  res.json({ success: true, message: 'Order updated' });
}));

module.exports = router;
module.exports.COLLECTIONS = COLLECTIONS;
