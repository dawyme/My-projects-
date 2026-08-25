/**
 * Supplier shipping rules and quotes.
 *
 * Nothing here assumes a product can ship anywhere. A quote exists only when an
 * operator has defined a rule that matches the destination; when no rule
 * matches the answer is "not shippable to this country", never a default rate.
 *
 * Rule specificity (most specific wins when several match):
 *     PRODUCT  →  CATEGORY  →  SUPPLIER  →  GLOBAL
 *
 * Every rule may carry its own country allow/block lists and regions, and rules
 * flagged `restricted` apply only to restricted goods (refrigerants and similar
 * operator-designated items).
 */
const prisma = require('../prisma');
const marketplaceSettings = require('./settings');
const { evaluateCountryAccess, expandCountries, parseList, COUNTRY_BY_CODE } = require('./countries');

const SCOPE_RANK = { PRODUCT: 0, CATEGORY: 1, SUPPLIER: 2, GLOBAL: 3 };

/** Shipping cost for one rule against a basket. */
function costFor(rule, { weightKg = 0, quantity = 1, subtotal = 0 } = {}) {
  const base = Number(rule.baseCost) || 0;
  const perKg = Number(rule.perKgCost) || 0;
  const perItem = Number(rule.perItemCost) || 0;
  const total = base + perKg * Math.max(0, Number(weightKg) || 0) + perItem * Math.max(0, Number(quantity) || 0);
  const freeOver = rule.freeOverAmount;
  const isFree = freeOverAmount => freeOverAmount !== null && freeOverAmount !== undefined
    && Number(subtotal) >= Number(freeOverAmount);
  return {
    cost: isFree(freeOver) ? 0 : Math.round(Math.max(0, total) * 100) / 100,
    freeShipping: isFree(freeOver),
    breakdown: { base, perKg, perItem, weightKg, quantity },
  };
}

/** Loads every active rule that could apply to this shipment. */
async function candidateRules({ tenantId = 'default', supplierId = null, supplierProductId = null, categoryId = null }) {
  const where = { tenantId, isActive: true };
  return prisma.supplierShippingRule.findMany({
    where: {
      ...where,
      OR: [
        { scope: 'GLOBAL' },
        ...(supplierId ? [{ scope: 'SUPPLIER', supplierId }] : []),
        ...(supplierId ? [{ scope: 'PRODUCT', supplierId }] : []),
        ...(categoryId ? [{ scope: 'CATEGORY', categoryId }] : []),
      ],
    },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
  });
}

function ruleMatches(rule, { country, supplierProductId, categoryId, supplierId, restricted }) {
  if (rule.scope === 'PRODUCT' && rule.supplierProductId !== supplierProductId) return false;
  if (rule.scope === 'CATEGORY' && rule.categoryId !== categoryId) return false;
  if (rule.scope === 'SUPPLIER' && rule.supplierId !== supplierId) return false;
  if (rule.scope !== 'GLOBAL' && rule.supplierId && rule.supplierId !== supplierId) return false;

  if (rule.restricted && !restricted) return false;

  const allow = expandCountries(parseList(rule.countries));
  const block = expandCountries(parseList(rule.excludedCountries));
  const regions = parseList(rule.regions);

  if (block.includes(country)) return false;
  if (allow.length && !allow.includes(country)) return false;
  if (regions.length) {
    const expanded = expandCountries(regions);
    if (!expanded.includes(country)) return false;
  }
  return true;
}

/**
 * Produces every shipping option available for a shipment.
 * @returns {{shippable:boolean, options:Array, restrictions:string[], blocked:reason|null}}
 */
async function quote({
  tenantId = 'default', country, supplierId = null, supplier = null, supplierProduct = null,
  categoryId = null, weightKg = 0, quantity = 1, subtotal = 0,
}) {
  const settings = await marketplaceSettings.read(tenantId);
  const destination = String(country || '').toUpperCase();

  const platformBlocked = expandCountries(settings.blockedCountries || []);
  if (platformBlocked.includes(destination)) {
    return {
      shippable: false, options: [], restrictions: [],
      blocked: `${COUNTRY_BY_CODE[destination]?.name || destination} is blocked at the platform level.`,
      destination,
    };
  }

  const supplierRow = supplier || (supplierId
    ? await prisma.supplier.findFirst({ where: { id: supplierId, tenantId } })
    : null);

  const access = evaluateCountryAccess({ destination, supplier: supplierRow || {}, supplierProduct });
  if (supplierRow && !access.allowed) {
    return { shippable: false, options: [], restrictions: access.restrictions, blocked: access.reason, destination: access.destination };
  }

  const rules = await candidateRules({
    tenantId, supplierId, supplierProductId: supplierProduct?.id || null, categoryId,
  });

  const restricted = Boolean(supplierProduct?.restricted);
  const matching = rules
    .filter((r) => ruleMatches(r, {
      country: access.destination || destination,
      supplierProductId: supplierProduct?.id || null,
      categoryId, supplierId, restricted,
    }))
    .sort((a, b) => (SCOPE_RANK[a.scope] ?? 9) - (SCOPE_RANK[b.scope] ?? 9));

  const options = matching.map((rule) => {
    const cost = costFor(rule, { weightKg, quantity, subtotal });
    return {
      ruleId: rule.id,
      scope: rule.scope,
      method: rule.method,
      methodName: rule.methodName,
      carrier: rule.carrier,
      cost: cost.cost,
      freeShipping: cost.freeShipping,
      breakdown: cost.breakdown,
      minDays: rule.minDays,
      maxDays: rule.maxDays,
      estimate: rule.minDays || rule.maxDays
        ? `${rule.minDays || rule.maxDays}–${rule.maxDays || rule.minDays} business day(s)`
        : null,
      restrictedOnly: rule.restricted,
      restrictionNote: rule.restrictionNote || null,
    };
  });

  // A restricted product may only use the carriers its own record allows.
  const allowedMethods = parseList(supplierProduct?.allowedShippingMethods);
  const filtered = allowedMethods.length
    ? options.filter((o) => allowedMethods.includes(String(o.method).toUpperCase()))
    : options;

  if (restricted && allowedMethods.length && !filtered.length) {
    return {
      shippable: false, options: [],
      restrictions: access.restrictions,
      blocked: `This restricted product may only ship via ${allowedMethods.join(', ')}, which is not available to ${COUNTRY_BY_CODE[access.destination || destination]?.name || destination}.`,
      destination: access.destination || destination,
    };
  }

  return {
    shippable: filtered.length > 0,
    options: filtered,
    restrictions: access.restrictions,
    blocked: filtered.length ? null : `No shipping rule covers ${COUNTRY_BY_CODE[access.destination || destination]?.name || destination} for this item. Add one under Supplier Marketplace → Shipping.`,
    destination: access.destination || destination,
  };
}

/**
 * Quotes every supplier-fulfilled line in an order and returns the total
 * shipping cost plus anything that cannot be shipped.
 */
async function quoteOrder({ tenantId = 'default', order, lines }) {
  const settings = await marketplaceSettings.read(tenantId);
  const country = String(order?.shippingCountry || settings.defaultCountry || '').toUpperCase();
  const results = [];
  let total = 0;
  const blockers = [];

  for (const line of lines) {
    const quoteResult = await quote({
      tenantId, country,
      supplierId: line.supplierId,
      supplierProduct: line.supplierProduct,
      categoryId: line.categoryId,
      weightKg: (Number(line.weightKg) || 0) * (line.quantity || 1),
      quantity: line.quantity,
      subtotal: line.subtotal,
    });
    if (!quoteResult.shippable) {
      blockers.push({ sku: line.supplierSku || line.sku, reason: quoteResult.blocked });
      continue;
    }
    const cheapest = quoteResult.options.reduce((a, b) => (b.cost < a.cost ? b : a), quoteResult.options[0]);
    total += cheapest.cost;
    results.push({ sku: line.supplierSku || line.sku, option: cheapest, all: quoteResult.options });
  }

  return { country, total: Math.round(total * 100) / 100, results, blockers };
}

module.exports = { quote, quoteOrder, candidateRules, ruleMatches, costFor, SCOPE_RANK };
