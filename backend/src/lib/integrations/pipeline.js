'use strict';

/**
 * Normalised-event pipeline (PR #71) — the seam where application flows
 * consume provider events without importing provider logic.
 *
 *     Provider webhook → Gateway (verify · normalise · dedupe · record)
 *                      → pipeline.dispatch(tenantCtx, event)
 *                      → application handlers (payments, reconciliation, …)
 *
 * Handlers are named, in-process subscriptions. The Gateway hands each
 * handler an ALREADY-RESOLVED tenant context: the tenant comes from the
 * connection row the webhook authenticated against — NEVER from the payload.
 * A malicious provider event claiming another tenant's reference can
 * therefore only ever be delivered with the correct tenantId; handlers must
 * resolve internal records scoped to it.
 *
 * Failure semantics: a handler that throws does not fail the webhook (the
 * provider already delivered it; re-delivery is deduped). The failure is
 * recorded in the event log, and the dispatch outcome is stored on the event
 * so a redelivery of the SAME payload is re-dispatched when the previous
 * attempt was not fully successful (at-least-once delivery, idempotent
 * processing) and suppressed when it was.
 *
 * Phase note: this PR registers NO production handlers — wiring provider
 * events into orders/invoices remains a separately reviewed phase (same
 * boundary PR #68 documented). Tests and future phases subscribe here.
 */

const subscribers = new Map(); // label → { handler, capabilities? }

/**
 * Subscribe to normalised provider events.
 * @param {string} label - unique name (second subscription with the same label replaces the first)
 * @param {Function} handler - async ({ tenantId, connectionId, providerId, event }) => void
 * @param {object} [opts] - { capabilities: ['receiveWebhook'] } reserved for future routing
 */
function subscribe(label, handler, opts = {}) {
  if (!label || typeof handler !== 'function') throw new TypeError('pipeline.subscribe(label, handler) requires both');
  subscribers.set(String(label), { handler, capabilities: opts.capabilities || null });
  return () => subscribers.delete(String(label));
}

function unsubscribe(label) {
  return subscribers.delete(String(label));
}

function subscribersCount() {
  return subscribers.size;
}

/**
 * Run every subscriber. Returns the aggregate dispatch outcome:
 *   { status: 'OK'|'PARTIAL'|'FAILED'|'NO_HANDLERS', failures: [{ label, message }] }
 * `status` is persisted on the integration event (safe strings only).
 */
async function dispatch(ctx) {
  if (!subscribers.size) return { status: 'NO_HANDLERS', failures: [] };
  const failures = [];
  for (const [label, sub] of subscribers) {
    if (sub.capabilities && ctx.capability && !sub.capabilities.includes(ctx.capability)) continue;
    try {
      await sub.handler(ctx);
    } catch (err) {
      failures.push({ label, message: String((err && err.message) || 'Handler failed').slice(0, 300) });
    }
  }
  const executed = [...subscribers.values()].filter((s) => !s.capabilities || !ctx.capability || s.capabilities.includes(ctx.capability)).length;
  if (!executed) return { status: 'NO_HANDLERS', failures: [] };
  if (failures.length === executed) return { status: 'FAILED', failures };
  if (failures.length) return { status: 'PARTIAL', failures };
  return { status: 'OK', failures: [] };
}

/** Test helper. */
function _reset() {
  subscribers.clear();
}

module.exports = { subscribe, unsubscribe, dispatch, subscribersCount, _reset };
