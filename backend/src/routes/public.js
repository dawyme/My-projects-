const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { publicFormLimiter } = require('../middleware/rateLimit');
const { activity } = require('../lib/audit');
const { readAll } = require('./settings');
const { sendMail } = require('../lib/mailer');
const cache = require('../lib/cache');
const payments = require('../lib/payments');
const { badRequest, notFound } = require('../lib/errors');
const { availableStock } = require('../lib/suppliers/inventory');
const shipping = require('../lib/suppliers/shipping');
const { resolveCountry, COUNTRY_BY_CODE } = require('../lib/suppliers/countries');
const fulfillmentService = require('../lib/suppliers/fulfillment');

const router = express.Router();
const reference = () => `BK-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

// GET /api/public/products — storefront catalogue feed
router.get('/products', asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const limit = Math.min(48, Math.max(1, parseInt(req.query.limit || '12', 10)));
  const where = { isActive: true };
  if (req.query.category) where.category = { slug: String(req.query.category) };
  if (req.query.featured === 'true') where.featured = true;
  if (req.query.search) {
    const s = String(req.query.search).slice(0, 80);
    where.OR = [{ name: { contains: s } }, { brand: { contains: s } }, { description: { contains: s } }];
  }
  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit,
      select: {
        id: true, sku: true, name: true, slug: true, description: true, brand: true, model: true,
        price: true, imageUrl: true, featured: true, quantity: true,
        supplierStock: true, fulfillmentType: true,
        category: { select: { name: true, slug: true } },
      },
    }),
    prisma.product.count({ where }),
  ]);
  // A dropshipped product legitimately has zero N&D-owned units but is still
  // purchasable, so stock is reported as *available* stock, never owned stock.
  res.json({
    success: true,
    data: items.map((p) => {
      const available = availableStock(p);
      const { quantity, supplierStock, ...rest } = p;
      return {
        ...rest,
        inStock: available > 0,
        availableStock: available,
        shipsFromSupplier: (p.fulfillmentType === 'SUPPLIER_FULFILLED' || p.fulfillmentType === 'HYBRID') && supplierStock > 0,
      };
    }),
    meta: { total, page, limit, pages: Math.ceil(total / limit) || 1 },
  });
}));

// GET /api/public/shipping/quote — what it costs to ship an item somewhere.
// Returns an explicit "cannot ship" rather than inventing a rate.
router.get('/shipping/quote', validate(z.object({
  country: z.string().trim().length(2).toUpperCase(),
  productId: z.string().uuid().optional(),
  quantity: z.coerce.number().int().min(1).max(999).default(1),
}), 'query'), asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const settings = await readAll();
  const country = resolveCountry(q.country) || q.country;

  if (!q.productId) {
    return res.json({
      success: true,
      data: {
        country, countryName: COUNTRY_BY_CODE[country]?.name || country,
        shippable: true, options: [],
        message: 'Add an item to see supplier shipping options for it.',
      },
    });
  }

  const product = await prisma.product.findUnique({
    where: { id: q.productId },
    select: { id: true, name: true, sku: true, price: true, categoryId: true, fulfillmentType: true, supplierStock: true, isActive: true },
  });
  if (!product || !product.isActive) throw notFound('Product not found');

  const mapping = await prisma.supplierProductMapping.findFirst({
    where: { productId: product.id },
    include: { supplierProduct: { include: { supplier: true } } },
  });

  const result = await shipping.quote({
    tenantId: 'default',
    country,
    supplier: mapping?.supplierProduct?.supplier || null,
    supplierId: mapping?.supplierProduct?.supplierId || null,
    supplierProduct: mapping?.supplierProduct || null,
    categoryId: product.categoryId,
    weightKg: (Number(mapping?.supplierProduct?.weightKg) || 0) * q.quantity,
    quantity: q.quantity,
    subtotal: product.price * q.quantity,
  });

  res.json({
    success: true,
    data: {
      country, countryName: COUNTRY_BY_CODE[country]?.name || country,
      currency: settings.payment.currency,
      currencySymbol: settings.payment.currencySymbol,
      dropshipped: Boolean(mapping?.supplierProduct),
      ...result,
    },
  });
}));

// GET /api/public/categories
router.get('/categories', asyncHandler(async (req, res) => {
  const data = await cache.wrap('public:categories', 60000, () => prisma.category.findMany({
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: { name: true, slug: true, description: true, imageUrl: true, _count: { select: { products: true } } },
  }));
  res.json({ success: true, data });
}));

// GET /api/public/services
router.get('/services', asyncHandler(async (req, res) => {
  const data = await prisma.service.findMany({
    where: { isActive: true }, orderBy: { name: 'asc' },
    select: { id: true, name: true, slug: true, description: true, basePrice: true, durationMin: true },
  });
  res.json({ success: true, data });
}));

// GET /api/public/orders/:reference — public order status for checkout return page
// For Tilopay orders still PENDING, consults the Tilopay /consult endpoint
// to check whether the payment was approved, then captures if so.
router.get('/orders/:reference', asyncHandler(async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { reference: req.params.reference },
    select: {
      id: true, reference: true, status: true, paymentMethod: true,
      paymentStatus: true, total: true, createdAt: true, paidAt: true,
      customer: { select: { name: true, email: true } },
    },
  });
  if (!order) throw notFound('Order not found');

  // For Tilopay orders that are still PENDING, poll the /consult endpoint.
  if (order.paymentMethod === 'TILOPAY' && order.paymentStatus === 'PENDING') {
    try {
      const result = await payments.confirmTilopayPayment(order.reference);
      if (result.paid) {
        // Capture the order using the same helper from the payments route.
        // Inline the minimal capture logic to avoid circular imports.
        await prisma.order.update({
          where: { id: order.id },
          data: {
            status: 'PAID',
            paymentStatus: 'PAID',
            paidAt: new Date(),
            ...(result.transactionId ? { paymentReference: result.transactionId } : {}),
          },
        });
        cache.invalidate('stats');
        await activity(null, 'payment', `Tilopay payment confirmed for ${order.reference}`);
        // Re-fetch after capture.
        const updated = await prisma.order.findUnique({
          where: { reference: req.params.reference },
          select: {
            id: true, reference: true, status: true, paymentMethod: true,
            paymentStatus: true, total: true, createdAt: true, paidAt: true,
            customer: { select: { name: true, email: true } },
          },
        });
        return res.json({ success: true, data: updated });
      }
    } catch (err) {
      // If the Tilopay consult call fails (network / config), we still
      // return the current PENDING status — the customer can refresh later.
      if (err.code !== 'GATEWAY_NOT_CONFIGURED') {
        await activity(null, 'payment', `Tilopay consult failed for ${order.reference}: ${err.message}`);
      }
    }
  }

  // Supplier fulfilment / dropship tracking, so a customer whose items ship
  // directly from a supplier sees the real progress and tracking number.
  const supplierFulfillments = await fulfillmentService.forOrder({ tenantId: 'default', orderId: order.id });

  res.json({
    success: true,
    data: {
      ...order,
      supplierFulfillments: supplierFulfillments.map((f) => ({
        status: f.status,
        supplierName: f.supplier?.name || null,
        trackingNumber: f.trackingNumber || null,
        carrier: f.carrier || null,
        trackingUrl: f.trackingUrl || null,
        shippingMethod: f.shippingMethod || null,
        shippedAt: f.shippedAt,
        deliveredAt: f.deliveredAt,
        trackingSupported: Boolean(f.trackingNumber || f.trackingUrl),
        items: f.items.map((i) => ({ sku: i.supplierSku, name: i.name, quantity: i.quantity })),
      })),
    },
  });
}));
// GET /api/public/settings — public-safe business info
router.get('/settings', asyncHandler(async (req, res) => {
  const all = await readAll();
  const p = all.payment;
  const PAYMENT_METHOD_LABELS = {
    CASH_ON_DELIVERY: 'Cash on Delivery',
    BANK_TRANSFER: 'Bank Transfer',
    STRIPE: 'Credit / Debit Card (Stripe)',
    PAYPAL: 'PayPal',
    WIPAY: 'WiPay',
    TILOPAY: 'Tilopay',
  };
  const flags = {
    CASH_ON_DELIVERY: p.cashOnDelivery,
    BANK_TRANSFER: p.bankTransfer,
    STRIPE: p.stripeEnabled,
    PAYPAL: p.paypalEnabled,
    WIPAY: p.wipayEnabled,
    TILOPAY: p.tilopayEnabled,
  };
  const methods = Object.entries(flags).filter(([, on]) => on).map(([id]) => {
    const configured = payments.GATEWAY_METHODS.includes(id)
      ? payments.gatewayEnv(id).configured
      : true; // offline methods (COD / bank transfer) always work
    return { id, label: PAYMENT_METHOD_LABELS[id], sandbox: !configured };
  });
  res.json({
    success: true,
    data: {
      company: all.company, hours: all.hours, social: all.social, seo: all.seo,
      currency: { code: p.currency, symbol: p.currencySymbol },
      checkout: { currency: p.currency, currencySymbol: p.currencySymbol, taxRate: p.taxRate, methods },
    },
  });
}));

// POST /api/public/contact
router.post('/contact', publicFormLimiter, validate(z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().email().max(180).optional().nullable(),
  phone: z.string().trim().max(40).optional().nullable(),
  subject: z.string().trim().max(200).optional().nullable(),
  serviceType: z.string().trim().max(120).optional().nullable(),
  message: z.string().trim().min(5).max(5000),
})), asyncHandler(async (req, res) => {
  const { name, email, phone, subject, serviceType, message } = req.body;
  const normalizedEmail = email ? email.toLowerCase() : null;
  const customer = normalizedEmail ? await prisma.customer.findUnique({ where: { email: normalizedEmail } }) : null;
  const selectedService = serviceType || 'General Inquiry';
  const storedSubject = subject || `${selectedService} enquiry`;
  const storedBody = `Service Type: ${selectedService}\n\n${message}`;
  const created = await prisma.contactMessage.create({
    data: { name, email: normalizedEmail || null, phone: phone || null, subject: storedSubject, body: storedBody, customerId: customer?.id || null },
  });
  cache.invalidate('stats');
  await activity(null, 'message', `New contact message from ${name}`);
  const settings = await readAll();
  if (settings.email.notifyMessages) {
    try {
      await sendMail({ to: settings.company.email, subject: `New website enquiry: ${subject || 'No subject'}`, text: `${name}${normalizedEmail ? ` <${normalizedEmail}>` : ''}${phone ? ` (${phone})` : ''}\n\n${message}` });
    } catch (err) {
      await activity(null, 'message', `Contact email notification failed for ${created.id}: ${err.message}`);
    }
  }
  if (normalizedEmail) {
    try {
      await sendMail({
        to: normalizedEmail, subject: `We received your message — ${storedSubject}`,
        text: `Hi ${name}, thanks for reaching out to us. We've received your enquiry and will get back to you shortly.\n\nYour message:\n${message}`,
      });
    } catch (err) {
      await activity(null, 'message', `Contact customer confirmation email failed for ${created.id}: ${err.message}`);
    }
  }
  res.status(201).json({ success: true, data: { id: created.id }, message: 'Thank you — your message has been received.' });
}));

// POST /api/public/bookings
router.post('/bookings', publicFormLimiter, validate(z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().email().max(180),
  phone: z.string().trim().max(40).optional().nullable(),
  address: z.string().trim().max(300).optional().nullable(),
  serviceId: z.string().uuid().optional().nullable(),
  scheduledAt: z.coerce.date(),
  description: z.string().trim().max(2000).optional().nullable(),
})), asyncHandler(async (req, res) => {
  const { name, email, phone, address, serviceId, scheduledAt, description } = req.body;
  const lower = email.toLowerCase();
  const customer = await prisma.customer.upsert({
    where: { email: lower },
    update: { name, phone: phone || undefined, address: address || undefined },
    create: { name, email: lower, phone: phone || null, address: address || null },
  });
  const service = serviceId ? await prisma.service.findUnique({ where: { id: serviceId } }) : null;
  const booking = await prisma.booking.create({
    data: {
      reference: reference(), customerId: customer.id, serviceId: service?.id || null,
      scheduledAt, address: address || customer.address || null, description: description || null,
      price: service?.basePrice || 0, status: 'PENDING',
    },
  });
  cache.invalidate('stats');
  await activity(null, 'booking', `New online booking ${booking.reference} from ${name}`);
  const settings = await readAll();
  if (settings.email.notifyBookings) {
    try {
      await sendMail({ to: settings.company.email, subject: `New booking ${booking.reference}`, text: `${name} <${lower}> booked ${service?.name || 'a service'} for ${new Date(scheduledAt).toLocaleString()}.` });
    } catch (err) {
      await activity(null, 'booking', `Booking owner email notification failed for ${booking.reference}: ${err.message}`);
    }
  }
  try {
    await sendMail({
      to: lower, subject: `Booking received — ${booking.reference}`,
      text: `Hi ${name}, we received your booking ${booking.reference} for ${new Date(scheduledAt).toLocaleString()}. Our team will confirm shortly.`,
    });
  } catch (err) {
    await activity(null, 'booking', `Booking customer confirmation email failed for ${booking.reference}: ${err.message}`);
  }
  res.status(201).json({ success: true, data: { reference: booking.reference }, message: 'Booking received. We will confirm shortly.' });
}));

module.exports = router;
