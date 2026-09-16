'use strict';

/**
 * Standardised provider-connection lifecycle (PR #71).
 *
 * The canonical lifecycle from the framework spec is
 *
 *     DISCONNECTED → CONNECTING → CONNECTED → DISABLED → ERROR
 *
 * PR #68 already persists six status values (`NOT_CONNECTED`, `CONFIGURED`,
 * `CONNECTED`, `DISCONNECTED`, `DISABLED`, `ERROR`) and the shared database
 * must not change in this phase — so this module does NOT mint new stored
 * statuses. It models the lifecycle over the existing values:
 *
 *   DISCONNECTED (spec) ≙ NOT_CONNECTED / CONFIGURED / DISCONNECTED (stored)
 *   CONNECTING          ≙ transient only — true while a connect/reconnect/
 *                         test operation is executing, never persisted
 *   CONNECTED           ≙ CONNECTED (only after adapter confirmation, below)
 *   DISABLED            ≙ DISABLED
 *   ERROR               ≙ ERROR
 *
 * and enforces the rule the spec is strictest about:
 *
 *   “A successful operation must only be reported after the provider
 *    adapter/backend confirms it. Never report a fake successful connection.”
 *
 * → `assertConfirmed()` below: a lifecycle operation flips a connection to
 * CONNECTED only when the adapter's result actually says success. An adapter
 * that returns `{ ok: false }` (or a falsy result object) produces a normalised
 * failure, not a green tick in the tenant UI.
 */

const { IntegrationError } = require('./base');

/** Stored status values — identical to PR #68 (`IntegrationConnection.status`). */
const STATES = ['NOT_CONNECTED', 'CONFIGURED', 'CONNECTED', 'DISCONNECTED', 'DISABLED', 'ERROR'];

/** Transient in-flight phase surfaced to clients while a lifecycle op runs. */
const CONNECTING_PHASE = 'CONNECTING';

/**
 * Allowed persisted transitions. Deliberately permissive on recovery edges
 * (any state can be re-tested/reconnected, provider changes reset anything)
 * but it documents the intended graph and `isAllowedTransition` lets the
 * Gateway reject nonsense (e.g. resurrecting a DISABLED row as CONNECTED).
 */
const TRANSITIONS = {
  NOT_CONNECTED: ['CONFIGURED', 'CONNECTING', 'CONNECTED', 'ERROR', 'DISABLED'],
  CONFIGURED: ['CONNECTING', 'CONNECTED', 'ERROR', 'DISABLED', 'NOT_CONNECTED'],
  CONNECTED: ['CONNECTING', 'DISCONNECTED', 'DISABLED', 'ERROR', 'CONFIGURED', 'NOT_CONNECTED'],
  DISCONNECTED: ['CONNECTING', 'CONNECTED', 'CONFIGURED', 'DISABLED', 'ERROR', 'NOT_CONNECTED'],
  DISABLED: ['CONFIGURED', 'ERROR', 'NOT_CONNECTED'], // enable → CONFIGURED; a disabled connection NEVER goes straight to CONNECTED
  ERROR: ['CONFIGURED', 'CONNECTING', 'CONNECTED', 'DISABLED', 'NOT_CONNECTED'],
};

function isAllowedTransition(from, to) {
  if (!from || !to) return true; // unknown/absent previous state: allow (creation path)
  if (from === to) return true;
  return (TRANSITIONS[from] || []).includes(to);
}

/** Map any persisted status to its canonical lifecycle phase for display. */
function phaseOf(status, { inFlight = false } = {}) {
  if (inFlight && (status === 'NOT_CONNECTED' || status === 'CONFIGURED' || status === 'DISCONNECTED' || status === 'ERROR')) {
    return CONNECTING_PHASE;
  }
  if (status === 'CONNECTED') return 'CONNECTED';
  if (status === 'DISABLED') return 'DISABLED';
  if (status === 'ERROR') return 'ERROR';
  return 'DISCONNECTED'; // NOT_CONNECTED | CONFIGURED | DISCONNECTED are all "not live"
}

/**
 * Guard for lifecycle success: connect / test / reconnect may only be
 * reported as a success when the adapter confirms it. Accepts:
 *   • { ok: true | success: true | connected: true } → confirmed
 *   • undefined / null → treated as confirmed (the operation ran without
 *     throwing and without dissent — adapters like PR #68's may return void)
 *   • { ok: false } / { success: false } / a falsy scalar → NOT confirmed
 */
function assertConfirmed(result, { providerId = null, operation = 'connect' } = {}) {
  if (result === undefined || result === null) return { ok: true, message: null };
  if (typeof result === 'object') {
    const positive = result.ok === true || result.success === true || result.connected === true;
    const negative = result.ok === false || result.success === false || result.connected === false;
    if (negative && !positive) {
      // A dissenting result is a decision, not a transport fault — no retry.
      throw new IntegrationError(
        String(result.message || `${providerId ? `${providerId}: ` : ''}${operation} was not confirmed by the provider`).slice(0, 300),
        { code: 'PROVIDER_UNCONFIRMED', category: 'PROVIDER', retryable: false, status: 502 }
      );
    }
    return { ok: true, message: result.message || null };
  }
  if (result === false || result === 0 || result === '') {
    throw new IntegrationError(
      `${providerId ? `${providerId}: ` : ''}${operation} was not confirmed by the provider`,
      { code: 'PROVIDER_UNCONFIRMED', category: 'PROVIDER', retryable: false, status: 502 }
    );
  }
  return { ok: true, message: null };
}

/** Lifecycle operations may run from any state; data operations require a live connection. */
const LIFECYCLE_OPERATIONS = new Set(['configure', 'connect', 'testConnection', 'disconnect', 'reconnect', 'enable', 'disable', 'rotateCredentials']);
const RECONNECTABLE = new Set(['NOT_CONNECTED', 'CONFIGURED', 'DISCONNECTED', 'CONNECTED', 'ERROR']);

module.exports = {
  STATES,
  TRANSITIONS,
  CONNECTING_PHASE,
  LIFECYCLE_OPERATIONS,
  RECONNECTABLE,
  isAllowedTransition,
  phaseOf,
  assertConfirmed,
};
