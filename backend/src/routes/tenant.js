const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect, authorize } = require('../middleware/auth');
const { badRequest, notFound } = require('../lib/errors');
const { audit } = require('../lib/audit');

const router = express.Router();
const planSchema = z.object({ planId: z.string().min(1) });
const publicPlan = (p) => ({
  id: p.id, name: p.name, slug: p.slug, description: p.description,
  price: p.price, currency: p.currency, interval: p.interval,
  features: JSON.parse(p.features || '{}'), limits: JSON.parse(p.limits || '{}'),
});

// Tenant users may see and select platform plans, but can never manage plans.
router.use(protect, authorize('TENANT_ADMIN'));

router.get('/overview', asyncHandler(async (req, res) => {
  const business = await prisma.business.findUnique({
    where: { id: req.tenantId },
    select: {
      id: true, name: true, slug: true, status: true, currency: true, taxRate: true,
      subscription: { include: { plan: true } },
      _count: { select: { users: true, customers: true, products: true, bookings: true, orders: true, workOrders: true } },
    },
  });
  if (!business) throw notFound('Business not found');
  res.json({ success: true, data: { ...business, subscription: business.subscription ? { ...business.subscription, plan: publicPlan(business.subscription.plan) } : null } });
}));

router.get('/plans', asyncHandler(async (req, res) => {
  const plans = await prisma.plan.findMany({ where: { isActive: true }, orderBy: { price: 'asc' } });
  res.json({ success: true, data: plans.map(publicPlan) });
}));

router.post('/subscription', validate(planSchema), asyncHandler(async (req, res) => {
  const plan = await prisma.plan.findFirst({ where: { id: req.body.planId, isActive: true } });
  if (!plan) throw badRequest('Active plan not found');
  const existing = await prisma.subscription.findUnique({ where: { businessId: req.tenantId } });
  const subscription = await prisma.subscription.upsert({
    where: { businessId: req.tenantId },
    update: { planId: plan.id, status: 'ACTIVE', cancelAtPeriodEnd: false },
    create: { businessId: req.tenantId, planId: plan.id, status: 'ACTIVE' },
    include: { plan: true },
  });
  if (existing?.planId !== plan.id || existing?.status !== 'ACTIVE') {
    await audit(req, 'UPDATE', 'Subscription', subscription.id, { businessId: req.tenantId, planId: plan.id, status: 'ACTIVE', source: 'tenant-portal' });
  }
  await prisma.business.update({ where: { id: req.tenantId }, data: { status: 'ACTIVE' } });
  res.json({ success: true, data: subscription });
}));

module.exports = router;
