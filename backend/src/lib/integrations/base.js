'use strict';

/**
 * Universal Integration Gateway — Standard Provider Interface.
 *
 * This module is the provider-agnostic contract every bank, payment service
 * provider (PSP), point-of-sale (POS) system and accounting integration speaks.
 * Application code (invoices, orders, checkout, payments, tenant settings)
 * MUST NOT contain provider-specific logic — it talks to the Gateway
 * (`gateway.js`), the Gateway resolves the tenant's connection row, and the
 * connection's adapter (a subclass of {@link IntegrationProvider}) performs
 * the provider-specific work:
 *
 *     N&D'S Application → Integration Gateway → Provider Adapter → Provider
 *
 * Adding a new institution is a one-file change with no core rewrite:
 *
 *     class NewBankAdapter extends IntegrationProvider { ... }
 *     registry.register(NewBankAdapter);
 *
 * Capabilities are OPT-IN. An adapter advertises only what its institution
 * actually supports; the Gateway checks `supports()` before every call and
 * fails safely (UnsupportedCapabilityError) instead of pretending success.
 * This is what lets one interface span API banks, OAuth banks, hosted payment
 * gateways, open-banking interfaces, SFTP/file settlement, CSV imports and
 * fully manual reconciliation — no provider is forced to implement a
 * capability it does not have.
 */

/* ---------------------------------------------------------------------------
 * Provider categories.
 *
 * BANK covers Trinidad & Tobago banks, Caribbean banks, US/Canadian/UK banks,
 * international banks and any future institution — the core architecture never
 * hardcodes a bank list. PSP covers Stripe, PayPal, WiPay, Tilopay and future
 * payment providers. POS covers Square, Clover, Shopify POS and future
 * point-of-sale systems. ACCOUNTING covers QuickBooks, Xero and future
 * accounting systems. OTHER is the escape hatch for future categories.
 * ------------------------------------------------------------------------- */
const PROVIDER_CATEGORIES = {
  BANK: 'Bank / financial institution (API, open banking, file or manual)',
  PSP: 'Payment service provider (hosted checkout, payment links, webhooks)',
  POS: 'Point-of-sale provider',
  ACCOUNTING: 'Accounting system',
  OTHER: 'Other integration',
};

const PROVIDER_CATEGORY_IDS = Object.keys(PROVIDER_CATEGORIES);

/* ---------------------------------------------------------------------------
 * Capabilities.
 *
 * Every adapter declares the subset it supports via `static capabilities`.
 * The Gateway refuses to invoke anything that is not advertised.
 * ------------------------------------------------------------------------- */
const CAPABILITIES = {
  configure: 'Validate and persist non-secret provider configuration',
  connect: 'Establish and persist an authenticated session with the provider',
  testConnection: 'Verify credentials and reachability without side effects',
  createPayment: 'Initiate a payment or hosted checkout session',
  getPaymentStatus: 'Poll the provider for the state of a payment',
  verifyPayment: 'Server-side verification that a payment completed',
  refundPayment: 'Refund a captured payment',
  voidPayment: 'Void an uncaptured authorisation',
  createPaymentLink: 'Generate a reusable / stand-alone payment link',
  receiveWebhook: 'Accept, verify and parse inbound provider webhooks',
  reconcile: 'Pull settlement / reconciliation reporting',
  importStatement: 'Import a CSV/statement file for manual matching',
  disconnect: 'Revoke / close the authenticated session',
};

const CAPABILITY_IDS = Object.keys(CAPABILITIES);

/* ---------------------------------------------------------------------------
 * Connection methods.
 *
 * Not every institution has an API. Each adapter declares which integration
 * mechanisms it uses so the UI and the Gateway can set correct expectations
 * (a MANUAL connection never attempts HTTP, a FILE_IMPORT connection never
 * asks for OAuth credentials, and so on).
 * ------------------------------------------------------------------------- */
const CONNECTION_METHODS = {
  API_KEY: 'Direct API integration with API keys / tokens',
  OAUTH2: 'OAuth 2.0 authorisation-code flow',
  BASIC: 'HTTP Basic credentials',
  BEARER: 'Bearer-token credentials',
  HOSTED_GATEWAY: 'Hosted payment gateway (redirect / embedded checkout)',
  OPEN_BANKING: 'Open-banking / regulated bank API',
  WEBHOOK: 'Inbound provider webhooks',
  SFTP: 'SFTP / file-based settlement',
  FILE_IMPORT: 'Manual CSV / statement file import',
  PAYMENT_LINK: 'Provider-hosted payment links',
  MANUAL: 'Manual reconciliation — no electronic interface',
};

const CONNECTION_METHOD_IDS = Object.keys(CONNECTION_METHODS);

/* ---------------------------------------------------------------------------
 * Error taxonomy.
 *
 * Every failure that crosses the Gateway boundary is (or is wrapped into) an
 * IntegrationError, so callers get a stable { code, category, retryable }
 * triple instead of provider-specific error shapes. `details` must NEVER
 * contain secrets — adapters redact before throwing (see redactForLog).
 * ------------------------------------------------------------------------- */
const ERROR_CATEGORIES = {
  CONFIG: 'Merchant configuration problem — fix settings and retry',
  AUTH: 'Authentication / authorisation failure against the provider',
  NETWORK: 'Transport failure reaching the provider',
  PROVIDER: 'Provider rejected the request (validation, limits, decline)',
  VALIDATION: 'Caller-supplied input failed validation',
  UNSUPPORTED: 'Capability not supported by this provider',
  INTERNAL: 'Unexpected framework / adapter failure',
};

const ERROR_CATEGORY_IDS = Object.keys(ERROR_CATEGORIES);

class IntegrationError extends Error {
  constructor(message, { code = 'INTEGRATION_ERROR', category = 'INTERNAL', retryable = false, status = 502, details } = {}) {
    super(message);
    this.name = 'IntegrationError';
    this.code = code;
    this.category = ERROR_CATEGORY_IDS.includes(category) ? category : 'INTERNAL';
    this.retryable = Boolean(retryable);
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

/** The provider does not implement the requested capability. Never retry. */
class UnsupportedCapabilityError extends IntegrationError {
  constructor(providerId, capability) {
    super(
      `Provider '${providerId}' does not support '${capability}'. ` +
        `Choose a provider that advertises this capability instead.`,
      { code: 'UNSUPPORTED_CAPABILITY', category: 'UNSUPPORTED', retryable: false, status: 400 }
    );
    this.name = 'UnsupportedCapabilityError';
    this.providerId = providerId;
    this.capability = capability;
  }
}

/** The capability exists but the connection is not established/configured. */
class NotConnectedError extends IntegrationError {
  constructor(message = 'Not connected — configure credentials and test the connection first') {
    super(message, { code: 'NOT_CONNECTED', category: 'CONFIG', retryable: false, status: 400 });
    this.name = 'NotConnectedError';
  }
}

/** Merchant-side misconfiguration (missing settings, bad config values). */
class IntegrationConfigError extends IntegrationError {
  constructor(message) {
    super(message, { code: 'INTEGRATION_NOT_CONFIGURED', category: 'CONFIG', retryable: false, status: 400 });
    this.name = 'IntegrationConfigError';
  }
}

/** Inbound webhook failed verification. Never retry against the same payload. */
class WebhookVerificationError extends IntegrationError {
  constructor(message = 'Webhook signature verification failed') {
    super(message, { code: 'WEBHOOK_VERIFICATION_FAILED', category: 'AUTH', retryable: false, status: 401 });
    this.name = 'WebhookVerificationError';
  }
}

/* ---------------------------------------------------------------------------
 * Standard Provider Interface.
 * ------------------------------------------------------------------------- */
class IntegrationProvider {
  /** Unique provider id, referenced by IntegrationConnection.providerId. */
  static id = 'base';
  static label = 'Base provider';
  static description = 'Abstract base — never registered directly.';
  /** One of PROVIDER_CATEGORY_IDS. */
  static category = 'OTHER';
  /** Connection mechanisms this adapter uses (subset of CONNECTION_METHOD_IDS). */
  static connectionMethods = [];
  /** Auth schemes the adapter accepts, e.g. ['API_KEY', 'OAUTH2', 'NONE']. */
  static authTypes = ['NONE'];
  /** Capability ids the provider can *possibly* offer. */
  static capabilities = [];
  /** Secret fields collected from the tenant (never echoed back). */
  static credentialFields = [];
  /** Non-secret configuration fields collected from the tenant. */
  static configFields = [];
  /** ISO country codes the provider operates in; [] = worldwide / any. */
  static regions = [];
  /** Whether credentials must exist before the connection can be tested. */
  static requiresCredentials = false;

  constructor({ connection = {}, secrets = {}, config = {}, tenantId = null } = {}) {
    this.connection = connection || {};
    this.secrets = secrets || {};
    this.config = config || {};
    this.tenantId = tenantId || connection.businessId || null;
    this.logger = () => {};
  }

  /** Capabilities actually available for THIS configuration. */
  capabilities() {
    return [...new Set(this.constructor.capabilities)].filter((c) => this.isConfiguredFor(c));
  }

  supports(capability) {
    return this.capabilities().includes(capability);
  }

  /** Throws UnsupportedCapabilityError unless the capability is available. */
  requireCapability(capability) {
    if (!this.supports(capability)) {
      throw new UnsupportedCapabilityError(this.constructor.id, capability);
    }
  }

  /** Subclasses narrow capabilities when a prerequisite is not configured. */
  // eslint-disable-next-line no-unused-vars
  isConfiguredFor(capability) {
    return true;
  }

  /** True when the adapter has everything it needs to talk to the provider. */
  hasCredentials() {
    if (!this.constructor.requiresCredentials) return true;
    return this.constructor.credentialFields
      .filter((f) => f.required)
      .every((f) => Boolean(this.secrets?.[f.name]));
  }

  requireCredentials() {
    if (!this.hasCredentials()) throw new NotConnectedError();
  }

  /* ---- capability implementations (adapters override what they offer) ---- */

  /**
   * Validates non-secret configuration. Returns the normalised config object.
   * @returns {Promise<object>}
   */
  async configure() {
    return { ...(this.config || {}) };
  }

  /**
   * Establishes an authenticated session.
   * @returns {Promise<{ ok: boolean, message?: string }>}
   */
  async connect() {
    throw new UnsupportedCapabilityError(this.constructor.id, 'connect');
  }

  /**
   * Side-effect-free connectivity / credential check.
   * @returns {Promise<{ ok: boolean, message?: string }>}
   */
  async testConnection() {
    throw new UnsupportedCapabilityError(this.constructor.id, 'testConnection');
  }

  /**
   * Initiates a payment.
   * @param {object} payment - { amount, currency, reference, description?, customer?, returnUrls? }
   * @returns {Promise<{ action: 'redirect'|'manual'|'simulated', url?, reference, sandbox, instructions? }>}
   */
  // eslint-disable-next-line no-unused-vars
  async createPayment(payment) {
    throw new UnsupportedCapabilityError(this.constructor.id, 'createPayment');
  }

  /**
   * Polls the provider for a payment's state.
   * @returns {Promise<{ status: 'PENDING'|'PAID'|'FAILED'|'REFUNDED'|'UNKNOWN', transactionId?, amount?, currency?, raw? }>}
   */
  // eslint-disable-next-line no-unused-vars
  async getPaymentStatus(reference) {
    throw new UnsupportedCapabilityError(this.constructor.id, 'getPaymentStatus');
  }

  /**
   * Server-side verification that a payment completed (e.g. confirm-on-return).
   * @returns {Promise<{ paid: boolean, transactionId? }>}
   */
  // eslint-disable-next-line no-unused-vars
  async verifyPayment(reference) {
    throw new UnsupportedCapabilityError(this.constructor.id, 'verifyPayment');
  }

  /**
   * Refunds a captured payment.
   * @returns {Promise<{ refunded: boolean, refundReference?, amount? }>}
   */
  // eslint-disable-next-line no-unused-vars
  async refundPayment(reference, amount) {
    throw new UnsupportedCapabilityError(this.constructor.id, 'refundPayment');
  }

  // eslint-disable-next-line no-unused-vars
  async voidPayment(reference) {
    throw new UnsupportedCapabilityError(this.constructor.id, 'voidPayment');
  }

  // eslint-disable-next-line no-unused-vars
  async createPaymentLink(payment) {
    throw new UnsupportedCapabilityError(this.constructor.id, 'createPaymentLink');
  }

  /**
   * Verifies an inbound webhook's authenticity. MUST be timing-safe and MUST
   * NOT throw on hostile input — return false instead.
   * @returns {Promise<boolean>|boolean}
   */
  // eslint-disable-next-line no-unused-vars
  async verifyWebhook(rawBody, headers) {
    return false;
  }

  /**
   * Parses a VERIFIED webhook payload into the canonical shape.
   * Must only be called after verifyWebhook() returned true.
   * @returns {Promise<{ reference?, transactionId?, paid?, amount?, currency? }|null>}
   */
  // eslint-disable-next-line no-unused-vars
  async parseWebhook(rawBody, headers, body) {
    return null;
  }

  // eslint-disable-next-line no-unused-vars
  async reconcile(params) {
    throw new UnsupportedCapabilityError(this.constructor.id, 'reconcile');
  }

  // eslint-disable-next-line no-unused-vars
  async importStatement(file) {
    throw new UnsupportedCapabilityError(this.constructor.id, 'importStatement');
  }

  async disconnect() {
    return { ok: true, message: 'No persistent session to close.' };
  }

  /**
   * Scrubs adapter-specific secrets from a value before it is logged or
   * persisted in an IntegrationEvent. The Gateway always calls this on error
   * details and metadata; adapters with exotic secret shapes override it.
   */
  redactForLog(value) {
    try {
      // eslint-disable-next-line global-require
      const { redact, redactString } = require('./credentials');
      const secretValues = Object.values(this.secrets || {}).filter((v) => typeof v === 'string' && v.length >= 4);
      const structural = redact(value);
      return typeof structural === 'string' ? redactString(structural, secretValues) : structural;
    } catch (_) {
      return '[unloggable]';
    }
  }

  /** Browser-safe provider description used by the catalogue endpoint. */
  static describe() {
    return {
      id: this.id,
      label: this.label,
      description: this.description,
      category: this.category,
      categoryLabel: PROVIDER_CATEGORIES[this.category] || this.category,
      connectionMethods: (this.connectionMethods || []).map((id) => ({
        id, label: id, description: CONNECTION_METHODS[id] || id,
      })),
      authTypes: this.authTypes || [],
      regions: this.regions || [],
      capabilities: CAPABILITY_IDS.map((id) => ({
        id, label: id, description: CAPABILITIES[id], supported: (this.capabilities || []).includes(id),
      })),
      credentialFields: this.credentialFields || [],
      configFields: this.configFields || [],
      requiresCredentials: Boolean(this.requiresCredentials),
    };
  }
}

module.exports = {
  IntegrationProvider,
  IntegrationError,
  UnsupportedCapabilityError,
  NotConnectedError,
  IntegrationConfigError,
  WebhookVerificationError,
  PROVIDER_CATEGORIES,
  PROVIDER_CATEGORY_IDS,
  CAPABILITIES,
  CAPABILITY_IDS,
  CONNECTION_METHODS,
  CONNECTION_METHOD_IDS,
  ERROR_CATEGORIES,
  ERROR_CATEGORY_IDS,
};
