/**
 * CSV parsing for supplier catalogue feeds.
 *
 * Hand-rolled (no new dependency) and deliberately strict:
 *   • RFC 4180 quoting — embedded delimiters, newlines and escaped quotes
 *   • BOM stripping and CRLF/LF tolerance
 *   • delimiter sniffing (, ; TAB |) from the header row
 *   • hard caps on size, rows and cell length
 *   • CSV/formula-injection neutralisation on every emitted cell so a hostile
 *     feed can never land `=cmd|…` or `@SUM(…)` in a spreadsheet an operator
 *     later opens, and can never smuggle markup into the admin UI
 */

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB per feed file
const MAX_ROWS = 50000;
const MAX_CELL = 20000;

class CsvError extends Error {
  constructor(message, code = 'CSV_ERROR') { super(message); this.name = 'CsvError'; this.code = code; }
}

const CANDIDATES = [',', ';', '\t', '|'];

const PLAIN_NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

/** Neutralises spreadsheet formula injection and strips control characters. */
function sanitizeCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .slice(0, MAX_CELL);
  const trimmed = s.replace(/^[\s\t\r]+/, '');
  // A leading = + @ (or - that is not a plain number) makes a spreadsheet
  // evaluate the cell. Prefixing with an apostrophe keeps the text readable.
  if (/^[=+@]/.test(trimmed) || (/^-/.test(trimmed) && !PLAIN_NUMBER.test(trimmed))) {
    s = `'${s}`;
  }
  return s;
}

function detectDelimiter(headerLine) {
  let inQuotes = false;
  const counts = Object.fromEntries(CANDIDATES.map((d) => [d, 0]));
  for (const ch of headerLine) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (inQuotes) continue;
    if (counts[ch] !== undefined) counts[ch]++;
  }
  const best = CANDIDATES.map((d) => ({ d, n: counts[d] })).reduce((a, b) => (b.n > a.n ? b : a), { d: ',', n: 0 });
  return best.n > 0 ? best.d : ',';
}

/** Returns the text of the first (header) line, respecting quotes. */
function firstLine(src) {
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (inQuotes) continue;
    if (ch === '\n') return src.slice(0, i);
    if (ch === '\r') return src.slice(0, i);
  }
  return src;
}

/**
 * Parses CSV text into an array of row arrays.
 * @returns {{rows:string[][], delimiter:string, truncated:boolean}}
 */
function parseCsv(input, { delimiter, maxRows = MAX_ROWS } = {}) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input ?? '');
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
    throw new CsvError(`CSV feed exceeds the ${MAX_BYTES / 1024 / 1024} MB limit`, 'TOO_LARGE');
  }
  const src = text.replace(/^\uFEFF/, '');
  const d = delimiter || detectDelimiter(firstLine(src));

  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  let truncated = false;

  const pushRow = () => {
    row.push(field);
    field = '';
    if (row.some((c) => c !== '') || row.length > 1) {
      if (rows.length >= maxRows) { truncated = true; return false; }
      rows.push(row);
    }
    row = [];
    return true;
  };

  for (let i = 0; i < src.length && !truncated; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else { field += ch; }
      continue;
    }
    if (ch === '"' && field === '') { inQuotes = true; continue; }
    if (ch === d) { row.push(field); field = ''; continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      if (!pushRow()) break;
      continue;
    }
    field += ch;
  }
  if (inQuotes) throw new CsvError('Unterminated quoted field in CSV feed', 'MALFORMED');
  if (!truncated && (field !== '' || row.length)) pushRow();

  return { rows: rows.map((r) => r.map(sanitizeCell)), delimiter: d, truncated };
}

/**
 * Converts CSV text into an array of objects keyed by the header row.
 * Duplicate headers are de-duplicated with a numeric suffix.
 */
function parseCsvObjects(input, options = {}) {
  const { rows, delimiter, truncated } = parseCsv(input, options);
  if (!rows.length) return { records: [], headers: [], delimiter, truncated };
  const seen = new Map();
  const headers = rows[0].map((h, i) => {
    const key = String(h).trim() || `column_${i + 1}`;
    const n = seen.get(key) || 0;
    seen.set(key, n + 1);
    return n ? `${key}_${n + 1}` : key;
  });
  const records = rows.slice(1).map((cells) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = cells[i] === undefined ? '' : cells[i]; });
    return obj;
  });
  return { records, headers, delimiter, truncated };
}

/** Best-effort header → canonical field matching, for the mapping UI. */
const ALIASES = {
  supplierSku: ['sku', 'supplier_sku', 'suppliersku', 'part_number', 'partnumber', 'item', 'item_no', 'itemno', 'product_code', 'code'],
  manufacturerPart: ['mpn', 'manufacturer_part', 'manufacturerpart', 'mfg_part', 'oem', 'oem_number', 'part'],
  upc: ['upc', 'ean', 'gtin', 'barcode', 'isbn'],
  name: ['name', 'title', 'product', 'product_name', 'productname', 'description_short', 'short_description'],
  description: ['description', 'desc', 'long_description', 'details', 'product_description'],
  brand: ['brand', 'manufacturer', 'vendor', 'make'],
  category: ['category', 'cat', 'group', 'product_group', 'productgroup', 'type', 'department'],
  supplierCost: ['cost', 'price', 'cost_price', 'costprice', 'your_price', 'wholesale', 'wholesale_price', 'net_price', 'unit_cost'],
  msrp: ['msrp', 'list_price', 'listprice', 'retail', 'retail_price', 'rrp', 'srp', 'map'],
  currency: ['currency', 'cur', 'currency_code'],
  stock: ['stock', 'qty', 'quantity', 'on_hand', 'onhand', 'available', 'inventory', 'stock_qty'],
  stockStatus: ['stock_status', 'availability', 'stockstatus', 'status'],
  imageUrl: ['image', 'image_url', 'imageurl', 'img', 'photo', 'picture', 'main_image'],
  gallery: ['images', 'gallery', 'additional_images'],
  weightKg: ['weight', 'weight_kg', 'weightkg', 'gross_weight'],
  lengthCm: ['length', 'length_cm', 'depth'],
  widthCm: ['width', 'width_cm'],
  heightCm: ['height', 'height_cm'],
  restricted: ['restricted', 'hazmat', 'hazardous', 'dangerous_goods'],
  restrictionType: ['restriction_type', 'hazmat_class', 'danger_class'],
  allowedCountries: ['allowed_countries', 'ship_to', 'countries'],
  blockedCountries: ['blocked_countries', 'excluded_countries'],
  allowedShippingMethods: ['shipping_methods', 'allowed_shipping'],
};

const normaliseHeader = (h) => String(h).toLowerCase().replace(/[\s\-]+/g, '_').replace(/[^a-z0-9_]/g, '');

/** Guesses a column map from the feed's headers. */
function guessColumnMap(headers = []) {
  const map = {};
  for (const [field, aliases] of Object.entries(ALIASES)) {
    const exact = headers.find((h) => normaliseHeader(h) === field.toLowerCase() || aliases.includes(normaliseHeader(h)));
    if (exact) map[field] = exact;
  }
  return map;
}

/** RFC 4180 serialisation, used for the "download errors" export. */
function toCsv(rows, columns) {
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = v instanceof Date ? v.toISOString() : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => cell(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => cell(typeof c.value === 'function' ? c.value(r) : r[c.value])).join(',')).join('\n');
  return `${head}\n${body}\n`;
}

module.exports = {
  parseCsv, parseCsvObjects, guessColumnMap, sanitizeCell, toCsv,
  detectDelimiter, CsvError, MAX_BYTES, MAX_ROWS, ALIASES,
};
