'use strict';
/**
 * Payment gateway layer.
 *
 * Supported methods:
 *   CASH_ON_DELIVERY  — no gateway; payment captured manually on delivery.
 *   BANK_TRANSFER     — no gateway; instructions shown, payment captured
 *                       manually when the transfer arrives.
 *   STRIPE            — Checkout Sessions (hosted page) + webhook capture.
 *   PAYPAL            — Orders v2 (hosted approval) + webhook capture.
 *   WIPAY             — hosted checkout session + webhook capture.
 *   TILOPAY           — hosted checkout session + webhook capture.
 *
 * Every gateway exposes the same contract:
 *   createPayment(ctx)            -> { action, url?, reference?, sandbox, instructions? }
 *   verifyWebhook(rawBody, hdrs)  -> boolean
 *   parseWebhook(rawBody, hdrs)   -> { orderReference?, transactionId? } | null
 *
 * Sandbox / test mode: when a gateway's credentials are not configured the
 * adapters run in a clearly-labelled simulated mode **outside production** so
 * the full storefront flow remains testable. In production, an enabled but
 * unconfigured gateway is rejected with an actionable error instead.
 */
const crypto = require('crypto');

const PAYMENT_METHODS = ['CASH_ON_DELIVERY', 'BANK_TRANSFER', 'STRIPE', 'PAYPAL', 'WIPAY', 'TILOPAY'];
const GATEWAY_METHODS = ['STRIPE', 'PAYPAL', 'WIPAY', 'TILOPAY'];
const PAYMENT_STATUSES = ['PENDING', 'PAID', 'FAILED', 'REFUNDED'];

const isProd = () => process.env.NODE_ENV === 'production';

/** Shared secret used only in non-production sandbox webhook tests. */
const sandboxSecret = () => process.env.PAYMENT_SANDBOX_SECRET || 'dev-sandbox-secret';

class PaymentError extends Error {
  constructor(message, { code = 'PAYMENT_ERROR', config = false } = {}) {
    super(message);
    this.name = 'PaymentError';
    this.code = code;
    this.config = config; // true when the merchant must fix environment setup
  }
}

const paymentError = (message, opts) => new PaymentError(message, opts);
const configError = (missing) => new PaymentError(
  `${missing} is not configured. Add it to the server environment, or disable this payment method in Admin → Settings → Payments.`,
  { code: 'GATEWAY_NOT_CONFIGURED', config: true }
);

/* ------------------------------------------------------------------ http  */
async function httpJson(url, { method = 'POST', headers = {}, body, form } = {}) {
  const init = { method, headers, signal: AbortSignal.timeout(15000) };
  if (form) {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(form).toString();
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* non-JSON response */ }
  if (!res.ok) {
    throw paymentError(`Gateway request failed (${res.status}${json && json.message ? `: ${json.message}` : ''})`);
  }
  return json;
}

const basicAuth = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

/* ------------------------------------------------------------ signatures */
function hmacHex(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

function timingSafeEqualHex(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

/** Stripe signature scheme: HMAC-SHA256(webhookSecret, `${t}.${rawBody}`). */
function verifyStripeSignature(rawBody, headers) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return false;
  const header = headers['stripe-signature'] || headers['Stripe-Signature'];
  if (!header) return false;
  const parts = String(header).split(',').map((s) => s.trim());
  const t = parts.find((p) => p.startsWith('t='))?.slice(2);
  const v1 = parts.find((p) => p.startsWith('v1='))?.slice(3);
  if (!t || !v1) return false;
  return timingSafeEqualHex(hmacHex(secret, `${t}.${rawBody}`), v1);
}

/** CRC32 used by PayPal's webhook transmission signature. */
function crc32(str) {
  let crc = 0xffffffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i);
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** PayPal v2 webhook verification (HMAC variant using PAYPAL_WEBHOOK_SECRET). */
function verifyPaypalSignature(rawBody, headers) {
  const secret = process.env.PAYPAL_WEBHOOK_SECRET;
  if (!secret) return false;
  const id = headers['paypal-transmission-id'] || headers['Paypal-Transmission-Id'];
  const time = headers['paypal-transmission-time'] || headers['Paypal-Transmission-Time'];
  const webhookId = process.env.PAYPAL_WEBHOOK_ID || '';
  const sig = headers['paypal-transmission-sig'] || headers['Paypal-Transmission-Sig'];
  if (!id || !time || !sig) return false;
  const payload = `${id}|${time}|${webhookId}|${crc32(rawBody)}`;
  return timingSafeEqualHex(hmacHex(secret, payload), sig);
}

/** Generic HMAC scheme (WiPay / Tilopay / sandbox): `sha256=…` over the body. */
function verifyHmacSignature(rawBody, headers, secret) {
  const sig = headers['x-payment-signature'] || headers['x-signature'] || headers['signature'];
  if (!sig) return false;
  const expected = hmacHex(secret, rawBody);
  return timingSafeEqualHex(sig.replace(/^sha256=/i, ''), expected);
}

/* -------------------------------------------------------------- gateway  */
function gatewayEnv(name) {
  switch (name) {
    case 'STRIPE':
      return { configured: Boolean(process.env.STRIPE_SECRET_KEY), key: process.env.STRIPE_SECRET_KEY };
    case 'PAYPAL':
      return { configured: Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET) };
    case 'WIPAY':
      return { configured: Boolean(process.env.WIPAY_API_TOKEN && process.env.WIPAY_MERCHANT_ID) };
    case 'TILOPAY':
      return { configured: Boolean(process.env.TILOPAY_API_KEY) };
    default:
      return { configured: true };
  }
}

const GATEWAYS = {
  STRIPE: {
    label: 'Credit / Debit Card (Stripe)',
    async createPayment(ctx) {
      const env = gatewayEnv('STRIPE');
      if (!env.configured) return sandboxRedirect('STRIPE', ctx);
      const { order, customer, settings, baseUrl } = ctx;
      const currency = (settings.payment.currency || 'USD').toLowerCase();
      const session = await httpJson('https://api.stripe.com/v1/checkout/sessions', {
        headers: { Authorization: basicAuth(env.key, ''), 'Stripe-Version': '2024-06-20' },
        form: {
          mode: 'payment',
          success_url: `${baseUrl}/checkout.html?order=${order.reference}&status=paid`,
          cancel_url: `${baseUrl}/checkout.html?order=${order.reference}&status=cancelled`,
          client_reference_id: order.reference,
          customer_email: customer.email,
          metadata: { order_reference: order.reference },
          'line_items[0][quantity]': '1',
          'line_items[0][price_data][currency]': currency,
          'line_items[0][price_data][unit_amount]': String(Math.round(order.total * 100)),
          'line_items[0][price_data][product_data][name]': `Order ${order.reference}`.slice(0, 200),
        },
      });
      if (!session || !session.url) throw paymentError('Stripe did not return a checkout URL');
      return { action: 'redirect', url: session.url, reference: session.id, sandbox: false };
    },
    verifyWebhook(rawBody, headers) { return verifyStripeSignature(rawBody, headers); },
    parseWebhook(rawBody, headers, body) {
      if (!body || body.type !== 'checkout.session.completed') return null;
      const ref = body.data?.object?.client_reference_id || body.data?.object?.metadata?.order_reference;
      return { orderReference: ref, transactionId: body.data?.object?.payment_intent || body.id };
    },
  },

  PAYPAL: {
    label: 'PayPal',
    async createPayment(ctx) {
      const env = gatewayEnv('PAYPAL');
      if (!env.configured) return sandboxRedirect('PAYPAL', ctx);
      const { order, customer, settings, baseUrl } = ctx;
      const api = (process.env.PAYPAL_ENV || 'live') === 'sandbox'
        ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
      const created = await httpJson(`${api}/v2/checkout/orders`, {
        headers: { Authorization: basicAuth(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET) },
        body: {
          intent: 'CAPTURE',
          purchase_units: [{
            reference_id: order.reference,
            custom_id: order.reference,
            description: `Order ${order.reference}`.slice(0, 127),
            amount: { currency_code: settings.payment.currency || 'USD', value: order.total.toFixed(2) },
          }],
          application_context: {
            brand_name: (settings.company.name || 'N&D\'s').slice(0, 127),
            return_url: `${baseUrl}/checkout.html?order=${order.reference}&status=paid`,
            cancel_url: `${baseUrl}/checkout.html?order=${order.reference}&status=cancelled`,
            user_action: 'PAY_NOW',
          },
        },
      });
      const approve = (created.links || []).find((l) => l.rel === 'approve');
      if (!approve || !approve.href) throw paymentError('PayPal did not return an approval link');
      return { action: 'redirect', url: approve.href, reference: created.id, sandbox: false };
    },
    verifyWebhook(rawBody, headers) { return verifyPaypalSignature(rawBody, headers); },
    parseWebhook(rawBody, headers, body) {
      if (!body) return null;
      const event = body.event_type;
      if (!event || !/PAYMENT\.CAPTURE\.(COMPLETED|DENIED)/.test(event)) return null;
      const res = body.resource || {};
      const ref = res.custom_id
        || res.supplementary_data?.related_ids?.order_id
        || body.supplementary_data?.related_ids?.order_id;
      return { orderReference: ref, transactionId: res.id || body.id };
    },
  },

  WIPAY: {
    label: 'WiPay',
    async createPayment(ctx) {
      const env = gatewayEnv('WIPAY');
      if (!env.configured) return sandboxRedirect('WIPAY', ctx);
      const { order, customer, settings, baseUrl } = ctx;
      const endpoint = process.env.WIPAY_BASE_URL || 'https://www.wipaycaribbean.com/api/checkout';
      const res = await httpJson(endpoint, {
        form: {
          api_token: process.env.WIPAY_API_TOKEN,
          merchant_id: process.env.WIPAY_MERCHANT_ID,
          amount: order.total.toFixed(2),
          currency: settings.payment.currency || 'USD',
          order_id: order.reference,
          description: `Order ${order.reference}`.slice(0, 190),
          redirect_url: `${baseUrl}/checkout.html?order=${order.reference}&status=paid`,
          webhook_url: `${baseUrl}/api/payments/webhook/wipay`,
          customer_firstname: (customer.name || '').split(' ')[0].slice(0, 60),
          customer_lastname: (customer.name || '').split(' ').slice(1).join(' ').slice(0, 60),
          customer_email: customer.email,
          customer_phone: customer.phone || '',
        },
      });
      const url = res?.link || res?.redirect_url || res?.url || res?.checkout_url;
      if (!url) throw paymentError('WiPay did not return a checkout URL');
      return { action: 'redirect', url, reference: res?.id || res?.transaction_id || res?.order_id || order.reference, sandbox: false };
    },
    verifyWebhook(rawBody, headers) {
      return verifyHmacSignature(rawBody, headers, process.env.WIPAY_WEBHOOK_SECRET);
    },
    parseWebhook(rawBody, headers, body) {
      if (!body) return null;
      const ref = body.order_reference || body.orderReference || body.order_id || body.orderId;
      const tx = body.transaction_id || body.transactionId || body.id;
      return { orderReference: ref, transactionId: tx };
    },
  },

  TILOPAY: {
    label: 'Tilopay',
    async createPayment(ctx) {
      const env = gatewayEnv('TILOPAY');
      if (!env.configured) return sandboxRedirect('TILOPAY', ctx);
      const { order, customer, settings, baseUrl } = ctx;
      const endpoint = process.env.TILOPAY_BASE_URL || 'https://app.tilopay.com/api/checkout';
      const res = await httpJson(endpoint, {
        body: {
          api_key: process.env.TILOPAY_API_KEY,
          api_user: process.env.TILOPAY_API_USER || '',
          api_password: process.env.TILOPAY_API_PASSWORD || '',
          amount: order.total.toFixed(2),
          currency: settings.payment.currency || 'USD',
          reference: order.reference,
          description: `Order ${order.reference}`.slice(0, 190),
          success_url: `${baseUrl}/checkout.html?order=${order.reference}&status=paid`,
          cancel_url: `${baseUrl}/checkout.html?order=${order.reference}&status=cancelled`,
          callback_url: `${baseUrl}/api/payments/webhook/tilopay`,
          customer_name: customer.name,
          customer_email: customer.email,
        },
      });
      const url = res?.redirect_url || res?.link || res?.url || res?.checkout_url;
      if (!url) throw paymentError('Tilopay did not return a checkout URL');
      return { action: 'redirect', url, reference: res?.id || res?.transaction_id || order.reference, sandbox: false };
    },
    verifyWebhook(rawBody, headers) {
      return verifyHmacSignature(rawBody, headers, process.env.TILOPAY_WEBHOOK_SECRET);
    },
    parseWebhook(rawBody, headers, body) {
      if (!body) return null;
      const ref = body.order_reference || body.orderReference || body.reference;
      const tx = body.transaction_id || body.transactionId || body.id;
      return { orderReference: ref, transactionId: tx };
    },
  },
};

/** Non-production simulated gateway redirect so the full flow can be tested. */
function sandboxRedirect(gateway, ctx) {
  const { order, baseUrl } = ctx;
  const name = GATEWAYS[gateway].label;
  return {
    action: 'redirect',
    url: `${baseUrl}/checkout.html?order=${order.reference}&status=paid&sandbox=1`,
    reference: `sandbox_${gateway.toLowerCase()}_${Date.now().toString(36)}`,
    sandbox: true,
    instructions: `${name} is running in test mode because its API keys are not configured. No real payment was taken.`,
  };
}

/* -------------------------------------------------------------- public  */
function assertMethodEnabled(method, paymentSettings) {
  if (!PAYMENT_METHODS.includes(method)) throw paymentError(`Unknown payment method '${method}'`, { code: 'INVALID_METHOD' });
  const flags = {
    CASH_ON_DELIVERY: 'cashOnDelivery',
    BANK_TRANSFER: 'bankTransfer',
    STRIPE: 'stripeEnabled',
    PAYPAL: 'paypalEnabled',
    WIPAY: 'wipayEnabled',
    TILOPAY: 'tilopayEnabled',
  };
  if (paymentSettings[flags[method]] === false) {
    throw paymentError(`Payment method ${method.replace(/_/g, ' ').toLowerCase()} is currently disabled`, { code: 'METHOD_DISABLED' });
  }
  const gw = gatewayEnv(method);
  if (GATEWAY_METHODS.includes(method) && !gw.configured && isProd()) {
    throw configError(`${method} API credentials`);
  }
}

/**
 * Creates the gateway payment for a freshly created order.
 * Returns { action, url?, reference?, sandbox, instructions? }.
 */
async function createPayment(method, ctx) {
  if (!GATEWAY_METHODS.includes(method)) {
    // COD / bank transfer: nothing to do at the gateway — the merchant
    // captures the payment manually from the admin dashboard.
    const instructions = method === 'BANK_TRANSFER' && ctx.settings?.payment?.bankTransferDetails
      ? ctx.settings.payment.bankTransferDetails
      : '';
    return { action: 'manual', reference: null, sandbox: false, instructions };
  }
  const gateway = GATEWAYS[method];
  if (!gateway) throw paymentError(`Unsupported gateway '${method}'`, { code: 'INVALID_METHOD' });
  const result = await gateway.createPayment(ctx);
  // Persist the gateway transaction id on the order.
  if (result.reference) {
    await ctx.updateOrder({ paymentReference: result.reference });
  }
  return result;
}

/**
 * Verifies an incoming webhook. In production every gateway must produce a
 * valid signature; outside production an enabled-but-unconfigured gateway may
 * fall back to the sandbox shared secret so end-to-end tests can run.
 */
function verifyWebhook(method, rawBody, headers) {
  const gateway = GATEWAYS[method];
  if (!gateway) return false;
  if (gateway.verifyWebhook(rawBody, headers)) return true;
  const gw = gatewayEnv(method);
  if (!gw.configured && !isProd()) {
    return verifyHmacSignature(rawBody, headers, sandboxSecret());
  }
  return false;
}

/** Extracts { orderReference, transactionId } from a verified webhook body. */
function parseWebhook(method, rawBody, headers, body) {
  const gateway = GATEWAYS[method];
  return gateway ? gateway.parseWebhook(rawBody, headers, body) : null;
}

module.exports = {
  PAYMENT_METHODS,
  GATEWAY_METHODS,
  PAYMENT_STATUSES,
  PaymentError,
  paymentError,
  configError,
  gatewayEnv,
  assertMethodEnabled,
  createPayment,
  verifyWebhook,
  parseWebhook,
  sandboxSecret,
  gatewayConfig: (name) => gatewayEnv(name),
  gateways: () => Object.fromEntries(GATEWAY_METHODS.map((m) => [m, { label: GATEWAYS[m].label, configured: gatewayEnv(m).configured }])),
};
