'use strict';

/**
 * Sandbox Demo PSP (category: PSP, methods: HOSTED_GATEWAY + WEBHOOK).
 *
 * A clearly-labelled, zero-network demonstration adapter that proves the
 * hosted-checkout side of the framework: redirect creation, status polling,
 * server-side verification, refunds, HMAC webhook verification and webhook
 * parsing. It holds payments in process memory only — nothing is persisted,
 * nothing leaves the host, and NO REAL MONEY can move.
 *
 * Safety rails:
 *   • every result is stamped `sandbox: true`
 *   • the redirect URL targets the `.invalid` TLD (RFC 2606 — unresolvable)
 *   • createPayment / testConnection REFUSE to run in production
 *
 * Future PSP adapters (Stripe, PayPal, WiPay, Tilopay, …) follow this exact
 * shape with real HTTP in place of the in-memory store.
 */

const crypto = require('crypto');
const {
  IntegrationProvider,
  IntegrationConfigError,
  NotConnectedError,
} = require('../base');

const isProd = () => process.env.NODE_ENV === 'production';

/** In-memory ledger: reference → { status, amount, currency, ... }. Never persisted. */
const ledger = new Map();

function hmacHex(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

function timingSafeEqualHex(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

class SandboxDemoProvider extends IntegrationProvider {
  static id = 'SANDBOX_DEMO';
  static label = 'Sandbox Demo PSP (test only)';
  static description = 'Demonstration PSP for integration testing. Simulated payments only — never available in production.';
  static category = 'PSP';
  static connectionMethods = ['HOSTED_GATEWAY', 'WEBHOOK'];
  static authTypes = ['API_KEY', 'NONE'];
  static capabilities = [
    'configure',
    'connect',
    'testConnection',
    'createPayment',
    'getPaymentStatus',
    'verifyPayment',
    'refundPayment',
    'receiveWebhook',
    'disconnect',
  ];
  static regions = [];
  static requiresCredentials = false;
  static credentialFields = [
    { name: 'apiKey', label: 'Demo API key', type: 'password', required: false },
    { name: 'webhookSecret', label: 'Demo webhook signing secret', type: 'password', required: false },
  ];
  static configFields = [
    { name: 'descriptor', label: 'Statement descriptor', type: 'text', required: false, maxLength: 60 },
  ];

  assertSandboxAllowed() {
    if (isProd()) {
      throw new IntegrationConfigError(
        'The Sandbox Demo PSP is a testing adapter and is never available in production. Connect a real provider instead.'
      );
    }
  }

  async connect() {
    this.assertSandboxAllowed();
    return { ok: true, message: 'Sandbox demo session established (simulated).' };
  }

  async testConnection() {
    this.assertSandboxAllowed();
    return { ok: true, message: 'Sandbox demo PSP reachable (simulated — no network used).' };
  }

  async createPayment(payment = {}) {
    this.assertSandboxAllowed();
    const amount = Number(payment.amount);
    if (!(amount > 0)) throw new IntegrationConfigError('A positive payment amount is required.');
    const reference = String(payment.reference || '').trim();
    if (!reference) throw new IntegrationConfigError('A payment reference is required.');
    const currency = String(payment.currency || 'USD').toUpperCase();
    ledger.set(`${this.connection?.id || 'ad-hoc'}:${reference}`, {
      status: 'PENDING',
      amount,
      currency,
      createdAt: new Date().toISOString(),
    });
    return {
      action: 'redirect',
      // RFC 2606 .invalid — guaranteed unresolvable, so the URL can never charge anyone.
      url: `https://sandbox-demo.invalid/checkout/${encodeURIComponent(reference)}`,
      reference,
      sandbox: true,
      instructions: 'Demo PSP running in simulated mode. No real payment was taken and none can be.',
    };
  }

  _lookup(reference) {
    return ledger.get(`${this.connection?.id || 'ad-hoc'}:${String(reference)}`) || null;
  }

  async getPaymentStatus(reference) {
    this.assertSandboxAllowed();
    const entry = this._lookup(reference);
    if (!entry) return { status: 'UNKNOWN' };
    return { status: entry.status, transactionId: `demo_${String(reference)}`, amount: entry.amount, currency: entry.currency };
  }

  async verifyPayment(reference) {
    this.assertSandboxAllowed();
    const entry = this._lookup(reference);
    // The demo ledger auto-settles: anything created here counts as paid when
    // verified, mirroring a customer completing hosted checkout.
    if (!entry) return { paid: false };
    if (entry.status === 'PENDING') entry.status = 'PAID';
    return { paid: entry.status === 'PAID', transactionId: `demo_${String(reference)}` };
  }

  async refundPayment(reference, amount) {
    this.assertSandboxAllowed();
    const entry = this._lookup(reference);
    if (!entry) throw new NotConnectedError(`No demo payment '${String(reference).slice(0, 80)}' exists to refund.`);
    if (entry.status === 'REFUNDED') return { refunded: true, refundReference: `demo_refund_${String(reference)}`, amount: entry.amount };
    const value = amount === undefined || amount === null ? entry.amount : Number(amount);
    if (!(value > 0) || value > entry.amount) {
      throw new IntegrationConfigError('Refund amount must be positive and may not exceed the payment amount.');
    }
    entry.status = 'REFUNDED';
    entry.refundedAmount = value;
    return { refunded: true, refundReference: `demo_refund_${String(reference)}`, amount: value };
  }

  /**
   * Demo webhook scheme: `sha256=<hmac>` over the raw body using the
   * connection's `webhookSecret`. Returns false (never throws) when the
   * secret is missing or the signature is absent — the Gateway then applies
   * the standard non-production sandbox fallback, exactly like the existing
   * payment webhooks.
   */
  async verifyWebhook(rawBody, headers = {}) {
    try {
      const secret = this.secrets?.webhookSecret;
      if (!secret) return false;
      const sig = headers['x-payment-signature'] || headers['x-signature'] || headers.signature;
      if (!sig) return false;
      return timingSafeEqualHex(String(sig).replace(/^sha256=/i, ''), hmacHex(secret, String(rawBody || '')));
    } catch (_) {
      return false;
    }
  }

  async parseWebhook(rawBody, headers, body) {
    if (!body || typeof body !== 'object') return null;
    const event = String(body.event || body.type || '').toUpperCase();
    if (!event.includes('PAYMENT')) return null;
    const reference = body.reference || body.order_reference || body.orderReference || null;
    if (!reference) return null;
    // A verified demo webhook settles the simulated payment it names.
    const entry = this._lookup(reference);
    if (entry && entry.status === 'PENDING') entry.status = 'PAID';
    return {
      reference: String(reference),
      transactionId: body.transaction_id || body.transactionId || `demo_${String(reference)}`,
      paid: /COMPLETED|PAID|SUCCESS|APPROVED/.test(event),
      amount: body.amount != null ? Number(body.amount) : undefined,
      currency: body.currency ? String(body.currency).toUpperCase() : undefined,
    };
  }

  async disconnect() {
    return { ok: true, message: 'Sandbox demo session closed (simulated).' };
  }
}

/** Clears the in-memory ledger — tests only. */
function _resetSandboxLedger() {
  ledger.clear();
}

module.exports = { SandboxDemoProvider, _resetSandboxLedger };
