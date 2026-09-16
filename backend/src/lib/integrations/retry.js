'use strict';

/**
 * Bounded retry executor for provider operations (PR #71).
 *
 * Retrying is safe only where re-issuing the request cannot duplicate an
 * effect, so the policy is driven by the OPERATION, not by caller hope:
 *
 *   • safe read/status/test/sync operations retry on retryable failures
 *     (NETWORK, TIMEOUT, RATE_LIMIT, transient 5xx PROVIDER);
 *   • WRITE operations (payments, refunds, transfers, imports) retry only
 *     when the adapter explicitly declares `providerIdempotency = true` —
 *     meaning the provider itself deduplicates by the reference we send.
 *     Without that guarantee a timeout on createPayment may mean "the money
 *     moved" — resending could double-charge, so the Gateway does not.
 *   • Non-retryable categories (AUTH, AUTHZ, CONFIG, VALIDATION,
 *     UNSUPPORTED, UNKNOWN) never retry — bounded, no uncontrolled loops.
 *
 * Every attempt after the first is reported through `onRetry` so the Gateway
 * can record it in the existing IntegrationEvent log. Backoff is exponential
 * with jitter, hard-capped, and configurable per deployment.
 */

const MAX_ATTEMPTS_CEILING = 6; // total tries, including the first — never exceeded

const envInt = (name, fallback) => {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Capabilities whose invocation has no side effect at the provider → safe to retry. */
const SAFE_RETRY_CAPABILITIES = new Set([
  'configure', 'connect', 'testConnection', 'disconnect',
  'getPaymentStatus', 'verifyPayment',
  'getAccounts', 'getBalance', 'getTransactions', 'getTransferStatus', 'verifyAccount',
  'getPosTransaction', 'reconcile',
  'syncCustomers', 'syncProducts', 'syncInventory', 'syncInvoices', 'syncPayments',
  'pollSync', 'receiveWebhook',
]);

/** Capabilities that mutate provider state → retry only with provider-side idempotency. */
const WRITE_CAPABILITIES = new Set([
  'createPayment', 'capturePayment', 'refundPayment', 'voidPayment',
  'createPaymentLink', 'initiateTransfer',
  'createPosTransaction', 'importStatement',
]);

/**
 * Resolve the retry policy for one operation invocation.
 * @returns {{ retries: number, baseDelayMs: number, maxDelayMs: number } | null}
 *          null when the operation must not be retried at all.
 */
function policyFor({ capability, providerIdempotency = false, overrides = {} } = {}) {
  const eligible = SAFE_RETRY_CAPABILITIES.has(capability)
    || (WRITE_CAPABILITIES.has(capability) && providerIdempotency);
  if (!eligible) return null;
  const retries = Math.min(MAX_ATTEMPTS_CEILING - 1, envInt('INTEGRATION_RETRY_ATTEMPTS', 2));
  return {
    retries: overrides.retries !== undefined ? Math.min(MAX_ATTEMPTS_CEILING - 1, Math.max(0, Number(overrides.retries))) : retries,
    baseDelayMs: overrides.baseDelayMs !== undefined ? Number(overrides.baseDelayMs) : envInt('INTEGRATION_RETRY_BASE_MS', 250),
    maxDelayMs: overrides.maxDelayMs !== undefined ? Number(overrides.maxDelayMs) : envInt('INTEGRATION_RETRY_MAX_MS', 8000),
  };
}

/**
 * PR #71: NETWORK/TIMEOUT/RATE_LIMIT are the canonical retryable categories;
 * transient PROVIDER 5xx may also carry retryable=true. Adapters may throw
 * RAW errors (fetch rejections, HTTP libs) — classify them with the same
 * rules the Gateway applies AFTER the executor, so retry decisions match the
 * normalised outcome no matter which shape the adapter used.
 */
function isRetryableError(err) {
  if (!err) return false;
  if (err.retryable === true) return true;
  if (err.retryable === false || err.category) return false;
  // eslint-disable-next-line global-require
  const results = require('./results');
  return results.classifyError(err).retryable === true;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with full jitter, bounded by maxDelayMs. */
function backoffDelay(attempt, { baseDelayMs, maxDelayMs }) {
  const capped = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.round(Math.random() * capped);
}

/**
 * Execute `fn` with bounded retries.
 * @param {Function} fn - async operation; receives the zero-based attempt index.
 * @param {object} opts - { policy, isRetryable, onRetry }
 *   onRetry({ attempt, maxAttempts, delayMs, error }) — fired before each sleep.
 * @returns {Promise<any>} the first successful result, or the final error thrown.
 */
async function executeWithRetry(fn, { policy, isRetryable = isRetryableError, onRetry = null } = {}) {
  const retries = policy ? Math.max(0, policy.retries) : 0;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= retries || !isRetryable(err)) throw err;
      const delayMs = backoffDelay(attempt, policy);
      if (onRetry) {
        try { await onRetry({ attempt: attempt + 1, maxAttempts: retries + 1, delayMs, error: err }); }
        catch (_) { /* retry telemetry must never mask the operation itself */ }
      }
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

module.exports = {
  MAX_ATTEMPTS_CEILING,
  SAFE_RETRY_CAPABILITIES,
  WRITE_CAPABILITIES,
  policyFor,
  isRetryableError,
  executeWithRetry,
  backoffDelay,
};
