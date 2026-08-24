/**
 * Manual / email fulfilment connector.
 *
 * For suppliers with no machine interface at all. Catalogue data arrives as an
 * operator-uploaded file (handled by the importer, which is transport-agnostic)
 * and purchase orders are transmitted by email using the platform's existing
 * mailer.
 *
 * Honesty rules baked in here:
 *   • no order capability other than EMAIL is advertised, so the UI can never
 *     offer "poll status" or "fetch tracking" for these suppliers;
 *   • submitOrder() only reports success when the mailer actually accepted the
 *     message — if SMTP/Resend is not configured it throws, and the fulfillment
 *     is recorded as FAILED rather than silently "sent".
 */
const { SupplierConnector, SupplierConnectorError, NotConnectedError } = require('./base');
const { sendMail } = require('../../mailer');

class ManualConnector extends SupplierConnector {
  static id = 'MANUAL';
  static label = 'Manual / email fulfilment';
  static description = 'Suppliers without an API. Import catalogues from an uploaded CSV/XML/JSON file and transmit purchase orders by email.';
  static transport = 'MANUAL';
  static formats = ['CSV', 'XML', 'JSON'];
  static authTypes = ['NONE'];
  static capabilities = ['connect', 'testConnection', 'disconnect', 'submitOrder'];
  static requiresCredentials = false;
  static credentialFields = [];
  static configFields = [
    { name: 'orderEmail', label: 'Supplier order email', type: 'email', required: true, help: 'Purchase orders are emailed here' },
    { name: 'ccEmail', label: 'Copy to', type: 'email' },
    { name: 'emailSubject', label: 'Email subject', type: 'text', help: 'Default: Purchase order {reference} — {supplier}' },
    { name: 'emailBody', label: 'Email body template', type: 'textarea', help: 'Supports {reference} {supplier} {items} {shipTo} {total}' },
    { name: 'accountRef', label: 'Account reference to quote', type: 'text' },
    { name: 'leadTimeDays', label: 'Typical lead time (days)', type: 'number' },
  ];

  isConfiguredFor(capability) {
    if (capability === 'submitOrder') return Boolean(this.config.orderEmail);
    return true;
  }

  async connect() {
    return { ok: true, message: 'No remote system to connect to — orders are sent by email.' };
  }

  /** Verifies that an order destination exists and that the mailer is usable. */
  async testConnection() {
    if (!this.config.orderEmail) {
      throw new NotConnectedError('Not connected — a supplier order email address is required');
    }
    const mailConfigured = Boolean(process.env.RESEND_API_KEY);
    return {
      ok: true,
      message: mailConfigured
        ? `Ready — purchase orders will be emailed to ${this.config.orderEmail}.`
        : `Configured, but outbound email is not set up (RESEND_API_KEY missing) — orders cannot be transmitted until it is.`,
      warnings: mailConfigured ? [] : ['RESEND_API_KEY is not configured'],
    };
  }

  render(body, ctx) {
    return String(body)
      .replace(/\{reference\}/g, ctx.reference || '')
      .replace(/\{supplier\}/g, ctx.supplier || '')
      .replace(/\{items\}/g, ctx.itemsText || '')
      .replace(/\{shipTo\}/g, ctx.shipToText || '')
      .replace(/\{total\}/g, ctx.total || '')
      .replace(/\{accountRef\}/g, ctx.accountRef || '');
  }

  async submitOrder(payload) {
    if (!this.config.orderEmail) throw new NotConnectedError('No supplier order email configured');
    if (!process.env.RESEND_API_KEY) {
      throw new SupplierConnectorError(
        'Outbound email is not configured (RESEND_API_KEY missing), so the purchase order was NOT sent',
        { code: 'MAIL_UNAVAILABLE' }
      );
    }
    const itemsText = (payload.items || [])
      .map((i) => `  • ${i.supplierSku} — ${i.name} × ${i.quantity} @ ${i.unitCost.toFixed(2)} = ${(i.unitCost * i.quantity).toFixed(2)}`)
      .join('\n');
    const shipTo = payload.shipTo || {};
    const shipToText = [shipTo.name, shipTo.phone, shipTo.address, shipTo.city, shipTo.postalCode, shipTo.country]
      .filter(Boolean).join('\n  ');
    const total = (payload.items || []).reduce((s, i) => s + (i.unitCost * i.quantity), 0).toFixed(2);

    const subject = this.config.emailSubject
      ? this.render(this.config.emailSubject, { reference: payload.reference, supplier: this.supplier.name })
      : `Purchase order ${payload.reference} — ${this.supplier.name}`;
    const body = this.config.emailBody
      ? this.render(this.config.emailBody, { reference: payload.reference, supplier: this.supplier.name, itemsText, shipToText, total, accountRef: this.config.accountRef || this.supplier.accountRef })
      : [
        `Purchase order ${payload.reference}`,
        this.supplier.accountRef || this.config.accountRef ? `Account: ${this.supplier.accountRef || this.config.accountRef}` : '',
        '', 'Items:', itemsText, '',
        `Total: ${payload.currency || this.supplier.currency || 'USD'} ${total}`,
        '', 'Ship to:', `  ${shipToText}`,
        payload.shippingMethod ? `Shipping method: ${payload.shippingMethod}` : '',
        '', 'Please confirm receipt and advise tracking once dispatched.',
      ].filter(Boolean).join('\n');

    const result = await sendMail({ to: this.config.orderEmail, subject, text: body });
    return {
      ok: true,
      supplierOrderId: null,
      reference: result?.id || null,
      message: `Purchase order emailed to ${this.config.orderEmail}`,
    };
  }
}

module.exports = { ManualConnector };
