#!/usr/bin/env node
const assert = require('assert');
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'test-resend-key';
const app = require('../src/app');
const prisma = require('../src/lib/prisma');

function makeClient(base) {
  const cookies = new Map(); let csrfToken = null; let accessToken = null;
  async function request(method, path, body) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookies.size) headers.Cookie = [...cookies].map(([k,v]) => `${k}=${v}`).join('; ');
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const cookie of response.headers.getSetCookie?.() || []) { const [pair] = cookie.split(';'); const i = pair.indexOf('='); cookies.set(pair.slice(0,i), pair.slice(i+1)); }
    const text = await response.text(); let json; try { json = JSON.parse(text); } catch (_) { json = null; }
    return { status: response.status, body: json };
  }
  return { get: p => request('GET', p), post: (p,b) => request('POST', p,b), put: (p,b) => request('PUT', p,b), setCsrfToken: t => { csrfToken=t; }, setAccessToken: t => { accessToken=t; } };
}

async function main() {
  const server = app.listen(0); await new Promise(r => server.once('listening', r));
  const client = makeClient(`http://127.0.0.1:${server.address().port}`);
  const originalFetch = global.fetch; const resendCalls = [];
  global.fetch = async (url, options) => {
    if (String(url) === 'https://api.resend.com/emails') {
      resendCalls.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ id: 'test-reminder-id' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(url, options);
  };
  let booking; let startedAt;
  try {
    const csrf = await client.get('/api/csrf-token'); assert.strictEqual(csrf.status, 200); client.setCsrfToken(csrf.body.data.csrfToken);
    const login = await client.post('/api/auth/login', { email: process.env.SEED_ADMIN_EMAIL || 'admin@ndsairconditioning.com', password: process.env.SEED_ADMIN_PASSWORD || 'Admin@12345' });
    assert.strictEqual(login.status, 200); client.setAccessToken(login.body.data.accessToken);
    const users = await client.get('/api/users?limit=100'); assert.strictEqual(users.status, 200);
    const technician = users.body.data.find(u => u.isActive && ['STAFF','ADMIN'].includes(u.role));
    const bookings = await client.get('/api/bookings?limit=100&sort=scheduledAt&order=asc'); assert.strictEqual(bookings.status, 200);
    booking = bookings.body.data.find(b => b.customer?.email);
    assert.ok(booking, 'an existing booking with a customer email is required');
    const original = { scheduledAt: booking.scheduledAt, technicianId: booking.technicianId, status: booking.status, priority: booking.priority };
    startedAt = new Date();

    const next = new Date(new Date(booking.scheduledAt).getTime() + 60 * 60 * 1000).toISOString();
    const dispatchUpdate = await client.put(`/api/bookings/${booking.id}`, { scheduledAt: next, technicianId: technician?.id || null, status: booking.status, priority: booking.priority, notify: false });
    assert.strictEqual(dispatchUpdate.status, 200, 'dispatch board must be able to reschedule and assign');
    assert.strictEqual(dispatchUpdate.body.data.technicianId, technician?.id || null);
    assert.strictEqual(new Date(dispatchUpdate.body.data.scheduledAt).toISOString(), next);

    const reminder = await client.post(`/api/reminders/bookings/${booking.id}`);
    assert.strictEqual(reminder.status, 200); assert.strictEqual(reminder.body.data.sent, true); assert.strictEqual(resendCalls.length, 1);
    assert.match(resendCalls[0].subject, /Reminder/);

    const duplicate = await client.post(`/api/reminders/bookings/${booking.id}`);
    assert.strictEqual(duplicate.status, 200); assert.strictEqual(duplicate.body.data.alreadySent, true); assert.strictEqual(resendCalls.length, 1, 'duplicate reminder must not resend');

    const restored = await client.put(`/api/bookings/${booking.id}`, { ...original, notify: false });
    assert.strictEqual(restored.status, 200, 'test booking must be restored');
    console.log('PASS: dispatch assignment/reschedule and reminder idempotency contract');
  } finally {
    if (booking && startedAt) await prisma.auditLog.deleteMany({ where: { entity: 'Booking', entityId: booking.id, action: 'REMINDER_SENT', createdAt: { gte: startedAt } } });
    global.fetch = originalFetch;
    await prisma.$disconnect(); await new Promise(r => server.close(r));
  }
}

main().catch(error => { console.error(`FAIL: dispatch/reminders contract — ${error.stack || error.message}`); process.exit(1); });
