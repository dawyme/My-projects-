#!/usr/bin/env node
const assert = require('assert');
const {
  effectiveDurationMin,
  occupiedWindow,
  overlaps,
  dayOfDate,
  parseDayHours,
  parseHhMm,
  resolveSchedulingPolicy,
  checkTechnicianConflicts,
  checkTimeOffConflicts,
  checkWorkingHours,
  checkBreaks,
  checkClosedDays,
  checkLeadTimeWindow,
  applyPolicy,
  validateAppointmentTimes,
} = require('../src/lib/scheduling-rules');

function run() {
  // ------------------------------------------------ duration resolution
  assert.strictEqual(effectiveDurationMin({}, null), 60);
  assert.strictEqual(effectiveDurationMin({ durationMin: null }, { durationMin: 90 }), 90);
  assert.strictEqual(effectiveDurationMin({ durationMin: 45 }, { durationMin: 90 }), 45);
  assert.strictEqual(effectiveDurationMin({ durationMin: 0 }, { durationMin: 30 }), 30);

  // ------------------------------------------------ occupied window + buffer
  const win = occupiedWindow('2026-09-12T14:00:00Z', 60, 15);
  assert.strictEqual(win.start.toISOString(), '2026-09-12T13:45:00.000Z');
  assert.strictEqual(win.end.toISOString(), '2026-09-12T15:00:00.000Z');
  assert.strictEqual(overlaps(new Date('2026-09-12T13:45:00Z'), new Date('2026-09-12T15:00:00Z'),
    new Date('2026-09-12T15:00:00Z'), new Date('2026-09-12T16:00:00Z')), false, 'adjacent windows do not overlap');
  assert.strictEqual(overlaps(new Date('2026-09-12T13:45:00Z'), new Date('2026-09-12T15:00:00Z'),
    new Date('2026-09-12T14:59:00Z'), new Date('2026-09-12T16:00:00Z')), true);

  // ------------------------------------------------ weekdays + time parsing
  assert.strictEqual(dayOfDate('2026-09-14T10:00:00Z'), 1, 'Monday = 1');
  assert.strictEqual(dayOfDate('2026-09-20T10:00:00Z'), 7, 'Sunday = 7');
  assert.deepStrictEqual(parseDayHours('08:00-17:00'), { startMin: 480, endMin: 1020 });
  assert.deepStrictEqual(parseDayHours('09:30-13:30'), { startMin: 570, endMin: 810 });
  assert.strictEqual(parseDayHours('Closed'), null);
  assert.strictEqual(parseDayHours(''), null);
  assert.strictEqual(parseDayHours('17:00-08:00'), null, 'inverted range is invalid');
  assert.strictEqual(parseHhMm('09:05'), 545);
  assert.strictEqual(parseHhMm('25:00'), null);

  // ------------------------------------------------ policy resolution
  assert.deepStrictEqual(resolveSchedulingPolicy(null), { conflictPolicy: 'warn', minLeadHours: 0, maxBookingDays: 0, strictWorkingHours: false });
  assert.deepStrictEqual(resolveSchedulingPolicy({ conflictPolicy: 'block', minLeadHours: 4 }),
    { conflictPolicy: 'block', minLeadHours: 4, maxBookingDays: 0, strictWorkingHours: false });
  assert.strictEqual(resolveSchedulingPolicy({ conflictPolicy: 'bogus' }).conflictPolicy, 'warn');
  assert.strictEqual(resolveSchedulingPolicy({ minLeadHours: -5 }).minLeadHours, 0);

  // ------------------------------------------------ technician double-booking
  const bookings = [
    { id: 'b1', reference: 'BK-A', technicianId: 't1', status: 'CONFIRMED', scheduledAt: new Date('2026-09-14T10:00:00Z'), durationMin: null, bufferMin: null, service: { durationMin: 60 } },
    { id: 'b2', reference: 'BK-B', technicianId: 't1', status: 'PENDING', scheduledAt: new Date('2026-09-14T11:30:00Z'), durationMin: 60, bufferMin: 0, service: null },
    { id: 'b3', reference: 'BK-C', technicianId: 't2', status: 'CONFIRMED', scheduledAt: new Date('2026-09-14T10:00:00Z'), durationMin: null, bufferMin: null, service: { durationMin: 60 } },
    { id: 'b4', reference: 'BK-D', technicianId: 't1', status: 'CANCELLED', scheduledAt: new Date('2026-09-14T10:30:00Z'), durationMin: null, bufferMin: null, service: { durationMin: 60 } },
  ];
  assert.strictEqual(checkTechnicianConflicts({ start: new Date('2026-09-14T09:00:00Z'), end: new Date('2026-09-14T10:00:00Z'), technicianId: 't1', bookings }).length, 0, 'no overlap before the window');
  const hit = checkTechnicianConflicts({ start: new Date('2026-09-14T10:30:00Z'), end: new Date('2026-09-14T11:30:00Z'), technicianId: 't1', bookings });
  assert.strictEqual(hit.length, 1, 'overlaps b1 only');
  assert.strictEqual(hit[0].reference, 'BK-A');
  const otherTech = checkTechnicianConflicts({ start: new Date('2026-09-14T10:30:00Z'), end: new Date('2026-09-14T11:30:00Z'), technicianId: 't2', bookings });
  assert.deepStrictEqual(otherTech.map((c) => c.reference), ['BK-C'], "only the candidate technician's own bookings are counted");
  assert.strictEqual(checkTechnicianConflicts({ start: new Date('2026-09-14T13:00:00Z'), end: new Date('2026-09-14T14:00:00Z'), technicianId: 't2', bookings }).length, 0, 'other technician is free at another time');
  assert.strictEqual(checkTechnicianConflicts({ start: new Date('2026-09-14T10:30:00Z'), end: new Date('2026-09-14T11:30:00Z'), technicianId: 't1', ignoreBookingId: 'b1', bookings }).length, 0, 'self excluded on update');
  const withBuffer = checkTechnicianConflicts({ start: new Date('2026-09-14T09:50:00Z'), end: new Date('2026-09-14T11:50:00Z'), technicianId: 't1', bookings });
  assert.ok(withBuffer.some((c) => c.reference === 'BK-B'), 'buffered window catches the 11:30 booking');

  // ------------------------------------------------ approved time off
  const timeOffs = [
    { id: 'to1', userId: 't1', status: 'APPROVED', startsAt: new Date('2026-09-14T08:00:00Z'), endsAt: new Date('2026-09-15T17:00:00Z'), reason: 'Holiday' },
    { id: 'to2', userId: 't1', status: 'PENDING', startsAt: new Date('2026-09-14T08:00:00Z'), endsAt: new Date('2026-09-15T17:00:00Z'), reason: null },
    { id: 'to3', userId: 't2', status: 'APPROVED', startsAt: new Date('2026-09-14T08:00:00Z'), endsAt: new Date('2026-09-15T17:00:00Z'), reason: null },
  ];
  assert.strictEqual(checkTimeOffConflicts({ start: new Date('2026-09-14T09:00:00Z'), end: new Date('2026-09-14T10:00:00Z'), technicianId: 't1', timeOffs }).length, 1, 'approved time off blocks');
  assert.strictEqual(checkTimeOffConflicts({ start: new Date('2026-09-16T09:00:00Z'), end: new Date('2026-09-16T10:00:00Z'), technicianId: 't1', timeOffs }).length, 0, 'outside the time-off range is fine');
  const t2Conflicts = checkTimeOffConflicts({ start: new Date('2026-09-14T09:00:00Z'), end: new Date('2026-09-14T10:00:00Z'), technicianId: 't2', timeOffs });
  assert.deepStrictEqual(t2Conflicts.map((c) => c.timeOffId), ['to3'], "only the candidate technician's own time off is counted");

  // ------------------------------------------------ working hours
  const hoursByDay = { 1: { startMin: 480, endMin: 1020 } }; // Monday 08:00-17:00
  assert.strictEqual(checkWorkingHours('2026-09-14T09:00:00Z', '2026-09-14T10:00:00Z', hoursByDay).length, 0, 'inside hours is fine');
  assert.strictEqual(checkWorkingHours('2026-09-14T18:00:00Z', '2026-09-14T19:00:00Z', hoursByDay).length, 1, 'after close is a violation');
  assert.strictEqual(checkWorkingHours('2026-09-14T06:00:00Z', '2026-09-14T09:00:00Z', hoursByDay).length, 1, 'before open is a violation');
  assert.strictEqual(checkWorkingHours('2026-09-14T09:00:00Z', '2026-09-14T10:00:00Z', {}).length, 0, 'no defined hours = no constraint');
  assert.strictEqual(checkWorkingHours('2026-09-14T23:30:00Z', '2026-09-15T01:30:00Z', { 1: { startMin: 480, endMin: 1020 }, 2: { startMin: 480, endMin: 1020 } }).length, 2, 'multi-day span checks each day');

  // ------------------------------------------------ breaks
  const breaksByDay = { 1: [{ startMin: 720, endMin: 780 }] }; // Monday 12:00-13:00
  assert.strictEqual(checkBreaks('2026-09-14T11:30:00Z', '2026-09-14T13:30:00Z', breaksByDay).length, 1, 'crossing the break');
  assert.strictEqual(checkBreaks('2026-09-14T14:00:00Z', '2026-09-14T15:00:00Z', breaksByDay).length, 0, 'after the break');

  // ------------------------------------------------ closed days
  const closed = [new Date('2026-09-14T00:00:00Z')];
  assert.strictEqual(checkClosedDays('2026-09-14T09:00:00Z', '2026-09-14T10:00:00Z', closed).length, 1);
  assert.strictEqual(checkClosedDays('2026-09-15T09:00:00Z', '2026-09-15T10:00:00Z', closed).length, 0);

  // ------------------------------------------------ lead time / window
  const now = new Date('2026-09-12T12:00:00Z');
  assert.strictEqual(checkLeadTimeWindow('2026-09-12T13:00:00Z', now, { minLeadHours: 2 }).length, 1, 'below minimum lead time');
  assert.strictEqual(checkLeadTimeWindow('2026-09-13T00:00:00Z', now, { minLeadHours: 2 }).length, 0, 'meets the lead time');
  assert.strictEqual(checkLeadTimeWindow('2026-12-31T09:00:00Z', now, { maxBookingDays: 30 }).length, 1, 'beyond the booking window');
  assert.strictEqual(checkLeadTimeWindow('2026-09-13T09:00:00Z', now, { maxBookingDays: 30 }).length, 0, 'inside the booking window');

  // ------------------------------------------------ policy application
  const conflicts = [{ type: 'technician-overlap', reference: 'BK-A', message: 'x' }];
  const warnings = [{ type: 'working-hours', message: 'y' }];
  const warn = applyPolicy({ conflicts, warnings, policy: { conflictPolicy: 'warn' } });
  assert.strictEqual(warn.blocked, false, 'warn policy never blocks');
  const block = applyPolicy({ conflicts, warnings, policy: { conflictPolicy: 'block' } });
  assert.strictEqual(block.blocked, true, 'block policy blocks on conflicts');
  assert.strictEqual(block.warnings.length, 1);
  const strict = applyPolicy({ conflicts: [], warnings, policy: { conflictPolicy: 'warn', strictWorkingHours: true } });
  assert.strictEqual(strict.blocked, false, 'strict working hours alone does not block under warn policy');
  assert.strictEqual(strict.conflicts.length, 1, 'strict working hours promotes the warning to a conflict');
  const strictBlock = applyPolicy({ conflicts: [], warnings, policy: { conflictPolicy: 'block', strictWorkingHours: true } });
  assert.strictEqual(strictBlock.blocked, true, 'strict + block rejects out-of-hours appointments');

  // ------------------------------------------------ hard data validation
  assert.ok(validateAppointmentTimes({ scheduledAt: '2026-09-12T09:00:00Z' }).start instanceof Date);
  assert.throws(() => validateAppointmentTimes({ scheduledAt: 'not-a-date' }), /valid date/);
  assert.throws(() => validateAppointmentTimes({ scheduledAt: '2026-09-12T09:00:00Z', durationMin: 2 }), /durationMin/);
  assert.throws(() => validateAppointmentTimes({ scheduledAt: '2026-09-12T09:00:00Z', bufferMin: 999 }), /bufferMin/);
  // past dates stay valid: dispatch boards reschedule and crews record past visits
  assert.ok(validateAppointmentTimes({ scheduledAt: '2024-01-01T09:00:00Z' }).start instanceof Date, 'past scheduledAt is accepted');
}

try {
  run();
  console.log('PASS: scheduling rules unit contracts');
} catch (error) {
  console.error(`FAIL: scheduling rules unit contracts — ${error.stack || error.message}`);
  process.exitCode = 1;
}
