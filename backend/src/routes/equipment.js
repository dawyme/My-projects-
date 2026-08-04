const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect, adminOnly } = require('../middleware/auth');
const { paginationSchema, buildOrderBy, meta } = require('../lib/pagination');
const router = express.Router();

router.get('/', protect, validate(paginationSchema.extend({ search: z.string().optional(), status: z.string().optional() }), 'query'), asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const where = {};
  if (q.search) where.OR = [{ name: { contains: q.search } }, { email: { contains: q.search } }, { customerId: { contains: q.search } }];
  if (q.status) where.employmentStatus = q.status.toUpperCase();
  const [items, total] = await Promise.all([
    prisma.equipment.findMany({ where, skip: (q.page-1)*q.limit, take: q.limit, orderBy: { name: 'asc' } }),
    prisma.equipment.count({ where })
  ]);
  res.json({ success: true, data: items, meta: meta(total, q.page, q.limit) });
}));

router.post('/', protect, adminOnly, asyncHandler(async (req, res) => {
  const t = await prisma.equipment.create({ data: req.body });
  res.status(201).json({ success: true, data: t });
}));

router.put('/:id', protect, adminOnly, asyncHandler(async (req, res) => {
  const t = await prisma.equipment.update({ where: { id: req.params.id }, data: req.body });
  res.json({ success: true, data: t });
}));

router.delete('/:id', protect, adminOnly, asyncHandler(async (req, res) => {
  await prisma.equipment.delete({ where: { id: req.params.id } });
  res.json({ success: true });
}));

module.exports = router;
