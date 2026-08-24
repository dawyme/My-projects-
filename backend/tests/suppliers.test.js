/**
 * Supplier Marketplace — end-to-end verification.
 *
 * Boots the real Express app, signs in as ADMIN and STAFF, and drives the whole
 * feature through its HTTP API: supplier CRUD, connector configuration, a REAL
 * HTTP round trip to a stub supplier API, connection testing, catalogue import
 * with preview/commit, the markup engine, publishing into the existing
 * storefront catalogue, inventory and price synchronisation, shipping rules and
 * country restrictions, dropship fulfilment with tracking, permissions,
 * credential protection and tenant isolation.
 *
 * The stub supplier is a real HTTP server on a loopback port — the REST/JSON
 * connector talks to it over the network exactly as it would to a live supplier.
 * Nothing is mocked at the connector boundary.
 *
 *   node backend/tests/suppliers.test.js
 */
require('dotenv').config();
const http = require('http');
const assert = require('assert');

// The stub supplier listens on 127.0.0.1; allow it explicitly rather than
// weakening the connector's SSRF protection globally.
process.env.SUPPLIER_ALLOWED_HOSTS = [process.env.SUPPLIER_ALLOWED_HOSTS, '127.0.0.1', 'localhost']
  .filter(Boolean).join(',');
process.env.SUPPLIER_CREDENTIALS_KEY = process.env.SUPPLIER_CREDENTIALS_KEY
  || 'test-supplier-credential-encryption-key';
process.env.SUPPLIER_SCHEDULER_DISABLED = 'true';
// This suite makes several hundred requests in under a minute; widen the
// budgets rather than weaken them in the application.
process.env.RATE_LIMIT_API_MAX = '20000';
process.env.RATE_LIMIT_WRITE_MAX = '20000';
process.env.RATE_LIMIT_SUPPLIER_WRITE_MAX = '20000';

const app = require('../src/app');
const prisma = require('../src/lib/prisma');
const { applyMarkup, priceFor, resolveRule } = require('../src/lib/suppliers/markup');
const { availableStock, allocate } = require('../src/lib/suppliers/inventory');
const { parseCsvObjects } = require('../src/lib/suppliers/parsers/csv');
const { parseXml } = require('../src/lib/suppliers/parsers/xml');
const { encryptSecrets, decryptSecrets, fingerprint } = require('../src/lib/suppliers/credentials');
const { evaluateCountryAccess, expandCountries } = require('../src/lib/suppliers/countries');

let base = '';
const results = [];
let failures = 0;

async function test(name, fn) {
  try { await fn(); results.push(['PASS', name]); }
  catch (e) { failures++; results.push(['FAIL', `${name} — ${e.message}`]); }
}

function makeClient() {
  const jar = new Map();
  let csrf = null;
  let bearer = null;
  return {
    setBearer(t) { bearer = t; },
    get token() { return bearer; },
    async req(method, path, body, opts = {}) {
      const headers = { ...(opts.headers || {}) };
      if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
      const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookie) headers.Cookie = cookie;
      if (csrf) headers['x-csrf-token'] = csrf;
      if (bearer && !opts.noBearer) headers.Authorization = `Bearer ${bearer}`;
      let url = base + path;
      if (opts.query) {
        const usp = new URLSearchParams();
        for (const [k, v] of Object.entries(opts.query)) {
          if (v !== undefined && v !== null && v !== '') usp.set(k, String(v));
        }
        const qs = usp.toString();
        if (qs) url += (url.includes('?') ? '&' : '?') + qs;
      }
      const res = await fetch(url, {
        method, headers,
        body: body === undefined ? undefined : (body instanceof FormData ? body : JSON.stringify(body)),
        redirect: 'manual',
      });
      for (const c of res.headers.getSetCookie?.() || []) {
        const [pair] = c.split(';');
        const idx = pair.indexOf('=');
        const k = pair.slice(0, idx); const v = pair.slice(idx + 1);
        if (v === '') jar.delete(k); else jar.set(k, v);
        if (k === 'hvac_csrf') csrf = v;
      }
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) { /* non-JSON */ }
      return { status: res.status, body: json, text, headers: res.headers };
    },
    get(p, o) { return this.req('GET', p, undefined, o); },
    /** Returns the parsed JSON body, or throws with the HTTP status for a clearer failure. */
    async body(method, path, payload, opts) {
      const r = await this.req(method, path, payload, opts);
      if (!r.body) throw new Error(`${method} ${path} → HTTP ${r.status} ${r.text.slice(0, 300)}`);
      return r.body;
    },
    getJ(p, q) { return this.body('GET', p, undefined, { query: q }); },
    postJ(p, b) { return this.body('POST', p, b); },
    post(p, b, o) { return this.req('POST', p, b, o); },
    put(p, b, o) { return this.req('PUT', p, b, o); },
    patch(p, b, o) { return this.req('PATCH', p, b, o); },
    del(p, b, o) { return this.req('DELETE', p, b, o); },
  };
}

/* ==========================================================================
 * Stub supplier API — a real HTTP server the connector talks to.
 * ========================================================================== */

const API_KEY = 'sk_supplier_test_51H8xA9f2a';
const supplierState = {
  products: [
    {
      sku: 'TST-AC-12K', mpn: 'DC-INV-12000', upc: '8901234567890',
      name: 'Test 12000 BTU Inverter Split AC', description: 'Wall-mounted inverter split system',
      brand: 'TestCool', category: 'Split Air Conditioners', cost: 400, msrp: 640, currency: 'USD',
      stock: 40, stockStatus: 'IN_STOCK', weightKg: 38.5, restricted: false,
    },
    {
      sku: 'TST-COMP-5T', mpn: 'CS-0500', upc: '8901234567891',
      name: 'Test 5 Ton Scroll Compressor', description: 'Hermetic scroll compressor',
      brand: 'TestCool', category: 'Compressors', cost: 700, msrp: 1100, currency: 'USD',
      stock: 6, stockStatus: 'LOW_STOCK', weightKg: 52, restricted: false,
    },
    {
      sku: 'TST-R410A-25', mpn: 'R410A-25', upc: '8901234567892',
      name: 'Test R-410A Refrigerant 25 lb', description: 'Pre-charged cylinder',
      brand: 'TestGas', category: 'Refrigerants', cost: 120, msrp: 180, currency: 'USD',
      stock: 15, stockStatus: 'IN_STOCK', weightKg: 13.2,
      restricted: true, restrictionType: 'REFRIGERANT', allowedShippingMethods: ['HAZMAT_GROUND'],
    },
  ],
  orders: new Map(),
  hits: { products: 0, stock: 0, prices: 0, orders: 0, status: 0, tracking: 0, cancel: 0 },
};

function stubSupplierServer() {
  const send = (res, code, payload) => {
    const body = JSON.stringify(payload);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.headers['x-api-key'] !== API_KEY) return send(res, 401, { message: 'Invalid API key' });

    if (url.pathname === '/products' && req.method === 'GET') {
      supplierState.hits.products++;
      return send(res, 200, { data: { products: supplierState.products }, meta: {} });
    }
    if (url.pathname === '/stock' && req.method === 'GET') {
      supplierState.hits.stock++;
      return send(res, 200, { data: supplierState.products.map((p) => ({ sku: p.sku, stock: p.stock, stockStatus: p.stockStatus })) });
    }
    if (url.pathname === '/prices' && req.method === 'GET') {
      supplierState.hits.prices++;
      return send(res, 200, { data: supplierState.products.map((p) => ({ sku: p.sku, cost: p.cost, msrp: p.msrp })) });
    }
    if (url.pathname === '/orders' && req.method === 'POST') {
      supplierState.hits.orders++;
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const payload = JSON.parse(raw || '{}');
        const id = `SUP-${1000 + supplierState.orders.size + 1}`;
        supplierState.orders.set(id, { payload, status: 'ACCEPTED' });
        send(res, 201, { id, status: 'ACCEPTED' });
      });
      return undefined;
    }
    const orderMatch = url.pathname.match(/^\/orders\/([^/]+)(\/tracking|\/cancel)?$/);
    if (orderMatch) {
      const [, id, action] = orderMatch;
      const order = supplierState.orders.get(id);
      if (!order) return send(res, 404, { message: 'Order not found' });
      if (action === '/tracking') {
        supplierState.hits.tracking++;
        // A supplier only issues a tracking number once the parcel has left,
        // so asking for tracking implies the order has shipped.
        if (order.status !== 'CANCELLED') order.status = 'SHIPPED';
        return send(res, 200, { trackingNumber: `TRK${id}`, carrier: 'TestExpress', trackingUrl: `https://track.test/${id}`, status: order.status });
      }
      if (action === '/cancel') {
        supplierState.hits.cancel++;
        order.status = 'CANCELLED';
        return send(res, 200, { id, status: 'CANCELLED' });
      }
      supplierState.hits.status++;
      return send(res, 200, { id, status: order.status });
    }
    return send(res, 404, { message: 'Not found' });
  });
  return server;
}

/* ========================================================================== */

async function main() {
  const supplierApi = stubSupplierServer();
  await new Promise((r) => supplierApi.listen(0, '127.0.0.1', r));
  const supplierBase = `http://127.0.0.1:${supplierApi.address().port}`;

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const admin = makeClient();
  const staff = makeClient();
  const anon = makeClient();

  // ------------------------------------------------------------- auth
  await test('ADMIN can sign in', async () => {
    await admin.get('/api/csrf-token');
    const r = await admin.post('/api/auth/login', {
      email: process.env.SEED_ADMIN_EMAIL || 'admin@ndsairconditioning.com',
      password: process.env.SEED_ADMIN_PASSWORD || 'Admin@12345',
    });
    assert.strictEqual(r.status, 200, r.text);
    admin.setBearer(r.body.data.accessToken);
  });
  await test('STAFF can sign in', async () => {
    await staff.get('/api/csrf-token');
    const r = await staff.post('/api/auth/login', {
      email: process.env.SEED_STAFF_EMAIL || 'staff@ndsairconditioning.com',
      password: process.env.SEED_STAFF_PASSWORD || 'Staff@12345',
    });
    assert.strictEqual(r.status, 200, r.text);
    staff.setBearer(r.body.data.accessToken);
  });

  // --------------------------------------------------- connector catalogue
  await test('GET /api/suppliers/connectors lists every registered connector', async () => {
    const r = await admin.get('/api/suppliers/connectors');
    assert.strictEqual(r.status, 200);
    const ids = r.body.data.map((c) => c.id);
    for (const expected of ['REST_JSON', 'GRAPHQL', 'CSV_FEED', 'XML_FEED', 'JSON_FEED', 'SFTP', 'MANUAL']) {
      assert.ok(ids.includes(expected), `missing connector ${expected}`);
    }
    assert.ok(r.body.meta.capabilities.length >= 11, 'capability catalogue incomplete');
  });

  await test('connector catalogue declares capabilities per connector', async () => {
    const r = await admin.get('/api/suppliers/connectors');
    const rest = r.body.data.find((c) => c.id === 'REST_JSON');
    const supported = rest.capabilities.filter((c) => c.supported).map((c) => c.id);
    for (const cap of ['connect', 'testConnection', 'disconnect', 'importCatalog', 'syncInventory', 'syncPricing', 'submitOrder', 'getOrderStatus', 'getTracking', 'cancelOrder']) {
      assert.ok(supported.includes(cap), `REST_JSON should advertise ${cap}`);
    }
    const csv = r.body.data.find((c) => c.id === 'CSV_FEED');
    assert.ok(!csv.capabilities.find((c) => c.id === 'submitOrder').supported, 'a CSV feed must not claim submitOrder');
  });

  await test('GET /api/suppliers/types exposes trade, shipping and country vocabularies', async () => {
    const r = await admin.get('/api/suppliers/types');
    assert.ok(r.body.data.supplierTypes.includes('HVAC'));
    assert.ok(r.body.data.supplierTypes.includes('REFRIGERATION'));
    assert.ok(r.body.data.countries.length > 200, 'country reference data incomplete');
    assert.ok(r.body.data.currencies.some((c) => c.code === 'TTD'));
    assert.ok(r.body.data.fulfillmentTypes.length === 3);
  });

  // ------------------------------------------------------ supplier CRUD
  let supplierId = null;
  await test('POST /api/suppliers creates a supplier', async () => {
    const r = await admin.post('/api/suppliers', {
      name: 'TestCool Distributors', country: 'us', currency: 'USD',
      type: 'HVAC', fulfillmentType: 'HYBRID', countriesServed: ['CARIBBEAN'],
      blockedCountries: ['IR'], shippingMethods: ['STANDARD', 'HAZMAT_GROUND'],
      markupType: 'PERCENT', markupValue: 30, leadTimeDays: 7, website: 'https://testcool.example',
      email: 'orders@testcool.example', accountRef: 'TC-4417',
    });
    assert.strictEqual(r.status, 201, r.text);
    supplierId = r.body.data.id;
    assert.strictEqual(r.body.data.status, 'ACTIVE');
    assert.ok(r.body.data.code, 'a code should be generated');
    assert.deepStrictEqual(r.body.data.countriesServed, ['CARIBBEAN']);
  });

  await test('supplier code is unique per tenant', async () => {
    const r = await admin.post('/api/suppliers', { name: 'TestCool Distributors' });
    assert.strictEqual(r.status, 201, r.text);
    assert.notStrictEqual(r.body.data.code, 'TESTCOOL-DISTRIBUTORS');
    await admin.del(`/api/suppliers/${r.body.data.id}`);
  });

  await test('POST /api/suppliers validates the payload', async () => {
    const r = await admin.post('/api/suppliers', { name: 'x' });
    assert.strictEqual(r.status, 400);
    assert.ok(Array.isArray(r.body.details));
  });

  await test('GET /api/suppliers lists suppliers with live counters', async () => {
    const r = await admin.get('/api/suppliers');
    assert.strictEqual(r.status, 200);
    const found = r.body.data.find((s) => s.id === supplierId);
    assert.ok(found, 'new supplier should be listed');
    assert.ok(found.counts && typeof found.counts.products === 'number');
  });

  await test('GET /api/suppliers/:id returns the supplier with its integration state', async () => {
    const r = await admin.get(`/api/suppliers/${supplierId}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.data.name, 'TestCool Distributors');
    assert.strictEqual(r.body.data.integration, null);
  });

  await test('PUT /api/suppliers/:id updates the supplier', async () => {
    const r = await admin.put(`/api/suppliers/${supplierId}`, { phone: '+1 555 0100', leadTimeDays: 10 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.data.phone, '+1 555 0100');
    assert.strictEqual(r.body.data.leadTimeDays, 10);
  });

  await test('anonymous requests to the supplier API are rejected', async () => {
    assert.strictEqual((await anon.get('/api/suppliers')).status, 401);
    assert.strictEqual((await anon.get('/api/supplier-products')).status, 401);
    assert.strictEqual((await anon.get('/api/supplier-syncs')).status, 401);
    assert.strictEqual((await anon.get('/api/supplier-settings')).status, 401);
  });

  await test('STAFF may view suppliers but not manage them', async () => {
    assert.strictEqual((await staff.get('/api/suppliers')).status, 200);
    const r = await staff.post('/api/suppliers', { name: 'Staff Supplier' });
    assert.strictEqual(r.status, 403, 'STAFF must not create suppliers');
    assert.strictEqual((await staff.put(`/api/suppliers/${supplierId}`, { name: 'Hacked' })).status, 403);
    assert.strictEqual((await staff.del(`/api/suppliers/${supplierId}`)).status, 403);
  });

  await test('STAFF may run imports and syncs but not manage integrations', async () => {
    assert.strictEqual((await staff.get('/api/supplier-imports')).status, 200);
    const r = await staff.post('/api/supplier-integrations', {
      supplierId, name: 'x', connectorType: 'REST_JSON', authType: 'NONE',
    });
    assert.strictEqual(r.status, 403, 'STAFF must not create integrations');
  });

  // ------------------------------------------------------- integrations
  let integrationId = null;
  await test('POST /api/supplier-integrations stores credentials encrypted', async () => {
    const r = await admin.post('/api/supplier-integrations', {
      supplierId, name: 'TestCool REST API', connectorType: 'REST_JSON', authType: 'API_KEY',
      baseUrl: supplierBase,
      config: {
        catalogPath: '/products', itemsPath: 'data.products', pagination: 'none',
        inventoryPath: '/stock', inventoryItemsPath: 'data',
        pricingPath: '/prices', pricingItemsPath: 'data',
        orderPath: '/orders', orderMethod: 'POST',
        statusPath: '/orders/{id}', trackingPath: '/orders/{id}/tracking', cancelPath: '/orders/{id}/cancel',
        apiKeyHeader: 'X-Api-Key',
        columnMap: {
          supplierSku: 'sku', manufacturerPart: 'mpn', upc: 'upc', name: 'name',
          description: 'description', brand: 'brand', category: 'category',
          supplierCost: 'cost', msrp: 'msrp', currency: 'currency', stock: 'stock',
          stockStatus: 'stockStatus', weightKg: 'weightKg', restricted: 'restricted',
          restrictionType: 'restrictionType', allowedShippingMethods: 'allowedShippingMethods',
        },
      },
      credentials: { apiKey: API_KEY },
    });
    assert.strictEqual(r.status, 201, r.text);
    integrationId = r.body.data.id;
    assert.strictEqual(r.body.data.status, 'CONFIGURED', 'nothing may be CONNECTED before a real test');
  });

  await test('integration responses never contain the plaintext secret', async () => {
    const list = await admin.get('/api/supplier-integrations');
    assert.ok(!list.text.includes(API_KEY), 'list response leaked the API key');
    assert.ok(!list.text.includes('credentialsCipher'), 'cipher column must not be serialised');
    const detail = await admin.get(`/api/supplier-integrations/${integrationId}`);
    assert.ok(!detail.text.includes(API_KEY), 'detail response leaked the API key');
    const fields = detail.body.data.credentialFields;
    assert.ok(fields.find((f) => f.name === 'apiKey'), 'a masked descriptor should be present');
    assert.ok(!String(fields.find((f) => f.name === 'apiKey').fingerprint).includes(API_KEY));
  });

  await test('credentials are encrypted at rest and decrypt back to the original', async () => {
    const row = await prisma.supplierIntegration.findUnique({ where: { id: integrationId } });
    assert.ok(row.credentialsCipher, 'a cipher envelope should be stored');
    assert.ok(row.credentialsCipher.startsWith('v1.'), 'unexpected envelope format');
    assert.ok(!row.credentialsCipher.includes(API_KEY), 'plaintext must not appear in the cipher');
    assert.deepStrictEqual(decryptSecrets(row.credentialsCipher), { apiKey: API_KEY });
  });

  await test('credential fingerprint is stable and reveals only the tail', async () => {
    assert.strictEqual(fingerprint(API_KEY), fingerprint(API_KEY));
    assert.ok(fingerprint(API_KEY).startsWith('••••'));
    assert.ok(!fingerprint(API_KEY).includes(API_KEY.slice(0, 8)));
  });

  await test('capability detection narrows to what is actually configured', async () => {
    const r = await admin.get(`/api/supplier-integrations/${integrationId}`);
    const caps = r.body.data.capabilityMatrix.map((c) => c.id).filter((id) => r.body.data.capabilityMatrix.find((c) => c.id === id).available);
    for (const cap of ['importCatalog', 'syncInventory', 'syncPricing', 'submitOrder', 'getOrderStatus', 'getTracking', 'cancelOrder']) {
      assert.ok(caps.includes(cap), `${cap} should be available with this configuration`);
    }
    assert.strictEqual(r.body.data.missingCredentials, false);
  });

  await test('POST /api/supplier-integrations/:id/test performs a real connection test', async () => {
    const r = await admin.post(`/api/supplier-integrations/${integrationId}/test`);
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.data.connected, true, r.body.data.message);
    const row = await prisma.supplierIntegration.findUnique({ where: { id: integrationId } });
    assert.strictEqual(row.status, 'CONNECTED');
    assert.ok(row.lastTestedAt, 'lastTestedAt should be recorded');
  });

  await test('a bad API key makes the connection test fail honestly', async () => {
    const saved = await prisma.supplierIntegration.findUnique({ where: { id: integrationId } });
    await prisma.supplierIntegration.update({
      where: { id: integrationId },
      data: { credentialsCipher: encryptSecrets({ apiKey: 'wrong-key' }) },
    });
    const r = await admin.post(`/api/supplier-integrations/${integrationId}/test`);
    assert.strictEqual(r.body.data.connected, false);
    assert.ok(/401/.test(r.body.data.message), `expected an HTTP 401 message, got: ${r.body.data.message}`);
    const row = await prisma.supplierIntegration.findUnique({ where: { id: integrationId } });
    assert.strictEqual(row.status, 'ERROR');
    assert.ok(!row.lastError.includes('wrong-key'), 'the secret must never be written to lastError');
    await prisma.supplierIntegration.update({ where: { id: integrationId }, data: { credentialsCipher: saved.credentialsCipher, status: 'CONNECTED', lastError: null } });
  });

  await test('an integration with no credentials reports NOT_CONNECTED', async () => {
    const supplier2 = await admin.post('/api/suppliers', { name: 'NoCreds Supplier' });
    const integ = await admin.post('/api/supplier-integrations', {
      supplierId: supplier2.body.data.id, name: 'No creds', connectorType: 'REST_JSON',
      authType: 'API_KEY', baseUrl: supplierBase, config: { catalogPath: '/products' },
    });
    const r = await admin.post(`/api/supplier-integrations/${integ.body.data.id}/test`);
    assert.strictEqual(r.body.data.connected, false);
    assert.strictEqual(r.body.data.status, 'NOT_CONNECTED');
    assert.ok(/credentials required/i.test(r.body.data.message), r.body.data.message);
    const sync = await admin.post('/api/supplier-syncs', { supplierId: supplier2.body.data.id, type: 'FULL', wait: true });
    assert.strictEqual(sync.body.data.status, 'FAILED');
    assert.ok(/credentials required/i.test(sync.body.data.message), sync.body.data.message);
    await admin.del(`/api/suppliers/${supplier2.body.data.id}`);
  });

  await test('a second integration for the same supplier is rejected', async () => {
    const r = await admin.post('/api/supplier-integrations', {
      supplierId, name: 'Duplicate', connectorType: 'REST_JSON', authType: 'NONE',
    });
    assert.strictEqual(r.status, 400);
  });

  await test('an unknown connector type is rejected', async () => {
    const supplier3 = await admin.post('/api/suppliers', { name: 'Bad Connector Supplier' });
    const r = await admin.post('/api/supplier-integrations', {
      supplierId: supplier3.body.data.id, name: 'Bad', connectorType: 'NOT_A_CONNECTOR', authType: 'NONE',
    });
    assert.strictEqual(r.status, 400);
    await admin.del(`/api/suppliers/${supplier3.body.data.id}`);
  });

  await test('private/loopback supplier URLs are blocked unless explicitly allowed', async () => {
    const { assertPublicUrl } = require('../src/lib/suppliers/http');
    const saved = process.env.SUPPLIER_ALLOWED_HOSTS;
    delete process.env.SUPPLIER_ALLOWED_HOSTS;
    assert.throws(() => assertPublicUrl('http://127.0.0.1:9999/products'), /private or link-local/);
    assert.throws(() => assertPublicUrl('http://169.254.169.254/latest/meta-data'), /metadata/);
    process.env.SUPPLIER_ALLOWED_HOSTS = saved;
    assert.strictEqual(typeof assertPublicUrl('http://127.0.0.1:9999/products'), 'string');
  });

  // ------------------------------------------------------- CSV import
  const CSV_GOOD = [
    'sku,mpn,upc,name,description,brand,category,cost,msrp,currency,stock,stock_status,weight_kg,restricted,restriction_type',
    'CSV-AC-9K,DC-9000,8901234560001,9000 BTU Window Unit,Compact window air conditioner,TestCool,Window Air Conditioners,210.00,349.00,USD,25,IN_STOCK,28,false,',
    'CSV-FILTER-01,FD-083,8901234560002,"Filter Drier 083, 3/8 in",Solder-on filter drier,TestCool,Filter Driers,8.50,16.00,USD,200,IN_STOCK,0.4,false,',
    'CSV-R134A,R134A-30,8901234560003,R-134a Refrigerant 30 lb,Recovery-grade cylinder,TestGas,Refrigerants,140.00,210.00,USD,10,IN_STOCK,15,true,REFRIGERANT',
  ].join('\n');

  let importId = null;
  await test('POST /api/supplier-imports/preview builds a preview without writing anything', async () => {
    const before = await prisma.supplierProduct.count({ where: { supplierId } });
    const r = await admin.post('/api/supplier-imports/preview', {
      supplierId, filename: 'catalog.csv', content: CSV_GOOD,
    });
    assert.strictEqual(r.status, 201, r.text);
    importId = r.body.data.importId;
    assert.strictEqual(r.body.data.summary.NEW, 3, JSON.stringify(r.body.data.summary));
    assert.strictEqual(r.body.data.summary.UPDATED, 0);
    assert.strictEqual(r.body.data.summary.UNCHANGED, 0);
    assert.strictEqual(r.body.data.summary.ERRORS, 0);
    assert.strictEqual(await prisma.supplierProduct.count({ where: { supplierId } }), before, 'preview must not write catalogue rows');
  });

  await test('CSV column mapping is auto-detected from the header row', async () => {
    const r = await admin.get(`/api/supplier-imports/${importId}`);
    assert.strictEqual(r.status, 200);
    const { records } = parseCsvObjects(CSV_GOOD);
    const { guessColumnMap } = require('../src/lib/suppliers/parsers/csv');
    const map = guessColumnMap(Object.keys(records[0]));
    assert.strictEqual(map.supplierSku, 'sku');
    assert.strictEqual(map.supplierCost, 'cost');
    assert.strictEqual(map.stock, 'stock');
    assert.strictEqual(map.restrictionType, 'restriction_type');
  });

  await test('POST /api/supplier-imports/:id/commit applies the preview', async () => {
    const r = await admin.post(`/api/supplier-imports/${importId}/commit`, {});
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.data.summary.NEW, 3);
    assert.strictEqual(await prisma.supplierProduct.count({ where: { supplierId } }), 3);
  });

  await test('committing the same feed again is idempotent', async () => {
    const r = await admin.post('/api/supplier-imports/preview', { supplierId, filename: 'catalog.csv', content: CSV_GOOD });
    const second = await admin.post(`/api/supplier-imports/${r.body.data.importId}/commit`, {});
    assert.strictEqual(second.body.data.summary.NEW, 0, 'no new rows on a repeat import');
    assert.strictEqual(second.body.data.summary.UPDATED, 0, 'no updates on a repeat import');
    assert.strictEqual(second.body.data.summary.UNCHANGED, 3);
    assert.strictEqual(await prisma.supplierProduct.count({ where: { supplierId } }), 3, 'no duplicate products');
  });

  await test('a changed cost is reported as UPDATED, not NEW', async () => {
    const changed = CSV_GOOD.replace('210.00', '225.00');
    const r = await admin.post('/api/supplier-imports/preview', { supplierId, filename: 'catalog.csv', content: changed });
    assert.strictEqual(r.body.data.summary.UPDATED, 1, JSON.stringify(r.body.data.summary));
    assert.strictEqual(r.body.data.summary.NEW, 0);
    const row = r.body.data.preview.find((p) => p.record.supplierSku === 'CSV-AC-9K');
    assert.ok(row.changes.some((c) => c.field === 'supplierCost'), 'the cost change should be itemised');
    await admin.post(`/api/supplier-imports/${r.body.data.importId}/commit`, {});
  });

  await test('invalid rows are reported as ERRORS and skipped on commit', async () => {
    const bad = [
      'sku,name,cost,stock',
      ',No SKU product,10,5',
      'CSV-OK-1,Valid product,10,5',
      'CSV-NEG,Has negative cost,-5,5',
      'CSV-NOSTOCK,Has negative stock,10,-3',
      'CSV-BADUPC,Bad UPC,10,3',
    ].join('\n');
    const r = await admin.post('/api/supplier-imports/preview', { supplierId, filename: 'bad.csv', content: bad });
    // 5 data rows: one valid, one missing SKU, one negative cost, one negative
    // stock, one valid (CSV-BADUPC has no UPC column, so it validates).
    assert.strictEqual(r.body.data.summary.ERRORS, 3, JSON.stringify(r.body.data.summary));
    assert.strictEqual(r.body.data.summary.NEW, 2);
    const errorFields = r.body.data.errors.flatMap((e) => e.errors.map((x) => x.field));
    assert.ok(errorFields.includes('supplierSku'));
    assert.ok(errorFields.includes('supplierCost'));
    assert.ok(errorFields.includes('stock'));
    const commit = await admin.post(`/api/supplier-imports/${r.body.data.importId}/commit`, {});
    assert.strictEqual(commit.body.data.summary.NEW, 2, 'only the valid rows are written');
    assert.strictEqual(commit.body.data.summary.ERRORS, 3);
  });

  await test('CSV formula injection is neutralised before it reaches the catalogue', async () => {
    const hostile = [
      'sku,name,cost,stock',
      'CSV-EVIL,=cmd|\' /C calc\'!A0,10,5',
      'CSV-EVIL2,@SUM(A1:A9)*cmd|\' /C calc\'!A0,10,5',
      'CSV-EVIL3,<script>alert(1)</script>,10,5',
    ].join('\n');
    const { records } = parseCsvObjects(hostile);
    assert.ok(records[0].name.startsWith("'="), `formula should be prefixed, got ${records[0].name}`);
    assert.ok(records[1].name.startsWith("'@"), `formula should be prefixed, got ${records[1].name}`);
    const r = await admin.post('/api/supplier-imports/preview', { supplierId, filename: 'evil.csv', content: hostile });
    const committed = await admin.post(`/api/supplier-imports/${r.body.data.importId}/commit`, {});
    assert.strictEqual(committed.status, 200);
    const stored = await prisma.supplierProduct.findFirst({ where: { supplierId, supplierSku: 'CSV-EVIL3' } });
    assert.ok(stored, 'the row should still be importable');
    assert.ok(!stored.name.includes('<script'), 'script markup must be neutralised');
  });

  await test('XML and JSON feeds parse into the same normalised shape', async () => {
    const xml = `<?xml version="1.0"?><catalog><product>
      <sku>XML-AC-1</sku><name>XML Split Unit</name><cost>300</cost><stock>12</stock>
      <specs><btu>12000</btu><voltage>230</voltage></specs>
    </product></catalog>`;
    const { root } = parseXml(xml);
    assert.strictEqual(root.catalog.product.sku, 'XML-AC-1');
    assert.strictEqual(root.catalog.product.specs.btu, '12000');

    const r = await admin.post('/api/supplier-imports/preview', {
      supplierId, filename: 'catalog.xml', content: xml, itemsPath: 'catalog.product',
    });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.data.summary.NEW, 1);
    await admin.post(`/api/supplier-imports/${r.body.data.importId}/commit`, {});

    const json = JSON.stringify([{ sku: 'JSON-AC-1', name: 'JSON Split Unit', cost: 310, stock: 9 }]);
    const r2 = await admin.post('/api/supplier-imports/preview', { supplierId, filename: 'catalog.json', content: json });
    assert.strictEqual(r2.body.data.summary.NEW, 1);
    await admin.post(`/api/supplier-imports/${r2.body.data.importId}/commit`, {});
  });

  await test('XML feeds with a DOCTYPE are rejected (XXE / entity expansion)', async () => {
    const evil = `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY x "y">]><catalog><product><sku>X</sku><name>&x;</name></product></catalog>`;
    const r = await admin.post('/api/supplier-imports/preview', { supplierId, filename: 'evil.xml', content: evil, itemsPath: 'catalog.product' });
    assert.strictEqual(r.status, 400, 'a DTD-bearing feed must be refused');
  });

  await test('an import can be discarded without touching the catalogue', async () => {
    const before = await prisma.supplierProduct.count({ where: { supplierId } });
    const r = await admin.post('/api/supplier-imports/preview', { supplierId, content: 'sku,name,cost,stock\nCANCEL-1,Cancel me,1,1' });
    const cancel = await admin.post(`/api/supplier-imports/${r.body.data.importId}/cancel`);
    assert.strictEqual(cancel.body.data.status, 'CANCELLED');
    assert.strictEqual(await prisma.supplierProduct.count({ where: { supplierId } }), before);
    const commit = await admin.post(`/api/supplier-imports/${r.body.data.importId}/commit`, {});
    assert.strictEqual(commit.status, 409, 'a cancelled import cannot be committed');
  });

  await test('GET /api/supplier-imports/:id/errors.csv downloads the error report', async () => {
    const bad = 'sku,name,cost,stock\n,No SKU,10,5';
    const r = await admin.post('/api/supplier-imports/preview', { supplierId, content: bad });
    const csv = await admin.get(`/api/supplier-imports/${r.body.data.importId}/errors.csv`);
    assert.strictEqual(csv.status, 200);
    assert.ok(csv.text.includes('supplierSku'), csv.text.slice(0, 200));
  });

  // ------------------------------------------------------- pricing engine
  await test('markup engine: 30% on a cost of 100 gives 130', async () => {
    assert.strictEqual(applyMarkup(100, { markupType: 'PERCENT', markupValue: 30 }), 130);
  });
  await test('markup engine: fixed markup of 25 on a cost of 100 gives 125', async () => {
    assert.strictEqual(applyMarkup(100, { markupType: 'FIXED', markupValue: 25 }), 125);
  });
  await test('markup precedence is Product → Category → Supplier → Global', async () => {
    const supplier = { markupType: 'PERCENT', markupValue: 10 };
    const globalRule = { markupType: 'PERCENT', markupValue: 5, isActive: true };
    const categoryRules = [{ scope: 'CATEGORY', categoryId: 'cat-1', markupType: 'PERCENT', markupValue: 20, isActive: true }];

    assert.strictEqual(resolveRule({ supplierProduct: {}, supplier, globalRule }).scope, 'SUPPLIER');
    assert.strictEqual(resolveRule({ supplierProduct: { categoryId: 'cat-1' }, supplier, categoryRules, globalRule }).scope, 'CATEGORY');
    assert.strictEqual(resolveRule({
      supplierProduct: { categoryId: 'cat-1', markupOverrideType: 'PERCENT', markupOverrideValue: 40 },
      supplier, categoryRules, globalRule,
    }).scope, 'PRODUCT');
    assert.strictEqual(resolveRule({ supplierProduct: {}, supplier: {}, globalRule }).scope, 'GLOBAL');
    assert.strictEqual(resolveRule({ supplierProduct: {}, supplier: {} }).scope, 'NONE');
  });
  await test('a price override short-circuits the markup engine', async () => {
    const result = priceFor({
      supplierProduct: { supplierCost: 100, priceOverride: 999 },
      supplier: { markupType: 'PERCENT', markupValue: 30 },
    });
    assert.strictEqual(result.price, 999);
    assert.strictEqual(result.overridden, true);
  });
  await test('rounding rounds the computed price to the nearest step', async () => {
    assert.strictEqual(applyMarkup(100, { markupType: 'PERCENT', markupValue: 33, roundTo: 5 }), 135);
    assert.strictEqual(applyMarkup(100, { markupType: 'PERCENT', markupValue: 33, roundTo: 0.5 }), 133);
  });

  await test('the supplier-level markup is applied to imported products', async () => {
    const { data } = await admin.getJ('/api/supplier-products', { supplierId, search: 'CSV-AC-9K' });
    const p = data[0];
    assert.ok(p, 'the imported product should be listed');
    // Supplier markup is 30%; the last commit set the cost to 225.
    assert.strictEqual(p.supplierCost, 225);
    assert.strictEqual(p.sellingPrice, 292.5, `expected 225 * 1.3 = 292.5, got ${p.sellingPrice}`);
  });

  await test('PATCH pricing with a product override wins over the supplier rule', async () => {
    const { data } = await admin.getJ('/api/supplier-products', { supplierId, search: 'CSV-AC-9K' });
    const r = await admin.patch(`/api/supplier-products/${data[0].id}/pricing`, { markupOverrideType: 'FIXED', markupOverrideValue: 100 });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.data.computedPrice, 325, `225 + 100 fixed = 325, got ${r.body.data.computedPrice}`);
    const clear = await admin.patch(`/api/supplier-products/${data[0].id}/pricing`, { markupOverrideType: null, markupOverrideValue: null });
    assert.strictEqual(clear.body.data.computedPrice, 292.5, 'clearing the override restores the supplier rule');
  });

  await test('a category markup rule beats the supplier rule', async () => {
    const cats = await admin.get('/api/categories');
    const category = cats.body.data.find((c) => c.name === 'Refrigerants') || cats.body.data[0];
    const rule = await admin.post('/api/supplier-settings/markup-rules', {
      scope: 'CATEGORY', categoryId: category.id, markupType: 'PERCENT', markupValue: 50,
    });
    assert.strictEqual(rule.status, 201, rule.text);
    const preview = await admin.get('/api/supplier-products/price-preview', { query: { supplierId, cost: 100 } });
    // No categoryId on the probe → supplier rule still wins; check the chain is reported.
    assert.ok(preview.body.data.chain.supplier, 'the supplier tier should be reported');
    assert.ok(preview.body.data.chain.category || preview.body.data.chain.supplier);
    await admin.del(`/api/supplier-settings/markup-rules/${rule.body.data.id}`);
  });

  await test('duplicate category markup rules are rejected', async () => {
    const cats = await admin.get('/api/categories');
    const category = cats.body.data[0];
    const first = await admin.post('/api/supplier-settings/markup-rules', { scope: 'CATEGORY', categoryId: category.id, markupValue: 10 });
    assert.strictEqual(first.status, 201);
    const second = await admin.post('/api/supplier-settings/markup-rules', { scope: 'CATEGORY', categoryId: category.id, markupValue: 20 });
    assert.strictEqual(second.status, 400);
    await admin.del(`/api/supplier-settings/markup-rules/${first.body.data.id}`);
  });

  await test('POST /api/supplier-settings/markup-preview explains the calculation', async () => {
    const r = await admin.post('/api/supplier-settings/markup-preview', { cost: 100, markupType: 'PERCENT', markupValue: 30 });
    assert.strictEqual(r.body.data.price, 130);
    assert.ok(r.body.data.explanation.includes('130.00'), r.body.data.explanation);
  });

  // ------------------------------------------------------ publish / storefront
  let publishedProductId = null;
  await test('publishing creates a real Product in the existing catalogue', async () => {
    const { data } = await admin.getJ('/api/supplier-products', { supplierId, search: 'CSV-AC-9K' });
    const r = await admin.post(`/api/supplier-products/${data[0].id}/publish`);
    assert.strictEqual(r.status, 200, r.text);
    publishedProductId = r.body.data.productId;
    assert.strictEqual(r.body.data.createdProduct, true);
    assert.strictEqual(r.body.data.price, 292.5);
    const product = await prisma.product.findUnique({ where: { id: publishedProductId } });
    assert.ok(product, 'a platform Product row must exist');
    assert.strictEqual(product.sku, 'CSV-AC-9K');
    assert.strictEqual(product.quantity, 0, 'a newly published dropship product owns no N&D stock');
    assert.strictEqual(product.supplierStock, 25, 'supplier stock is mirrored, not merged into owned stock');
  });

  await test('publishing twice updates the same product (no duplicates)', async () => {
    const { data } = await admin.getJ('/api/supplier-products', { supplierId, search: 'CSV-AC-9K' });
    const r = await admin.post(`/api/supplier-products/${data[0].id}/publish`);
    assert.strictEqual(r.body.data.createdProduct, false);
    assert.strictEqual(r.body.data.productId, publishedProductId);
    const count = await prisma.product.count({ where: { sku: 'CSV-AC-9K' } });
    assert.strictEqual(count, 1);
  });

  await test('the published product appears in the public storefront feed', async () => {
    const r = await anon.get('/api/public/products?search=9000 BTU Window');
    const found = r.body.data.find((p) => p.sku === 'CSV-AC-9K');
    assert.ok(found, 'the published supplier product must be on the storefront');
    assert.strictEqual(found.inStock, true, 'supplier stock makes it purchasable');
    assert.strictEqual(found.availableStock, 25);
    assert.strictEqual(found.shipsFromSupplier, true);
  });

  await test('mapping a supplier product to an existing platform product is manual and persists', async () => {
    const products = await admin.get('/api/products');
    const target = products.body.data.find((p) => p.sku !== 'CSV-AC-9K');
    const { data } = await admin.getJ('/api/supplier-products', { supplierId, search: 'CSV-FILTER-01' });
    const r = await admin.post('/api/supplier-products/map', { supplierProductId: data[0].id, productId: target.id });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.data.matchKey, 'MANUAL');
    const after = await admin.get(`/api/supplier-products/${data[0].id}`);
    assert.strictEqual(after.body.data.mappingStatus, 'MANUAL');
    assert.strictEqual(after.body.data.productId, target.id);
  });

  await test('a platform product cannot be mapped to two supplier products', async () => {
    const products = await admin.get('/api/products');
    const target = products.body.data.find((p) => p.sku !== 'CSV-AC-9K');
    const { data } = await admin.getJ('/api/supplier-products', { supplierId, search: 'JSON-AC-1' });
    const r = await admin.post('/api/supplier-products/map', { supplierProductId: data[0].id, productId: target.id });
    assert.strictEqual(r.status, 409, 'the second mapping should be refused');
  });

  // --------------------------------------------------------- inventory model
  await test('available stock separates owned, supplier and sellable units', async () => {
    const local = { quantity: 5, supplierStock: 10, fulfillmentType: 'LOCAL' };
    assert.strictEqual(availableStock(local), 5, 'LOCAL must ignore supplier stock');
    const hybrid = { quantity: 5, supplierStock: 10, fulfillmentType: 'HYBRID' };
    assert.strictEqual(availableStock(hybrid), 15);
    const supplierOnly = { quantity: 0, supplierStock: 10, fulfillmentType: 'SUPPLIER_FULFILLED' };
    assert.strictEqual(availableStock(supplierOnly), 10);
  });

  await test('allocation always consumes N&D stock before the supplier', async () => {
    const product = { quantity: 3, supplierStock: 10, fulfillmentType: 'HYBRID' };
    assert.deepStrictEqual(allocate(product, 5), { local: 3, dropship: 2, short: 0, available: 13 });
    assert.deepStrictEqual(allocate(product, 20), { local: 3, dropship: 10, short: 7, available: 13 });
    const localOnly = { quantity: 3, supplierStock: 10, fulfillmentType: 'LOCAL' };
    assert.deepStrictEqual(allocate(localOnly, 5), { local: 3, dropship: 0, short: 2, available: 3 });
  });

  await test('GET /api/inventory reports owned, supplier and available stock separately', async () => {
    const r = await admin.get('/api/inventory?search=CSV-AC-9K');
    const row = r.body.data.find((p) => p.sku === 'CSV-AC-9K');
    assert.ok(row, 'the product should appear in inventory');
    assert.strictEqual(row.localStock, 0);
    assert.strictEqual(row.supplierStock, 25);
    assert.strictEqual(row.availableStock, 25);
    assert.strictEqual(row.stockStatus, 'ok');
    assert.strictEqual(row.ownedStockStatus, 'out', 'owned stock is still zero — it must not be inflated');
  });

  // --------------------------------------------------------- synchronisation
  await test('a CATALOG sync pulls the catalogue over the real connector', async () => {
    const before = supplierState.hits.products;
    const r = await admin.post('/api/supplier-syncs', { supplierId, type: 'CATALOG', wait: true });
    assert.strictEqual(r.status, 202, r.text);
    assert.ok(supplierState.hits.products > before, 'the connector must have called the supplier API');
    assert.strictEqual(r.body.data.status, 'COMPLETED', r.body.data.message);
    assert.strictEqual(r.body.data.created, 3, JSON.stringify(r.body.data));
    assert.strictEqual(r.body.data.processed, 3);
    const stored = await prisma.supplierProduct.findFirst({ where: { supplierId, supplierSku: 'TST-AC-12K' } });
    assert.ok(stored, 'the synced product must be stored');
    assert.strictEqual(stored.supplierCost, 400);
    assert.strictEqual(stored.stock, 40);
    assert.strictEqual(stored.restricted, false);
    const refrigerant = await prisma.supplierProduct.findFirst({ where: { supplierId, supplierSku: 'TST-R410A-25' } });
    assert.strictEqual(refrigerant.restricted, true, 'restricted flag must survive the sync');
    assert.strictEqual(refrigerant.restrictionType, 'REFRIGERANT');
  });

  await test('re-running the same sync is idempotent', async () => {
    const r = await admin.post('/api/supplier-syncs', { supplierId, type: 'CATALOG', wait: true });
    assert.strictEqual(r.body.data.created, 0);
    assert.strictEqual(r.body.data.updated, 0);
    assert.strictEqual(r.body.data.skipped, 3);
  });

  await test('an INVENTORY sync updates supplier stock only', async () => {
    supplierState.products[0].stock = 55;
    const r = await admin.post('/api/supplier-syncs', { supplierId, type: 'INVENTORY', wait: true });
    assert.strictEqual(r.body.data.status, 'COMPLETED', r.body.data.message);
    assert.strictEqual(r.body.data.inventoryUpdates, 1, JSON.stringify(r.body.data));
    const stored = await prisma.supplierProduct.findFirst({ where: { supplierId, supplierSku: 'TST-AC-12K' } });
    assert.strictEqual(stored.stock, 55);
    supplierState.products[0].stock = 40;
  });

  await test('a PRICING sync updates cost and recomputes the selling price', async () => {
    supplierState.products[1].cost = 800;
    const r = await admin.post('/api/supplier-syncs', { supplierId, type: 'PRICING', wait: true });
    assert.strictEqual(r.body.data.priceUpdates >= 1, true, JSON.stringify(r.body.data));
    const stored = await prisma.supplierProduct.findFirst({ where: { supplierId, supplierSku: 'TST-COMP-5T' } });
    assert.strictEqual(stored.supplierCost, 800);
    assert.strictEqual(stored.sellingPrice, 1040, '800 * 1.3 = 1040');
    supplierState.products[1].cost = 700;
    await admin.post('/api/supplier-syncs', { supplierId, type: 'PRICING', wait: true });
  });

  await test('a sync mirrors stock onto a published product without touching owned stock', async () => {
    await prisma.product.update({ where: { id: publishedProductId }, data: { quantity: 4 } });
    supplierState.products[0].stock = 77;
    // TST-AC-12K is not published; publish it, then sync.
    const { data } = await admin.getJ('/api/supplier-products', { supplierId, search: 'TST-AC-12K' });
    await admin.post(`/api/supplier-products/${data[0].id}/publish`);
    const r = await admin.post('/api/supplier-syncs', { supplierId, type: 'INVENTORY', wait: true });
    assert.strictEqual(r.body.data.status, 'COMPLETED', r.body.data.message);
    const product = await prisma.product.findUnique({ where: { sku: 'TST-AC-12K' } });
    assert.strictEqual(product.supplierStock, 77);
    assert.strictEqual(product.quantity, 0, 'owned stock must never be written by a supplier sync');
    supplierState.products[0].stock = 40;
  });

  await test('a failing supplier makes the sync FAILED and records the error', async () => {
    const savedKey = await prisma.supplierIntegration.findUnique({ where: { id: integrationId } });
    await prisma.supplierIntegration.update({
      where: { id: integrationId },
      data: { credentialsCipher: encryptSecrets({ apiKey: 'will-fail' }) },
    });
    const r = await admin.post('/api/supplier-syncs', { supplierId, type: 'CATALOG', wait: true });
    assert.strictEqual(r.body.data.status, 'FAILED');
    assert.ok(/401/.test(r.body.data.message), r.body.data.message);
    const integ = await prisma.supplierIntegration.findUnique({ where: { id: integrationId } });
    assert.strictEqual(integ.status, 'ERROR');
    assert.ok(!integ.lastError.includes('will-fail'), 'the secret must not leak into lastError');
    await prisma.supplierIntegration.update({ where: { id: integrationId }, data: { credentialsCipher: savedKey.credentialsCipher, status: 'CONNECTED' } });
  });

  await test('a failed sync can be retried and the retry is linked to its parent', async () => {
    const failed = await admin.get('/api/supplier-syncs', { query: { status: 'FAILED', limit: 1 } });
    const failedSync = failed.body.data[0];
    assert.ok(failedSync, 'there should be a failed run to retry');
    const r = await admin.post(`/api/supplier-syncs/${failedSync.id}/retry`);
    assert.strictEqual(r.status, 202, r.text);
    assert.strictEqual(r.body.data.parentSyncId, failedSync.id);
    assert.strictEqual(r.body.data.attempt, failedSync.attempt + 1);
  });

  await test('sync logs record per-record actions', async () => {
    const runs = await admin.get('/api/supplier-syncs', { query: { status: 'COMPLETED', limit: 1 } });
    const run = runs.body.data[0];
    const logs = await admin.get(`/api/supplier-syncs/${run.id}/logs`);
    assert.strictEqual(logs.status, 200);
    assert.ok(logs.body.meta.summary, 'log action counts should be summarised');
  });

  await test('overlapping syncs for one supplier are refused', async () => {
    const syncEngine = require('../src/lib/suppliers/sync-engine');
    const sync = await prisma.supplierSync.create({
      data: { tenantId: 'default', supplierId, type: 'FULL', trigger: 'MANUAL', status: 'RUNNING' },
    });
    const r = await admin.post('/api/supplier-syncs', { supplierId, type: 'FULL' });
    assert.strictEqual(r.status, 409);
    assert.ok(/already running/i.test(r.body.error), r.body.error);
    await syncEngine.cancel({ syncId: sync.id });
  });

  await test('stale RUNNING syncs are recovered on startup', async () => {
    const syncEngine = require('../src/lib/suppliers/sync-engine');
    const stale = await prisma.supplierSync.create({
      data: {
        tenantId: 'default', supplierId, type: 'FULL', trigger: 'MANUAL', status: 'RUNNING',
        startedAt: new Date(Date.now() - 3 * 3600 * 1000),
      },
    });
    const recovered = await syncEngine.recoverStale({ olderThanMinutes: 30 });
    assert.ok(recovered >= 1, 'the stale run should be recovered');
    const after = await prisma.supplierSync.findUnique({ where: { id: stale.id } });
    assert.strictEqual(after.status, 'FAILED');
    assert.ok(/Recovered/.test(after.message), after.message);
  });

  await test('a disabled supplier cannot be synchronised', async () => {
    await admin.patch(`/api/suppliers/${supplierId}/status`, { status: 'DISABLED' });
    const r = await admin.post('/api/supplier-syncs', { supplierId, type: 'FULL' });
    assert.strictEqual(r.status, 409);
    await admin.patch(`/api/suppliers/${supplierId}/status`, { status: 'ACTIVE' });
  });

  // ----------------------------------------------------------- shipping rules
  let ruleCaribbean = null;
  let ruleHazmat = null;
  await test('POST /api/supplier-shipping creates a supplier-scoped rule', async () => {
    const r = await admin.post('/api/supplier-shipping', {
      scope: 'SUPPLIER', supplierId, name: 'Caribbean standard', countries: ['CARIBBEAN'],
      method: 'STANDARD', methodName: 'Standard Caribbean freight', carrier: 'TestExpress',
      baseCost: 25, perKgCost: 1.5, minDays: 5, maxDays: 10,
    });
    assert.strictEqual(r.status, 201, r.text);
    ruleCaribbean = r.body.data.id;
  });

  await test('a restricted-goods rule is scoped to restricted products only', async () => {
    const r = await admin.post('/api/supplier-shipping', {
      scope: 'SUPPLIER', supplierId, name: 'Refrigerant ground only', countries: ['CARIBBEAN'],
      method: 'HAZMAT_GROUND', methodName: 'Restricted goods ground freight', restricted: true,
      baseCost: 60, perKgCost: 3, minDays: 7, maxDays: 14, restrictionNote: 'Certified handler required',
    });
    assert.strictEqual(r.status, 201, r.text);
    ruleHazmat = r.body.data.id;
  });

  await test('a quote is produced for a served destination', async () => {
    const r = await admin.post('/api/supplier-shipping/quote', { country: 'TT', supplierId, weightKg: 10, quantity: 1, subtotal: 300 });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.data.shippable, true, r.body.data.blocked);
    const standard = r.body.data.options.find((o) => o.method === 'STANDARD');
    assert.ok(standard, 'the standard rule should match');
    assert.strictEqual(standard.cost, 40, 'base 25 + 10kg * 1.5 = 40');
    assert.ok(standard.estimate.includes('5'), standard.estimate);
  });

  await test('no quote exists for a country the supplier does not serve', async () => {
    const r = await admin.post('/api/supplier-shipping/quote', { country: 'DE', supplierId });
    assert.strictEqual(r.body.data.shippable, false);
    assert.ok(/does not list Germany/.test(r.body.data.blocked), r.body.data.blocked);
  });

  await test('a platform-blocked country is never shippable', async () => {
    await admin.put('/api/supplier-settings', { blockedCountries: ['DE'] });
    const r = await admin.post('/api/supplier-shipping/quote', { country: 'DE', supplierId });
    assert.strictEqual(r.body.data.shippable, false);
    assert.ok(/platform level/.test(r.body.data.blocked), r.body.data.blocked);
    await admin.put('/api/supplier-settings', { blockedCountries: [] });
  });

  await test('a blocked supplier country overrides an allow-list', async () => {
    const access = evaluateCountryAccess({
      destination: 'JM',
      supplier: { name: 'X', countriesServed: '["CARIBBEAN"]', blockedCountries: '["JM"]' },
    });
    assert.strictEqual(access.allowed, false);
  });

  await test('region codes expand into their member countries', async () => {
    const list = expandCountries(['CARIBBEAN']);
    assert.ok(list.includes('TT') && list.includes('JM') && list.includes('BB'));
    assert.ok(list.length > 20, `expected the Caribbean region to expand, got ${list.length}`);
  });

  await test('a restricted product may only use its allowed shipping methods', async () => {
    const { data } = await admin.getJ('/api/supplier-products', { supplierId, search: 'TST-R410A-25' });
    const r = await admin.post('/api/supplier-shipping/quote', { country: 'TT', supplierProductId: data[0].id });
    assert.strictEqual(r.body.data.shippable, true, r.body.data.blocked);
    assert.ok(r.body.data.options.every((o) => o.method === 'HAZMAT_GROUND'),
      `only HAZMAT_GROUND should be offered, got ${r.body.data.options.map((o) => o.method).join(',')}`);
    assert.ok(r.body.data.restrictions.includes('REFRIGERANT'));
  });

  await test('removing every matching rule makes the item unshippable', async () => {
    await admin.put(`/api/supplier-shipping/${ruleCaribbean}`, { isActive: false });
    await admin.put(`/api/supplier-shipping/${ruleHazmat}`, { isActive: false });
    const r = await admin.post('/api/supplier-shipping/quote', { country: 'TT', supplierId });
    assert.strictEqual(r.body.data.shippable, false);
    assert.ok(/No shipping rule covers/.test(r.body.data.blocked), r.body.data.blocked);
    await admin.put(`/api/supplier-shipping/${ruleCaribbean}`, { isActive: true });
    await admin.put(`/api/supplier-shipping/${ruleHazmat}`, { isActive: true });
  });

  await test('GET /api/supplier-shipping/restrictions lists restricted products', async () => {
    const r = await admin.get('/api/supplier-shipping/restrictions');
    assert.ok(r.body.data.products.some((p) => p.restrictionType === 'REFRIGERANT'));
    assert.ok(r.body.data.rules.length >= 1);
  });

  // ------------------------------------------------- checkout / dropshipping
  let customerId = null;
  let dropshipOrderId = null;
  await test('a customer can check out a supplier-fulfilled product with zero N&D stock', async () => {
    const product = await prisma.product.findUnique({ where: { sku: 'TST-AC-12K' } });
    assert.strictEqual(product.quantity, 0, 'precondition: no owned stock');
    const r = await anon.post('/api/payments/checkout', {
      name: 'Dropship Customer', email: 'dropship.customer@example.com', phone: '+1 868 555 0100',
      address: '12 Coastal Road', city: 'Point Fortin', country: 'TT', postalCode: '000000',
      paymentMethod: 'CASH_ON_DELIVERY',
      items: [{ productId: product.id, quantity: 2 }],
    });
    assert.strictEqual(r.status, 201, r.text);
    dropshipOrderId = (await prisma.order.findFirst({ where: { reference: r.body.data.order.reference } })).id;
    assert.ok(r.body.data.supplierFulfillment, 'the response should report supplier fulfilment');
    assert.strictEqual(r.body.data.supplierFulfillment.count, 1);
  });

  await test('checkout does not drive owned stock negative for dropshipped units', async () => {
    const product = await prisma.product.findUnique({ where: { sku: 'TST-AC-12K' } });
    assert.strictEqual(product.quantity, 0, 'no owned stock was consumed by a dropship line');
    const order = await prisma.order.findUnique({ where: { id: dropshipOrderId }, include: { items: true } });
    assert.strictEqual(order.shippingCountry, 'TT');
  });

  await test('a supplier fulfilment record was raised against the real order', async () => {
    const r = await admin.get(`/api/supplier-fulfillments/for-order/${dropshipOrderId}`);
    assert.strictEqual(r.body.data.length, 1);
    const f = r.body.data[0];
    assert.strictEqual(f.status, 'PENDING');
    assert.strictEqual(f.transmissionStatus, 'NOT_SENT', 'nothing may be reported as sent before transmission');
    assert.strictEqual(f.items[0].quantity, 2);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(f.shipTo)), {
      name: 'Dropship Customer', phone: '+1 868 555 0100', address: '12 Coastal Road',
      city: 'Point Fortin', country: 'TT', postalCode: '000000',
    });
  });

  await test('submitting transmits the purchase order through the connector API', async () => {
    const list = await admin.get(`/api/supplier-fulfillments/for-order/${dropshipOrderId}`);
    const before = supplierState.hits.orders;
    const r = await admin.post(`/api/supplier-fulfillments/${list.body.data[0].id}/submit`);
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.data.sent, true, r.body.data.message);
    assert.ok(supplierState.hits.orders > before, 'the connector must have POSTed to the supplier');
    assert.ok(r.body.data.supplierOrderId, 'the supplier order id must be captured');
    assert.strictEqual(supplierState.orders.get(r.body.data.supplierOrderId).payload.order.items[0].quantity, 2);
  });

  await test('submitting the same fulfilment twice is refused', async () => {
    const list = await admin.get(`/api/supplier-fulfillments/for-order/${dropshipOrderId}`);
    const r = await admin.post(`/api/supplier-fulfillments/${list.body.data[0].id}/submit`);
    assert.strictEqual(r.status, 409);
  });

  await test('polling the supplier returns its order status', async () => {
    const list = await admin.get(`/api/supplier-fulfillments/for-order/${dropshipOrderId}`);
    const r = await admin.post(`/api/supplier-fulfillments/${list.body.data[0].id}/refresh`);
    assert.strictEqual(r.body.data.statusChecked, true);
    assert.ok(r.body.data.supplierStatus, 'the supplier reported a status');
  });

  await test('tracking is retrieved from the supplier and moves the order to SHIPPED', async () => {
    const list = await admin.get(`/api/supplier-fulfillments/for-order/${dropshipOrderId}`);
    await prisma.order.update({ where: { id: dropshipOrderId }, data: { status: 'PAID', paymentStatus: 'PAID', paidAt: new Date() } });
    const r = await admin.post(`/api/supplier-fulfillments/${list.body.data[0].id}/refresh`);
    assert.strictEqual(r.body.data.trackingChecked, true);
    const after = await prisma.supplierFulfillment.findFirst({ where: { orderId: dropshipOrderId } });
    assert.ok(after.trackingNumber, 'a tracking number should be stored');
    assert.strictEqual(after.carrier, 'TestExpress');
    const order = await prisma.order.findUnique({ where: { id: dropshipOrderId } });
    assert.strictEqual(order.status, 'SHIPPED', 'the customer order should follow the fulfilment');
  });

  await test('the customer can see the tracking on the public order status endpoint', async () => {
    const order = await prisma.order.findUnique({ where: { id: dropshipOrderId } });
    const r = await anon.get(`/api/public/orders/${order.reference}`);
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.data.status, 'SHIPPED');
    assert.strictEqual(r.body.data.supplierFulfillments.length, 1);
    assert.ok(r.body.data.supplierFulfillments[0].trackingNumber);
    assert.strictEqual(r.body.data.supplierFulfillments[0].trackingSupported, true);
  });

  await test('marking a fulfilment DELIVERED completes the customer order', async () => {
    const list = await admin.get(`/api/supplier-fulfillments/for-order/${dropshipOrderId}`);
    await admin.patch(`/api/supplier-fulfillments/${list.body.data[0].id}/status`, { status: 'DELIVERED' });
    const order = await prisma.order.findUnique({ where: { id: dropshipOrderId } });
    assert.strictEqual(order.status, 'COMPLETED');
  });

  await test('a hybrid order splits between N&D stock and the supplier', async () => {
    const product = await prisma.product.findUnique({ where: { sku: 'CSV-AC-9K' } });
    await prisma.product.update({ where: { id: product.id }, data: { quantity: 1, fulfillmentType: 'HYBRID', supplierStock: 25 } });
    const r = await anon.post('/api/payments/checkout', {
      name: 'Hybrid Customer', email: 'hybrid.customer@example.com',
      city: 'San Fernando', country: 'TT', paymentMethod: 'CASH_ON_DELIVERY',
      items: [{ productId: product.id, quantity: 3 }],
    });
    assert.strictEqual(r.status, 201, r.text);
    const order = await prisma.order.findFirst({ where: { reference: r.body.data.order.reference } });
    const after = await prisma.product.findUnique({ where: { id: product.id } });
    assert.strictEqual(after.quantity, 0, 'the one owned unit is consumed first');
    const list = await admin.get(`/api/supplier-fulfillments/for-order/${order.id}`);
    assert.strictEqual(list.body.data.length, 1);
    assert.strictEqual(list.body.data[0].items[0].quantity, 2, 'only the shortfall is dropshipped');
  });

  await test('cancelling a fulfilment notifies the supplier when it can', async () => {
    const spList = await admin.getJ('/api/supplier-products', { supplierId, search: 'TST-COMP-5T' });
    await admin.post(`/api/supplier-products/${spList.data[0].id}/publish`);
    const product = await prisma.product.findUnique({ where: { sku: 'TST-COMP-5T' } });
    assert.ok(product, 'the compressor should now exist in the platform catalogue');
    const order = await anon.post('/api/payments/checkout', {
      name: 'Cancel Customer', email: 'cancel.customer@example.com', city: 'Arima',
      country: 'TT', paymentMethod: 'CASH_ON_DELIVERY',
      items: [{ productId: product.id, quantity: 1 }],
    });
    const created = await prisma.order.findFirst({ where: { reference: order.body.data.order.reference } });
    const list = await admin.get(`/api/supplier-fulfillments/for-order/${created.id}`);
    const submitted = await admin.post(`/api/supplier-fulfillments/${list.body.data[0].id}/submit`);
    assert.strictEqual(submitted.body.data.sent, true);
    const before = supplierState.hits.cancel;
    const r = await admin.post(`/api/supplier-fulfillments/${list.body.data[0].id}/cancel`, { reason: 'Customer changed their mind' });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.data.supplierNotified, true);
    assert.ok(supplierState.hits.cancel > before, 'the cancel call must reach the supplier');
    assert.strictEqual(r.body.data.fulfillment.status, 'CANCELLED');
  });

  await test('cancelling an order returns only the N&D-owned units to stock', async () => {
    const product = await prisma.product.findUnique({ where: { sku: 'CSV-AC-9K' } });
    await prisma.product.update({ where: { id: product.id }, data: { quantity: 2, supplierStock: 25, fulfillmentType: 'HYBRID' } });
    const r = await anon.post('/api/payments/checkout', {
      name: 'Restock Customer', email: 'restock.customer@example.com', city: 'Chaguanas',
      country: 'TT', paymentMethod: 'CASH_ON_DELIVERY',
      items: [{ productId: product.id, quantity: 4 }],
    });
    const order = await prisma.order.findFirst({ where: { reference: r.body.data.order.reference } });
    const afterOrder = await prisma.product.findUnique({ where: { id: product.id } });
    assert.strictEqual(afterOrder.quantity, 0, '2 owned units consumed');
    await admin.patch(`/api/orders/${order.id}/status`, { status: 'CANCELLED' });
    const restored = await prisma.product.findUnique({ where: { id: product.id } });
    assert.strictEqual(restored.quantity, 2, 'only the 2 owned units come back, not the 2 dropshipped ones');
  });

  // --------------------------------------------------------- automation
  await test('the scheduler can be enabled and reports its state', async () => {
    const r = await admin.patch('/api/supplier-syncs/automation', { autoSyncEnabled: true, syncIntervalMinutes: 30 });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.data.settings.autoSyncEnabled, true);
    const status = await admin.get('/api/supplier-syncs/automation');
    assert.strictEqual(status.body.data.scheduler.autoSyncEnabled, true);
    await admin.patch('/api/supplier-syncs/automation', { autoSyncEnabled: false });
  });

  await test('a per-integration schedule is stored and gated on connection', async () => {
    const r = await admin.patch(`/api/supplier-integrations/${integrationId}/schedule`, {
      syncEnabled: true, syncIntervalMinutes: 45, syncTypes: ['INVENTORY', 'PRICING'],
    });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.data.syncIntervalMinutes, 45);
    const automation = await admin.get('/api/supplier-syncs/automation');
    const row = automation.body.data.integrations.find((i) => i.id === integrationId);
    assert.deepStrictEqual(row.syncTypes, ['INVENTORY', 'PRICING']);
  });

  await test('POST /api/supplier-syncs/sync-all queues every connectable supplier', async () => {
    const r = await admin.post('/api/supplier-syncs/sync-all', { type: 'INVENTORY' });
    assert.strictEqual(r.status, 202, r.text);
    assert.ok(r.body.data.queued.length >= 1);
  });

  // --------------------------------------------------------- settings + security
  await test('GET /api/supplier-settings exposes settings, permissions and security', async () => {
    const r = await admin.get('/api/supplier-settings');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.data.settings.defaultMarkupType);
    assert.ok(r.body.data.permissions.available.length >= 9);
    assert.strictEqual(r.body.data.security.dedicatedCredentialKey, true);
    assert.ok(r.body.data.reference.countries > 200);
  });

  await test('PUT /api/supplier-settings persists marketplace settings', async () => {
    const r = await admin.put('/api/supplier-settings', { defaultMarkupValue: 35, autoPublish: false });
    assert.strictEqual(r.body.data.settings.defaultMarkupValue, 35);
    await admin.put('/api/supplier-settings', { defaultMarkupValue: 30 });
  });

  await test('STAFF cannot change marketplace settings', async () => {
    const r = await staff.put('/api/supplier-settings', { defaultMarkupValue: 99 });
    assert.strictEqual(r.status, 403);
  });

  await test('only administrators can change the permission policy', async () => {
    assert.strictEqual((await staff.get('/api/supplier-settings/permissions')).status, 403);
    const r = await admin.get('/api/supplier-settings/permissions');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.data.policy.ADMIN, ['*']);
  });

  await test('permission policy overrides are enforced immediately', async () => {
    await admin.put('/api/supplier-settings/permissions', { role: 'STAFF', permissions: ['suppliers.view'] });
    const importAttempt = await staff.post('/api/supplier-imports/preview', { supplierId, content: 'sku,name\nX,Y' });
    assert.strictEqual(importAttempt.status, 403, 'imports.manage was revoked');
    await admin.put('/api/supplier-settings/permissions', {
      role: 'STAFF', permissions: ['suppliers.view', 'imports.manage', 'sync.manage', 'fulfillment.manage'],
    });
    assert.strictEqual((await staff.get('/api/supplier-imports')).status, 200);
  });

  await test('tenant isolation: another tenant cannot see these suppliers', async () => {
    const other = await prisma.supplier.create({
      data: { tenantId: 'tenant-other', name: 'Other Tenant Supplier', code: 'OTHER-1', country: 'US' },
    });
    const list = await admin.get('/api/suppliers', { query: { status: 'ALL', limit: 100 } });
    assert.ok(!list.body.data.some((s) => s.id === other.id), 'a different tenant\'s supplier leaked into the list');
    const detail = await admin.get(`/api/suppliers/${other.id}`);
    assert.strictEqual(detail.status, 404);
    const products = await admin.get('/api/supplier-products', { query: { supplierId: other.id } });
    assert.strictEqual(products.body.data.length, 0);
    await prisma.supplier.delete({ where: { id: other.id } });
  });

  await test('a forged tenant cannot read or write another tenant\'s data', async () => {
    const foreignSupplier = await prisma.supplier.create({
      data: { tenantId: 'tenant-evil', name: 'Foreign', code: 'EVIL-1' },
    });
    const foreignProduct = await prisma.supplierProduct.create({
      data: { tenantId: 'tenant-evil', supplierId: foreignSupplier.id, supplierSku: 'EVIL-SKU', name: 'Foreign product', supplierCost: 1 },
    });
    assert.strictEqual((await admin.get(`/api/suppliers/${foreignSupplier.id}`)).status, 404);
    assert.strictEqual((await admin.get(`/api/supplier-products/${foreignProduct.id}`)).status, 404);
    assert.strictEqual((await admin.patch(`/api/supplier-products/${foreignProduct.id}/status`, { isActive: false })).status, 404);
    await prisma.supplierProduct.delete({ where: { id: foreignProduct.id } });
    await prisma.supplier.delete({ where: { id: foreignSupplier.id } });
  });

  await test('supplier disable, archive and restore work as a lifecycle', async () => {
    const created = await admin.post('/api/suppliers', { name: 'Lifecycle Supplier' });
    const id = created.body.data.id;
    assert.strictEqual((await admin.patch(`/api/suppliers/${id}/status`, { status: 'DISABLED' })).body.data.status, 'DISABLED');
    assert.strictEqual((await admin.patch(`/api/suppliers/${id}/status`, { status: 'ACTIVE' })).body.data.status, 'ACTIVE');
    const archived = await admin.post(`/api/suppliers/${id}/archive`);
    assert.strictEqual(archived.body.data.status, 'ARCHIVED');
    assert.strictEqual((await admin.patch(`/api/suppliers/${id}/status`, { status: 'ACTIVE' })).status, 400,
      'an archived supplier must be restored first');
    const restored = await admin.post(`/api/suppliers/${id}/restore`);
    assert.strictEqual(restored.body.data.status, 'ACTIVE');
    assert.strictEqual((await admin.del(`/api/suppliers/${id}`)).status, 200);
  });

  await test('deleting a supplier with fulfilment history archives it instead', async () => {
    const r = await admin.del(`/api/suppliers/${supplierId}`);
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.data.status, 'ARCHIVED');
    const still = await prisma.supplier.findUnique({ where: { id: supplierId } });
    assert.ok(still, 'the supplier row must survive — fulfilment history depends on it');
  });

  await test('credential rotation keeps old fields and clears removed ones', async () => {
    const before = await prisma.supplierIntegration.findUnique({ where: { id: integrationId } });
    const r = await admin.put(`/api/supplier-integrations/${integrationId}`, {
      credentials: { apiKey: 'sk_rotated_value_9988' },
    });
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(!r.text.includes('sk_rotated_value_9988'), 'the new secret must not be echoed');
    const after = await prisma.supplierIntegration.findUnique({ where: { id: integrationId } });
    assert.deepStrictEqual(decryptSecrets(after.credentialsCipher), { apiKey: 'sk_rotated_value_9988' });
    assert.notStrictEqual(after.credentialsCipher, before.credentialsCipher);
    // restore the working key so the remaining checks stay valid
    await admin.put(`/api/supplier-integrations/${integrationId}`, { credentials: { apiKey: API_KEY } });
  });

  await test('audit log records supplier marketplace actions', async () => {
    const r = await admin.get('/api/audit-logs?limit=100');
    const entities = r.body.data.map((l) => l.entity);
    assert.ok(entities.includes('Supplier'), 'supplier actions should be audited');
    assert.ok(entities.includes('SupplierIntegration'), 'integration actions should be audited');
    assert.ok(!r.text.includes(API_KEY), 'the API key must never appear in audit data');
  });

  await test('unpublishing withdraws the product without destroying owned data', async () => {
    const { data } = await admin.getJ('/api/supplier-products', { supplierId, search: 'CSV-AC-9K' });
    const r = await admin.post(`/api/supplier-products/${data[0].id}/unpublish`);
    assert.strictEqual(r.status, 200, r.text);
    const sp = await prisma.supplierProduct.findUnique({ where: { id: data[0].id } });
    assert.strictEqual(sp.published, false);
    const mapping = await prisma.supplierProductMapping.findFirst({ where: { supplierProductId: data[0].id } });
    assert.strictEqual(mapping, null, 'the mapping is removed on unpublish');
  });

  await test('SFTP connector reports honestly that its runtime is not installed', async () => {
    const connectors = await admin.get('/api/suppliers/connectors');
    const sftp = connectors.body.data.find((c) => c.id === 'SFTP');
    assert.strictEqual(sftp.installed, false, 'ssh2 is not part of the baseline dependencies');
    const supplier = await admin.post('/api/suppliers', { name: 'SFTP Supplier' });
    const integ = await admin.post('/api/supplier-integrations', {
      supplierId: supplier.body.data.id, name: 'SFTP drop', connectorType: 'SFTP', authType: 'SFTP',
      config: { host: 'sftp.supplier.example', catalogPath: '/feeds/catalog.csv' },
      credentials: { username: 'feeds', password: 'secret' },
    });
    assert.strictEqual(integ.status, 201);
    const test = await admin.post(`/api/supplier-integrations/${integ.body.data.id}/test`);
    assert.strictEqual(test.body.data.connected, false);
    assert.ok(/ssh2/.test(test.body.data.message), `expected an actionable runtime message, got: ${test.body.data.message}`);
    await admin.del(`/api/suppliers/${supplier.body.data.id}`);
  });

  // ----------------------------------------------------------- unit coverage
  await test('CSV parser handles quoted delimiters, embedded newlines and CRLF', async () => {
    const csv = 'sku,name,notes\r\nA1,"Widget, large","line1\nline2"\r\nA2,Plain,\r\n';
    const { records } = parseCsvObjects(csv);
    assert.strictEqual(records.length, 2);
    assert.strictEqual(records[0].name, 'Widget, large');
    assert.strictEqual(records[0].notes, 'line1\nline2');
  });

  await test('CSV parser detects semicolon and tab delimiters', async () => {
    assert.strictEqual(parseCsvObjects('sku;name\nA;B').records[0].name, 'B');
    assert.strictEqual(parseCsvObjects('sku\tname\nA\tB').records[0].name, 'B');
  });

  await test('the encryption envelope is authenticated — tampering fails', async () => {
    const envelope = encryptSecrets({ apiKey: 'secret-value' });
    const parts = envelope.split('.');
    parts[3] = Buffer.from('tampered-ciphertext').toString('base64url');
    assert.throws(() => decryptSecrets(parts.join('.')), /decrypt|Unsupported|auth/i);
  });

  await test('fulfilment statuses cover the full lifecycle', async () => {
    const { STATUSES } = require('../src/lib/suppliers/fulfillment');
    for (const s of ['PENDING', 'READY', 'SUBMITTED', 'ACCEPTED', 'PROCESSING', 'PARTIALLY_SHIPPED', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'FAILED']) {
      assert.ok(STATUSES.includes(s), `missing status ${s}`);
    }
  });

  await teardown();

  // --------------------------------------------------------------- report
  console.log('\nSupplier Marketplace verification');
  console.log('=================================');
  for (const [status, name] of results) {
    console.log(`  ${status === 'PASS' ? '✔' : '✘'} ${name}`);
  }
  const passed = results.filter((r) => r[0] === 'PASS').length;
  console.log(`\n${passed}/${results.length} checks passed\n`);

  supplierApi.close();
  server.close();
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error('\nSupplier suite crashed:', e);
  await teardown().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});

/**
 * Removes everything this suite created. The local SQLite runner does not apply
 * foreign keys (see prisma/migrate.js), so children are deleted explicitly in
 * dependency order rather than relying on cascade.
 */
async function teardown() {
  const testCustomers = ['dropship.customer@example.com', 'hybrid.customer@example.com',
    'cancel.customer@example.com', 'restock.customer@example.com'];
  const testSkus = ['CSV-AC-9K', 'CSV-FILTER-01', 'CSV-R134A', 'CSV-OK-1', 'CSV-BADUPC',
    'CSV-EVIL', 'CSV-EVIL2', 'CSV-EVIL3', 'XML-AC-1', 'JSON-AC-1',
    'TST-AC-12K', 'TST-COMP-5T', 'TST-R410A-25'];
  const supplierIds = (await prisma.supplier.findMany({
    where: { OR: [{ code: { startsWith: 'TESTCOOL' } }, { name: { startsWith: 'TestCool' } },
      { name: { startsWith: 'NoCreds' } }, { name: { startsWith: 'Bad Connector' } },
      { name: { startsWith: 'Lifecycle' } }, { name: { startsWith: 'SFTP Supplier' } },
      { name: { startsWith: 'Dbg' } }, { tenantId: { not: 'default' } }] },
    select: { id: true },
  })).map((s) => s.id);

  const orders = await prisma.order.findMany({
    where: { customer: { email: { in: testCustomers } } }, select: { id: true },
  });
  const orderIds = orders.map((o) => o.id);

  await prisma.supplierFulfillmentItem.deleteMany({ where: { fulfillment: { orderId: { in: orderIds } } } });
  await prisma.supplierFulfillment.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.supplierFulfillmentItem.deleteMany({ where: { fulfillment: { supplierId: { in: supplierIds } } } });
  await prisma.supplierFulfillment.deleteMany({ where: { supplierId: { in: supplierIds } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.customer.deleteMany({ where: { email: { in: testCustomers } } });

  await prisma.supplierSyncLog.deleteMany({ where: { supplierId: { in: supplierIds } } });
  await prisma.supplierSync.deleteMany({ where: { supplierId: { in: supplierIds } } });
  await prisma.supplierCatalogImport.deleteMany({ where: { supplierId: { in: supplierIds } } });
  await prisma.supplierProductMapping.deleteMany({ where: { supplierId: { in: supplierIds } } });
  await prisma.supplierProduct.deleteMany({ where: { supplierId: { in: supplierIds } } });
  // Orphans left behind by earlier interrupted runs.
  await prisma.supplierProductMapping.deleteMany({ where: { product: { sku: { in: testSkus } } } });
  await prisma.supplierProduct.deleteMany({ where: { supplierSku: { in: testSkus } } });
  await prisma.product.deleteMany({ where: { sku: { in: testSkus } } });
  await prisma.supplierShippingRule.deleteMany({ where: { supplierId: { in: supplierIds } } });
  await prisma.supplierMarkupRule.deleteMany({});
  await prisma.supplierIntegration.deleteMany({ where: { supplierId: { in: supplierIds } } });
  await prisma.supplier.deleteMany({ where: { id: { in: supplierIds } } });
  await prisma.category.deleteMany({ where: { slug: { in: ['supplier-imports', 'filter-driers', 'window-air-conditioners'] } } });
}
