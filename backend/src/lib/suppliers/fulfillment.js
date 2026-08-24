/**
 * Supplier fulfilment / dropshipping.
 *
 * The customer journey is untouched: storefront → existing checkout →
 * existing payment gateway → existing `Order`. This module starts AFTER that
 * order exists. It splits each order line between N&D stock and supplier stock
 * and raises one fulfilment record per supplier for the dropshipped remainder.
 *
 * Statuses: PENDING → READY → SUBMITTED → ACCEPTED → PROCESSING
 *           → PARTIALLY_SHIPPED → SHIPPED → DELIVERED
 *           (CANCELLED / FAILED at any point)
 *
 * An order is only ever marked SUBMITTED when a transport actually accepted
 * it — an API 2xx, or an email the mailer confirmed. Anything less is FAILED.
 */
const prisma = require('../prisma');
const { allocate, usesSupplierStock } = require('./inventory');
const syncEngine = require('./sync-engine');
const shipping = require('./shipping');
const registry = require('./registry');
const { decryptSecrets, redactString } = require('./credentials');
const { evaluateCountryAccess } = require('./countries');
const marketplaceSettings = require('./settings');
const cache = require('../cache');
const { activity } = require('../audit');

const STATUSES = [
  'PENDING', 'READY', 'SUBMITTED', 'ACCEPTED', 'PROCESSING',
  'PARTIALLY_SHIPPED', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'FAILED',
];

const TIMESTAMP_FIELD = {
  SUBMITTED: 'submittedAt', ACCEPTED: 'acceptedAt',
  SHIPPED: 'shippedAt', PARTIALLY_SHIPPED: 'shippedAt',
  DELIVERED: 'deliveredAt', CANCELLED: 'cancelledAt',
};

const include = {
  supplier: { select: { id: true, name: true, code: true, country: true, currency: true, dropshipEnabled: true } },
  order: { select: { id: true, reference: true, status: true, paymentStatus: true, total: true, shippingName: true, shippingPhone: true, shippingAddress: true, shippingCity: true, shippingCountry: true, shippingPostalCode: true, customer: { select: { name: true, email: true } } } },
  items: { include: { supplierProduct: { select: { id: true, supplierSku: true, name: true, supplierCost: true, restricted: true, restrictionType: true } } } },
};

const round = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Raises supplier fulfilments for an order's dropshipped lines.
 * Idempotent: an existing PENDING/… fulfilment for the same supplier is reused.
 */
async function ensureForOrder({ tenantId = 'default', orderId, actorId = null, reason = null }) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: { include: { product: true } }, customer: true },
  });
  if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });

  // Group the supplier-fulfilled remainder of each line by supplier.
  const bySupplier = new Map();
  const skipped = [];

  for (const item of order.items) {
    const product = item.product;
    if (!usesSupplierStock(product.fulfillmentType)) continue;

    // The split was fixed when the order was placed and stored on the line.
    // Re-deriving it here would be wrong: owned stock has already been
    // deducted, so the same calculation would over-allocate to the supplier.
    // `localQuantity` is null on pre-marketplace lines, which were fully local.
    const localTaken = item.localQuantity === null || item.localQuantity === undefined
      ? item.quantity
      : item.localQuantity;
    const dropshipQuantity = Math.max(0, item.quantity - localTaken);
    if (dropshipQuantity <= 0) continue;
    const allocation = { ...allocate(product, item.quantity), dropship: dropshipQuantity, local: localTaken };

    const mapping = await prisma.supplierProductMapping.findFirst({
      where: { tenantId, productId: product.id },
      include: { supplierProduct: { include: { supplier: true } } },
    });
    if (!mapping?.supplierProduct) {
      skipped.push({ sku: product.sku, reason: 'No supplier product is mapped to this catalogue item' });
      continue;
    }
    const supplierProduct = mapping.supplierProduct;
    if (supplierProduct.supplier.status !== 'ACTIVE' || !supplierProduct.supplier.dropshipEnabled) {
      skipped.push({ sku: product.sku, reason: `${supplierProduct.supplier.name} is not available for dropshipping` });
      continue;
    }

    const access = evaluateCountryAccess({
      destination: order.shippingCountry || (await marketplaceSettings.read()).defaultCountry,
      supplier: supplierProduct.supplier,
      supplierProduct,
    });
    if (!access.allowed) {
      skipped.push({ sku: product.sku, reason: access.reason });
      continue;
    }

    if (!bySupplier.has(supplierProduct.supplierId)) bySupplier.set(supplierProduct.supplierId, []);
    bySupplier.get(supplierProduct.supplierId).push({
      supplierProduct, allocation, item, product,
    });
  }

  const created = [];
  for (const [supplierId, lines] of bySupplier) {
    const existing = await prisma.supplierFulfillment.findFirst({ where: { tenantId, orderId, supplierId } });
    if (existing) { created.push(existing); continue; }

    const supplier = lines[0].supplierProduct.supplier;
    const items = lines.map((l) => ({
      supplierProductId: l.supplierProduct.id,
      productId: l.product.id,
      supplierSku: l.supplierProduct.supplierSku,
      name: l.supplierProduct.name || l.product.name,
      quantity: l.allocation.dropship,
      unitCost: Number(l.supplierProduct.supplierCost) || 0,
      unitPrice: Number(l.item.unitPrice) || 0,
      total: round((Number(l.supplierProduct.supplierCost) || 0) * l.allocation.dropship),
    }));

    const quote = await shipping.quote({
      tenantId,
      country: order.shippingCountry || (await marketplaceSettings.read()).defaultCountry,
      supplierId, supplier,
      supplierProduct: lines[0].supplierProduct,
      categoryId: lines[0].product.categoryId,
      weightKg: lines.reduce((s, l) => s + (Number(l.supplierProduct.weightKg) || 0) * l.allocation.dropship, 0),
      quantity: items.reduce((s, i) => s + i.quantity, 0),
      subtotal: order.subtotal,
    });
    const chosen = quote.options.length
      ? quote.options.reduce((a, b) => (b.cost < a.cost ? b : a), quote.options[0])
      : null;

    const fulfillment = await prisma.supplierFulfillment.create({
      data: {
        tenantId, supplierId, orderId,
        status: 'PENDING',
        fulfillmentType: 'SUPPLIER_FULFILLED',
        transmissionMethod: transmissionMethodFor(supplier),
        transmissionStatus: 'NOT_SENT',
        shippingMethod: chosen?.method || (await marketplaceSettings.read()).defaultShippingMethod,
        shippingCost: chosen?.cost || 0,
        currency: supplier.currency || (await marketplaceSettings.read()).defaultCurrency,
        totalCost: round(items.reduce((s, i) => s + i.total, 0)),
        shipTo: JSON.stringify({
          name: order.shippingName, phone: order.shippingPhone, address: order.shippingAddress,
          city: order.shippingCity, country: order.shippingCountry, postalCode: order.shippingPostalCode,
        }),
        notes: reason || null,
        items: { create: items },
      },
      include,
    });
    created.push(fulfillment);
  }

  if (created.length) cache.invalidate('stats');
  return { fulfillments: created, skipped };
}

function transmissionMethodFor(supplier) {
  const connectorType = supplier.integration?.connectorType;
  if (!connectorType) return 'MANUAL';
  if (connectorType === 'MANUAL') return 'EMAIL';
  return 'API';
}

/**
 * Transmits a fulfilment to the supplier.
 *
 * Three honest outcomes:
 *   API   — the connector POSTed the order and the supplier answered 2xx
 *   EMAIL — the platform mailer accepted the message
 *   MANUAL— no automated channel exists; the record moves to READY and the
 *           operator must place the order themselves. It is NEVER reported as
 *           sent.
 */
async function submit({ tenantId = 'default', fulfillmentId, actorId = null }) {
  const fulfillment = await prisma.supplierFulfillment.findFirst({
    where: { id: fulfillmentId, tenantId }, include: { ...include, supplier: { include: { integration: true } } },
  });
  if (!fulfillment) throw Object.assign(new Error('Fulfilment not found'), { status: 404 });
  if (['SUBMITTED', 'ACCEPTED', 'PROCESSING', 'SHIPPED', 'DELIVERED'].includes(fulfillment.status)) {
    throw Object.assign(new Error(`This fulfilment was already ${fulfillment.status.toLowerCase()}`), { status: 409 });
  }
  if (fulfillment.status === 'CANCELLED') throw Object.assign(new Error('A cancelled fulfilment cannot be submitted'), { status: 409 });

  const supplier = fulfillment.supplier;
  const integration = supplier.integration;
  const payload = {
    reference: fulfillment.order.reference,
    fulfillmentId: fulfillment.id,
    currency: fulfillment.currency,
    shippingMethod: fulfillment.shippingMethod,
    shipTo: JSON.parse(fulfillment.shipTo || '{}'),
    items: fulfillment.items.map((i) => ({
      supplierSku: i.supplierSku, name: i.name, quantity: i.quantity,
      unitCost: i.unitCost, total: i.total,
    })),
  };

  await prisma.supplierFulfillment.update({
    where: { id: fulfillment.id }, data: { attempts: { increment: 1 } },
  });

  let result;
  try {
    if (!integration) {
      await setStatus({ tenantId, fulfillmentId, status: 'READY', actorId, note: 'No integration configured — awaiting manual placement with the supplier.' });
      return {
        ok: true, sent: false, status: 'READY',
        message: 'No supplier integration is configured. The fulfilment is marked READY for manual placement — it has NOT been sent.',
      };
    }

    const adapter = await syncEngine.adapterFor(integration, supplier);

    if (adapter.supports('submitOrder')) {
      result = await adapter.submitOrder(payload);
      await prisma.supplierFulfillment.update({
        where: { id: fulfillment.id },
        data: {
          transmissionMethod: 'API',
          transmissionStatus: 'SENT',
          transmissionRef: result.reference || null,
          supplierOrderId: result.supplierOrderId || null,
          status: 'SUBMITTED',
          submittedAt: new Date(),
          failureReason: null,
        },
      });
      await activity(actorId, 'supplier', `Purchase order for ${fulfillment.order.reference} sent to ${supplier.name} via API`);
      cache.invalidate('stats');
      return { ok: true, sent: true, status: 'SUBMITTED', supplierOrderId: result.supplierOrderId || null, message: result.message || 'Order submitted to the supplier.' };
    }

    // No order API — fall back to the email connector if one is configured.
    const ManualConnector = registry.get('MANUAL');
    const emailConfig = (() => { try { return JSON.parse(integration.config || '{}'); } catch { return {}; } })();
    if (emailConfig.orderEmail) {
      const mailer = new ManualConnector({
        supplier, integration, secrets: {}, config: emailConfig, settings: await marketplaceSettings.read(),
      });
      result = await mailer.submitOrder(payload);
      await prisma.supplierFulfillment.update({
        where: { id: fulfillment.id },
        data: {
          transmissionMethod: 'EMAIL', transmissionStatus: 'SENT',
          transmissionRef: result.reference || null, status: 'SUBMITTED', submittedAt: new Date(), failureReason: null,
        },
      });
      await activity(actorId, 'supplier', `Purchase order for ${fulfillment.order.reference} emailed to ${supplier.name}`);
      cache.invalidate('stats');
      return { ok: true, sent: true, status: 'SUBMITTED', message: result.message };
    }

    await setStatus({ tenantId, fulfillmentId, status: 'READY', actorId, note: 'The connector offers no order API and no order email is configured.' });
    return {
      ok: true, sent: false, status: 'READY',
      message: `${supplier.name} has no order API and no order email is configured. The fulfilment is READY for manual placement — it has NOT been sent.`,
    };
  } catch (err) {
    const secretValues = (() => { try { return Object.values(decryptSecrets(integration?.credentialsCipher)); } catch { return []; } })();
    const message = redactString(err.message || 'Submission failed', secretValues);
    await prisma.supplierFulfillment.update({
      where: { id: fulfillment.id },
      data: { status: 'FAILED', transmissionStatus: 'FAILED', failureReason: message.slice(0, 500) },
    });
    cache.invalidate('stats');
    throw Object.assign(new Error(message), { status: 502, code: 'SUBMISSION_FAILED' });
  }
}

/**
 * Moves a fulfilment through its lifecycle and keeps the customer's order
 * status in step with it.
 */
async function setStatus({ tenantId = 'default', fulfillmentId, status, actorId = null, note = null, tracking = null }) {
  if (!STATUSES.includes(status)) throw Object.assign(new Error(`Unknown fulfilment status "${status}"`), { status: 400 });
  const fulfillment = await prisma.supplierFulfillment.findFirst({ where: { id: fulfillmentId, tenantId }, include });
  if (!fulfillment) throw Object.assign(new Error('Fulfilment not found'), { status: 404 });

  const data = { status };
  const stamp = TIMESTAMP_FIELD[status];
  if (stamp && !fulfillment[stamp]) data[stamp] = new Date();
  if (status === 'FAILED' && note) data.failureReason = note.slice(0, 500);
  if (note && status !== 'FAILED') data.notes = note.slice(0, 1000);
  if (tracking) {
    if (tracking.trackingNumber) data.trackingNumber = String(tracking.trackingNumber).slice(0, 120);
    if (tracking.carrier) data.carrier = String(tracking.carrier).slice(0, 120);
    if (tracking.trackingUrl) data.trackingUrl = String(tracking.trackingUrl).slice(0, 400);
  }

  const updated = await prisma.supplierFulfillment.update({ where: { id: fulfillment.id }, data, include });
  await syncOrderStatus(tenantId, fulfillment.orderId);
  cache.invalidate('stats');
  return updated;
}

/** Records tracking details captured from the supplier or entered by an admin. */
async function recordTracking({ tenantId = 'default', fulfillmentId, trackingNumber, carrier, trackingUrl, status = 'SHIPPED', actorId = null }) {
  if (!trackingNumber) throw Object.assign(new Error('A tracking number is required'), { status: 400 });
  return setStatus({ tenantId, fulfillmentId, status, actorId, tracking: { trackingNumber, carrier, trackingUrl } });
}

/**
 * Pulls the current status / tracking from the supplier. Reports clearly when
 * the connector cannot provide it instead of inventing a value.
 */
async function refreshFromSupplier({ tenantId = 'default', fulfillmentId }) {
  const fulfillment = await prisma.supplierFulfillment.findFirst({
    where: { id: fulfillmentId, tenantId }, include: { ...include, supplier: { include: { integration: true } } },
  });
  if (!fulfillment) throw Object.assign(new Error('Fulfilment not found'), { status: 404 });
  const integration = fulfillment.supplier.integration;
  if (!integration) {
    return { ok: false, supported: false, message: 'No integration configured — supplier status is unavailable. Update it manually.' };
  }
  const adapter = await syncEngine.adapterFor(integration, fulfillment.supplier);
  const out = { ok: true, supported: false, statusChecked: false, trackingChecked: false };

  if (!fulfillment.supplierOrderId) {
    out.message = 'This fulfilment has no supplier order id yet, so there is nothing to poll.';
    return out;
  }

  if (adapter.supports('getOrderStatus')) {
    const result = await adapter.getOrderStatus(fulfillment.supplierOrderId);
    out.statusChecked = true;
    out.supplierStatus = result.raw;
    if (result.status && STATUSES.includes(result.status) && result.status !== fulfillment.status) {
      await setStatus({ tenantId, fulfillmentId, status: result.status });
      out.statusUpdated = result.status;
    }
  }
  if (adapter.supports('getTracking')) {
    const tracking = await adapter.getTracking(fulfillment.supplierOrderId);
    out.trackingChecked = true;
    out.tracking = tracking;
    if (tracking.trackingNumber && tracking.trackingNumber !== fulfillment.trackingNumber) {
      await recordTracking({
        tenantId, fulfillmentId,
        trackingNumber: tracking.trackingNumber,
        carrier: tracking.carrier,
        trackingUrl: tracking.trackingUrl,
        status: tracking.status && STATUSES.includes(tracking.status) ? tracking.status : 'SHIPPED',
      });
      out.trackingUpdated = true;
    }
  }

  if (!out.statusChecked && !out.trackingChecked) {
    out.supported = false;
    out.message = `${fulfillment.supplier.name} does not expose order status or tracking through its connector. Tracking is not supported for this supplier.`;
  }

  // Reconcile the customer's order on every poll, including when the supplier
  // reports a status we already held — the order may have been paid since the
  // last poll, and the customer must not be left looking at a stale status.
  await syncOrderStatus(tenantId, fulfillment.orderId);
  return out;
}

/** Cancels a fulfilment, telling the supplier when it can. */
async function cancel({ tenantId = 'default', fulfillmentId, reason, actorId = null }) {
  const fulfillment = await prisma.supplierFulfillment.findFirst({
    where: { id: fulfillmentId, tenantId }, include: { ...include, supplier: { include: { integration: true } } },
  });
  if (!fulfillment) throw Object.assign(new Error('Fulfilment not found'), { status: 404 });
  if (['DELIVERED', 'CANCELLED'].includes(fulfillment.status)) {
    throw Object.assign(new Error(`A ${fulfillment.status.toLowerCase()} fulfilment cannot be cancelled`), { status: 409 });
  }

  let supplierNotified = false;
  let supplierMessage = 'The supplier was not notified — no order API is configured.';

  if (fulfillment.supplierOrderId && fulfillment.supplier.integration) {
    const adapter = await syncEngine.adapterFor(fulfillment.supplier.integration, fulfillment.supplier);
    if (adapter.supports('cancelOrder')) {
      const result = await adapter.cancelOrder(fulfillment.supplierOrderId, reason);
      supplierNotified = true;
      supplierMessage = result.message || 'Cancellation sent to the supplier.';
    }
  }

  const updated = await setStatus({ tenantId, fulfillmentId, status: 'CANCELLED', actorId, note: reason || null });
  await activity(actorId, 'supplier', `Fulfilment for ${fulfillment.order.reference} cancelled (${fulfillment.supplier.name})`);
  return { fulfillment: updated, supplierNotified, supplierMessage };
}

/**
 * Keeps the customer's order status in step with its fulfilments.
 * Only ever moves an order forward, and only once it is paid.
 */
async function syncOrderStatus(tenantId, orderId) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || order.status === 'CANCELLED') return order;

  const fulfillments = await prisma.supplierFulfillment.findMany({ where: { tenantId, orderId } });
  if (!fulfillments.length) return order;

  const active = fulfillments.filter((f) => !['CANCELLED', 'FAILED'].includes(f.status));
  if (!active.length) return order;

  const allDelivered = active.every((f) => f.status === 'DELIVERED');
  const anyShipped = active.some((f) => ['SHIPPED', 'DELIVERED', 'PARTIALLY_SHIPPED'].includes(f.status));

  let target = null;
  if (allDelivered) target = 'COMPLETED';
  else if (anyShipped) target = 'SHIPPED';
  if (!target) return order;

  const orderRank = { PENDING: 0, PAID: 1, SHIPPED: 2, COMPLETED: 3 };
  if ((orderRank[order.status] ?? 0) >= orderRank[target]) return order;
  if (order.paymentStatus !== 'PAID' && order.status === 'PENDING') return order;

  return prisma.order.update({ where: { id: orderId }, data: { status: target } });
}

/** Fulfilment summary shown on the order detail view. */
async function forOrder({ tenantId = 'default', orderId }) {
  return prisma.supplierFulfillment.findMany({ where: { tenantId, orderId }, include, orderBy: { createdAt: 'asc' } });
}

module.exports = {
  STATUSES, ensureForOrder, submit, setStatus, recordTracking, refreshFromSupplier,
  cancel, syncOrderStatus, forOrder, transmissionMethodFor,
};
