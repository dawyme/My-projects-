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

/**
 * Registers a provider adapter class.
 *
 * Duplicate handling (PR #71): re-registering the SAME class is an idempotent
 * no-op (module reloads, test harnesses); registering a DIFFERENT class under
 * a taken id is a conflict and throws — silent shadowing of a built-in by a
 * plugin would be a supply-chain foot-gun. `{ force: true }` overrides
 * deliberately (used by tests and future marketplace upserts).
 */
function register(Provider, { source = 'builtin', force = false } = {}) {
  if (typeof Provider !== 'function' || !(Provider.prototype instanceof IntegrationProvider)) {
    throw new TypeError(`Provider "${Provider?.name || Provider}" must extend IntegrationProvider`);
  }
  if (!Provider.id || Provider.id === 'base') throw new TypeError('Provider must declare a unique static id');
  if (!PROVIDER_CATEGORY_IDS.includes(Provider.category)) {
    throw new TypeError(`Provider "${Provider.id}" declares unknown category "${Provider.category}"`);
  }
  const existing = registry.get(Provider.id);
  if (existing && existing.Provider !== Provider && !force) {
    throw new TypeError(
      `Provider id "${Provider.id}" is already registered by "${existing.Provider.name}" (source: ${existing.source}). ` +
        `Choose a unique id or register with { force: true } to replace it.`
    );
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

/** Registered provider ids (stable order: registration order). */
function ids() { return [...registry.keys()]; }

/** Registration metadata for one provider (source included). */
function entry(id) {
  const found = registry.get(id);
  return found ? { id, source: found.source, registered: true } : null;
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

/* ---- PR #71: metadata discovery APIs (registry is the single source) ---- */

/** Identity + catalogue metadata for one provider, or null when unknown. */
function getMetadata(id) {
  const Provider = get(id);
  return Provider ? Provider.describe() : null;
}

/** Capability descriptors (id/description/supported/groups) for one provider. */
function getCapabilities(id) {
  const Provider = get(id);
  return Provider ? Provider.getCapabilities() : null;
}

/** Capability ids the provider class declares (pre-configuration view). */
function declaredCapabilities(id) {
  const Provider = get(id);
  return Provider ? [...new Set(Provider.capabilities || [])] : null;
}

/** Metadata-driven configuration/credential schema for the connection wizard. */
function getConfigurationSchema(id) {
  const Provider = get(id);
  return Provider ? Provider.getConfigurationSchema() : null;
}

/**
 * Validate whether an operation is supported by the PROVIDER CLASS.
 * (A specific connection may narrow it further — the Gateway's `supports()`
 * check against the instantiated adapter remains the runtime authority.)
 */
function supportsOperation(id, capability) {
  const declared = declaredCapabilities(id);
  return Boolean(declared && declared.includes(capability));
}

/** Structural validation a provider must satisfy before registration is honoured. */
function validate(Provider) {
  const problems = [];
  if (typeof Provider !== 'function' || !(Provider.prototype instanceof IntegrationProvider)) problems.push('must extend IntegrationProvider');
  else {
    if (!Provider.id || Provider.id === 'base') problems.push('must declare a unique static id');
    if (!PROVIDER_CATEGORY_IDS.includes(Provider.category)) problems.push(`unknown category "${Provider.category}"`);
    for (const cap of Provider.capabilities || []) {
      if (!CAPABILITY_IDS.includes(cap)) problems.push(`unknown capability "${cap}"`);
    }
    for (const m of Provider.connectionMethods || []) {
      if (!CONNECTION_METHOD_IDS.includes(m)) problems.push(`unknown connection method "${m}"`);
    }
    for (const f of [...(Provider.credentialFields || []), ...(Provider.configFields || [])]) {
      if (!f || !(f.name || f.key)) problems.push('every configuration/credential field must declare a name');
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Browser-safe catalogue of every registered provider, sorted by label. */
function list() {
  return [...registry.values()]
    .map(({ Provider, source }) => ({ ...Provider.describe(), source }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function capabilities() {
  const { CAPABILITY_GROUPS, CAPABILITY_GROUP_IDS } = require('./base');
  return CAPABILITY_IDS.map((id) => ({
    id,
    description: CAPABILITIES[id],
    groups: CAPABILITY_GROUP_IDS.filter((g) => (CAPABILITY_GROUPS[g] || []).includes(id)),
  }));
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
  // PR #71 — discovery & validation surface:
  ids, entry, getMetadata, getCapabilities, declaredCapabilities,
  getConfigurationSchema, supportsOperation, validate,
};
