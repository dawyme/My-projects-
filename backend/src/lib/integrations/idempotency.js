'use strict';

/**
 * Idempotency for provider operations (PR #71).
 *
 * Duplicate submissions must not duplicate money movement, refunds, payment
 * links, transfers, sync jobs or webhook processing. Two cooperating layers:
 *
 *  1. IN-PROCESS LEDGER (this module) — per (tenant, connection, operation,
 *     key) it tracks IN_FLIGHT reservations (so a second concurrent request
 *     cannot double-execute) and DONE results (so a retry replays the exact
 *     original result). Bounded + TTL'd, so the ledger can never grow
 *     without limit; on a cold start/restart it is empty by design.
 *
 *  2. EVENT-LOG RECOVERY — the durable record of "we already processed this"
 *     is the existing secret-scrubbed IntegrationEvent stream. When the
 *     in-process ledger misses (e.g. after a restart), the Gateway queries
 *     IntegrationEvents by the idempotency key stored in event metadata and
 *     returns a replay marker instead of re-executing. No new table, no
 *     second idempotency store — deliberately reusing the PR #68 mechanism.
 *
 * Request fingerprinting: an entry stores a SHA-256 digest of the canonical
 * request payload. Re-using a key with DIFFERENT content is a client bug
 * (Stripe semantics) and is rejected with IDEMPOTENCY_CONFLICT rather than
 * silently replaying the first call's result.
 *
 * Webhook dedupe (same module, different layer): a verified provider event is
 * fingerprinted (connection + reference + canonical payload digest) and
 * checked against the event log so provider retry storms create one internal
 * record, not N.
 *
 * This module is pure bookkeeping: no prisma import (recovery callbacks are
 * injected by the Gateway), no secrets stored anywhere (digests only).
 */

const crypto = require('crypto');

const TTL_MS = Number(process.env.INTEGRATION_IDEMPOTENCY_TTL_MS || 30 * 60 * 1000); // 30 min
const MAX_ENTRIES = Number(process.env.INTEGRATION_IDEMPOTENCY_MAX || 5000);

/** stable → stable → digest. Never throws; never includes secret material (callers pass normalised inputs). */
function canonicalize(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

const digest = (value) => crypto.createHash('sha256').update(canonicalize(value)).digest('hex');

const entryKey = ({ tenantId, connectionId, operation, idempotencyKey }) =>
  `${tenantId}:${connectionId}:${operation}:${idempotencyKey}`;

/** Bounded FIFO-with-TTL store. */
const store = new Map(); // key → { state, digest, result?, error?, expiresAt }

function evictExpired() {
  const now = Date.now();
  for (const [k, v] of store) if (v.expiresAt <= now) store.delete(k);
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }
}

/**
 * Claim an idempotency slot before executing.
 * @returns {'new'|'in-flight'|'replay'|'conflict'}
 *  - new: caller must execute then settle()/fail()
 *  - in-flight: identical request is already running — do not execute
 *  - replay: completed earlier — entry.result carries the original outcome
 *  - conflict: same key, different payload — entry carries error info
 */
function claim(scope) {
  evictExpired();
  const key = entryKey(scope);
  const reqDigest = digest(scope.payload || {});
  const existing = store.get(key);
  if (existing && existing.expiresAt > Date.now()) {
    if (existing.digest !== reqDigest) return { state: 'conflict', entry: existing };
    if (existing.state === 'DONE') return { state: 'replay', entry: existing };
    return { state: 'in-flight', entry: existing };
  }
  const entry = { state: 'IN_FLIGHT', digest: reqDigest, expiresAt: Date.now() + TTL_MS };
  store.set(key, entry);
  return { state: 'new', entry };
}

function settle(scope, result) {
  const entry = store.get(entryKey(scope));
  if (!entry) return;
  entry.state = 'DONE';
  entry.result = result;
  entry.expiresAt = Date.now() + TTL_MS;
}

/** Failures release the slot so a legitimate retry can execute (permanently-failed requests are NOT cached). */
function release(scope) {
  store.delete(entryKey(scope));
}

/* --------------------------------------------------------- webhook dedupe */

/** Canonical fingerprint of one normalised inbound event, scoped to a connection. */
function webhookFingerprint({ connectionId, event }) {
  return digest({ connectionId, reference: event.reference || null, type: event.type || null, amount: event.amount ?? null, status: event.status || null });
}

/** Test/cleanup hook — clears the in-process ledger. */
function _reset() {
  store.clear();
}

function _stats() {
  return { size: store.size, ttlMs: TTL_MS, maxEntries: MAX_ENTRIES };
}

module.exports = {
  digest,
  canonicalize,
  claim,
  settle,
  release,
  entryKey,
  webhookFingerprint,
  _reset,
  _stats,
};
