#!/usr/bin/env node
const assert = require('assert');
const bcrypt = require('bcryptjs');
const app = require('../src/app');
const prisma = require('../src/lib/prisma');

function makeClient(base) {
  const cookies = new Map();
  let csrfToken = null;
  let accessToken = null;

  async function request(method, path, body) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookies.size) headers.Cookie = [...cookies].map(([key, value]) => `${key}=${value}`).join('; ');
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const cookie of response.headers.getSetCookie?.() || []) {
      const [pair] = cookie.split(';');
      const separator = pair.indexOf('=');
      cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch (_) { json = null; }
    return { status: response.status, body: json };
  }

  return {
    setCsrfToken(token) { csrfToken = token; },
    setAccessToken(token) { accessToken = token; },
    get(path) { return request('GET', path); },
    post(path, body) { return request('POST', path, body); },
    patch(path, body) { return request('PATCH', path, body); },
  };
}

async function main() {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const client = makeClient(`http://127.0.0.1:${server.address().port}`);
  let requestId;
  let workOrderId;
  let rbacRequestId;
  let rbacWorkOrderId;
  let rbacCustomerEmail;

  try {
    const csrf = await client.get('/api/csrf-token');
    assert.strictEqual(csrf.status, 200);
    assert.ok(csrf.body?.data?.csrfToken);
    client.setCsrfToken(csrf.body.data.csrfToken);

    const login = await client.post('/api/auth/login', {
      email: process.env.SEED_ADMIN_EMAIL || 'admin@ndsairconditioning.com',
      password: process.env.SEED_ADMIN_PASSWORD || 'Admin@12345',
    });
    assert.strictEqual(login.status, 200, 'admin authentication must work');
    client.setAccessToken(login.body.data.accessToken);

    const customers = await client.get('/api/customers?limit=1');
    assert.strictEqual(customers.status, 200);
    assert.ok(customers.body?.data?.[0]?.id, 'an existing customer is required');
    const customerId = customers.body.data[0].id;

    const missing = await client.post('/api/service-requests', {});
    assert.strictEqual(missing.status, 400, 'missing required fields must return 400');

    const invalidCustomer = await client.post('/api/service-requests', {
      customerId: '00000000-0000-4000-8000-000000000000',
      serviceType: 'Air Conditioning Repair',
      problem: 'Unit not cooling',
      address: 'Test service address',
      priority: 'NORMAL',
    });
    assert.ok([400, 404].includes(invalidCustomer.status), 'invalid customerId must be rejected');

    const created = await client.post('/api/service-requests', {
      customerId,
      serviceType: 'Air Conditioning Repair',
      problem: 'Unit not cooling',
      address: 'Test service address',
      priority: 'NORMAL',
    });
    assert.strictEqual(created.status, 201);
    assert.ok(created.body?.data?.id);
    assert.strictEqual(created.body.data.status, 'NEW');
    requestId = created.body.data.id;

    const detail = await client.get(`/api/service-requests/${requestId}`);
    assert.strictEqual(detail.status, 200);
    assert.strictEqual(detail.body?.data?.id, requestId);
    assert.strictEqual(detail.body?.data?.customer?.id, customerId);

    const filtered = await client.get('/api/service-requests?status=NEW');
    assert.strictEqual(filtered.status, 200);
    assert.ok(filtered.body.data.some((item) => item.id === requestId));
    assert.ok(filtered.body.data.every((item) => item.status === 'NEW'));

    const converted = await client.post(`/api/service-requests/${requestId}/convert`, {});
    assert.strictEqual(converted.status, 201);
    assert.ok(converted.body?.data?.id);
    assert.strictEqual(converted.body.data.requestId, requestId);
    assert.strictEqual(converted.body.data.status, 'NEW');
    workOrderId = converted.body.data.id;

    const repeated = await client.post(`/api/service-requests/${requestId}/convert`, {});
    assert.ok([200, 201].includes(repeated.status));
    assert.strictEqual(repeated.body?.data?.id, workOrderId);

    const invalidTransition = await client.post(`/api/work-orders/${workOrderId}/status`, {
      status: 'COMPLETED',
    });
    assert.strictEqual(invalidTransition.status, 400);

    // ---- RBAC: STAFF retains operational access; CUSTOMER must not ----
    const staffClient = makeClient(`http://127.0.0.1:${server.address().port}`);
    const staffCsrf = await staffClient.get('/api/csrf-token');
    staffClient.setCsrfToken(staffCsrf.body.data.csrfToken);
    const staffAuth = await staffClient.post('/api/auth/login', {
      email: process.env.SEED_STAFF_EMAIL || 'staff@ndsairconditioning.com',
      password: process.env.SEED_STAFF_PASSWORD || 'Staff@12345',
    });
    assert.strictEqual(staffAuth.status, 200, 'staff authentication must work');
    staffClient.setAccessToken(staffAuth.body.data.accessToken);

    const rbacCreated = await client.post('/api/service-requests', {
      customerId, serviceType: 'RBAC Fixture', problem: 'RBAC fixture', address: 'RBAC address', priority: 'NORMAL',
    });
    assert.strictEqual(rbacCreated.status, 201);
    rbacRequestId = rbacCreated.body.data.id;

    // CUSTOMER must not be able to perform any of the operational mutations —
    // checked first, while the request is still in its initial NEW state.
    rbacCustomerEmail = `rbac-wo-customer.${Date.now()}@example.com`;
    await prisma.user.create({
      data: { name: 'WO RBAC Customer', email: rbacCustomerEmail, passwordHash: await bcrypt.hash('Customer@12345', 12), role: 'CUSTOMER', businessId: null },
    });
    const customerClient = makeClient(`http://127.0.0.1:${server.address().port}`);
    const customerCsrf = await customerClient.get('/api/csrf-token');
    customerClient.setCsrfToken(customerCsrf.body.data.csrfToken);
    const customerAuth = await customerClient.post('/api/auth/login', { email: rbacCustomerEmail, password: 'Customer@12345' });
    assert.strictEqual(customerAuth.status, 200, JSON.stringify(customerAuth.body));
    customerClient.setAccessToken(customerAuth.body.data.accessToken);

    const custStatusChange = await customerClient.patch(`/api/service-requests/${rbacRequestId}/status`, { status: 'REVIEWING' });
    assert.strictEqual(custStatusChange.status, 403, 'a CUSTOMER must not be able to change a service request\'s status');

    const custConvert = await customerClient.post(`/api/service-requests/${rbacRequestId}/convert`, {});
    assert.strictEqual(custConvert.status, 403, 'a CUSTOMER must not be able to convert a service request');

    // STAFF (TECHNICIAN) must retain the ability to review/convert/operate.
    const staffStatusChange = await staffClient.patch(`/api/service-requests/${rbacRequestId}/status`, { status: 'REVIEWING' });
    assert.strictEqual(staffStatusChange.status, 200, 'STAFF must retain the ability to review a service request');

    const staffConvert = await staffClient.post(`/api/service-requests/${rbacRequestId}/convert`, {});
    assert.strictEqual(staffConvert.status, 201, 'STAFF must retain the ability to convert a service request');
    rbacWorkOrderId = staffConvert.body.data.id;

    const staffAssign = await staffClient.post(`/api/work-orders/${rbacWorkOrderId}/assign`, { technicianId: null });
    assert.strictEqual(staffAssign.status, 200, 'STAFF must retain the ability to (un)assign a work order');

    const staffWorkOrderStatus = await staffClient.post(`/api/work-orders/${rbacWorkOrderId}/status`, { status: 'ASSIGNED' });
    assert.strictEqual(staffWorkOrderStatus.status, 200, 'STAFF must retain the ability to change work order status');

    const custAssign = await customerClient.post(`/api/work-orders/${rbacWorkOrderId}/assign`, { technicianId: null });
    assert.strictEqual(custAssign.status, 403, 'a CUSTOMER must not be able to assign a work order');

    const custWOStatus = await customerClient.post(`/api/work-orders/${rbacWorkOrderId}/status`, { status: 'IN_PROGRESS' });
    assert.strictEqual(custWOStatus.status, 403, 'a CUSTOMER must not be able to change work order status');

    const custLabour = await customerClient.post(`/api/work-orders/${rbacWorkOrderId}/labour`, { description: 'Hack', hours: 1, rate: 10 });
    assert.strictEqual(custLabour.status, 403, 'a CUSTOMER must not be able to add billable labour');

    const custParts = await customerClient.post(`/api/work-orders/${rbacWorkOrderId}/parts`, { productId: '00000000-0000-4000-8000-000000000000', quantity: 1 });
    assert.strictEqual(custParts.status, 403, 'a CUSTOMER must not be able to bill parts to a work order');

    const custSchedule = await customerClient.post(`/api/work-orders/${rbacWorkOrderId}/schedule`, { scheduledAt: new Date().toISOString() });
    assert.strictEqual(custSchedule.status, 403, 'a CUSTOMER must not be able to schedule a work order');

    const custInvoice = await customerClient.post(`/api/work-orders/${rbacWorkOrderId}/invoice`, {});
    assert.strictEqual(custInvoice.status, 403, 'a CUSTOMER must not be able to invoice a work order');

    console.log('PASS: service operations API contract');
  } finally {
    if (rbacWorkOrderId) await prisma.workOrder.deleteMany({ where: { id: rbacWorkOrderId } });
    if (rbacRequestId) await prisma.serviceRequest.deleteMany({ where: { id: rbacRequestId } });
    if (rbacCustomerEmail) await prisma.user.deleteMany({ where: { email: rbacCustomerEmail } });
    if (workOrderId) await prisma.workOrder.deleteMany({ where: { id: workOrderId } });
    if (requestId) await prisma.serviceRequest.deleteMany({ where: { id: requestId } });
    if (requestId || workOrderId || rbacRequestId || rbacWorkOrderId) {
      await prisma.auditLog.deleteMany({
        where: { entityId: { in: [requestId, workOrderId, rbacRequestId, rbacWorkOrderId].filter(Boolean) } },
      });
    }
    await prisma.$disconnect();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(`FAIL: service operations API contract — ${error.stack || error.message}`);
  process.exit(1);
});
