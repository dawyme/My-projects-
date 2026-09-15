'use strict';

/**
 * Integration credential protection.
 *
 * Phase 1 deliberately does NOT invent a second secret-storage mechanism: the
 * platform already ships a reviewed, AES-256-GCM credential envelope for the
 * Supplier Marketplace (`lib/suppliers/credentials.js`), and the Integration
 * Gateway reuses it verbatim for tenant provider secrets (API keys, OAuth
 * refresh tokens, webhook signing secrets, SFTP passwords, private keys).
 *
 * The guarantees are therefore identical:
 *   • secrets are encrypted at rest (AES-256-GCM, scrypt-derived key)
 *   • only masked fingerprints are ever returned to the browser
 *   • secrets are never written to audit logs, integration events or stdout
 *
 * Key derivation is shared with the supplier envelope
 * (`SUPPLIER_CREDENTIALS_KEY`, falling back to `JWT_SECRET`), so a deployment
 * that secures one automatically secures the other. A dedicated
 * `INTEGRATION_CREDENTIALS_KEY` may be introduced in a later phase alongside a
 * re-encryption migration; until then this module intentionally exposes no
 * divergent key path that could silently split the secret estate.
 */

const supplierCredentials = require('../suppliers/credentials');

const {
  encryptSecrets,
  decryptSecrets,
  fingerprint,
  describeFields,
  redact,
  redactString,
  dedicatedKeyConfigured,
} = supplierCredentials;

module.exports = {
  encryptSecrets,
  decryptSecrets,
  fingerprint,
  describeFields,
  redact,
  redactString,
  dedicatedKeyConfigured,
};
