/**
 * REST / JSON supplier connector.
 *
 * Fully configuration-driven: nothing about any particular supplier is
 * hard-coded. An administrator supplies the base URL, the endpoint paths, the
 * JSON path to the item array and a column map, and this adapter turns that
 * into the standard supplier interface.
 *
 * Supported auth: NONE | API_KEY (header or query) | BASIC | BEARER | OAUTH2
 * (client-credentials flow with in-memory token caching).
 */
const {
  SupplierConnector, SupplierConnectorError, NotConnectedError,
  normalizeRecord, getPath,
} = require('./base');
const { httpRequest, buildUrl, assertPublicUrl } = require('../http');
const { redactString } = require('../credentials');

const COLUMN_MAP_DEFAULT = {
  supplierSku: 'sku', name: 'name', description: 'description', brand: 'brand',
  category: 'category', supplierCost: 'cost', msrp: 'msrp', currency: 'currency',
  stock: 'stock', stockStatus: 'stockStatus', imageUrl: 'imageUrl', gallery: 'gallery',
  specs: 'specs', weightKg: 'weightKg', lengthCm: 'lengthCm', widthCm: 'widthCm', heightCm: 'heightCm',
  manufacturerPart: 'mpn', upc: 'upc', restricted: 'restricted', restrictionType: 'restrictionType',
  allowedCountries: 'allowedCountries', blockedCountries: 'blockedCountries',
};

class RestJsonConnector extends SupplierConnector {
  static id = 'REST_JSON';
  static label = 'REST / JSON API';
  static description = 'Any supplier exposing a JSON REST API. Endpoints, pagination and field mapping are configured per integration — no code changes needed.';
  static transport = 'API';
  static formats = ['JSON'];
  static authTypes = ['NONE', 'API_KEY', 'BASIC', 'BEARER', 'OAUTH2'];
  static capabilities = [
    'connect', 'testConnection', 'disconnect',
    'importCatalog', 'syncProducts', 'syncInventory', 'syncPricing',
    'submitOrder', 'getOrderStatus', 'getTracking', 'cancelOrder',
  ];
  static requiresCredentials = false;
  static credentialFields = [
    { name: 'apiKey', label: 'API key', type: 'secret', authTypes: ['API_KEY'] },
    { name: 'apiSecret', label: 'API secret', type: 'secret', authTypes: ['API_KEY'] },
    { name: 'username', label: 'Username', type: 'text', authTypes: ['BASIC'] },
    { name: 'password', label: 'Password', type: 'secret', authTypes: ['BASIC'] },
    { name: 'accessToken', label: 'Access token', type: 'secret', authTypes: ['BEARER'] },
    { name: 'refreshToken', label: 'Refresh token', type: 'secret', authTypes: ['BEARER'] },
    { name: 'clientId', label: 'OAuth client ID', type: 'text', authTypes: ['OAUTH2'] },
    { name: 'clientSecret', label: 'OAuth client secret', type: 'secret', authTypes: ['OAUTH2'] },
  ];
  static configFields = [
    { name: 'baseUrl', label: 'Base URL', type: 'url', required: true, help: 'e.g. https://api.supplier.com/v2' },
    { name: 'apiKeyHeader', label: 'API key header', type: 'text', help: 'Default: X-Api-Key', group: 'Authentication' },
    { name: 'apiKeyInQuery', label: 'Send API key as a query parameter', type: 'boolean', group: 'Authentication' },
    { name: 'apiKeyQueryName', label: 'API key query name', type: 'text', help: 'Default: api_key', group: 'Authentication' },
    { name: 'oauthTokenUrl', label: 'OAuth token URL', type: 'url', group: 'Authentication' },
    { name: 'oauthScope', label: 'OAuth scope', type: 'text', group: 'Authentication' },
    { name: 'testPath', label: 'Connection test path', type: 'text', help: 'Cheap endpoint used by Test connection (default: catalog path)', group: 'Authentication' },
    { name: 'catalogPath', label: 'Catalogue endpoint', type: 'text', required: true, help: 'e.g. /products', group: 'Catalogue' },
    { name: 'catalogQuery', label: 'Catalogue query string', type: 'text', help: 'e.g. active=true&fields=sku,name', group: 'Catalogue' },
    { name: 'itemsPath', label: 'JSON path to items', type: 'text', help: 'e.g. data.products', group: 'Catalogue' },
    { name: 'pagination', label: 'Pagination', type: 'select', options: ['none', 'page', 'offset', 'cursor'], group: 'Catalogue' },
    { name: 'pageParam', label: 'Page parameter', type: 'text', help: 'Default: page', group: 'Catalogue' },
    { name: 'limitParam', label: 'Page size parameter', type: 'text', help: 'Default: limit', group: 'Catalogue' },
    { name: 'cursorPath', label: 'JSON path to next cursor', type: 'text', help: 'e.g. meta.next_cursor', group: 'Catalogue' },
    { name: 'cursorParam', label: 'Cursor parameter', type: 'text', help: 'Default: cursor', group: 'Catalogue' },
    { name: 'maxPages', label: 'Maximum pages per run', type: 'number', help: 'Default: 200', group: 'Catalogue' },
    { name: 'inventoryPath', label: 'Inventory endpoint', type: 'text', group: 'Sync' },
    { name: 'inventoryItemsPath', label: 'Inventory items path', type: 'text', group: 'Sync' },
    { name: 'pricingPath', label: 'Pricing endpoint', type: 'text', group: 'Sync' },
    { name: 'pricingItemsPath', label: 'Pricing items path', type: 'text', group: 'Sync' },
    { name: 'orderPath', label: 'Order submission endpoint', type: 'text', group: 'Orders' },
    { name: 'orderMethod', label: 'Order HTTP method', type: 'select', options: ['POST', 'PUT'], group: 'Orders' },
    { name: 'statusPath', label: 'Order status endpoint', type: 'text', help: 'Use {id} for the supplier order id', group: 'Orders' },
    { name: 'trackingPath', label: 'Tracking endpoint', type: 'text', help: 'Use {id} for the supplier order id', group: 'Orders' },
    { name: 'cancelPath', label: 'Cancel endpoint', type: 'text', help: 'Use {id} for the supplier order id', group: 'Orders' },
    { name: 'cancelMethod', label: 'Cancel HTTP method', type: 'select', options: ['POST', 'DELETE', 'PUT'], group: 'Orders' },
    { name: 'columnMap', label: 'Field mapping', type: 'map', group: 'Field mapping', help: 'Map supplier JSON fields to platform fields' },
  ];

  constructor(options) {
    super(options);
    this.columnMap = { ...COLUMN_MAP_DEFAULT, ...(this.config.columnMap || {}) };
    this.tokenCache = null;
  }

  get baseUrl() {
    const url = this.config.baseUrl || this.integration.baseUrl;
    if (!url) throw new SupplierConnectorError('No base URL configured for this integration', { code: 'NOT_CONFIGURED' });
    return assertPublicUrl(url);
  }

  get secretsList() {
    return Object.values(this.secrets || {}).filter(Boolean).map(String);
  }

  isConfiguredFor(capability) {
    const c = this.config || {};
    switch (capability) {
      case 'syncInventory': return Boolean(c.inventoryPath);
      case 'syncPricing': return Boolean(c.pricingPath);
      case 'submitOrder': return Boolean(c.orderPath);
      case 'getOrderStatus': return Boolean(c.statusPath);
      case 'getTracking': return Boolean(c.trackingPath);
      case 'cancelOrder': return Boolean(c.cancelPath);
      default: return true;
    }
  }

  hasCredentials() {
    switch (this.integration.authType || this.config.authType || 'NONE') {
      case 'API_KEY': return Boolean(this.secrets.apiKey);
      case 'BASIC': return Boolean(this.secrets.username && this.secrets.password);
      case 'BEARER': return Boolean(this.secrets.accessToken);
      case 'OAUTH2': return Boolean(this.secrets.clientId && this.secrets.clientSecret);
      default: return true;
    }
  }

  /** Fetches (and caches) an OAuth2 client-credentials access token. */
  async oauthToken() {
    const authType = this.integration.authType || 'OAUTH2';
    if (authType !== 'OAUTH2') return null;
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 30000) return this.tokenCache.accessToken;
    const tokenUrl = this.config.oauthTokenUrl;
    if (!tokenUrl) throw new SupplierConnectorError('OAuth token URL is not configured', { code: 'NOT_CONFIGURED' });
    const res = await httpRequest(assertPublicUrl(tokenUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.secrets.clientId,
        client_secret: this.secrets.clientSecret,
        ...(this.config.oauthScope ? { scope: this.config.oauthScope } : {}),
      }).toString(),
      secrets: this.secretsList,
    });
    const payload = res.json || {};
    const accessToken = payload.access_token || payload.accessToken || payload.token;
    if (!accessToken) throw new SupplierConnectorError('OAuth token response did not contain an access token', { code: 'AUTH_FAILED' });
    this.tokenCache = {
      accessToken,
      expiresAt: Date.now() + (Number(payload.expires_in || 3600) * 1000),
      refreshToken: payload.refresh_token || null,
    };
    return accessToken;
  }

  async headers(extra = {}) {
    const authType = this.integration.authType || this.config.authType || 'NONE';
    const headers = {
      Accept: 'application/json',
      'User-Agent': 'NDS-SupplierMarketplace/1.0',
      ...(this.config.headers || {}),
      ...extra,
    };
    switch (authType) {
      case 'API_KEY': {
        if (!this.secrets.apiKey) throw new NotConnectedError();
        if (this.config.apiKeyInQuery) break; // handled in queryFor()
        headers[this.config.apiKeyHeader || 'X-Api-Key'] = this.secrets.apiKey;
        if (this.secrets.apiSecret) headers[this.config.apiSecretHeader || 'X-Api-Secret'] = this.secrets.apiSecret;
        break;
      }
      case 'BASIC': {
        if (!this.secrets.username) throw new NotConnectedError();
        headers.Authorization = `Basic ${Buffer.from(`${this.secrets.username}:${this.secrets.password || ''}`).toString('base64')}`;
        break;
      }
      case 'BEARER': {
        if (!this.secrets.accessToken) throw new NotConnectedError();
        headers.Authorization = `Bearer ${this.secrets.accessToken}`;
        break;
      }
      case 'OAUTH2': {
        const token = await this.oauthToken();
        headers.Authorization = `Bearer ${token}`;
        break;
      }
      default: break;
    }
    return headers;
  }

  queryFor(extra = {}) {
    const query = { ...extra };
    if ((this.integration.authType || this.config.authType) === 'API_KEY' && this.config.apiKeyInQuery) {
      query[this.config.apiKeyQueryName || 'api_key'] = this.secrets.apiKey;
    }
    for (const [k, v] of new URLSearchParams(this.config.catalogQuery || '')) {
      if (query[k] === undefined) query[k] = v;
    }
    return query;
  }

  async connect() {
    this.requireCredentials();
    if ((this.integration.authType || this.config.authType) === 'OAUTH2') {
      await this.oauthToken();
      return { ok: true, message: 'OAuth token acquired.', session: 'oauth2-client-credentials' };
    }
    const result = await this.testConnection();
    return { ok: result.ok, message: result.message };
  }

  async testConnection() {
    this.requireCredentials();
    const path = this.config.testPath || this.config.catalogPath;
    if (!path) {
      throw new SupplierConnectorError('Configure a catalogue endpoint before testing the connection', { code: 'NOT_CONFIGURED' });
    }
    const started = Date.now();
    const res = await httpRequest(buildUrl(this.baseUrl, path, this.queryFor({ [this.config.limitParam || 'limit']: 1 })), {
      headers: await this.headers(),
      timeoutMs: Number(this.config.timeoutMs || 20000),
      retries: 0,
      secrets: this.secretsList,
    });
    const items = this.extractItems(res.json, this.config.itemsPath);
    return {
      ok: true,
      status: res.status,
      latencyMs: Date.now() - started,
      message: `Connected — HTTP ${res.status} in ${Date.now() - started}ms${items ? `, items array resolved (${items.length} sample)` : ''}.`,
    };
  }

  async disconnect() {
    this.tokenCache = null;
    return { ok: true, message: 'Cached OAuth token discarded.' };
  }

  extractItems(payload, itemsPath) {
    if (payload === null || payload === undefined) return null;
    if (itemsPath) {
      const found = getPath(payload, itemsPath);
      if (Array.isArray(found)) return found;
      if (found && typeof found === 'object') return [found];
      return null;
    }
    if (Array.isArray(payload)) return payload;
    // Common shapes: {data:[…]}, {items:[…]}, {results:[…]}
    for (const key of ['data', 'items', 'results', 'products', 'records', 'rows']) {
      if (Array.isArray(payload[key])) return payload[key];
      if (payload[key] && typeof payload[key] === 'object') {
        for (const inner of ['items', 'results', 'products', 'records', 'rows']) {
          if (Array.isArray(payload[key][inner])) return payload[key][inner];
        }
      }
    }
    return null;
  }

  /**
   * Pages through a configured endpoint, yielding normalised records.
   * @returns {AsyncGenerator<{records:Array,cursor:string|null,done:boolean,page:number}>}
   */
  async *fetchFrom({ path, itemsPath, columnMap, cursor = null, limit = 100, maxPages = 200, extraQuery = {} }) {
    this.requireCredentials();
    if (!path) throw new SupplierConnectorError('Endpoint path is not configured', { code: 'NOT_CONFIGURED' });
    const mode = this.config.pagination || 'none';
    const pageParam = this.config.pageParam || 'page';
    const limitParam = this.config.limitParam || 'limit';
    const cursorParam = this.config.cursorParam || 'cursor';
    let page = Number(cursor && mode === 'page' ? cursor : 1);
    let offset = Number(cursor && mode === 'offset' ? cursor : 0);
    let nextCursor = cursor && mode === 'cursor' ? cursor : null;
    let pages = 0;

    while (pages < maxPages) {
      pages++;
      const query = this.queryFor({ ...extraQuery, [limitParam]: limit });
      if (mode === 'page') query[pageParam] = page;
      if (mode === 'offset') query[limitParam] = limit;
      if (mode === 'cursor' && nextCursor) query[cursorParam] = nextCursor;

      const res = await httpRequest(buildUrl(this.baseUrl, path, query), {
        headers: await this.headers(),
        timeoutMs: Number(this.config.timeoutMs || 30000),
        secrets: this.secretsList,
      });
      const items = this.extractItems(res.json, itemsPath);
      if (items === null) {
        throw new SupplierConnectorError(
          `Could not locate the item array in the response${itemsPath ? ` at "${itemsPath}"` : ''}. Check the "JSON path to items" setting.`,
          { code: 'BAD_SHAPE' }
        );
      }
      const records = items.map((raw) => normalizeRecord(raw, columnMap));

      let following = null;
      if (mode === 'page') following = items.length >= limit ? String(page + 1) : null;
      else if (mode === 'offset') following = items.length >= limit ? String(offset + items.length) : null;
      else if (mode === 'cursor') following = this.config.cursorPath ? (getPath(res.json, this.config.cursorPath) || null) : null;

      yield {
        records,
        page,
        cursor: following ? String(following) : null,
        done: !following || items.length === 0,
      };

      if (!following || items.length === 0) return;
      page = Number(following) || page + 1;
      offset = Number(following) || offset;
      nextCursor = mode === 'cursor' ? String(following) : null;
    }
  }

  fetchCatalog({ cursor = null, limit = 100 } = {}) {
    return this.fetchFrom({
      path: this.config.catalogPath,
      itemsPath: this.config.itemsPath,
      columnMap: this.columnMap,
      cursor, limit,
      maxPages: Number(this.config.maxPages || 200),
    });
  }

  fetchInventory({ cursor = null, limit = 100 } = {}) {
    return this.fetchFrom({
      path: this.config.inventoryPath,
      itemsPath: this.config.inventoryItemsPath || this.config.itemsPath,
      columnMap: this.columnMap,
      cursor, limit,
      maxPages: Number(this.config.maxPages || 200),
    });
  }

  fetchPricing({ cursor = null, limit = 100 } = {}) {
    return this.fetchFrom({
      path: this.config.pricingPath,
      itemsPath: this.config.pricingItemsPath || this.config.itemsPath,
      columnMap: this.columnMap,
      cursor, limit,
      maxPages: Number(this.config.maxPages || 200),
    });
  }

  /**
   * Transmits a purchase order. Only called when `orderPath` is configured, so
   * a "submitted" status always reflects a real HTTP round trip.
   */
  async submitOrder(payload) {
    this.requireCredentials();
    if (!this.config.orderPath) throw new NotConnectedError('Order submission endpoint is not configured');
    const body = {
      order: {
        reference: payload.reference,
        currency: payload.currency,
        shippingMethod: payload.shippingMethod,
        shipTo: payload.shipTo,
        items: (payload.items || []).map((i) => ({
          sku: i.supplierSku, quantity: i.quantity, unitCost: i.unitCost,
        })),
      },
      ...(this.config.orderExtraBody || {}),
    };
    const res = await httpRequest(buildUrl(this.baseUrl, this.config.orderPath), {
      method: this.config.orderMethod || 'POST',
      headers: await this.headers({ 'Content-Type': 'application/json' }),
      body,
      secrets: this.secretsList,
    });
    const data = res.json || {};
    const supplierOrderId = data.id || data.orderId || data.order_id || getPath(data, this.config.orderIdPath || 'id') || null;
    return {
      ok: true,
      status: res.status,
      supplierOrderId: supplierOrderId ? String(supplierOrderId) : null,
      reference: res.headers.get('x-order-reference') || null,
      raw: data,
      message: supplierOrderId ? `Supplier accepted order ${supplierOrderId}` : `Supplier accepted the order (HTTP ${res.status})`,
    };
  }

  async getOrderStatus(supplierOrderId) {
    this.requireCredentials();
    if (!this.config.statusPath) throw new SupplierConnectorError('Order status endpoint is not configured', { code: 'NOT_CONFIGURED' });
    const res = await httpRequest(buildUrl(this.baseUrl, this.config.statusPath.replace('{id}', encodeURIComponent(supplierOrderId))), {
      headers: await this.headers(), secrets: this.secretsList,
    });
    const data = res.json || {};
    const raw = String(getPath(data, this.config.statusField || 'status') || '').toUpperCase();
    return { raw, status: mapSupplierStatus(raw), supplierOrderId, data };
  }

  async getTracking(supplierOrderId) {
    this.requireCredentials();
    if (!this.config.trackingPath) throw new SupplierConnectorError('Tracking endpoint is not configured', { code: 'NOT_CONFIGURED' });
    const res = await httpRequest(buildUrl(this.baseUrl, this.config.trackingPath.replace('{id}', encodeURIComponent(supplierOrderId))), {
      headers: await this.headers(), secrets: this.secretsList,
    });
    const data = res.json || {};
    return {
      trackingNumber: getPath(data, this.config.trackingNumberPath || 'trackingNumber') || null,
      carrier: getPath(data, this.config.carrierPath || 'carrier') || null,
      trackingUrl: getPath(data, this.config.trackingUrlPath || 'trackingUrl') || null,
      status: mapSupplierStatus(String(getPath(data, this.config.statusField || 'status') || '')),
      data,
    };
  }

  async cancelOrder(supplierOrderId, reason) {
    this.requireCredentials();
    if (!this.config.cancelPath) throw new SupplierConnectorError('Cancel endpoint is not configured', { code: 'NOT_CONFIGURED' });
    const res = await httpRequest(buildUrl(this.baseUrl, this.config.cancelPath.replace('{id}', encodeURIComponent(supplierOrderId))), {
      method: this.config.cancelMethod || 'POST',
      headers: await this.headers({ 'Content-Type': 'application/json' }),
      body: { reason: reason || 'Cancelled by merchant' },
      secrets: this.secretsList,
    });
    return { ok: true, status: res.status, data: res.json || {}, message: `Cancel request accepted (HTTP ${res.status})` };
  }
}

/** Best-effort mapping from arbitrary supplier status text to our lifecycle. */
const STATUS_WORDS = [
  [/CANCEL|VOID|REJECT/i, 'CANCELLED'],
  [/DELIVER|COMPLETE|CLOSED/i, 'DELIVERED'],
  [/SHIP|DISPATCH|IN_TRANSIT|TRACK/i, 'SHIPPED'],
  [/PARTIAL/i, 'PARTIALLY_SHIPPED'],
  [/PROCESS|PACK|PREPAR|WORK/i, 'PROCESSING'],
  [/ACCEPT|CONFIRM|APPROV/i, 'ACCEPTED'],
  [/FAIL|ERROR/i, 'FAILED'],
  [/READY/i, 'READY'],
  [/SUBMIT|SENT|PLACED/i, 'SUBMITTED'],
  [/PEND|NEW|OPEN/i, 'PENDING'],
];

function mapSupplierStatus(raw) {
  const value = String(raw || '').toUpperCase();
  for (const [re, mapped] of STATUS_WORDS) if (re.test(value)) return mapped;
  return value || null;
}

module.exports = { RestJsonConnector, mapSupplierStatus, COLUMN_MAP_DEFAULT };
