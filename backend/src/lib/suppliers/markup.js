/**
 * Markup / pricing engine.
 *
 * Supplier cost and customer selling price are always kept apart. A price is
 * derived from the *first* matching rule in this precedence order:
 *
 *     PRODUCT  →  CATEGORY  →  SUPPLIER  →  GLOBAL  →  (no rule ⇒ cost passthrough)
 *
 * A product-level `priceOverride` short-circuits the engine entirely: the
 * operator has pinned the number by hand and no rule may move it.
 *
 * Nothing here talks to the database — pass in the rules and you get a
 * deterministic answer, which keeps it unit-testable.
 */

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Rounds to the nearest multiple of `step` (0.05, 0.5, 1, 5, 10 …). */
function roundToMultiple(value, step) {
  const s = Number(step);
  if (!s || s <= 0 || !Number.isFinite(s)) return round2(value);
  return round2(Math.round(value / s) * s);
}

/**
 * Applies a single markup rule to a cost.
 *   PERCENT: cost × (1 + value/100)     — 100 @ 30% ⇒ 130
 *   FIXED:   cost + value               — 100 + 25  ⇒ 125
 */
function applyMarkup(cost, { markupType = 'PERCENT', markupValue = 0, roundTo } = {}) {
  const base = Math.max(0, Number(cost) || 0);
  const amount = Number(markupValue) || 0;
  const raw = markupType === 'FIXED' ? base + amount : base * (1 + amount / 100);
  const price = roundTo ? roundToMultiple(raw, roundTo) : round2(raw);
  return Math.max(0, price);
}

/**
 * Picks the winning rule for a supplier product.
 * @param {object} ctx
 * @param {object} ctx.supplierProduct  row (or a partial with the override fields)
 * @param {object} ctx.supplier         supplier row
 * @param {Array}  ctx.categoryRules    SupplierMarkupRule rows with scope CATEGORY
 * @param {object} ctx.globalRule       SupplierMarkupRule row with scope GLOBAL (or null)
 */
function resolveRule({ supplierProduct = {}, supplier = {}, categoryRules = [], globalRule = null } = {}) {
  if (supplierProduct.markupOverrideValue !== null && supplierProduct.markupOverrideValue !== undefined
      && supplierProduct.markupOverrideType) {
    return {
      scope: 'PRODUCT', type: supplierProduct.markupOverrideType,
      value: Number(supplierProduct.markupOverrideValue), roundTo: null,
      source: `Product override (${supplierProduct.supplierSku || supplierProduct.id || ''})`.trim(),
    };
  }

  const categoryId = supplierProduct.categoryId;
  if (categoryId) {
    const match = (categoryRules || [])
      .filter((r) => r.isActive !== false && r.scope === 'CATEGORY' && r.categoryId === categoryId)
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))[0];
    if (match) {
      return {
        scope: 'CATEGORY', type: match.markupType, value: Number(match.markupValue),
        roundTo: match.roundTo || null, source: `Category rule ${match.id}`,
      };
    }
  }

  if (supplier?.markupValue !== null && supplier?.markupValue !== undefined && supplier?.markupType) {
    return {
      scope: 'SUPPLIER', type: supplier.markupType, value: Number(supplier.markupValue),
      roundTo: null, source: `Supplier ${supplier.name || supplier.id}`,
    };
  }

  if (globalRule && globalRule.isActive !== false) {
    return {
      scope: 'GLOBAL', type: globalRule.markupType, value: Number(globalRule.markupValue),
      roundTo: globalRule.roundTo || null, source: 'Global default',
    };
  }

  return { scope: 'NONE', type: 'PERCENT', value: 0, roundTo: null, source: 'No markup rule — cost passthrough' };
}

/**
 * Full price calculation for one supplier product.
 * @returns {{cost:number, price:number, rule:object, overridden:boolean,
 *            margin:number, marginPercent:number, currency:string}}
 */
function priceFor(ctx = {}) {
  const supplierProduct = ctx.supplierProduct || {};
  const rule = resolveRule(ctx);
  const cost = round2(supplierProduct.supplierCost || 0);
  const overridden = supplierProduct.priceOverride !== null && supplierProduct.priceOverride !== undefined;
  // resolveRule() returns {type, value}; applyMarkup() takes {markupType, markupValue}.
  const price = overridden
    ? round2(supplierProduct.priceOverride)
    : applyMarkup(cost, { markupType: rule.type, markupValue: rule.value, roundTo: rule.roundTo });
  const margin = round2(price - cost);
  return {
    cost,
    price,
    rule,
    overridden,
    margin,
    marginPercent: price > 0 ? round2((margin / price) * 100) : 0,
    currency: supplierProduct.currency || ctx.supplier?.currency || 'USD',
  };
}

/** Batch version keyed by supplierProduct id — used by the sync engine. */
function priceMany(supplierProducts, ctx = {}) {
  return supplierProducts.map((sp) => ({
    id: sp.id,
    supplierSku: sp.supplierSku,
    ...priceFor({
      supplierProduct: sp,
      supplier: ctx.suppliers?.[sp.supplierId] || ctx.supplier || {},
      categoryRules: sp.categoryId ? (ctx.categoryRulesByCategory?.[sp.categoryId] || ctx.categoryRules || []) : [],
      globalRule: ctx.globalRule ?? null,
    }),
  }));
}

/** Human-readable explanation for the price-preview UI. */
function explain(result) {
  const { cost, price, rule, overridden } = result;
  if (overridden) return `Manual override — ${cost.toFixed(2)} cost, price pinned to ${price.toFixed(2)}.`;
  if (rule.scope === 'NONE') return `No markup rule matched — selling at supplier cost (${cost.toFixed(2)}).`;
  const detail = rule.type === 'FIXED'
    ? `+${Number(rule.value).toFixed(2)} fixed`
    : `+${Number(rule.value).toFixed(1)}%`;
  return `${rule.scope} rule (${rule.source}): ${cost.toFixed(2)} ${detail} ⇒ ${price.toFixed(2)}`;
}

module.exports = { applyMarkup, resolveRule, priceFor, priceMany, roundToMultiple, round2, explain };
