const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect, adminOnly } = require('../middleware/auth');
const { paginationSchema, buildOrderBy, meta } = require('../lib/pagination');
const { notFound } = require('../lib/errors');
const { audit, activity } = require('../lib/audit');
const { sendMessageReplyEmail } = require('../lib/mailer');
const cache = require('../lib/cache');

const router = express.Router();
const STATUSES = ['UNREAD', 'READ', 'ARCHIVED'];

const listQuery = paginationSchema.extend({
  status: z.string().optional(),
  format: z.enum(['json']).default('json'),
});

// GET /api/messages
router.get('/', protect, validate(listQuery, 'query'), asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const where = {};
  if (q.status) where.status = { in: q.status.split(',').map((s) => s.trim().toUpperCase()).filter((s) => STATUSES.includes(s)) };
  if (q.search) {
    where.OR = [
      { name: { contains: q.search } }, { email: { contains: q.search } },
      { subject: { contains: q.search } }, { body: { contains: q.search } },
    ];
  }
  const [items, total, counts] = await Promise.all([
    prisma.contactMessage.findMany({
      where,
      orderBy: buildOrderBy(q.sort, q.order, ['createdAt', 'status', 'name']),
      skip: (q.page - 1) * q.limit, take: q.limit,
      include: { _count: { select: { replies: true } } },
    }),
    prisma.contactMessage.count({ where }),
    prisma.contactMessage.groupBy({ by: ['status'], _count: { _all: true } }),
  ]);
  const summary = Object.fromEntries(STATUSES.map((s) => [s, counts.find((c) => c.status === s)?._count._all || 0]));
  res.json({ success: true, data: items, meta: { ...meta(total, q.page, q.limit), summary } });
}));

// GET /api/messages/:id — reading marks it as READ
router.get('/:id', protect, asyncHandler(async (req, res) => {
  const message = await prisma.contactMessage.findUnique({
    where: { id: req.params.id },
    include: { replies: { orderBy: { sentAt: 'asc' }, include: { user: { select: { name: true } } } }, customer: true },
  });
  if (!message) throw notFound('Message not found');
  if (message.status === 'UNREAD') {
    await prisma.contactMessage.update({ where: { id: message.id }, data: { status: 'READ' } });
    message.status = 'READ';
    cache.invalidate('stats');
  }
  res.json({ success: true, data: message });
}));

// PATCH /api/messages/:id/status
router.patch('/:id/status', protect,
  validate(z.object({ status: z.enum(STATUSES) })),
  asyncHandler(async (req, res) => {
    const message = await prisma.contactMessage.update({ where: { id: req.params.id }, data: { status: req.body.status } });
    cache.invalidate('stats');
    await audit(req, 'STATUS_CHANGE', 'ContactMessage', message.id, { status: message.status });
    res.json({ success: true, data: message });
  }));

// POST /api/messages/:id/reply
router.post('/:id/reply', protect,
  validate(z.object({ body: z.string().trim().min(1).max(5000) })),
  asyncHandler(async (req, res) => {
    const message = await prisma.contactMessage.findUnique({ where: { id: req.params.id } });
    if (!message) throw notFound('Message not found');
    const reply = await prisma.messageReply.create({
      data: { messageId: message.id, userId: req.user.id, body: req.body.body },
      include: { user: { select: { name: true } } },
    });
    await prisma.contactMessage.update({ where: { id: message.id }, data: { status: 'READ' } });
    const delivery = await sendMessageReplyEmail(message, req.body.body).catch(() => ({ delivered: false }));
    cache.invalidate('stats');
    await audit(req, 'REPLY', 'ContactMessage', message.id);
    await activity(req.user.id, 'message', `${req.user.name} replied to ${message.name}`);
    res.status(201).json({ success: true, data: reply, meta: { emailDelivered: !!delivery.delivered } });
  }));

// POST /api/messages/bulk — bulk archive / mark / delete
router.post('/bulk', protect,
  validate(z.object({
    ids: z.array(z.string().uuid()).min(1).max(200),
    action: z.enum(['read', 'unread', 'archive', 'delete']),
  })),
  asyncHandler(async (req, res) => {
    const { ids, action } = req.body;
    let result;
    if (action === 'delete') {
      if (req.user.role !== 'ADMIN') return res.status(403).json({ success: false, error: 'Only admins can delete messages' });
      result = await prisma.contactMessage.deleteMany({ where: { id: { in: ids } } });
    } else {
      const status = action === 'archive' ? 'ARCHIVED' : action.toUpperCase();
      result = await prisma.contactMessage.updateMany({ where: { id: { in: ids } }, data: { status } });
    }
    cache.invalidate('stats');
    await audit(req, `BULK_${action.toUpperCase()}`, 'ContactMessage', null, { count: result.count });
    res.json({ success: true, data: { affected: result.count } });
  }));

// DELETE /api/messages/:id
router.delete('/:id', protect, adminOnly, asyncHandler(async (req, res) => {
  await prisma.contactMessage.delete({ where: { id: req.params.id } });
  cache.invalidate('stats');
  await audit(req, 'DELETE', 'ContactMessage', req.params.id);
  res.json({ success: true, message: 'Message deleted' });
}));

module.exports = router;
