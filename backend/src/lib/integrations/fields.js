'use strict';

/**
 * Provider configuration-schema layer (PR #71).
 *
 * Providers declare the fields a tenant must fill in — API keys, client ids,
 * OAuth settings, SFTP hosts, bank account numbers, import folders — as
 * *metadata*, never as UI code. This module owns the metadata vocabulary:
 *
 *   • normalizeField()    — canonical, complete descriptor for one field
 *   • validateFields()    — server-side validation driven by the same metadata
 *   • configurationSchema() — the full { config, credentials } schema an
 *     adapter exposes, consumed by the dynamic connection wizard (PR #69)
 *
 * The contract is deliberately backward compatible with the compact phase-1
 * field objects ({ name, label, type, required, maxLength, ... }): every
 * missing key gets a safe default, so existing adapters keep working while
 * new ones may declare `secret`, `writeOnly`, `supportsRotation`,
 * `supportsClearing`, `environmentSpecific` and `validation` explicitly.
 *
 * Security invariants enforced here:
 *   • secret fields are ONLY valid in `credentialFields` — declaring
 *     `secret: true` on a config field is a registration bug and is flagged;
 *   • validation NEVER echoes secret values back — the result carries field
 *     names, messages and *which* credential keys were provided, nothing else.
 *
 * This module must not import base.js or gateway.js (they import this one).
 */

/** Field types the shared admin UI already knows how to render. */
const FIELD_TYPES = ['text', 'textarea', 'number', 'boolean', 'select', 'password', 'url', 'email', 'json', 'checkbox'];

const SECRET_TYPES = ['password'];

/**
 * Canonicalise one provider-declared field descriptor. Unknown keys are
 * preserved verbatim (a provider may add UI hints the core does not know).
 */
function normalizeField(raw = {}, { kind = 'config' } = {}) {
  const field = { ...raw };
  const name = String(field.name || field.key || '').trim();
  field.name = name;
  field.key = name; // alias — some clients read `key`
  field.label = String(field.label || name);
  field.type = SECRET_TYPES.includes(field.type) || field.secret === true ? (raw.type || 'password') : (field.type || 'text');
  if (!FIELD_TYPES.includes(field.type)) field.type = 'text';
  field.required = field.required === undefined ? field.kind === 'secret' : Boolean(field.required);
  field.secret = kind === 'credential' ? true : Boolean(field.secret);
  // Secrets are write-only by contract: the browser can set them, never read.
  field.writeOnly = field.secret ? true : Boolean(field.writeOnly);
  // Rotation/clearing semantics — secret fields support both unless the
  // provider explicitly opts out; plain config fields "clear" by omission.
  field.supportsRotation = field.secret ? field.supportsRotation !== false : Boolean(field.supportsRotation);
  field.supportsClearing = field.secret ? field.supportsClearing !== false : true;
  field.environmentSpecific = Boolean(field.environmentSpecific);
  if (field.help !== undefined) field.help = String(field.help);
  if (field.placeholder !== undefined) field.placeholder = String(field.placeholder);

  const validation = { ...(field.validation || {}) };
  if (field.maxLength !== undefined && validation.maxLength === undefined) validation.maxLength = Number(field.maxLength) || undefined;
  if (field.minLength !== undefined && validation.minLength === undefined) validation.minLength = Number(field.minLength) || undefined;
  if (field.min !== undefined && validation.min === undefined) validation.min = Number(field.min);
  if (field.max !== undefined && validation.max === undefined) validation.max = Number(field.max);
  if (field.pattern !== undefined && validation.pattern === undefined) validation.pattern = String(field.pattern);
  if (field.patternMessage !== undefined && validation.message === undefined) validation.message = String(field.patternMessage);
  if (field.options !== undefined && validation.oneOf === undefined) {
    validation.oneOf = (field.options || []).map((o) => (o && typeof o === 'object' ? o.value : o));
  }
  if (field.required !== undefined) validation.required = Boolean(field.required);
  field.validation = validation;
  return field;
}

const normalizeFields = (fields, kind) => (fields || []).map((f) => normalizeField(f, { kind }));

/** A safe, compact validation error: field + message only. Never values. */
function fieldError(field, message) {
  return { field, message };
}

function validateString(field, value, errors) {
  const s = String(value ?? '');
  const v = field.validation || {};
  if (!s.trim() && !field.required) return null;
  if (v.maxLength && s.length > v.maxLength) errors.push(fieldError(field.name, `Must be at most ${v.maxLength} characters`));
  if (v.minLength && s.length < v.minLength) errors.push(fieldError(field.name, `Must be at least ${v.minLength} characters`));
  if (v.pattern) {
    let re = null;
    try { re = new RegExp(v.pattern); } catch (_) { re = null; }
    if (re && !re.test(s)) errors.push(fieldError(field.name, v.message || 'Invalid format'));
  }
  if (v.oneOf && v.oneOf.length && !v.oneOf.some((o) => String(o) === s)) {
    errors.push(fieldError(field.name, `Must be one of: ${v.oneOf.join(', ')}`));
  }
  if (field.type === 'url' && s && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    errors.push(fieldError(field.name, 'Must be an absolute URL'));
  }
  if (field.type === 'email' && s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) {
    errors.push(fieldError(field.name, 'Must be a valid email address'));
  }
  return s;
}

/**
 * Validates a proposed { config, credentials } submission against a provider's
 * normalised field schemas. Returns safe output only:
 *   { ok, errors[], normalizedConfig, credentialKeys: { provided[], omittedRequired[] } }
 * Secret VALUES are never included anywhere in the result.
 */
function validateConfiguration({ configFields = [], credentialFields = [], config = {}, credentials = {} } = {}) {
  const errors = [];
  const normalizedConfig = {};

  for (const raw of configFields || []) {
    const field = raw && raw.name ? raw : normalizeField(raw, { kind: 'config' });
    if (field.secret) errors.push(fieldError(field.name, 'Secret fields must be declared as credentials, not config'));
    const value = (config || {})[field.name];
    const missing = value === undefined || value === null || value === '';
    if (missing) {
      if (field.required) errors.push(fieldError(field.name, `${field.label || field.name} is required`));
      else if (field.default !== undefined) normalizedConfig[field.name] = field.default;
      continue;
    }
    switch (field.type) {
      case 'number': {
        const n = Number(value);
        if (!Number.isFinite(n)) errors.push(fieldError(field.name, 'Must be a number'));
        else {
          const v = field.validation || {};
          if (v.min !== undefined && Number.isFinite(v.min) && n < v.min) errors.push(fieldError(field.name, `Must be ≥ ${v.min}`));
          if (v.max !== undefined && Number.isFinite(v.max) && n > v.max) errors.push(fieldError(field.name, `Must be ≤ ${v.max}`));
          normalizedConfig[field.name] = n;
        }
        break;
      }
      case 'boolean':
      case 'checkbox':
        normalizedConfig[field.name] = value === true || value === 'true' || value === 1 || value === '1';
        break;
      case 'json':
        if (typeof value === 'object') normalizedConfig[field.name] = value;
        else {
          try { normalizedConfig[field.name] = JSON.parse(String(value)); }
          catch (_) { errors.push(fieldError(field.name, 'Must be valid JSON')); }
        }
        break;
      default: {
        const s = validateString(field, value, errors);
        if (s !== null) normalizedConfig[field.name] = s;
        break;
      }
    }
  }

  // Credentials: shape validation only (secret values are validated for
  // *presence and type*, never echoed). Omitted keys legitimately mean
  // "keep the existing secret" — callers decide whether that is acceptable.
  const credentialKeys = { provided: [], omittedRequired: [] };
  for (const raw of credentialFields || []) {
    const field = raw && raw.name ? raw : normalizeField(raw, { kind: 'credential' });
    const value = (credentials || {})[field.name];
    if (value === undefined || value === null || value === '') {
      if (field.required) credentialKeys.omittedRequired.push(field.name);
      continue;
    }
    if (typeof value !== 'string' || !value.length) errors.push(fieldError(field.name, 'Credential values must be non-empty strings'));
    else {
      if (field.validation && field.validation.maxLength && value.length > field.validation.maxLength) {
        errors.push(fieldError(field.name, `Must be at most ${field.validation.maxLength} characters`));
      }
      credentialKeys.provided.push(field.name);
    }
  }
  for (const [name, value] of Object.entries(credentials || {})) {
    if (value === undefined || value === null || value === '') continue;
    const known = (credentialFields || []).some((f) => (f.name || f.key) === name);
    if (!known) errors.push(fieldError(name, 'Unknown credential field for this provider'));
  }

  if (credentialKeys.omittedRequired.length) {
    for (const name of credentialKeys.omittedRequired) {
      errors.push(fieldError(name, 'Required credential missing'));
    }
  }
  return { ok: errors.length === 0, errors, normalizedConfig, credentialKeys };
}

/** Full schema payload for `GET /providers/:id/schema` (wizard-consumable). */
function configurationSchema(Provider) {
  const environments = Provider.environments && Provider.environments.length ? Provider.environments : ['SANDBOX', 'PRODUCTION'];
  return {
    providerId: Provider.id,
    label: Provider.label,
    version: Provider.version || '1.0.0',
    environments,
    docs: Provider.docs || null,
    authTypes: Provider.authTypes || ['NONE'],
    connectionMethods: Provider.connectionMethods || [],
    requiresCredentials: Boolean(Provider.requiresCredentials),
    configFields: normalizeFields(Provider.configFields, 'config'),
    credentialFields: normalizeFields(Provider.credentialFields, 'credential'),
  };
}

module.exports = {
  FIELD_TYPES,
  normalizeField,
  normalizeFields,
  validateConfiguration,
  configurationSchema,
};
