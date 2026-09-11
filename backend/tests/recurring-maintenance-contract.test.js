#!/usr/bin/env node
const assert = require('assert');
const app = require('../src/app');
const prisma = require('../src/lib/prisma');

function makeClient(base) {
  const cookies = new Map(); let csrf = null; let token = null;
  async function request(method, path, body) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookies.size) headers.Cookie = [...cookies].map(([k,v]) => `${k}=${v}`).join('; ');
    if (csrf) headers['X-CSRF-Token'] = csrf;
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const cookie of response.headers.getSetCookie?.() || []) { const [pair] = cookie.split(';'); const [k,v] = pair.split('='); cookies.set(k,v); }
    const text = await response.text(); let json = null; try { json = JSON.parse(text); } catch (_) {}
    return { status: response.status, body: json };
  }
  return { get: (p) => request('GET',p), post: (p,b) => request('POST',p,b), put: (p,b) => request('PUT',p,b), setToken: (v) => { token=v; }, setCsrf: (v) => { csrf=v; } };
}

async function main() {
  const server = app.listen(0); await new Promise((r) => server.once('listening', r));
  const client = makeClient(`http://127.0.0.1:${server.address().port}`);
  let seriesId; let occurrenceId; let createdBookingId;
  try {
    const csrf = await client.get('/api/csrf-token');
    assert.strictEqual(csrf.status, 200);
    client.setCsrf(csrf.body.data.csrfToken);
    const login = await client.post('/api/auth/login', { email: process.env.SEED_ADMIN_EMAIL || 'admin@ndsairconditioning.com', password: process.env.SEED_ADMIN_PASSWORD || 'Admin@12345' });
    assert.strictEqual(login.status, 200, 'admin login must work');
    client.setToken(login.body.data.accessToken);
    const customers = await client.get('/api/customers?limit=1'); assert.strictEqual(customers.status, 200);
    const customer = customers.body.data[0]; assert.ok(customer?.id);
    const equipment = await client.get(`/api/equipment?customerId=${customer.id}&limit=1`);
    const equipmentRow = equipment.body.data[0];
    const services = await client.get('/api/services?limit=1'); const service = services.body.data[0];
    const technicians = await client.get('/api/users?limit=100');
    const technician = technicians.body.data.find((u) => u.isActive && ['ADMIN','STAFF'].includes(u.role));
    const start = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000); start.setUTCHours(14,0,0,0);
    const created = await client.post('/api/recurring-maintenance', { customerId: customer.id, equipmentId: equipmentRow?.id || null, serviceId: service?.id || null, technicianId: technician?.id || null, intervalMonths: 3, startDate: start.toISOString() });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    seriesId = created.body.data.id;
    assert.strictEqual(created.body.data.status, 'ACTIVE');
    assert.strictEqual(created.body.data.occurrences.length, 1);
    occurrenceId = created.body.data.occurrences[0].id;
    createdBookingId = created.body.data.occurrences[0].bookingId;
    const cross = await client.get(`/api/recurring-maintenance/${seriesId}`); assert.strictEqual(cross.status, 200);
    const paused = await client.post(`/api/recurring-maintenance/${seriesId}/pause`); assert.strictEqual(paused.status, 200); assert.strictEqual(paused.body.data.status, 'PAUSED');
    const resumed = await client.post(`/api/recurring-maintenance/${seriesId}/resume`); assert.strictEqual(resumed.status, 200); assert.strictEqual(resumed.body.data.status, 'ACTIVE');
    const cancelled = await client.post(`/api/recurring-maintenance/${seriesId}/cancel`); assert.strictEqual(cancelled.status, 200); assert.strictEqual(cancelled.body.data.status, 'CANCELLED');
    const history = await prisma.recurringMaintenanceOccurrence.findUnique({ where: { id: occurrenceId } }); assert.ok(history);
    console.log('PASS: recurring maintenance API contract');
  } finally {
    if (seriesId) await prisma.recurringMaintenanceSeries.deleteMany({ where: { id: seriesId } });
    if (createdBookingId) await prisma.booking.deleteMany({ where: { id: createdBookingId } });
    await prisma.$disconnect(); await new Promise((r) => server.close(r));
  }
}
main().catch((error) => { console.error(`FAIL: recurring maintenance API contract — ${error.stack || error.message}`); process.exit(1); });
