/**
 * Supplier Marketplace settings.
 *
 * Stored in the platform's existing `Setting` key/value table under the
 * `supplierMarketplace` key, so it participates in the same read/write,
 * caching and audit path as every other business setting.
 */
const prisma = require('../prisma');
const cache = require('../cache');

const KEY = 'supplierMarketplace';

const DEFAULTS = {
  // Pricing
  defaultMarkupType: 'PERCENT',   // PERCENT | FIXED
  defaultMarkupValue: 30,
  roundTo: null,                  // round computed prices to the nearest multiple (null = off)
  defaultCurrency: 'USD',
  fxRates: {},                    // { EUR: 1.08 } — rate INTO defaultCurrency. Absent = "not configured".
  // Catalogue behaviour
  autoCreateProducts: true,       // publishing creates the platform Product when none is mapped
  autoPublish: false,             // publish imported products without review
  defaultFulfillmentType: 'HYBRID',
  defaultCountry: 'TT',
  // Synchronisation
  autoSyncEnabled: false,         // master switch for the scheduler
  syncIntervalMinutes: 60,        // fallback interval when an integration has none
  batchSize: 100,                 // records per batch
  maxSyncAttempts: 3,
  syncConcurrency: 2,             // max simultaneous supplier syncs
  // Fulfilment
  autoFulfillOnPaid: true,        // raise supplier fulfilments as soon as an order is paid
  autoSubmitOrders: false,        // transmit purchase orders without operator confirmation
  defaultShippingMethod: 'STANDARD',
  // Restrictions
  blockedCountries: [],           // never sell to these, regardless of supplier config
  restrictUnmapped: true,         // block checkout for supplier-fulfilled items with no shipping quote
  // Permissions (extends, never replaces, the existing role system)
  permissions: {
    ADMIN: ['*'],
    STAFF: ['suppliers.view', 'imports.manage', 'sync.manage', 'fulfillment.manage'],
  },
  // Supplier type vocabulary — extensible without a code change
  supplierTypes: [
    'HVAC', 'REFRIGERATION', 'AUTOMOTIVE_AC', 'ELECTRICAL', 'PLUMBING',
    'APPLIANCE', 'GENERAL',
  ],
  // Shipping method vocabulary used across suppliers
  shippingMethods: [
    { code: 'STANDARD', name: 'Standard shipping' },
    { code: 'EXPRESS', name: 'Express shipping' },
    { code: 'FREIGHT', name: 'Freight / pallet' },
    { code: 'LOCAL_DELIVERY', name: 'Local delivery' },
    { code: 'PICKUP', name: 'Customer pickup' },
    { code: 'HAZMAT_GROUND', name: 'Restricted goods — ground only' },
  ],
  // Restriction vocabulary (labels only — no legal meaning is implied)
  restrictionTypes: [
    'REFRIGERANT', 'PRESSURISED', 'FLAMMABLE', 'CORROSIVE', 'BATTERY', 'HAZMAT', 'CUSTOM',
  ],
};

let cached = null;

async function read() {
  if (cached) return cached;
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  let stored = {};
  if (row) {
    try { stored = JSON.parse(row.value); } catch { stored = {}; }
  }
  cached = {
    ...DEFAULTS,
    ...stored,
    permissions: { ...DEFAULTS.permissions, ...(stored.permissions || {}) },
    fxRates: { ...DEFAULTS.fxRates, ...(stored.fxRates || {}) },
  };
  return cached;
}

function invalidate() {
  cached = null;
  cache.invalidate('supplier');
}

/** Merges a partial patch into the stored settings. */
async function write(patch = {}) {
  const current = await read();
  const next = {
    ...current,
    ...patch,
    permissions: patch.permissions ? { ...current.permissions, ...patch.permissions } : current.permissions,
    fxRates: patch.fxRates !== undefined ? patch.fxRates : current.fxRates,
  };
  delete next.permissions['*'];
  await prisma.setting.upsert({
    where: { key: KEY },
    update: { value: JSON.stringify(next) },
    create: { key: KEY, value: JSON.stringify(next) },
  });
  invalidate();
  return next;
}

/** The global markup rule expressed as a SupplierMarkupRule-shaped object. */
async function globalMarkupRule() {
  const s = await read();
  return {
    id: 'global',
    scope: 'GLOBAL',
    markupType: s.defaultMarkupType,
    markupValue: Number(s.defaultMarkupValue) || 0,
    roundTo: s.roundTo || null,
    isActive: true,
  };
}

/**
 * Converts an amount in `from` into the platform's default currency.
 * Returns null when no rate is configured — callers must surface that rather
 * than silently assuming parity.
 */
async function convert(amount, from, to) {
  const settings = await read();
  const target = (to || settings.defaultCurrency || 'USD').toUpperCase();
  const source = (from || target).toUpperCase();
  if (source === target) return { amount: Number(amount) || 0, rate: 1, configured: true };
  const rate = Number(settings.fxRates?.[source]);
  if (!Number.isFinite(rate) || rate <= 0) return { amount: null, rate: null, configured: false };
  return { amount: Math.round((Number(amount) || 0) * rate * 100) / 100, rate, configured: true };
}

module.exports = { DEFAULTS, read, write, invalidate, globalMarkupRule, convert, KEY };
