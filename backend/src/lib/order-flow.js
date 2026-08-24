/**
 * Glue between the EXISTING order/payment flow and supplier fulfilment.
 *
 * Nothing here replaces checkout, payments or order creation. These helpers are
 * called at two well-defined moments:
 *
 *   afterOrderCreated()  — the order row exists; raise supplier fulfilments for
 *                          the dropshipped remainder of each line
 *   onOrderPaid()        — money has been captured; optionally transmit the
 *                          purchase orders automatically
 *
 * Both are non-throwing by design: a supplier-side problem must never fail a
 * customer's payment. Problems are recorded on the fulfilment record and shown
 * in the Admin dashboard instead.
 */
const prisma = require('./prisma');
const fulfillment = require('./suppliers/fulfillment');
const marketplaceSettings = require('./suppliers/settings');
const { allocate, usesSupplierStock } = require('./suppliers/inventory');
const { tenantOf } = require('./suppliers/tenant');
const { activity } = require('./audit');
const cache = require('./cache');

/**
 * Splits each requested line between N&D stock and supplier stock.
 * @returns {{lines:Array, allocations:Object, shortfalls:Array}}
 */
function planLines(products, requested) {
  const byId = new Map(products.map((p) => [p.id, p]));
  const allocations = {};
  const shortfalls = [];
  const lines = requested.map((item) => {
    const product = byId.get(item.productId);
    if (!product) {
      shortfalls.push({ productId: item.productId, reason: 'Product not found' });
      return null;
    }
    const alloc = allocate(product, item.quantity);
    allocations[product.id] = alloc;
    if (alloc.short > 0) {
      shortfalls.push({
        productId: product.id, sku: product.sku, name: product.name,
        requested: item.quantity, available: alloc.available,
        reason: `Insufficient stock for ${product.name} (${alloc.available} available)`,
      });
      return null;
    }
    return { product, allocation: alloc };
  }).filter(Boolean);
  return { lines, allocations, shortfalls };
}

/**
 * Raises supplier fulfilments for a freshly created order.
 * Safe to call for orders with no supplier lines — it is a no-op then.
 */
async function afterOrderCreated({ req = null, orderId }) {
  try {
    const tenantId = tenantOf(req);
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: { include: { product: true } } } });
    if (!order) return { fulfillments: [], skipped: [] };
    const hasSupplierLine = order.items.some((i) => usesSupplierStock(i.product?.fulfillmentType));
    if (!hasSupplierLine) return { fulfillments: [], skipped: [] };

    const result = await fulfillment.ensureForOrder({ tenantId, orderId });
    if (result.fulfillments.length) {
      await activity(null, 'supplier', `${result.fulfillments.length} supplier fulfilment(s) raised for order ${order.reference}`);
      // A COD/bank order in a sandbox environment is captured immediately, so
      // give the paid hook a chance to run in the same request.
      if (order.paymentStatus === 'PAID') await onOrderPaid({ req, orderId });
    }
    return result;
  } catch (err) {
    await activity(null, 'supplier', `Could not raise supplier fulfilments for order ${orderId}: ${err.message}`);
    return { fulfillments: [], skipped: [{ reason: err.message }] };
  }
}

/**
 * Called once payment is captured. Transmits purchase orders only when the
 * operator has switched automatic submission on — otherwise fulfilments wait
 * in PENDING for a human to review and submit.
 */
async function onOrderPaid({ req = null, orderId }) {
  try {
    const settings = await marketplaceSettings.read();
    if (!settings.autoSubmitOrders) return { submitted: 0, held: true };
    const tenantId = tenantOf(req);
    const pending = await prisma.supplierFulfillment.findMany({
      where: { tenantId, orderId, status: { in: ['PENDING', 'READY'] } },
    });
    let submitted = 0;
    const failures = [];
    for (const record of pending) {
      try { await fulfillment.submit({ tenantId, fulfillmentId: record.id }); submitted++; }
      catch (err) { failures.push({ fulfillmentId: record.id, message: err.message }); }
    }
    cache.invalidate('stats');
    return { submitted, failures };
  } catch (err) {
    return { submitted: 0, error: err.message };
  }
}

/** Availability summary used by the storefront feed and cart validation. */
function availabilitySummary(product) {
  const alloc = allocate(product, Number.MAX_SAFE_INTEGER);
  return {
    available: alloc.available,
    localStock: Math.max(0, Number(product.quantity) || 0),
    supplierStock: usesSupplierStock(product.fulfillmentType) ? Math.max(0, Number(product.supplierStock) || 0) : 0,
    fulfillmentType: product.fulfillmentType || 'LOCAL',
    inStock: alloc.available > 0,
  };
}

/**
 * How many units of each line were deducted from N&D-owned stock.
 *
 * Derived from the fulfilment records rather than stored redundantly, so there
 * is no second source of truth to drift. Anything a supplier is shipping was
 * never taken out of `Product.quantity`, so it must not be put back when an
 * order is cancelled — doing so would inflate owned stock with supplier units.
 *
 * @returns {Map<string, number>} productId → units to return to owned stock
 */
async function restockableQuantities({ tenantId = 'default', orderId, items }) {
  const dropshipped = new Map();
  const fulfillmentItems = await prisma.supplierFulfillmentItem.findMany({
    where: {
      tenantId,
      productId: { in: items.map((i) => i.productId) },
      fulfillment: { orderId, status: { not: 'CANCELLED' } },
    },
    select: { productId: true, quantity: true },
  });
  for (const fi of fulfillmentItems) {
    dropshipped.set(fi.productId, (dropshipped.get(fi.productId) || 0) + fi.quantity);
  }
  const out = new Map();
  for (const item of items) {
    // Newer order lines carry the exact split; older ones fall back to what the
    // fulfilment records show was dropshipped.
    const local = item.localQuantity === null || item.localQuantity === undefined
      ? Math.max(0, item.quantity - (dropshipped.get(item.productId) || 0))
      : item.localQuantity;
    out.set(item.productId, local);
  }
  return out;
}

module.exports = { planLines, afterOrderCreated, onOrderPaid, availabilitySummary, restockableQuantities };
