/**
 * Calendar & Scheduling foundation (Phase C) — validation rules.
 *
 * The pure functions in this module are the single source of truth for
 * appointment availability: duration resolution, occupied-window computation
 * and every conflict/availability check (technician overlap, approved
 * time-off, working hours, breaks, closed days, lead time and booking
 * window). They perform no I/O so they can be unit tested directly; the
 * async `loadSchedulingContext` at the bottom is a thin Prisma loader used by
 * the API routes.
 *
 * Time conventions (consistent with the rest of the app, which renders the
 * calendar in UTC): weekdays are ISO 1 = Monday … 7 = Sunday; "HH:mm" strings
 * are 24-hour; business hours come from the tenant's `hours` Setting
 * (e.g. "08:00-17:00" or "Closed") and can be overridden per technician by
 * `WorkingHours` rows.
 *
 * Policy (per-business `Setting` key "scheduling", see the Settings section):
 *   conflictPolicy     "warn" (default) | "block"
 *   minLeadHours       minimum hours between now and the start (0 = off)
 *   maxBookingDays     furthest allowed start date in days (0 = off)
 *   strictWorkingHours false (default) | true — promotes working-hours,
 *                      break and closed-day violations to blocking conflicts
 * Defaults are deliberately no-ops so existing tenants and flows keep
 * working until they opt in.
 */

const prisma = require('./prisma');

const DAY_NAME = { 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday', 7: 'Sunday' };

/** Effective appointment duration in minutes: booking override → service → 60. */
function effectiveDurationMin(booking = {}, service = null) {
  if (Number.isFinite(booking.durationMin) && booking.durationMin > 0) return booking.durationMin;
  if (service && Number.isFinite(service.durationMin) && service.durationMin > 0) return service.durationMin;
  return 60;
}

/**
 * Occupied window for a technician: [start - buffer, start + duration].
 * The buffer is travel/changeover time before the appointment.
 */
function occupiedWindow(start, durationMin, bufferMin = 0) {
  const s = new Date(start);
  const buffer = Number.isFinite(bufferMin) && bufferMin > 0 ? bufferMin : 0;
  const duration = Number.isFinite(durationMin) && durationMin > 0 ? durationMin : 60;
  return { start: new Date(s.getTime() - buffer * 60000), end: new Date(s.getTime() + duration * 60000) };
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/** ISO weekday 1 = Monday … 7 = Sunday (UTC). */
function dayOfDate(date) {
  const d = new Date(date);
  return ((d.getUTCDay() + 6) % 7) + 1;
}

/** UTC "YYYY-MM-DD" key. */
function dateKey(date) {
  return new Date(date).toISOString().slice(0, 10);
}

/** Parses "HH:mm-HH:mm" (or "HH:MM–HH:MM") → { startMin, endMin } | null. "Closed"/"" → null. */
function parseDayHours(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || /^closed$/i.test(trimmed)) return null;
  const m = trimmed.match(/^(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const startMin = Number(m[1]) * 60 + Number(m[2]);
  const endMin = Number(m[3]) * 60 + Number(m[4]);
  if (startMin >= endMin) return null;
  return { startMin, endMin };
}

/** Parses a validated "HH:mm" → minutes since UTC midnight. */
function parseHhMm(value) {
  const m = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes < 1440 ? minutes : null;
}

function resolveSchedulingPolicy(stored) {
  const policy = { conflictPolicy: 'warn', minLeadHours: 0, maxBookingDays: 0, strictWorkingHours: false };
  if (!stored || typeof stored !== 'object') return policy;
  if (stored.conflictPolicy === 'block' || stored.conflictPolicy === 'warn') policy.conflictPolicy = stored.conflictPolicy;
  if (Number.isFinite(stored.minLeadHours) && stored.minLeadHours >= 0) policy.minLeadHours = stored.minLeadHours;
  if (Number.isFinite(stored.maxBookingDays) && stored.maxBookingDays >= 0) policy.maxBookingDays = stored.maxBookingDays;
  if (stored.strictWorkingHours === true) policy.strictWorkingHours = true;
  return policy;
}

/**
 * Technician double-booking: non-cancelled bookings of the same technician
 * whose occupied windows overlap. `bookings` rows must carry
 * { id, reference, scheduledAt, status, service: { durationMin } | null }.
 */
function checkTechnicianConflicts({ start, end, technicianId, ignoreBookingId, bookings = [] }) {
  if (!technicianId) return [];
  const conflicts = [];
  for (const b of bookings) {
    if (!technicianId || b.technicianId !== technicianId) continue;
    if (b.status === 'CANCELLED') continue;
    if (ignoreBookingId && b.id === ignoreBookingId) continue;
    const window = occupiedWindow(b.scheduledAt, effectiveDurationMin(b, b.service), b.bufferMin);
    if (overlaps(start, end, window.start, window.end)) {
      conflicts.push({
        type: 'technician-overlap',
        bookingId: b.id,
        reference: b.reference,
        message: `Technician already booked for ${b.reference} on ${dateKey(b.scheduledAt)} (${new Date(b.scheduledAt).toISOString().slice(11, 16)})`,
      });
    }
  }
  return conflicts;
}

/** Overlap with APPROVED time off for the technician. */
function checkTimeOffConflicts({ start, end, technicianId, timeOffs = [] }) {
  if (!technicianId) return [];
  const conflicts = [];
  for (const t of timeOffs) {
    if (t.userId !== technicianId) continue;
    if (t.status !== 'APPROVED') continue;
    if (overlaps(start, end, t.startsAt, t.endsAt)) {
      conflicts.push({
        type: 'time-off',
        timeOffId: t.id,
        message: `Technician has approved time off from ${new Date(t.startsAt).toISOString().slice(0, 16).replace('T', ' ')} to ${new Date(t.endsAt).toISOString().slice(0, 16).replace('T', ' ')}${t.reason ? ` (${t.reason})` : ''}`,
      });
    }
  }
  return conflicts;
}

/**
 * Working-hours violations. `hoursByDay` maps ISO weekday 1-7 →
 * { startMin, endMin } | null (null = no defined hours for that day).
 * When no day in the span has defined hours, there is no constraint.
 */
function checkWorkingHours(start, end, hoursByDay = {}) {
  const warnings = [];
  const [s, e] = [new Date(start), new Date(end)];
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || s >= e) return warnings;
  let cursor = new Date(s);
  while (cursor < e) {
    const day = dayOfDate(cursor);
    const dayStart = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate()));
    const dayEnd = new Date(dayStart.getTime() + 864e5);
    const from = cursor > dayStart ? cursor : dayStart;
    const to = e < dayEnd ? e : dayEnd;
    const hours = hoursByDay[day] || null;
    if (hours && (to > from)) {
      const openAt = new Date(dayStart.getTime() + hours.startMin * 60000);
      const closeAt = new Date(dayStart.getTime() + hours.endMin * 60000);
      const inside = overlaps(from, to, openAt, closeAt);
      const fullyInside = from >= openAt && to <= closeAt;
      if (!fullyInside) {
        warnings.push({
          type: 'working-hours',
          day,
          message: `Outside ${DAY_NAME[day]} working hours (${fmtMin(hours.startMin)}–${fmtMin(hours.endMin)})`,
          inside,
        });
      }
    }
    cursor = dayEnd;
  }
  return warnings;
}

/** Break-period violations: `breaksByDay` maps ISO weekday 1-7 → [{ startMin, endMin }]. */
function checkBreaks(start, end, breaksByDay = {}) {
  const warnings = [];
  const [s, e] = [new Date(start), new Date(end)];
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || s >= e) return warnings;
  let cursor = new Date(s);
  while (cursor < e) {
    const day = dayOfDate(cursor);
    const dayStart = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate()));
    const dayEnd = new Date(dayStart.getTime() + 864e5);
    const from = cursor > dayStart ? cursor : dayStart;
    const to = e < dayEnd ? e : dayEnd;
    for (const brk of breaksByDay[day] || []) {
      const openAt = new Date(dayStart.getTime() + brk.startMin * 60000);
      const closeAt = new Date(dayStart.getTime() + brk.endMin * 60000);
      if (overlaps(from, to, openAt, closeAt)) {
        warnings.push({ type: 'break', day, message: `Overlaps the scheduled break ${fmtMin(brk.startMin)}–${fmtMin(brk.endMin)} on ${DAY_NAME[day]}` });
      }
    }
    cursor = dayEnd;
  }
  return warnings;
}

/** `closedDays` is a list of UTC-midnight Dates; an appointment touching one is a violation. */
function checkClosedDays(start, end, closedDays = []) {
  const warnings = [];
  const [s, e] = [new Date(start), new Date(end)];
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || s >= e) return warnings;
  for (const cd of closedDays) {
    const dayStart = new Date(Date.UTC(cd.getUTCFullYear(), cd.getUTCMonth(), cd.getUTCDate()));
    const dayEnd = new Date(dayStart.getTime() + 864e5);
    if (overlaps(s, e, dayStart, dayEnd)) {
      warnings.push({ type: 'closed-day', date: dateKey(dayStart), reason: cd.reason || null, message: `The business is closed on ${dateKey(dayStart)}${cd.reason ? ` (${cd.reason})` : ''}` });
    }
  }
  return warnings;
}

/** Min lead time / max booking window. Returns conflicts (policy-sensitive). */
function checkLeadTimeWindow(start, now, { minLeadHours = 0, maxBookingDays = 0 } = {}) {
  const conflicts = [];
  const s = new Date(start);
  const n = new Date(now);
  if (Number.isNaN(s.getTime())) return conflicts;
  if (minLeadHours > 0) {
    const minStart = new Date(n.getTime() + minLeadHours * 3600000);
    if (s < minStart) conflicts.push({ type: 'lead-time', message: `Minimum lead time is ${minLeadHours}h — the earliest start is ${minStart.toISOString().slice(0, 16).replace('T', ' ')}` });
  }
  if (maxBookingDays > 0) {
    const maxStart = new Date(n.getTime() + maxBookingDays * 864e5);
    if (s > maxStart) conflicts.push({ type: 'booking-window', message: `Bookings are accepted up to ${maxBookingDays} days ahead — the latest start is ${dateKey(maxStart)}` });
  }
  return conflicts;
}

/**
 * Applies the business policy to a raw conflicts/warnings set.
 * Returns { conflicts, warnings, blocked } where `blocked` is true when the
 * policy says the request must be rejected.
 */
function applyPolicy({ conflicts = [], warnings = [], policy }) {
  const p = resolveSchedulingPolicy(policy);
  const hardConflicts = [...conflicts];
  if (p.strictWorkingHours) {
    for (const w of warnings) hardConflicts.push({ type: w.type, ...w, promoted: true });
  }
  const effectiveWarnings = p.strictWorkingHours
    ? warnings.filter((w) => !['working-hours', 'break', 'closed-day'].includes(w.type))
    : warnings;
  return {
    conflicts: hardConflicts,
    warnings: effectiveWarnings,
    blocked: p.conflictPolicy === 'block' && hardConflicts.length > 0,
  };
}

function fmtMin(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/** Hard data validation: throws Error with a useful message. */
function validateAppointmentTimes({ scheduledAt, durationMin, bufferMin, now = new Date() }) {
  const start = new Date(scheduledAt);
  if (Number.isNaN(start.getTime())) throw new Error('scheduledAt must be a valid date');
  if (durationMin !== undefined && durationMin !== null) {
    const d = Number(durationMin);
    if (!Number.isInteger(d) || d < 5 || d > 1440) throw new Error('durationMin must be an integer between 5 and 1440 minutes');
  }
  if (bufferMin !== undefined && bufferMin !== null) {
    const b = Number(bufferMin);
    if (!Number.isInteger(b) || b < 0 || b > 480) throw new Error('bufferMin must be an integer between 0 and 480 minutes');
  }
  // Note: past dates are deliberately NOT rejected — dispatch boards and
  // field crews legitimately record or reschedule past visits.
  return { start };
}

/**
 * Loads everything a conflict check needs for one tenant + technician +
 * time range: tenant bookings in the window, technician working hours,
 * business default hours (from the `hours` Setting), approved time off,
 * breaks and closed days, plus the tenant scheduling policy.
 */
async function loadSchedulingContext({ businessId, technicianId, from, to }) {
  const since = new Date(from.getTime() - 864e5);
  const until = new Date(to.getTime() + 864e5);
  const [bookings, workingHours, timeOffs, breaks, closedDays, hoursSetting, policySetting] = await Promise.all([
    prisma.booking.findMany({
      where: { businessId, scheduledAt: { gte: since, lte: until }, status: { not: 'CANCELLED' } },
      select: { id: true, reference: true, scheduledAt: true, status: true, technicianId: true, durationMin: true, bufferMin: true, service: { select: { durationMin: true } } },
    }),
    technicianId ? prisma.workingHours.findMany({ where: { businessId, userId: technicianId } }) : [],
    technicianId ? prisma.timeOff.findMany({ where: { businessId, userId: technicianId, startsAt: { lt: until }, endsAt: { gt: since }, status: 'APPROVED' } }) : [],
    prisma.breakPeriod.findMany({ where: { businessId, OR: [{ userId: null }, ...(technicianId ? [{ userId: technicianId }] : [])] } }),
    prisma.closedDay.findMany({ where: { businessId, date: { gte: new Date(since), lte: new Date(until) } } }),
    prisma.setting.findUnique({ where: { businessId_key: { businessId, key: 'hours' } } }),
    prisma.setting.findUnique({ where: { businessId_key: { businessId, key: 'scheduling' } } }),
  ]);

  // Business default hours (Settings `hours`), merged with technician
  // overrides (WorkingHours wins per day).
  let businessHours = {};
  let policyValue = null;
  try { businessHours = hoursSetting ? JSON.parse(hoursSetting.value) : {}; } catch (_) { businessHours = {}; }
  try { policyValue = policySetting ? JSON.parse(policySetting.value) : null; } catch (_) { policyValue = null; }
  const DAY_KEY = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const hoursByDay = {};
  for (let day = 1; day <= 7; day++) {
    hoursByDay[day] = parseDayHours(businessHours[DAY_KEY[day - 1]]);
  }
  for (const wh of workingHours) {
    if (wh.day >= 1 && wh.day <= 7) hoursByDay[wh.day] = parseDayHours(`${wh.start}-${wh.end}`);
  }
  const breaksByDay = {};
  for (const b of breaks) {
    if (b.day < 1 || b.day > 7) continue;
    (breaksByDay[b.day] = breaksByDay[b.day] || []).push({ startMin: parseHhMm(b.start), endMin: parseHhMm(b.end) });
  }
  for (const day of Object.keys(breaksByDay)) {
    breaksByDay[day] = breaksByDay[day].filter((b) => b.startMin !== null && b.endMin !== null);
    if (!breaksByDay[day].length) delete breaksByDay[day];
  }

  return {
    bookings,
    workingHours,
    timeOffs,
    hoursByDay,
    breaksByDay,
    closedDays: closedDays.map((c) => c.date),
    policy: resolveSchedulingPolicy(policyValue),
  };
}

module.exports = {
  DAY_NAME,
  effectiveDurationMin,
  occupiedWindow,
  overlaps,
  dayOfDate,
  dateKey,
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
  loadSchedulingContext,
};
