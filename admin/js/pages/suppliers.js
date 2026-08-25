/** Supplier Marketplace → Suppliers: full supplier lifecycle management. */
import { api, auth } from '../api.js';
import { setTitle } from '../layout.js';
import {
  el, qs, qsa, icon, esc, money, num, statusBadge, debounce, skeletonRows, emptyState,
  pagination, modal, confirmDialog, formData, showFieldErrors, toast, toastError,
  dateTime, relative, titleCase,
} from '../ui.js';
import { sectionHead, kvList } from './supplier-nav.js';

const state = { page: 1, limit: 20, search: '', status: 'ACTIVE', type: '', country: '', sort: 'createdAt', order: 'desc' };
let vocabulary = { supplierTypes: [], fulfillmentTypes: [], shippingMethods: [], countries: [], currencies: [] };

export async function render(view, query) {
  setTitle('Suppliers');
  Object.assign(state, { page: 1, search: query.search || '', status: query.status || 'ACTIVE' });

  view.innerHTML = `
    ${sectionHead({
      title: 'Suppliers',
      subtitle: 'Every trade supplier, distributor and manufacturer you source from.',
      active: '/suppliers',
      actions: `<button class="btn btn--primary" id="newBtn">${icon('plus')} Add supplier</button>`,
    })}
    <section class="card">
      <div class="toolbar">
        <label class="sr-only" for="searchInput">Search suppliers</label>
        <input id="searchInput" class="toolbar__search" type="search" placeholder="Search by name, code, email or account…" value="${esc(state.search)}">
        <label class="sr-only" for="statusFilter">Status</label>
        <select id="statusFilter">
          <option value="ACTIVE">Active</option><option value="DISABLED">Disabled</option>
          <option value="ARCHIVED">Archived</option><option value="ALL">All statuses</option>
        </select>
        <label class="sr-only" for="typeFilter">Trade</label>
        <select id="typeFilter"><option value="">All trades</option></select>
        <label class="sr-only" for="countryFilter">Country</label>
        <select id="countryFilter"><option value="">All countries</option></select>
        <button class="btn btn--subtle btn--sm" id="resetBtn">Reset</button>
      </div>
      <div class="table-wrap"><table class="data">
        <caption class="sr-only">Suppliers</caption>
        <thead><tr>
          <th scope="col" class="sortable" data-sort="name">Supplier</th>
          <th scope="col">Trade</th>
          <th scope="col" class="sortable" data-sort="country">Country</th>
          <th scope="col">Integration</th>
          <th scope="col">Fulfilment</th>
          <th scope="col" class="num">Products</th>
          <th scope="col">Status</th>
          <th scope="col" style="text-align:right">Actions</th>
        </tr></thead>
        <tbody id="rows">${skeletonRows(8)}</tbody></table></div>
      <div class="card__foot" id="pager"></div>
    </section>`;

  qs('#statusFilter', view).value = state.status;

  try {
    const { data } = await api.get('/suppliers/types');
    vocabulary = data;
    qs('#typeFilter', view).innerHTML = `<option value="">All trades</option>${data.supplierTypes.map((t) =>
      `<option value="${esc(t)}" ${state.type === t ? 'selected' : ''}>${esc(titleCase(t))}</option>`).join('')}`;
    qs('#countryFilter', view).innerHTML = `<option value="">All countries</option>${data.countries.map((c) =>
      `<option value="${esc(c.code)}">${esc(c.name)}</option>`).join('')}`;
  } catch (e) { toastError(e); }

  const rows = qs('#rows', view);
  const pager = qs('#pager', view);

  async function load() {
    rows.innerHTML = skeletonRows(8);
    try {
      const { data, meta } = await api.get('/suppliers', {
        page: state.page, limit: state.limit, search: state.search, status: state.status,
        type: state.type, country: state.country, sort: state.sort, order: state.order,
      });
      if (!data.length) {
        rows.innerHTML = `<tr><td colspan="8">${emptyState('No suppliers found',
          state.search || state.type ? 'Try adjusting your search or filters.' : 'Add your first supplier to start importing catalogues.',
          '<button class="btn btn--primary" onclick="document.getElementById(\'newBtn\').click()">Add supplier</button>')}</td></tr>`;
        pager.innerHTML = '';
        return;
      }
      rows.innerHTML = data.map(rowMarkup).join('');
      pager.innerHTML = '';
      pager.appendChild(pagination(meta, (p) => { state.page = p; load(); }));
    } catch (e) {
      rows.innerHTML = `<tr><td colspan="8">${emptyState('Could not load suppliers', e.message)}</td></tr>`;
    }
  }

  function rowMarkup(s) {
    const integration = s.integration;
    const conn = !integration
      ? '<span class="badge badge--muted">No connector</span>'
      : `${statusBadge(integration.status)}<div class="cell-sub">${esc(integration.connectorType)}</div>`;
    return `<tr data-id="${esc(s.id)}">
      <td><div class="cell-main">${esc(s.name)}</div><div class="cell-sub"><code>${esc(s.code)}</code>${s.accountRef ? ` · acct ${esc(s.accountRef)}` : ''}</div></td>
      <td>${esc(titleCase(s.type))}</td>
      <td>${esc(s.country || '—')}</td>
      <td>${conn}</td>
      <td>${statusBadge(s.fulfillmentType, titleCase(s.fulfillmentType))}</td>
      <td class="num">${num(s.counts.products)}${s.counts.published ? `<div class="cell-sub">${num(s.counts.published)} live</div>` : ''}</td>
      <td>${statusBadge(s.status)}</td>
      <td><div class="row-actions">
        <button class="btn btn--ghost btn--icon" data-act="view" aria-label="View ${esc(s.name)}">${icon('eye')}</button>
        <button class="btn btn--ghost btn--icon" data-act="edit" aria-label="Edit ${esc(s.name)}">${icon('edit')}</button>
        <button class="btn btn--ghost btn--icon" data-act="toggle" aria-label="${s.status === 'ACTIVE' ? 'Disable' : 'Enable'} ${esc(s.name)}">${icon(s.status === 'ACTIVE' ? 'eyeOff' : 'check')}</button>
        <button class="btn btn--ghost btn--icon" data-act="archive" aria-label="Archive ${esc(s.name)}" ${auth.isAdmin ? '' : 'disabled'}>${icon('archive')}</button>
      </div></td></tr>`;
  }

  /* ------------------------------------------------------------- filters */
  qs('#searchInput', view).addEventListener('input', debounce((e) => { state.search = e.target.value.trim(); state.page = 1; load(); }));
  qs('#statusFilter', view).onchange = (e) => { state.status = e.target.value; state.page = 1; load(); };
  qs('#typeFilter', view).onchange = (e) => { state.type = e.target.value; state.page = 1; load(); };
  qs('#countryFilter', view).onchange = (e) => { state.country = e.target.value; state.page = 1; load(); };
  qs('#resetBtn', view).onclick = () => {
    Object.assign(state, { search: '', status: 'ACTIVE', type: '', country: '', page: 1 });
    qs('#searchInput', view).value = ''; qs('#statusFilter', view).value = 'ACTIVE';
    qs('#typeFilter', view).value = ''; qs('#countryFilter', view).value = '';
    load();
  };
  qsa('.sortable', view).forEach((th) => {
    th.onclick = () => {
      const field = th.dataset.sort;
      if (state.sort === field) state.order = state.order === 'asc' ? 'desc' : 'asc';
      else { state.sort = field; state.order = 'asc'; }
      load();
    };
  });

  /* -------------------------------------------------------------- actions */
  qs('#newBtn', view).onclick = () => supplierForm({ onSaved: load });

  rows.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    const action = btn.dataset.act;
    if (action === 'view') return supplierDetail(id, load);
    if (action === 'edit') {
      const { data } = await api.get(`/suppliers/${id}`);
      return supplierForm({ supplier: data, onSaved: load });
    }
    if (action === 'toggle') {
      const { data } = await api.get(`/suppliers/${id}`);
      const next = data.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
      const ok = await confirmDialog({
        title: next === 'DISABLED' ? 'Disable supplier?' : 'Enable supplier?',
        message: next === 'DISABLED'
          ? `${data.name} will stop accepting new orders and its scheduled syncs will pause. Its catalogue stays intact.`
          : `${data.name} will become available again.`,
        confirmLabel: next === 'DISABLED' ? 'Disable' : 'Enable',
        danger: next === 'DISABLED',
      });
      if (!ok) return;
      try {
        await api.patch(`/suppliers/${id}/status`, { status: next });
        toast(`${data.name} ${next === 'DISABLED' ? 'disabled' : 'enabled'}`);
        load();
      } catch (err) { toastError(err); }
      return;
    }
    if (action === 'archive') {
      const ok = await confirmDialog({
        title: 'Archive supplier?',
        message: 'Archiving hides the supplier and pauses its syncs. Nothing is deleted and it can be restored.',
        confirmLabel: 'Archive',
      });
      if (!ok) return;
      try {
        const r = await api.post(`/suppliers/${id}/archive`);
        toast(r.message || 'Supplier archived');
        load();
      } catch (err) { toastError(err); }
    }
  });

  await load();
}

/* ------------------------------------------------------------------ detail */

async function supplierDetail(id, onChanged) {
  let data;
  try { ({ data } = await api.get(`/suppliers/${id}`)); }
  catch (e) { return toastError(e); }

  const s = data;
  const countriesLabel = s.countriesServed.length
    ? s.countriesServed.map((c) => esc(c)).join(', ')
    : 'Worldwide (no allow-list set)';

  modal({
    title: s.name,
    size: 'lg',
    body: `
      <div class="tabs tabs--scroll" role="tablist" aria-label="Supplier sections">
        <button class="tab" role="tab" aria-selected="true" data-tab="overview">Overview</button>
        <button class="tab" role="tab" aria-selected="false" data-tab="products">Products (${num(s._count.products)})</button>
        <button class="tab" role="tab" aria-selected="false" data-tab="syncs">Sync history (${num(s._count.syncs)})</button>
        <button class="tab" role="tab" aria-selected="false" data-tab="fulfillment">Fulfilments (${num(s._count.fulfillments)})</button>
      </div>
      <div id="tabBody" style="padding-top:14px"><div class="spinner"></div></div>`,
    footer: `<button class="btn btn--ghost" data-close>Close</button>
      <a class="btn btn--subtle" href="#/supplier-integrations">Integrations</a>
      <button class="btn btn--primary" id="runSync">Run sync now</button>`,
    onMount: ({ root, close }) => {
      const body = qs('#tabBody', root);
      const show = async (tab) => {
        qsa('.tab', root).forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === tab)));
        body.innerHTML = '<div class="spinner"></div>';
        if (tab === 'overview') return renderOverview(body);
        if (tab === 'products') return renderProducts(body);
        if (tab === 'syncs') return renderSyncs(body);
        return renderFulfillments(body);
      };
      qsa('.tab', root).forEach((t) => { t.onclick = () => show(t.dataset.tab); });

      const renderOverview = (host) => {
        host.innerHTML = `
          ${kvList([
            ['Code', `<code>${esc(s.code)}</code>`],
            ['Status', statusBadge(s.status)],
            ['Trade', esc(titleCase(s.type))],
            ['Fulfilment', statusBadge(s.fulfillmentType, titleCase(s.fulfillmentType))],
            ['Country', esc(s.country || '—')],
            ['Currency', esc(s.currency)],
            ['Website', s.website ? `<a href="${esc(s.website)}" target="_blank" rel="noopener">${esc(s.website)}</a>` : null],
            ['Contact', [s.contactName, s.email, s.phone].filter(Boolean).map(esc).join('<br>') || null],
            ['Account reference', esc(s.accountRef)],
            ['Countries served', countriesLabel],
            ['Blocked countries', s.blockedCountries.length ? esc(s.blockedCountries.join(', ')) : '—'],
            ['Shipping methods', s.shippingMethods.length ? esc(s.shippingMethods.join(', ')) : '—'],
            ['Lead time', `${num(s.leadTimeDays)} day(s)`],
            ['Minimum order', money(s.minOrderValue)],
            ['Dropshipping', s.dropshipEnabled ? 'Enabled' : 'Disabled'],
            ['Default markup', s.markupType ? `${s.markupType === 'PERCENT' ? `${s.markupValue}%` : money(s.markupValue)}` : 'Uses global default'],
            ['Integration', s.integration ? `${esc(s.integration.name)} · ${esc(s.integration.connectorType)} ${statusBadge(s.integration.status)}` : 'Not configured'],
            ['Created', dateTime(s.createdAt)],
          ])}
          ${s.notes ? `<div class="alert alert--info" style="margin-top:12px">${esc(s.notes)}</div>` : ''}
          <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn--subtle btn--sm" data-quick="products">${icon('box')} View products</button>
            <button class="btn btn--subtle btn--sm" data-quick="syncs">${icon('refresh')} Sync history</button>
            <button class="btn btn--subtle btn--sm" data-quick="fulfillment">${icon('truck')} Fulfilments</button>
          </div>`;
        qsa('[data-quick]', host).forEach((b) => { b.onclick = () => show(b.dataset.quick); });
      };

      const renderProducts = async (host) => {
        try {
          const { data: items, meta } = await api.get(`/suppliers/${s.id}/products`, { limit: 10 });
          if (!items.length) { host.innerHTML = emptyState('No supplier products', 'Import a catalogue to populate this supplier.'); return; }
          host.innerHTML = `<div class="table-wrap"><table class="data"><thead><tr>
            <th>Supplier SKU</th><th>Product</th><th class="num">Cost</th><th class="num">Price</th>
            <th class="num">Supplier stock</th><th>Mapping</th><th>Published</th></tr></thead>
            <tbody>${items.map((p) => `<tr>
              <td><code>${esc(p.supplierSku)}</code></td>
              <td>${esc(p.name)}</td>
              <td class="num">${money(p.supplierCost)}</td>
              <td class="num">${money(p.sellingPrice)}</td>
              <td class="num">${num(p.stock)}</td>
              <td>${statusBadge(p.mappingStatus)}${p.mapping?.product ? `<div class="cell-sub">${esc(p.mapping.product.sku)}</div>` : ''}</td>
              <td>${p.published ? '<span class="badge badge--success">Live</span>' : '<span class="badge badge--muted">Draft</span>'}</td></tr>`).join('')}
            </tbody></table></div>
            <div class="cell-sub" style="margin-top:8px">Showing ${items.length} of ${num(meta.total)} — <a href="#/supplier-products?supplierId=${esc(s.id)}">open Supplier Products</a></div>`;
        } catch (e) { host.innerHTML = emptyState('Could not load products', e.message); }
      };

      const renderSyncs = async (host) => {
        try {
          const { data: items, meta } = await api.get(`/suppliers/${s.id}/syncs`, { limit: 10 });
          if (!items.length) { host.innerHTML = emptyState('No synchronisations yet', 'Run one from Sync & Automation.'); return; }
          host.innerHTML = `<div class="table-wrap"><table class="data"><thead><tr>
            <th>Type</th><th>Trigger</th><th>Status</th><th class="num">Processed</th>
            <th class="num">Created</th><th class="num">Updated</th><th class="num">Errors</th><th>Started</th></tr></thead>
            <tbody>${items.map((r) => `<tr>
              <td>${esc(r.type)}</td><td>${esc(r.trigger.toLowerCase())}</td><td>${statusBadge(r.status)}</td>
              <td class="num">${num(r.processed)}</td><td class="num">${num(r.created)}</td>
              <td class="num">${num(r.updated)}</td><td class="num">${num(r.errorCount)}</td>
              <td>${dateTime(r.startedAt)}</td></tr>`).join('')}</tbody></table></div>
              <div class="cell-sub" style="margin-top:8px">${num(meta.total)} run(s) total — <a href="#/supplier-logs?supplierId=${esc(s.id)}">full log</a></div>`;
        } catch (e) { host.innerHTML = emptyState('Could not load sync history', e.message); }
      };

      const renderFulfillments = async (host) => {
        try {
          const { data: items, meta } = await api.get(`/suppliers/${s.id}/fulfillments`, { limit: 10 });
          if (!items.length) { host.innerHTML = emptyState('No fulfilments yet', 'Supplier fulfilments appear once customers order dropshipped items.'); return; }
          host.innerHTML = `<div class="table-wrap"><table class="data"><thead><tr>
            <th>Order</th><th>Status</th><th>Items</th><th>Tracking</th><th>Created</th></tr></thead>
            <tbody>${items.map((f) => `<tr>
              <td><code>${esc(f.order.reference)}</code><div class="cell-sub">${money(f.order.total)}</div></td>
              <td>${statusBadge(f.status)}</td>
              <td class="num">${num(f.items.reduce((a, i) => a + i.quantity, 0))}</td>
              <td>${f.trackingNumber ? `<code>${esc(f.trackingNumber)}</code><div class="cell-sub">${esc(f.carrier || '')}</div>` : '<span class="cell-sub">—</span>'}</td>
              <td>${dateTime(f.createdAt)}</td></tr>`).join('')}</tbody></table></div>
              <div class="cell-sub" style="margin-top:8px">${num(meta.total)} fulfilment(s) — <a href="#/supplier-fulfillment?supplierId=${esc(s.id)}">open Fulfilment</a></div>`;
        } catch (e) { host.innerHTML = emptyState('Could not load fulfilments', e.message); }
      };

      qs('#runSync', root).onclick = async () => {
        if (!s.integration) {
          close();
          toast('Add an integration for this supplier before synchronising.', 'warning');
          location.hash = '#/supplier-integrations';
          return;
        }
        try {
          const r = await api.post('/supplier-syncs', { supplierId: s.id, type: 'FULL' });
          toast(r.message);
          close();
          location.hash = '#/supplier-logs';
          onChanged?.();
        } catch (e) { toastError(e); }
      };

      show('overview');
    },
  });
}

/* -------------------------------------------------------------------- form */

function supplierForm({ supplier = null, onSaved }) {
  const editing = Boolean(supplier);
  const s = supplier || {};
  const options = (list, selected = []) => list.map((c) =>
    `<option value="${esc(c)}" ${selected.includes(c) ? 'selected' : ''}>${esc(c)}</option>`).join('');

  modal({
    title: editing ? `Edit ${s.name}` : 'Add supplier',
    size: 'lg',
    body: `<form id="supplierForm" novalidate>
      <div class="grid grid--form">
        <div class="field span-2"><label for="f-name">Supplier name *</label>
          <input id="f-name" name="name" required maxlength="140" value="${esc(s.name || '')}"></div>
        <div class="field"><label for="f-code">Supplier code</label>
          <input id="f-code" name="code" maxlength="24" value="${esc(s.code || '')}" placeholder="Auto-generated from the name"></div>
        <div class="field"><label for="f-type">Trade / supplier type</label>
          <select id="f-type" name="type">${vocabulary.supplierTypes.map((t) =>
            `<option value="${esc(t)}" ${(s.type || 'GENERAL') === t ? 'selected' : ''}>${esc(titleCase(t))}</option>`).join('')}</select>
          <small class="secret-field__hint">Not on the list? Type a new one — types are extensible.</small>
          <input id="f-type-custom" name="typeCustom" placeholder="e.g. SOLAR" maxlength="40" style="margin-top:6px"></div>
        <div class="field"><label for="f-fulfillment">Fulfilment method</label>
          <select id="f-fulfillment" name="fulfillmentType">${vocabulary.fulfillmentTypes.map((f) =>
            `<option value="${esc(f.id)}" ${(s.fulfillmentType || 'HYBRID') === f.id ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select></div>
        <div class="field"><label for="f-country">Supplier country</label>
          <select id="f-country" name="country"><option value="">Not specified</option>
            ${vocabulary.countries.map((c) => `<option value="${esc(c.code)}" ${s.country === c.code ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="f-currency">Currency</label>
          <select id="f-currency" name="currency">${vocabulary.currencies.map((c) =>
            `<option value="${esc(c.code)}" ${(s.currency || 'USD') === c.code ? 'selected' : ''}>${esc(c.code)} — ${esc(c.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="f-website">Website</label>
          <input id="f-website" name="website" type="url" maxlength="300" value="${esc(s.website || '')}"></div>
        <div class="field"><label for="f-email">Email</label>
          <input id="f-email" name="email" type="email" maxlength="140" value="${esc(s.email || '')}"></div>
        <div class="field"><label for="f-phone">Phone</label>
          <input id="f-phone" name="phone" maxlength="40" value="${esc(s.phone || '')}"></div>
        <div class="field"><label for="f-contact">Contact person</label>
          <input id="f-contact" name="contactName" maxlength="140" value="${esc(s.contactName || '')}"></div>
        <div class="field"><label for="f-account">Account reference</label>
          <input id="f-account" name="accountRef" maxlength="80" value="${esc(s.accountRef || '')}"></div>
        <div class="field"><label for="f-lead">Lead time (days)</label>
          <input id="f-lead" name="leadTimeDays" type="number" min="0" max="365" value="${s.leadTimeDays ?? 0}"></div>
        <div class="field"><label for="f-min">Minimum order value</label>
          <input id="f-min" name="minOrderValue" type="number" min="0" step="0.01" value="${s.minOrderValue ?? 0}"></div>
        <div class="field"><label for="f-terms">Payment terms</label>
          <input id="f-terms" name="paymentTerms" maxlength="200" value="${esc(s.paymentTerms || '')}" placeholder="Net 30"></div>
        <div class="field"><label for="f-markupType">Default markup</label>
          <select id="f-markupType" name="markupType">
            <option value="">Use global default</option>
            <option value="PERCENT" ${s.markupType === 'PERCENT' ? 'selected' : ''}>Percentage</option>
            <option value="FIXED" ${s.markupType === 'FIXED' ? 'selected' : ''}>Fixed amount</option>
          </select></div>
        <div class="field"><label for="f-markupValue">Markup value</label>
          <input id="f-markupValue" name="markupValue" type="number" step="0.01" value="${s.markupValue ?? ''}"></div>
        <div class="field span-2"><label for="f-served">Countries served</label>
          <select id="f-served" name="countriesServed" multiple size="5">${options(vocabulary.countries.map((c) => c.code), s.countriesServed || [])}</select>
          <small class="secret-field__hint">Leave empty for worldwide. Regions (e.g. CARIBBEAN) are accepted too — comma-separate them in the text box below.</small>
          <input id="f-served-text" name="countriesServedText" placeholder="CARIBBEAN, TT, JM" style="margin-top:6px"></div>
        <div class="field span-2"><label for="f-blocked">Blocked countries</label>
          <input id="f-blocked" name="blockedCountriesText" placeholder="Comma-separated codes or region names" value="${esc((s.blockedCountries || []).join(', '))}"></div>
        <div class="field span-2"><label for="f-methods">Shipping methods offered</label>
          <select id="f-methods" name="shippingMethods" multiple size="4">${options(vocabulary.shippingMethods.map((m) => m.code), s.shippingMethods || [])}</select></div>
        <div class="field span-2"><label for="f-notes">Notes</label>
          <textarea id="f-notes" name="notes" rows="3" maxlength="4000">${esc(s.notes || '')}</textarea></div>
        <div class="field span-2"><label class="checkline">
          <input type="checkbox" name="dropshipEnabled" ${s.dropshipEnabled === false ? '' : 'checked'}> Allow this supplier to dropship directly to customers</label></div>
      </div>
    </form>`,
    footer: `<button class="btn btn--ghost" data-close>Cancel</button>
             <button class="btn btn--primary" id="saveBtn">${editing ? 'Save changes' : 'Add supplier'}</button>`,
    onMount: ({ root, close }) => {
      const form = qs('#supplierForm', root);
      qs('#saveBtn', root).onclick = async () => {
        const payload = formData(form);
        const customType = String(payload.typeCustom || '').trim().toUpperCase();
        if (customType) payload.type = customType;
        delete payload.typeCustom;

        const servedText = String(payload.countriesServedText || '').trim();
        const served = [...new Set([...(Array.isArray(payload.countriesServed) ? payload.countriesServed : []),
          ...servedText.split(',').map((v) => v.trim()).filter(Boolean)])];
        payload.countriesServed = served.length ? served : null;
        delete payload.countriesServedText;

        const blocked = String(payload.blockedCountriesText || '').split(',').map((v) => v.trim()).filter(Boolean);
        payload.blockedCountries = blocked.length ? blocked : null;
        delete payload.blockedCountriesText;

        if (!payload.markupType) { payload.markupType = null; payload.markupValue = null; }
        if (payload.markupValue === undefined) payload.markupValue = null;

        try {
          if (editing) { await api.put(`/suppliers/${s.id}`, payload); toast('Supplier updated'); }
          else { await api.post('/suppliers', payload); toast('Supplier added — now configure its connector.'); }
          close();
          onSaved?.();
        } catch (e) { showFieldErrors(form, e); }
      };
    },
  });
}
