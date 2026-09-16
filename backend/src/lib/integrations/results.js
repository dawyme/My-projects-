'use strict';

/**
 * Normalised provider results (PR #71).
 *
 * Provider-specific response shapes stop at the adapter boundary: everything
 * crossing into the application is normalised here into stable, documented
 * structures. Callers (invoices, orders, POS, accounting sync, the admin UI)
 * therefore never branch on which bank or PSP answered.
 *
 *   • connectionResult  — lifecycle outcome of connect / test / reconnect
 *   • paymentResult     — normalised payment / checkout outcome
 *   • transferResult    — normalised bank-transfer initiation outcome
 *   • transactionResult — normalised ledger transaction line
 *   • syncResult        — normalised synchronisation outcome
 *   • operationError    — any failure normalised to { code, category, retryable }
 *
 * PR #68 already shipped the coarse error taxonomy (CONFIG | AUTH | NETWORK |
 * PROVIDER | VALIDATION | UNSUPPORTED | INTERNAL). PR #71 refines it with
 * AUTHZ | RATE_LIMIT | TIMEOUT | UNKNOWN for callers that need to decide
 * between "re-authenticate", "back off" and "report a bug". The coarse
 * categories remain valid and stable — this is additive, never a rename.
 *
 * Safety rule for every builder here: `metadata` is provider-safe data only.
 * Secrets never enter result objects; callers additionally pass them through
 * adapter.redactForLog() before persisting (the Gateway does this).
 */

/* ------------------------------------------------------------------ statuses */

/** Payment lifecycle states every PSP/bank result normalises into. */
const PAYMENT_STATUSES = ['PENDING', 'AUTHORIZED', 'PAID', 'FAILED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'UNKNOWN'];

/** Transfer lifecycle states for banking payment-initiation flows. */
const TRANSFER_STATUSES = ['PENDING', 'SUBMITTED', 'PROCESSING', 'COMPLETED', 'FAILED', 'RETURNED', 'UNKNOWN'];

const STATUS_ALIASES = {
  // payment
  SUCCESS: 'PAID', SUCCESSFUL: 'PAID', COMPLETED: 'PAID', APPROVED: 'PAID', SETTLED: 'PAID', CAPTURED: 'PAID',
  DECLINED: 'FAILED', REJECTED: 'FAILED', ERROR: 'FAILED', EXPIRED: 'FAILED',
  CREATED: 'PENDING', OPEN: 'PENDING', IN_PROGRESS: 'PENDING', PENDING_PAYMENT: 'PENDING', WAITING: 'PENDING',
  CANCEL: 'CANCELLED', VOID: 'CANCELLED', VOIDED: 'CANCELLED',
  PARTIAL_REFUND: 'PARTIALLY_REFUNDED',
  // transfer
  SENT: 'SUBMITTED', SCHEDULED: 'PENDING', ACCEPTED: 'SUBMITTED',
  PROCESSED: 'COMPLETED', REVERSED: 'RETURNED',
};

function normalizeStatus(value, allowed, fallback) {
  const s = String(value || '').trim().toUpperCase();
  if (allowed.includes(s)) return s;
  const alias = STATUS_ALIASES[s];
  if (alias && allowed.includes(alias)) return alias;
  return fallback;
}

/* -------------------------------------------------------------------- result builders */

/** Trim safe metadata to a serialisable, bounded object (secret scrubbing is the Gateway's job). */
function safeMetadata(value) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue;
    if (typeof v === 'function' || typeof v === 'symbol') continue;
    out[k] = typeof v === 'object' ? v : v;
  }
  return out;
}

const nowIso = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)) : undefined);

/** Lifecycle outcome: success, provider, connectionId, status, safe message, error category. */
function connectionResult({ ok, provider = null, connectionId = null, status = null, message = null, error = null }) {
  const result = {
    success: Boolean(ok) && !error,
    provider,
    connectionId,
    status: error ? 'ERROR' : (status || (ok ? 'CONNECTED' : 'NOT_CONNECTED')),
    message: message || null,
  };
  if (error) result.errorCategory = error.category || 'UNKNOWN';
  return result;
}

/**
 * Payment result normalised from any PSP adapter shape.
 * Raw adapter fields (redirect url, instructions, action) are preserved so
 * existing checkout-style callers keep working while new callers use `status`.
 */
function paymentResult(raw = {}, ctx = {}) {
  const status = normalizeStatus(raw.status || (raw.paid ? 'PAID' : undefined) || (raw.action === 'manual' ? 'PENDING' : undefined), PAYMENT_STATUSES, 'PENDING');
  return {
    provider: ctx.providerId || raw.provider || null,
    externalReference: raw.reference || raw.referenceId || raw.order_reference || raw.orderReference || ctx.reference || null,
    transactionId: raw.transactionId || raw.transaction_id || null,
    internalReference: raw.internalReference || ctx.internalReference || null,
    status,
    amount: Number.isFinite(Number(raw.amount)) ? Number(raw.amount) : (ctx.amount !== undefined ? Number(ctx.amount) : null),
    currency: raw.currency ? String(raw.currency).toUpperCase().slice(0, 3) : (ctx.currency ? String(ctx.currency).toUpperCase().slice(0, 3) : null),
    action: raw.action || undefined,
    url: raw.url || undefined,
    instructions: raw.instructions || undefined,
    sandbox: Boolean(raw.sandbox),
    createdAt: nowIso(raw.createdAt || raw.created_at),
    updatedAt: nowIso(raw.updatedAt || raw.updated_at),
    metadata: safeMetadata(raw.metadata || raw.raw || {}),
  };
}

/** Transfer (payment initiation) result for banking-style adapters. */
function transferResult(raw = {}, ctx = {}) {
  return {
    provider: ctx.providerId || raw.provider || null,
    externalReference: raw.reference || raw.transferId || ctx.reference || null,
    transactionId: raw.transactionId || null,
    status: normalizeStatus(raw.status, TRANSFER_STATUSES, 'PENDING'),
    amount: Number.isFinite(Number(raw.amount)) ? Number(raw.amount) : null,
    currency: raw.currency ? String(raw.currency).toUpperCase().slice(0, 3) : null,
    sandbox: Boolean(raw.sandbox),
    timestamps: {
      initiatedAt: nowIso(raw.initiatedAt || raw.createdAt),
      expectedCompletionAt: nowIso(raw.expectedCompletionAt),
      completedAt: nowIso(raw.completedAt),
    },
    metadata: safeMetadata(raw.metadata || {}),
  };
}

/** One ledger transaction line (bank statement entry, POS sale, PSP capture…). */
function transactionResult(raw = {}, ctx = {}) {
  const type = String(raw.type || raw.transactionType || ctx.type || 'DEBIT').toUpperCase();
  return {
    provider: ctx.providerId || raw.provider || null,
    externalTransactionId: raw.externalTransactionId || raw.id || raw.transactionId || null,
    internalReference: raw.internalReference || raw.reference || null,
    amount: Number.isFinite(Number(raw.amount)) ? Number(raw.amount) : null,
    currency: raw.currency ? String(raw.currency).toUpperCase().slice(0, 3) : null,
    status: normalizeStatus(raw.status, PAYMENT_STATUSES, 'PENDING'),
    type: /^(DEBIT|CREDIT|REFUND|CHARGEBACK|FEE|TRANSFER|PAYMENT|SALE|VOID)$/.test(type) ? type : 'DEBIT',
    timestamp: nowIso(raw.timestamp || raw.date || raw.postedAt || raw.createdAt),
    counterparty: raw.counterparty || raw.description ? String(raw.counterparty || raw.description).slice(0, 200) : null,
    metadata: safeMetadata(raw.metadata || {}),
  };
}

/** Account descriptor for getAccounts(). */
function accountResult(raw = {}, ctx = {}) {
  return {
    provider: ctx.providerId || raw.provider || null,
    externalId: raw.externalId || raw.id || raw.accountId || null,
    name: raw.name ? String(raw.name).slice(0, 120) : null,
    currency: raw.currency ? String(raw.currency).toUpperCase().slice(0, 3) : null,
    maskedIdentifier: raw.maskedIdentifier || (raw.number ? `••••${String(raw.number).slice(-4)}` : null),
    type: raw.type ? String(raw.type).toUpperCase().slice(0, 30) : null,
    metadata: safeMetadata(raw.metadata || {}),
  };
}

/** Balance snapshot for getBalance(). */
function balanceResult(raw = {}, ctx = {}) {
  return {
    provider: ctx.providerId || raw.provider || null,
    accountId: raw.accountId || ctx.accountId || null,
    available: Number.isFinite(Number(raw.available)) ? Number(raw.available) : null,
    ledger: Number.isFinite(Number(raw.ledger ?? raw.ledgerBalance)) ? Number(raw.ledger ?? raw.ledgerBalance) : null,
    currency: raw.currency ? String(raw.currency).toUpperCase().slice(0, 3) : null,
    asOf: nowIso(raw.asOf || raw.retrievedAt) || new Date().toISOString(),
    sandbox: Boolean(raw.sandbox),
    metadata: safeMetadata(raw.metadata || {}),
  };
}

/** Synchronisation outcome for sync and poll flows — counts only, never payload data. */
function syncResult(raw = {}, ctx = {}) {
  const int = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.trunc(Number(v))) : 0);
  return {
    provider: ctx.providerId || raw.provider || null,
    resource: ctx.resource || raw.resource || null,
    created: int(raw.created),
    updated: int(raw.updated),
    unchanged: int(raw.unchanged ?? raw.skipped),
    failed: int(raw.failed ?? raw.errors),
    total: int(raw.total),
    truncated: Boolean(raw.truncated),
    nextCursor: raw.nextCursor ?? raw.cursor ?? null,
    completedAt: nowIso(raw.completedAt) || new Date().toISOString(),
    metadata: safeMetadata(raw.metadata || {}),
  };
}

/** Canonical inbound provider event shape used by webhook normalisation. */
function providerEvent(raw = {}, ctx = {}) {
  return {
    provider: ctx.providerId || null,
    connectionId: ctx.connectionId || null,
    tenantId: ctx.tenantId || null,
    type: String(raw.type || raw.event || '').toUpperCase() || 'PROVIDER_EVENT',
    reference: raw.reference ? String(raw.reference).slice(0, 200) : null,
    transactionId: raw.transactionId || raw.transaction_id || null,
    status: normalizeStatus(raw.status || (raw.paid ? 'PAID' : undefined), PAYMENT_STATUSES, 'UNKNOWN'),
    amount: Number.isFinite(Number(raw.amount)) ? Number(raw.amount) : null,
    currency: raw.currency ? String(raw.currency).toUpperCase().slice(0, 3) : null,
    occurredAt: nowIso(raw.occurredAt || raw.timestamp || raw.created_at),
    metadata: safeMetadata(raw.metadata || {}),
  };
}

/* ------------------------------------------------------------------ error classification */

const RETRYABLE_CATEGORIES = new Set(['NETWORK', 'TIMEOUT', 'RATE_LIMIT']);

const TIMEOUT_RE = /timed?\s*out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT|deadline exceeded/i;
const NETWORK_RE = /ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|network|fetch failed|socket hang up|getaddrinfo/i;
const RATE_RE = /rate.?limit|too many requests|throttl|429\b/i;
const AUTHZ_RE = /\bforbidden\b|\bpermission|\bnot authorized\b|insufficient|scope|\b403\b|access denied|not permitted/i;
const AUTH_RE = /\bunauthor(ized|ised)\b|\binvalid (api )?key|\binvalid credentials|\bauth(entication)? fail|bad credentials|token (expired|invalid)|401\b/i;
const VALIDATION_RE = /\binvalid (request|input|parameter|amount|field)|validation|unprocessable|422\b|\b400\b|missing required/i;
const PROVIDER_RE = /\b5\d\d\b|service unavailable|bad gateway|gateway time|server error|declined|do not honour/i;

/**
 * Classify ANY thrown value into the Gateway error taxonomy.
 * Inspects (in order): an already-normalised IntegrationError (passthrough),
 * HTTP-like status codes, error codes, then message heuristics.
 * Returns { category, retryable, status, code }.
 */
function classifyError(err) {
  // eslint-disable-next-line global-require
  const { IntegrationError } = require('./base');
  // Any Gateway IntegrationError subclass (incl. UnsupportedCapability /
  // NotConnected / Config / Webhook errors) passes through unchanged —
  // adapters have already declared the authoritative classification.
  if (err instanceof IntegrationError && err.category) {
    return { category: err.category, retryable: Boolean(err.retryable), status: err.status || 502, code: err.code || 'INTEGRATION_ERROR' };
  }
  const status = Number(err && (err.status ?? err.statusCode ?? err.response?.status));
  const code = String((err && (err.code || err.errorCode || err.body?.code)) || '');
  const message = String((err && err.message) || '');
  const name = String((err && err.name) || '');

  let category = 'UNKNOWN';
  let retryable = false;
  let httpStatus = 502;

  if (name === 'AbortError' || name === 'TimeoutError' || TIMEOUT_RE.test(code) || TIMEOUT_RE.test(message)) {
    category = 'TIMEOUT'; retryable = true; httpStatus = 504;
  } else if (status === 429 || RATE_RE.test(message) || /RATE_LIMIT/i.test(code)) {
    category = 'RATE_LIMIT'; retryable = true; httpStatus = 429;
  } else if (status >= 500 && status <= 599) {
    category = 'PROVIDER'; retryable = true; httpStatus = 502;
  } else if (status === 401) {
    category = 'AUTH'; retryable = false; httpStatus = 401;
  } else if (status === 403) {
    category = 'AUTHZ'; retryable = false; httpStatus = 403;
  } else if (status === 404) {
    category = 'PROVIDER'; retryable = false; httpStatus = 404;
  } else if (status === 400 || status === 422) {
    category = 'VALIDATION'; retryable = false; httpStatus = 400;
  } else if (NETWORK_RE.test(code) || NETWORK_RE.test(message)) {
    category = 'NETWORK'; retryable = true; httpStatus = 502;
  } else if (AUTH_RE.test(message)) {
    category = 'AUTH'; retryable = false; httpStatus = 401;
  } else if (AUTHZ_RE.test(message)) {
    category = 'AUTHZ'; retryable = false; httpStatus = 403;
  } else if (VALIDATION_RE.test(message)) {
    category = 'VALIDATION'; retryable = false; httpStatus = 400;
  } else if (PROVIDER_RE.test(message)) {
    category = 'PROVIDER'; retryable = true; httpStatus = 502;
  }

  let outCode = code && /^[A-Z0-9_]{3,60}$/.test(code) ? code : null;
  if (!outCode) {
    outCode = {
      AUTH: 'PROVIDER_AUTH_FAILED', AUTHZ: 'PROVIDER_ACCESS_DENIED', VALIDATION: 'PROVIDER_VALIDATION_FAILED',
      RATE_LIMIT: 'PROVIDER_RATE_LIMITED', TIMEOUT: 'PROVIDER_TIMEOUT', NETWORK: 'PROVIDER_UNREACHABLE',
      PROVIDER: 'PROVIDER_ERROR', UNKNOWN: 'PROVIDER_ERROR',
    }[category] || 'PROVIDER_ERROR';
  }
  return { category, retryable, status: httpStatus, code: outCode };
}

/** Whether the framework may auto-retry an error of this classification. */
const isRetryableError = (info) => Boolean(info && (info.retryable || RETRYABLE_CATEGORIES.has(info.category)));

/** Stable, browser-safe error body for HTTP responses. Never contains secrets. */
function errorResult(err, { providerId = null } = {}) {
  const info = classifyError(err);
  return {
    code: info.code,
    category: info.category,
    retryable: info.retryable,
    provider: providerId,
    message: String((err && err.message) || 'The provider request failed.').slice(0, 300),
  };
}

module.exports = {
  PAYMENT_STATUSES,
  TRANSFER_STATUSES,
  RETRYABLE_CATEGORIES,
  normalizeStatus,
  connectionResult,
  paymentResult,
  transferResult,
  transactionResult,
  accountResult,
  balanceResult,
  syncResult,
  providerEvent,
  classifyError,
  isRetryableError,
  errorResult,
};
