/** Supplier Marketplace → Sync Logs: run history plus per-record detail. */
import { api, auth } from '../api.js';
import { setTitle } from '../layout.js';
import {
  qs, qsa, icon, esc, num, statusBadge, skeletonRows, emptyState,
  pagination, modal, toast, toastError, dateTime, relative, titleCase,
} from '../ui.js';
import { sectionHead, kvList } from './supplier-nav.js';

const state = { page: 1, limit: 20, supplierId: '', status: '', type: '', trigger: '', search: '' };
let suppliers = [];

export async function render(view, query) {
  setTitle('Sync Logs');
  Object.assign(state, { page: 1, supplierId: query.supplierId || '' });

  view.innerHTML = `
    ${sectionHead({
      title: 'Sync Logs',
      subtitle: 'Every synchronisation run, its counters and its per-record detail. Failed and partial runs can be retried.',
      active: '/supplier-logs',
    })}
    <section class="card">
      <div class="toolbar">
        <label class="sr-only" for="supplierFilter">Supplier</label>
        <select id="supplierFilter"><option value="">All suppliers</option></select>
        <label class="sr-only" for="statusFilter">Status</label>
        <select id="statusFilter"><option value="">Any status</option>
          ${['QUEUED', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'].map((s) =>
            `<option value="${s}">${esc(titleCase(s))}</option>`).join('')}</select>
        <label class="sr-only" for="typeFilter">Type</label>
        <select id="typeFilter"><option value="">Any type</option>
          ${['FULL', 'CATALOG', 'INVENTORY', 'PRICING'].map((t) => `<option value="${t}">${esc(titleCase(t))}</option>`).join('')}</select>
        <label class="sr-only" for="triggerFilter">Trigger</label>
        <select id="triggerFilter"><option value="">Any trigger</option>
          ${['MANUAL', 'SCHEDULED', 'RETRY'].map((t) => `<option value="${t}">${esc(titleCase(t))}</option>`).join('')}</select>
      </div>
      <div class="table-wrap"><table class="data">
        <caption class="sr-only">Synchronisation runs</caption>
        <thead><tr>
          <th scope="col">Supplier</th><th scope="col">Integration</th><th scope="col">Type</th>
          <th scope="col">Trigger</th><th scope="col">Start</th><th scope="col">End</th>
          <th scope="col" class="num">Processed</th><th scope="col" class="num">Created</th>
          <th scope="col" class="num">Updated</th><th scope="col" class="num">Errors</th>
          <th scope="col">Status</th><th scope="col" style="text-align:right">Actions</th>
        </tr></thead>
        <tbody id="rows">${skeletonRows(12)}</tbody></table></div>
      <div class="card__foot" id="pager"></div>
    </section>`;

  const rows = qs('#rows', view);
  const pager = qs('#pager', view);

  try {
    const { data } = await api.get('/suppliers', { status: 'ALL', limit: 100 });
    suppliers = data;
    qs('#supplierFilter', view).innerHTML = `<option value="">All suppliers</option>${suppliers.map((s) =>
      `<option value="${esc(s.id)}" ${state.supplierId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}`;
  } catch (e) { toastError(e); }

  async function load() {
    rows.innerHTML = skeletonRows(12);
    try {
      const { data, meta } = await api.get('/supplier-syncs', {
        page: state.page, limit: state.limit, supplierId: state.supplierId,
        status: state.status, type: state.type, trigger: state.trigger,
      });
      if (!data.length) {
        rows.innerHTML = `<tr><td colspan="12">${emptyState('No synchronisation runs',
          'Run a sync from Sync & Automation to see it here.')}</td></tr>`;
        pager.innerHTML = '';
        return;
      }
      rows.innerHTML = data.map((s) => `<tr data-id="${esc(s.id)}">
        <td><div class="cell-main">${esc(s.supplier?.name || '—')}</div><div class="cell-sub">${esc(s.supplier?.code || '')}</div></td>
        <td>${s.integration ? `${esc(s.integration.name)}<div class="cell-sub">${esc(s.integration.connectorType)}</div>` : '—'}</td>
        <td>${esc(s.type)}</td><td>${esc(s.trigger.toLowerCase())}${s.attempt > 1 ? `<div class="cell-sub">attempt ${num(s.attempt)}</div>` : ''}</td>
        <td>${dateTime(s.startedAt)}</td>
        <td>${s.finishedAt ? `${dateTime(s.finishedAt)}<div class="cell-sub">${num(s.durationMs || 0)} ms</div>` : '<span class="cell-sub">running</span>'}</td>
        <td class="num">${num(s.processed)}</td>
        <td class="num">${num(s.created)}</td>
        <td class="num">${num(s.updated)}<div class="cell-sub">${num(s.inventoryUpdates)} stock · ${num(s.priceUpdates)} price</div></td>
        <td class="num">${s.errorCount ? `<span class="badge badge--danger">${num(s.errorCount)}</span>` : '0'}</td>
        <td>${statusBadge(s.status)}</td>
        <td><div class="row-actions">
          <button class="btn btn--ghost btn--icon" data-act="view" aria-label="Inspect run">${icon('eye')}</button>
          <button class="btn btn--ghost btn--icon" data-act="logs" aria-label="Record log">${icon('file')}</button>
          <button class="btn btn--ghost btn--icon" data-act="retry" aria-label="Retry run"
            ${['FAILED', 'PARTIAL', 'CANCELLED'].includes(s.status) ? '' : 'disabled'}>${icon('refresh')}</button>
        </div></td></tr>`).join('');
      pager.innerHTML = '';
      pager.appendChild(pagination(meta, (p) => { state.page = p; load(); }));
    } catch (e) {
      rows.innerHTML = `<tr><td colspan="12">${emptyState('Could not load sync logs', e.message)}</td></tr>`;
    }
  }

  const bind = (id, key) => { qs(id, view).onchange = (e) => { state[key] = e.target.value; state.page = 1; load(); }; };
  bind('#supplierFilter', 'supplierId'); bind('#statusFilter', 'status');
  bind('#typeFilter', 'type'); bind('#triggerFilter', 'trigger');

  rows.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const id = btn.closest('tr').dataset.id;
    const act = btn.dataset.act;
    if (act === 'view') return detail(id, load);
    if (act === 'logs') return logViewer(id);
    if (act === 'retry') {
      try { const r = await api.post(`/supplier-syncs/${id}/retry`); toast(r.message); load(); }
      catch (err) { toastError(err); }
    }
  });

  await load();

  async function detail(id, after) {
    let data;
    try { ({ data } = await api.get(`/supplier-syncs/${id}`)); }
    catch (e) { return toastError(e); }
    const s = data;
    modal({
      title: `Sync ${s.type} — ${s.supplier?.name || ''}`,
      size: 'lg',
      body: `
        <div class="import-summary" style="margin-bottom:14px">
          ${tile('PROCESSED', s.processed)}${tile('CREATED', s.created)}${tile('UPDATED', s.updated)}
          ${tile('SKIPPED', s.skipped)}${tile('STOCK UPDATES', s.inventoryUpdates)}
          ${tile('PRICE UPDATES', s.priceUpdates)}${tile('ERRORS', s.errorCount)}
        </div>
        ${kvList([
          ['Status', statusBadge(s.status)],
          ['Trigger', esc(s.trigger.toLowerCase())],
          ['Attempt', `${num(s.attempt)} of ${num(s.maxAttempts)}`],
          ['Batch size', num(s.batch)],
          ['Started', dateTime(s.startedAt)],
          ['Finished', s.finishedAt ? dateTime(s.finishedAt) : 'still running'],
          ['Duration', s.durationMs ? `${num(s.durationMs)} ms` : '—'],
          ['Message', esc(s.message || '—')],
          ['Cursor', s.cursor ? `<code>${esc(s.cursor)}</code>` : '—'],
        ])}
        ${s.errors.length ? `<h4 style="margin:16px 0 6px">Errors (${num(s.errors.length)})</h4>
          <div class="table-wrap"><table class="data"><thead><tr><th>SKU</th><th>Problem</th></tr></thead>
          <tbody>${s.errors.slice(0, 50).map((e) => `<tr><td><code>${esc(e.sku || '—')}</code></td><td>${esc(e.message)}</td></tr>`).join('')}</tbody></table></div>` : ''}
        ${s.logs.length ? `<h4 style="margin:16px 0 6px">Recent record log</h4>
          <div class="table-wrap"><table class="data"><thead><tr><th>Action</th><th>SKU</th><th>Detail</th></tr></thead>
          <tbody>${s.logs.slice(0, 25).map((l) => `<tr>
            <td>${statusBadge(l.action === 'ERROR' ? 'FAILED' : l.action === 'CREATE' ? 'NEW' : l.action === 'UPDATE' ? 'CHANGED' : 'OK', l.action)}</td>
            <td><code>${esc(l.sku || '—')}</code></td><td>${esc(l.message || '')}</td></tr>`).join('')}</tbody></table></div>` : ''}`,
      footer: `<button class="btn btn--ghost" data-close>Close</button>
        ${['FAILED', 'PARTIAL', 'CANCELLED'].includes(s.status) ? '<button class="btn btn--primary" id="retryBtn">Retry this run</button>' : ''}
        <button class="btn btn--subtle" id="logsBtn">Full record log</button>`,
      onMount: ({ root, close }) => {
        const retry = qs('#retryBtn', root);
        if (retry) {
          retry.onclick = async () => {
            try { const r = await api.post(`/supplier-syncs/${id}/retry`); toast(r.message); close(); after?.(); }
            catch (e) { toastError(e); }
          };
        }
        qs('#logsBtn', root).onclick = () => { close(); logViewer(id); };
      },
    });
  }

  async function logViewer(id, page = 1, action = '') {
    let data;
    let metaInfo;
    try { ({ data, meta: metaInfo } = await api.get(`/supplier-syncs/${id}/logs`, { page, limit: 50, action })); }
    catch (e) { return toastError(e); }

    const m = modal({
      title: 'Record log',
      size: 'lg',
      body: `<div class="toolbar">
          <label class="sr-only" for="logAction">Filter by action</label>
          <select id="logAction"><option value="">All actions</option>
            ${['CREATE', 'UPDATE', 'SKIP', 'ERROR'].map((a) => `<option value="${a}" ${action === a ? 'selected' : ''}>${esc(titleCase(a))} (${num(metaInfo.summary?.[a] || 0)})</option>`).join('')}
          </select></div>
        <div id="logBody"></div><div class="card__foot" id="logPager"></div>`,
      footer: '<button class="btn btn--ghost" data-close>Close</button>',
      onMount: ({ root }) => {
        const body = qs('#logBody', root);
        const pagerHost = qs('#logPager', root);
        const paint = () => {
          body.innerHTML = data.length
            ? `<div class="table-wrap"><table class="data"><thead><tr><th>Action</th><th>SKU</th><th>Field</th><th>Detail</th><th>When</th></tr></thead>
               <tbody>${data.map((l) => `<tr>
                 <td>${statusBadge(l.action === 'ERROR' ? 'FAILED' : l.action === 'CREATE' ? 'NEW' : l.action === 'UPDATE' ? 'CHANGED' : 'OK', l.action)}</td>
                 <td><code>${esc(l.sku || '—')}</code></td><td>${esc(l.field || '—')}</td>
                 <td>${esc(l.message || '')}</td><td>${dateTime(l.createdAt)}</td></tr>`).join('')}</tbody></table></div>`
            : emptyState('No log entries', 'This run recorded no per-record changes.');
          pagerHost.innerHTML = '';
          pagerHost.appendChild(pagination(metaInfo, async (p) => {
            const r = await api.get(`/supplier-syncs/${id}/logs`, { page: p, limit: 50, action });
            data = r.data; metaInfo = r.meta; paint();
          }));
        };
        paint();
        qs('#logAction', root).onchange = async (e) => {
          action = e.target.value;
          const r = await api.get(`/supplier-syncs/${id}/logs`, { page: 1, limit: 50, action });
          data = r.data; metaInfo = r.meta; paint();
        };
      },
    });
    return m;
  }
}

function tile(label, value) {
  return `<div class="import-summary__tile"><div class="import-summary__value">${num(value)}</div>
    <div class="import-summary__label">${esc(label)}</div></div>`;
}
