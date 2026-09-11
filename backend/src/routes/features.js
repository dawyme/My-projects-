const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect } = require('../middleware/auth');
const { platformAdminOnly } = require('../lib/tenant');
const { normalizeFeatureKey } = require('../lib/features');
const { badRequest, notFound, conflict } = require('../lib/errors');
const { audit } = require('../lib/audit');

const router = express.Router();
const featureSchema = z.object({
  key: z.string().trim().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).nullable().optional(),
  isActive: z.boolean().default(true),
  isCore: z.boolean().default(false),
  defaultEnabled: z.boolean().default(false),
});

const publicFeature = (feature, tenants = []) => ({
  id: feature.id, key: feature.key, name: feature.name, description: feature.description,
  isActive: feature.isActive, isCore: feature.isCore, defaultEnabled: feature.defaultEnabled,
  createdAt: feature.createdAt, updatedAt: feature.updatedAt, tenants,
});

router.use(protect, platformAdminOnly);

router.get('/', asyncHandler(async (req, res) => {
  const [features, businesses, accesses] = await Promise.all([
    prisma.platformFeature.findMany({ orderBy: { name: 'asc' } }),
    prisma.business.findMany({ where: { isDefault: false, status: { not: 'DELETED' } }, orderBy: { name: 'asc' }, select: { id: true, name: true, slug: true, status: true } }),
    prisma.tenantFeatureAccess.findMany(),
  ]);
  const accessByFeature = new Map();
  for (const access of accesses) {
    if (!accessByFeature.has(access.featureId)) accessByFeature.set(access.featureId, new Map());
    accessByFeature.get(access.featureId).set(access.businessId, access.enabled);
  }
  res.json({ success: true, data: features.map((feature) => publicFeature(feature, businesses.map((business) => ({
    ...business, enabled: feature.isCore ? true : (accessByFeature.get(feature.id)?.get(business.id) ?? feature.defaultEnabled),
  })))) });
}));

router.post('/', validate(featureSchema), asyncHandler(async (req, res) => {
  const key = normalizeFeatureKey(req.body.key);
  if (!key) throw badRequest('A valid feature key is required');
  const existing = await prisma.platformFeature.findUnique({ where: { key } });
  if (existing) throw conflict('A feature with that key already exists');
  const feature = await prisma.platformFeature.create({ data: { ...req.body, key } });
  await audit(req, 'CREATE', 'PlatformFeature', feature.id, { key });
  res.status(201).json({ success: true, data: publicFeature(feature) });
}));

router.patch('/:id', validate(featureSchema), asyncHandler(async (req, res) => {
  const existing = await prisma.platformFeature.findUnique({ where: { id: req.params.id } });
  if (!existing) throw notFound('Feature not found');
  const key = normalizeFeatureKey(req.body.key);
  const duplicate = await prisma.platformFeature.findFirst({ where: { key, NOT: { id: existing.id } } });
  if (duplicate) throw conflict('A feature with that key already exists');
  const feature = await prisma.platformFeature.update({ where: { id: existing.id }, data: { ...req.body, key } });
  await audit(req, 'UPDATE', 'PlatformFeature', feature.id, { key, isActive: feature.isActive });
  res.json({ success: true, data: publicFeature(feature) });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const feature = await prisma.platformFeature.findUnique({ where: { id: req.params.id } });
  if (!feature) throw notFound('Feature not found');
  const updated = await prisma.platformFeature.update({ where: { id: feature.id }, data: { isActive: false } });
  await audit(req, 'DELETE', 'PlatformFeature', feature.id, { softDelete: true });
  res.json({ success: true, data: publicFeature(updated) });
}));

router.patch('/:id/access/:businessId', validate(z.object({ enabled: z.boolean() })), asyncHandler(async (req, res) => {
  const feature = await prisma.platformFeature.findUnique({ where: { id: req.params.id } });
  if (!feature) throw notFound('Feature not found');
  const business = await prisma.business.findUnique({ where: { id: req.params.businessId } });
  if (!business || business.isDefault || business.status === 'DELETED') throw badRequest('Only active SaaS tenants can receive feature access');
  if (feature.isCore && req.body.enabled === false) throw badRequest('Core platform features cannot be disabled for tenants');
  const access = await prisma.tenantFeatureAccess.upsert({
    where: { featureId_businessId: { featureId: feature.id, businessId: business.id } },
    update: { enabled: req.body.enabled },
    create: { featureId: feature.id, businessId: business.id, enabled: req.body.enabled },
  });
  await audit(req, req.body.enabled ? 'ENABLE' : 'DISABLE', 'TenantFeatureAccess', access.id, { featureId: feature.id, businessId: business.id });
  res.json({ success: true, data: { featureId: feature.id, businessId: business.id, enabled: feature.isCore ? true : access.enabled } });
}));

module.exports = router;
