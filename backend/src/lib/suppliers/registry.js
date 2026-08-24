/**
 * Connector registry.
 *
 * The single place the platform learns which supplier adapters exist. Core
 * commerce code never imports a connector directly — it asks the registry for
 * one by `connectorType`, so:
 *
 *   • adding a supplier = create a SupplierIntegration row (no deploy)
 *   • adding a transport = drop a file in connectors/ and register it
 *   • a future Supplier Plugin Marketplace = the same `register()` call fed by
 *     installed plugin packages (see `loadFromDirectory`)
 */
const path = require('path');
const fs = require('fs');
const { SupplierConnector, CAPABILITIES, CAPABILITY_IDS } = require('./connectors/base');

const registry = new Map();
const externalLoaded = new Set();

/** Registers a connector class. Idempotent — the last registration wins. */
function register(Connector, { source = 'builtin' } = {}) {
  if (typeof Connector !== 'function' || !(Connector.prototype instanceof SupplierConnector)) {
    throw new TypeError(`Connector "${Connector?.name || Connector}" must extend SupplierConnector`);
  }
  if (!Connector.id || Connector.id === 'base') throw new TypeError('Connector must declare a unique static id');
  registry.set(Connector.id, { Connector, source });
  return Connector.id;
}

function unregister(id) { return registry.delete(id); }

function has(id) { return registry.has(id); }

function get(id) {
  const entry = registry.get(id);
  if (!entry) return null;
  return entry.Connector;
}

/**
 * Instantiates the adapter bound to a SupplierIntegration row.
 * @returns {SupplierConnector|null} null when the connector type is unknown
 */
function create({ supplier, integration, secrets = {}, config = {}, settings = {} } = {}) {
  const Connector = get(integration?.connectorType);
  if (!Connector) return null;
  return new Connector({ supplier, integration, secrets, config, settings });
}

/** Browser-safe catalogue of every registered connector. */
function list() {
  return [...registry.values()]
    .map(({ Connector, source }) => ({ ...Connector.describe(), source, installed: Connector.runtimeAvailable ? Connector.runtimeAvailable() : true }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function capabilities() {
  return CAPABILITY_IDS.map((id) => ({ id, description: CAPABILITIES[id] }));
}

/**
 * Registers every connector module found in a directory. Used today for the
 * built-in connectors and tomorrow for installed marketplace plugins — the
 * contract is identical, which is what makes the future plugin marketplace a
 * packaging problem rather than an architecture change.
 */
function loadFromDirectory(dir, { source = 'plugin' } = {}) {
  const loaded = [];
  if (!fs.existsSync(dir)) return loaded;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
    const full = path.join(dir, file);
    if (externalLoaded.has(full)) continue;
    externalLoaded.add(full);
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const mod = require(full);
    const candidates = [mod, mod.default, ...(mod ? Object.values(mod).filter((v) => typeof v === 'function') : [])];
    for (const candidate of candidates) {
      if (typeof candidate === 'function'
        && candidate.prototype instanceof SupplierConnector
        && candidate.id && candidate.id !== 'base' && !registry.has(candidate.id)) {
        register(candidate, { source });
        loaded.push(candidate.id);
      }
    }
  }
  return loaded;
}

/* ---- built-in connectors -------------------------------------------------- */
register(require('./connectors/rest-json').RestJsonConnector);
register(require('./connectors/graphql').GraphQlConnector);
register(require('./connectors/file-feed').CsvFeedConnector);
register(require('./connectors/file-feed').XmlFeedConnector);
register(require('./connectors/file-feed').JsonFeedConnector);
register(require('./connectors/sftp').SftpConnector);
register(require('./connectors/manual').ManualConnector);

// Optional plugin directory: backend/src/lib/suppliers/plugins
loadFromDirectory(path.join(__dirname, 'plugins'), { source: 'plugin' });

module.exports = { register, unregister, has, get, create, list, capabilities, loadFromDirectory };
