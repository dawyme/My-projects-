const DEFAULT_REMINDER_OFFSETS_DAYS = Object.freeze([30, 7, 1, 0]);

function addMonthsClamped(value, months) {
  const source = new Date(value);
  if (Number.isNaN(source.getTime())) throw new Error('Invalid date');
  if (!Number.isInteger(months) || months <= 0) throw new Error('Months must be a positive integer');
  const day = source.getUTCDate();
  const target = new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth() + months, 1,
    source.getUTCHours(), source.getUTCMinutes(), source.getUTCSeconds(), source.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}

function normalizeRecurrence(input = {}) {
  const intervalMonths = Number(input.intervalMonths);
  if (!Number.isInteger(intervalMonths)) throw new Error('Interval must be an integer');
  if (intervalMonths <= 0) throw new Error('Interval must be positive');
  return { intervalMonths };
}

function normalizeReminderOffsets(offsets) {
  const source = offsets == null ? DEFAULT_REMINDER_OFFSETS_DAYS : offsets;
  if (!Array.isArray(source) || !source.every((v) => Number.isInteger(Number(v)) && Number(v) >= 0)) {
    throw new Error('Reminder offsets must be non-negative integers');
  }
  return [...new Set(source.map(Number))].sort((a, b) => b - a);
}

function buildReminderSchedule(appointment, offsets = DEFAULT_REMINDER_OFFSETS_DAYS) {
  const scheduledAt = new Date(appointment);
  if (Number.isNaN(scheduledAt.getTime())) throw new Error('Invalid appointment date');
  return normalizeReminderOffsets(offsets).map((offsetDays) => ({
    offsetDays,
    channel: 'EMAIL',
    scheduledFor: new Date(scheduledAt.getTime() - offsetDays * 24 * 60 * 60 * 1000),
  }));
}

function parseReminderOffsets(value) {
  try { return normalizeReminderOffsets(JSON.parse(value)); } catch (_) { return [...DEFAULT_REMINDER_OFFSETS_DAYS]; }
}

module.exports = {
  DEFAULT_REMINDER_OFFSETS_DAYS,
  addMonthsClamped,
  normalizeRecurrence,
  normalizeReminderOffsets,
  buildReminderSchedule,
  parseReminderOffsets,
};
