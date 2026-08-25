/**
 * File-feed supplier connectors: CSV, XML and JSON documents delivered over
 * HTTP(S) (a scheduled drop URL, an authenticated download link, a CDN export).
 *
 * The three classes share one implementation — only the document parser and the
 * default field aliases differ. File feeds are read-only: they can import a
 * catalogue and refresh stock/pricing, but they cannot accept purchase orders,
 * so no order capability is advertised and the Admin UI says so plainly.
 */
const { SupplierConnector, SupplierConnectorError, normalizeRecord } = require('./base');
const { httpRequest, assertPublicUrl } = require('../http');
const { parseCsvObjects, guessColumnMap } = require('../parsers/csv');
const { parseXml, selectNodes, flattenNode } = require('../parsers/xml');
const { getPath } = require('./base');
const { COLUMN_MAP_DEFAULT } = require('./rest-json');

class FileFeedConnector extends SupplierConnector {
  static transport = 'FILE';
  static authTypes = ['NONE', 'API_KEY', 'BASIC', 'BEARER'];
  static capabilities = ['connect', 'testConnection', 'disconnect', 'importCatalog', 'syncProducts', 'syncInventory', 'syncPricing'];
  static credentialFields = [
    { name: 'apiKey', label: 'API key', type: 'secret', authTypes: ['API_KEY'] },
    { name: 'username', label: 'Username', type: 'text', authTypes: ['BASIC'] },
    { name: 'password', label: 'Password', type: 'secret', authTypes: ['BASIC'] },
    { name: 'accessToken', label: 'Access token', type: 'secret', authTypes: ['BEARER'] },
  ];
  static configFields = [
    { name: 'feedUrl', label: 'Feed URL', type: 'url', required: true, help: 'Full URL of the catalogue file' },
    { name: 'inventoryFeedUrl', label: 'Inventory feed URL', type: 'url', help: 'Optional separate stock feed', group: 'Sync' },
    { name: 'pricingFeedUrl', label: 'Pricing feed URL', type: 'url', help: 'Optional separate price feed', group: 'Sync' },
    { name: 'apiKeyHeader', label: 'API key header', type: 'text', help: 'Default: X-Api-Key', group: 'Authentication' },
    { name: 'itemsPath', label: 'Item node path', type: 'text', group: 'Parsing' },
    { name: 'delimiter', label: 'Delimiter', type: 'text', group: 'Parsing' },
    { name: 'encoding', label: 'Encoding', type: 'select', options: ['utf8', 'latin1'], group: 'Parsing' },
    { name: 'columnMap', label: 'Field mapping', type: 'map', group: 'Field mapping' },
  ];

  constructor(options) {
    super(options);
    this.columnMap = { ...COLUMN_MAP_DEFAULT, ...(this.config.columnMap || {}) };
  }

  get secretsList() { return Object.values(this.secrets || {}).filter(Boolean).map(String); }

  isConfiguredFor(capability) {
    if (capability === 'syncInventory') return Boolean(this.config.inventoryFeedUrl || this.config.feedUrl);
    if (capability === 'syncPricing') return Boolean(this.config.pricingFeedUrl || this.config.feedUrl);
    return true;
  }

  hasCredentials() {
    switch (this.integration.authType || 'NONE') {
      case 'API_KEY': return Boolean(this.secrets.apiKey);
      case 'BASIC': return Boolean(this.secrets.username && this.secrets.password);
      case 'BEARER': return Boolean(this.secrets.accessToken);
      default: return true;
    }
  }

  async headers() {
    const headers = { 'User-Agent': 'NDS-SupplierMarketplace/1.0' };
    switch (this.integration.authType || 'NONE') {
      case 'API_KEY':
        this.requireCredentials();
        headers[this.config.apiKeyHeader || 'X-Api-Key'] = this.secrets.apiKey;
        break;
      case 'BASIC':
        this.requireCredentials();
        headers.Authorization = `Basic ${Buffer.from(`${this.secrets.username}:${this.secrets.password || ''}`).toString('base64')}`;
        break;
      case 'BEARER':
        this.requireCredentials();
        headers.Authorization = `Bearer ${this.secrets.accessToken}`;
        break;
      default: break;
    }
    return headers;
  }

  async download(url) {
    this.requireCredentials();
    if (!url) throw new SupplierConnectorError('No feed URL configured', { code: 'NOT_CONFIGURED' });
    const res = await httpRequest(assertPublicUrl(url), {
      headers: await this.headers(),
      expect: 'text',
      secrets: this.secretsList,
      timeoutMs: Number(this.config.timeoutMs || 60000),
    });
    return res.body;
  }

  /** Overridden per format: turns raw text into an array of raw records. */
  // eslint-disable-next-line no-unused-vars
  parse(text) { throw new Error('parse() must be implemented by the concrete feed connector'); }

  /** Headers of the document, for the mapping UI. */
  // eslint-disable-next-line no-unused-vars
  detectHeaders(text) { return []; }

  async connect() {
    this.requireCredentials();
    const r = await this.testConnection();
    return { ok: r.ok, message: r.message };
  }

  async testConnection() {
    this.requireCredentials();
    const started = Date.now();
    const text = await this.download(this.config.feedUrl);
    const records = this.parse(text);
    return {
      ok: true,
      latencyMs: Date.now() - started,
      message: `Feed reachable and parsed — ${records.length} record(s) in ${Date.now() - started}ms.`,
    };
  }

  async *fetchCatalog() {
    const text = await this.download(this.config.feedUrl);
    const records = this.parse(text);
    const BATCH = 500;
    for (let i = 0; i < records.length; i += BATCH) {
      const slice = records.slice(i, i + BATCH);
      yield {
        records: slice.map((raw) => normalizeRecord(raw, this.columnMap)),
        page: Math.floor(i / BATCH) + 1,
        cursor: i + BATCH < records.length ? String(i + BATCH) : null,
        done: i + BATCH >= records.length,
      };
    }
  }

  fetchInventory() { return this.fetchFromUrl(this.config.inventoryFeedUrl || this.config.feedUrl); }
  fetchPricing() { return this.fetchFromUrl(this.config.pricingFeedUrl || this.config.feedUrl); }

  async *fetchFromUrl(url) {
    const text = await this.download(url);
    const records = this.parse(text);
    const BATCH = 500;
    for (let i = 0; i < records.length; i += BATCH) {
      const slice = records.slice(i, i + BATCH);
      yield {
        records: slice.map((raw) => normalizeRecord(raw, this.columnMap)),
        page: Math.floor(i / BATCH) + 1,
        cursor: i + BATCH < records.length ? String(i + BATCH) : null,
        done: i + BATCH >= records.length,
      };
    }
  }
}

class CsvFeedConnector extends FileFeedConnector {
  static id = 'CSV_FEED';
  static label = 'CSV feed (HTTP)';
  static description = 'A CSV catalogue delivered over HTTP(S). Column mapping is auto-detected and can be corrected per integration.';
  static formats = ['CSV', 'TSV'];

  parse(text) {
    const { records, truncated } = parseCsvObjects(text, { delimiter: this.config.delimiter || undefined });
    if (truncated) throw new SupplierConnectorError('CSV feed exceeded the row limit — split the file or raise the limit', { code: 'TOO_LARGE' });
    return records;
  }

  detectHeaders(text) {
    const { records } = parseCsvObjects(text, { delimiter: this.config.delimiter || undefined, maxRows: 2 });
    return records.length ? Object.keys(records[0]) : [];
  }

  /** Auto-maps the columns of a freshly-fetched feed. */
  async suggestColumnMap() {
    const headers = this.detectHeaders(await this.download(this.config.feedUrl));
    return { headers, columnMap: guessColumnMap(headers) };
  }
}

class XmlFeedConnector extends FileFeedConnector {
  static id = 'XML_FEED';
  static label = 'XML feed (HTTP)';
  static description = 'An XML catalogue delivered over HTTP(S). Point "Item node path" at the repeating product element.';
  static formats = ['XML'];

  parse(text) {
    const { root } = parseXml(text);
    const nodes = selectNodes(root, this.config.itemsPath);
    if (!nodes.length) {
      throw new SupplierConnectorError(
        this.config.itemsPath
          ? `No items found at "${this.config.itemsPath}"`
          : 'Configure the "Item node path" (for example catalog.product) for this XML feed',
        { code: 'BAD_SHAPE' }
      );
    }
    return nodes.map((n) => flattenNode(n));
  }

  detectHeaders(text) {
    try {
      const { root } = parseXml(text);
      const nodes = selectNodes(root, this.config.itemsPath);
      return nodes.length ? Object.keys(flattenNode(nodes[0])) : [];
    } catch { return []; }
  }

  async suggestColumnMap() {
    const headers = this.detectHeaders(await this.download(this.config.feedUrl));
    return { headers, columnMap: guessColumnMap(headers) };
  }
}

class JsonFeedConnector extends FileFeedConnector {
  static id = 'JSON_FEED';
  static label = 'JSON feed (HTTP)';
  static description = 'A JSON array (or a JSON document containing one) delivered over HTTP(S).';
  static formats = ['JSON'];

  parse(text) {
    let payload;
    try { payload = JSON.parse(text); } catch (e) {
      throw new SupplierConnectorError(`Feed is not valid JSON: ${e.message}`, { code: 'INVALID_JSON' });
    }
    if (Array.isArray(payload)) return payload;
    if (this.config.itemsPath) {
      const found = getPath(payload, this.config.itemsPath);
      if (Array.isArray(found)) return found;
      throw new SupplierConnectorError(`No array found at "${this.config.itemsPath}"`, { code: 'BAD_SHAPE' });
    }
    for (const key of ['data', 'items', 'results', 'products', 'records']) {
      if (Array.isArray(payload[key])) return payload[key];
    }
    throw new SupplierConnectorError('Could not locate an item array — set the "Item node path"', { code: 'BAD_SHAPE' });
  }

  detectHeaders(text) {
    try { return Object.keys(this.parse(text)[0] || {}); } catch { return []; }
  }

  async suggestColumnMap() {
    const headers = this.detectHeaders(await this.download(this.config.feedUrl));
    return { headers, columnMap: guessColumnMap(headers) };
  }
}

module.exports = { FileFeedConnector, CsvFeedConnector, XmlFeedConnector, JsonFeedConnector };
