/**
 * Provider Integration Framework (PR #71) — verification.
 *
 * Covers the framework layer built on the PR #68 Universal Integration
 * Gateway without replacing it:
 *
 *   • registry — discovery, metadata, capabilities, duplicate handling
 *   • configuration schema — required/optional/secret fields, validation,
 *     rotation and clear semantics (metadata-driven, no provider UI forms)
 *   • lifecycle — connect / test / enable / disable / disconnect / reconnect,
 *     including the rule that success is only ever reported after the
 *     provider adapter CONFIRMS it
 *   • capabilities — supported vs unsupported operations fail safely
 *   • error normalisation — AUTH, AUTHZ, VALIDATION, TIMEOUT, NETWORK,
 *     RATE_LIMIT, PROVIDER categories map to stable HTTP + event data
 *   • idempotency — duplicate requests replay instead of re-executing;
 *     duplicate webhooks produce one internal effect
 *   • retry — bounded retries for retryable failures, none for
 *     non-retryable ones, attempts recorded in the integration event log
 *   • security — secrets never exposed, tenant isolation in both
 *     directions, RBAC, webhook verification before dedupe/parsing
 *   • proof providers — MANUAL_BANK_TRANSFER and SANDBOX_DEMO keep working
 *     through the new framework paths
 *
 * All extra providers here are TEST FIXTURES registered in-process and
 * unregistered at the end — no real-world bank, PSP or POS API is pretended
 * to exist, and no network is ever touched.
 *
 *   node backend/tests/provider-framework.test.js
 */
require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// Fast, deterministic backoff for the retry checks; generous budgets for
// request limits (widened here rather than weakening the app).
process.env.INTEGRATION_RETRY_BASE_MS = '1';
process.env.INTEGRATION_RETRY_MAX_MS = '3';
process.env.RATE_LIMIT_API_MAX = process.env.RATE_LIMIT_API_MAX || '20000';
process.env.RATE_LIMIT_WRITE_MAX = process.env.RATE_LIMIT_WRITE_MAX || '20000';

const app = require('../src/app');
const prisma = require('../src/lib/prisma');
const registry = require('../src/lib/integrations/registry');
const gateway = require('../src/lib/integrations/gateway');
const base = require('../src/lib/integrations/base');
const fields = require('../src/lib/integrations/fields');
const results = require('../src/lib/integrations/results');
const retry = require('../src/lib/integrations/retry');
const idempotency = require('../src/lib/integrations/idempotency');
const lifecycle = require('../src/lib/integrations/lifecycle');
const pipeline = require('../src/lib/integrations/pipeline');
const { _resetSandboxLedger } = require('../src/lib/integrations/adapters/sandbox-psp');

let base_ = ''; // HTTP origin (named to avoid shadowing base.js module)
const resultsLog = [];
let failures = 0;
const suiteStart = new Date();
const trackedConnectionIds = [];
const registeredFixtures = [];

async function test(name, fn) {
  try { await fn(); resultsLog.push(['PASS', name]); }
  catch (e) { failures++; resultsLog.push(['FAIL', `${name} — ${e.message}`]); }
}

function makeClient() {
  const jar = new Map();
  let csrf = null;
  let bearer = null;
  return {
    setBearer(t) { bearer = t; },
    async req(method, path, body, opts = {}) {
      const headers = { ...(opts.headers || {}) };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookie) headers.Cookie = cookie;
      if (csrf) headers['x-csrf-token'] = csrf;
      if (bearer && !opts.noBearer) headers.Authorization = `Bearer ${bearer}`;
      const res = await fetch(base_ + path, {
        method, headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
      });
      for (const c of res.headers.getSetCookie?.() || []) {
        const [pair] = c.split(';');
        const idx = pair.indexOf('=');
        jar.set(pair.slice(0, idx), pair.slice(idx + 1));
        if (pair.startsWith('hvac_csrf=')) csrf = pair.slice('hvac_csrf='.length);
      }
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) {}
      return { status: res.status, body: json, text };
    },
    get(p, o) { return this.req('GET', p, undefined, o); },
    post(p, b, o) { return this.req('POST', p, b, o); },
    put(p, b, o) { return this.req('PUT', p, b, o); },
    patch(p, b, o) { return this.req('PATCH', p, b, o); },
    del(p, o) { return this.req('DELETE', p, undefined, o); },
  };
}

function signHmac(secret, rawBody) {
  return `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

/* ======================================================================
 * Test-fixture providers — registered only for this run, unregistered in
 * cleanup. They emulate provider behaviours the framework must handle:
 * flaky transport, auth failures, rate limits, unconfirmed results,
 * required-credential banks, POS sync and file import.
 * ==================================================================== */

const {
  IntegrationProvider,
} = base;

class FlakyBankProvider extends IntegrationProvider {
  static id = 'FLAKY_BANK';
  static label = 'Flaky Test Bank';
  static description = 'Test fixture: two retryable transport failures, then success.';
  static category = 'BANK';
  static connectionMethods = ['API_KEY'];
  static authTypes = ['NONE', 'API_KEY'];
  static capabilities = ['testConnection', 'disconnect', 'getBalance', 'createPayment'];
  static state = { balanceCalls: 0, payCalls: 0 };

  async testConnection() { return { ok: true, message: 'flaky ok' }; }
  async getBalance() {
    FlakyBankProvider.state.balanceCalls += 1;
    if (FlakyBankProvider.state.balanceCalls <= 2) throw new Error('simulated fetch failed: ECONNRESET');
    return { available: 500.25, currency: 'TTD', asOf: new Date().toISOString() };
  }
  async createPayment(payment) {
    FlakyBankProvider.state.payCalls += 1;
    if (FlakyBankProvider.state.payCalls === 1) throw new Error('socket hang up');
    return { action: 'manual', reference: payment.reference, status: 'PENDING', sandbox: false };
  }
}

class BadAuthBankProvider extends IntegrationProvider {
  static id = 'BADAUTH_BANK';
  static label = 'Bad Auth Test Bank';
  static category = 'BANK';
  static capabilities = ['testConnection', 'getBalance', 'getTransferStatus'];
  static calls = { balance: 0 };
  async testConnection() { return { ok: true }; }
  async getBalance() {
    BadAuthBankProvider.calls.balance += 1;
    throw Object.assign(new Error('invalid api key'), { status: 401 });
  }
  async getTransferStatus(reference) {
    return { status: 'UNKNOWN', reference };
  }
}

class RateLimitedBankProvider extends IntegrationProvider {
  static id = 'RATELIMIT_BANK';
  static label = 'Rate Limited Test Bank';
  static category = 'BANK';
  static capabilities = ['testConnection', 'getBalance'];
  static calls = 0;
  async testConnection() { return { ok: true }; }
  async getBalance() {
    RateLimitedBankProvider.calls += 1;
    throw Object.assign(new Error('429 Too Many Requests — slow down'), { status: 429 });
  }
}

class UnconfirmedBankProvider extends IntegrationProvider {
  static id = 'UNCONFIRMED_BANK';
  static label = 'Unconfirmed Test Bank';
  static category = 'BANK';
  static capabilities = ['connect', 'testConnection'];
  static calls = 0;
  async connect() { return { ok: false, message: 'bank declined the handshake' }; }
  async testConnection() {
    UnconfirmedBankProvider.calls += 1;
    return { ok: false, message: 'bank declined the verification' };
  }
}

class StrictBankProvider extends IntegrationProvider {
  static id = 'STRICT_BANK';
  static label = 'Strict Credential Test Bank';
  static category = 'BANK';
  static connectionMethods = ['API_KEY', 'OAUTH2'];
  static authTypes = ['NONE', 'API_KEY', 'OAUTH2'];
  static capabilities = ['configure', 'connect', 'testConnection', 'disconnect'];
  static requiresCredentials = true;
  static credentialFields = [
    { name: 'apiKey', label: 'API key', type: 'password', required: true },
    { name: 'clientSecret', label: 'Client secret', type: 'password', required: true },
    { name: 'optionalToken', label: 'Optional token', type: 'password', required: false },
  ];
  static configFields = [
    { name: 'environment', label: 'Environment', type: 'select', required: true, options: ['sandbox', 'live'], environmentSpecific: true },
    { name: 'merchantId', label: 'Merchant ID', type: 'text', required: false, maxLength: 30, pattern: '^[A-Z0-9\\-]+$' },
  ];
  async validateCredentials(creds) {
    if (String(creds.apiKey || '').startsWith('bad-')) return { ok: false, message: 'key format rejected' };
    return { ok: true };
  }
  async testConnection() {
    this.requireCredentials();
    return { ok: true, message: 'strict bank ok' };
  }
}

class IdemPspProvider extends IntegrationProvider {
  static id = 'IDEM_PSP';
  static label = 'Idempotent Test PSP';
  static category = 'PSP';
  static providerIdempotency = true; // the "provider" dedupes by reference
  static capabilities = ['testConnection', 'createPayment', 'getPaymentStatus', 'refundPayment'];
  static state = { payCalls: 0, seq: 0, refunds: 0, seen: new Map() };
  async testConnection() { return { ok: true }; }
  async createPayment(payment) {
    IdemPspProvider.state.payCalls += 1;
    const key = `idem-${payment.reference}`;
    if (IdemPspProvider.state.seen.has(key)) return IdemPspProvider.state.seen.get(key); // provider-side dedupe
    IdemPspProvider.state.seq += 1;
    const out = {
      action: 'redirect', url: `https://idem.invalid/checkout/${payment.reference}`,
      reference: payment.reference, transactionId: `IDEM-TX-${IdemPspProvider.state.seq}`,
      status: 'PENDING', sandbox: true,
    };
    IdemPspProvider.state.seen.set(key, out);
    return out;
  }
  async refundPayment(reference) {
    IdemPspProvider.state.refunds += 1;
    return { refunded: true, refundReference: `IDEM-RF-${IdemPspProvider.state.refunds}`, amount: 5 };
  }
}

class SyncPosProvider extends IntegrationProvider {
  static id = 'SYNC_POS';
  static label = 'Sync Test POS';
  static category = 'POS';
  static capabilities = ['testConnection', 'syncProducts', 'syncInventory', 'syncCustomers', 'createPosTransaction', 'getPosTransaction'];
  static state = { syncCalls: 0 };
  async testConnection() { return { ok: true }; }
  async syncProducts() {
    SyncPosProvider.state.syncCalls += 1;
    return { created: 2, updated: 1, unchanged: 5, failed: 0, total: 8, nextCursor: 'cursor-2' };
  }
  async syncInventory() { return { created: 0, updated: 4, total: 4 }; }
  async syncCustomers() { throw new Error('customers export disabled for this POS plan'); }
  async createPosTransaction(t) {
    return { externalTransactionId: t.reference || 'pos-1', amount: 12.5, currency: 'TTD', status: 'PAID', type: 'SALE' };
  }
  async getPosTransaction(reference) {
    return { externalTransactionId: `pos-${reference}`, amount: 12.5, currency: 'TTD', status: 'PAID', type: 'SALE' };
  }
}

class FileImportBankProvider extends IntegrationProvider {
  static id = 'FILEBANK_IMPORT';
  static label = 'File Import Test Bank';
  static category = 'BANK';
  static connectionMethods = ['FILE_IMPORT', 'SFTP'];
  static capabilities = ['testConnection', 'importStatement', 'reconcile'];
  async testConnection() { return { ok: true }; }
  async importStatement(payload = {}) {
    let rows = [];
    if (Array.isArray(payload.rows)) rows = payload.rows;
    else if (typeof payload.contents === 'string') {
      rows = payload.contents.split('\n').filter((l) => l.trim() && !l.toLowerCase().startsWith('ref,'));
    }
    return { created: rows.length, updated: 0, unchanged: 0, total: rows.length };
  }
  async reconcile() { return { rows: 3, note: 'statement file available' }; }
}

const FIXTURES = [
  FlakyBankProvider, BadAuthBankProvider, RateLimitedBankProvider,
  UnconfirmedBankProvider, StrictBankProvider, IdemPspProvider,
  SyncPosProvider, FileImportBankProvider,
];

function registerFixtures() {
  for (const F of FIXTURES) { registry.register(F, { source: 'test', force: false }); registeredFixtures.push(F.id); }
}
function unregisterFixtures() {
  for (const id of registeredFixtures) registry.unregister(id);
}

/* ================================ main ================================ */

async function main() {
  _resetSandboxLedger();
  registerFixtures();

  /* ---------------- unit: fields / configuration schema ---------------- */
  await test('unit: normalizeField fills safe defaults and keeps raw extras', () => {
    const f = fields.normalizeField({ name: 'apiKey', label: 'API key', type: 'password', required: true, help: 'paste me' }, { kind: 'credential' });
    assert.strictEqual(f.secret, true);
    assert.strictEqual(f.writeOnly, true);
    assert.strictEqual(f.supportsRotation, true);
    assert.strictEqual(f.supportsClearing, true);
    assert.strictEqual(f.environmentSpecific, false);
    assert.strictEqual(f.help, 'paste me');
    assert.deepStrictEqual(f.validation, { required: true });
    const opt = fields.normalizeField({ name: 'region', type: 'text' }, { kind: 'config' });
    assert.strictEqual(opt.required, false);
    assert.strictEqual(opt.secret, false);
    assert.strictEqual(opt.supportsClearing, true);
  });

  await test('unit: validateConfiguration enforces required, type, length, pattern, options', () => {
    const { configFields, credentialFields } = StrictBankProvider.getConfigurationSchema();
    const bad = fields.validateConfiguration({
      configFields, credentialFields,
      config: { environment: 'nope', merchantId: 'lowercase!' },
      credentials: {},
    });
    assert.strictEqual(bad.ok, false);
    const byField = new Map(bad.errors.map((e) => [e.field, e.message]));
    assert.match(byField.get('environment') || '', /one of/);
    assert.match(byField.get('merchantId') || '', /Invalid format/);
    assert.ok(bad.errors.some((e) => e.field === 'apiKey' && /required/i.test(e.message)));
    assert.ok(bad.errors.some((e) => e.field === 'clientSecret'));
    const good = fields.validateConfiguration({
      configFields, credentialFields,
      config: { environment: 'sandbox', merchantId: 'M-1' },
      credentials: { apiKey: 'k', clientSecret: 's' },
    });
    assert.strictEqual(good.ok, true, JSON.stringify(good.errors));
    assert.deepStrictEqual(good.credentialKeys.provided.sort(), ['apiKey', 'clientSecret']);
    // Values are never echoed by the validator output.
    const serialised = JSON.stringify(good);
    assert.ok(!serialised.includes('"k"') && !serialised.includes('"s"'), 'validator leaked credential values');
  });

  await test('unit: provider schema exposure is metadata-only and wizard-shaped', () => {
    const schema = registry.getConfigurationSchema('SANDBOX_DEMO');
    assert.strictEqual(schema.providerId, 'SANDBOX_DEMO');
    assert.strictEqual(schema.version, '1.1.0');
    assert.deepStrictEqual(schema.environments, ['SANDBOX']);
    assert.ok(schema.docs && typeof schema.docs.guide === 'string');
    const key = schema.credentialFields.find((f) => f.name === 'apiKey');
    assert.strictEqual(key.secret, true);
    assert.strictEqual(key.writeOnly, true);
    assert.strictEqual(key.supportsRotation, true);
    assert.strictEqual(registry.getConfigurationSchema('NOPE_NOPE'), null);
  });

  /* ---------------- unit: registry extensions ---------------- */
  await test('unit: duplicate registration — same class no-op, different class conflicts, force replaces', () => {
    assert.strictEqual(registry.register(FlakyBankProvider, { source: 'test' }), 'FLAKY_BANK'); // same class → no-op
    class Imposter extends IntegrationProvider { static id = 'FLAKY_BANK'; static category = 'BANK'; }
    assert.throws(() => registry.register(Imposter), TypeError);
    registry.register(Imposter, { force: true });
    assert.strictEqual(registry.get('FLAKY_BANK'), Imposter);
    registry.register(FlakyBankProvider, { source: 'test', force: true }); // restore
    assert.strictEqual(registry.get('FLAKY_BANK'), FlakyBankProvider);
  });

  await test('unit: registry discovery APIs — metadata, capabilities, support checks, validate', () => {
    const meta = registry.getMetadata('SYNC_POS');
    assert.strictEqual(meta.category, 'POS');
    assert.ok(meta.capabilities.some((c) => c.id === 'syncProducts' && c.supported));
    assert.ok(meta.capabilities.find((c) => c.id === 'syncProducts').groups.includes('pos'));
    assert.deepStrictEqual(registry.declaredCapabilities('MANUAL_BANK_TRANSFER').sort(),
      ['configure', 'connect', 'createPayment', 'disconnect', 'testConnection'].sort());
    assert.strictEqual(registry.supportsOperation('SANDBOX_DEMO', 'receiveWebhook'), true);
    assert.strictEqual(registry.supportsOperation('SANDBOX_DEMO', 'getBalance'), false);
    assert.strictEqual(registry.supportsOperation('NOT_A_PROVIDER', 'getBalance'), false);
    assert.ok(registry.ids().includes('IDEM_PSP'));
    const v = registry.validate(SyncPosProvider);
    assert.strictEqual(v.ok, true);
    class Bad extends IntegrationProvider {
      static id = 'BAD_UNIT';
      static category = 'BANK';
      static capabilities = ['teleport'];
    }
    const bad = registry.validate(Bad);
    assert.strictEqual(bad.ok, false);
    assert.ok(bad.problems.some((p) => /teleport/.test(p)));
    assert.strictEqual(registry.entry('MANUAL_BANK_TRANSFER').source, 'builtin');
  });

  /* ---------------- unit: results normalisation ---------------- */
  await test('unit: error classification covers the framework categories', () => {
    const c = (e) => results.classifyError(e);
    assert.strictEqual(c(Object.assign(new Error('x'), { status: 401 })).category, 'AUTH');
    assert.strictEqual(c(Object.assign(new Error('x'), { status: 403 })).category, 'AUTHZ');
    assert.strictEqual(c(new Error('invalid credentials supplied')).category, 'AUTH');
    assert.strictEqual(c(new Error('insufficient scope for this operation')).category, 'AUTHZ');
    assert.strictEqual(c(new Error('invalid amount')).category, 'VALIDATION');
    assert.strictEqual(c(Object.assign(new Error('x'), { name: 'TimeoutError' })).category, 'TIMEOUT');
    assert.strictEqual(c(new Error('fetch failed: ENOTFOUND')).category, 'NETWORK');
    assert.strictEqual(c(Object.assign(new Error('slow down'), { status: 429 })).category, 'RATE_LIMIT');
    assert.strictEqual(c(Object.assign(new Error('boom'), { status: 502 })).category, 'PROVIDER');
    assert.strictEqual(c(new Error('something odd')).category, 'UNKNOWN');
    // retryable flags: transport-ish true, auth/validation false
    assert.strictEqual(results.isRetryableError(c(new Error('ETIMEDOUT'))), true);
    assert.strictEqual(results.isRetryableError(c(Object.assign(new Error('nope'), { status: 401 }))), false);
    // IntegrationError subclasses pass through unchanged.
    const unsupported = new base.UnsupportedCapabilityError('X', 'getBalance');
    assert.strictEqual(c(unsupported).category, 'UNSUPPORTED');
    assert.strictEqual(c(unsupported).retryable, false);
  });

  await test('unit: payment/transaction/sync/connection normalisation', () => {
    const pay = results.paymentResult({ status: 'SUCCESS', reference: 'R9', amount: '42.50', currency: 'ttd', transaction_id: 'TX9', metadata: { x: 1 } }, { providerId: 'ANY' });
    assert.strictEqual(pay.status, 'PAID'); // provider aliases normalise
    assert.strictEqual(pay.amount, 42.5);
    assert.strictEqual(pay.currency, 'TTD');
    assert.strictEqual(pay.transactionId, 'TX9');
    const txn = results.transactionResult({ id: 'T1', amount: -5, currency: 'USD', type: 'refund', postedAt: '2026-01-02T00:00:00Z', description: 'Back to sender' }, { providerId: 'ANY' });
    assert.strictEqual(txn.type, 'REFUND');
    assert.strictEqual(txn.amount, -5);
    assert.strictEqual(txn.externalTransactionId, 'T1');
    const sync = results.syncResult({ created: 3, updated: 2, skipped: 4, total: 9, nextCursor: 'c9' }, { providerId: 'ANY', resource: 'products' });
    assert.deepStrictEqual([sync.created, sync.updated, sync.unchanged, sync.total, sync.nextCursor], [3, 2, 4, 9, 'c9']);
    const conn = results.connectionResult({ ok: true, provider: 'ANY', connectionId: 'c1' });
    assert.strictEqual(conn.success, true);
    assert.strictEqual(conn.status, 'CONNECTED');
    const failed = results.connectionResult({ ok: false, provider: 'ANY', error: { category: 'AUTH' } });
    assert.strictEqual(failed.status, 'ERROR');
    assert.strictEqual(failed.errorCategory, 'AUTH');
  });

  /* ---------------- unit: retry + idempotency + lifecycle ---------------- */
  await test('unit: retry policy is safe-by-operation and bounded', () => {
    assert.strictEqual(retry.policyFor({ capability: 'getBalance' }).retries, 2);
    assert.strictEqual(retry.policyFor({ capability: 'getPaymentStatus' }) !== null, true);
    assert.strictEqual(retry.policyFor({ capability: 'createPayment', providerIdempotency: false }), null); // never resend money blindly
    assert.strictEqual(retry.policyFor({ capability: 'createPayment', providerIdempotency: true }).retries, 2);
    assert.strictEqual(retry.policyFor({ capability: 'syncProducts' }) !== null, true);
    // Hard ceiling: attempts can never exceed the ceiling regardless of input.
    const big = retry.policyFor({ capability: 'getBalance', overrides: { retries: 999 } });
    assert.ok(big.retries <= retry.MAX_ATTEMPTS_CEILING - 1);
  });

  await test('unit: retry executor stops at the first non-retryable failure', async () => {
    let calls = 0;
    const err = new base.IntegrationError('nope', { category: 'AUTH', retryable: false });
    await assert.rejects(retry.executeWithRetry(async () => { calls += 1; throw err; }, { policy: retry.policyFor({ capability: 'getBalance' }) }), /nope/);
    assert.strictEqual(calls, 1);
    calls = 0;
    const ok = await retry.executeWithRetry(async () => {
      calls += 1;
      if (calls < 3) throw new base.IntegrationError('flaky', { category: 'NETWORK', retryable: true });
      return 'done';
    }, { policy: retry.policyFor({ capability: 'getBalance' }) });
    assert.strictEqual(ok, 'done');
    assert.strictEqual(calls, 3);
  });

  await test('unit: idempotency ledger — claim, replay, conflict, release', () => {
    const scope = { tenantId: 'u1', connectionId: 'c1', operation: 'createPayment', idempotencyKey: 'unit-key-1', payload: { amount: 1 } };
    assert.strictEqual(idempotency.claim(scope).state, 'new');
    assert.strictEqual(idempotency.claim(scope).state, 'in-flight');
    idempotency.settle(scope, { ok: true, reference: 'R' });
    const replay = idempotency.claim(scope);
    assert.strictEqual(replay.state, 'replay');
    assert.deepStrictEqual(replay.entry.result, { ok: true, reference: 'R' });
    const conflict = idempotency.claim({ ...scope, payload: { amount: 2 } });
    assert.strictEqual(conflict.state, 'conflict');
    idempotency.release(scope);
    assert.strictEqual(idempotency.claim(scope).state, 'new');
    idempotency.release(scope);
  });

  await test('unit: lifecycle guard — CONNECTED needs confirmation; transitions are mapped', () => {
    assert.deepStrictEqual(lifecycle.assertConfirmed(undefined), { ok: true, message: null });
    assert.deepStrictEqual(lifecycle.assertConfirmed({ ok: true }), { ok: true, message: null });
    assert.throws(() => lifecycle.assertConfirmed({ ok: false, message: 'declined' }, { providerId: 'P', operation: 'connect' }),
      (e) => e.code === 'PROVIDER_UNCONFIRMED' && e.retryable === false);
    assert.throws(() => lifecycle.assertConfirmed(false), /not confirmed/);
    assert.strictEqual(lifecycle.phaseOf('NOT_CONNECTED'), 'DISCONNECTED');
    assert.strictEqual(lifecycle.phaseOf('CONFIGURED'), 'DISCONNECTED');
    assert.strictEqual(lifecycle.phaseOf('CONNECTED'), 'CONNECTED');
    assert.strictEqual(lifecycle.phaseOf('CONFIGURED', { inFlight: true }), 'CONNECTING');
    assert.strictEqual(lifecycle.isAllowedTransition('CONNECTED', 'DISCONNECTED'), true);
    assert.strictEqual(lifecycle.isAllowedTransition('DISABLED', 'CONNECTED'), false);
    for (const s of gateway.CONNECTION_STATUSES) assert.ok(['NOT_CONNECTED', 'CONFIGURED', 'CONNECTED', 'DISCONNECTED', 'DISABLED', 'ERROR'].includes(s), 'stored statuses unchanged');
  });

  await test('unit: unsupported operations fail with the standard error on the base class', async () => {
    const p = new IntegrationProvider({});
    for (const op of ['getAccounts', 'getBalance', 'getTransactions', 'initiateTransfer', 'getTransferStatus', 'verifyAccount',
      'createPosTransaction', 'getPosTransaction', 'syncCustomers', 'syncProducts', 'syncInvoices', 'syncPayments', 'capturePayment', 'pollSync']) {
      assert.strictEqual(p.supports(op), false, `${op} must not be advertised`);
    }
    for (const op of ['getAccounts', 'getBalance', 'syncProducts', 'capturePayment', 'initiateTransfer']) {
      await assert.rejects(() => p[op]({}), (e) => e instanceof base.UnsupportedCapabilityError && e.code === 'UNSUPPORTED_CAPABILITY');
    }
    const bankAdapter = registry.create({ connection: { providerId: 'MANUAL_BANK_TRANSFER' } });
    await assert.rejects(() => bankAdapter.getBalance({}), (e) => e.code === 'UNSUPPORTED_CAPABILITY');
    await assert.rejects(() => bankAdapter.syncProducts({}), (e) => e.code === 'UNSUPPORTED_CAPABILITY');
    // validateCredentials default is a permissive pass — adapters opt in.
    assert.deepStrictEqual(await bankAdapter.validateCredentials({}), { ok: true });
    // handleWebhook convenience on an adapter that cannot receive webhooks:
    const res = await bankAdapter.handleWebhook('{}', {}, {});
    assert.strictEqual(res.verified, false);
    assert.strictEqual(res.event, null);
  });

  await test('unit: webhook pipeline subscribe/dispatch is isolated per tenant context', async () => {
    const seen = [];
    const off = pipeline.subscribe('unit-pipeline', (ctx) => { seen.push(ctx.tenantId); });
    const ok = await pipeline.dispatch({ tenantId: 'T1', event: { reference: 'R' }, capability: 'receiveWebhook' });
    assert.strictEqual(ok.status, 'OK');
    const boom = pipeline.subscribe('unit-fail', () => { throw new Error('handler exploded'); });
    const mixed = await pipeline.dispatch({ tenantId: 'T2', event: {}, capability: 'receiveWebhook' });
    assert.strictEqual(mixed.status, 'PARTIAL');
    assert.strictEqual(mixed.failures[0].label, 'unit-fail');
    assert.ok(!/exploded/.test(JSON.stringify(Object.keys(mixed.failures[0]))), 'only labels recorded');
    pipeline.unsubscribe('unit-fail'); boom();
    off();
    assert.strictEqual(pipeline.subscribersCount(), 0);
  });

  /* ---------------- HTTP bootstrap ---------------- */
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base_ = `http://127.0.0.1:${server.address().port}`;

  const admin = makeClient();
  const staff = makeClient();
  const anon = makeClient();
  await test('admin + staff login', async () => {
    await admin.get('/api/csrf-token');
    await staff.get('/api/csrf-token');
    await anon.get('/api/csrf-token');
    const a = await admin.post('/api/auth/login', { email: 'admin@ndsairconditioning.com', password: 'Admin@12345' });
    assert.strictEqual(a.status, 200);
    admin.setBearer(a.body.data.accessToken);
    const s = await staff.post('/api/auth/login', { email: 'staff@ndsairconditioning.com', password: 'Staff@12345' });
    assert.strictEqual(s.status, 200);
    staff.setBearer(s.body.data.accessToken);
  });

  /* ---------------- catalogue + discovery API ---------------- */
  await test('GET /providers carries PR #71 identity + normalised field metadata', async () => {
    const r = await admin.get('/api/integrations/providers');
    assert.strictEqual(r.status, 200);
    const ids = r.body.data.map((p) => p.id);
    for (const id of ['MANUAL_BANK_TRANSFER', 'SANDBOX_DEMO', 'SYNC_POS']) assert.ok(ids.includes(id));
    const demo = r.body.data.find((p) => p.id === 'SANDBOX_DEMO');
    assert.strictEqual(demo.version, '1.1.0');
    assert.deepStrictEqual(demo.environments, ['SANDBOX']);
    assert.strictEqual(demo.providerIdempotency, false);
    assert.ok(demo.capabilities.length >= 28, 'capability catalogue extended');
    const cred = demo.credentialFields.find((f) => f.name === 'apiKey');
    for (const k of ['secret', 'writeOnly', 'supportsRotation', 'supportsClearing', 'environmentSpecific', 'validation']) {
      assert.ok(k in cred, `credential field missing ${k}`);
    }
    const groups = r.body.meta.capabilities.find((c) => c.id === 'getBalance');
    assert.ok(groups.groups.includes('banking'));
    assert.ok(!JSON.stringify(r.body).includes('credentialsCipher'));
  });

  await test('GET /providers/:id, /capabilities and /schema expose discovery metadata; unknown → 404', async () => {
    const meta = await admin.get('/api/integrations/providers/SYNC_POS');
    assert.strictEqual(meta.status, 200);
    assert.strictEqual(meta.body.data.category, 'POS');
    const caps = await admin.get('/api/integrations/providers/SYNC_POS/capabilities');
    assert.strictEqual(caps.status, 200);
    const capIds = caps.body.data.map((c) => c.id);
    assert.ok(capIds.includes('syncProducts') && capIds.includes('createPosTransaction'));
    assert.ok(!capIds.includes('receiveWebhook'), 'only declared capabilities are exposed');
    assert.strictEqual(caps.body.meta.all, 28);
    const schema = await admin.get('/api/integrations/providers/STRICT_BANK/schema');
    assert.strictEqual(schema.status, 200);
    assert.strictEqual(schema.body.data.requiresCredentials, true);
    const envField = schema.body.data.configFields.find((f) => f.name === 'environment');
    assert.strictEqual(envField.environmentSpecific, true);
    assert.deepStrictEqual(envField.validation.oneOf, ['sandbox', 'live']);
    assert.strictEqual((await admin.get('/api/integrations/providers/NO_SUCH_PROVIDER')).status, 404);
  });

  await test('POST /providers/:id/validate preflights a draft without persisting anything', async () => {
    const bad = await admin.post('/api/integrations/providers/STRICT_BANK/validate', {
      config: { environment: 'nope', merchantId: 'bad id!' }, credentials: { nope: 'x' },
    });
    assert.strictEqual(bad.status, 200);
    assert.strictEqual(bad.body.data.ok, false);
    const fieldsErrored = bad.body.data.errors.map((e) => e.field);
    assert.ok(fieldsErrored.includes('environment') && fieldsErrored.includes('merchantId') && fieldsErrored.includes('nope'));
    assert.ok(fieldsErrored.includes('apiKey'), 'required credential missing must be flagged');
    const good = await admin.post('/api/integrations/providers/STRICT_BANK/validate', {
      config: { environment: 'sandbox', merchantId: 'M-1' }, credentials: { apiKey: 'k1', clientSecret: 's1' },
    });
    assert.strictEqual(good.body.data.ok, true);
    assert.deepStrictEqual(good.body.data.credentialFieldsProvided.sort(), ['apiKey', 'clientSecret']);
    // Nothing persisted by the validation call.
    const list = await admin.get('/api/integrations?limit=100');
    assert.ok(!list.body.data.some((c) => c.providerId === 'STRICT_BANK'));
    const methodMismatch = await admin.post('/api/integrations/providers/MANUAL_BANK_TRANSFER/validate', { connectionMethod: 'SFTP' });
    assert.ok(methodMismatch.body.data.errors.some((e) => e.field === 'connectionMethod'));
  });

  /* ---------------- lifecycle: confirmation, enable/disable, reconnect ---------------- */
  let flakyId; let strictId; let idemId; let posId; let fileId; let demoId; let demoToken;
  const DEMO_WH = 'whsec-fw71-SECRET-xyz-123456789';
  await test('create fixture connections', async () => {
    const mk = async (providerId, extra = {}) => {
      const r = await admin.post('/api/integrations', { providerId, name: `${providerId} ${Date.now()}`, ...extra });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      trackedConnectionIds.push(r.body.data.id);
      return r.body.data;
    };
    flakyId = (await mk('FLAKY_BANK')).id;
    assert.strictEqual((await admin.post(`/api/integrations/${flakyId}/test`, {})).status, 200);
    strictId = (await mk('STRICT_BANK', {
      authType: 'API_KEY',
      config: { environment: 'sandbox' },
      credentials: { apiKey: 'start-key-987', clientSecret: 'start-secret-987' },
    })).id;
    idemId = (await mk('IDEM_PSP')).id;
    posId = (await mk('SYNC_POS')).id;
    fileId = (await mk('FILEBANK_IMPORT')).id;
    const demo = await mk('SANDBOX_DEMO', { authType: 'API_KEY', credentials: { webhookSecret: DEMO_WH } });
    demoId = demo.id; demoToken = demo.webhookToken;
    assert.strictEqual((await admin.post(`/api/integrations/${demoId}/test`, {})).status, 200);
  });

  await test('unconfirmed adapter result never reports success (fake-green impossible)', async () => {
    const r = await admin.post('/api/integrations', { providerId: 'UNCONFIRMED_BANK', name: `Unconfirmed ${Date.now()}` });
    assert.strictEqual(r.status, 201);
    const id = r.body.data.id;
    trackedConnectionIds.push(id);
    const test1 = await admin.post(`/api/integrations/${id}/test`, {});
    assert.strictEqual(test1.status, 502);
    assert.strictEqual(test1.body.code, 'PROVIDER_UNCONFIRMED');
    assert.strictEqual(test1.body.category, 'PROVIDER');
    assert.strictEqual(test1.body.retryable, false);
    const row = await prisma.integrationConnection.findUnique({ where: { id } });
    assert.strictEqual(row.status, 'ERROR', 'unconfirmed test must NOT set CONNECTED');
    assert.match(row.lastError, /declined/);
    assert.strictEqual(UnconfirmedBankProvider.calls, 1, 'unconfirmed results must not be retried');
    const connAttempt = await admin.post(`/api/integrations/${id}/connect`, {});
    assert.strictEqual(connAttempt.status, 502);
    assert.strictEqual((await prisma.integrationConnection.findUnique({ where: { id } })).status, 'ERROR');
  });

  await test('enable / disable / reconnect lifecycle (aliases + PATCH parity)', async () => {
    const dis = await admin.post(`/api/integrations/${flakyId}/disable`, {});
    assert.strictEqual(dis.status, 200);
    assert.strictEqual(dis.body.data.status, 'DISABLED');
    const blocked = await admin.post(`/api/integrations/${flakyId}/test`, {});
    assert.strictEqual(blocked.status, 400);
    assert.match(blocked.body.error, /disabled/);
    const blockedReconnect = await admin.post(`/api/integrations/${flakyId}/reconnect`, {});
    assert.strictEqual(blockedReconnect.status, 400);
    const en = await admin.post(`/api/integrations/${flakyId}/enable`, {});
    assert.strictEqual(en.status, 200);
    assert.strictEqual(en.body.data.status, 'CONFIGURED');
    assert.strictEqual((await admin.post(`/api/integrations/${flakyId}/test`, {})).status, 200);
    // disconnect → reconnect round-trip via the lifecycle ops.
    assert.strictEqual((await admin.post(`/api/integrations/${flakyId}/disconnect`, {})).status, 200);
    const rec = await admin.post(`/api/integrations/${flakyId}/reconnect`, {});
    assert.strictEqual(rec.status, 200, JSON.stringify(rec.body));
    const row = await prisma.integrationConnection.findUnique({ where: { id: flakyId } });
    assert.strictEqual(row.status, 'CONNECTED');
    const events = await admin.get(`/api/integrations/${flakyId}/events?limit=50`);
    const ops = events.body.data.map((e) => e.operation);
    for (const op of ['disable', 'enable', 'reconnect', 'testConnection']) {
      assert.ok(ops.includes(op), `event log missing ${op}`);
    }
  });

  /* ---------------- capability gating through the generic endpoint ---------------- */
  await test('generic operation endpoint gates capabilities and returns normalised results', async () => {
    const status = await admin.post(`/api/integrations/${demoId}/operations/getPaymentStatus`, { payload: { reference: 'NO-SUCH-REF' } });
    assert.strictEqual(status.status, 200, JSON.stringify(status.body));
    assert.strictEqual(status.body.data.status, 'UNKNOWN'); // normalised shape, not a raw provider blob
    assert.strictEqual(status.body.meta.capability, 'getPaymentStatus');
    assert.strictEqual(status.body.meta.providerId, 'SANDBOX_DEMO');
    // Unsupported on this provider → standardized response, no side effect.
    const unsup = await admin.post(`/api/integrations/${posId}/operations/getBalance`, { payload: {} });
    assert.strictEqual(unsup.status, 400);
    assert.strictEqual(unsup.body.code, 'UNSUPPORTED_CAPABILITY');
    assert.strictEqual(unsup.body.category, 'UNSUPPORTED');
    assert.strictEqual(unsup.body.retryable, false);
    const row = await prisma.integrationConnection.findUnique({ where: { id: posId } });
    assert.notStrictEqual(row.status, 'ERROR', 'unsupported calls never mark the connection broken');
    // Non-contract operation names are refused.
    const bogus = await admin.post(`/api/integrations/${posId}/operations/downloadTheBankDatabase`, { payload: {} });
    assert.strictEqual(bogus.status, 400);
    assert.match(bogus.body.error, /not part of the standard provider contract/);
    // Reference-less operations fail validation before the adapter.
    const noRef = await admin.post(`/api/integrations/${posId}/operations/getPosTransaction`, { payload: {} });
    assert.strictEqual(noRef.status, 400);
    assert.match(noRef.body.error, /reference/);
    // Normalised lifecycle test result (framework spec §6/§16).
    const t = await admin.post(`/api/integrations/${flakyId}/operations/testConnection`, { payload: {} });
    assert.strictEqual(t.status, 200);
    assert.strictEqual(t.body.data.success, true);
    assert.strictEqual(t.body.data.status, 'CONNECTED');
    assert.strictEqual(t.body.data.provider, 'FLAKY_BANK');
    assert.strictEqual(t.body.data.connectionId, flakyId);
    assert.strictEqual(t.body.data.errorCategory, undefined);
  });

  await test('POS sync flows normalise into sync results with cursor metadata', async () => {
    const s = await admin.post(`/api/integrations/${posId}/operations/syncProducts`, { payload: {} });
    assert.strictEqual(s.status, 201, JSON.stringify(s.body));
    assert.deepStrictEqual([s.body.data.created, s.body.data.updated, s.body.data.unchanged, s.body.data.total], [2, 1, 5, 8]);
    assert.strictEqual(s.body.data.resource, 'products');
    assert.strictEqual(s.body.data.nextCursor, 'cursor-2');
    assert.strictEqual(SyncPosProvider.state.syncCalls, 1);
    const broken = await admin.post(`/api/integrations/${posId}/operations/syncCustomers`, { payload: {} });
    assert.strictEqual(broken.status, 502); // generic provider failure normalised
    assert.ok(['PROVIDER', 'UNKNOWN'].includes(broken.body.category));
  });

  await test('file import via secure JSON payload normalises to a sync result (SFTP/file banks)', async () => {
    const csv = 'ref,amount\nA-1,10.5\nA-2,20\nA-3,30';
    const r = await admin.post(`/api/integrations/${fileId}/operations/importStatement`, {
      payload: { filename: 'statement.csv', contentsBase64: Buffer.from(csv).toString('base64') },
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.data.created, 3);
    assert.strictEqual(r.body.data.resource, 'statement');
    const bad = await admin.post(`/api/integrations/${fileId}/operations/importStatement`, { payload: {} });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.body.error, /contentsBase64/);
  });

  /* ---------------- errors over HTTP ---------------- */
  await test('provider auth failure → 401 AUTH, never retried, connection marked ERROR', async () => {
    const r = await admin.post('/api/integrations', { providerId: 'BADAUTH_BANK', name: `BadAuth ${Date.now()}` });
    const id = r.body.data.id;
    trackedConnectionIds.push(id);
    await admin.post(`/api/integrations/${id}/test`, {});
    const bal = await admin.post(`/api/integrations/${id}/operations/getBalance`, { payload: {} });
    assert.strictEqual(bal.status, 401);
    assert.strictEqual(bal.body.category, 'AUTH');
    assert.strictEqual(bal.body.retryable, false);
    assert.strictEqual(BadAuthBankProvider.calls.balance, 1, 'non-retryable failures must not retry');
    const retries = await prisma.integrationEvent.count({ where: { connectionId: id, operation: 'retryAttempt' } });
    assert.strictEqual(retries, 0);
    assert.strictEqual((await prisma.integrationConnection.findUnique({ where: { id } })).status, 'ERROR');
  });

  await test('rate-limit failures retry bounded (max attempts) and record retry events', async () => {
    const r = await admin.post('/api/integrations', { providerId: 'RATELIMIT_BANK', name: `RL ${Date.now()}` });
    const id = r.body.data.id;
    trackedConnectionIds.push(id);
    const bal = await admin.post(`/api/integrations/${id}/operations/getBalance`, { payload: {} });
    assert.strictEqual(bal.status, 429);
    assert.strictEqual(bal.body.category, 'RATE_LIMIT');
    assert.strictEqual(bal.body.retryable, true);
    // 1 initial + 2 retries — never more (bounded).
    assert.strictEqual(RateLimitedBankProvider.calls, 3);
    const retryEvents = await prisma.integrationEvent.findMany({ where: { connectionId: id, operation: 'retryAttempt' } });
    assert.strictEqual(retryEvents.length, 2);
    for (const e of retryEvents) {
      assert.strictEqual(e.errorCategory, 'RATE_LIMIT');
      const md = JSON.parse(e.metadata);
      assert.strictEqual(md.operation, 'getBalance');
      assert.ok(md.attempt >= 1 && md.attempt <= 2 && md.maxAttempts === 3);
    }
  });

  await test('retryable network failures succeed after bounded retries (reads)', async () => {
    const before = FlakyBankProvider.state.balanceCalls; // fresh fixture: 0
    const bal = await admin.post(`/api/integrations/${flakyId}/operations/getBalance`, { payload: {} });
    assert.strictEqual(bal.status, 200, JSON.stringify(bal.body));
    assert.strictEqual(bal.body.data.available, 500.25);
    assert.strictEqual(bal.body.data.currency, 'TTD');
    assert.strictEqual(FlakyBankProvider.state.balanceCalls - before, 3, 'exactly 2 retries then success');
    const retryEvents = await prisma.integrationEvent.findMany({ where: { connectionId: flakyId, operation: 'retryAttempt', success: false } });
    assert.strictEqual(retryEvents.length, 2);
    for (const e of retryEvents) {
      assert.strictEqual(e.errorCategory, 'NETWORK');
      const md = JSON.parse(e.metadata);
      assert.strictEqual(md.operation, 'getBalance');
      assert.ok(md.attempt >= 1 && md.attempt <= 2 && md.maxAttempts === 3);
    }
    // A later call succeeds without retries (provider recovered):
    const again = await admin.post(`/api/integrations/${flakyId}/operations/getBalance`, { payload: {} });
    assert.strictEqual(again.status, 200);
    assert.strictEqual(FlakyBankProvider.state.balanceCalls - before, 4);
  });

  /* ---------------- idempotency ---------------- */
  await test('idempotency key: duplicate payment replays; changed body conflicts; provider called once', async () => {
    const key = `idem-${Date.now()}`;
    const first = await admin.post(`/api/integrations/${idemId}/operations/createPayment`, {
      idempotencyKey: key, payload: { amount: 25, currency: 'USD', reference: 'IDEM-REF-1' },
    });
    assert.strictEqual(first.status, 201);
    assert.strictEqual(first.body.meta.replayed, false);
    const tx = first.body.data.transactionId;
    const callsAfterFirst = IdemPspProvider.state.payCalls;
    const dup = await admin.post(`/api/integrations/${idemId}/operations/createPayment`, {
      idempotencyKey: key, payload: { amount: 25, currency: 'USD', reference: 'IDEM-REF-1' },
    });
    assert.strictEqual(dup.status, 200, 'replays answer with 200, not a second 201');
    assert.strictEqual(dup.body.meta.replayed, true);
    assert.strictEqual(dup.body.data.transactionId, tx, 'the duplicate got the ORIGINAL result');
    assert.strictEqual(IdemPspProvider.state.payCalls, callsAfterFirst, 'provider not re-invoked');
    const conflict = await admin.post(`/api/integrations/${idemId}/operations/createPayment`, {
      idempotencyKey: key, payload: { amount: 99, currency: 'USD', reference: 'IDEM-REF-1' },
    });
    assert.strictEqual(conflict.status, 409);
    assert.strictEqual(conflict.body.code, 'IDEMPOTENCY_CONFLICT');
    assert.strictEqual(IdemPspProvider.state.payCalls, callsAfterFirst);
  });

  await test('idempotency key on provider-declared write retries the flaky call then caches', async () => {
    const before = FlakyBankProvider.state.payCalls; // 0 → first attempt throws network
    const key = `flaky-${Date.now()}`;
    const r = await admin.post(`/api/integrations/${flakyId}/operations/createPayment`, {
      idempotencyKey: key, payload: { amount: 10, currency: 'TTD', reference: 'FLAKY-REF-1' },
    });
    // FLAKY_BANK is NOT provider-idempotent → the framework does not resend a
    // failed write; the caller may safely retry with the same key.
    assert.strictEqual(r.status, 502);
    assert.strictEqual(r.body.category, 'NETWORK');
    assert.strictEqual(r.body.retryable, true);
    assert.strictEqual(FlakyBankProvider.state.payCalls - before, 1, 'failed writes are never auto-retried without provider idempotency');
    const retryCall = await admin.post(`/api/integrations/${flakyId}/operations/createPayment`, {
      idempotencyKey: key, payload: { amount: 10, currency: 'TTD', reference: 'FLAKY-REF-1' },
    });
    assert.strictEqual(retryCall.status, 201, 'explicit client retry with same key succeeds (attempt 2 of provider)');
    assert.strictEqual(FlakyBankProvider.state.payCalls - before, 2);
    const replay = await admin.post(`/api/integrations/${flakyId}/operations/createPayment`, {
      idempotencyKey: key, payload: { amount: 10, currency: 'TTD', reference: 'FLAKY-REF-1' },
    });
    assert.strictEqual(replay.status, 200);
    assert.strictEqual(replay.body.meta.replayed, true);
    assert.strictEqual(FlakyBankProvider.state.payCalls - before, 2);
  });

  await test('typed payment endpoint honours idempotencyKey (replay + audit marker)', async () => {
    const key = `typed-${Date.now()}`;
    const ref = `IDEM-TYPED-${Date.now()}`;
    const first = await admin.post(`/api/integrations/${demoId}/payments`, { amount: 12, currency: 'USD', reference: ref, idempotencyKey: key });
    assert.strictEqual(first.status, 201);
    const dup = await admin.post(`/api/integrations/${demoId}/payments`, { amount: 12, currency: 'USD', reference: ref, idempotencyKey: key });
    assert.strictEqual(dup.status, 201);
    assert.deepStrictEqual(dup.body.data, first.body.data, 'replay returns the original result body');
    const events = await prisma.integrationEvent.findMany({ where: { connectionId: demoId, operation: 'createPayment' }, orderBy: { createdAt: 'desc' }, take: 5 });
    assert.ok(events.some((e) => {
      try { return JSON.parse(e.metadata || '{}').idempotentReplay === true; } catch (_) { return false; }
    }), 'replay must be visible in the event log');
  });

  /* ---------------- credential rotation ---------------- */
  await test('atomic rotation endpoint: validates, swaps in one write, keeps secrets secret', async () => {
    const NEW_KEY = 'rotated-key-ABC-123987';
    const rejected = await admin.post(`/api/integrations/${strictId}/credentials`, { credentials: { apiKey: 'bad-prefix-nope' } });
    assert.strictEqual(rejected.status, 400);
    assert.match(rejected.body.error, /rejected the new credentials/);
    const unchanged = await prisma.integrationConnection.findUnique({ where: { id: strictId } });
    assert.ok(unchanged.credentialsCipher.includes('.'), 'cipher still present after rejection');
    const clearedRequired = await admin.post(`/api/integrations/${strictId}/credentials`, { credentials: { clientSecret: null } });
    assert.strictEqual(clearedRequired.status, 400);
    assert.match(clearedRequired.body.error, /required credentials unset/);
    const ok = await admin.post(`/api/integrations/${strictId}/credentials`, { credentials: { apiKey: NEW_KEY, optionalToken: 'opt-123' } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(!JSON.stringify(ok.body).includes(NEW_KEY), 'rotation response leaks the secret');
    assert.strictEqual(ok.body.data.status, 'CONFIGURED', 'rotation invalidates the previous CONNECTED claim');
    const names = ok.body.data.credentialFields.map((f) => f.name).sort();
    assert.deepStrictEqual(names, ['apiKey', 'clientSecret', 'optionalToken']);
    assert.ok(ok.body.data.credentialFields.every((f) => /^••••/.test(f.fingerprint)));
    const row = await prisma.integrationConnection.findUnique({ where: { id: strictId } });
    assert.ok(!row.credentialsCipher.includes(NEW_KEY), 'plaintext secret in cipher?!');
    // Reconnect succeeds with the rotated material.
    assert.strictEqual((await admin.post(`/api/integrations/${strictId}/test`, {})).status, 200);
    const evts = await admin.get(`/api/integrations/${strictId}/events?limit=50&operation=credentialRotated`);
    assert.strictEqual(evts.body.data.length, 1);
    const md = evts.body.data[0].metadata; // presentEvent already parsed the JSON
    assert.deepStrictEqual(md.rotated.sort(), ['apiKey', 'optionalToken']);
    assert.deepStrictEqual(md.cleared, []);
    assert.ok(!JSON.stringify(md).includes(NEW_KEY), 'event metadata leaked the secret');
  });

  /* ---------------- webhooks: normalisation, dedupe, dispatch ---------------- */
  await test('webhook pipeline: verified event dispatches once; redelivery dedupes', async () => {
    const received = [];
    const off = pipeline.subscribe('fw71-payments', (ctx) => {
      received.push({ tenant: ctx.tenantId, ref: ctx.event.reference, status: ctx.event.status });
    });
    const ref = `FW71-${Date.now()}`;
    await admin.post(`/api/integrations/${demoId}/payments`, { amount: 5, currency: 'USD', reference: ref });
    const raw = JSON.stringify({ event: 'PAYMENT_COMPLETED', reference: ref, amount: 5, currency: 'USD' });
    const sig = { 'Content-Type': 'application/json', 'x-payment-signature': signHmac(DEMO_WH, raw) };
    const one = await fetch(`${base_}/api/integrations/webhooks/SANDBOX_DEMO/${demoToken}`, { method: 'POST', headers: sig, body: raw });
    const oneJson = await one.json();
    assert.strictEqual(one.status, 200);
    assert.strictEqual(oneJson.handled, true);
    assert.strictEqual(oneJson.dispatched, 'OK');
    assert.strictEqual(received.length, 1);
    // Same event redelivered (provider retry storm): deduped, handler NOT re-run.
    const two = await fetch(`${base_}/api/integrations/webhooks/SANDBOX_DEMO/${demoToken}`, { method: 'POST', headers: sig, body: raw });
    const twoJson = await two.json();
    assert.strictEqual(two.status, 200);
    assert.strictEqual(twoJson.handled, true);
    assert.strictEqual(twoJson.duplicate, true);
    assert.strictEqual(received.length, 1, 'duplicate webhook must not create a second internal effect');
    // A DIFFERENT payload for the same reference is not a duplicate.
    const raw2 = JSON.stringify({ event: 'PAYMENT_REFUNDED', reference: ref, amount: 5, currency: 'USD' });
    const three = await fetch(`${base_}/api/integrations/webhooks/SANDBOX_DEMO/${demoToken}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-payment-signature': signHmac(DEMO_WH, raw2) }, body: raw2,
    });
    const threeJson = await three.json();
    assert.strictEqual(threeJson.duplicate, undefined);
    assert.strictEqual(received.length, 2);
    off();
    // Tenant safety: handlers see the CONNECTION's tenant, never a payload-supplied one.
    assert.ok(received.every((r) => r.tenant === 'default'));
  });

  await test('failed handler dispatch is re-run on redelivery (at-least-once + idempotent)', async () => {
    let attempts = 0;
    const off = pipeline.subscribe('fw71-flaky-handler', () => {
      attempts += 1;
      if (attempts === 1) throw new Error('simulated downstream failure');
    });
    const ref = `FW71-FAIL-${Date.now()}`;
    const raw = JSON.stringify({ event: 'PAYMENT_COMPLETED', reference: ref, amount: 3, currency: 'USD' });
    const sig = { 'Content-Type': 'application/json', 'x-payment-signature': signHmac(DEMO_WH, raw) };
    const first = await (await fetch(`${base_}/api/integrations/webhooks/SANDBOX_DEMO/${demoToken}`, { method: 'POST', headers: sig, body: raw })).json();
    assert.strictEqual(first.dispatched, 'FAILED');
    const again = await (await fetch(`${base_}/api/integrations/webhooks/SANDBOX_DEMO/${demoToken}`, { method: 'POST', headers: sig, body: raw })).json();
    assert.strictEqual(again.duplicate, undefined, 'a previously FAILED dispatch must be re-processed, not deduped away');
    assert.strictEqual(again.dispatched, 'OK');
    assert.strictEqual(attempts, 2);
    off();
  });

  await test('webhook security is unchanged by dedupe: bad signature never reaches handlers', async () => {
    let touched = 0;
    const off = pipeline.subscribe('fw71-should-not-run', () => { touched += 1; });
    const raw = JSON.stringify({ event: 'PAYMENT_COMPLETED', reference: 'FORGED-1', amount: 1, currency: 'USD' });
    const r = await fetch(`${base_}/api/integrations/webhooks/SANDBOX_DEMO/${demoToken}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-payment-signature': signHmac('attacker-secret', raw) }, body: raw,
    });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(touched, 0);
    off();
  });

  /* ---------------- proof providers keep working through the framework ---------------- */
  await test('MANUAL_BANK_TRANSFER + SANDBOX_DEMO keep working through new paths', async () => {
    const manual = await admin.post('/api/integrations', {
      providerId: 'MANUAL_BANK_TRANSFER', name: `Manual ${Date.now()}`,
      config: { bankName: 'Framework Bank', accountName: 'N&D', accountNumber: '4242', currency: 'TTD' },
    });
    assert.strictEqual(manual.status, 201);
    const mId = manual.body.data.id;
    trackedConnectionIds.push(mId);
    assert.strictEqual((await admin.post(`/api/integrations/${mId}/test`, {})).status, 200);
    const mPay = await admin.post(`/api/integrations/${mId}/operations/createPayment`, {
      payload: { amount: 250.5, currency: 'TTD', reference: `MAN-${Date.now()}` },
    });
    assert.strictEqual(mPay.status, 201);
    assert.strictEqual(mPay.body.data.status, 'PENDING'); // normalised
    assert.match(mPay.body.data.instructions, /Framework Bank/); // raw adapter fields preserved
    // typed endpoints untouched:
    const typed = await admin.post(`/api/integrations/${mId}/payments`, { amount: 10, reference: `MAN-TYPED-${Date.now()}` });
    assert.strictEqual(typed.body.data.action, 'manual');
    const demoCap = await admin.get(`/api/integrations/${demoId}/capabilities`);
    assert.strictEqual(demoCap.status, 200);
    assert.strictEqual(demoCap.body.data.find((c) => c.id === 'receiveWebhook').supported, true);
    assert.strictEqual(demoCap.body.data.find((c) => c.id === 'syncProducts').supported, false);
    const demoLink = await admin.post(`/api/integrations/${demoId}/operations/createPaymentLink`, { payload: { amount: 5, reference: 'LINK-1' } });
    assert.strictEqual(demoLink.status, 400);
    assert.strictEqual(demoLink.body.code, 'UNSUPPORTED_CAPABILITY');
  });

  /* ---------------- security: isolation, RBAC, secret containment ---------------- */
  let tenantBId; let tenantBAdmin; let tenantBConnId;
  await test('tenant B fixture + cross-tenant denial on every new framework route', async () => {
    tenantBId = await prisma.business.create({ data: { name: `Tenant B71 ${Date.now()}`, slug: `tenant-b71-${Date.now()}` } });
    const email = `tenantb71.${Date.now()}@example.com`;
    await prisma.user.create({ data: { name: 'Tenant B71 Admin', email, passwordHash: await bcrypt.hash('TenantB@12345', 12), role: 'ADMIN', businessId: tenantBId.id || tenantBId } });
    tenantBAdmin = makeClient();
    await tenantBAdmin.get('/api/csrf-token');
    const login = await tenantBAdmin.post('/api/auth/login', { email, password: 'TenantB@12345' });
    assert.strictEqual(login.status, 200, JSON.stringify(login.body));
    tenantBAdmin.setBearer(login.body.data.accessToken);

    for (const [method, p, body] of [
      ['POST', `/api/integrations/${demoId}/reconnect`, {}],
      ['POST', `/api/integrations/${demoId}/operations/createPayment`, { payload: { amount: 1, reference: 'H' } }],
      ['POST', `/api/integrations/${demoId}/credentials`, { credentials: { apiKey: 'steal-me' } }],
      ['GET', `/api/integrations/${demoId}/capabilities`, undefined],
      ['POST', `/api/integrations/${demoId}/enable`, {}],
      ['POST', `/api/integrations/${demoId}/disable`, {}],
      ['POST', `/api/integrations/${demoId}/payments`, { amount: 1, reference: 'STEAL', idempotencyKey: 'x' }],
      ['POST', `/api/integrations/${demoId}/refunds`, { reference: 'STEAL', idempotencyKey: 'x' }],
    ]) {
      const r = await tenantBAdmin.req(method, p, body);
      assert.strictEqual(r.status, 404, `tenant B ${method} ${p} leaked (status ${r.status})`);
    }
    // direction 2: tenant B's own connection is invisible to tenant A
    const bConn = await tenantBAdmin.post('/api/integrations', {
      providerId: 'MANUAL_BANK_TRANSFER', name: `B bank ${Date.now()}`,
      config: { bankName: 'B', accountName: 'B', accountNumber: '1' },
    });
    assert.strictEqual(bConn.status, 201);
    tenantBConnId = bConn.body.data.id;
    trackedConnectionIds.push(tenantBConnId);
    assert.strictEqual((await admin.get(`/api/integrations/${tenantBConnId}/capabilities`)).status, 404);
    assert.strictEqual((await admin.post(`/api/integrations/${tenantBConnId}/operations/getBalance`, { payload: {} })).status, 404);
    // provider discovery is catalogue-level metadata (no tenant data) and shared:
    assert.strictEqual((await tenantBAdmin.get('/api/integrations/providers/STRICT_BANK/schema')).status, 200);
    // …but tenant connection lists stay isolated.
    const bList = await tenantBAdmin.get('/api/integrations?limit=50');
    assert.ok(bList.body.data.every((c) => c.businessId === tenantBId.id || c.businessId === tenantBId));
  });

  await test('RBAC: staff blocked and anonymous blocked on all framework routes', async () => {
    for (const p of ['/api/integrations/providers/SYNC_POS/schema', `/api/integrations/${demoId}/capabilities`]) {
      assert.strictEqual((await staff.get(p)).status, 403);
      assert.strictEqual((await anon.get(p)).status, 401);
    }
    assert.strictEqual((await staff.post(`/api/integrations/${demoId}/operations/getBalance`, { payload: {} })).status, 403);
    assert.strictEqual((await anon.post(`/api/integrations/${demoId}/credentials`, { credentials: {} })).status, 401);
    assert.strictEqual((await staff.post('/api/integrations/providers/MANUAL_BANK_TRANSFER/validate', { config: {} })).status, 403);
  });

  await test('secrets never leak: every framework response, event and audit stays clean', async () => {
    const serialiseAll = [];
    for (const p of [
      `/api/integrations/${demoId}`, `/api/integrations/${strictId}`, `/api/integrations/${demoId}/events?limit=100`,
      `/api/integrations/${strictId}/events?limit=100`, `/api/integrations/providers`,
    ]) serialiseAll.push(JSON.stringify((await admin.get(p)).body));
    const all = serialiseAll.join('\n');
    for (const secret of [DEMO_WH, 'rotated-key-ABC-123987', 'start-key-987', 'start-secret-987', 'opt-123']) {
      assert.ok(!all.includes(secret), `leaked ${secret}`);
    }
    assert.ok(!all.includes('credentialsCipher'));
    const audits = await prisma.auditLog.findMany({ where: { entity: 'IntegrationConnection' }, orderBy: { createdAt: 'desc' }, take: 40 });
    assert.ok(!JSON.stringify(audits).includes('rotated-key-ABC-123987'), 'audit leak');
  });

  await test('connection lifecycle metadata surfaces canonical phase to clients', async () => {
    const d = await admin.get(`/api/integrations/${strictId}`);
    assert.ok(['DISCONNECTED', 'CONNECTED', 'CONFIGURED'].includes(d.body.data.status));
    assert.ok(['DISCONNECTED', 'CONNECTED', 'DISABLED', 'ERROR', 'CONNECTING'].includes(d.body.data.lifecyclePhase));
    assert.strictEqual(d.body.data.lifecyclePhase, lifecycle.phaseOf(d.body.data.status));
  });

  /* ---------------- cleanup ---------------- */
  await test('cleanup fixtures', async () => {
    pipeline._reset();
    idempotency._reset();
    await prisma.integrationEvent.deleteMany({
      where: { businessId: { in: ['default', tenantBId ? (tenantBId.id || tenantBId) : 'default'] }, createdAt: { gte: suiteStart } },
    });
    await prisma.integrationConnection.deleteMany({ where: { id: { in: trackedConnectionIds } } });
    if (tenantBId) {
      const uid = tenantBId.id || tenantBId;
      const ids = (await prisma.user.findMany({ where: { businessId: uid }, select: { id: true } })).map((u) => u.id);
      await prisma.auditLog.deleteMany({ where: { OR: [{ businessId: uid }, { userId: { in: ids } }] } });
      await prisma.activity.deleteMany({ where: { OR: [{ businessId: uid }, { userId: { in: ids } }] } });
      await prisma.user.deleteMany({ where: { businessId: uid } });
      await prisma.business.delete({ where: { id: uid } });
    }
    unregisterFixtures();
    for (const id of ['FLAKY_BANK', 'BADAUTH_BANK', 'RATELIMIT_BANK', 'UNCONFIRMED_BANK', 'STRICT_BANK', 'IDEM_PSP', 'SYNC_POS', 'FILEBANK_IMPORT']) {
      assert.strictEqual(registry.has(id), false, `${id} must not survive the run`);
    }
    assert.ok(registry.has('MANUAL_BANK_TRANSFER') && registry.has('SANDBOX_DEMO'), 'built-ins intact');
  });

  server.close();
  await prisma.$disconnect();

  const pass = resultsLog.filter((r) => r[0] === 'PASS').length;
  console.log('\nProvider Integration Framework (PR #71) verification\n========================================');
  for (const [state, name] of resultsLog) console.log(`  ${state === 'PASS' ? '✔' : '✘'} ${name}`);
  console.log(`\n${pass}/${resultsLog.length} checks passed${failures ? ` — ${failures} FAILED` : ''}\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); unregisterFixtures(); process.exit(1); });
