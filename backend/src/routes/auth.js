const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect, optionalAuth } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');
const { unauthorized, badRequest, conflict } = require('../lib/errors');
const { audit, activity } = require('../lib/audit');
const {
  signAccessToken, issueRefreshToken, verifyRefreshToken,
  revokeRefreshToken, revokeAllForUser,
} = require('../lib/tokens');
const { setAuthCookies, clearAuthCookies, REFRESH_COOKIE } = require('../lib/cookies');
const { DEFAULT_TENANT } = require('../lib/tenant');
const { roleFor } = require('../lib/permissions');

const router = express.Router();

const loginSchema = z.object({
  email: z.string().email('A valid email is required').max(180),
  password: z.string().min(1, 'Password is required').max(200),
});

const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, role: roleFor(u),
  businessId: u.businessId || null,
  phone: u.phone || null, avatarUrl: u.avatarUrl || null, lastLoginAt: u.lastLoginAt || null,
});

const registerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().email('A valid email is required').max(180),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200)
    .regex(/[A-Za-z]/, 'Password must contain a letter')
    .regex(/[0-9]/, 'Password must contain a number'),
  phone: z.string().trim().max(40).optional(),
});

// POST /api/auth/register
router.post('/register', authLimiter, validate(registerSchema), asyncHandler(async (req, res) => {
  const email = req.body.email.toLowerCase().trim();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw conflict('Email is already registered');
  const passwordHash = await bcrypt.hash(req.body.password, 12);
  const user = await prisma.user.create({
    data: {
      name: req.body.name.trim(), email, passwordHash, role: 'CUSTOMER',
      businessId: DEFAULT_TENANT, phone: req.body.phone || null,
    },
  });
  const accessToken = signAccessToken(user);
  const { token: refreshToken, expiresAt } = await issueRefreshToken(user, {
    ip: req.ip, userAgent: req.get('user-agent') || null,
  });
  setAuthCookies(res, { accessToken, refreshToken, refreshExpires: expiresAt });
  res.status(201).json({ success: true, data: { user: publicUser(user), accessToken, refreshToken, expiresAt } });
}));

// POST /api/auth/login
router.post('/login', authLimiter, validate(loginSchema), asyncHandler(async (req, res) => {
  const email = req.body.email.toLowerCase().trim();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.isActive) throw unauthorized('Invalid email or password');
  const ok = await bcrypt.compare(req.body.password, user.passwordHash);
  if (!ok) throw unauthorized('Invalid email or password');
  const accessToken = signAccessToken(user);
  const { token: refreshToken, expiresAt } = await issueRefreshToken(user, {
    ip: req.ip, userAgent: req.get('user-agent') || null,
  });
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  setAuthCookies(res, { accessToken, refreshToken, refreshExpires: expiresAt });
  res.json({ success: true, data: { user: publicUser(user), accessToken, refreshToken, expiresAt } });
}));

// GET /api/auth/me
router.get('/me', protect, asyncHandler(async (req, res) => {
  res.json({ success: true, data: { user: publicUser(req.user) } });
}));

// PATCH /api/auth/me
const profileSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  avatarUrl: z.string().trim().max(400).nullable().optional(),
});
router.patch('/me', protect, validate(profileSchema), asyncHandler(async (req, res) => {
  const user = await prisma.user.update({ where: { id: req.user.id }, data: req.body });
  await audit(req, 'UPDATE', 'User', user.id, req.body);
  res.json({ success: true, data: { user: publicUser(user) } });
}));

// POST /api/auth/change-password
const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'Password must be at least 8 characters').max(200)
    .regex(/[A-Za-z]/, 'Password must contain a letter')
    .regex(/[0-9]/, 'Password must contain a number'),
});
router.post('/change-password', protect, validate(passwordSchema), asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  const ok = await bcrypt.compare(req.body.currentPassword, user.passwordHash);
  if (!ok) throw badRequest('Current password is incorrect');
  const passwordHash = await bcrypt.hash(req.body.newPassword, 12);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
  await revokeAllForUser(user.id);
  await prisma.user.update({ where: { id: user.id }, data: { sessionVersion: { increment: 1 } } });
  clearAuthCookies(res);
  await audit(req, 'PASSWORD_CHANGE', 'User', user.id);
  res.json({ success: true, message: 'Password updated. Please sign in again.' });
}));

// POST /api/auth/logout
router.post('/logout', optionalAuth, asyncHandler(async (req, res) => {
  const token = req.body?.refreshToken || req.cookies?.[REFRESH_COOKIE];
  let userId = req.user?.id || null;
  try {
    if (token) {
      try {
        const verified = await verifyRefreshToken(token);
        userId = verified.record.userId;
        await revokeRefreshToken(token);
      } catch (_) {
        // Logout remains idempotent for already-revoked/expired refresh tokens.
      }
    }
    if (userId) {
      await prisma.user.update({ where: { id: userId }, data: { sessionVersion: { increment: 1 } } });
    }
  } finally {
    // Logout is intentionally idempotent at the HTTP boundary: even if the
    // refresh token is already revoked/expired, auth cookies must be cleared.
    clearAuthCookies(res);
  }
  res.json({ success: true, message: 'Logged out' });
}));

// POST /api/auth/logout-all
router.post('/logout-all', protect, asyncHandler(async (req, res) => {
  await revokeAllForUser(req.user.id);
  await prisma.user.update({ where: { id: req.user.id }, data: { sessionVersion: { increment: 1 } } });
  clearAuthCookies(res);
  await audit(req, 'LOGOUT_ALL', 'User', req.user.id);
  res.json({ success: true, message: 'All sessions revoked' });
}));

module.exports = router;
module.exports.publicUser = publicUser;
