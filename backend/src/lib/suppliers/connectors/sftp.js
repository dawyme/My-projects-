/**
 * SFTP supplier connector.
 *
 * Pulls a catalogue file from the supplier's SFTP drop directory and parses it
 * with the same CSV/XML/JSON readers the HTTP feeds use.
 *
 * SSH is not part of the platform's baseline dependencies (it needs a native
 * crypto binding). The connector detects `ssh2` at runtime:
 *
 *   • installed  → full connect / test / import behaviour
 *   • missing    → a precise RuntimeUnavailableError naming the one command
 *                  that fixes it, and the integration is reported as
 *                  "Not connected — runtime required" rather than faked.
 *
 *     npm install ssh2
 */
const {
  SupplierConnector, SupplierConnectorError, RuntimeUnavailableError,
  NotConnectedError, normalizeRecord,
} = require('./base');
const { parseCsvObjects, guessColumnMap } = require('../parsers/csv');
const { parseXml, selectNodes, flattenNode } = require('../parsers/xml');
const { getPath } = require('./base');
const { COLUMN_MAP_DEFAULT } = require('./rest-json');

let ssh2 = null;
try { ssh2 = require('ssh2'); } catch (_) { ssh2 = null; }

const MAX_FILE_BYTES = 25 * 1024 * 1024;

function loadSsh2() {
  if (ssh2) return ssh2;
  throw new RuntimeUnavailableError(
    'The SFTP runtime (ssh2) is not installed on this server',
    'Run `npm install ssh2` in the backend directory, then restart the API.'
  );
}

class SftpConnector extends SupplierConnector {
  static id = 'SFTP';
  static label = 'SFTP file drop';
  static description = 'Reads catalogue files from the supplier\'s SFTP server. Supports CSV, XML and JSON payloads with the same field mapping as HTTP feeds.';
  static transport = 'FILE';
  static formats = ['CSV', 'XML', 'JSON'];
  static authTypes = ['SFTP'];
  static capabilities = ['connect', 'testConnection', 'disconnect', 'importCatalog', 'syncProducts', 'syncInventory', 'syncPricing'];
  static requiresCredentials = true;
  static credentialFields = [
    { name: 'username', label: 'SFTP username', type: 'text', required: true },
    { name: 'password', label: 'SFTP password', type: 'secret', help: 'Leave empty when using a private key' },
    { name: 'privateKey', label: 'Private key (PEM)', type: 'secret', help: 'OpenSSH / PEM formatted private key' },
    { name: 'passphrase', label: 'Key passphrase', type: 'secret' },
  ];
  static configFields = [
    { name: 'host', label: 'Host', type: 'text', required: true },
    { name: 'port', label: 'Port', type: 'number', help: 'Default: 22' },
    { name: 'catalogPath', label: 'Catalogue file path', type: 'text', required: true, help: 'e.g. /feeds/catalog.csv' },
    { name: 'inventoryPath', label: 'Inventory file path', type: 'text', group: 'Sync' },
    { name: 'pricingPath', label: 'Pricing file path', type: 'text', group: 'Sync' },
    { name: 'fileFormat', label: 'File format', type: 'select', options: ['CSV', 'XML', 'JSON'], help: 'Default: inferred from the extension' },
    { name: 'itemsPath', label: 'Item node path (XML/JSON)', type: 'text', group: 'Parsing' },
    { name: 'delimiter', label: 'Delimiter (CSV)', type: 'text', group: 'Parsing' },
    { name: 'columnMap', label: 'Field mapping', type: 'map', group: 'Field mapping' },
  ];

  constructor(options) {
    super(options);
    this.columnMap = { ...COLUMN_MAP_DEFAULT, ...(this.config.columnMap || {}) };
  }

  get secretsList() { return Object.values(this.secrets || {}).filter(Boolean).map(String); }

  isConfiguredFor(capability) {
    if (capability === 'syncInventory') return Boolean(this.config.inventoryPath || this.config.catalogPath);
    if (capability === 'syncPricing') return Boolean(this.config.pricingPath || this.config.catalogPath);
    return true;
  }

  hasCredentials() {
    return Boolean(this.secrets.username && (this.secrets.password || this.secrets.privateKey));
  }

  /** Opens a session, runs `work(sftp)`, and always closes the connection. */
  withSftp(work, { timeoutMs = 30000 } = {}) {
    const { Client } = loadSsh2();
    this.requireCredentials();
    const conn = new Client();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.end();
        reject(new SupplierConnectorError(`SFTP connection timed out after ${timeoutMs}ms`, { code: 'TIMEOUT' }));
      }, timeoutMs);

      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) { clearTimeout(timer); conn.end(); return reject(new SupplierConnectorError(`SFTP session failed: ${err.message}`, { code: 'SFTP_SESSION' })); }
          Promise.resolve()
            .then(() => work(sftp))
            .then((result) => { clearTimeout(timer); conn.end(); resolve(result); })
            .catch((e) => { clearTimeout(timer); conn.end(); reject(e); });
        });
      });
      conn.on('error', (err) => {
        clearTimeout(timer);
        const message = /authentication/i.test(err.message)
          ? 'Not connected — SFTP credentials rejected'
          : `SFTP connection failed: ${err.message}`;
        reject(new SupplierConnectorError(message, { code: /authentication/i.test(err.message) ? 'AUTH_FAILED' : 'NETWORK' }));
      });

      const config = {
        host: this.config.host,
        port: Number(this.config.port || 22),
        username: this.secrets.username,
        readyTimeout: timeoutMs,
      };
      if (this.secrets.privateKey) {
        config.privateKey = this.secrets.privateKey;
        if (this.secrets.passphrase) config.passphrase = this.secrets.passphrase;
      } else {
        config.password = this.secrets.password;
      }
      conn.connect(config);
    });
  }

  readFile(sftp, remotePath) {
    return new Promise((resolve, reject) => {
      const stream = sftp.createReadStream(remotePath, { encoding: 'utf8' });
      let data = '';
      let size = 0;
      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_FILE_BYTES) {
          stream.destroy();
          reject(new SupplierConnectorError(`SFTP file exceeds ${MAX_FILE_BYTES / 1024 / 1024} MB`, { code: 'TOO_LARGE' }));
          return;
        }
        data += chunk;
      });
      stream.on('end', () => resolve(data));
      stream.on('error', (err) => reject(new SupplierConnectorError(`Could not read ${remotePath}: ${err.message}`, { code: 'READ_FAILED' })));
    });
  }

  detectFormat(remotePath) {
    const explicit = this.config.fileFormat;
    if (explicit) return explicit;
    const ext = String(remotePath).split('.').pop().toLowerCase();
    if (ext === 'xml') return 'XML';
    if (ext === 'json') return 'JSON';
    return 'CSV';
  }

  parse(text, remotePath) {
    const format = this.detectFormat(remotePath);
    if (format === 'XML') {
      const { root } = parseXml(text);
      const nodes = selectNodes(root, this.config.itemsPath);
      if (!nodes.length) throw new SupplierConnectorError(`No items found at "${this.config.itemsPath || ''}" in the XML file`, { code: 'BAD_SHAPE' });
      return nodes.map((n) => flattenNode(n));
    }
    if (format === 'JSON') {
      let payload;
      try { payload = JSON.parse(text); } catch (e) { throw new SupplierConnectorError(`File is not valid JSON: ${e.message}`, { code: 'INVALID_JSON' }); }
      if (Array.isArray(payload)) return payload;
      const found = this.config.itemsPath ? getPath(payload, this.config.itemsPath) : null;
      if (Array.isArray(found)) return found;
      throw new SupplierConnectorError('Set the "Item node path" for this JSON file', { code: 'BAD_SHAPE' });
    }
    const { records, truncated } = parseCsvObjects(text, { delimiter: this.config.delimiter || undefined });
    if (truncated) throw new SupplierConnectorError('SFTP file exceeded the row limit', { code: 'TOO_LARGE' });
    return records;
  }

  async connect() {
    const started = Date.now();
    await this.withSftp(() => Promise.resolve());
    return { ok: true, message: `SFTP session established in ${Date.now() - started}ms.` };
  }

  async testConnection() {
    const started = Date.now();
    const remotePath = this.config.catalogPath;
    const result = await this.withSftp(async (sftp) => {
      const stat = await new Promise((resolve, reject) => {
        sftp.stat(remotePath, (err, st) => {
          if (err) {
            reject(new SupplierConnectorError(`Catalogue file not found at ${remotePath}: ${err.message}`, { code: 'NOT_FOUND' }));
            return;
          }
          resolve(st);
        });
      });
      return { size: stat.size, mtime: stat.mtime ? new Date(stat.mtime * 1000).toISOString() : null };
    });
    return {
      ok: true,
      latencyMs: Date.now() - started,
      message: `Connected — ${remotePath} present (${result.size} bytes${result.mtime ? `, modified ${result.mtime}` : ''}).`,
    };
  }

  async fetchFile(remotePath) {
    if (!remotePath) throw new SupplierConnectorError('No file path configured', { code: 'NOT_CONFIGURED' });
    return this.withSftp(async (sftp) => {
      const text = await this.readFile(sftp, remotePath);
      return this.parse(text, remotePath);
    });
  }

  async *batches(records) {
    const BATCH = 500;
    if (!records.length) { yield { records: [], page: 1, cursor: null, done: true }; return; }
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

  async *fetchCatalog() { yield* this.batches(await this.fetchFile(this.config.catalogPath)); }
  async *fetchInventory() { yield* this.batches(await this.fetchFile(this.config.inventoryPath || this.config.catalogPath)); }
  async *fetchPricing() { yield* this.batches(await this.fetchFile(this.config.pricingPath || this.config.catalogPath)); }

  async suggestColumnMap() {
    const records = await this.fetchFile(this.config.catalogPath);
    const headers = records.length ? Object.keys(records[0]) : [];
    return { headers, columnMap: guessColumnMap(headers) };
  }

  /** True when the ssh2 runtime is present on this server. */
  static runtimeAvailable() { return Boolean(ssh2); }
}

module.exports = { SftpConnector, loadSsh2, runtimeAvailable: () => Boolean(ssh2) };
