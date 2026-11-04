'use strict';
/**
 * Decimal-safe money helpers. All arithmetic is done in INTEGER CENTS so no
 * floating-point rounding can leak into totals. Database columns are
 * Decimal(12,2); legacy columns (orders, POS, invoices) are Float and are
 * converted once, at the read boundary, with legacyToCents().
 */
const MAX_CENTS = 999999999999; // 9,999,999,999.99 — fits Decimal(12,2) and Number.MAX_SAFE_INTEGER
const STRICT = /^\d{1,10}(\.\d{1,2})?$/;

/** Strict parse of API input ("12.50", 12.5) → integer cents. Throws RangeError on bad input. */
function parseMoney(value) {
  if (value === null || value === undefined || value === '') throw new RangeError('Amount is required');
  const text = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : String(value).trim();
  if (!STRICT.test(text)) throw new RangeError('Amount must be a positive number with at most 2 decimal places');
  const [whole, frac = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) throw new RangeError('Amount is too large');
  return cents;
}

/** Read a stored value (Prisma Decimal, string or Float) → integer cents, rounding half away from zero. */
function toCents(value) {
  if (value === null || value === undefined) return 0;
  const n = Number(typeof value === 'object' && typeof value.toString === 'function' ? value.toString() : value);
  if (!Number.isFinite(n)) return 0;
  return Math.sign(n) * Math.round(Math.abs(n) * 100 + 1e-9);
}
const legacyToCents = toCents;

/** Integer cents → "1234.56" (exact string, safe to hand to a Decimal column or JSON). */
function fromCents(cents) {
  const c = Math.round(Number(cents) || 0);
  const sign = c < 0 ? '-' : '';
  const abs = Math.abs(c);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

const sumCents = (list) => list.reduce((s, c) => s + c, 0);

module.exports = { MAX_CENTS, parseMoney, toCents, legacyToCents, fromCents, sumCents };
