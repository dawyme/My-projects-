/** Supplier Marketplace → Import Products: feed upload, preview and commit. */
import { api, auth } from '../api.js';
import { setTitle } from '../layout.js';
import {
  qs, qsa, icon, esc, money, num, statusBadge, skeletonRows, emptyState,
  pagination, modal, confirmDialog, toast, toastError, relative,
} from '../ui.js';
import { sectionHead } from './supplier-nav.js';

const state = { page: 1, limit: 20, supplierId: '', status: '' };
let suppliers = [];

export async function render(view, query) {
  setTitle('Import Products');
  Object.assign(state, { page: 1, supplierId: query.supplierId || '' });

  view.innerHTML = `
    ${sectionHead({
      title: 'Import Products',
      subtitle: 'Upload a CSV, XML or JSON catalogue feed — or pull one straight from a connected supplier. Every import is previewed before it is committed.',
      active: '/supplier-imports',
      actions: `<a class="btn btn--ghost" href="/api/supplier-imports/template.csv" download>${icon('download')} Template CSV</a>
                <button class="btn btn--primary" id="importBtn">${icon('upload')} New import</button>`,
    })}
    <section class="card">
      <div class="toolbar">
        <label class="sr-only" for="supplierFilter">Supplier</label>
        <select id="supplierFilter"><option value="">All suppliers</option></select>
        <label class="sr-only" for="statusFilter">Status</label>
        <select id="statusFilter">
          <option value="">Any status</option><option value="PREVIEWING">Previewing</option>
          <option value="COMMITTED">Committed</option><option value="CANCELLED">Cancelled</option>
        </select>
      </div>
      <div class="table-wrap"><table class="data">
        <caption class="sr-only">Catalogue imports</caption>
        <thead><tr><th scope="col">Supplier</th><th scope="col">Source</th><th scope="col" class="num">Rows</th>
          <th scope="col">New</th><th scope="col">Updated</th><th scope="col">Unchanged</th>
          <th scope="col">Errors</th><th scope="col">Status</th><th scope="col">When</th>
          <th scope="col" style="text-align:right">Actions</th></tr></thead>
        <tbody id="rows">${skeletonRows(10)}</tbody></table></div>
      <div class="card__foot" id="pager"></div>
    </section>`;

  const rows = qs('#rows', view);
  const pager = qs('#pager', view);

  try {
    const { data } = await api.get('/suppliers', { status: 'ALL', limit: 100 });
    suppliers = data;
    qs('#supplierFilter', view).innerHTML = `<option value="">All suppliers</option>${data.map((s) =>
      `<option value="${esc(s.id)}" ${state.supplierId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}`;
  } catch (e) { toastError(e); }

  async function load() {
    rows.innerHTML = skeletonRows(10);
    try {
      const { data, meta } = await api.get('/supplier-imports', {
        page: state.page, limit: state.limit, supplierId: state.supplierId, status: state.status,
      });
      if (!data.length) {
        rows.innerHTML = `<tr><td colspan="10">${emptyState('No imports yet',
          'Upload a catalogue file or pull one from a connected supplier.')}</td></tr>`;
        pager.innerHTML = '';
        return;
      }
      rows.innerHTML = data.map((r) => `<tr data-id="${esc(r.id)}">
        <td><div class="cell-main">${esc(r.supplier?.name || '—')}</div><div class="cell-sub">${esc(r.filename || 'live feed')}</div></td>
        <td>${esc(r.source)}</td>
        <td class="num">${num(r.rowsRead)}</td>
        <td class="num">${num(r.rowsCreated)}</td>
        <td class="num">${num(r.rowsUpdated)}</td>
        <td class="num">${num(r.rowsUnchanged)}</td>
        <td class="num">${r.rowsFailed ? `<span class="badge badge--danger">${num(r.rowsFailed)}</span>` : '0'}</td>
        <td>${statusBadge(r.status)}</td>
        <td>${relative(r.createdAt)}</td>
        <td><div class="row-actions">
          <button class="btn btn--ghost btn--icon" data-act="view" aria-label="View preview">${icon('eye')}</button>
          ${r.status === 'PREVIEWING' ? `<button class="btn btn--ghost btn--icon" data-act="commit" aria-label="Commit import">${icon('check')}</button>
          <button class="btn btn--ghost btn--icon" data-act="cancel" aria-label="Discard import">${icon('x')}</button>` : ''}
          ${r.rowsFailed ? `<a class="btn btn--ghost btn--icon" href="/api/supplier-imports/${esc(r.id)}/errors.csv" aria-label="Download errors">${icon('download')}</a>` : ''}
        </div></td></tr>`).join('');
      pager.innerHTML = '';
      pager.appendChild(pagination(meta, (p) => { state.page = p; load(); }));
    } catch (e) {
      rows.innerHTML = `<tr><td colspan="10">${emptyState('Could not load imports', e.message)}</td></tr>`;
    }
  }

  qs('#supplierFilter', view).onchange = (e) => { state.supplierId = e.target.value; state.page = 1; load(); };
  qs('#statusFilter', view).onchange = (e) => { state.status = e.target.value; state.page = 1; load(); };
  qs('#importBtn', view).onclick = () => importWizard({ onDone: load });

  rows.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    if (btn.dataset.act === 'view') return previewDetail(id, load);
    if (btn.dataset.act === 'commit') return commitImport(id, load);
    if (btn.dataset.act === 'cancel') {
      const ok = await confirmDialog({ title: 'Discard this import?', message: 'The preview is thrown away. No catalogue changes were made.', confirmLabel: 'Discard' });
      if (!ok) return;
      try { const r = await api.post(`/supplier-imports/${id}/cancel`); toast(r.message); load(); }
      catch (err) { toastError(err); }
    }
  });

  await load();
}

async function commitImport(id, after) {
  const { data } = await api.get(`/supplier-imports/${id}`);
  const s = data.summary;
  const ok = await confirmDialog({
    title: 'Commit this import?',
    message: `${num(s.NEW)} new, ${num(s.UPDATED)} updated, ${num(s.UNCHANGED)} unchanged, ${num(s.ERRORS)} error(s) will be applied. Error rows are skipped.`,
    confirmLabel: 'Commit import',
    danger: false,
  });
  if (!ok) return;
  try {
    const r = await api.post(`/supplier-imports/${id}/commit`);
    toast(r.message);
    after?.();
  } catch (e) { toastError(e); }
}

async function previewDetail(id, after) {
  let data;
  try { ({ data } = await api.get(`/supplier-imports/${id}`)); }
  catch (e) { return toastError(e); }
  const s = data.summary;

  modal({
    title: `Import preview — ${data.supplier?.name || ''}`,
    size: 'lg',
    body: `
      <div class="import-summary">
        ${tile('NEW', s.NEW, 'var(--brand-600)')}
        ${tile('UPDATED', s.UPDATED, 'var(--warning,#d97706)')}
        ${tile('UNCHANGED', s.UNCHANGED, 'var(--text-muted)')}
        ${tile('ERRORS', s.ERRORS, 'var(--danger,#dc2626)')}
        ${tile('TOTAL ROWS', s.total, 'var(--text)')}
      </div>
      <div class="tabs tabs--scroll" style="margin-top:14px" role="tablist">
        <button class="tab" role="tab" aria-selected="true" data-tab="rows">Rows (${num(data.preview.length)})</button>
        <button class="tab" role="tab" aria-selected="false" data-tab="errors">Errors (${num((data.errorLog || []).length)})</button>
      </div>
      <div id="previewBody" class="preview-table" style="margin-top:10px"></div>`,
    footer: data.status === 'PREVIEWING'
      ? `<button class="btn btn--ghost" data-close>Close</button>
         <button class="btn btn--danger" id="discardBtn">Discard</button>
         <button class="btn btn--primary" id="commitBtn">Commit ${num(s.NEW + s.UPDATED)} change(s)</button>`
      : `<button class="btn btn--ghost" data-close>Close</button>`,
    onMount: ({ root, close }) => {
      const body = qs('#previewBody', root);
      const show = (tab) => {
        qs('.tab', root).setAttribute('aria-selected', String(tab === 'rows'));
        qsa('.tab', root).forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === tab)));
        body.innerHTML = tab === 'rows' ? rowsTable() : errorsTable();
      };
      qsa('.tab', root).forEach((t) => { t.onclick = () => show(t.dataset.tab); });

      function rowsTable() {
        if (!data.preview.length) return emptyState('No rows', 'This feed produced no rows.');
        return `<div class="table-wrap"><table class="data"><thead><tr>
          <th>#</th><th>Verdict</th><th>Supplier SKU</th><th>Product</th><th class="num">Cost</th>
          <th class="num">Price</th><th class="num">Stock</th><th>Matched product</th><th>Detail</th></tr></thead>
          <tbody>${data.preview.map((r) => `<tr>
            <td class="num">${num(r.row)}</td>
            <td>${statusBadge(r.verdict === 'ERROR' ? 'FAILED' : r.verdict === 'NEW' ? 'NEW' : r.verdict === 'UPDATED' ? 'CHANGED' : 'OK', r.verdict)}</td>
            <td><code>${esc(r.record.supplierSku || '—')}</code></td>
            <td>${esc(r.record.name || '—')}${r.record.brand ? `<div class="cell-sub">${esc(r.record.brand)}</div>` : ''}</td>
            <td class="num">${money(r.record.supplierCost || 0)}</td>
            <td class="num">${r.price ? money(r.price.price) : '—'}</td>
            <td class="num">${num(r.record.stock || 0)}</td>
            <td>${r.matchedProduct ? `<code>${esc(r.matchedProduct.sku)}</code><div class="cell-sub">${esc(r.matchedProduct.matchKey)}</div>` : '<span class="cell-sub">No match</span>'}</td>
            <td>${(r.changes || []).length
              ? r.changes.slice(0, 3).map((c) => `<div class="diff-row"><span>${esc(c.field)}</span><span class="diff-row__from">${esc(String(c.from ?? '—'))}</span><span class="diff-row__to">${esc(String(c.to ?? '—'))}</span></div>`).join('')
              : (r.errors || []).map((e) => `<span style="color:var(--danger)">${esc(e.field)}: ${esc(e.message)}</span>`).join('<br>') || '<span class="cell-sub">No change</span>'}</td>
          </tr>`).join('')}</tbody></table></div>`;
      }

      function errorsTable() {
        if (!data.errorLog.length) return emptyState('No errors', 'Every row in this feed validated cleanly.');
        return `<div class="table-wrap"><table class="data"><thead><tr><th>Row</th><th>SKU</th><th>Field</th><th>Problem</th></tr></thead>
          <tbody>${data.errorLog.flatMap((entry) => (entry.errors || []).map((e) => `<tr>
            <td class="num">${num(entry.row)}</td><td><code>${esc(entry.sku || '—')}</code></td>
            <td>${esc(e.field)}</td><td>${esc(e.message)}</td></tr>`)).join('')}</tbody></table></div>`;
      }

      show('rows');

      const commitBtn = qs('#commitBtn', root);
      if (commitBtn) {
        commitBtn.onclick = async () => { close(); await commitImport(id, after); };
      }
      const discardBtn = qs('#discardBtn', root);
      if (discardBtn) {
        discardBtn.onclick = async () => {
          const ok = await confirmDialog({ title: 'Discard this import?', message: 'The preview is thrown away.', confirmLabel: 'Discard' });
          if (!ok) return;
          try { await api.post(`/supplier-imports/${id}/cancel`); toast('Import discarded'); close(); after?.(); }
          catch (e) { toastError(e); }
        };
      }
    },
  });
}

function tile(label, value, color) {
  return `<div class="import-summary__tile"><div class="import-summary__value" style="color:${color}">${num(value)}</div>
    <div class="import-summary__label">${esc(label)}</div></div>`;
}

/* ------------------------------------------------------------------ wizard */

function importWizard({ onDone }) {
  modal({
    title: 'New catalogue import',
    size: 'lg',
    body: `<form id="importForm" novalidate>
      <div class="grid grid--form">
        <div class="field"><label for="imp-supplier">Supplier *</label>
          <select id="imp-supplier" name="supplierId" required>
            <option value="">Choose a supplier…</option>
            ${suppliers.filter((s) => s.status !== 'ARCHIVED').map((s) =>
              `<option value="${esc(s.id)}" ${state.supplierId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
          </select></div>
        <div class="field"><label for="imp-mode">Source</label>
          <select id="imp-mode" name="mode">
            <option value="file">Upload a file (CSV / XML / JSON)</option>
            <option value="integration">Pull from the connected supplier</option>
            <option value="paste">Paste feed content</option>
          </select></div>
        <div class="field span-2" id="fileField"><label for="imp-file">Feed file</label>
          <input id="imp-file" type="file" accept=".csv,.tsv,.xml,.json,text/csv,application/json,text/xml"
            class="dz" style="padding:18px;width:100%"></div>
        <div class="field span-2" id="pasteField" hidden><label for="imp-content">Feed content</label>
          <textarea id="imp-content" rows="8" placeholder="sku,name,cost,stock&#10;AC-12K,12000 BTU Split,412.50,48"></textarea></div>
        <div class="field"><label for="imp-items">Item node path (XML / JSON)</label>
          <input id="imp-items" name="itemsPath" placeholder="catalog.product"></div>
        <div class="field"><label for="imp-limit">Max rows to pull</label>
          <input id="imp-limit" type="number" name="limit" min="1" max="5000" value="500"></div>
        <div class="field span-2"><label class="checkline">
          <input type="checkbox" name="publish"> Publish matched products to the storefront on commit</label></div>
      </div>
      <div class="alert alert--info" style="margin-top:10px">
        ${icon('shield')} Feeds are parsed server-side with formula-injection neutralisation, size and row caps, and
        DTD/entity rejection for XML. Nothing is written until you commit the preview.</div>
    </form>`,
    footer: `<button class="btn btn--ghost" data-close>Cancel</button>
             <button class="btn btn--primary" id="previewBtn">${icon('eye')} Build preview</button>`,
    onMount: ({ root, close }) => {
      const modeSelect = qs('#imp-mode', root);
      const syncMode = () => {
        qs('#fileField', root).hidden = modeSelect.value !== 'file';
        qs('#pasteField', root).hidden = modeSelect.value !== 'paste';
      };
      modeSelect.onchange = syncMode;
      syncMode();

      qs('#previewBtn', root).onclick = async () => {
        const supplierId = qs('#imp-supplier', root).value;
        if (!supplierId) return toast('Choose a supplier first', 'warning');
        const itemsPath = qs('#imp-items', root).value.trim() || undefined;
        const limit = Number(qs('#imp-limit', root).value) || 500;
        const publish = qs('input[name="publish"]', root).checked;
        const btn = qs('#previewBtn', root);
        btn.disabled = true;
        btn.textContent = 'Parsing…';

        try {
          let result;
          if (modeSelect.value === 'file') {
            const file = qs('#imp-file', root).files[0];
            if (!file) { toast('Choose a file first', 'warning'); return; }
            const fd = new FormData();
            fd.append('file', file);
            fd.append('supplierId', supplierId);
            if (itemsPath) fd.append('itemsPath', itemsPath);
            result = await api.upload('/supplier-imports/preview-file', fd);
          } else if (modeSelect.value === 'paste') {
            const content = qs('#imp-content', root).value;
            if (!content.trim()) { toast('Paste some feed content first', 'warning'); return; }
            result = await api.post('/supplier-imports/preview', { supplierId, content, itemsPath });
          } else {
            result = await api.post('/supplier-imports/preview-integration', { supplierId, limit });
          }
          close();
          toast(result.message, result.data.summary.ERRORS ? 'warning' : 'success');
          if (publish) sessionStorage.setItem('nds.import.autopublish', result.data.importId);
          previewDetail(result.data.importId, onDone);
          onDone?.();
        } catch (e) {
          toastError(e);
        } finally {
          btn.disabled = false;
          btn.innerHTML = `${icon('eye')} Build preview`;
        }
      };
    },
  });
}
