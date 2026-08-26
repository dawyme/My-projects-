const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect, adminOnly } = require('../middleware/auth');
const { badRequest, notFound } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { tenantWhere } = require('../lib/tenant');

const router = express.Router();
const slugify = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

const body = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(1000).optional().nullable(),
  imageUrl: z.string().trim().max(400).optional().nullable(),
  sortOrder: z.coerce.number().int().min(0).default(0),
});

// GET /api/categories
router.get('/', protect, asyncHandler(async (req, res) => {
  const categories = await prisma.category.findMany({
    where: tenantWhere(req),
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { products: true } } },
  });
  res.json({ success: true, data: categories });
}));

// GET /api/categories/:id
router.get('/:id', protect, asyncHandler(async (req, res) => {
  const category = await prisma.category.findFirst({
    where: tenantWhere(req, { id: req.params.id }), include: { _count: { select: { products: true } } },
  });
  if (!category) throw notFound('Category not found');
  res.json({ success: true, data: category });
}));

// POST /api/categories
router.post('/', protect, validate(body), asyncHandler(async (req, res) => {
  const slug = slugify(req.body.name);
  const clash = await prisma.category.findFirst({ where: tenantWhere(req, { slug }) });
  if (clash) throw badRequest('A category with that name already exists in this business');
  const category = await prisma.category.create({ data: { ...req.body, slug, businessId: req.tenantId } });
  await audit(req, 'CREATE', 'Category', category.id, { name: category.name });
  res.status(201).json({ success: true, data: category });
}));

// PUT /api/categories/:id
router.put('/:id', protect, validate(body.partial()), asyncHandler(async (req, res) => {
  const existing = await prisma.category.findFirst({ where: tenantWhere(req, { id: req.params.id }) });
  if (!existing) throw notFound('Category not found');
  const data = { ...req.body };
  if (data.name) {
    data.slug = slugify(data.name);
    const clash = await prisma.category.findFirst({ where: tenantWhere(req, { slug: data.slug, NOT: { id: existing.id } }) });
    if (clash) throw badRequest('A category with that name already exists in this business');
  }
  const category = await prisma.category.update({ where: { id: existing.id }, data });
  await audit(req, 'UPDATE', 'Category', category.id, data);
  res.json({ success: true, data: category });
}));

// DELETE /api/categories/:id
router.delete('/:id', protect, adminOnly, asyncHandler(async (req, res) => {
  const existing = await prisma.category.findFirst({ where: tenantWhere(req, { id: req.params.id }) });
  if (!existing) throw notFound('Category not found');
  const count = await prisma.product.count({ where: { businessId: req.tenantId, categoryId: existing.id } });
  if (count > 0) throw badRequest(`Category still has ${count} product(s). Move or delete them first.`);
  await prisma.category.delete({ where: { id: existing.id } });
  await audit(req, 'DELETE', 'Category', existing.id);
  res.json({ success: true, message: 'Category deleted' });
}));

module.exports = router;
