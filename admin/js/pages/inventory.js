import { api } from '../api.js';
import { setTitle } from '../layout.js';
import {
  qs, qsa, icon, esc, money, num, dateTime, statusBadge, debounce, skeletonRows,
  emptyState, pagination, modal, toast, toastError,
} from '../ui.js';

const state = { page: 1, limit: 20, search: '', status: 'all', categoryId: '' };

export async function render(view, query) {
  setTitle('Inventory');
  Object.assign(state, { page: 1, search: query.search || '', status: query.status || 'all' });

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Inventory</h1><p>Stock levels, low stock alerts, adjustments, restock history and reports.</p></div>
      <div class="page-head__actions">
        <button class="btn btn--ghost" id="reportBtn">${icon('download')} Stock report</button>
        <button class="btn btn--ghost" id="restockBtn">${icon('upload')} Record restock</button>
        <button class="btn btn--primary" id="adjustBtn">${icon('edit')} Adjust stock</button>
      </div>
    </div>
    <div class="grid grid--stats" id="summary"></div>
    <div class="tabs" style="margin-top:18px" role="tablist" id="tabs">
      <button class="tab" role="tab" data-tab="levels" aria-selected="true">Stock levels</button>
      <button class="tab" role="tab" data-tab="restocks" aria-selected="false">Restock history</button>
      <button class="tab" role="tab" data-tab="adjustments" aria-selected="false">Adjustments</button>
      <button class="tab" role="tab" data-tab="report" aria-selected="false">Report</button>
    </div>
    <section class="card" style="margin-top:14px" id="panel"></section>`;

  let products = [];
  try { products = (await api.get('/products', { limit: 100, active: 'true' })).data; } catch { /* dialogs degrade gracefully */ }

  async function loadSummary() {
    try {
      const { meta } = await api.get('/inventory', { limit: 1 });
      const s = meta.summary;
      qs('#summary', view).innerHTML = `
        <article class="stat"><div class="stat__top"><div class="stat__icon i-brand">${icon('box')}</div>
          <div><div class="stat__label">Total SKUs</div><div class="stat__value">${num(s.totalSkus)}</div></div></div>
          <div class="stat__meta">${num(s.totalUnits)} units on hand</div></article>
        <article class="stat"><div class="stat__top"><div class="stat__icon ${s.lowStock ? 'i-warning' : 'i-success'}">${icon('alert')}</div>
          <div><div class="stat__label">Low stock</div><div class="stat__value">${num(s.lowStock)}</div></div></div>
          <div class="stat__meta">At or below reorder level</div></article>
        <article class="stat"><div class="stat__top"><div class="stat__icon ${s.outOfStock ? 'i-danger' : 'i-success'}">${icon('x')}</div>
          <div><div class="stat__label">Out of stock</div><div class="stat__value">${num(s.outOfStock)}</div></div></div>
          <div class="stat__meta">Requires immediate restock</div></article>
        <article class="stat"><div class="stat__top"><div class="stat__icon i-success">${icon('money')}</div>
          <div><div class="stat__label">Stock value (cost)</div><div class="stat__value">${money(s.stockValue)}</div></div></div>
          <div class="stat__meta">Retail ${money(s.retailValue)}</div></article>`;
    } catch (e) { toastError(e); }
  }

  const panel = qs('#panel', view);

  async function loadLevels() {
    panel.innerHTML = `
      <div class="toolbar">
        <label class="sr-only" for="invSearch">Search stock</label>
        <input id="invSearch" class="toolbar__search" type="search" placeholder="Search product or SKU…" value="${esc(state.search)}">
        <label class="sr-only" for="invStatus">Filter by stock status</label>
        <select id="invStatus">
          <option value="all" ${state.status === 'all' ? 'selected' : ''}>All stock</option>
          <option value="low" ${state.status === 'low' ? 'selected' : ''}>Low stock</option>
          <option value="out" ${state.status === 'out' ? 'selected' : ''}>Out of stock</option>
          <option value="ok" ${state.status === 'ok' ? 'selected' : ''}>Healthy</option>
        </select>
      </div>
      <div class="table-wrap"><table class="data"><caption class="sr-only">Stock levels</caption>
        <thead><tr><th scope="col">Product</th><th scope="col">Category</th><th scope="col" class="num">On hand</th>
          <th scope="col" class="num">Reorder at</th><th scope="col" class="num">Stock value</th>
          <th scope="col">Status</th><th scope="col" style="text-align:right">Actions</th></tr></thead>
        <tbody id="invRows">${skeletonRows(7)}</tbody></table></div>
      <div class="card__foot" id="invPager"></div>`;

    const rows = qs('#invRows', panel);
    const fetchRows = async () => {
      rows.innerHTML = skeletonRows(7);
      try {
        const { data, meta } = await api.get('/inventory', { ...state });
        if (!data.length) { rows.innerHTML = `<tr><td colspan="7">${emptyState('Nothing to show', 'No products match this filter.')}</td></tr>`; return; }
        rows.innerHTML = data.map((p) => `<tr>
          <td><div class="cell-main">${esc(p.name)}</div><div class="cell-sub">${esc(p.sku)}</div></td>
          <td>${esc(p.category?.name || '—')}</td>
          <td class="num">${num(p.quantity)}</td>
          <td class="num">${num(p.lowStockLevel)}</td>
          <td class="num">${money(p.stockValue)}</td>
          <td>${statusBadge(p.stockStatus, p.stockStatus === 'ok' ? 'Healthy' : p.stockStatus === 'low' ? 'Low' : 'Out of stock')}</td>
          <td><div class="row-actions">
            <button class="btn btn--ghost btn--sm" data-adjust="${esc(p.id)}">Adjust</button>
            <button class="btn btn--ghost btn--sm" data-restock="${esc(p.id)}">Restock</button></div></td></tr>`).join('');
        const pager = qs('#invPager', panel);
        pager.innerHTML = '';
        pager.appendChild(pagination(meta, (p) => { state.page = p; fetchRows(); }));
      } catch (e) { rows.innerHTML = `<tr><td colspan="7">${emptyState('Could not load inventory', e.message)}</td></tr>`; }
    };
    qs('#invSearch', panel).addEventListener('input', debounce((e) => { state.search = e.target.value.trim(); state.page = 1; fetchRows(); }));
    qs('#invStatus', panel).onchange = (e) => { state.status = e.target.value; state.page = 1; fetchRows(); };
    panel.addEventListener('click', (e) => {
      const adjust = e.target.closest('[data-adjust]');
      const restock = e.target.closest('[data-restock]');
      if (adjust) openAdjust(adjust.dataset.adjust);
      if (restock) openRestock(restock.dataset.restock);
    });
    await fetchRows();
  }

  async function loadHistory(kind) {
    const isRestock = kind === 'restocks';
    panel.innerHTML = `<div class="card__head"><h2>${isRestock ? 'Restock history' : 'Inventory adjustments'}</h2></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th scope="col">Date</th><th scope="col">Product</th>
          ${isRestock ? '<th scope="col" class="num">Quantity</th><th scope="col" class="num">Unit cost</th><th scope="col">Supplier</th><th scope="col">Reference</th>'
            : '<th scope="col" class="num">Change</th><th scope="col" class="num">Before → after</th><th scope="col">Reason</th><th scope="col">By</th>'}
        </tr></thead><tbody id="histRows">${skeletonRows(6)}</tbody></table></div>
      <div class="card__foot" id="histPager"></div>`;
    const rows = qs('#histRows', panel);
    const page = { n: 1 };
    const fetchRows = async () => {
      rows.innerHTML = skeletonRows(6);
      try {
        const { data, meta } = await api.get(`/inventory/${kind}`, { page: page.n, limit: 20 });
        if (!data.length) { rows.innerHTML = `<tr><td colspan="6">${emptyState('No records', isRestock ? 'Recorded restocks will appear here.' : 'Stock adjustments will appear here.')}</td></tr>`; return; }
        rows.innerHTML = data.map((r) => isRestock
          ? `<tr><td>${esc(dateTime(r.receivedAt))}</td>
              <td><div class="cell-main">${esc(r.product?.name)}</div><div class="cell-sub">${esc(r.product?.sku)}</div></td>
              <td class="num">+${num(r.quantity)}</td><td class="num">${money(r.unitCost)}</td>
              <td>${esc(r.supplier || '—')}</td><td>${esc(r.reference || '—')}</td></tr>`
          : `<tr><td>${esc(dateTime(r.createdAt))}</td>
              <td><div class="cell-main">${esc(r.product?.name)}</div><div class="cell-sub">${esc(r.product?.sku)}</div></td>
              <td class="num" style="color:${r.change > 0 ? 'var(--success)' : 'var(--danger)'}">${r.change > 0 ? '+' : ''}${num(r.change)}</td>
              <td class="num">${num(r.before)} → ${num(r.after)}</td>
              <td>${esc(r.reason)}</td><td>${esc(r.user?.name || 'System')}</td></tr>`).join('');
        const pager = qs('#histPager', panel);
        pager.innerHTML = '';
        pager.appendChild(pagination(meta, (p) => { page.n = p; fetchRows(); }));
      } catch (e) { rows.innerHTML = `<tr><td colspan="6">${emptyState('Could not load history', e.message)}</td></tr>`; }
    };
    await fetchRows();
  }

  async function loadReport() {
    panel.innerHTML = `<div class="card__head"><h2>Inventory valuation report</h2>
      <div class="card__actions"><button class="btn btn--ghost btn--sm" id="csvBtn">${icon('download')} Download CSV</button></div></div>
      <div class="card__body" id="reportBody"><div style="display:grid;place-items:center;min-height:200px"><div class="spinner"></div></div></div>`;
    qs('#csvBtn', panel).onclick = () => api.download('/inventory/report', { format: 'csv' }, 'inventory-report.csv')
      .then(() => toast('Report downloaded')).catch(toastError);
    try {
      const { data } = await api.get('/inventory/report');
      qs('#reportBody', panel).innerHTML = `
        <div class="grid grid--stats" style="margin-bottom:18px">
          <div class="stat"><div class="stat__label">SKUs</div><div class="stat__value">${num(data.totals.skus)}</div></div>
          <div class="stat"><div class="stat__label">Units</div><div class="stat__value">${num(data.totals.units)}</div></div>
          <div class="stat"><div class="stat__label">Stock value</div><div class="stat__value">${money(data.totals.stockValue)}</div></div>
          <div class="stat"><div class="stat__label">Retail value</div><div class="stat__value">${money(data.totals.retailValue)}</div></div>
        </div>
        <h3 style="font-size:14px;margin-bottom:9px">By category</h3>
        <div class="table-wrap"><table class="data">
          <thead><tr><th scope="col">Category</th><th scope="col" class="num">SKUs</th><th scope="col" class="num">Units</th><th scope="col" class="num">Stock value</th></tr></thead>
          <tbody>${Object.entries(data.byCategory).map(([name, c]) => `<tr><td>${esc(name || 'Uncategorised')}</td>
            <td class="num">${num(c.skus)}</td><td class="num">${num(c.units)}</td><td class="num">${money(c.stockValue)}</td></tr>`).join('')}</tbody>
        </table></div>`;
    } catch (e) { qs('#reportBody', panel).innerHTML = emptyState('Could not build report', e.message); }
  }

  function productOptions(selectedId) {
    return products.map((p) => `<option value="${esc(p.id)}" ${p.id === selectedId ? 'selected' : ''}>${esc(p.name)} (${esc(p.sku)}) — ${num(p.quantity)} in stock</option>`).join('');
  }

  function openAdjust(productId) {
    modal({
      title: 'Adjust stock', size: 'sm',
      body: `<form id="adjForm" novalidate>
        <div class="field"><label for="aj-product">Product *</label><select id="aj-product" name="productId" required>${productOptions(productId)}</select></div>
        <div class="field"><label for="aj-change">Change *</label><input id="aj-change" name="change" type="number" required placeholder="e.g. -3 or 12">
          <span class="hint">Use a negative number to reduce stock (damage, shrinkage, internal use).</span></div>
        <div class="field"><label for="aj-reason">Reason *</label><input id="aj-reason" name="reason" required placeholder="Damaged in transit"></div>
      </form>`,
      footer: '<button class="btn btn--ghost" data-close>Cancel</button><button class="btn btn--primary" id="saveAdj">Apply adjustment</button>',
      onMount: ({ root, close }) => {
        qs('#saveAdj', root).onclick = async () => {
          const form = qs('#adjForm', root);
          const btn = qs('#saveAdj', root);
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner"></span> Applying…';
          try {
            await api.post('/inventory/adjust', {
              productId: form.productId.value, change: Number(form.change.value), reason: form.reason.value.trim(),
            });
            toast('Stock adjusted');
            close();
            loadSummary();
            activeTab === 'levels' ? loadLevels() : loadHistory('adjustments');
          } catch (e) { toastError(e); btn.disabled = false; btn.textContent = 'Apply adjustment'; }
        };
      },
    });
  }

  function openRestock(productId) {
    modal({
      title: 'Record restock', size: 'sm',
      body: `<form id="restockForm" novalidate>
        <div class="field"><label for="rs-product">Product *</label><select id="rs-product" name="productId" required>${productOptions(productId)}</select></div>
        <div class="field"><label for="rs-qty">Quantity received *</label><input id="rs-qty" name="quantity" type="number" min="1" required></div>
        <div class="field"><label for="rs-cost">Unit cost</label><input id="rs-cost" name="unitCost" type="number" step="0.01" min="0" placeholder="Updates the product cost price"></div>
        <div class="field"><label for="rs-supplier">Supplier</label><input id="rs-supplier" name="supplier"></div>
        <div class="field"><label for="rs-ref">Purchase order reference</label><input id="rs-ref" name="reference"></div>
      </form>`,
      footer: '<button class="btn btn--ghost" data-close>Cancel</button><button class="btn btn--primary" id="saveRestock">Record restock</button>',
      onMount: ({ root, close }) => {
        qs('#saveRestock', root).onclick = async () => {
          const form = qs('#restockForm', root);
          const btn = qs('#saveRestock', root);
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner"></span> Saving…';
          try {
            await api.post('/inventory/restock', {
              productId: form.productId.value,
              quantity: Number(form.quantity.value),
              unitCost: form.unitCost.value ? Number(form.unitCost.value) : 0,
              supplier: form.supplier.value || null,
              reference: form.reference.value || null,
            });
            toast('Restock recorded');
            close();
            loadSummary();
            activeTab === 'levels' ? loadLevels() : loadHistory('restocks');
          } catch (e) { toastError(e); btn.disabled = false; btn.textContent = 'Record restock'; }
        };
      },
    });
  }

  let activeTab = 'levels';
  qs('#tabs', view).addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (!tab) return;
    qsa('#tabs .tab', view).forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    activeTab = tab.dataset.tab;
    if (activeTab === 'levels') loadLevels();
    else if (activeTab === 'report') loadReport();
    else loadHistory(activeTab);
  });
  qs('#adjustBtn', view).onclick = () => openAdjust();
  qs('#restockBtn', view).onclick = () => openRestock();
  qs('#reportBtn', view).onclick = () => api.download('/inventory/report', { format: 'csv' }, 'inventory-report.csv')
    .then(() => toast('Report downloaded')).catch(toastError);

  await Promise.all([loadSummary(), loadLevels()]);
}
