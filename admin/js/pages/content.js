/**
 * Website Content Manager — edit every editable website page, section and
 * collection from the admin dashboard. Supports publish / draft, autosave,
 * image upload, rich text editing and live preview.
 */
import { api, auth } from '../api.js';
import { setTitle } from '../layout.js';
import {
  el, qs, qsa, icon, esc, dateTime, modal, toast, toastError,
  confirmDialog, debounce, emptyState, pagination,
} from '../ui.js';

const MODULES = [
  { key: 'homepage', label: 'Homepage', icon: 'dashboard' },
  { key: 'about', label: 'About Us', icon: 'users' },
  { key: 'services', label: 'Services', icon: 'wrench' },
  { key: 'products-home', label: 'Products Home', icon: 'box' },
  { key: 'gallery', label: 'Gallery', icon: 'image' },
  { key: 'testimonials', label: 'Testimonials', icon: 'inbox' },
  { key: 'faq', label: 'FAQ', icon: 'tag' },
  { key: 'contact', label: 'Contact Info', icon: 'mail' },
  { key: 'hours', label: 'Business Hours', icon: 'clock' },
  { key: 'emergency', label: 'Emergency Banner', icon: 'alert' },
  { key: 'promotions', label: 'Promotions', icon: 'money' },
  { key: 'footer', label: 'Footer', icon: 'file' },
  { key: 'seo', label: 'SEO', icon: 'chart' },
  { key: 'social', label: 'Social Media', icon: 'share' },
  { key: 'logo', label: 'Logo Manager', icon: 'tag' },
  { key: 'banners', label: 'Banner / Image', icon: 'eye' },
];

const ICON_EXTRA = { image: 'M3 5h18v14H3z', share: 'M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8.6 13.5l6.8 4M15.4 6.5l-6.8 4' };

// Fields rendered with the rich-text editor (HTML).
const RICH_KEYS = new Set(['description', 'body', 'answer', 'intro', 'mission', 'vision', 'about', 'content', 'text']);
const TEXTAREA_KEYS = new Set(['subtitle', 'review', 'bio', 'address']);

const COLLECTION_TABS = { services: 'services', gallery: 'gallery', testimonials: 'testimonials', faq: 'faqs', promotions: 'promotions', about: 'team' };

let currentTab = 'homepage';
let state = null; // { pageKey, content, status, seo }

/* ============================================================ helpers */

function fieldId() { return `f-${Math.random().toString(36).slice(2, 8)}`; }

function buildRichEditor(initial = '') {
  const id = fieldId();
  const wrap = el(`<div class="rte">
    <div class="rte__toolbar" role="toolbar" aria-label="Formatting toolbar">
      <button type="button" data-cmd="bold" aria-label="Bold"><b>B</b></button>
      <button type="button" data-cmd="italic" aria-label="Italic"><i>I</i></button>
      <button type="button" data-cmd="underline" aria-label="Underline"><u>U</u></button>
      <button type="button" data-cmd="insertUnorderedList" aria-label="Bullet list">&#8226; List</button>
      <button type="button" data-cmd="insertOrderedList" aria-label="Numbered list">1. List</button>
      <button type="button" data-cmd="createLink" aria-label="Insert link">Link</button>
    </div>
    <div class="rte__editor" id="${id}" contenteditable="true" data-path data-html placeholder="Type here…">${initial}</div>
  </div>`);
  wrap.querySelectorAll('[data-cmd]').forEach((btn) => {
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      const editor = wrap.querySelector('.rte__editor');
      editor.focus();
      const cmd = btn.dataset.cmd;
      if (cmd === 'createLink') {
        const url = prompt('Enter link URL (https://…)');
        if (url) document.execCommand('createLink', false, url);
      } else {
        document.execCommand(cmd);
      }
    });
  });
  return wrap;
}

/** Renders a single content field and returns markup (paths use dot notation). */
function renderField(path, key, value) {
  const id = fieldId();
  const isRich = RICH_KEYS.has(key);
  const isTextarea = TEXTAREA_KEYS.has(key) || (typeof value === 'string' && value.length > 120);
  const label = esc(key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()));
  const hint = `data-path="${path}"`;
  if (typeof value === 'boolean') {
    return `<label class="checkline"><input type="checkbox" ${hint} ${value ? 'checked' : ''}> ${label}</label>`;
  }
  if (typeof value === 'number') {
    return `<div class="field"><label for="${id}">${label}</label><input id="${id}" type="number" ${hint} value="${esc(String(value))}"></div>`;
  }
  if (typeof value === 'string') {
    if (isRich) {
      return `<div class="field"><label for="${id}">${label}</label>${buildRichEditor(value).outerHTML}</div>`;
    }
    if (isTextarea) {
      return `<div class="field"><label for="${id}">${label}</label><textarea id="${id}" rows="4" ${hint}>${esc(value)}</textarea></div>`;
    }
    return `<div class="field"><label for="${id}">${label}</label><input id="${id}" type="text" ${hint} value="${esc(value)}"></div>`;
  }
  if (Array.isArray(value)) {
    // array of primitives
    if (!value.length || value.every((v) => typeof v !== 'object')) {
      return `<div class="field"><label>${label}</label><div class="list-editor" data-path="${path}">
        ${value.map((v, i) => `<div class="list-row"><input type="text" data-path="${path}.${i}" value="${esc(String(v))}">
          <button type="button" class="icon-btn list-remove" aria-label="Remove item">${icon('trash')}</button></div>`).join('')}
        <button type="button" class="btn btn--ghost list-add">${icon('plus')} Add ${label.toLowerCase()}</button></div></div>`;
    }
    // array of objects
    return `<div class="field"><label>${label}</label><div class="list-editor" data-path="${path}">
      ${value.map((obj, i) => `<div class="list-card" data-path="${path}.${i}">
        <div class="list-card__head"><span>${esc(key)} item ${i + 1}</span>
        <button type="button" class="icon-btn list-remove" aria-label="Remove item">${icon('trash')}</button></div>
        <div class="list-card__body">${Object.entries(obj).map(([k, v]) => renderField(`${path}.${i}.${k}`, k, v)).join('')}</div>
      </div>`).join('')}
      <button type="button" class="btn btn--ghost list-add">${icon('plus')} Add ${label.toLowerCase()}</button></div></div>`;
  }
  if (value && typeof value === 'object') {
    const inner = Object.entries(value).map(([k, v]) => renderField(`${path}.${k}`, k, v)).join('');
    return `<div class="field field--group"><label class="field--group__label">${label}</label><div class="field--group__body">${inner}</div></div>`;
  }
  return '';
}

function renderEmptySchema() {
  // A fresh empty object renders a single grouped field so forms are never blank.
  return `<div class="field field--group"><label class="field--group__label">Content</label><div class="field--group__body"></div></div>`;
}

/** Reconstructs a nested object from all [data-path] elements in a root. */
function readForm(root) {
  const out = {};
  qsa('[data-path]', root).forEach((node) => {
    const segs = node.dataset.path.split('.');
    let cur = out;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i];
      const nextIsIdx = /^\d+$/.test(segs[i + 1]);
      if (nextIsIdx && !Array.isArray(cur[seg])) cur[seg] = [];
      if (!Array.isArray(cur[seg]) && typeof cur[seg] !== 'object') cur[seg] = {};
      cur = cur[seg];
    }
    const leaf = segs[segs.length - 1];
    let val;
    if (node.type === 'checkbox') val = node.checked;
    else if (node.type === 'number') val = node.value === '' ? undefined : Number(node.value);
    else if (node.dataset && node.dataset.html !== undefined && node.getAttribute('contenteditable') === 'true') val = node.innerHTML;
    else val = node.value === '' ? '' : node.value;
    cur[leaf] = val;
  });
  return out;
}

/* ============================================================ page editor */

async function renderPageEditor(panel, pageKey) {
  let data;
  try { data = (await api.get(`/content/${pageKey}`)).data; }
  catch (e) { panel.innerHTML = `<div class="card__body">${emptyState('Could not load this page', e.message)}</div>`; return; }

  state = { pageKey, content: data.content, status: data.status, seo: data.seo || {} };

  const readOnly = !auth.isAdmin;
  const statusBadge = `<span class="badge badge--${data.status === 'PUBLISHED' ? 'success' : 'warning'}">${data.status}</span>`;

  panel.innerHTML = `
    <div class="card__head" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">${esc(data.title)}</h2> ${statusBadge}
      <span class="hint" data-autosave>Autosave ready</span>
      <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn--ghost" data-action="preview">${icon('eye')} Preview</button>
        <button class="btn btn--ghost" data-action="save" ${readOnly ? 'disabled' : ''}>${icon('check')} Save draft</button>
        <button class="btn btn--primary" data-action="publish" ${readOnly ? 'disabled' : ''}>${icon('upload')} Publish</button>
      </div>
    </div>
    <div class="card__body">
      <div class="alert alert--info" hidden data-editnotice>You have read-only access. Only administrators can publish content.</div>
      <form id="contentForm" novalidate>
        <div data-schema>${Object.keys(data.content).length ? Object.entries(data.content).map(([k, v]) => renderField(k, k, v)).join('') : renderEmptySchema()}</div>
      </form>
      <div class="content-seo" style="margin-top:22px">
        <div class="card__head"><h3>SEO settings</h3></div>
        <div class="grid grid--form">
          <div class="field"><label>Meta title</label><input data-seo="metaTitle" value="${esc(state.seo.metaTitle || '')}"></div>
          <div class="field"><label>Meta description</label><textarea data-seo="metaDescription" rows="3">${esc(state.seo.metaDescription || '')}</textarea></div>
          <div class="field"><label>Keywords</label><input data-seo="keywords" value="${esc(state.seo.keywords || '')}"></div>
          <div class="field"><label>Open Graph image URL</label><input data-seo="ogImage" value="${esc(state.seo.ogImage || '')}"></div>
          <div class="field"><label>Canonical URL</label><input data-seo="canonicalUrl" value="${esc(state.seo.canonicalUrl || '')}"></div>
          <div class="field"><label>Robots</label><input data-seo="robots" value="${esc(state.seo.robots || 'index,follow')}"></div>
        </div>
      </div>
    </div>`;

  if (readOnly) qs('[data-editnotice]', panel).hidden = false;
  if (readOnly) qsa('form#contentForm input, form#contentForm textarea, form#contentForm [contenteditable]', panel).forEach((n) => { n.disabled = true; n.contentEditable = 'false'; });

  const form = qs('#contentForm', panel);
  const readContent = () => ({ ...readForm(form.querySelector('[data-schema]')) });

  // structural add/remove handlers
  form.addEventListener('click', (e) => {
    const add = e.target.closest('.list-add');
    const rem = e.target.closest('.list-remove');
    if (add) {
      e.preventDefault();
      const editor = add.closest('.list-editor');
      const path = editor.dataset.path;
      const cur = readContent();
      const node = path.split('.').reduce((o, s) => o[s], cur);
      const template = Array.isArray(node) && node.length ? node[node.length - 1] : (node && typeof node === 'object' ? node : '');
      const sample = template && typeof template === 'object'
        ? Object.fromEntries(Object.entries(template).map(([k, v]) => [k, typeof v === 'string' ? '' : typeof v === 'number' ? 0 : typeof v === 'boolean' ? false : Array.isArray(v) ? [] : {}]))
        : '';
      state.content = cur;
      renderSchema(panel, pageKey, cur);
      scheduleAutosave(panel, pageKey);
    } else if (rem) {
      e.preventDefault();
      const card = rem.closest('.list-card') || rem.closest('.list-row');
      const editor = card.closest('.list-editor');
      const path = editor.dataset.path;
      const idx = Number(card.dataset.path ? card.dataset.path.split('.').pop() : (card.querySelector('[data-path]')?.dataset.path.split('.').pop() || 0));
      const cur = readContent();
      const node = path.split('.').reduce((o, s) => o[s], cur);
      if (Array.isArray(node)) node.splice(idx, 1);
      state.content = cur;
      renderSchema(panel, pageKey, cur);
      scheduleAutosave(panel, pageKey);
    }
  });

  // autosave on any input
  const scheduleAutosave = debounce(() => doAutosave(panel, pageKey), 900);
  form.addEventListener('input', () => {
    state.content = readContent();
    const node = qs('[data-autosave]', panel);
    if (node) node.textContent = 'Unsaved changes…';
    scheduleAutosave();
  });
  form.addEventListener('change', () => {
    state.content = readContent();
    scheduleAutosave();
  });

  function readSeo() {
    const seo = {};
    qsa('[data-seo]', panel).forEach((n) => { seo[n.dataset.seo] = n.value; });
    return seo;
  }

  async function doAutosave(p, key) {
    try {
      await api.post(`/content/${key}/autosave`, { draft: readContent() });
      const node = qs('[data-autosave]', p);
      if (node) node.textContent = 'Draft autosaved';
      toast('Draft saved automatically', 'info', 'Autosave');
    } catch (e) { /* non-blocking */ }
  }

  qs('[data-action="save"]', panel).onclick = async () => {
    try {
      const body = { content: readContent() };
      const seo = readSeo();
      if (Object.keys(seo).length) body.seo = seo;
      await api.put(`/content/${pageKey}`, body);
      state.status = (await api.get(`/content/${pageKey}`)).data.status;
      toast('Content saved. Remember to publish it to go live.', 'success', 'Saved');
    } catch (e) { toastError(e); }
  };

  qs('[data-action="publish"]', panel).onclick = async () => {
    if (!auth.isAdmin) return;
    const ok = await confirmDialog({ title: 'Publish changes?', message: 'This content will immediately appear on the live website.', confirmLabel: 'Publish' });
    if (!ok) return;
    try {
      const body = { content: readContent() };
      const seo = readSeo();
      if (Object.keys(seo).length) body.seo = seo;
      const r = await api.post(`/content/${pageKey}/publish`, body);
      state.status = r.data.status;
      toast('Page published — changes are live.', 'success', 'Published');
      panel.querySelector('.badge').outerHTML = `<span class="badge badge--success">PUBLISHED</span>`;
    } catch (e) { toastError(e); }
  };

  qs('[data-action="preview"]', panel).onclick = () => renderPreview(panel, pageKey);
}

function renderSchema(panel, pageKey, content) {
  const schema = qs('[data-schema]', panel);
  if (!schema) return;
  schema.innerHTML = Object.keys(content).length
    ? Object.entries(content).map(([k, v]) => renderField(k, k, v)).join('')
    : renderEmptySchema();
}

/** Opens a modal with a live HTML preview of the current content. */
function renderPreview(panel, pageKey) {
  const content = readForm(qs('#contentForm [data-schema]', panel));
  const title = qs('#contentForm [data-path="hero.title"]', panel)?.value
    || content.hero?.title || 'Website preview';
  const html = previewHtml(content);
  modal({
    title: `Preview — ${title}`,
    size: 'lg',
    body: `<div style="max-height:70vh;overflow:auto"><div class="preview-page">${html}</div></div>`,
    footer: `<button class="btn btn--primary" data-close>Close preview</button>`,
  });
}

function escHtml(v) {
  return String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** A small opinionated HTML renderer so admins can preview their content. */
function previewHtml(c) {
  const parts = [];
  const hero = c.hero || {};
  parts.push(`<section style="background:linear-gradient(135deg,#0b3a5b,#12507f);color:#fff;padding:48px;border-radius:10px;margin-bottom:16px">
    <h1 style="margin:0 0 8px">${escHtml(hero.title || '')}</h1>
    <p style="opacity:.85;margin:0 0 16px">${escHtml(hero.subtitle || '')}</p>
    <div style="display:flex;gap:8px">${escHtml(hero.ctaPrimary?.label || '') ? `<span style="background:#0ea5e9;padding:8px 14px;border-radius:6px">${escHtml(hero.ctaPrimary.label)}</span>` : ''}
    ${escHtml(hero.ctaSecondary?.label || '') ? `<span style="border:1px solid #fff;padding:8px 14px;border-radius:6px">${escHtml(hero.ctaSecondary.label)}</span>` : ''}</div>
  </section>`);
  if (c.intro) parts.push(`<p>${escHtml(c.intro)}</p>`);
  if (c.description) parts.push(`<p>${c.description}</p>`);
  if (c.mission) parts.push(`<h3>Mission</h3><p>${c.mission}</p>`);
  if (c.vision) parts.push(`<h3>Vision</h3><p>${c.vision}</p>`);
  const cta = c.cta || {};
  if (cta.title) parts.push(`<section style="background:#f1f5f9;padding:32px;border-radius:10px;text-align:center"><h2 style="margin:0 0 6px">${escHtml(cta.title)}</h2><p style="margin:0 0 12px">${escHtml(cta.subtitle || '')}</p></section>`);
  return parts.join('');
}

/* ============================================================ collection manager */

const COLLECTION_CONFIG = {
  services: {
    title: 'Services', columns: ['name', 'icon', 'featured', 'status'],
    fields: [
      { name: 'name', label: 'Service name', type: 'text', required: true },
      { name: 'icon', label: 'Icon (font-awesome class)', type: 'text' },
      { name: 'imageUrl', label: 'Image', type: 'image' },
      { name: 'description', label: 'Short description', type: 'rich' },
      { name: 'content', label: 'Full description (rich text)', type: 'rich' },
      { name: 'featured', label: 'Featured service', type: 'check' },
      { name: 'sortOrder', label: 'Sort order', type: 'number' },
    ],
  },
  testimonials: {
    title: 'Testimonials', columns: ['name', 'company', 'rating', 'status'],
    fields: [
      { name: 'name', label: 'Customer name', type: 'text', required: true },
      { name: 'company', label: 'Company', type: 'text' },
      { name: 'review', label: 'Review', type: 'rich', required: true },
      { name: 'rating', label: 'Rating (1-5)', type: 'number', min: 1, max: 5 },
      { name: 'photoUrl', label: 'Customer photo', type: 'image' },
      { name: 'sortOrder', label: 'Sort order', type: 'number' },
    ],
  },
  gallery: {
    title: 'Gallery', columns: ['title', 'category', 'status'],
    fields: [
      { name: 'title', label: 'Title', type: 'text' },
      { name: 'category', label: 'Category', type: 'text' },
      { name: 'imageUrl', label: 'Image', type: 'image', required: true },
      { name: 'alt', label: 'Alt text', type: 'text' },
      { name: 'sortOrder', label: 'Sort order', type: 'number' },
    ],
  },
  faqs: {
    title: 'FAQ', columns: ['question', 'category', 'status'],
    fields: [
      { name: 'question', label: 'Question', type: 'text', required: true },
      { name: 'answer', label: 'Answer', type: 'rich', required: true },
      { name: 'category', label: 'Category', type: 'text' },
      { name: 'sortOrder', label: 'Sort order', type: 'number' },
    ],
  },
  promotions: {
    title: 'Promotions', columns: ['title', 'badge', 'status'],
    fields: [
      { name: 'title', label: 'Promotion title', type: 'text', required: true },
      { name: 'badge', label: 'Badge (e.g. SALE)', type: 'text' },
      { name: 'body', label: 'Description', type: 'rich' },
      { name: 'imageUrl', label: 'Image', type: 'image' },
      { name: 'link', label: 'Link URL', type: 'text' },
      { name: 'sortOrder', label: 'Sort order', type: 'number' },
      { name: 'startAt', label: 'Start date', type: 'date' },
      { name: 'endAt', label: 'End date', type: 'date' },
    ],
  },
  team: {
    title: 'Team Members', columns: ['name', 'role', 'status'],
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'role', label: 'Role', type: 'text' },
      { name: 'bio', label: 'Biography', type: 'rich' },
      { name: 'photoUrl', label: 'Photo', type: 'image' },
      { name: 'sortOrder', label: 'Sort order', type: 'number' },
    ],
  },
};

function statusPill(s) {
  return `<span class="badge badge--${s === 'PUBLISHED' ? 'success' : 'warning'}">${esc(s)}</span>`;
}

function renderCollection(panel, collection, pageKey) {
  const cfg = COLLECTION_CONFIG[collection];
  const readOnly = !auth.isAdmin;
  panel.innerHTML = `
    <div class="card__head" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0">${esc(cfg.title)}</h2>
      <div class="topbar__search" style="max-width:260px">
        ${icon('search')}<input data-search type="search" placeholder="Search ${esc(cfg.title.toLowerCase())}…" aria-label="Search">
      </div>
      <select data-status aria-label="Filter by status" style="margin-left:auto">
        <option value="">All statuses</option><option value="PUBLISHED">Published</option><option value="DRAFT">Draft</option>
      </select>
      <button class="btn btn--primary" data-add ${readOnly ? 'disabled' : ''}>${icon('plus')} New ${esc(cfg.title.slice(0, -1))}</button>
    </div>
    <div class="card__body">
      <div data-list style="min-height:160px"></div>
    </div>`;

  const listHost = qs('[data-list]', panel);
  let items = [];
  let filter = { search: '', status: '' };

  const load = debounce(async () => {
    listHost.innerHTML = `<div style="display:grid;place-items:center;padding:30px"><div class="spinner"></div></div>`;
    try {
      const r = await api.get(`/site-content/${collection}`, { search: filter.search, status: filter.status, limit: 100 });
      items = r.data;
      renderRows();
    } catch (e) { listHost.innerHTML = emptyState('Could not load items', e.message); }
  }, 200);

  function renderRows() {
    if (!items.length) { listHost.innerHTML = emptyState('No items yet', 'Click "New" to add your first item.'); return; }
    const head = cfg.columns.map((c) => `<th>${esc(c.charAt(0).toUpperCase() + c.slice(1))}</th>`).join('');
    listHost.innerHTML = `<table class="table"><thead><tr><th>${head}</th><th>Published</th><th style="width:190px">Actions</th></tr></thead>
      <tbody>${items.map((it, idx) => `<tr data-id="${esc(it.id)}">
        ${cfg.columns.map((c) => `<td>${colCell(c, it)}</td>`).join('')}
        <td>${statusPill(it.status)}</td>
        <td>
          <div style="display:flex;gap:6px">
            <button class="icon-btn" data-act="move" data-dir="-1" aria-label="Move up" ${idx === 0 ? 'disabled' : ''}>${icon('chevUp')}</button>
            <button class="icon-btn" data-act="move" data-dir="1" aria-label="Move down" ${idx === items.length - 1 ? 'disabled' : ''}>${icon('chevDown')}</button>
            <button class="icon-btn" data-act="edit" aria-label="Edit">${icon('edit')}</button>
            <button class="icon-btn" data-act="toggle" aria-label="Publish / unpublish">${icon(it.status === 'PUBLISHED' ? 'eyeOff' : 'eye')}</button>
            <button class="icon-btn" data-act="delete" aria-label="Delete" ${readOnly ? 'disabled' : ''}>${icon('trash')}</button>
          </div>
        </td></tr>`).join('')}</tbody></table>`;
  }

  function colCell(c, it) {
    if (c === 'status') return '';
    if (c === 'featured') return `<span class="badge badge--${it.featured ? 'purple' : 'muted'}">${it.featured ? 'Featured' : '—'}</span>`;
    if (c === 'rating') return `${'★'.repeat(it.rating || 0)}${'☆'.repeat(5 - (it.rating || 0))}`;
    if (c === 'imageUrl' && it.imageUrl) return `<img src="${esc(it.imageUrl)}" alt="" style="height:38px;width:48px;object-fit:cover;border-radius:6px">`;
    return esc(String(it[c] ?? '—')).slice(0, 60);
  }

  listHost.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    const item = items.find((i) => i.id === id);
    const act = btn.dataset.act;
    if (act === 'edit') openEditor(item);
    else if (act === 'toggle') {
      try {
        await api.post(`/site-content/${collection}/${id}/${item.status === 'PUBLISHED' ? 'draft' : 'publish'}`);
        toast(item.status === 'PUBLISHED' ? 'Moved to draft' : 'Published', 'success');
        load();
      } catch (err) { toastError(err); }
    } else if (act === 'delete') {
      if (!auth.isAdmin) return;
      const ok = await confirmDialog({ title: 'Delete this item?', message: 'This action cannot be undone.', confirmLabel: 'Delete' });
      if (!ok) return;
      try { await api.del(`/site-content/${collection}/${id}`); toast('Item deleted', 'success'); load(); }
      catch (err) { toastError(err); }
    } else if (act === 'move') {
      const j = idxOf(id);
      const target = j + Number(btn.dataset.dir);
      if (target < 0 || target >= items.length) return;
      const arr = items.slice(); const [moved] = arr.splice(j, 1); arr.splice(target, 0, moved);
      try {
        await api.post(`/site-content/${collection}/reorder`, { items: arr.map((it, k) => ({ id: it.id, sortOrder: k + 1 })) });
        items = arr; renderRows();
      } catch (err) { toastError(err); }
    }
  });
  function idxOf(id) { return items.findIndex((i) => i.id === id); }

  qs('[data-search]', panel).addEventListener('input', (e) => { filter.search = e.target.value; load(); });
  qs('[data-status]', panel).addEventListener('change', (e) => { filter.status = e.target.value; load(); });
  qs('[data-add]', panel).onclick = () => openEditor(null);

  function openEditor(item) {
    const isNew = !item;
    const values = item || {};
    const fields = cfg.fields.map((f) => {
      const v = values[f.name];
      if (f.type === 'check') return `<label class="checkline"><input type="checkbox" name="${esc(f.name)}" ${v ? 'checked' : ''}> ${esc(f.label)}</label>`;
      if (f.type === 'image') {
        return `<div class="field"><label>${esc(f.label)}</label>
          <div style="display:flex;gap:8px;align-items:center">
            <img data-img data-name="${esc(f.name)}" src="${esc(v || '')}" alt="" style="height:44px;width:56px;object-fit:cover;border-radius:6px;border:1px solid var(--border)" ${v ? '' : 'hidden'}>
            <input type="hidden" name="${esc(f.name)}" value="${esc(v || '')}" data-url>
            <button type="button" class="btn btn--ghost" data-upload>${icon('upload')} Upload</button>
            ${v ? `<button type="button" class="icon-btn" data-clearimg aria-label="Clear image">${icon('x')}</button>` : ''}
          </div></div>`;
      }
      if (f.type === 'rich') return `<div class="field"><label>${esc(f.label)}</label><div data-rich name="${esc(f.name)}">${v || ''}</div></div>`;
      if (f.type === 'number') return `<div class="field"><label>${esc(f.label)}</label><input type="number" name="${esc(f.name)}" value="${esc(v ?? '')}" ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.max !== undefined ? `max="${f.max}"` : ''}></div>`;
      if (f.type === 'date') return `<div class="field"><label>${esc(f.label)}</label><input type="date" name="${esc(f.name)}" value="${v ? new Date(v).toISOString().slice(0, 10) : ''}"></div>`;
      return `<div class="field"><label>${esc(f.label)}</label><input type="text" name="${esc(f.name)}" value="${esc(v ?? '')}" ${f.required ? 'required' : ''}></div>`;
    }).join('');

    const m = modal({
      title: isNew ? `New ${cfg.title.slice(0, -1)}` : `Edit ${cfg.title.slice(0, -1)}`,
      size: 'md',
      body: `<form id="collForm">${fields}</form>`,
      footer: `<button class="btn btn--ghost" data-close>Cancel</button>
               <button class="btn btn--primary" data-save>${isNew ? 'Create' : 'Save changes'}</button>`,
      onMount: ({ root }) => {
        root.querySelector('[data-upload]')?.addEventListener('click', (e) => uploadImage(e, root, collection));
        root.querySelectorAll('[data-clearimg]').forEach((b) => b.onclick = () => {
          const img = b.closest('.field').querySelector('[data-img]');
          const url = b.closest('.field').querySelector('[data-url]');
          img.hidden = true; url.value = '';
        });
        root.querySelectorAll('[data-rich]').forEach((node) => {
          const editor = buildRichEditor(node.innerHTML);
          node.replaceWith(editor);
        });
        root.querySelector('[data-save]').onclick = async () => {
          const form = root.querySelector('#collForm');
          const payload = {};
          for (const f of cfg.fields) {
            const inp = form.elements[f.name];
            if (!inp) continue;
            if (f.type === 'check') payload[f.name] = inp.checked;
            else if (f.type === 'number') payload[f.name] = inp.value === '' ? undefined : Number(inp.value);
            else if (f.type === 'date') payload[f.name] = inp.value ? new Date(inp.value).toISOString() : null;
            else if (f.type === 'rich') payload[f.name] = root.querySelector(`[data-rich]`)?.querySelector('.rte__editor')?.innerHTML || root.querySelector(`[data-rich="${esc(f.name)}"]`)?.innerHTML || '';
            else payload[f.name] = inp.value;
          }
          try {
            if (isNew) { const r = await api.post(`/site-content/${collection}`, payload); toast('Created successfully', 'success'); }
            else { await api.put(`/site-content/${collection}/${item.id}`, payload); toast('Saved successfully', 'success'); }
            m.close(); load();
          } catch (err) { toastError(err); }
        };
      },
    });
  }

  load();
}

async function uploadImage(e, root, collection) {
  e.preventDefault();
  const fileInput = el('<input type="file" accept="image/*">');
  fileInput.onchange = async () => {
    const file = fileInput.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('images', file);
    fd.append('folder', `/${collection}`);
    try {
      const r = await api.upload('/media/upload', fd);
      const asset = r.data[0];
      const field = e.target.closest('.field');
      const img = field.querySelector('[data-img]');
      const url = field.querySelector('[data-url]');
      img.src = asset.url; img.hidden = false; url.value = asset.url;
      toast('Image uploaded', 'success');
    } catch (err) { toastError(err); }
  };
  fileInput.click();
}

/* ============================================================ page entry */

export async function render(view, query) {
  setTitle('Website Content Manager');

  // deep-link to a tab from #/content?tab=homepage
  if (query && query.tab && MODULES.find((m) => m.key === query.tab)) currentTab = query.tab;

  let pages = [];
  try { pages = (await api.get('/content')).data; } catch (e) { /* tabs still render */ }
  const statusOf = (k) => pages.find((p) => p.key === k)?.status || 'DRAFT';

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Website Content Manager</h1><p>Edit every page and section. Changes only go live once you publish.</p></div>
      <a class="btn btn--ghost" href="../index.html" target="_blank" rel="noopener">${icon('eye')} View website</a>
    </div>
    <div class="tabs tabs--scroll" role="tablist" id="contentTabs">
      ${MODULES.map((m, i) => `<button class="tab ${i === 0 ? '' : ''}" role="tab" data-tab="${m.key}" aria-selected="${m.key === currentTab}">
        ${icon(ICON_EXTRA[m.icon] ? m.icon : m.icon)} ${esc(m.label)}
        <span class="tab__dot ${statusOf(m.key) === 'PUBLISHED' ? 'is-live' : ''}" title="${esc(statusOf(m.key))}"></span></button>`).join('')}
    </div>
    <section class="card" style="margin-top:14px" id="contentPanel">
      <div class="card__body" style="display:grid;place-items:center;min-height:200px"><div class="spinner"></div></div>
    </section>`;

  const panel = qs('#contentPanel', view);
  const tabs = qs('#contentTabs', view);

  async function activate(key) {
    currentTab = key;
    tabs.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === key)));
    const collection = COLLECTION_TABS[key];
    if (collection) {
      renderCollection(panel, collection, key);
    } else {
      renderPageEditor(panel, key);
    }
  }

  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (btn) activate(btn.dataset.tab);
  });

  await activate(currentTab);
}
