'use strict';
/**
 * Reporting periods in America/Port_of_Spain (UTC-4 all year; Trinidad & Tobago
 * does not observe daylight saving). "Today" and "this month" therefore roll
 * over at local midnight, not at UTC midnight.
 */
const TIMEZONE = 'America/Port_of_Spain';
const OFFSET_MS = -4 * 3600 * 1000;
const DAY_MS = 86400000;

function localParts(date) {
  const d = new Date(date.getTime() + OFFSET_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), dow: d.getUTCDay() };
}
/** UTC instant of local midnight for a local calendar date. */
const localMidnight = (y, m, d) => new Date(Date.UTC(y, m, d) - OFFSET_MS);
const pad = (n) => String(n).padStart(2, '0');

const monthKey = (date) => { const p = localParts(new Date(date)); return `${p.y}-${pad(p.m + 1)}`; };
const dayKey = (date) => { const p = localParts(new Date(date)); return `${p.y}-${pad(p.m + 1)}-${pad(p.d)}`; };

/** 'YYYY-MM-DD' → local midnight (UTC instant). Throws RangeError for invalid dates. */
function parseLocalDate(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || ''));
  if (!m) throw new RangeError('Dates must be formatted YYYY-MM-DD');
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  const check = new Date(Date.UTC(y, mo, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo || check.getUTCDate() !== d) throw new RangeError('Invalid calendar date');
  return localMidnight(y, mo, d);
}

const PERIODS = ['today', 'week', 'month', 'last_month', 'year', 'custom', 'all'];

/** Returns { from, to (EXCLUSIVE), label } as UTC Dates for a named period. */
function periodRange(period = 'month', { now = new Date(), from, to } = {}) {
  const p = localParts(now);
  switch (period) {
    case 'today': { const f = localMidnight(p.y, p.m, p.d); return { from: f, to: new Date(f.getTime() + DAY_MS), label: 'Today' }; }
    case 'week': { const back = (p.dow + 6) % 7; const f = localMidnight(p.y, p.m, p.d - back); return { from: f, to: new Date(f.getTime() + 7 * DAY_MS), label: 'This week' }; }
    case 'month': return { from: localMidnight(p.y, p.m, 1), to: localMidnight(p.y, p.m + 1, 1), label: 'This month' };
    case 'last_month': return { from: localMidnight(p.y, p.m - 1, 1), to: localMidnight(p.y, p.m, 1), label: 'Last month' };
    case 'year': return { from: localMidnight(p.y, 0, 1), to: localMidnight(p.y + 1, 0, 1), label: 'This year' };
    case 'all': return { from: new Date(0), to: localMidnight(p.y, p.m, p.d + 1), label: 'All time' };
    case 'custom': {
      if (!from || !to) throw new RangeError('A custom range needs both from and to dates');
      const f = parseLocalDate(from);
      const t = new Date(parseLocalDate(to).getTime() + DAY_MS); // `to` is inclusive for humans
      if (t <= f) throw new RangeError('The end date must not be before the start date');
      if (t - f > 5 * 366 * DAY_MS) throw new RangeError('Custom ranges are limited to 5 years');
      return { from: f, to: t, label: `${from} to ${to}` };
    }
    default: throw new RangeError(`Unknown period "${period}"`);
  }
}

/** Month keys (YYYY-MM) covered by [from, to). */
function monthKeysBetween(from, to) {
  const keys = [];
  const f = localParts(from);
  const last = localParts(new Date(to.getTime() - 1));
  let y = f.y, m = f.m;
  while (y < last.y || (y === last.y && m <= last.m)) {
    keys.push(`${y}-${pad(m + 1)}`);
    if (++m > 11) { m = 0; y++; }
    if (keys.length > 120) break;
  }
  return keys;
}

module.exports = { TIMEZONE, OFFSET_MS, PERIODS, periodRange, parseLocalDate, monthKey, dayKey, monthKeysBetween, localMidnight };
