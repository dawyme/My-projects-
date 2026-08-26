/**
 * Supplier credential protection.
 *
 * Secrets (API keys, secrets, OAuth access/refresh tokens, SFTP passwords,
 * private keys) are encrypted at rest with AES-256-GCM and are NEVER:
 *   • returned to the browser (only a masked fingerprint is exposed),
 *   • written to audit logs, sync logs or the console.
 *
 * Envelope format:  v1.<iv b64url>.<authTag b64url>.<ciphertext b64url>
 *
 * Key derivation: scrypt over SUPPLIER_CREDENTIALS_KEY, falling back to
 * JWT_SECRET so a deployment that has not set the dedicated variable still
 * encrypts rather than storing plaintext. Rotating the key requires
 * re-saving each integration's credentials (documented in
 * docs/SUPPLIER_MARKETPLACE.md §Security).
 */
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const SALT = 'nds-supplier-credentials-v1';

let cachedKey = null;
let cachedSource = null;

function keySource() {
  return process.env.SUPPLIER_CREDENTIALS_KEY
    || process.env.JWT_SECRET
    || 'nds-insecure-development-only-key';
}

function key() {
  const source = keySource();
  if (cachedKey && cachedSource === source) return cachedKey;
  cachedSource = source;
  cachedKey = crypto.scryptSync(source, SALT, 32);
  return cachedKey;
}

/** True when a dedicated SUPPLIER_CREDENTIALS_KEY is configured. */
function dedicatedKeyConfigured() {
  return Boolean(process.env.SUPPLIER_CREDENTIALS_KEY);
}

/**
 * Encrypts an arbitrary JSON-serialisable object of secrets.
 * @returns {string|null} the envelope, or null when there is nothing to store
 */
function encryptSecrets(plain) {
  if (plain === null || plain === undefined) return null;
  const entries = Object.entries(plain).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!entries.length) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(Object.fromEntries(entries)), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

/** Decrypts an envelope. Throws on tampering or an unreadable envelope. */
function decryptSecrets(envelope) {
  if (!envelope) return {};
  const parts = String(envelope).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Malformed credential envelope');
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
  try { return JSON.parse(pt); } catch { throw new Error('Unreadable credential payload'); }
}

/**
 * A stable, non-reversible fingerprint of a secret so the UI can show that
 * *something* is stored and let an admin recognise which value it was,
 * without ever exposing the secret itself.
 *   "sk_live_51H8x…9f2a"  →  "•••••••9f2a"
 */
function fingerprint(secret) {
  const value = String(secret ?? '');
  if (!value) return null;
  const hash = crypto.createHash('sha256').update(`${SALT}:${value}`).digest('hex').slice(0, 4);
  const tail = value.length > 4 ? value.slice(-4) : value;
  return `••••${tail}${hash}`;
}

/**
 * Builds the browser-safe descriptor list persisted in
 * SupplierIntegration.credentialFields.
 */
function describeFields(plain, existing = []) {
  const now = new Date().toISOString();
  const prior = new Map((existing || []).map((f) => [f.name, f]));
  const out = [];
  for (const [name, value] of Object.entries(plain || {})) {
    if (value === undefined) continue;
    if (value === null || value === '') {
      // Explicitly cleared — drop the descriptor.
      continue;
    }
    out.push({
      name,
      set: true,
      fingerprint: fingerprint(value),
      updatedAt: prior.get(name)?.fingerprint === fingerprint(value)
        ? prior.get(name)?.updatedAt || now
        : now,
    });
  }
  // Preserve descriptors for secrets that were not re-submitted.
  const names = new Set(out.map((f) => f.name));
  for (const f of existing || []) if (!names.has(f.name)) out.push(f);
  return out;
}

/** Recursively strips every secret-ish key from an object before it is logged. */
const SECRET_KEY = /secret|password|passwd|token|apikey|api_key|api-key|key|credential|privatekey|auth/i;

function redact(value, depth = 0) {
  if (depth > 6) return '[deep]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    return out;
  }
  return value;
}

/** Redacts secrets from a free-form string before it hits a log column. */
function redactString(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (s && String(s).length >= 4) out = out.split(String(s)).join('[redacted]');
  }
  return out.replace(/(authorization:\s*)(bearer\s+)?[^\s,;]+/gi, '$1[redacted]')
    .replace(/(password=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(api[_-]?key["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, '$1[redacted]');
}

module.exports = {
  encryptSecrets, decryptSecrets, fingerprint, describeFields,
  redact, redactString, dedicatedKeyConfigured,
};
