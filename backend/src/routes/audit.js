const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect, adminOnly } = require('../middleware/auth');
const { paginationSchema, meta, toCsv } = require('../lib/pagination');

const router = express.Router();

// GET /api/audit-logs
router.get('/', protect, adminOnly, validate(paginationSchema.extend({
  entity: z.string().optional(),
  action: z.string().optional(),
  userId: z.string().optional(),
  format: z.enum(['json', 'csv']).default('json'),
}), 'query'), asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const where = {};
  if (q.entity) where.entity = q.entity;
  if (q.action) where.action = q.action;
  if (q.userId) where.userId = q.userId;
  if (q.search) where.OR = [{ action: { contains: q.search } }, { entity: { contains: q.search } }, { data: { contains: q.search } }];

  if (q.format === 'csv') {
    const rows = await prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: 5000, include: { user: { select: { name: true, email: true } } } });
    res.header('Content-Type', 'text/csv');
    res.attachment('audit-logs.csv');
    return res.send(toCsv(rows, [
      { label: 'Time', value: 'createdAt' }, { label: 'User', value: (r) => r.user?.email || 'system' },
      { label: 'Action', value: 'action' }, { label: 'Entity', value: 'entity' },
      { label: 'Entity ID', value: 'entityId' }, { label: 'IP', value: 'ip' }, { label: 'Data', value: 'data' },
    ]));
  }

  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({
      where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit,
      include: { user: { select: { name: true, email: true } } },
    }),
    prisma.auditLog.count({ where }),
  ]);
  res.json({ success: true, data: items, meta: meta(total, q.page, q.limit) });
}));

module.exports = router;
