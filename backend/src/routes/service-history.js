const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect } = require('../middleware/auth');
const { paginationSchema, meta } = require('../lib/pagination');
const { tenantWhere } = require('../lib/tenant');

const router = express.Router();

router.get('/', protect, validate(paginationSchema.extend({ search: z.string().optional() }), 'query'), asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const where = tenantWhere(req);
  if (q.search) where.description = { contains: q.search, mode: 'insensitive' };
  const [items, total] = await Promise.all([
    prisma.serviceHistory.findMany({
      where,
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      orderBy: { serviceDate: 'desc' },
      include: { equipment: { include: { customer: true } } },
    }),
    prisma.serviceHistory.count({ where }),
  ]);
  res.json({ success: true, data: items, meta: meta(total, q.page, q.limit) });
}));

module.exports = router;
