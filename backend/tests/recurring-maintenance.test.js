#!/usr/bin/env node
const assert = require('assert');
const {
  addMonthsClamped,
  normalizeRecurrence,
  buildReminderSchedule,
  DEFAULT_REMINDER_OFFSETS_DAYS,
} = require('../src/lib/recurring-maintenance');

function iso(value) {
  return new Date(value).toISOString();
}

function run() {
  // Recurrence date calculation: preserve the day when it exists.
  assert.strictEqual(iso(addMonthsClamped('2026-09-11T10:00:00Z', 3)), '2026-12-11T10:00:00.000Z');
  assert.strictEqual(iso(addMonthsClamped('2026-09-11T10:00:00Z', 6)), '2027-03-11T10:00:00.000Z');

  // Month-end behavior is deterministic: clamp to the last valid day.
  assert.strictEqual(iso(addMonthsClamped('2026-01-31T10:00:00Z', 1)), '2026-02-28T10:00:00.000Z');
  assert.strictEqual(iso(addMonthsClamped('2028-01-31T10:00:00Z', 1)), '2028-02-29T10:00:00.000Z');
  assert.strictEqual(iso(addMonthsClamped('2026-03-31T10:00:00Z', 6)), '2026-09-30T10:00:00.000Z');

  // Supported intervals plus a positive custom month interval.
  for (const months of [1, 2, 3, 6, 12, 24]) {
    assert.deepStrictEqual(normalizeRecurrence({ intervalMonths: months }), { intervalMonths: months });
  }
  assert.throws(() => normalizeRecurrence({ intervalMonths: 0 }), /positive/i);
  assert.throws(() => normalizeRecurrence({ intervalMonths: -3 }), /positive/i);
  assert.throws(() => normalizeRecurrence({ intervalMonths: 1.5 }), /integer/i);

  // The core reminder policy remains free/core and has the required defaults.
  assert.deepStrictEqual(DEFAULT_REMINDER_OFFSETS_DAYS, [30, 7, 1, 0]);
  const appointment = new Date('2026-12-11T10:00:00Z');
  const reminders = buildReminderSchedule(appointment, [30, 7, 1, 0]);
  assert.deepStrictEqual(reminders.map((r) => r.offsetDays), [30, 7, 1, 0]);
  assert.strictEqual(iso(reminders[0].scheduledFor), '2026-11-11T10:00:00.000Z');
  assert.strictEqual(iso(reminders[1].scheduledFor), '2026-12-04T10:00:00.000Z');
  assert.strictEqual(iso(reminders[2].scheduledFor), '2026-12-10T10:00:00.000Z');
  assert.strictEqual(iso(reminders[3].scheduledFor), '2026-12-11T10:00:00.000Z');

  console.log('PASS: recurring maintenance recurrence contracts');
}

try {
  run();
} catch (error) {
  console.error(`FAIL: recurring maintenance recurrence contracts — ${error.stack || error.message}`);
  process.exitCode = 1;
}
