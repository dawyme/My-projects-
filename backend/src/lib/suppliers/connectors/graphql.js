/**
 * GraphQL supplier connector.
 *
 * The administrator pastes the supplier's query; the adapter executes it,
 * follows `itemsPath` to the item array and normalises each record with the
 * same column map used by the REST connector.
 */
const { SupplierConnector, SupplierConnectorError, normalizeRecord, getPath } = require('./base');
const { httpRequest, assertPublicUrl } = require('../http');
const { COLUMN_MAP_DEFAULT } = require('./rest-json');

class GraphQlConnector extends SupplierConnector {
  static id = 'GRAPHQL';
  static label = 'GraphQL API';
  static description = 'For suppliers exposing a GraphQL endpoint. Paste the catalogue/inventory/pricing queries and map the response fields.';
  static transport = 'API';
  static formats = ['GraphQL', 'JSON'];
  static authTypes = ['NONE', 'API_KEY', 'BEARER', 'OAUTH2'];
  static capabilities = ['connect', 'testConnection', 'disconnect', 'importCatalog', 'syncProducts', 'syncInventory', 'syncPricing'];
  static credentialFields = [
    { name: 'apiKey', label: 'API key', type: 'secret', authTypes: ['API_KEY'] },
    { name: 'accessToken', label: 'Access token', type: 'secret', authTypes: ['BEARER'] },
    { name: 'clientId', label: 'OAuth client ID', type: 'text', authTypes: ['OAUTH2'] },
    { name: 'clientSecret', label: 'OAuth client secret', type: 'secret', authTypes: ['OAUTH2'] },
  ];
  static configFields = [
    { name: 'baseUrl', label: 'GraphQL endpoint', type: 'url', required: true, help: 'e.g. https://api.supplier.com/graphql' },
    { name: 'apiKeyHeader', label: 'API key header', type: 'text', help: 'Default: X-Api-Key', group: 'Authentication' },
    { name: 'catalogQuery', label: 'Catalogue query', type: 'textarea', required: true, group: 'Queries', help: 'GraphQL query returning the product array' },
    { name: 'catalogVariables', label: 'Catalogue variables (JSON)', type: 'json', group: 'Queries' },
    { name: 'inventoryQuery', label: 'Inventory query', type: 'textarea', group: 'Queries' },
    { name: 'pricingQuery', label: 'Pricing query', type: 'textarea', group: 'Queries' },
    { name: 'itemsPath', label: 'JSON path to items', type: 'text', help: 'e.g. data.products.edges', group: 'Queries' },
    { name: 'columnMap', label: 'Field mapping', type: 'map', group: 'Field mapping' },
  ];

  constructor(options) {
    super(options);
    this.columnMap = { ...COLUMN_MAP_DEFAULT, ...(this.config.columnMap || {}) };
  }

  get secretsList() { return Object.values(this.secrets || {}).filter(Boolean).map(String); }

  isConfiguredFor(capability) {
    if (capability === 'syncInventory') return Boolean(this.config.inventoryQuery);
    if (capability === 'syncPricing') return Boolean(this.config.pricingQuery);
    return true;
  }

  hasCredentials() {
    switch (this.integration.authType || 'NONE') {
      case 'API_KEY': return Boolean(this.secrets.apiKey);
      case 'BEARER': return Boolean(this.secrets.accessToken);
      case 'OAUTH2': return Boolean(this.secrets.clientId && this.secrets.clientSecret);
      default: return true;
    }
  }

  get endpoint() {
    const url = this.config.baseUrl || this.integration.baseUrl;
    if (!url) throw new SupplierConnectorError('No GraphQL endpoint configured', { code: 'NOT_CONFIGURED' });
    return assertPublicUrl(url);
  }

  async headers() {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'NDS-SupplierMarketplace/1.0' };
    switch (this.integration.authType || 'NONE') {
      case 'API_KEY':
        if (!this.secrets.apiKey) throw new SupplierConnectorError('Not connected — credentials required', { code: 'NOT_CONNECTED' });
        headers[this.config.apiKeyHeader || 'X-Api-Key'] = this.secrets.apiKey;
        break;
      case 'BEARER':
        if (!this.secrets.accessToken) throw new SupplierConnectorError('Not connected — credentials required', { code: 'NOT_CONNECTED' });
        headers.Authorization = `Bearer ${this.secrets.accessToken}`;
        break;
      case 'OAUTH2':
        throw new SupplierConnectorError('OAuth2 token exchange is not configured for this GraphQL integration — use an access token instead', { code: 'NOT_CONFIGURED' });
      default: break;
    }
    return headers;
  }

  parseVariables(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch { throw new SupplierConnectorError('Catalogue variables must be valid JSON', { code: 'BAD_CONFIG' }); }
  }

  async execute(query, variables = {}) {
    this.requireCredentials();
    if (!query) throw new SupplierConnectorError('No query configured', { code: 'NOT_CONFIGURED' });
    const res = await httpRequest(this.endpoint, {
      method: 'POST',
      headers: await this.headers(),
      body: { query, variables },
      secrets: this.secretsList,
    });
    const payload = res.json || {};
    if (Array.isArray(payload.errors) && payload.errors.length) {
      throw new SupplierConnectorError(`GraphQL error: ${payload.errors.map((e) => e.message).join('; ').slice(0, 300)}`, { code: 'GRAPHQL_ERROR' });
    }
    return payload;
  }

  extract(payload) {
    const itemsPath = this.config.itemsPath;
    if (!itemsPath) throw new SupplierConnectorError('Configure the "JSON path to items" for this GraphQL feed', { code: 'NOT_CONFIGURED' });
    const found = getPath(payload, itemsPath);
    if (!Array.isArray(found)) {
      throw new SupplierConnectorError(`No item array found at "${itemsPath}"`, { code: 'BAD_SHAPE' });
    }
    return found;
  }

  async connect() {
    this.requireCredentials();
    const r = await this.testConnection();
    return { ok: r.ok, message: r.message };
  }

  async testConnection() {
    this.requireCredentials();
    const started = Date.now();
    const res = await httpRequest(this.endpoint, {
      method: 'POST',
      headers: await this.headers(),
      body: { query: '{ __typename }' },
      retries: 0,
      secrets: this.secretsList,
    });
    return { ok: true, status: res.status, latencyMs: Date.now() - started, message: `GraphQL endpoint reachable — HTTP ${res.status} in ${Date.now() - started}ms.` };
  }

  async *fetchCatalog({ limit = 500 } = {}) {
    const payload = await this.execute(this.config.catalogQuery, { ...this.parseVariables(this.config.catalogVariables), limit });
    const items = this.extract(payload);
    yield { records: items.map((raw) => normalizeRecord(raw, this.columnMap)), page: 1, cursor: null, done: true };
  }

  async *fetchInventory({ limit = 500 } = {}) {
    const payload = await this.execute(this.config.inventoryQuery, { limit });
    yield { records: this.extract(payload).map((raw) => normalizeRecord(raw, this.columnMap)), page: 1, cursor: null, done: true };
  }

  async *fetchPricing({ limit = 500 } = {}) {
    const payload = await this.execute(this.config.pricingQuery, { limit });
    yield { records: this.extract(payload).map((raw) => normalizeRecord(raw, this.columnMap)), page: 1, cursor: null, done: true };
  }
}

module.exports = { GraphQlConnector };
