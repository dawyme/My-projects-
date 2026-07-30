/** Shared UI primitives: escaping, formatting, toasts, modals, tables, charts. */

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

export const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};

export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ------------------------------------------------------------ formatting */
let currency = { code: 'USD', symbol: '$' };
export function setCurrency(c) { if (c) currency = c; }

export function money(n) {
  const value = Number(n || 0);
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.code, maximumFractionDigits: 2 }).format(value);
  } catch {
    return `${currency.symbol}${value.toFixed(2)}`;
  }
}
export const num = (n) => new Intl.NumberFormat().format(Number(n || 0));
export const pct = (n) => `${Number(n || 0) > 0 ? '+' : ''}${Number(n || 0).toFixed(1)}%`;

export function date(d, opts) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString(undefined, opts || { year: 'numeric', month: 'short', day: 'numeric' });
}
export function dateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function relative(d) {
  if (!d) return '';
  const diff = Date.now() - new Date(d).getTime();
  const abs = Math.abs(diff);
  const units = [['year', 31536e6], ['month', 2592e6], ['day', 864e5], ['hour', 36e5], ['minute', 6e4]];
  for (const [unit, ms] of units) {
    if (abs >= ms) {
      const v = Math.round(diff / ms);
      return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-v, unit);
    }
  }
  return 'just now';
}
export const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
export const titleCase = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/* ------------------------------------------------------------ badges */
const STATUS_TONE = {
  PENDING: 'warning', CONFIRMED: 'info', IN_PROGRESS: 'purple', COMPLETED: 'success', CANCELLED: 'danger',
  UNREAD: 'warning', READ: 'info', ARCHIVED: 'muted',
  PAID: 'success', SHIPPED: 'info',
  ADMIN: 'purple', STAFF: 'info',
  LOW: 'muted', NORMAL: 'info', HIGH: 'warning', URGENT: 'danger',
  ok: 'success', low: 'warning', out: 'danger', critical: 'danger', warning: 'warning',
};
export const statusBadge = (status, label) =>
  `<span class="badge badge--${STATUS_TONE[status] || 'muted'}">${esc(label || titleCase(status))}</span>`;

export const trend = (value) => {
  const v = Number(value || 0);
  const tone = v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
  const arrow = v > 0 ? '↑' : v < 0 ? '↓' : '→';
  return `<span class="trend trend--${tone}">${arrow} ${Math.abs(v).toFixed(1)}%</span>`;
};

/* ------------------------------------------------------------ icons */
const ICONS = {
  dashboard: '<path d="M3 13h8V3H3v10Zm0 8h8v-6H3v6Zm10 0h8V11h-8v10Zm0-18v6h8V3h-8Z"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5V8Z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/>',
  chart: '<path d="M3 3v18h18"/><path d="m7 14 4-4 4 4 5-6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.62.68 1.06 1.32 1.06H21a2 2 0 1 1 0 4h-.09c-.64 0-1.18.44-1.32 1.06Z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/>',
  alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4M12 17h.01"/>',
  money: '<circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 6v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  menu: '<path d="M3 12h18M3 6h18M3 18h18"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0 5 5l-9 9a2.8 2.8 0 0 1-4-4l9-9-1 -1Z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  archive: '<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"/>',
  reply: '<path d="M9 17 4 12l5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z"/>',
  refresh: '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
  filter: '<path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3Z"/>',
  tag: '<path d="M20.59 13.41 12 22l-9-9V3h10l7.59 7.59a2 2 0 0 1 0 2.82Z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
};
export const icon = (name, cls = '') =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.box}</svg>`;

/* ------------------------------------------------------------ toasts */
function toastHost() {
  let host = qs('.toasts');
  if (!host) {
    host = el('<div class="toasts" role="status" aria-live="polite"></div>');
    document.body.appendChild(host);
  }
  return host;
}
export function toast(message, type = 'success', title) {
  const titles = { success: 'Success', error: 'Error', warning: 'Warning', info: 'Notice' };
  const node = el(`<div class="toast toast--${type}">
    <div class="toast__body"><div class="toast__title">${esc(title || titles[type] || 'Notice')}</div>
    <div class="toast__msg">${esc(message)}</div></div>
    <button class="toast__close" aria-label="Dismiss notification">&times;</button></div>`);
  node.querySelector('.toast__close').onclick = () => node.remove();
  toastHost().appendChild(node);
  setTimeout(() => node.remove(), type === 'error' ? 7000 : 4200);
}
export const toastError = (e) => toast(e?.message || 'Something went wrong', 'error');

/* ------------------------------------------------------------ modal */
export function modal({ title, body, footer, size = '', onMount }) {
  const backdrop = el(`<div class="modal-backdrop" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal ${size ? `modal--${size}` : ''}">
      <div class="modal__head"><h2>${esc(title)}</h2>
        <button class="icon-btn" data-close style="margin-left:auto" aria-label="Close dialog">${icon('x')}</button></div>
      <div class="modal__body"></div>
      ${footer !== null ? '<div class="modal__foot"></div>' : ''}
    </div></div>`);
  const bodyEl = backdrop.querySelector('.modal__body');
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body);
  const footEl = backdrop.querySelector('.modal__foot');
  if (footEl && footer) footEl.innerHTML = footer;

  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(backdrop);
  setTimeout(() => (backdrop.querySelector('input,select,textarea,button:not([data-close])') || backdrop).focus(), 60);
  const ctx = { root: backdrop, body: bodyEl, footer: footEl, close };
  onMount?.(ctx);
  return ctx;
}

export function confirmDialog({ title = 'Are you sure?', message, confirmLabel = 'Confirm', danger = true }) {
  return new Promise((resolve) => {
    const m = modal({
      title, size: 'sm',
      body: `<p style="margin:0;color:var(--text-muted)">${esc(message)}</p>`,
      footer: `<button class="btn btn--ghost" data-close>Cancel</button>
               <button class="btn ${danger ? 'btn--danger' : 'btn--primary'}" data-confirm>${esc(confirmLabel)}</button>`,
      onMount: ({ root, close }) => {
        root.querySelector('[data-confirm]').onclick = () => { close(); resolve(true); };
        root.addEventListener('click', (e) => { if (e.target.closest('[data-close]') || e.target === root) resolve(false); });
      },
    });
    m.root.addEventListener('keydown', (e) => { if (e.key === 'Escape') resolve(false); });
  });
}

/* ------------------------------------------------------------ misc helpers */
export function debounce(fn, ms = 320) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function skeletonRows(cols, rows = 6) {
  return Array.from({ length: rows }, () =>
    `<tr>${Array.from({ length: cols }, () => '<td><div class="skeleton"></div></td>').join('')}</tr>`).join('');
}

export function emptyState(title, message, actionHtml = '') {
  return `<div class="empty">${icon('inbox')}<h3>${esc(title)}</h3><p>${esc(message)}</p>${actionHtml ? `<div style="margin-top:14px">${actionHtml}</div>` : ''}</div>`;
}

export function pagination(meta, onPage) {
  const wrap = el('<div class="pagination"></div>');
  if (!meta) return wrap;
  const { page, pages, total, limit } = meta;
  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  wrap.appendChild(el(`<span class="pagination__info">Showing ${num(from)}–${num(Math.min(page * limit, total))} of ${num(total)}</span>`));
  const btn = (label, target, opts = {}) => {
    const b = el(`<button class="page-btn" ${opts.disabled ? 'disabled' : ''} ${opts.current ? 'aria-current="true"' : ''} ${opts.label ? `aria-label="${opts.label}"` : ''}>${label}</button>`);
    if (!opts.disabled && !opts.current) b.onclick = () => onPage(target);
    wrap.appendChild(b);
  };
  btn('‹', page - 1, { disabled: page <= 1, label: 'Previous page' });
  const window = [];
  for (let i = 1; i <= pages; i++) {
    if (i === 1 || i === pages || Math.abs(i - page) <= 1) window.push(i);
    else if (window[window.length - 1] !== '…') window.push('…');
  }
  for (const p of window) {
    if (p === '…') wrap.appendChild(el('<span style="color:var(--text-soft);padding:0 3px">…</span>'));
    else btn(String(p), p, { current: p === page, label: `Page ${p}` });
  }
  btn('›', page + 1, { disabled: page >= pages, label: 'Next page' });
  return wrap;
}

/** Serialises a form into a plain object, coercing checkboxes and numbers. */
export function formData(form) {
  const out = {};
  for (const field of form.elements) {
    if (!field.name || field.disabled) continue;
    if (field.type === 'checkbox') out[field.name] = field.checked;
    else if (field.type === 'number') out[field.name] = field.value === '' ? undefined : Number(field.value);
    else out[field.name] = field.value === '' ? undefined : field.value;
  }
  return out;
}

export function showFieldErrors(form, apiError) {
  qsa('.error', form).forEach((n) => n.remove());
  qsa('[aria-invalid]', form).forEach((n) => n.removeAttribute('aria-invalid'));
  const errors = apiError?.fieldErrors || {};
  let first = null;
  for (const [field, message] of Object.entries(errors)) {
    const input = form.elements[field];
    if (!input) continue;
    input.setAttribute('aria-invalid', 'true');
    input.closest('.field')?.appendChild(el(`<span class="error">${esc(message)}</span>`));
    first = first || input;
  }
  first?.focus();
  if (!Object.keys(errors).length && apiError) toastError(apiError);
}

/* ------------------------------------------------------------ charts (dependency-free SVG) */
const PALETTE = ['#0891b2', '#7c3aed', '#059669', '#d97706', '#dc2626', '#2563eb'];

function axisLabels(max) {
  const step = max / 4;
  return Array.from({ length: 5 }, (_, i) => Math.round((max - step * i) * 100) / 100);
}

/** Grouped line chart. series = [{ name, values, color? }] */
export function lineChart(host, { labels, series, formatter = num }) {
  const W = 720, H = 260, pad = { l: 54, r: 14, t: 14, b: 30 };
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const x = (i) => pad.l + (labels.length <= 1 ? iw / 2 : (i * iw) / (labels.length - 1));
  const y = (v) => pad.t + ih - (v / max) * ih;

  const grid = axisLabels(max).map((v, i) => {
    const gy = pad.t + (i * ih) / 4;
    return `<line x1="${pad.l}" y1="${gy}" x2="${W - pad.r}" y2="${gy}" stroke="var(--border)" stroke-width="1"/>
      <text x="${pad.l - 8}" y="${gy + 4}" text-anchor="end" font-size="10" fill="var(--text-soft)">${esc(formatter(v))}</text>`;
  }).join('');

  const step = Math.ceil(labels.length / 12);
  const xLabels = labels.map((l, i) => (i % step === 0
    ? `<text x="${x(i)}" y="${H - 10}" text-anchor="middle" font-size="10" fill="var(--text-soft)">${esc(l)}</text>` : '')).join('');

  const paths = series.map((s, si) => {
    const color = s.color || PALETTE[si % PALETTE.length];
    const pts = s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
    const area = `${pad.l},${pad.t + ih} ${pts} ${x(s.values.length - 1)},${pad.t + ih}`;
    const dots = s.values.map((v, i) =>
      `<circle cx="${x(i)}" cy="${y(v)}" r="3" fill="${color}"><title>${esc(labels[i])}: ${esc(formatter(v))}</title></circle>`).join('');
    return `${si === 0 ? `<polygon points="${area}" fill="${color}" opacity=".08"/>` : ''}
      <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>${dots}`;
  }).join('');

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" role="img"
      aria-label="${esc(series.map((s) => s.name).join(', '))} chart">${grid}${paths}${xLabels}</svg>`;
  return legend(series);
}

/** Grouped/stacked bar chart. */
export function barChart(host, { labels, series, formatter = num }) {
  const W = 720, H = 260, pad = { l: 54, r: 14, t: 14, b: 30 };
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const groupW = iw / labels.length;
  const barW = Math.max(3, (groupW * 0.66) / series.length);

  const grid = axisLabels(max).map((v, i) => {
    const gy = pad.t + (i * ih) / 4;
    return `<line x1="${pad.l}" y1="${gy}" x2="${W - pad.r}" y2="${gy}" stroke="var(--border)"/>
      <text x="${pad.l - 8}" y="${gy + 4}" text-anchor="end" font-size="10" fill="var(--text-soft)">${esc(formatter(v))}</text>`;
  }).join('');

  const bars = labels.map((label, i) => series.map((s, si) => {
    const v = s.values[i] || 0;
    const h = (v / max) * ih;
    const bx = pad.l + i * groupW + (groupW - barW * series.length) / 2 + si * barW;
    const color = s.color || PALETTE[si % PALETTE.length];
    return `<rect x="${bx}" y="${pad.t + ih - h}" width="${barW - 1.5}" height="${Math.max(h, v > 0 ? 2 : 0)}" rx="3" fill="${color}">
      <title>${esc(label)} — ${esc(s.name)}: ${esc(formatter(v))}</title></rect>`;
  }).join('')).join('');

  const step = Math.ceil(labels.length / 12);
  const xLabels = labels.map((l, i) => (i % step === 0
    ? `<text x="${pad.l + i * groupW + groupW / 2}" y="${H - 10}" text-anchor="middle" font-size="10" fill="var(--text-soft)">${esc(l)}</text>` : '')).join('');

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" role="img"
      aria-label="${esc(series.map((s) => s.name).join(', '))} bar chart">${grid}${bars}${xLabels}</svg>`;
  return legend(series);
}

/** Donut chart. data = [{ label, value }] */
export function donutChart(host, data, formatter = num) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const R = 70, r = 44, C = 90;
  if (!total) { host.innerHTML = emptyState('No data yet', 'There is nothing to chart for this period.'); return ''; }
  let angle = -Math.PI / 2;
  const arcs = data.map((d, i) => {
    const slice = (d.value / total) * Math.PI * 2;
    const [x1, y1] = [C + R * Math.cos(angle), C + R * Math.sin(angle)];
    const [x2, y2] = [C + R * Math.cos(angle + slice), C + R * Math.sin(angle + slice)];
    const [ix2, iy2] = [C + r * Math.cos(angle + slice), C + r * Math.sin(angle + slice)];
    const [ix1, iy1] = [C + r * Math.cos(angle), C + r * Math.sin(angle)];
    const large = slice > Math.PI ? 1 : 0;
    angle += slice;
    return `<path d="M${x1},${y1} A${R},${R} 0 ${large} 1 ${x2},${y2} L${ix2},${iy2} A${r},${r} 0 ${large} 0 ${ix1},${iy1} Z"
      fill="${PALETTE[i % PALETTE.length]}"><title>${esc(d.label)}: ${esc(formatter(d.value))} (${((d.value / total) * 100).toFixed(1)}%)</title></path>`;
  }).join('');
  host.innerHTML = `<svg viewBox="0 0 180 180" width="100%" height="100%" role="img" aria-label="Distribution chart">
    ${arcs}<text x="90" y="86" text-anchor="middle" font-size="13" font-weight="700" fill="var(--text)">${esc(formatter(total))}</text>
    <text x="90" y="102" text-anchor="middle" font-size="9" fill="var(--text-soft)">TOTAL</text></svg>`;
  return legend(data.map((d, i) => ({ name: `${d.label} (${formatter(d.value)})`, color: PALETTE[i % PALETTE.length] })));
}

function legend(series) {
  return `<div class="legend">${series.map((s, i) =>
    `<span><i style="background:${s.color || PALETTE[i % PALETTE.length]}"></i>${esc(s.name)}</span>`).join('')}</div>`;
}
