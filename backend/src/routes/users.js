const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect, adminOnly } = require('../middleware/auth');
const { badRequest, notFound } = require('../lib/errors');
const { audit, activity } = require('../lib/audit');
const { revokeAllForUser } = require('../lib/tokens');
const { publicUser } = require('./auth');

const router = express.Router();
const ROLES = ['ADMIN', 'STAFF'];

// GET /api/users — staff can read the roster (needed for technician assignment)
router.get('/', protect, asyncHandler(async (req, res) => {
  const users = await prisma.user.findMany({
    orderBy: { name: 'asc' },
    select: {
      id: true, name: true, email: true, role: true, phone: true, avatarUrl: true,
      isActive: true, lastLoginAt: true, createdAt: true,
      _count: { select: { bookings: true } },
    },
  });
  res.json({ success: true, data: users });
}));

// POST /api/users
router.post('/', protect, adminOnly, validate(z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().email().max(180),
  password: z.string().min(8).max(200).regex(/[A-Za-z]/, 'Must contain a letter').regex(/[0-9]/, 'Must contain a number'),
  role: z.enum(ROLES).default('STAFF'),
  phone: z.string().trim().max(40).optional().nullable(),
})), asyncHandler(async (req, res) => {
  const { password, ...rest } = req.body;
  const user = await prisma.user.create({
    data: { ...rest, email: rest.email.toLowerCase(), passwordHash: await bcrypt.hash(password, 12) },
  });
  await audit(req, 'CREATE', 'User', user.id, { email: user.email, role: user.role });
  await activity(req.user.id, 'user', `${req.user.name} created ${user.role.toLowerCase()} account for ${user.name}`);
  res.status(201).json({ success: true, data: publicUser(user) });
}));

// PUT /api/users/:id
router.put('/:id', protect, adminOnly, validate(z.object({
  name: z.string().trim().min(2).max(120).optional(),
  email: z.string().email().max(180).optional(),
  role: z.enum(ROLES).optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  isActive: z.coerce.boolean().optional(),
  password: z.string().min(8).max(200).optional(),
})), asyncHandler(async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) throw notFound('User not found');
  const { password, ...data } = req.body;
  if (data.email) data.email = data.email.toLowerCase();

  // Guard: never leave the system without an active admin.
  if ((data.role && data.role !== 'ADMIN' && target.role === 'ADMIN') || (data.isActive === false && target.role === 'ADMIN')) {
    const admins = await prisma.user.count({ where: { role: 'ADMIN', isActive: true, NOT: { id: target.id } } });
    if (admins === 0) throw badRequest('At least one active administrator must remain');
  }
  if (password) data.passwordHash = await bcrypt.hash(password, 12);

  const user = await prisma.user.update({ where: { id: target.id }, data });
  if (password || data.isActive === false) await revokeAllForUser(user.id);
  await audit(req, 'UPDATE', 'User', user.id, { ...data, passwordHash: undefined });
  res.json({ success: true, data: publicUser(user) });
}));

// DELETE /api/users/:id
router.delete('/:id', protect, adminOnly, asyncHandler(async (req, res) => {
  if (req.params.id === req.user.id) throw badRequest('You cannot delete your own account');
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) throw notFound('User not found');
  if (target.role === 'ADMIN') {
    const admins = await prisma.user.count({ where: { role: 'ADMIN', isActive: true, NOT: { id: target.id } } });
    if (admins === 0) throw badRequest('At least one active administrator must remain');
  }
  await prisma.booking.updateMany({ where: { technicianId: target.id }, data: { technicianId: null } });
  await prisma.user.delete({ where: { id: target.id } });
  await audit(req, 'DELETE', 'User', target.id, { email: target.email });
  res.json({ success: true, message: 'User deleted' });
}));

module.exports = router;
