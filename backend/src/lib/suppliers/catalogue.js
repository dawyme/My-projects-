/**
 * Publishing: the bridge between a SupplierProduct and the platform's ONE
 * product catalogue.
 *
 * There is deliberately no second catalogue. Publishing creates or updates a
 * real `Product` row, which is what the storefront, cart, checkout, orders and
 * inventory pages already read. The mapping row (`SupplierProductMapping`)
 * records the link, so later syncs update the same product instead of creating
 * a duplicate.
 *
 * Owned stock is never overwritten: `Product.quantity` is left exactly as the
 * inventory module maintains it. Only `supplierStock`, `fulfillmentType` and
 * `supplierStockAt` are mirrored, plus price/cost/content.
 */
const prisma = require('../prisma');
const { priceFor } = require('./markup');
const { FULFILLMENT_TYPES } = require('./inventory');
const marketplaceSettings = require('./settings');
const cache = require('../cache');

const slugify = (s) => String(s).toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'product';

async function uniqueSlug(base, ignoreId) {
  let slug = base;
  let n = 1;
  // Slug collisions get a numeric suffix.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const found = await prisma.product.findUnique({ where: { slug } });
    if (!found || found.id === ignoreId) return slug;
    slug = `${base}-${++n}`;
  }
}

const FALLBACK_CATEGORY = { name: 'Supplier Imports', slug: 'supplier-imports' };

async function ensureCategory(tenantId, categoryId, categoryText) {
  if (categoryId) {
    const found = await prisma.category.findUnique({ where: { id: categoryId } });
    if (found) return found;
  }
  if (categoryText) {
    const slug = slugify(categoryText);
    const found = await prisma.category.findFirst({ where: { OR: [{ slug }, { name: categoryText }] } });
    if (found) return found;
    return prisma.category.create({ data: { name: String(categoryText).slice(0, 120), slug: await uniqueSlug(slug) } });
  }
  const fallback = await prisma.category.findFirst({ where: { slug: FALLBACK_CATEGORY.slug } });
  if (fallback) return fallback;
  return prisma.category.create({ data: { name: FALLBACK_CATEGORY.name, slug: FALLBACK_CATEGORY.slug } });
}

/** Recomputes a supplier product's selling price with the markup engine. */
async function reprice(supplierProductId, { tenantId = 'default' } = {}) {
  const supplierProduct = await prisma.supplierProduct.findFirst({
    where: { id: supplierProductId, tenantId }, include: { supplier: true },
  });
  if (!supplierProduct) return null;
  const globalRule = await marketplaceSettings.globalMarkupRule();
  const categoryRules = supplierProduct.categoryId
    ? await prisma.supplierMarkupRule.findMany({ where: { tenantId, scope: 'CATEGORY', categoryId: supplierProduct.categoryId, isActive: true } })
    : [];
  const price = priceFor({ supplierProduct, supplier: supplierProduct.supplier, categoryRules, globalRule });
  await prisma.supplierProduct.update({
    where: { id: supplierProduct.id },
    data: { sellingPrice: price.price, markupApplied: JSON.stringify(price.rule) },
  });
  return price;
}

/**
 * Publishes a supplier product to the storefront catalogue.
 * Idempotent: publishing twice updates the same Product.
 */
async function publish({ tenantId = 'default', supplierProductId, actorId = null }) {
  const supplierProduct = await prisma.supplierProduct.findFirst({
    where: { id: supplierProductId, tenantId },
    include: { supplier: true, mapping: { include: { product: true } } },
  });
  if (!supplierProduct) throw Object.assign(new Error('Supplier product not found'), { status: 404 });

  const settings = await marketplaceSettings.read();
  const price = await reprice(supplierProduct.id, { tenantId });
  const category = await ensureCategory(tenantId, supplierProduct.categoryId, supplierProduct.categoryText);
  const fulfillmentType = FULFILLMENT_TYPES.includes(supplierProduct.fulfillmentType)
    ? supplierProduct.fulfillmentType
    : (FULFILLMENT_TYPES.includes(supplierProduct.supplier.fulfillmentType)
      ? supplierProduct.supplier.fulfillmentType
      : settings.defaultFulfillmentType);

  const content = {
    name: supplierProduct.name,
    description: supplierProduct.description || null,
    brand: supplierProduct.brand || null,
    model: supplierProduct.manufacturerPart || null,
    imageUrl: supplierProduct.imageUrl || null,
    gallery: supplierProduct.gallery || null,
    specs: supplierProduct.specs || null,
  };

  let product = supplierProduct.mapping?.product || null;
  let createdProduct = false;

  if (!product) {
    const bySku = await prisma.product.findUnique({ where: { sku: supplierProduct.supplierSku.toUpperCase() } });
    if (bySku) product = bySku;
  }

  if (product) {
    product = await prisma.product.update({
      where: { id: product.id },
      data: {
        ...content,
        categoryId: category.id,
        price: price.price,
        costPrice: price.cost,
        supplierStock: Math.max(0, supplierProduct.stock),
        supplierStockAt: new Date(),
        fulfillmentType,
        isActive: true,
      },
    });
  } else {
    product = await prisma.product.create({
      data: {
        sku: supplierProduct.supplierSku.toUpperCase(),
        slug: await uniqueSlug(slugify(supplierProduct.name)),
        ...content,
        categoryId: category.id,
        price: price.price,
        costPrice: price.cost,
        quantity: 0, // N&D owns none of this yet — it is supplier stock only
        supplierStock: Math.max(0, supplierProduct.stock),
        supplierStockAt: new Date(),
        fulfillmentType,
        isActive: true,
      },
    });
    createdProduct = true;
  }

  // Record / refresh the mapping so future syncs land on this product.
  const existing = await prisma.supplierProductMapping.findUnique({ where: { supplierProductId: supplierProduct.id } });
  if (existing) {
    await prisma.supplierProductMapping.update({ where: { id: existing.id }, data: { productId: product.id } });
  } else {
    const taken = await prisma.supplierProductMapping.findFirst({ where: { tenantId, productId: product.id } });
    if (!taken) {
      await prisma.supplierProductMapping.create({
        data: {
          tenantId, supplierId: supplierProduct.supplierId, supplierProductId: supplierProduct.id,
          productId: product.id, supplierSku: supplierProduct.supplierSku,
          matchKey: createdProduct ? 'CREATED' : 'SKU', source: 'AUTO', confidence: createdProduct ? 100 : 90,
        },
      });
    }
  }

  await prisma.supplierProduct.update({
    where: { id: supplierProduct.id },
    data: { published: true, mappingStatus: 'AUTO', sellingPrice: price.price, markupApplied: JSON.stringify(price.rule) },
  });

  cache.invalidate('stats');
  return { product, price, createdProduct };
}

/**
 * Unpublishes. A product the marketplace created is archived; a product that
 * already existed in N&D's catalogue is left in place and simply detached from
 * supplier fulfilment, so no owned data is destroyed.
 */
async function unpublish({ tenantId = 'default', supplierProductId }) {
  const supplierProduct = await prisma.supplierProduct.findFirst({
    where: { id: supplierProductId, tenantId },
    include: { mapping: true },
  });
  if (!supplierProduct) throw Object.assign(new Error('Supplier product not found'), { status: 404 });

  await prisma.supplierProduct.update({ where: { id: supplierProduct.id }, data: { published: false } });

  if (supplierProduct.mapping) {
    const product = await prisma.product.findUnique({ where: { id: supplierProduct.mapping.productId } });
    if (product) {
      const marketplaceOwned = supplierProduct.mapping.matchKey === 'CREATED';
      await prisma.product.update({
        where: { id: product.id },
        data: {
          supplierStock: 0,
          supplierStockAt: null,
          fulfillmentType: 'LOCAL',
          ...(marketplaceOwned ? { isActive: false } : {}),
        },
      });
    }
    await prisma.supplierProductMapping.delete({ where: { id: supplierProduct.mapping.id } });
    await prisma.supplierProduct.update({ where: { id: supplierProduct.id }, data: { mappingStatus: 'UNMAPPED' } });
  }

  cache.invalidate('stats');
  return { unpublished: true };
}

/**
 * Mirrors a supplier product onto its published platform product after a sync.
 * Returns the fields that actually changed (used for change counting).
 */
async function mirrorToProduct({ tenantId = 'default', supplierProduct, supplier }) {
  const mapping = await prisma.supplierProductMapping.findUnique({
    where: { supplierProductId: supplierProduct.id }, include: { product: true },
  });
  if (!mapping?.product || !supplierProduct.published) return { changed: [] };

  const product = mapping.product;
  const data = {};
  if (Math.abs(Number(product.price) - Number(supplierProduct.sellingPrice)) > 1e-9) data.price = supplierProduct.sellingPrice;
  if (Math.abs(Number(product.costPrice) - Number(supplierProduct.supplierCost)) > 1e-9) data.costPrice = supplierProduct.supplierCost;
  if (Number(product.supplierStock || 0) !== Number(supplierProduct.stock || 0)) data.supplierStock = Math.max(0, supplierProduct.stock || 0);
  if (supplierProduct.name && product.name !== supplierProduct.name) data.name = supplierProduct.name;
  if (supplierProduct.imageUrl && product.imageUrl !== supplierProduct.imageUrl) data.imageUrl = supplierProduct.imageUrl;
  if (supplierProduct.brand && product.brand !== supplierProduct.brand) data.brand = supplierProduct.brand;
  data.supplierStockAt = new Date();

  const changed = Object.keys(data).filter((k) => k !== 'supplierStockAt');
  if (changed.length || data.supplierStock !== undefined) {
    await prisma.product.update({ where: { id: product.id }, data });
    cache.invalidate('stats');
  }
  return { changed, productId: product.id };
}

/** Manually links a supplier product to an existing platform product. */
async function mapToProduct({ tenantId = 'default', supplierProductId, productId }) {
  const supplierProduct = await prisma.supplierProduct.findFirst({ where: { id: supplierProductId, tenantId } });
  if (!supplierProduct) throw Object.assign(new Error('Supplier product not found'), { status: 404 });
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) throw Object.assign(new Error('Platform product not found'), { status: 404 });

  const existing = await prisma.supplierProductMapping.findUnique({ where: { supplierProductId: supplierProduct.id } });
  const taken = await prisma.supplierProductMapping.findFirst({ where: { tenantId, productId } });
  if (taken && taken.supplierProductId !== supplierProduct.id) {
    throw Object.assign(new Error(`That platform product is already mapped to supplier SKU ${taken.supplierSku}`), { status: 409 });
  }

  if (existing) {
    await prisma.supplierProductMapping.update({
      where: { id: existing.id },
      data: { productId, supplierSku: supplierProduct.supplierSku, matchKey: 'MANUAL', source: 'MANUAL', confidence: 100 },
    });
  } else {
    await prisma.supplierProductMapping.create({
      data: {
        tenantId, supplierId: supplierProduct.supplierId, supplierProductId: supplierProduct.id,
        productId, supplierSku: supplierProduct.supplierSku, matchKey: 'MANUAL', source: 'MANUAL', confidence: 100,
      },
    });
  }
  await prisma.supplierProduct.update({ where: { id: supplierProduct.id }, data: { mappingStatus: 'MANUAL' } });
  return prisma.supplierProductMapping.findUnique({ where: { supplierProductId: supplierProduct.id }, include: { product: true } });
}

async function unmap({ tenantId = 'default', supplierProductId }) {
  const mapping = await prisma.supplierProductMapping.findFirst({
    where: { supplierProductId, tenantId }, include: { supplierProduct: true, product: true },
  });
  if (!mapping) throw Object.assign(new Error('No mapping found'), { status: 404 });
  if (mapping.supplierProduct.published) {
    throw Object.assign(new Error('Unpublish the supplier product before removing its mapping'), { status: 409 });
  }
  await prisma.supplierProductMapping.delete({ where: { id: mapping.id } });
  await prisma.supplierProduct.update({ where: { id: supplierProductId }, data: { mappingStatus: 'UNMAPPED' } });
  return { unmapped: true, productSku: mapping.product.sku };
}

module.exports = { publish, unpublish, reprice, mirrorToProduct, mapToProduct, unmap, ensureCategory };
