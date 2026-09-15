'use strict';

/**
 * Manual Bank Transfer provider (category: BANK, method: MANUAL).
 *
 * The proof that the framework does NOT assume every bank has an API: this
 * adapter models a bank relationship with no electronic interface at all. The
 * tenant publishes their banking instructions; the Gateway hands those
 * instructions to the payer; the tenant confirms receipt out-of-band and
 * captures payment through the existing capture flow.
 *
 * It deliberately advertises NO refund / status / webhook capabilities, which
 * is what makes it the regression fixture for "unsupported operations fail
 * safely instead of pretending they succeeded".
 *
 * This adapter is framework-level only: it does not alter the existing
 * BANK_TRANSFER checkout behaviour in `lib/payments` (that path is untouched
 * by this phase).
 */

const { IntegrationProvider, IntegrationConfigError } = require('../base');

class ManualBankTransferProvider extends IntegrationProvider {
  static id = 'MANUAL_BANK_TRANSFER';
  static label = 'Manual Bank Transfer';
  static description = 'Accept bank transfers with published instructions and manual reconciliation. No API required — works with any bank worldwide.';
  static category = 'BANK';
  static connectionMethods = ['MANUAL'];
  static authTypes = ['NONE'];
  static capabilities = ['configure', 'connect', 'testConnection', 'createPayment', 'disconnect'];
  static regions = []; // any country — the tenant names their own bank
  static requiresCredentials = false;
  static credentialFields = [];
  static configFields = [
    { name: 'bankName', label: 'Bank name', type: 'text', required: true, maxLength: 120 },
    { name: 'accountName', label: 'Account name', type: 'text', required: true, maxLength: 120 },
    { name: 'accountNumber', label: 'Account number', type: 'text', required: true, maxLength: 60 },
    { name: 'branchOrRouting', label: 'Branch / routing info', type: 'text', required: false, maxLength: 120 },
    { name: 'currency', label: 'Settlement currency (ISO)', type: 'text', required: false, maxLength: 3 },
    { name: 'instructions', label: 'Payer instructions', type: 'textarea', required: false, maxLength: 2000 },
  ];

  /** Manual connections have no session to establish. */
  async connect() {
    return { ok: true, message: 'Manual bank transfer needs no live session — instructions are ready to publish.' };
  }

  /**
   * "Testing" a manual connection means validating that the published
   * instructions are complete. No network traffic is ever attempted.
   */
  async testConnection() {
    const missing = ['bankName', 'accountName', 'accountNumber']
      .filter((field) => !String(this.config?.[field] || '').trim());
    if (missing.length) {
      throw new IntegrationConfigError(
        `Bank transfer instructions are incomplete — missing: ${missing.join(', ')}.`
      );
    }
    return { ok: true, message: `Instructions verified for ${String(this.config.bankName).slice(0, 80)}.` };
  }

  /**
   * Returns the payer instructions for a payment. Nothing is transmitted
   * anywhere — the merchant captures the payment manually when it arrives,
   * exactly like the existing BANK_TRANSFER checkout path.
   */
  async createPayment(payment = {}) {
    const cfg = this.config || {};
    const reference = String(payment.reference || '').trim();
    if (!payment || !(Number(payment.amount) > 0)) {
      throw new IntegrationConfigError('A positive payment amount is required.');
    }
    if (!reference) {
      throw new IntegrationConfigError('A payment reference is required.');
    }
    await this.testConnection(); // instructions must be complete to quote them
    const lines = [
      `Pay ${Number(payment.amount).toFixed(2)}${payment.currency ? ` ${String(payment.currency).toUpperCase()}` : ''} to:`,
      `${cfg.accountName} — ${cfg.bankName}, account ${cfg.accountNumber}`,
    ];
    if (cfg.branchOrRouting) lines.push(String(cfg.branchOrRouting));
    lines.push(`Use reference: ${reference}`);
    if (cfg.instructions) lines.push('', String(cfg.instructions));
    return {
      action: 'manual',
      reference,
      sandbox: false,
      instructions: lines.join('\n').slice(0, 2000),
    };
  }

  async disconnect() {
    return { ok: true, message: 'Manual bank transfer disconnected. Published instructions are retained for re-activation.' };
  }
}

module.exports = { ManualBankTransferProvider };
