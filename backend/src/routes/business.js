const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect, adminOnly } = require('../middleware/auth');
const { platformAdminOnly, tenantWhere } = require('../lib/tenant');
const { badRequest, notFound, conflict } = require('../lib/errors');
const { audit, activity } = require('../lib/audit');

const router = express.Router();

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const slugify = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

const businessPublic = (b) => ({
  id: b.id, name: b.name, slug: b.slug, status: b.status, isDefault: b.isDefault,
  phone: b.phone, email: b.email, address: b.address, currency: b.currency,
  taxRate: b.taxRate, createdAt: b.createdAt,
});

// ---------------------------------------------------------------------------
// Own-tenant management (any authenticated user of the tenant)
// ---------------------------------------------------------------------------

// GET /api/business/current
router.get('/current', protect, asyncHandler(async (req, res) => {
  const business = await prisma.business.findUnique({
    where: { id: req.tenantId },
    include: {
      _count: { select: { users: true, customers: true, bookings: true, orders: true, products: true } },
    },
  });
  if (!business) throw notFound('Business not found');
  res.json({ success: true, data: { ...businessPublic(business), counts: business._count } });
}));

// PUT /api/business/current — tenant admins may update their own profile
const updateSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().email().max(180).nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
  currency: z.string().trim().length(3).toUpperCase().optional(),
  taxRate: z.number().min(0).max(1).optional(),
});
router.put('/current', protect, adminOnly, validate(updateSchema), asyncHandler(async (req, res) => {
  const business = await prisma.business.findUnique({ where: { id: req.tenantId } });
  if (!business) throw notFound('Business not found');
  const updated = await prisma.business.update({ where: { id: business.id }, data: req.body });
  await audit(req, 'UPDATE', 'Business', business.id, req.body);
  await activity(req.user.id, 'business', `${req.user.name} updated the business profile`);
  res.json({ success: true, data: businessPublic(updated) });
}));

// ---------------------------------------------------------------------------
// Platform administration (businessId-less admins) — the tenant roster
// ---------------------------------------------------------------------------

const createSchema = z.object({
  name: z.string().trim().min(2).max(160),
  slug: z.string().trim().regex(SLUG_RE, 'Slug must be lowercase letters, numbers and dashes').max(60).optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().email().max(180).nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
  currency: z.string().trim().length(3).toUpperCase().optional(),
  taxRate: z.number().min(0).max(1).optional(),
  admin: z.object({
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().email().max(180),
    password: z.string().min(8).max(200)
      .regex(/[A-Za-z]/, 'Password must contain a letter')
      .regex(/[0-9]/, 'Password must contain a number'),
  }),
});

// POST /api/businesses — onboard a new tenant with its first admin user
router.post('/', protect, platformAdminOnly, validate(createSchema), asyncHandler(async (req, res) => {
  const { admin, ...payload } = req.body;
  const slug = payload.slug || slugify(payload.name);
  if (!SLUG_RE.test(slug)) throw badRequest('Could not derive a valid slug from the business name');

  const exists = await prisma.business.findFirst({ where: { OR: [{ slug }, { name: payload.name }] } });
  if (exists) throw conflict('A business with that name or slug already exists');
  const emailTaken = await prisma.user.findUnique({ where: { email: admin.email.toLowerCase() } });
  if (emailTaken) throw conflict('A user with that email already exists');

  const business = await prisma.business.create({
    data: {
      ...payload, slug,
      name: payload.name,
      users: {
        create: {
          name: admin.name,
          email: admin.email.toLowerCase(),
          passwordHash: await bcrypt.hash(admin.password, 12),
          role: 'ADMIN',
        },
      },
    },
    include: { users: { select: { id: true, name: true, email: true, role: true } } },
  });

  await audit(req, 'CREATE', 'Business', business.id, { slug: business.slug });
  await activity(req.user.id, 'business', `${req.user.name} onboarded tenant ${business.name}`);
  res.status(201).json({
    success: true,
    data: { ...businessPublic(business), users: business.users },
  });
}));

// GET /api/businesses — the tenant roster with usage counts
router.get('/', protect, platformAdminOnly, asyncHandler(async (req, res) => {
  const businesses = await prisma.business.findMany({
    orderBy: { createdAt: 'asc' },
    include: { _count: { select: { users: true, customers: true, bookings: true, orders: true, products: true } } },
  });
  res.json({
    success: true,
    data: businesses.map((b) => ({ ...businessPublic(b), counts: b._count })),
  });
}));

// GET /api/businesses/:id
router.get('/:id', protect, platformAdminOnly, asyncHandler(async (req, res) => {
  const business = await prisma.business.findUnique({
    where: { id: req.params.id },
    include: {
      users: { select: { id: true, name: true, email: true, role: true, isActive: true, lastLoginAt: true } },
      _count: { select: { users: true, customers: true, bookings: true, orders: true, products: true } },
    },
  });
  if (!business) throw notFound('Business not found');
  res.json({ success: true, data: { ...businessPublic(business), users: business.users, counts: business._count } });
}));

// PATCH /api/businesses/:id — status / profile from the platform
const patchSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().email().max(180).nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
});
router.patch('/:id', protect, platformAdminOnly, validate(patchSchema), asyncHandler(async (req, res) => {
  const business = await prisma.business.findUnique({ where: { id: req.params.id } });
  if (!business) throw notFound('Business not found');
  if (business.isDefault && req.body.status === 'SUSPENDED') {
    throw badRequest('The default tenant cannot be suspended');
  }
  const updated = await prisma.business.update({ where: { id: business.id }, data: req.body });
  await audit(req, 'STATUS_CHANGE', 'Business', business.id, req.body);
  res.json({ success: true, data: businessPublic(updated) });
}));

module.exports = router;
