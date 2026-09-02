const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect, adminOnly, authorize } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { badRequest, notFound } = require('../lib/errors');
const { audit, activity } = require('../lib/audit');
const { readAll } = require('./settings');
const { DEFAULT_TENANT, tenantWhere } = require('../lib/tenant');
const { sendMail } = require('../lib/mailer');
const cache = require('../lib/cache');
const payments = require('../lib/payments');
const orderFlow = require('../lib/order-flow');
const { availableStock, allocate } = require('../lib/suppliers/inventory');

const webhookRouter = express.Router();
const router = express.Router();

const reference = () => `OR-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const round = (n) => Math.round(n * 100) / 100;

/**
 * Captures an order's payment (idempotent). Sets the order status to PAID and
 * records when the money was received. Stock is deducted at order creation, so
 * a capture never touches inventory.
 */
async function captureOrder(orderId, { transactionId, actorReq, note } = {}) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order) throw notFound('Order not found');
    // Idempotent: already captured/refunded/failed orders are returned untouched.
    if (order.paymentStatus !== 'PENDING') return order;
    if (order.status === 'CANCELLED') {
      throw badRequest('Cannot capture payment for a cancelled order');
    }
    return tx.order.update({
      where: { id: orderId },
      data: {
        status: 'PAID',
        paymentStatus: 'PAID',
        paidAt: new Date(),
        ...(transactionId ? { paymentReference: transactionId } : {}),
        ...(note ? { notes: note } : {}),
      },
    });
  }).then(async (order) => {
    cache.invalidate('stats');
    if (actorReq) {
      audit(actorReq, 'PAYMENT_CAPTURED', 'Order', order.id, {
        reference: order.reference, method: order.paymentMethod, total: order.total,
      }).catch(() => {});
    }
    // Money is in: hand the order to supplier fulfilment. Never throws into the
    // payment path — problems are recorded on the fulfilment record instead.
    await orderFlow.onOrderPaid({ req: actorReq, orderId: order.id });
    return order;
  });
}

/**
 * Mark a payment as failed (idempotent). Order remains PENDING so the merchant
 * can retry or cancel.
 */
async function failOrder(orderId) {
  return prisma.order.updateMany({
    where: { id: orderId, paymentStatus: { not: 'PAID' } },
    data: { paymentStatus: 'FAILED' },
  });
}

/* =====================================================================
 * Webhooks (mounted before global JSON parsing / CSRF in app.js — the
 * handlers receive the raw request body for signature verification).
 * ===================================================================== */
webhookRouter.post('/:gateway', asyncHandler(async (req, res) => {
  const method = String(req.params.gateway || '').toUpperCase();
  if (!payments.GATEWAY_METHODS.includes(method)) {
    return res.status(404).json({ received: false, error: 'Unknown gateway' });
  }

  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const headers = req.headers;

  if (!payments.verifyWebhook(method, rawBody, headers)) {
    return res.status(401).json({ received: false, error: 'Invalid signature' });
  }

  let body = null;
  try { body = rawBody ? JSON.parse(rawBody) : null; } catch (_) { body = null; }
  const parsed = payments.parseWebhook(method, rawBody, headers, body);
  if (!parsed || !parsed.orderReference) {
    // Valid signature but nothing for us to action (e.g. unrelated event).
    return res.json({ received: true, handled: false });
  }

  // Storefront orders belong to the default tenant; gateway callbacks quote
  // only the human-readable reference.
  const order = await prisma.order.findFirst({ where: { businessId: DEFAULT_TENANT, reference: parsed.orderReference } });
  if (!order) {
    return res.status(404).json({ received: true, handled: false, error: 'Order not found' });
  }

  const captured = await captureOrder(order.id, { transactionId: parsed.transactionId });
  await activity(null, 'payment', `Payment ${captured.paymentStatus === 'PAID' ? 'captured' : 'confirmed'} for ${order.reference} via ${method}`);
  res.json({ received: true, handled: true, order: order.reference, status: captured.paymentStatus });
}));

/* =====================================================================
 * Public storefront checkout — creates the customer + order, reserves
 * stock, and starts the selected payment method.
 * ===================================================================== */
const checkoutSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().email().max(180),
  phone: z.string().trim().max(40).optional().nullable(),
  address: z.string().trim().max(300).optional().nullable(),
  city: z.string().trim().max(80).optional().nullable(),
  // International shipping: needed to resolve supplier shipping rules and
  // country restrictions for dropshipped lines.
  country: z.string().trim().length(2).toUpperCase().optional().nullable(),
  postalCode: z.string().trim().max(20).optional().nullable(),
  paymentMethod: z.enum(payments.PAYMENT_METHODS),
  items: z.array(z.object({
    productId: z.string().uuid(),
    quantity: z.coerce.number().int().min(1).max(999),
  })).min(1).max(50),
  notes: z.string().trim().max(2000).optional().nullable(),
});

router.post('/checkout', writeLimiter, validate(checkoutSchema), asyncHandler(async (req, res) => {
  const { name, email, phone, address, city, country, postalCode, paymentMethod, items, notes } = req.body;
  const settings = await readAll(DEFAULT_TENANT);

  // 1. Gate the payment method against the admin payment settings.
  try {
    payments.assertMethodEnabled(paymentMethod, settings.payment);
  } catch (err) {
    throw badRequest(err.message, [{ field: 'paymentMethod', message: err.message }]);
  }

  // 2. Load products server-side — client-supplied prices are never trusted.
  const ids = [...new Set(items.map((i) => i.productId))];
  const products = await prisma.product.findMany({ where: { businessId: DEFAULT_TENANT, id: { in: ids }, isActive: true } });
  const byId = new Map(products.map((p) => [p.id, p]));
  // Availability counts N&D stock plus, when the product opts in, the stock its
  // mapped supplier advertises. Supplier units are never written into
  // Product.quantity — they are fulfilled by the supplier instead.
  const allocations = {};
  const lines = items.map((i) => {
    const p = byId.get(i.productId);
    if (!p) throw badRequest(`Product ${i.productId} is not available`);
    const available = availableStock(p);
    if (available < i.quantity) {
      throw badRequest(`Insufficient stock for ${p.name} (${available} available)`);
    }
    allocations[p.id] = allocate(p, i.quantity);
    const total = round(p.price * i.quantity);
    // `localQuantity` records the split so fulfilment and restock both know how
    // much of this line was ever N&D-owned stock.
    return { productId: p.id, quantity: i.quantity, unitPrice: p.price, total, localQuantity: allocations[p.id].local };
  });

  const subtotal = round(lines.reduce((s, l) => s + l.total, 0));
  const tax = round(subtotal * ((settings.payment.taxRate || 0) / 100));

  // 3. Create the customer (link by email) and the order atomically.
  const existingCustomer = await prisma.customer.findFirst({ where: { businessId: DEFAULT_TENANT, email: email.toLowerCase() } });
  const customer = existingCustomer
    ? await prisma.customer.update({
        where: { id: existingCustomer.id },
        data: { name, phone: phone || undefined, address: address || undefined, city: city || undefined },
      })
    : await prisma.customer.create({
        data: { businessId: DEFAULT_TENANT, name, email: email.toLowerCase(), phone: phone || null, address: address || null, city: city || null },
      });

  const order = await prisma.$transaction(async (tx) => {
    const created = await tx.order.create({
      data: {
        reference: reference(),
        businessId: DEFAULT_TENANT,
        customerId: customer.id,
        status: 'PENDING',
        paymentMethod,
        paymentStatus: 'PENDING',
        shippingName: name,
        shippingPhone: phone || null,
        shippingAddress: address || null,
        shippingCity: city || null,
        shippingCountry: country || null,
        shippingPostalCode: postalCode || null,
        notes: notes || null,
        subtotal,
        tax,
        total: round(subtotal + tax),
        items: { create: lines.map((l) => ({ ...l, businessId: DEFAULT_TENANT })) },
      },
      include: { items: { include: { product: { select: { id: true, name: true, sku: true } } } } },
    });
    for (const l of lines) {
      // Only N&D-owned units are deducted. The dropshipped remainder becomes a
      // supplier fulfilment below.
      const local = allocations[l.productId]?.local ?? l.quantity;
      if (local > 0) {
        await tx.product.update({ where: { id: l.productId }, data: { quantity: { decrement: local } } });
      }
    }
    return created;
  });
  cache.invalidate('stats');
  await audit(req, 'CREATE', 'Order', order.id, { reference: order.reference, total: order.total, method: paymentMethod });

  // 3b. Raise supplier fulfilments for any dropshipped remainder.
  const supplierFlow = await orderFlow.afterOrderCreated({ req, orderId: order.id });

  // 4. Start the payment method.
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const payment = await payments.createPayment(paymentMethod, {
    order, customer, settings, baseUrl,
    updateOrder: (data) => prisma.order.update({ where: { id: order.id }, data }),
  });

  // 5. In sandbox mode there is no real redirect target the customer can
  //    complete, so the payment is captured immediately and clearly labelled.
  if (payment.sandbox && payment.action === 'redirect') {
    await captureOrder(order.id, { transactionId: payment.reference, actorReq: req });
    await activity(null, 'payment', `Sandbox payment ${payment.reference} captured for ${order.reference}`);
  }
  const finalOrder = await prisma.order.findUnique({ where: { id: order.id } });

  // 6. Confirmations.
  await activity(null, 'order', `New storefront order ${order.reference} (${paymentMethod.replace(/_/g, ' ').toLowerCase()})`);
  const notify = await readAll(DEFAULT_TENANT);
  if (notify.email.notifyBookings) {
    sendMail({
      to: notify.company.email,
      subject: `New online order ${order.reference}`,
      text: `${name} <${email}> ordered ${lines.reduce((s, l) => s + l.quantity, 0)} item(s) totalling ${settings.payment.currencySymbol || ''}${order.total.toFixed(2)} via ${paymentMethod.replace(/_/g, ' ').toLowerCase()}.`,
    }).catch(() => {});
  }
  sendMail({
    to: email.toLowerCase(),
    subject: `Order received — ${order.reference}`,
    text: `Hi ${name},\n\nWe received your order ${order.reference} (${settings.payment.currencySymbol || ''}${order.total.toFixed(2)}).\n\n${payment.sandbox ? 'Test mode: no payment was taken. ' : ''}${payment.instructions || ''}\n\nOur team will confirm delivery shortly.\n\n— ${notify.company.name}`,
  }).catch(() => {});

  res.status(201).json({
    success: true,
    data: {
      order: {
        id: finalOrder.id, reference: finalOrder.reference,
        status: finalOrder.status, paymentStatus: finalOrder.paymentStatus,
        total: finalOrder.total, subtotal: finalOrder.subtotal, tax: finalOrder.tax,
      },
      payment: {
        method: paymentMethod,
        action: payment.action,
        status: finalOrder.paymentStatus,
        url: payment.url || null,
        sandbox: Boolean(payment.sandbox),
        instructions: payment.instructions || null,
      },
      supplierFulfillment: supplierFlow.fulfillments.length
        ? { count: supplierFlow.fulfillments.length, note: 'Some items ship directly from our supplier.' }
        : null,
      message: payment.sandbox
        ? 'Order placed in test mode — no real payment was taken.'
        : 'Order placed. Follow the payment steps to complete your purchase.',
    },
  });
}));

/* =====================================================================
 * Admin — manual capture (COD / bank transfer / offline payments) and
 * refunds, plus gateway configuration status.
 * ===================================================================== */
router.get('/gateways', protect, asyncHandler(async (req, res) => {
  res.json({ success: true, data: payments.gateways() });
}));

// Staff-permitted (ADMIN or STAFF); a customer must not be able to capture
// payment merely by knowing an order id. The order must also belong to the
// caller's own tenant — resolved with tenantWhere(), never a client-supplied
// businessId — before the shared capture logic ever touches it.
router.post('/:orderId/capture', protect, authorize('ADMIN', 'STAFF'), validate(z.object({
  transactionId: z.string().trim().max(200).optional().nullable(),
  note: z.string().trim().max(500).optional().nullable(),
})), asyncHandler(async (req, res) => {
  const owned = await prisma.order.findFirst({ where: tenantWhere(req, { id: req.params.orderId }), select: { id: true } });
  if (!owned) throw notFound('Order not found');
  const order = await captureOrder(req.params.orderId, {
    transactionId: req.body.transactionId || undefined,
    note: req.body.note || undefined,
    actorReq: req,
  });
  await activity(req.user.id, 'order', `${req.user.name} captured payment for ${order.reference}`);
  res.json({ success: true, data: order, message: 'Payment captured — order marked as paid' });
}));

router.post('/:orderId/refund', protect, adminOnly, asyncHandler(async (req, res) => {
  const existing = await prisma.order.findFirst({ where: tenantWhere(req, { id: req.params.orderId }) });
  if (!existing) throw notFound('Order not found');
  if (existing.paymentStatus !== 'PAID') throw badRequest('Only paid orders can be refunded');
  const order = await prisma.order.update({
    where: { id: existing.id },
    data: { paymentStatus: 'REFUNDED' },
  });
  cache.invalidate('stats');
  await audit(req, 'REFUND', 'Order', order.id, { reference: order.reference, amount: order.total });
  await activity(req.user.id, 'order', `${req.user.name} refunded ${order.reference}`);
  res.json({ success: true, data: order, message: 'Payment refunded' });
}));

module.exports = router;
module.exports.webhookRouter = webhookRouter;
