const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect, authorize } = require('../middleware/auth');
const { badRequest, notFound } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { readAll } = require('./settings');
const payments = require('../lib/payments');
const billing = require('../lib/subscription-billing');

const router = express.Router();
const planSchema = z.object({ planId: z.string().min(1) });
const checkoutSchema = z.object({
  planId: z.string().min(1),
  paymentMethod: z.enum(['STRIPE', 'PAYPAL', 'WIPAY', 'TILOPAY']),
});
const publicPlan = (p) => ({
  id: p.id, name: p.name, slug: p.slug, description: p.description,
  price: p.price, currency: p.currency, interval: p.interval,
  features: JSON.parse(p.features || '{}'), limits: JSON.parse(p.limits || '{}'),
});

// Tenant admins manage their business, but platform plans are owned by Super Admin.
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

router.get('/payment-methods', asyncHandler(async (req, res) => {
  const settings = await readAll(req.tenantId);
  const flags = { STRIPE: 'stripeEnabled', PAYPAL: 'paypalEnabled', WIPAY: 'wipayEnabled', TILOPAY: 'tilopayEnabled' };
  const labels = { STRIPE: 'Credit / Debit Card (Stripe)', PAYPAL: 'PayPal', WIPAY: 'WiPay', TILOPAY: 'Tilopay' };
  res.json({ success: true, data: payments.GATEWAY_METHODS.map((method) => ({
    id: method, label: labels[method], enabled: settings.payment?.[flags[method]] !== false, configured: payments.gatewayConfig(method).configured,
  })).filter((method) => method.enabled && (method.configured || process.env.NODE_ENV !== 'production')) });
}));

router.post('/subscription/checkout', validate(checkoutSchema), asyncHandler(async (req, res) => {
  const plan = await prisma.plan.findFirst({ where: { id: req.body.planId, isActive: true } });
  if (!plan) throw badRequest('Active plan not found');

  const settings = await readAll(req.tenantId);
  try {
    payments.assertMethodEnabled(req.body.paymentMethod, settings.payment);
  } catch (err) {
    throw badRequest(err.message);
  }

  const pending = billing.createPendingSubscriptionPayment({
    businessId: req.tenantId, planId: plan.id, amount: plan.price, currency: plan.currency, paymentMethod: req.body.paymentMethod,
  });
  const payment = await prisma.subscriptionPayment.create({ data: pending });
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const returnPath = `/tenant/#/subscription?payment=${encodeURIComponent(payment.reference)}`;
  const gatewaySettings = { ...settings, payment: { ...settings.payment, currency: plan.currency } };
  try {
    const gateway = await payments.createPayment(req.body.paymentMethod, {
      order: { reference: payment.reference, total: payment.amount, paymentMethod: payment.paymentMethod },
      customer: { name: req.user.name, email: req.user.email },
      settings: gatewaySettings,
      baseUrl,
      successUrl: `${baseUrl}${returnPath}&status=paid`,
      cancelUrl: `${baseUrl}${returnPath}&status=cancelled`,
      updateOrder: async () => {},
    });
    await prisma.subscriptionPayment.update({ where: { id: payment.id }, data: { gatewayReference: gateway.reference || null } });
    res.status(201).json({ success: true, data: {
      reference: payment.reference, plan: publicPlan(plan), status: 'PENDING',
      paymentMethod: payment.paymentMethod, action: gateway.action, url: gateway.url || null, sandbox: Boolean(gateway.sandbox), instructions: gateway.instructions || null,
    } });
  } catch (err) {
    await prisma.subscriptionPayment.update({ where: { id: payment.id }, data: { status: 'FAILED', failedAt: new Date() } });
    throw err;
  }
}));

router.get('/subscription/payments/:reference', asyncHandler(async (req, res) => {
  const payment = await prisma.subscriptionPayment.findFirst({ where: { reference: req.params.reference, businessId: req.tenantId }, include: { plan: true } });
  if (!payment) throw notFound('Subscription payment not found');
  res.json({ success: true, data: { reference: payment.reference, status: payment.status, paymentMethod: payment.paymentMethod, amount: payment.amount, currency: payment.currency, plan: publicPlan(payment.plan) } });
}));

router.post('/subscription/payments/:reference/confirm', asyncHandler(async (req, res) => {
  const payment = await prisma.subscriptionPayment.findFirst({ where: { reference: req.params.reference, businessId: req.tenantId }, include: { plan: true } });
  if (!payment) throw notFound('Subscription payment not found');
  if (payment.paymentMethod !== 'TILOPAY') throw badRequest('Only Tilopay payments use return confirmation');
  if (payment.status !== 'PENDING') return res.json({ success: true, data: { status: payment.status } });

  const result = await payments.confirmTilopayPayment(payment.reference);
  if (!result.paid) return res.json({ success: true, data: { status: 'PENDING' } });

  // The payment reference and server-created amount are bound to this pending record.
  // Tilopay's consult endpoint is the payment-status authority for one-off payments.
  const resultData = await prisma.$transaction((tx) => billing.activatePaidSubscription(tx, payment, result.transactionId));
  await audit(req, 'UPDATE', 'Subscription', resultData.subscription.id, { businessId: req.tenantId, planId: payment.planId, source: 'tilopay-return' });
  res.json({ success: true, data: { status: 'PAID', subscription: resultData.subscription } });
}));

router.post('/subscription/payments/:reference/cancel', asyncHandler(async (req, res) => {
  const payment = await prisma.subscriptionPayment.findFirst({ where: { reference: req.params.reference, businessId: req.tenantId } });
  if (!payment) throw notFound('Subscription payment not found');
  const cancelled = await prisma.$transaction((tx) => billing.cancelSubscriptionPayment(tx, payment));
  res.json({ success: true, data: { status: cancelled.status } });
}));

// Legacy direct activation is intentionally removed. Subscription changes occur only
// after a verified gateway payment (or a verified Tilopay return confirmation).

module.exports = router;
