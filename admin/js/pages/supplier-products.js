/** Supplier Marketplace → Supplier Products. */
import { api, auth } from '../api.js';
import { setTitle } from '../layout.js';
import {
  qs, qsa, icon, esc, money, num, statusBadge, debounce, skeletonRows, emptyState,
  pagination, modal, confirmDialog, formData, showFieldErrors, toast, toastError,
  dateTime, relative, titleCase,
} from '../ui.js';
import { sectionHead, kvList } from './supplier-nav.js';

const state = {
  page: 1, limit: 20, search: '', supplierId: '', published: '', mapping: '',
  syncStatus: '', fulfillmentType: '', restricted: '', sort: 'createdAt', order: 'desc',
};
let suppliers = [];
let products = [];
let selected = new Set();

export async function render(view, query) {
  setTitle('Supplier Products');
  Object.assign(state, { page: 1, search: query.search || '', supplierId: query.supplierId || '' });
  selected = new Set();

  view.innerHTML = `
    ${sectionHead({
      title: 'Supplier Products',
      subtitle: 'What suppliers advertise versus what N&D sells. Supplier stock is never counted as N&D-owned inventory.',
      active: '/supplier-products',
    })}
    <section class="card">
      <div class="toolbar">
        <label class="sr-only" for="searchInput">Search supplier products</label>
        <input id="searchInput" class="toolbar__search" type="search" placeholder="Search by SKU, name, brand, MPN or UPC…" value="${esc(state.search)}">
        <label class="sr-only" for="supplierFilter">Supplier</label>
        <select id="supplierFilter"><option value="">All suppliers</option></select>
        <label class="sr-only" for="publishedFilter">Published</label>
        <select id="publishedFilter"><option value="">Published &amp; draft</option>
          <option value="true">Published</option><option value="false">Draft</option></select>
        <label class="sr-only" for="mappingFilter">Mapping</label>
        <select id="mappingFilter"><option value="">Any mapping</option>
          <option value="MAPPED">Mapped</option><option value="UNMAPPED">Unmapped</option>
          <option value="MANUAL">Manually mapped</option></select>
        <label class="sr-only" for="fulfillmentFilter">Fulfilment</label>
        <select id="fulfillmentFilter"><option value="">Any fulfilment</option>
          <option value="LOCAL">Local</option><option value="SUPPLIER_FULFILLED">Supplier fulfilled</option>
          <option value="HYBRID">Hybrid</option></select>
        <label class="sr-only" for="restrictedFilter">Restricted</label>
        <select id="restrictedFilter"><option value="">All products</option>
          <option value="true">Restricted only</option></select>
        <button class="btn btn--subtle btn--sm" id="resetBtn">Reset</button>
      </div>
      <div class="bulkbar" id="bulkbar">
        <span class="bulkbar__count" id="bulkCount">0 selected</span>
        <button class="btn btn--ghost btn--sm" id="bulkPublishBtn">${icon('upload')} Publish selected</button>
        <button class="btn btn--subtle btn--sm" id="bulkUnpublishBtn">Unpublish selected</button>
        <button class="btn btn--subtle btn--sm" id="clearSelBtn">Clear</button>
      </div>
      <div class="table-wrap"><table class="data">
        <caption class="sr-only">Supplier products</caption>
        <thead><tr>
          <th style="width:38px"><input type="checkbox" id="selectAll" aria-label="Select all on this page"></th>
          <th scope="col" class="sortable" data-sort="supplierSku">Supplier SKU</th>
          <th scope="col" class="sortable" data-sort="name">Product</th>
          <th scope="col">Supplier</th>
          <th scope="col" class="num sortable" data-sort="supplierCost">Cost</th>
          <th scope="col" class="num sortable" data-sort="sellingPrice">Price</th>
          <th scope="col">Stock (N&amp;D / supplier / available)</th>
          <th scope="col">Mapping</th>
          <th scope="col">Sync</th>
          <th scope="col">Status</th>
          <th scope="col" style="text-align:right">Actions</th>
        </tr></thead>
        <tbody id="rows">${skeletonRows(11)}</tbody></table></div>
      <div class="card__foot" id="pager"></div>
    </section>`;

  const rows = qs('#rows', view);
  const pager = qs('#pager', view);

  try {
    const [{ data: supplierPage }, { data: productPage }] = await Promise.all([
      api.get('/suppliers', { status: 'ALL', limit: 100 }),
      api.get('/products', { limit: 100 }),
    ]);
    suppliers = supplierPage;
    products = productPage;
    qs('#supplierFilter', view).innerHTML = `<option value="">All suppliers</option>${suppliers.map((s) =>
      `<option value="${esc(s.id)}" ${state.supplierId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}`;
  } catch (e) { toastError(e); }

  async function load() {
    rows.innerHTML = skeletonRows(11);
    try {
      const { data, meta } = await api.get('/supplier-products', {
        page: state.page, limit: state.limit, search: state.search, supplierId: state.supplierId,
        published: state.published, mapping: state.mapping, syncStatus: state.syncStatus,
        fulfillmentType: state.fulfillmentType, restricted: state.restricted,
        sort: state.sort, order: state.order,
      });
      if (!data.length) {
        rows.innerHTML = `<tr><td colspan="11">${emptyState('No supplier products',
          'Import a catalogue from a supplier to populate this list.',
          '<a class="btn btn--primary" href="#/supplier-imports">Import products</a>')}</td></tr>`;
        pager.innerHTML = '';
        return;
      }
      rows.innerHTML = data.map(rowMarkup).join('');
      pager.innerHTML = '';
      pager.appendChild(pagination(meta, (p) => { state.page = p; load(); }));
      syncSelection();
    } catch (e) {
      rows.innerHTML = `<tr><td colspan="11">${emptyState('Could not load supplier products', e.message)}</td></tr>`;
    }
  }

  function rowMarkup(p) {
    const markupTone = p.markupPercent < 0 ? 'danger' : p.markupPercent < 15 ? 'warning' : 'success';
    return `<tr data-id="${esc(p.id)}">
      <td><input type="checkbox" class="rowsel" value="${esc(p.id)}" aria-label="Select ${esc(p.supplierSku)}" ${selected.has(p.id) ? 'checked' : ''}></td>
      <td><code>${esc(p.supplierSku)}</code>${p.restricted ? ` <span class="badge badge--danger badge--plain">${esc(p.restrictionType || 'Restricted')}</span>` : ''}</td>
      <td><div class="cell-flex">
        <img class="thumb" src="${esc(p.imageUrl || '../assets/images/placeholder-product.svg')}" alt="" loading="lazy" decoding="async"
             onerror="this.src='../assets/images/placeholder-product.svg'">
        <div><div class="cell-main">${esc(p.name)}</div>
        <div class="cell-sub">${esc(p.brand || '—')}${p.categoryText ? ` · ${esc(p.categoryText)}` : ''}</div></div></div></td>
      <td>${esc(p.supplierName || '—')}</td>
      <td class="num">${money(p.supplierCost)}</td>
      <td class="num">${money(p.sellingPrice)}
        <div class="cell-sub"><span class="badge badge--${markupTone} badge--plain">${p.markupPercent > 0 ? '+' : ''}${p.markupPercent}%</span>
        ${p.priceOverride !== null && p.priceOverride !== undefined ? ' override' : ''}</div></td>
      <td><span class="stock-split">
        <span title="N&D-owned stock">${num(p.localStock)}</span>
        <span class="stock-split__part">/ ${num(p.supplierStock)}</span>
        <span class="stock-split__part">/ <strong>${num(p.availableStock)}</strong></span></span>
        <div class="cell-sub">${statusBadge(p.fulfillmentType, titleCase(p.fulfillmentType))}</div></td>
      <td>${statusBadge(p.mappingStatus)}${p.internalSku ? `<div class="cell-sub"><code>${esc(p.internalSku)}</code></div>` : ''}</td>
      <td>${statusBadge(p.syncStatus)}<div class="cell-sub">${p.lastSyncedAt ? relative(p.lastSyncedAt) : 'never'}</div></td>
      <td>${p.published ? '<span class="badge badge--success">Published</span>' : '<span class="badge badge--muted">Draft</span>'}
          ${p.isActive ? '' : '<div class="cell-sub">Disabled</div>'}</td>
      <td><div class="row-actions">
        <button class="btn btn--ghost btn--icon" data-act="view" aria-label="View ${esc(p.name)}">${icon('eye')}</button>
        <button class="btn btn--ghost btn--icon" data-act="price" aria-label="Edit pricing">${icon('money')}</button>
        <button class="btn btn--ghost btn--icon" data-act="map" aria-label="Match to a platform product">${icon('link')}</button>
        <button class="btn btn--ghost btn--icon" data-act="publish" aria-label="${p.published ? 'Unpublish' : 'Publish'}">${icon(p.published ? 'eyeOff' : 'upload')}</button>
        <button class="btn btn--ghost btn--icon" data-act="history" aria-label="Sync history">${icon('history')}</button>
      </div></td></tr>`;
  }

  /* ------------------------------------------------------------- filters */
  qs('#searchInput', view).addEventListener('input', debounce((e) => { state.search = e.target.value.trim(); state.page = 1; load(); }));
  const bind = (id, key) => { qs(id, view).onchange = (e) => { state[key] = e.target.value; state.page = 1; load(); }; };
  bind('#supplierFilter', 'supplierId'); bind('#publishedFilter', 'published');
  bind('#mappingFilter', 'mapping'); bind('#fulfillmentFilter', 'fulfillmentType');
  bind('#restrictedFilter', 'restricted');
  qs('#resetBtn', view).onclick = () => {
    Object.assign(state, { search: '', supplierId: '', published: '', mapping: '', fulfillmentType: '', restricted: '', syncStatus: '', page: 1 });
    ['#searchInput', '#supplierFilter', '#publishedFilter', '#mappingFilter', '#fulfillmentFilter', '#restrictedFilter']
      .forEach((sel) => { qs(sel, view).value = ''; });
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

  /* ----------------------------------------------------------- selection */
  function syncSelection() {
    const bar = qs('#bulkbar', view);
    bar.classList.toggle('show', selected.size > 0);
    qs('#bulkCount', view).textContent = `${selected.size} selected`;
    const boxes = qsa('.rowsel', view);
    qs('#selectAll', view).checked = boxes.length > 0 && boxes.every((b) => selected.has(b.value));
  }
  rows.addEventListener('change', (e) => {
    if (!e.target.classList.contains('rowsel')) return;
    if (e.target.checked) selected.add(e.target.value); else selected.delete(e.target.value);
    syncSelection();
  });
  qs('#selectAll', view).onchange = (e) => {
    qsa('.rowsel', view).forEach((b) => {
      b.checked = e.target.checked;
      if (e.target.checked) selected.add(b.value); else selected.delete(b.value);
    });
    syncSelection();
  };
  qs('#clearSelBtn', view).onclick = () => { selected.clear(); qsa('.rowsel', view).forEach((b) => { b.checked = false; }); syncSelection(); };
  qs('#bulkPublishBtn', view).onclick = async () => {
    try {
      const { data } = await api.post('/supplier-products/bulk-publish', { ids: [...selected] });
      toast(`Published ${data.published} product(s)${data.failed ? `, ${data.failed} failed` : ''}`, data.failed ? 'warning' : 'success');
      selected.clear(); load();
    } catch (e) { toastError(e); }
  };
  qs('#bulkUnpublishBtn', view).onclick = async () => {
    const ok = await confirmDialog({ title: 'Unpublish selected?', message: 'These products will be withdrawn from the storefront.', confirmLabel: 'Unpublish' });
    if (!ok) return;
    try {
      const { data } = await api.post('/supplier-products/bulk-unpublish', { ids: [...selected] });
      toast(`Unpublished ${data.unpublished} product(s)`);
      selected.clear(); load();
    } catch (e) { toastError(e); }
  };

  /* ------------------------------------------------------------- actions */
  rows.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    const action = btn.dataset.act;

    if (action === 'view') return productDetail(id, load);
    if (action === 'price') return priceEditor(id, load);
    if (action === 'map') return mapDialog(id, load);
    if (action === 'history') return historyDialog(id);
    if (action === 'publish') {
      const { data } = await api.get(`/supplier-products/${id}`);
      if (data.published) {
        const ok = await confirmDialog({ title: 'Unpublish?', message: `${data.name} will be withdrawn from the storefront.`, confirmLabel: 'Unpublish' });
        if (!ok) return;
        try { const r = await api.post(`/supplier-products/${id}/unpublish`); toast(r.message); load(); }
        catch (err) { toastError(err); }
        return;
      }
      const preview = await api.get('/supplier-products/price-preview', { supplierProductId: id }).catch(() => null);
      const ok = await confirmDialog({
        title: 'Publish to storefront?',
        message: preview
          ? `${data.name} — supplier cost ${money(preview.data.cost)}, selling price ${money(preview.data.price)} (${preview.data.rule.scope} rule).`
          : `${data.name} will be published to the storefront catalogue.`,
        confirmLabel: 'Publish', danger: false,
      });
      if (!ok) return;
      try { const r = await api.post(`/supplier-products/${id}/publish`); toast(r.message); load(); }
      catch (err) { toastError(err); }
    }
  });

  await load();

  /* -------------------------------------------------------------- dialogs */

  async function productDetail(id, after) {
    let data;
    try { ({ data } = await api.get(`/supplier-products/${id}`)); }
    catch (e) { return toastError(e); }
    modal({
      title: data.name,
      size: 'lg',
      body: `
        <div class="grid grid--2">
          <div>${kvList([
            ['Supplier SKU', `<code>${esc(data.supplierSku)}</code>`],
            ['Supplier', esc(data.supplierName)],
            ['Manufacturer part', esc(data.manufacturerPart)],
            ['UPC / EAN', esc(data.upc)],
            ['Brand', esc(data.brand)],
            ['Supplier category', esc(data.categoryText)],
            ['Supplier cost', money(data.supplierCost)],
            ['MSRP', data.msrp ? money(data.msrp) : '—'],
            ['Selling price', `<strong>${money(data.sellingPrice)}</strong>`],
            ['Markup', `${data.markupPercent}%${data.priceOverride !== null && data.priceOverride !== undefined ? ' (override)' : ''}`],
            ['Rule', data.markupApplied ? esc(`${data.markupApplied.scope} — ${data.markupApplied.source}`) : '—'],
          ])}</div>
          <div>${kvList([
            ['N&D stock', num(data.localStock)],
            ['Supplier stock', num(data.supplierStock)],
            ['Available', `<strong>${num(data.availableStock)}</strong>`],
            ['Fulfilment', statusBadge(data.fulfillmentType, titleCase(data.fulfillmentType))],
            ['Sync status', statusBadge(data.syncStatus)],
            ['Last synced', data.lastSyncedAt ? dateTime(data.lastSyncedAt) : 'never'],
            ['Mapping', `${statusBadge(data.mappingStatus)} ${data.internalSku ? `<code>${esc(data.internalSku)}</code>` : ''}`],
            ['Published', data.published ? 'Yes' : 'No'],
            ['Weight', data.weightKg ? `${data.weightKg} kg` : '—'],
            ['Dimensions', data.lengthCm ? `${data.lengthCm} × ${data.widthCm} × ${data.heightCm} cm` : '—'],
          ])}</div>
        </div>
        ${data.restricted ? `<div class="alert alert--error" style="margin-top:12px">
          ${icon('alert')} <strong>Restricted product${data.restrictionType ? ` — ${esc(titleCase(data.restrictionType))}` : ''}.</strong>
          ${esc(data.restrictionNotes || '')}
          ${data.documentationRequired?.length ? `<div style="margin-top:6px">Documents required: ${esc(data.documentationRequired.join(', '))}</div>` : ''}
          ${data.allowedShippingMethods?.length ? `<div>Allowed shipping methods: ${esc(data.allowedShippingMethods.join(', '))}</div>` : ''}
          ${data.allowedCountries?.length ? `<div>Allowed countries: ${esc(data.allowedCountries.join(', '))}</div>` : ''}
          ${data.blockedCountries?.length ? `<div>Blocked countries: ${esc(data.blockedCountries.join(', '))}</div>` : ''}
        </div>` : ''}
        ${data.description ? `<div style="margin-top:12px"><h4 style="margin:0 0 6px">Description</h4><p style="margin:0">${esc(data.description)}</p></div>` : ''}
        ${data.specs && Object.keys(data.specs).length ? `<div style="margin-top:12px"><h4 style="margin:0 0 6px">Specifications</h4>
          <dl class="kv">${Object.entries(data.specs).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</dd>`).join('')}</dl></div>` : ''}
        ${data.fulfillment.length ? `<div style="margin-top:14px"><h4 style="margin:0 0 6px">Recent fulfilments</h4>
          <div class="table-wrap"><table class="data"><thead><tr><th>Order</th><th>Status</th></tr></thead>
          <tbody>${data.fulfillment.map((f) => `<tr><td><code>${esc(f.fulfillment.order.reference)}</code></td><td>${statusBadge(f.fulfillment.status)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
        ${data.lastSyncError ? `<div class="alert alert--error" style="margin-top:12px">Last sync error: ${esc(data.lastSyncError)}</div>` : ''}`,
      footer: `<button class="btn btn--ghost" data-close>Close</button>
        <button class="btn btn--subtle" id="d-map">${icon('link')} Match product</button>
        <button class="btn btn--subtle" id="d-price">${icon('money')} Pricing</button>
        <button class="btn btn--primary" id="d-publish">${data.published ? 'Unpublish' : 'Publish'}</button>`,
      onMount: ({ root, close }) => {
        qs('#d-map', root).onclick = () => { close(); mapDialog(id, after); };
        qs('#d-price', root).onclick = () => { close(); priceEditor(id, after); };
        qs('#d-publish', root).onclick = async () => {
          try {
            if (data.published) { const r = await api.post(`/supplier-products/${id}/unpublish`); toast(r.message); }
            else { const r = await api.post(`/supplier-products/${id}/publish`); toast(r.message); }
            close(); after?.();
          } catch (e) { toastError(e); }
        };
      },
    });
  }

  async function priceEditor(id, after) {
    let data;
    let preview;
    try {
      ({ data } = await api.get(`/supplier-products/${id}`));
      ({ data: preview } = await api.get('/supplier-products/price-preview', { supplierProductId: id }));
    } catch (e) { return toastError(e); }

    modal({
      title: `Pricing — ${data.name}`,
      body: `<form id="priceForm">
        <div class="import-summary" style="margin-bottom:14px">
          ${tile('SUPPLIER COST', money(data.supplierCost), 'var(--text)')}
          ${tile('CURRENT PRICE', money(data.sellingPrice), 'var(--brand-600)')}
          ${tile('ACTIVE RULE', preview.rule.scope, 'var(--text-muted)')}
          ${tile('MARGIN', `${preview.marginPercent}%`, 'var(--success,#059669)')}
        </div>
        <p class="cell-sub" style="margin:0 0 12px">${esc(preview.rule.source)} — precedence is Product → Category → Supplier → Global.</p>
        <div class="grid grid--form">
          <div class="field"><label for="p-type">Markup override</label>
            <select id="p-type" name="markupOverrideType">
              <option value="">Inherit from ${esc(preview.rule.scope.toLowerCase())} rule</option>
              <option value="PERCENT" ${data.markupOverrideType === 'PERCENT' ? 'selected' : ''}>Percentage</option>
              <option value="FIXED" ${data.markupOverrideType === 'FIXED' ? 'selected' : ''}>Fixed amount</option>
            </select></div>
          <div class="field"><label for="p-value">Markup value</label>
            <input id="p-value" name="markupOverrideValue" type="number" step="0.01" value="${data.markupOverrideValue ?? ''}"></div>
          <div class="field span-2"><label for="p-override">Fixed selling price (overrides all rules)</label>
            <input id="p-override" name="priceOverride" type="number" step="0.01" min="0" value="${data.priceOverride ?? ''}"
              placeholder="Leave blank to use the markup engine"></div>
          <div class="field span-2"><div class="alert alert--info" id="p-result">${icon('money')} Calculated price: <strong>${money(preview.price)}</strong></div></div>
        </div></form>`,
      footer: `<button class="btn btn--ghost" data-close>Cancel</button>
        <button class="btn btn--danger" id="clearBtn">Clear overrides</button>
        <button class="btn btn--primary" id="saveBtn">Save pricing</button>`,
      onMount: ({ root, close }) => {
        const form = qs('#priceForm', root);
        const result = qs('#p-result', root);
        const recalc = debounce(async () => {
          const type = qs('#p-type', root).value || undefined;
          const value = qs('#p-value', root).value === '' ? undefined : Number(qs('#p-value', root).value);
          const override = qs('#p-override', root).value;
          if (override !== '') {
            result.innerHTML = `${icon('money')} Manual override: <strong>${money(Number(override))}</strong>`;
            return;
          }
          try {
            const { data: p } = await api.get('/supplier-products/price-preview', {
              supplierProductId: id, markupType: type, markupValue: value,
            });
            result.innerHTML = `${icon('money')} Calculated price: <strong>${money(p.price)}</strong>
              <span class="cell-sub"> — ${esc(p.rule.scope)} rule, margin ${p.marginPercent}%</span>`;
          } catch { /* preview is advisory only */ }
        }, 350);
        ['#p-type', '#p-value', '#p-override'].forEach((sel) => {
          qs(sel, root).addEventListener('input', recalc);
          qs(sel, root).addEventListener('change', recalc);
        });

        qs('#clearBtn', root).onclick = async () => {
          try {
            const r = await api.patch(`/supplier-products/${id}/pricing`, { priceOverride: null, markupOverrideType: null, markupOverrideValue: null });
            toast(`Overrides cleared — price is now ${money(r.data.computedPrice)} from the ${r.data.rule.scope} rule`);
            close(); after?.();
          } catch (e) { toastError(e); }
        };

        qs('#saveBtn', root).onclick = async () => {
          const payload = formData(form);
          const body = {};
          body.priceOverride = payload.priceOverride === undefined ? null : payload.priceOverride;
          body.markupOverrideType = payload.markupOverrideType || null;
          body.markupOverrideValue = payload.markupOverrideValue === undefined ? null : payload.markupOverrideValue;
          try {
            const r = await api.patch(`/supplier-products/${id}/pricing`, body);
            toast(`Price set to ${money(r.data.computedPrice)} (${r.data.rule.scope} rule)`);
            close(); after?.();
          } catch (e) { showFieldErrors(form, e); }
        };
      },
    });
  }

  async function mapDialog(id, after) {
    let data;
    try { ({ data } = await api.get(`/supplier-products/${id}`)); }
    catch (e) { return toastError(e); }
    modal({
      title: 'Match to a platform product',
      body: `<form id="mapForm">
        <p style="margin:0 0 12px">Supplier SKU <code>${esc(data.supplierSku)}</code> →
          ${data.internalSku ? `currently <code>${esc(data.internalSku)}</code>` : 'no platform product yet'}.</p>
        <div class="field"><label for="m-product">Platform product</label>
          <select id="m-product" name="productId" required>
            <option value="">Choose a product…</option>
            ${products.map((p) => `<option value="${esc(p.id)}" ${data.productId === p.id ? 'selected' : ''}>${esc(p.sku)} — ${esc(p.name)}</option>`).join('')}
          </select>
          <small class="secret-field__hint">The mapping persists through every future synchronisation, so the supplier's SKU never creates a duplicate product.</small></div>
        ${data.productId ? '<div class="alert alert--info">Replacing the mapping keeps the existing platform product; it is not deleted.</div>' : ''}
      </form>`,
      footer: `<button class="btn btn--ghost" data-close>Cancel</button>
        ${data.productId ? '<button class="btn btn--danger" id="unmapBtn">Remove mapping</button>' : ''}
        <button class="btn btn--primary" id="saveBtn">Save mapping</button>`,
      onMount: ({ root, close }) => {
        qs('#saveBtn', root).onclick = async () => {
          const productId = qs('#m-product', root).value;
          if (!productId) return toast('Choose a product', 'warning');
          try { const r = await api.post('/supplier-products/map', { supplierProductId: id, productId }); toast(r.message); close(); after?.(); }
          catch (e) { toastError(e); }
        };
        const unmap = qs('#unmapBtn', root);
        if (unmap) {
          unmap.onclick = async () => {
            const ok = await confirmDialog({ title: 'Remove mapping?', message: 'The supplier product must be unpublished first.', confirmLabel: 'Remove' });
            if (!ok) return;
            try { const r = await api.del(`/supplier-products/${id}/mapping`); toast(r.message); close(); after?.(); }
            catch (e) { toastError(e); }
          };
        }
      },
    });
  }

  async function historyDialog(id) {
    let data;
    try { ({ data } = await api.get(`/supplier-products/${id}/history`, { limit: 50 })); }
    catch (e) { return toastError(e); }
    modal({
      title: 'Synchronisation history',
      body: data.length
        ? `<div class="table-wrap"><table class="data"><thead><tr>
            <th>Action</th><th>Field</th><th>Detail</th><th>Sync</th><th>When</th></tr></thead>
            <tbody>${data.map((l) => `<tr>
              <td>${statusBadge(l.action === 'ERROR' ? 'FAILED' : l.action === 'CREATE' ? 'NEW' : l.action === 'UPDATE' ? 'CHANGED' : 'OK', l.action)}</td>
              <td>${esc(l.field || '—')}</td><td>${esc(l.message || '')}</td>
              <td>${esc(l.sync?.type || '')} · ${esc((l.sync?.trigger || '').toLowerCase())}</td>
              <td>${dateTime(l.createdAt)}</td></tr>`).join('')}</tbody></table></div>`
        : emptyState('No synchronisation history', 'This product has not been touched by a sync yet.'),
      footer: '<button class="btn btn--ghost" data-close>Close</button>',
    });
  }
}

function tile(label, value, color) {
  return `<div class="import-summary__tile"><div class="import-summary__value" style="color:${color};font-size:16px">${esc(value)}</div>
    <div class="import-summary__label">${esc(label)}</div></div>`;
}
