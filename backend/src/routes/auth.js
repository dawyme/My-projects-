const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');
const { unauthorized, badRequest } = require('../lib/errors');
const { audit, activity } = require('../lib/audit');
const {
  signAccessToken, issueRefreshToken, verifyRefreshToken,
  revokeRefreshToken, revokeAllForUser,
} = require('../lib/tokens');
const { setAuthCookies, clearAuthCookies, REFRESH_COOKIE } = require('../lib/cookies');

const router = express.Router();

const loginSchema = z.object({
  email: z.string().email('A valid email is required').max(180),
  password: z.string().min(1, 'Password is required').max(200),
});

const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, role: u.role,
  businessId: u.businessId || null,
  phone: u.phone || null, avatarUrl: u.avatarUrl || null, lastLoginAt: u.lastLoginAt || null,
});

// POST /api/auth/login
router.post('/login', authLimiter, validate(loginSchema), asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  // Constant-ish work factor even for unknown emails to avoid user enumeration.
  const hash = user?.passwordHash || '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
  const ok = await bcrypt.compare(password, hash);
  if (!user || !ok) {
    await audit(req, 'LOGIN_FAILED', 'User', null, { email });
    throw unauthorized('Invalid email or password');
  }
  if (!user.isActive) throw unauthorized('This account has been disabled');

  const accessToken = signAccessToken(user);
  const { token: refreshToken, expiresAt } = await issueRefreshToken(user, {
    ip: req.ip, userAgent: req.get('user-agent'),
  });
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  setAuthCookies(res, { accessToken, refreshToken, refreshExpires: expiresAt });

  req.user = user;
  await audit(req, 'LOGIN', 'User', user.id);
  await activity(user.id, 'auth', `${user.name} signed in`);

  res.json({ success: true, data: { user: publicUser(user), accessToken, refreshToken, expiresAt } });
}));

// POST /api/auth/refresh
router.post('/refresh', asyncHandler(async (req, res) => {
  const token = req.body?.refreshToken || req.cookies?.[REFRESH_COOKIE];
  if (!token) throw unauthorized('Refresh token required');
  let verified;
  try { verified = await verifyRefreshToken(token); }
  catch (_) { clearAuthCookies(res); throw unauthorized('Invalid or expired refresh token'); }

  const user = await prisma.user.findUnique({ where: { id: verified.payload.sub } });
  if (!user || !user.isActive) throw unauthorized('Account not found or disabled');

  // Rotate: the presented refresh token is revoked and replaced.
  await revokeRefreshToken(token);
  const accessToken = signAccessToken(user);
  const { token: refreshToken, expiresAt } = await issueRefreshToken(user, {
    ip: req.ip, userAgent: req.get('user-agent'),
  });
  setAuthCookies(res, { accessToken, refreshToken, refreshExpires: expiresAt });
  res.json({ success: true, data: { user: publicUser(user), accessToken, refreshToken, expiresAt } });
}));

// GET /api/auth/me
router.get('/me', protect, asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { business: { select: { id: true, name: true, slug: true, status: true, currency: true, taxRate: true } } },
  });
  if (!user) throw unauthorized('Account not found');
  res.json({ success: true, data: { user: publicUser(user), business: user.business || null, tenantId: req.tenantId } });
}));

// PATCH /api/auth/me — update own profile
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
  clearAuthCookies(res);
  await audit(req, 'PASSWORD_CHANGE', 'User', user.id);
  res.json({ success: true, message: 'Password updated. Please sign in again.' });
}));

// POST /api/auth/logout
router.post('/logout', asyncHandler(async (req, res) => {
  const token = req.body?.refreshToken || req.cookies?.[REFRESH_COOKIE];
  await revokeRefreshToken(token);
  clearAuthCookies(res);
  res.json({ success: true, message: 'Logged out' });
}));

// POST /api/auth/logout-all
router.post('/logout-all', protect, asyncHandler(async (req, res) => {
  await revokeAllForUser(req.user.id);
  clearAuthCookies(res);
  await audit(req, 'LOGOUT_ALL', 'User', req.user.id);
  res.json({ success: true, message: 'All sessions revoked' });
}));

module.exports = router;
module.exports.publicUser = publicUser;
