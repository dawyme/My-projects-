/**
 * Inventory model for supplier-fulfilled goods.
 *
 * The one rule that must never be broken: `Product.quantity` is N&D-owned
 * stock. A supplier feed NEVER writes to it. Supplier availability lives in
 * `Product.supplierStock` and only becomes sellable when the product's
 * `fulfillmentType` opts in.
 *
 *   LOCAL              available = quantity                      (supplierStock ignored)
 *   SUPPLIER_FULFILLED available = quantity + supplierStock      (supplier ships the rest)
 *   HYBRID             available = quantity + supplierStock      (N&D stock is used first)
 *
 * Everything that needs to answer "can we sell N of these?" — storefront feed,
 * cart, checkout, admin order entry — goes through {@link availableStock} so
 * the three numbers stay consistent across the platform.
 */

const FULFILLMENT_TYPES = ['LOCAL', 'SUPPLIER_FULFILLED', 'HYBRID'];

const FULFILLMENT_LABELS = {
  LOCAL: 'Local inventory',
  SUPPLIER_FULFILLED: 'Supplier fulfilled',
  HYBRID: 'Hybrid',
};

const FULFILLMENT_DESCRIPTIONS = {
  LOCAL: 'N&D owns the stock and fulfils the order from its own warehouse.',
  SUPPLIER_FULFILLED: 'The supplier owns the stock and ships directly to the customer.',
  HYBRID: 'N&D stock is used first; the shortfall is dropshipped by the supplier.',
};

const usesSupplierStock = (fulfillmentType) => fulfillmentType === 'SUPPLIER_FULFILLED' || fulfillmentType === 'HYBRID';

/** Units that can actually be sold right now. */
function availableStock(product) {
  if (!product) return 0;
  const local = Number(product.quantity) || 0;
  if (!usesSupplierStock(product.fulfillmentType)) return Math.max(0, local);
  return Math.max(0, local) + Math.max(0, Number(product.supplierStock) || 0);
}

/**
 * Splits a requested quantity between N&D stock and the supplier.
 * N&D stock is always consumed first (HYBRID and SUPPLIER_FULFILLED alike).
 * @returns {{local:number, dropship:number, short:number, available:number}}
 */
function allocate(product, requested) {
  const want = Math.max(0, Math.trunc(Number(requested) || 0));
  const local = Math.max(0, Number(product?.quantity) || 0);
  const supplier = usesSupplierStock(product?.fulfillmentType) ? Math.max(0, Number(product?.supplierStock) || 0) : 0;
  const available = local + supplier;
  const fromLocal = Math.min(want, local);
  const fromSupplier = Math.min(want - fromLocal, supplier);
  return {
    local: fromLocal,
    dropship: fromSupplier,
    short: Math.max(0, want - fromLocal - fromSupplier),
    available,
  };
}

/** Stock status label, computed from *available* stock (not owned stock). */
function stockStatus(product) {
  const available = availableStock(product);
  if (available <= 0) return 'out';
  if (available <= (Number(product?.lowStockLevel) || 0)) return 'low';
  return 'ok';
}

/** Adds the computed inventory fields to a product payload for API responses. */
function decorate(product) {
  if (!product) return product;
  const available = availableStock(product);
  const allocation = allocate(product, available);
  return {
    ...product,
    localStock: Math.max(0, Number(product.quantity) || 0),
    supplierStock: Math.max(0, Number(product.supplierStock) || 0),
    availableStock: available,
    stockStatus: stockStatus(product),
    fulfillmentType: product.fulfillmentType || 'LOCAL',
    fulfillmentLabel: FULFILLMENT_LABELS[product.fulfillmentType] || FULFILLMENT_LABELS.LOCAL,
    supplierFulfilled: allocation.dropship > 0,
  };
}

/** Batch version — avoids N+1 lookups when listing a catalogue. */
function decorateMany(products) {
  return (products || []).map(decorate);
}

/**
 * Mirrors supplier availability onto a mapped platform product WITHOUT ever
 * touching owned stock. Returns the patch to apply (or null when nothing
 * changed), so the sync engine can skip no-op writes and stay idempotent.
 */
function supplierStockPatch(product, supplierProduct, { fulfillmentType }) {
  const targetFulfillment = fulfillmentType || product.fulfillmentType || 'LOCAL';
  const stock = Math.max(0, Math.trunc(Number(supplierProduct?.stock) || 0));
  const patch = {};
  if (Number(product.supplierStock || 0) !== stock) patch.supplierStock = stock;
  if ((product.fulfillmentType || 'LOCAL') !== targetFulfillment) patch.fulfillmentType = targetFulfillment;
  patch.supplierStockAt = new Date();
  return patch;
}

module.exports = {
  FULFILLMENT_TYPES, FULFILLMENT_LABELS, FULFILLMENT_DESCRIPTIONS,
  usesSupplierStock, availableStock, allocate, stockStatus, decorate, decorateMany, supplierStockPatch,
};
