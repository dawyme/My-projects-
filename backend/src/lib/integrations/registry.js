'use strict';

/**
 * Integration provider registry.
 *
 * The single place the platform learns which bank / PSP / POS / accounting
 * adapters exist. Application code never imports an adapter directly — it asks
 * the Gateway, which asks the registry for a provider by id, so:
 *
 *   • connecting an institution = create an IntegrationConnection row (no deploy)
 *   • adding an institution    = drop one adapter file + `register()` (no core change)
 *   • a future provider marketplace = the same `register()` call fed by
 *     installed plugin packages (see `loadFromDirectory`)
 *
 * Mirrors the proven Supplier Marketplace connector registry (`suppliers/registry.js`).
 */

const path = require('path');
const fs = require('fs');
const {
  IntegrationProvider,
  CAPABILITIES,
  CAPABILITY_IDS,
  PROVIDER_CATEGORIES,
  PROVIDER_CATEGORY_IDS,
  CONNECTION_METHODS,
  CONNECTION_METHOD_IDS,
} = require('./base');

const registry = new Map();
const externalLoaded = new Set();

/** Registers a provider adapter class. Idempotent — the last registration wins. */
function register(Provider, { source = 'builtin' } = {}) {
  if (typeof Provider !== 'function' || !(Provider.prototype instanceof IntegrationProvider)) {
    throw new TypeError(`Provider "${Provider?.name || Provider}" must extend IntegrationProvider`);
  }
  if (!Provider.id || Provider.id === 'base') throw new TypeError('Provider must declare a unique static id');
  if (!PROVIDER_CATEGORY_IDS.includes(Provider.category)) {
    throw new TypeError(`Provider "${Provider.id}" declares unknown category "${Provider.category}"`);
  }
  registry.set(Provider.id, { Provider, source });
  return Provider.id;
}

function unregister(id) { return registry.delete(id); }

function has(id) { return registry.has(id); }

function get(id) {
  const entry = registry.get(id);
  if (!entry) return null;
  return entry.Provider;
}

/**
 * Instantiates the adapter bound to an IntegrationConnection row.
 * @returns {IntegrationProvider|null} null when the provider id is unknown
 */
function create({ connection, secrets = {}, config = {}, tenantId = null } = {}) {
  const Provider = get(connection?.providerId);
  if (!Provider) return null;
  return new Provider({ connection, secrets, config, tenantId });
}

/** Browser-safe catalogue of every registered provider, sorted by label. */
function list() {
  return [...registry.values()]
    .map(({ Provider, source }) => ({ ...Provider.describe(), source }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function capabilities() {
  return CAPABILITY_IDS.map((id) => ({ id, description: CAPABILITIES[id] }));
}

function categories() {
  return PROVIDER_CATEGORY_IDS.map((id) => ({ id, description: PROVIDER_CATEGORIES[id] }));
}

function connectionMethods() {
  return CONNECTION_METHOD_IDS.map((id) => ({ id, description: CONNECTION_METHODS[id] }));
}

/**
 * Registers every adapter module found in a directory. Used for future
 * installed provider plugins — the contract is identical to built-ins, which
 * is what makes a future provider marketplace a packaging problem rather than
 * an architecture change.
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
        && candidate.prototype instanceof IntegrationProvider
        && candidate.id && candidate.id !== 'base' && !registry.has(candidate.id)) {
        register(candidate, { source });
        loaded.push(candidate.id);
      }
    }
  }
  return loaded;
}

/* ---- built-in providers (phase 1 proof-of-design adapters) ---------------- */
// eslint-disable-next-line global-require
register(require('./adapters/manual-bank-transfer').ManualBankTransferProvider);
// eslint-disable-next-line global-require
register(require('./adapters/sandbox-psp').SandboxDemoProvider);

// Optional plugin directory: backend/src/lib/integrations/plugins
loadFromDirectory(path.join(__dirname, 'plugins'), { source: 'plugin' });

module.exports = {
  register, unregister, has, get, create, list,
  capabilities, categories, connectionMethods, loadFromDirectory,
};
