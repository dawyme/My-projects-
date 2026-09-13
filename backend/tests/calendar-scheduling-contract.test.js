#!/usr/bin/env node
/**
 * Phase C — Calendar & Scheduling foundation API contract.
 *
 * Boots the real app against the seeded local database and verifies:
 * calendar views + filters, availability, server-side conflict validation
 * (warn vs block policy), time off / working hours / breaks / closed days,
 * lead time & booking window, duration & buffer, recurring compatibility,
 * cancellation, tenant isolation, SUPER_ADMIN access, feature entitlement,
 * and the scheduling notification event bus.
 *
 * Conflict scenarios use a far-future slot (2030) so they can never collide
 * with seeded data. All rows created here are cleaned up in `finally`.
 */
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'test-resend-key';
const assert = require('assert');
const app = require('../src/app');
const prisma = require('../src/lib/prisma');
const { on: onSchedulingEvent } = require('../src/lib/scheduling-events');

const SLOT = '2030-01-15T10:00:00.000Z'; // Tuesday, far future
const SLOT2 = '2030-01-15T12:00:00.000Z'; // same day, later

function makeClient(base) {
  const cookies = new Map(); let csrfToken = null; let accessToken = null;
  async function request(method, path, body) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookies.size) headers.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const cookie of response.headers.getSetCookie?.() || []) { const [pair] = cookie.split(';'); cookies.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)); }
    const text = await response.text(); let json; try { json = JSON.parse(text); } catch (_) { json = null; }
    return { status: response.status, body: json };
  }
  return {
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b),
    put: (p, b) => request('PUT', p, b),
    patch: (p, b) => request('PATCH', p, b),
    del: (p, b) => request('DELETE', p, b),
    setCsrfToken: (t) => { csrfToken = t; },
    setAccessToken: (t) => { accessToken = t; },
  };
}

async function login(client, email, password) {
  const csrf = await client.get('/api/csrf-token');
  assert.strictEqual(csrf.status, 200);
  client.setCsrfToken(csrf.body.data.csrfToken);
  const r = await client.post('/api/auth/login', { email, password });
  assert.strictEqual(r.status, 200, `login failed for ${email}: ${JSON.stringify(r.body)}`);
  client.setAccessToken(r.body.data.accessToken);
}

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url) === 'https://api.resend.com/emails') {
      return new Response(JSON.stringify({ id: 'test-id' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(url, options);
  };

  let results = 0;
  async function test(name, fn) {
    try {
      await fn();
      results++;
      console.log(`  PASS: ${name}`);
    } catch (e) {
      console.error(`  FAIL: ${name} — ${e && e.stack || e}`);
      process.exitCode = 1;
    }
  }

  const admin = makeClient(base);   // tenant A (default, seeded)
  const platform = makeClient(base); // SUPER_ADMIN (businessId NULL)
  let tenantB = null, tenantBId = null, tenantBA = null;
  const created = { bookings: [], seriesId: null, workingHours: [], timeOffs: [], breaks: [], closedDays: [] };
  let originalScheduling = null, originalHours = null;
  let bookingA, bookingB, custA, custB;

  try {
    await login(admin, process.env.SEED_ADMIN_EMAIL || 'admin@ndsairconditioning.com', process.env.SEED_ADMIN_PASSWORD || 'Admin@12345');
    await login(platform, process.env.SEED_PLATFORM_EMAIL || 'platform@ndsairconditioning.com', process.env.SEED_PLATFORM_PASSWORD || 'Platform@12345');

    // Capture the tenant scheduling/hours settings so cleanup can restore them.
    originalScheduling = await prisma.setting.findUnique({ where: { businessId_key: { businessId: 'default', key: 'scheduling' } } });
    originalHours = await prisma.setting.findUnique({ where: { businessId_key: { businessId: 'default', key: 'hours' } } });

    // ------------------------------------------------------------ calendar views
    await test('calendar month view keeps the original shape', async () => {
      const month = new Date().toISOString().slice(0, 7);
      const r = await admin.get(`/api/bookings/calendar?month=${month}`);
      assert.strictEqual(r.status, 200);
      assert.ok(r.body.data.days && typeof r.body.data.days === 'object');
      assert.strictEqual(typeof r.body.data.total, 'number');
      assert.strictEqual(r.body.data.view, 'month');
    });
    await test('calendar day view returns a one-day range with events', async () => {
      const date = new Date().toISOString().slice(0, 10);
      const r = await admin.get(`/api/bookings/calendar?view=day&date=${date}`);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.data.view, 'day');
      assert.strictEqual(r.body.data.range.start.slice(0, 10), date);
      assert.strictEqual(Math.round((new Date(r.body.data.range.end) - new Date(r.body.data.range.start)) / 864e5), 1);
    });
    await test('calendar 3-day view spans three days', async () => {
      const r = await admin.get('/api/bookings/calendar?view=3day&date=2030-01-15');
      assert.strictEqual(r.status, 200);
      assert.strictEqual(Math.round((new Date(r.body.data.range.end) - new Date(r.body.data.range.start)) / 864e5), 3);
      assert.strictEqual(r.body.data.range.start.slice(0, 10), '2030-01-15');
    });
    await test('calendar week view starts on Monday and spans seven days', async () => {
      const r = await admin.get('/api/bookings/calendar?view=week&date=2030-01-17'); // Thursday
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.data.range.start.slice(0, 10), '2030-01-14'); // Monday
      assert.strictEqual(Math.round((new Date(r.body.data.range.end) - new Date(r.body.data.range.start)) / 864e5), 7);
    });
    await test('calendar agenda view returns a flat items list', async () => {
      const r = await admin.get('/api/bookings/calendar?view=agenda&date=2030-01-01');
      assert.strictEqual(r.status, 200);
      assert.ok(Array.isArray(r.body.data.items));
      assert.strictEqual(Math.round((new Date(r.body.data.range.end) - new Date(r.body.data.range.start)) / 864e5), 14);
    });
    await test('calendar events carry duration, end time and linkage fields', async () => {
      const list = await admin.get('/api/bookings?limit=1&sort=scheduledAt&order=desc');
      assert.strictEqual(list.status, 200);
      const b = list.body.data[0];
      const r = await admin.get(`/api/bookings/calendar?view=day&date=${b.scheduledAt.slice(0, 10)}`);
      const ev = (r.body.data.days[b.scheduledAt.slice(0, 10)] || []).find((e) => e.id === b.id);
      assert.ok(ev, 'event present for the booking date');
      for (const field of ['start', 'end', 'durationMin', 'bufferMin', 'customer', 'service', 'technician', 'technicianId', 'workOrder', 'recurring']) {
        assert.ok(field in ev, `event field ${field} present`);
      }
      assert.strictEqual(ev.end, new Date(new Date(b.scheduledAt).getTime() + ev.durationMin * 60000).toISOString().slice(11, 16));
    });
    await test('calendar filters: technician, status, service, customer, search', async () => {
      const unassigned = await admin.get('/api/bookings/calendar?view=agenda&date=2020-01-01&technicianId=unassigned');
      assert.strictEqual(unassigned.status, 200);
      assert.ok(unassigned.body.data.items.every((e) => e.technicianId === null));
      const list = await admin.get('/api/bookings?limit=50');
      const withStatus = (list.body.data.find((b) => b.status === 'COMPLETED'));
      if (withStatus) {
        const r = await admin.get(`/api/bookings/calendar?view=agenda&date=${withStatus.scheduledAt.slice(0, 10)}&status=COMPLETED`);
        assert.ok(r.body.data.items.every((e) => e.status === 'COMPLETED'));
      }
      const svc = list.body.data.find((b) => b.serviceId);
      if (svc) {
        const r = await admin.get(`/api/bookings/calendar?view=agenda&date=${svc.scheduledAt.slice(0, 10)}&serviceId=${svc.serviceId}`);
        assert.ok(r.body.data.items.every((e) => e.serviceId === svc.serviceId));
      }
      const ref = list.body.data[0].reference;
      const searched = await admin.get(`/api/bookings/calendar?view=agenda&date=${list.body.data[0].scheduledAt.slice(0, 10)}&search=${encodeURIComponent(ref)}`);
      assert.ok(searched.body.data.items.some((e) => e.reference === ref), 'search finds the reference');
    });

    // ------------------------------------------------------------ availability + conflicts (warn = default)
    let technician = null;
    await test('availability endpoint reports a free slot', async () => {
      const users = await admin.get('/api/users?limit=100');
      technician = users.body.data.find((u) => u.role === 'STAFF');
      assert.ok(technician, 'a STAFF technician exists');
      const r = await admin.get(`/api/bookings/availability?technicianId=${technician.id}&date=2030-01-15&time=10:00`);
      assert.strictEqual(r.status, 200);
      assert.ok(Array.isArray(r.body.data.conflicts));
      assert.ok(Array.isArray(r.body.data.warnings));
      assert.strictEqual(r.body.data.available, r.body.data.conflicts.length === 0);
    });
    await test('availability requires a technician and rejects foreign ids', async () => {
      assert.strictEqual((await admin.get('/api/bookings/availability?date=2030-01-15')).status, 400);
      assert.strictEqual((await admin.get('/api/bookings/availability?technicianId=00000000-0000-4000-8000-000000000000&date=2030-01-15')).status, 400);
    });

    await test('default policy is warn: double-booking creates with a conflict report', async () => {
      const current = await admin.get('/api/settings');
      assert.strictEqual(current.body.data.scheduling.conflictPolicy, 'warn', 'policy defaults to warn');
      custA = { name: 'Conflict Client One', email: `conflict.a.${Date.now()}@example.com`, phone: '+1 555 0101' };
      const r = await admin.post('/api/bookings', { customer: custA, technicianId: technician.id, scheduledAt: SLOT, durationMin: 60, bufferMin: 0 });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      bookingA = r.body.data;
      custB = { name: 'Conflict Client Two', email: `conflict.b.${Date.now()}@example.com`, phone: '+1 555 0102' };
      const r2 = await admin.post('/api/bookings', { customer: custB, technicianId: technician.id, scheduledAt: SLOT, durationMin: 60, bufferMin: 0 });
      assert.strictEqual(r2.status, 201, 'warn policy still allows the second booking');
      bookingB = r2.body.data;
      assert.ok((r2.body.conflicts || []).some((c) => c.type === 'technician-overlap' && c.reference === bookingA.reference));
    });
    await test('buffer extends the occupied window for conflict detection', async () => {
      const custC = { name: 'Buffer Client', email: `buffer.${Date.now()}@example.com` };
      const r = await admin.post('/api/bookings', { customer: custC, technicianId: technician.id, scheduledAt: SLOT2, durationMin: 30, bufferMin: 90 });
      assert.strictEqual(r.status, 201);
      created.bookings.push(r.body.data.id);
      // SLOT2 12:00 with 90 min buffer occupies 10:30-12:30 → overlaps bookingA (10:00-11:00)
      assert.ok((r.body.conflicts || []).some((c) => c.type === 'technician-overlap'), 'buffer window overlaps booking A');
    });
    await test('reschedule to an overlapping slot reports conflicts under warn policy', async () => {
      const r = await admin.put(`/api/bookings/${bookingB.id}`, { scheduledAt: new Date(new Date(SLOT).getTime() + 30 * 60000).toISOString(), notify: false });
      assert.strictEqual(r.status, 200);
      assert.ok((r.body.conflicts || []).length >= 1, 'overlap with booking A reported');
    });
    await test('assigning a technician to a conflicting slot reports conflicts under warn policy', async () => {
      const r = await admin.patch(`/api/bookings/${bookingB.id}/assign`, { technicianId: technician.id });
      assert.strictEqual(r.status, 200);
      assert.ok((r.body.conflicts || []).length >= 1);
    });

    // ------------------------------------------------------------ block policy
    await test('block policy rejects double-bookings with useful details', async () => {
      const set = await admin.put('/api/settings/scheduling', { conflictPolicy: 'block' });
      assert.strictEqual(set.status, 200);
      const custC = { name: 'Blocked Client', email: `blocked.${Date.now()}@example.com` };
      const r = await admin.post('/api/bookings', { customer: custC, technicianId: technician.id, scheduledAt: SLOT, durationMin: 60 });
      assert.strictEqual(r.status, 400);
      assert.ok(r.body.error);
      assert.ok((r.body.details?.conflicts || []).some((c) => c.type === 'technician-overlap'));
      const put = await admin.put(`/api/bookings/${bookingB.id}`, { scheduledAt: SLOT, notify: false });
      assert.strictEqual(put.status, 400, 'reschedule into the conflict is blocked');
      const assign = await admin.patch(`/api/bookings/${created.bookings[0]}/assign`, { technicianId: technician.id });
      // that booking (12:00-12:30 with 90 min buffer → 10:30-12:30) overlaps booking A at 10:00-11:00
      assert.strictEqual(assign.status, 400, 'assign into the conflict is blocked');
    });
    await test('block policy still allows conflict-free slots', async () => {
      const custC = { name: 'Free Slot Client', email: `freeslot.${Date.now()}@example.com` };
      const r = await admin.post('/api/bookings', { customer: custC, technicianId: technician.id, scheduledAt: '2030-01-16T10:00:00.000Z', durationMin: 60 });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      created.bookings.push(r.body.data.id);
    });

    // ------------------------------------------------------------ time off
    await test('approved time-off blocks the slot; pending does not', async () => {
      assert.strictEqual((await admin.put('/api/settings/scheduling', { conflictPolicy: 'block' })).status, 200);
      const r = await admin.post('/api/scheduling/time-off', {
        userId: technician.id, startsAt: '2030-02-01T00:00:00.000Z', endsAt: '2030-02-02T23:59:59.000Z', reason: 'Test leave',
      });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      created.timeOffs.push(r.body.data.id);
      const avail = await admin.get(`/api/bookings/availability?technicianId=${technician.id}&date=2030-02-01&time=10:00`);
      assert.ok(avail.body.data.conflicts.some((c) => c.type === 'time-off'));
      assert.strictEqual(avail.body.data.available, false);
      const custT = { name: 'Time Off Client', email: `timeoff.${Date.now()}@example.com` };
      const blocked = await admin.post('/api/bookings', { customer: custT, technicianId: technician.id, scheduledAt: '2030-02-01T10:00:00.000Z' });
      assert.strictEqual(blocked.status, 400, 'block policy rejects appointments during approved time off');
      const pending = await admin.post('/api/scheduling/time-off', { userId: technician.id, startsAt: '2030-03-01T00:00:00.000Z', endsAt: '2030-03-02T23:59:59.000Z', status: 'PENDING' });
      assert.strictEqual(pending.status, 201);
      created.timeOffs.push(pending.body.data.id);
      const avail2 = await admin.get(`/api/bookings/availability?technicianId=${technician.id}&date=2030-03-01&time=10:00`);
      assert.ok(!avail2.body.data.conflicts.some((c) => c.type === 'time-off'), 'pending time off is not a conflict');
    });
    await test('time-off status can be approved, rejected and cancelled', async () => {
      const pending = await prisma.timeOff.findFirst({ where: { businessId: 'default', userId: technician.id, status: 'PENDING' } });
      assert.ok(pending, 'a pending entry exists');
      assert.strictEqual((await admin.patch(`/api/scheduling/time-off/${pending.id}`, { status: 'APPROVED' })).status, 200);
      assert.strictEqual((await admin.patch(`/api/scheduling/time-off/${pending.id}`, { status: 'REJECTED' })).status, 200);
      assert.strictEqual((await admin.patch(`/api/scheduling/time-off/${pending.id}`, { status: 'CANCELLED' })).status, 200);
    });

    // ------------------------------------------------------------ working hours / breaks / closed days
    await test('working-hours violations warn by default and block when strict', async () => {
      const set = await admin.put('/api/settings/hours', {
        monday: '09:00-17:00', tuesday: '09:00-17:00', wednesday: '09:00-17:00', thursday: '09:00-17:00',
        friday: '09:00-17:00', saturday: 'Closed', sunday: 'Closed', emergency247: false,
      });
      assert.strictEqual(set.status, 200);
      const avail = await admin.get(`/api/bookings/availability?technicianId=${technician.id}&date=2030-04-02&time=20:00`); // Tuesday 20:00
      assert.ok(avail.body.data.warnings.some((w) => w.type === 'working-hours'), 'after close is a warning');
      assert.strictEqual(avail.body.data.available, true, 'warnings do not mark the slot unavailable');
      const custW = { name: 'After Hours Client', email: `afterhours.${Date.now()}@example.com` };
      const ok = await admin.post('/api/bookings', { customer: custW, technicianId: technician.id, scheduledAt: '2030-04-02T20:00:00.000Z', durationMin: 60 });
      assert.strictEqual(ok.status, 201, 'warn policy allows the out-of-hours booking');
      created.bookings.push(ok.body.data.id);
      assert.ok((ok.body.warnings || []).some((w) => w.type === 'working-hours'));
      const strict = await admin.put('/api/settings/scheduling', { strictWorkingHours: true });
      assert.strictEqual(strict.status, 200);
      const custW2 = { name: 'After Hours Client 2', email: `afterhours2.${Date.now()}@example.com` };
      const rejected = await admin.post('/api/bookings', { customer: custW2, technicianId: technician.id, scheduledAt: '2030-04-03T20:00:00.000Z', durationMin: 60 });
      assert.strictEqual(rejected.status, 400, 'strict working hours + block policy rejects');
      assert.ok((rejected.body.details?.conflicts || []).some((c) => c.type === 'working-hours' && c.promoted));
      await admin.put('/api/settings/scheduling', { strictWorkingHours: false });
    });
    await test('technician working hours override business hours', async () => {
      const r = await admin.put('/api/scheduling/working-hours', { userId: technician.id, day: 2, start: '06:00', end: '22:00' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      created.workingHours.push(r.body.data.id);
      const avail = await admin.get(`/api/bookings/availability?technicianId=${technician.id}&date=2030-04-02&time=20:00`); // Tue, inside 06:00-22:00
      assert.ok(!avail.body.data.warnings.some((w) => w.type === 'working-hours'), 'technician override widens the window');
      const list = await admin.get(`/api/scheduling/working-hours?userId=${technician.id}`);
      assert.ok(list.body.data.some((w) => w.day === 2 && w.start === '06:00'));
    });
    await test('business breaks and closed days produce warnings', async () => {
      const brk = await admin.put('/api/scheduling/breaks', { day: 2, start: '13:00', end: '14:00' });
      assert.strictEqual(brk.status, 200);
      created.breaks.push(brk.body.data.id);
      const avail = await admin.get(`/api/bookings/availability?technicianId=${technician.id}&date=2030-05-07&time=12:30`); // Tuesday 12:30 + 30 min crosses 13:00
      assert.ok(avail.body.data.warnings.some((w) => w.type === 'break'));
      const cd = await admin.post('/api/scheduling/closed-days', { date: '2030-06-01T00:00:00.000Z', reason: 'Platform test holiday' });
      assert.strictEqual(cd.status, 201);
      created.closedDays.push(cd.body.data.id);
      const avail2 = await admin.get(`/api/bookings/availability?date=2030-06-01&time=10:00&technicianId=${technician.id}`);
      assert.ok(avail2.body.data.warnings.some((w) => w.type === 'closed-day'));
    });

    // ------------------------------------------------------------ lead time / window
    await test('lead time and booking window rules are enforced per policy', async () => {
      assert.strictEqual((await admin.put('/api/settings/scheduling', { conflictPolicy: 'warn' })).status, 200);
      const set = await admin.put('/api/settings/scheduling', { minLeadHours: 24, maxBookingDays: 30 });
      assert.strictEqual(set.status, 200);
      const soon = new Date(Date.now() + 2 * 3600000).toISOString();
      const r = await admin.post('/api/bookings', { customer: { name: 'Lead Time Client', email: `leadtime.${Date.now()}@example.com` }, scheduledAt: soon, durationMin: 60 });
      assert.strictEqual(r.status, 201, 'warn policy allows below lead time');
      created.bookings.push(r.body.data.id);
      assert.ok((r.body.conflicts || []).some((c) => c.type === 'lead-time'));
      const far = new Date(Date.now() + 100 * 864e5).toISOString();
      const r2 = await admin.post('/api/bookings', { customer: { name: 'Window Client', email: `window.${Date.now()}@example.com` }, scheduledAt: far, durationMin: 60 });
      assert.ok((r2.body.conflicts || []).some((c) => c.type === 'booking-window'));
      created.bookings.push(r2.body.data.id);
      // block policy (still active from earlier) rejects both
      const r3 = await admin.put('/api/settings/scheduling', { conflictPolicy: 'block' });
      assert.strictEqual(r3.status, 200);
      const blocked = await admin.post('/api/bookings', { customer: { name: 'Lead Blocked', email: `leadblocked.${Date.now()}@example.com` }, scheduledAt: soon, durationMin: 60 });
      assert.strictEqual(blocked.status, 400);
      const blocked2 = await admin.post('/api/bookings', { customer: { name: 'Window Blocked', email: `windowblocked.${Date.now()}@example.com` }, scheduledAt: far, durationMin: 60 });
      assert.strictEqual(blocked2.status, 400);
      await admin.put('/api/settings/scheduling', { minLeadHours: 0, maxBookingDays: 0 });
    });

    // ------------------------------------------------------------ duration on calendar events
    await test('calendar events reflect explicit duration overrides', async () => {
      const custD = { name: 'Duration Client', email: `duration.${Date.now()}@example.com` };
      const r = await admin.post('/api/bookings', { customer: custD, technicianId: technician.id, scheduledAt: '2030-07-01T09:00:00.000Z', durationMin: 120 });
      assert.strictEqual(r.status, 201);
      created.bookings.push(r.body.data.id);
      const cal = await admin.get('/api/bookings/calendar?view=day&date=2030-07-01');
      const ev = cal.body.data.days['2030-07-01'].find((e) => e.id === r.body.data.id);
      assert.strictEqual(ev.durationMin, 120);
      assert.strictEqual(ev.start, '09:00');
      assert.strictEqual(ev.end, '11:00');
    });

    // ------------------------------------------------------------ recurring compatibility
    await test('recurring occurrences appear on the calendar flagged as recurring', async () => {
      const custs = await admin.get('/api/customers?limit=1');
      assert.strictEqual(custs.status, 200);
      const r = await admin.post('/api/recurring-maintenance', {
        customerId: custs.body.data[0].id, intervalMonths: 1, startDate: '2030-09-01T10:00:00.000Z', serviceLabel: 'Contract maintenance',
      });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      created.seriesId = r.body.data.id;
      const cal = await admin.get('/api/bookings/calendar?view=month&month=2030-09');
      const ev = (cal.body.data.days['2030-09-01'] || []).find((e) => e.recurring);
      assert.ok(ev, 'the occurrence booking appears with recurring: true');
      const series = (await admin.get(`/api/recurring-maintenance/${created.seriesId}`)).body.data;
      const first = series.occurrences.find((o) => o.occurrenceNumber === 1);
      assert.ok(first, 'series has its first occurrence');
      assert.strictEqual(ev.reference, first.booking.reference);
    });

    // ------------------------------------------------------------ cancellation
    await test('cancelled bookings stop conflicting and emit booking.cancelled', async () => {
      const events = [];
      const off = onSchedulingEvent('booking.cancelled', (p) => events.push(p));
      const cancel = await admin.patch(`/api/bookings/${bookingB.id}/status`, { status: 'CANCELLED', notify: false });
      assert.strictEqual(cancel.status, 200);
      assert.strictEqual(cancel.body.data.status, 'CANCELLED');
      await new Promise((r) => setTimeout(r, 50));
      off();
      assert.ok(events.some((e) => e.bookingId === bookingB.id && e.reference === bookingB.reference), 'booking.cancelled fired');
      const avail = await admin.get(`/api/bookings/availability?technicianId=${technician.id}&date=2030-01-15&time=10:30`);
      assert.ok(!avail.body.data.conflicts.some((c) => c.reference === bookingB.reference), 'cancelled booking no longer conflicts');
    });

    // ------------------------------------------------------------ notification events (create/assign/reschedule/update)
    await test('scheduling events fire on create, update, assign and reschedule', async () => {
      const seen = { created: 0, updated: 0, assigned: 0, rescheduled: 0 };
      const offs = [
        onSchedulingEvent('booking.created', () => seen.created++),
        onSchedulingEvent('booking.updated', () => seen.updated++),
        onSchedulingEvent('booking.assigned', () => seen.assigned++),
        onSchedulingEvent('booking.rescheduled', () => seen.rescheduled++),
      ];
      const r = await admin.post('/api/bookings', { customer: { name: 'Events Client', email: `events.${Date.now()}@example.com` }, scheduledAt: '2030-08-01T10:00:00.000Z', durationMin: 60 });
      assert.strictEqual(r.status, 201);
      const id = r.body.data.id;
      created.bookings.push(id);
      await admin.patch(`/api/bookings/${id}/assign`, { technicianId: technician.id });
      await admin.put(`/api/bookings/${id}`, { scheduledAt: '2030-08-02T10:00:00.000Z', notify: false });
      await admin.put(`/api/bookings/${id}`, { description: 'updated note', notify: false });
      await new Promise((r) => setTimeout(r, 50));
      offs.forEach((f) => f());
      assert.ok(seen.created >= 1, 'booking.created');
      assert.ok(seen.assigned >= 1, 'booking.assigned');
      assert.ok(seen.rescheduled >= 1, 'booking.rescheduled');
      assert.ok(seen.updated >= 1, 'booking.updated');
    });

    // ------------------------------------------------------------ SUPER_ADMIN
    await test('SUPER_ADMIN keeps unrestricted calendar access', async () => {
      const cal = await platform.get('/api/bookings/calendar?view=month&month=2030-01');
      assert.strictEqual(cal.status, 200);
      assert.ok(cal.body.data.total >= 2, 'platform owner sees default-tenant calendar data');
      const roster = await platform.get('/api/scheduling/technicians');
      assert.strictEqual(roster.status, 200);
      assert.ok(Array.isArray(roster.body.data));
      const av = await platform.get(`/api/bookings/availability?technicianId=${technician.id}&date=2030-08-01&time=10:00`);
      assert.strictEqual(av.status, 200);
    });

    // ------------------------------------------------------------ tenant isolation + feature entitlement
    await test('tenant isolation: separate calendars, 404 cross-tenant, no cross-tenant schedules', async () => {
      const plans = await platform.get('/api/saas/plans');
      assert.strictEqual(plans.status, 200);
      const planId = plans.body.data[0].id;
      const email = `phase-c-${Date.now()}@example.com`;
      const createdTenant = await platform.post('/api/saas/businesses', { name: `Phase C Tenant ${Date.now()}`, planId, admin: { name: 'Tenant B Admin', email, password: 'Tenant123!' } });
      assert.strictEqual(createdTenant.status, 201, JSON.stringify(createdTenant.body));
      tenantBId = createdTenant.body.data.id;
      tenantB = makeClient(base);
      await login(tenantB, email, 'Tenant123!');
      const empty = await tenantB.get('/api/bookings/calendar?view=month&month=2030-01');
      assert.strictEqual(empty.status, 200);
      assert.strictEqual(empty.body.data.total, 0, 'tenant B sees no tenant A bookings');
      const own = await tenantB.post('/api/bookings', { customer: { name: 'Tenant B Client', email: `tb.${Date.now()}@example.com` }, scheduledAt: '2030-01-15T10:00:00.000Z', durationMin: 60 });
      assert.strictEqual(own.status, 201);
      created.tenantBBookings = [own.body.data.id];
      const cross = await admin.get(`/api/bookings/${own.body.data.id}`);
      assert.strictEqual(cross.status, 404, 'tenant A cannot read a tenant B booking');
      const crossPut = await admin.put(`/api/bookings/${own.body.data.id}`, { description: 'x', notify: false });
      assert.strictEqual(crossPut.status, 404);
      const foreignUser = await prisma.user.findFirst({ where: { businessId: tenantBId } });
      const foreignWh = await admin.put('/api/scheduling/working-hours', { userId: foreignUser.id, day: 1, start: '09:00', end: '17:00' });
      // tenant A cannot upsert working hours for a tenant B user
      assert.strictEqual(foreignWh.status, 400, 'cross-tenant user rejected for scheduling data');
    });
    await test('feature entitlement: disabling calendar hides the calendar API but not service-bookings', async () => {
      const features = await platform.get('/api/saas/features');
      assert.strictEqual(features.status, 200);
      const calendarFeature = features.body.data.find((f) => f.key === 'calendar');
      assert.ok(calendarFeature, 'calendar feature is registered');
      const off = await platform.patch(`/api/saas/features/${calendarFeature.id}/access/${tenantBId}`, { enabled: false });
      assert.strictEqual(off.status, 200, JSON.stringify(off.body));
      assert.strictEqual((await tenantB.get('/api/bookings/calendar?view=month&month=2030-01')).status, 403, 'calendar API is feature-gated');
      assert.strictEqual((await tenantB.get('/api/scheduling/technicians')).status, 403, 'scheduling API is feature-gated');
      assert.strictEqual((await tenantB.get('/api/bookings?limit=5')).status, 200, 'service-bookings stays available');
      const on = await platform.patch(`/api/saas/features/${calendarFeature.id}/access/${tenantBId}`, { enabled: true });
      assert.strictEqual(on.status, 200);
      assert.strictEqual((await tenantB.get('/api/bookings/calendar?view=month&month=2030-01')).status, 200);
    });
  } catch (e) {
    console.error('FATAL:', e.stack || e);
    process.exitCode = 1;
  } finally {
    global.fetch = originalFetch;
    try {
      // restore settings exactly as found (Setting is keyed by businessId+key; it has no id)
      if (originalScheduling) {
        await prisma.setting.update({ where: { businessId_key: { businessId: 'default', key: 'scheduling' } }, data: { value: originalScheduling.value } }).catch(() => {});
      } else {
        await prisma.setting.delete({ where: { businessId_key: { businessId: 'default', key: 'scheduling' } } }).catch(() => {});
      }
      if (originalHours) {
        await prisma.setting.update({ where: { businessId_key: { businessId: 'default', key: 'hours' } }, data: { value: originalHours.value } }).catch(() => {});
      } else {
        await prisma.setting.delete({ where: { businessId_key: { businessId: 'default', key: 'hours' } } }).catch(() => {});
      }
      // scheduling rows
      for (const id of created.workingHours) await prisma.workingHours.delete({ where: { id } }).catch(() => {});
      for (const id of created.timeOffs) await prisma.timeOff.delete({ where: { id } }).catch(() => {});
      for (const id of created.breaks) await prisma.breakPeriod.delete({ where: { id } }).catch(() => {});
      for (const id of created.closedDays) await prisma.closedDay.delete({ where: { id } }).catch(() => {});
      // recurring series — occurrences cascade from the series, but the
      // occurrence bookings are parents and must be removed explicitly
      if (created.seriesId) {
        const occs = await prisma.recurringMaintenanceOccurrence.findMany({ where: { seriesId: created.seriesId }, select: { bookingId: true } });
        for (const o of occs) await prisma.booking.delete({ where: { id: o.bookingId } }).catch(() => {});
        await prisma.recurringMaintenanceSeries.delete({ where: { id: created.seriesId } }).catch(() => {});
      }
      // tenant B
      if (tenantBId) {
        for (const id of created.tenantBBookings || []) await prisma.booking.delete({ where: { id } }).catch(() => {});
        await prisma.activity.deleteMany({ where: { businessId: tenantBId } }).catch(() => {});
        await prisma.auditLog.deleteMany({ where: { businessId: tenantBId } }).catch(() => {});
        await prisma.subscription.deleteMany({ where: { businessId: tenantBId } }).catch(() => {});
        await prisma.customer.deleteMany({ where: { businessId: tenantBId } }).catch(() => {});
        await prisma.user.deleteMany({ where: { businessId: tenantBId } }).catch(() => {});
        await prisma.business.delete({ where: { id: tenantBId } }).catch(() => {});
      }
      // tenant A bookings (notes first, then cascade-safe delete)
      const ids = [bookingA?.id, bookingB?.id, ...created.bookings];
      for (const id of ids) {
        if (!id) continue;
        await prisma.bookingNote.deleteMany({ where: { bookingId: id } }).catch(() => {});
        await prisma.jobStatus.deleteMany({ where: { bookingId: id } }).catch(() => {});
        await prisma.booking.delete({ where: { id } }).catch(() => {});
      }
      // customers created by the tests (tenant A only; tenant B customers already removed)
      await prisma.customer.deleteMany({ where: { businessId: 'default', email: { startsWith: 'conflict.' } } }).catch(() => {});
      await prisma.customer.deleteMany({ where: { businessId: 'default', email: { startsWith: 'buffer.' } } }).catch(() => {});
      await prisma.customer.deleteMany({ where: { businessId: 'default', email: { startsWith: 'blocked.' } } }).catch(() => {});
      await prisma.customer.deleteMany({ where: { businessId: 'default', email: { startsWith: 'freeslot.' } } }).catch(() => {});
      await prisma.customer.deleteMany({ where: { businessId: 'default', email: { startsWith: 'timeoff.' } } }).catch(() => {});
      await prisma.customer.deleteMany({ where: { businessId: 'default', email: { startsWith: 'afterhours' } } }).catch(() => {});
      await prisma.customer.deleteMany({ where: { businessId: 'default', email: { startsWith: 'leadtime.' } } }).catch(() => {});
      await prisma.customer.deleteMany({ where: { businessId: 'default', email: { startsWith: 'window.' } } }).catch(() => {});
      await prisma.customer.deleteMany({ where: { businessId: 'default', email: { startsWith: 'leadblocked.' } } }).catch(() => {});
      await prisma.customer.deleteMany({ where: { businessId: 'default', email: { startsWith: 'windowblocked.' } } }).catch(() => {});
      await prisma.customer.deleteMany({ where: { businessId: 'default', email: { startsWith: 'duration.' } } }).catch(() => {});
      await prisma.customer.deleteMany({ where: { businessId: 'default', email: { startsWith: 'events.' } } }).catch(() => {});
    } catch (e) {
      console.error('cleanup error:', e.message);
    }
    server.close();
    console.log(`calendar-scheduling contract: ${process.exitCode ? 'FAIL' : `PASS (${results} checks)`}`);
  }
}

main();
