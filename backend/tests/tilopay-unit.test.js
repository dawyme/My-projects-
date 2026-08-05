/**
 * Tilopay unit tests — mocks the Tilopay HTTP calls (login, processPayment,
 * consult) to confirm the flow end-to-end without hitting the real API.
 */
const assert = require('assert');

// ─── Mock infrastructure ───────────────────────────────────────────────
const mockCalls = [];
let mockResponses = new Map(); // url → response object

const originalFetch = globalThis.fetch;

function mockFetch(url, init) {
  mockCalls.push({ url: String(url), method: init.method, headers: { ...init.headers }, body: init.body });
  const key = String(url);
  const mock = mockResponses.get(key);
  if (mock) {
    const body = typeof mock === 'function' ? mock(url, init) : mock;
    return Promise.resolve({
      ok: body._ok !== false,
      status: body._status || 200,
      text: () => Promise.resolve(JSON.stringify(body)),
      json: () => Promise.resolve(body),
    });
  }
  // Unmocked URL — return a generic error.
  return Promise.resolve({
    ok: false,
    status: 500,
    text: () => Promise.resolve('not mocked'),
    json: () => Promise.resolve(null),
  });
}

function setupMock(url, response) { mockResponses.set(url, response); }
function clearMocks() { mockCalls.length = 0; mockResponses.clear(); }

// ─── Test runner ────────────────────────────────────────────────────────
const results = [];
let failures = 0;

async function test(name, fn) {
  try { await fn(); results.push(['PASS', name]); }
  catch (e) { failures++; results.push(['FAIL', `${name} — ${e.message}`]); }
}

// ─── Tests ──────────────────────────────────────────────────────────────
async function main() {
  // Install mock before requiring the payments module so it uses mockFetch.
  globalThis.fetch = mockFetch;

  // Set env vars so Tilopay appears configured.
  process.env.TILOPAY_API_USER = 'test_api_user';
  process.env.TILOPAY_API_PASSWORD = 'test_api_password';
  process.env.TILOPAY_API_KEY = 'test_api_key';
  process.env.NODE_ENV = 'test';

  const payments = require('../src/lib/payments');

  // ── 1. Token handling (login + caching) ─────────────────────────────
  await test('getTilopayToken calls login and returns access_token', async () => {
    clearMocks();
    payments._resetTilopayTokenCache();
    setupMock('https://app.tilopay.com/api/v1/login', {
      access_token: 'mock_token_123',
      token_type: 'bearer',
      expires_in: 86400,
    });
    const token = await payments.getTilopayToken();
    assert.strictEqual(token, 'mock_token_123');
    // Should have called login exactly once.
    const loginCalls = mockCalls.filter((c) => c.url === 'https://app.tilopay.com/api/v1/login');
    assert.strictEqual(loginCalls.length, 1);
    // Body should contain apiuser + password.
    const body = JSON.parse(loginCalls[0].body);
    assert.strictEqual(body.apiuser, 'test_api_user');
    assert.strictEqual(body.password, 'test_api_password');
  });

  await test('getTilopayToken reuses cached token without calling login again', async () => {
    clearMocks();
    // Token was cached in the previous test — no mock needed.
    const token = await payments.getTilopayToken();
    assert.strictEqual(token, 'mock_token_123');
    const loginCalls = mockCalls.filter((c) => c.url === 'https://app.tilopay.com/api/v1/login');
    assert.strictEqual(loginCalls.length, 0, 'should not call login when token is cached');
  });

  await test('getTilopayToken re-logs in when token is near expiry', async () => {
    clearMocks();
    payments._resetTilopayTokenCache();
    // First login returns a token that expires in 30s (less than the 60s buffer).
    setupMock('https://app.tilopay.com/api/v1/login', {
      access_token: 'short_lived_token',
      token_type: 'bearer',
      expires_in: 30, // 30s — less than 60s buffer, so will be considered expired
    });
    const token = await payments.getTilopayToken();
    assert.strictEqual(token, 'short_lived_token');
    // Now get again — since 30s < 60s buffer, the token is already "near expiry"
    // so it should re-login.
    setupMock('https://app.tilopay.com/api/v1/login', {
      access_token: 'refreshed_token',
      token_type: 'bearer',
      expires_in: 86400,
    });
    const token2 = await payments.getTilopayToken();
    assert.strictEqual(token2, 'refreshed_token');
  });

  // ── 2. createPayment (processPayment) ──────────────────────────────
  await test('TILOPAY.createPayment calls processPayment with correct body and returns redirect', async () => {
    clearMocks();
    payments._resetTilopayTokenCache();
    setupMock('https://app.tilopay.com/api/v1/login', {
      access_token: 'create_pay_token',
      token_type: 'bearer',
      expires_in: 86400,
    });
    setupMock('https://app.tilopay.com/api/v1/processPayment', {
      type: '100',
      html: 'Use url redirect',
      url: 'https://secure.tilopay.com/htmls/test_payment.html',
    });

    const ctx = {
      order: { reference: 'OR-TEST-123', total: 150.00 },
      customer: { name: 'John Doe', email: 'john@example.com', phone: '8681234567', address: '12 Frederick St', city: 'Port of Spain' },
      settings: { payment: { currency: 'TTD' } },
      baseUrl: 'https://shop.example.com',
      updateOrder: async () => {},
    };

    const result = await payments.GATEWAYS?.TILOPAY?.createPayment?.(ctx)
      || await payments.createPayment('TILOPAY', ctx);

    assert.strictEqual(result.action, 'redirect');
    assert.strictEqual(result.url, 'https://secure.tilopay.com/htmls/test_payment.html');
    assert.strictEqual(result.reference, 'OR-TEST-123');
    assert.strictEqual(result.sandbox, false);

    // Verify the processPayment call had the right structure.
    const ppCalls = mockCalls.filter((c) => c.url === 'https://app.tilopay.com/api/v1/processPayment');
    assert.strictEqual(ppCalls.length, 1);
    const body = JSON.parse(ppCalls[0].body);
    assert.strictEqual(body.key, 'test_api_key');
    assert.strictEqual(body.amount, '150.00');
    assert.strictEqual(body.currency, 'TTD');
    assert.strictEqual(body.orderNumber, 'OR-TEST-123');
    assert.strictEqual(body.capture, '1');
    assert.strictEqual(body.subscription, '0');
    assert.strictEqual(body.platform, 'web');
    assert.strictEqual(body.token_version, 'v2');
    assert.strictEqual(body.hashVersion, 'V2');
    assert.strictEqual(body.billToFirstName, 'John');
    assert.strictEqual(body.billToLastName, 'Doe');
    assert.strictEqual(body.billToAddress, '12 Frederick St');
    assert.strictEqual(body.billToCity, 'Port of Spain');
    assert.strictEqual(body.billToCountry, 'TT');
    assert.strictEqual(body.billToEmail, 'john@example.com');
    assert.strictEqual(body.billToTelephone, '8681234567');
    assert.strictEqual(body.billToZipPostCode, '00000');
    // Ship-to mirrors bill-to.
    assert.strictEqual(body.shipToFirstName, 'John');
    assert.strictEqual(body.shipToLastName, 'Doe');
    assert.strictEqual(body.shipToCountry, 'TT');
    // Authorization header includes bearer token.
    const auth = ppCalls[0].headers.Authorization || ppCalls[0].headers.authorization;
    assert.ok(auth && auth.includes('bearer'), 'Authorization header should include bearer');
    // Redirect URL contains the order reference.
    assert.ok(body.redirect.includes('checkout.html?order=OR-TEST-123'), 'redirect should include checkout URL with order reference');
  });

  await test('TILOPAY.createPayment throws when type is not "100"', async () => {
    clearMocks();
    payments._resetTilopayTokenCache();
    setupMock('https://app.tilopay.com/api/v1/login', {
      access_token: 'fail_token',
      token_type: 'bearer',
      expires_in: 86400,
    });
    setupMock('https://app.tilopay.com/api/v1/processPayment', {
      type: '200',
      description: 'Insufficient funds',
    });

    const ctx = {
      order: { reference: 'OR-FAIL-456', total: 99.99 },
      customer: { name: 'Jane Smith', email: 'jane@example.com', phone: '', address: '', city: '' },
      settings: { payment: { currency: 'USD' } },
      baseUrl: 'https://shop.example.com',
      updateOrder: async () => {},
    };

    await assert.rejects(
      async () => {
        try {
          return await payments.GATEWAYS?.TILOPAY?.createPayment?.(ctx)
            || await payments.createPayment('TILOPAY', ctx);
        } catch (e) {
          // The outer createPayment may wrap it; re-throw to let rejects catch it.
          throw e;
        }
      },
      (err) => {
        assert.ok(err.message.includes('Tilopay payment failed'), `Expected Tilopay error, got: ${err.message}`);
        assert.ok(err.message.includes('Insufficient funds'), `Expected description in error, got: ${err.message}`);
        return true;
      }
    );
  });

  // ── 3. confirmTilopayPayment (consult) ─────────────────────────────
  await test('confirmTilopayPayment returns paid:true when latest entry code is "1"', async () => {
    clearMocks();
    payments._resetTilopayTokenCache();
    setupMock('https://app.tilopay.com/api/v1/login', {
      access_token: 'consult_token',
      token_type: 'bearer',
      expires_in: 86400,
    });
    setupMock('https://app.tilopay.com/api/v1/consult', {
      response: [
        { code: '1', auth: 'AUTH12345', orderNumber: 'OR-CONFIRM-1', tpt: '5000' },
      ],
    });

    const result = await payments.confirmTilopayPayment('OR-CONFIRM-1');
    assert.strictEqual(result.paid, true);
    assert.strictEqual(result.transactionId, 'AUTH12345');

    // Verify the consult call.
    const consultCalls = mockCalls.filter((c) => c.url === 'https://app.tilopay.com/api/v1/consult');
    assert.strictEqual(consultCalls.length, 1);
    const body = JSON.parse(consultCalls[0].body);
    assert.strictEqual(body.key, 'test_api_key');
    assert.strictEqual(body.orderNumber, 'OR-CONFIRM-1');
    assert.strictEqual(body.merchantId, '');
  });

  await test('confirmTilopayPayment uses the most recent entry when multiple exist', async () => {
    clearMocks();
    payments._resetTilopayTokenCache();
    setupMock('https://app.tilopay.com/api/v1/login', {
      access_token: 'consult_token_2',
      token_type: 'bearer',
      expires_in: 86400,
    });
    setupMock('https://app.tilopay.com/api/v1/consult', {
      response: [
        { code: '2', description: 'Declined', auth: '', orderNumber: 'OR-CONFIRM-2' },
        { code: '1', auth: 'AUTH67890', orderNumber: 'OR-CONFIRM-2', tpt: '7500' },
      ],
    });

    const result = await payments.confirmTilopayPayment('OR-CONFIRM-2');
    assert.strictEqual(result.paid, true);
    assert.strictEqual(result.transactionId, 'AUTH67890');
  });

  await test('confirmTilopayPayment returns paid:false when code is not "1"', async () => {
    clearMocks();
    payments._resetTilopayTokenCache();
    setupMock('https://app.tilopay.com/api/v1/login', {
      access_token: 'declined_token',
      token_type: 'bearer',
      expires_in: 86400,
    });
    setupMock('https://app.tilopay.com/api/v1/consult', {
      response: [
        { code: '2', description: 'Transaction declined', auth: '', orderNumber: 'OR-DECLINED' },
      ],
    });

    const result = await payments.confirmTilopayPayment('OR-DECLINED');
    assert.strictEqual(result.paid, false);
  });

  await test('confirmTilopayPayment returns paid:false when response array is empty', async () => {
    clearMocks();
    payments._resetTilopayTokenCache();
    setupMock('https://app.tilopay.com/api/v1/login', {
      access_token: 'empty_token',
      token_type: 'bearer',
      expires_in: 86400,
    });
    setupMock('https://app.tilopay.com/api/v1/consult', { response: [] });

    const result = await payments.confirmTilopayPayment('OR-EMPTY');
    assert.strictEqual(result.paid, false);
  });

  // ── 4. Webhook stubs (always reject for TILOPAY) ──────────────────
  await test('TILOPAY verifyWebhook always returns false (no webhook)', () => {
    assert.strictEqual(payments.verifyWebhook('TILOPAY', '{}', {}), false);
  });

  await test('TILOPAY parseWebhook always returns null (no webhook)', () => {
    assert.strictEqual(payments.parseWebhook('TILOPAY', '{}', {}, {}), null);
  });

  // ── 5. gatewayEnv for TILOPAY requires all three credentials ───────
  await test('gatewayEnv TILOPAY requires API_USER, API_PASSWORD, and API_KEY', () => {
    const orig = { u: process.env.TILOPAY_API_USER, p: process.env.TILOPAY_API_PASSWORD, k: process.env.TILOPAY_API_KEY };
    process.env.TILOPAY_API_USER = 'u';
    process.env.TILOPAY_API_PASSWORD = 'p';
    process.env.TILOPAY_API_KEY = 'k';
    assert.strictEqual(payments.gatewayEnv('TILOPAY').configured, true);
    delete process.env.TILOPAY_API_USER;
    assert.strictEqual(payments.gatewayEnv('TILOPAY').configured, false);
    process.env.TILOPAY_API_USER = orig.u;
    process.env.TILOPAY_API_PASSWORD = orig.p;
    process.env.TILOPAY_API_KEY = orig.k;
  });

  // ─── Cleanup ──────────────────────────────────────────────────────
  globalThis.fetch = originalFetch;
  delete process.env.TILOPAY_API_USER;
  delete process.env.TILOPAY_API_PASSWORD;
  delete process.env.TILOPAY_API_KEY;

  const pass = results.filter((r) => r[0] === 'PASS').length;
  console.log('\nTilopay unit tests\n==================');
  for (const [state, name] of results) console.log(`  ${state === 'PASS' ? '✔' : '✘'} ${name}`);
  console.log(`\n${pass}/${results.length} checks passed${failures ? ` — ${failures} FAILED` : ''}\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
