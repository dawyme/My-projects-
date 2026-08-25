/**
 * Standard Supplier Interface.
 *
 * Every connector in this directory extends {@link SupplierConnector}. The rest
 * of the platform (products, inventory, pricing, orders, fulfillment, the sync
 * engine) only ever talks to this interface, so a new supplier — or a whole new
 * transport — can be added by dropping one file into `connectors/` and
 * registering it, without touching the core commerce system.
 *
 *     Supplier → SupplierIntegration (row) → SupplierAdapter (class)
 *              → Standard Supplier Interface (this file) → Platform
 *
 * A capability that a connector does not advertise is never called: the sync
 * engine, the fulfillment service and the Admin UI all check `supports()`
 * first and report honestly when something is unavailable.
 */

const CAPABILITIES = {
  connect: 'Establish and persist a session with the supplier',
  testConnection: 'Verify credentials and reachability without side effects',
  disconnect: 'Tear down / revoke the session',
  importCatalog: 'Pull the full product catalogue',
  syncProducts: 'Refresh product information and images',
  syncInventory: 'Refresh stock levels and availability',
  syncPricing: 'Refresh supplier cost and MSRP',
  submitOrder: 'Transmit a purchase order to the supplier',
  getOrderStatus: 'Poll the supplier for order state',
  getTracking: 'Retrieve tracking number and carrier',
  cancelOrder: 'Cancel a submitted purchase order',
};

const CAPABILITY_IDS = Object.keys(CAPABILITIES);

/** Reads `a.b[0].c` out of an object; returns undefined when the path is absent. */
function getPath(source, path) {
  if (!path) return source;
  return String(path).split('.').reduce((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    const match = key.match(/^([^\[\]]+)((?:\[\d+\])*)$/);
    if (!match) return acc?.[key];
    let value = acc[match[1]];
    if (match[2]) {
      for (const idx of match[2].match(/\d+/g) || []) value = value?.[Number(idx)];
    }
    return value;
  }, source);
}

const toNumber = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const toInt = (v) => {
  const n = toNumber(v);
  return n === null ? null : Math.trunc(n);
};

const toBool = (v) => {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'in stock', 'available'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'out of stock', 'unavailable'].includes(s)) return false;
  return null;
};

/** Splits a delimited string into an array, tolerating arrays and empties. */
const toList = (v, sep = '|') => {
  if (v === null || v === undefined || v === '') return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v).split(sep).map((x) => x.trim()).filter(Boolean);
};

/**
 * Normalises one raw feed record into the platform's canonical shape.
 * Shared by every connector so the sync engine sees one format.
 */
function normalizeRecord(raw, map = {}) {
  const pick = (field) => {
    const source = map[field];
    if (!source) return undefined;
    return getPath(raw, source);
  };
  const sku = pick('supplierSku');
  const record = {
    supplierSku: sku === undefined || sku === null ? null : String(sku).trim(),
    manufacturerPart: (() => { const v = pick('manufacturerPart'); return v === undefined || v === null || v === '' ? null : String(v).trim(); })(),
    upc: (() => { const v = pick('upc'); return v === undefined || v === null || v === '' ? null : String(v).trim(); })(),
    name: (() => { const v = pick('name'); return v === undefined || v === null ? null : String(v).trim(); })(),
    description: (() => { const v = pick('description'); return v === undefined || v === null || v === '' ? null : String(v).trim(); })(),
    brand: (() => { const v = pick('brand'); return v === undefined || v === null || v === '' ? null : String(v).trim(); })(),
    categoryText: (() => { const v = pick('category'); return v === undefined || v === null || v === '' ? null : String(v).trim(); })(),
    supplierCost: toNumber(pick('supplierCost')) ?? 0,
    msrp: toNumber(pick('msrp')),
    currency: (() => { const v = pick('currency'); return v === undefined || v === null || v === '' ? null : String(v).trim().toUpperCase(); })(),
    stock: toInt(pick('stock')) ?? 0,
    stockStatus: (() => { const v = pick('stockStatus'); return v === undefined || v === null || v === '' ? null : String(v).trim().toUpperCase(); })(),
    imageUrl: (() => { const v = pick('imageUrl'); return v === undefined || v === null || v === '' ? null : String(v).trim(); })(),
    gallery: toList(pick('gallery')),
    specs: (() => {
      const v = pick('specs');
      if (v === undefined || v === null || v === '') return null;
      if (typeof v === 'object' && !Array.isArray(v)) return v;
      try { const p = JSON.parse(v); return typeof p === 'object' ? p : null; } catch { return null; }
    })(),
    weightKg: toNumber(pick('weightKg')),
    lengthCm: toNumber(pick('lengthCm')),
    widthCm: toNumber(pick('widthCm')),
    heightCm: toNumber(pick('heightCm')),
    restricted: toBool(pick('restricted')) ?? false,
    restrictionType: (() => { const v = pick('restrictionType'); return v === undefined || v === null || v === '' ? null : String(v).trim().toUpperCase(); })(),
    restrictionNotes: (() => { const v = pick('restrictionNotes'); return v === undefined || v === null || v === '' ? null : String(v).trim(); })(),
    documentationRequired: toList(pick('documentationRequired')),
    allowedCountries: toList(pick('allowedCountries')).map((c) => c.toUpperCase()),
    blockedCountries: toList(pick('blockedCountries')).map((c) => c.toUpperCase()),
    allowedShippingMethods: toList(pick('allowedShippingMethods')).map((c) => c.toUpperCase()),
    raw,
  };
  return record;
}

class SupplierConnectorError extends Error {
  constructor(message, { code = 'CONNECTOR_ERROR', status, details } = {}) {
    super(message);
    this.name = 'SupplierConnectorError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** Raised when the capability exists but its prerequisites are missing. */
class NotConnectedError extends SupplierConnectorError {
  constructor(message = 'Not connected — credentials required') {
    super(message, { code: 'NOT_CONNECTED' });
    this.name = 'NotConnectedError';
  }
}

/** Raised when the runtime needed for a transport is not installed. */
class RuntimeUnavailableError extends SupplierConnectorError {
  constructor(message, remedy) {
    super(message, { code: 'RUNTIME_UNAVAILABLE' });
    this.name = 'RuntimeUnavailableError';
    this.remedy = remedy;
  }
}

class SupplierConnector {
  /** Unique connector id, referenced by SupplierIntegration.connectorType. */
  static id = 'base';
  static label = 'Base connector';
  static description = 'Abstract base — never registered directly.';
  /** Transport family shown in the Admin UI. */
  static transport = 'API'; // API | FILE | MANUAL
  static formats = [];
  static authTypes = ['NONE'];
  /** Capabilities the transport can *possibly* offer. */
  static capabilities = [];
  /** Secret fields the Admin UI collects (never echoed back). */
  static credentialFields = [];
  /** Non-secret configuration fields the Admin UI collects. */
  static configFields = [];
  /** Whether the connector needs credentials before it can be tested. */
  static requiresCredentials = false;

  constructor({ supplier, integration, secrets = {}, config = {}, settings = {} } = {}) {
    this.supplier = supplier || {};
    this.integration = integration || {};
    this.secrets = secrets || {};
    this.config = config || {};
    this.settings = settings || {};
    this.logger = () => {};
  }

  /** Capabilities actually available for THIS configuration. */
  capabilities() {
    return [...new Set(this.constructor.capabilities)].filter((c) => this.isConfiguredFor(c));
  }

  supports(capability) {
    return this.capabilities().includes(capability);
  }

  /** Subclasses narrow capabilities when the required endpoint isn't configured. */
  // eslint-disable-next-line no-unused-vars
  isConfiguredFor(capability) {
    return true;
  }

  /** True when the connector has everything it needs to talk to the supplier. */
  hasCredentials() {
    if (!this.constructor.requiresCredentials) return true;
    return this.constructor.credentialFields
      .filter((f) => f.required)
      .every((f) => Boolean(this.secrets?.[f.name]));
  }

  requireCredentials() {
    if (!this.hasCredentials()) throw new NotConnectedError();
  }

  /** Default header set; connectors add their own auth headers on top. */
  async headers() {
    return { Accept: 'application/json', 'User-Agent': 'NDS-SupplierMarketplace/1.0' };
  }

  /* ---- capability implementations (subclasses override what they offer) ---- */
  async connect() { throw new SupplierConnectorError('connect() is not supported by this connector', { code: 'UNSUPPORTED' }); }
  async testConnection() { throw new SupplierConnectorError('testConnection() is not supported by this connector', { code: 'UNSUPPORTED' }); }
  async disconnect() { return { ok: true, message: 'No persistent session to close.' }; }

  /**
   * Yields arrays of normalised catalogue records. Implementations MUST honour
   * `limit` and return the next `cursor` so the sync engine can batch, resume
   * and report progress without loading a whole catalogue into memory.
   * @returns {AsyncGenerator<{records:Array, cursor:string|null, done:boolean}>}
   */
  async *fetchCatalog() { throw new SupplierConnectorError('importCatalog is not supported by this connector', { code: 'UNSUPPORTED' }); }
  async *fetchInventory() { throw new SupplierConnectorError('syncInventory is not supported by this connector', { code: 'UNSUPPORTED' }); }
  async *fetchPricing() { throw new SupplierConnectorError('syncPricing is not supported by this connector', { code: 'UNSUPPORTED' }); }

  async submitOrder() { throw new SupplierConnectorError('submitOrder is not supported by this connector', { code: 'UNSUPPORTED' }); }
  async getOrderStatus() { throw new SupplierConnectorError('getOrderStatus is not supported by this connector', { code: 'UNSUPPORTED' }); }
  async getTracking() { throw new SupplierConnectorError('getTracking is not supported by this connector', { code: 'UNSUPPORTED' }); }
  async cancelOrder() { throw new SupplierConnectorError('cancelOrder is not supported by this connector', { code: 'UNSUPPORTED' }); }

  /** Browser-safe description used by the Integrations page. */
  static describe() {
    return {
      id: this.id,
      label: this.label,
      description: this.description,
      transport: this.transport,
      formats: this.formats,
      authTypes: this.authTypes,
      capabilities: CAPABILITY_IDS.map((id) => ({
        id, label: id, description: CAPABILITIES[id], supported: this.capabilities.includes(id),
      })),
      credentialFields: this.credentialFields,
      configFields: this.configFields,
      requiresCredentials: this.requiresCredentials,
    };
  }
}

module.exports = {
  SupplierConnector, SupplierConnectorError, NotConnectedError, RuntimeUnavailableError,
  CAPABILITIES, CAPABILITY_IDS,
  normalizeRecord, getPath, toNumber, toInt, toBool, toList,
};
