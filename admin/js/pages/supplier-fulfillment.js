/** Supplier Marketplace → Fulfillment: dropship orders, submission and tracking. */
import { api, auth } from '../api.js';
import { setTitle } from '../layout.js';
import {
  qs, qsa, icon, esc, money, num, statusBadge, debounce, skeletonRows, emptyState,
  pagination, modal, confirmDialog, toast, toastError, dateTime, relative, titleCase,
} from '../ui.js';
import { sectionHead, kvList } from './supplier-nav.js';

const state = { page: 1, limit: 20, search: '', supplierId: '', status: '', transmissionStatus: '', sort: 'createdAt', order: 'desc' };
let suppliers = [];

const LIFECYCLE = ['PENDING', 'READY', 'SUBMITTED', 'ACCEPTED', 'PROCESSING', 'PARTIALLY_SHIPPED', 'SHIPPED', 'DELIVERED'];

export async function render(view, query) {
  setTitle('Supplier Fulfillment');
  Object.assign(state, { page: 1, supplierId: query.supplierId || '', status: query.status || '' });

  view.innerHTML = `
    ${sectionHead({
      title: 'Fulfillment',
      subtitle: 'Purchase orders raised from real customer orders. Nothing is reported as sent unless a transport accepted it.',
      active: '/supplier-fulfillment',
      actions: `<button class="btn btn--primary" id="raiseBtn">${icon('truck')} Raise from order</button>`,
    })}
    <section class="card">
      <div class="toolbar">
        <label class="sr-only" for="searchInput">Search fulfilments</label>
        <input id="searchInput" class="toolbar__search" type="search" placeholder="Search by order reference, supplier order id or tracking…" value="${esc(state.search)}">
        <label class="sr-only" for="supplierFilter">Supplier</label>
        <select id="supplierFilter"><option value="">All suppliers</option></select>
        <label class="sr-only" for="statusFilter">Status</label>
        <select id="statusFilter"><option value="">Any status</option>
          ${['PENDING', 'READY', 'SUBMITTED', 'ACCEPTED', 'PROCESSING', 'PARTIALLY_SHIPPED', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'FAILED']
            .map((s) => `<option value="${s}" ${state.status === s ? 'selected' : ''}>${esc(titleCase(s))}</option>`).join('')}</select>
        <label class="sr-only" for="txFilter">Transmission</label>
        <select id="txFilter"><option value="">Any transmission</option>
          <option value="NOT_SENT">Not sent</option><option value="SENT">Sent</option><option value="FAILED">Failed</option></select>
        <button class="btn btn--subtle btn--sm" id="resetBtn">Reset</button>
      </div>
      <div class="table-wrap"><table class="data">
        <caption class="sr-only">Supplier fulfilments</caption>
        <thead><tr>
          <th scope="col">Order</th><th scope="col">Supplier</th><th scope="col">Items</th>
          <th scope="col" class="num">Cost</th><th scope="col">Transmission</th>
          <th scope="col">Status</th><th scope="col">Tracking</th>
          <th scope="col" class="sortable" data-sort="createdAt">Created</th>
          <th scope="col" style="text-align:right">Actions</th>
        </tr></thead>
        <tbody id="rows">${skeletonRows(9)}</tbody></table></div>
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
    rows.innerHTML = skeletonRows(9);
    try {
      const { data, meta } = await api.get('/supplier-fulfillments', {
        page: state.page, limit: state.limit, search: state.search, supplierId: state.supplierId,
        status: state.status, transmissionStatus: state.transmissionStatus, sort: state.sort, order: state.order,
      });
      if (!data.length) {
        rows.innerHTML = `<tr><td colspan="9">${emptyState('No fulfilments yet',
          'They appear automatically when a customer orders a supplier-fulfilled item, or raise one from an existing order.')}</td></tr>`;
        pager.innerHTML = '';
        return;
      }
      rows.innerHTML = data.map(rowMarkup).join('');
      pager.innerHTML = '';
      pager.appendChild(pagination(meta, (p) => { state.page = p; load(); }));
    } catch (e) {
      rows.innerHTML = `<tr><td colspan="9">${emptyState('Could not load fulfilments', e.message)}</td></tr>`;
    }
  }

  function rowMarkup(f) {
    const tx = f.transmissionStatus === 'SENT'
      ? `<span class="badge badge--success">${esc(f.transmissionMethod)}</span>`
      : f.transmissionStatus === 'FAILED'
        ? '<span class="badge badge--danger">Failed</span>'
        : '<span class="badge badge--muted">Not sent</span>';
    return `<tr data-id="${esc(f.id)}">
      <td><a href="#/orders"><code>${esc(f.order.reference)}</code></a>
        <div class="cell-sub">${esc(f.order.customer?.name || '')} · ${esc(f.order.shippingCountry || '—')}</div></td>
      <td>${esc(f.supplier?.name || '—')}</td>
      <td class="num">${num(f.items.reduce((a, i) => a + i.quantity, 0))}
        <div class="cell-sub">${esc(f.items.map((i) => i.supplierSku).join(', ').slice(0, 40))}</div></td>
      <td class="num">${money(f.totalCost)}</td>
      <td>${tx}<div class="cell-sub">${esc(f.shippingMethod || '—')}</div></td>
      <td>${statusBadge(f.status)}${f.failureReason ? `<div class="cell-sub" style="color:var(--danger)">${esc(f.failureReason.slice(0, 70))}</div>` : ''}</td>
      <td>${f.trackingNumber
        ? `<code>${esc(f.trackingNumber)}</code><div class="cell-sub">${esc(f.carrier || '')}</div>`
        : '<span class="cell-sub">Not available</span>'}</td>
      <td>${relative(f.createdAt)}</td>
      <td><div class="row-actions">
        <button class="btn btn--ghost btn--icon" data-act="view" aria-label="View fulfilment">${icon('eye')}</button>
        <button class="btn btn--ghost btn--icon" data-act="submit" aria-label="Submit purchase order" ${['SUBMITTED', 'ACCEPTED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'].includes(f.status) ? 'disabled' : ''}>${icon('share')}</button>
        <button class="btn btn--ghost btn--icon" data-act="tracking" aria-label="Record tracking">${icon('truck')}</button>
        <button class="btn btn--ghost btn--icon" data-act="refresh" aria-label="Poll the supplier">${icon('refresh')}</button>
        <button class="btn btn--ghost btn--icon" data-act="cancel" aria-label="Cancel fulfilment" ${['DELIVERED', 'CANCELLED'].includes(f.status) ? 'disabled' : ''}>${icon('x')}</button>
      </div></td></tr>`;
  }

  qs('#searchInput', view).addEventListener('input', debounce((e) => { state.search = e.target.value.trim(); state.page = 1; load(); }));
  const bind = (id, key) => { qs(id, view).onchange = (e) => { state[key] = e.target.value; state.page = 1; load(); }; };
  bind('#supplierFilter', 'supplierId'); bind('#statusFilter', 'status'); bind('#txFilter', 'transmissionStatus');
  qs('#resetBtn', view).onclick = () => {
    Object.assign(state, { search: '', supplierId: '', status: '', transmissionStatus: '', page: 1 });
    ['#searchInput', '#supplierFilter', '#statusFilter', '#txFilter'].forEach((s) => { qs(s, view).value = ''; });
    load();
  };
  qsa('.sortable', view).forEach((th) => {
    th.onclick = () => {
      const f = th.dataset.sort;
      if (state.sort === f) state.order = state.order === 'asc' ? 'desc' : 'asc';
      else { state.sort = f; state.order = 'asc'; }
      load();
    };
  });

  qs('#raiseBtn', view).onclick = () => raiseDialog(load);

  rows.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const id = btn.closest('tr').dataset.id;
    const act = btn.dataset.act;

    if (act === 'view') return detail(id, load);
    if (act === 'submit') {
      const ok = await confirmDialog({
        title: 'Transmit purchase order?',
        message: 'The order is sent through the supplier connector (API) or by email if that is how the supplier is configured.',
        confirmLabel: 'Transmit', danger: false,
      });
      if (!ok) return;
      try { const r = await api.post(`/supplier-fulfillments/${id}/submit`); toast(r.message, r.data.sent ? 'success' : 'warning'); load(); }
      catch (err) { toastError(err); load(); }
      return;
    }
    if (act === 'tracking') return trackingDialog(id, load);
    if (act === 'refresh') {
      try {
        const { data } = await api.post(`/supplier-fulfillments/${id}/refresh`);
        if (!data.statusChecked && !data.trackingChecked) toast(data.message || 'This supplier exposes no status or tracking.', 'info');
        else toast(data.trackingUpdated ? 'Tracking updated from the supplier.' : `Supplier status: ${data.supplierStatus || 'unchanged'}`);
        load();
      } catch (err) { toastError(err); }
      return;
    }
    if (act === 'cancel') {
      const reason = prompt('Reason for cancelling this fulfilment?');
      if (!reason) return;
      try { const r = await api.post(`/supplier-fulfillments/${id}/cancel`, { reason }); toast(r.message); load(); }
      catch (err) { toastError(err); }
    }
  });

  await load();

  /* -------------------------------------------------------------- dialogs */

  async function detail(id, after) {
    let data;
    try { ({ data } = await api.get(`/supplier-fulfillments/${id}`)); }
    catch (e) { return toastError(e); }
    const f = data;
    modal({
      title: `Fulfilment for order ${f.order.reference}`,
      size: 'lg',
      body: `
        <div class="grid grid--2">
          <div>${kvList([
            ['Supplier', esc(f.supplier?.name || '—')],
            ['Status', statusBadge(f.status)],
            ['Supplier order id', f.supplierOrderId ? `<code>${esc(f.supplierOrderId)}</code>` : '—'],
            ['Transmission', `${esc(f.transmissionMethod)} · ${statusBadge(f.transmissionStatus)}`],
            ['Attempts', num(f.attempts)],
            ['Shipping method', esc(f.shippingMethod || '—')],
            ['Shipping cost', money(f.shippingCost)],
            ['Total supplier cost', money(f.totalCost)],
            ['Tracking', f.trackingNumber ? `<code>${esc(f.trackingNumber)}</code> (${esc(f.carrier || 'n/a')})` : 'Not available from this supplier'],
            ['Tracking URL', f.trackingUrl ? `<a href="${esc(f.trackingUrl)}" target="_blank" rel="noopener">Open</a>` : '—'],
          ])}</div>
          <div>${kvList([
            ['Customer', esc(f.order.customer?.name || '—')],
            ['Ship to', esc(f.shipTo.name || '—')],
            ['Address', [f.shipTo.address, f.shipTo.city, f.shipTo.postalCode, f.shipTo.country].filter(Boolean).map(esc).join('<br>') || '—'],
            ['Phone', esc(f.shipTo.phone)],
            ['Order status', statusBadge(f.order.status)],
            ['Payment', statusBadge(f.order.paymentStatus)],
            ['Submitted', f.submittedAt ? dateTime(f.submittedAt) : '—'],
            ['Shipped', f.shippedAt ? dateTime(f.shippedAt) : '—'],
            ['Delivered', f.deliveredAt ? dateTime(f.deliveredAt) : '—'],
          ])}</div>
        </div>
        <h4 style="margin:16px 0 6px">Lines</h4>
        <div class="table-wrap"><table class="data"><thead><tr>
          <th>Supplier SKU</th><th>Product</th><th class="num">Qty</th><th class="num">Unit cost</th><th class="num">Line total</th><th>Restriction</th></tr></thead>
          <tbody>${f.items.map((i) => `<tr>
            <td><code>${esc(i.supplierSku)}</code></td><td>${esc(i.name)}</td>
            <td class="num">${num(i.quantity)}</td><td class="num">${money(i.unitCost)}</td>
            <td class="num">${money(i.total)}</td>
            <td>${i.supplierProduct?.restricted ? `<span class="badge badge--danger">${esc(i.supplierProduct.restrictionType || 'Restricted')}</span>` : '—'}</td></tr>`).join('')}
          </tbody></table></div>
        ${f.failureReason ? `<div class="alert alert--error" style="margin-top:12px">${esc(f.failureReason)}</div>` : ''}
        ${f.notes ? `<div class="alert alert--info" style="margin-top:12px">${esc(f.notes)}</div>` : ''}`,
      footer: `<button class="btn btn--ghost" data-close>Close</button>
        <button class="btn btn--subtle" id="f-refresh">${icon('refresh')} Poll supplier</button>
        <button class="btn btn--subtle" id="f-status">${icon('edit')} Set status</button>
        <button class="btn btn--primary" id="f-tracking">${icon('truck')} Record tracking</button>`,
      onMount: ({ root, close }) => {
        qs('#f-refresh', root).onclick = async () => {
          try {
            const { data: r } = await api.post(`/supplier-fulfillments/${id}/refresh`);
            toast(r.message || `Supplier status: ${r.supplierStatus || 'unchanged'}`, r.statusChecked || r.trackingChecked ? 'success' : 'info');
            close(); after?.();
          } catch (e) { toastError(e); }
        };
        qs('#f-status', root).onclick = () => { close(); statusDialog(id, after); };
        qs('#f-tracking', root).onclick = () => { close(); trackingDialog(id, after); };
      },
    });
  }

  function statusDialog(id, after) {
    modal({
      title: 'Update fulfilment status',
      body: `<form id="stForm">
        <div class="field"><label for="st-status">Status</label>
          <select id="st-status">${LIFECYCLE.concat(['CANCELLED', 'FAILED']).map((s) => `<option value="${s}">${esc(titleCase(s))}</option>`).join('')}</select></div>
        <div class="field"><label for="st-supplierOrder">Supplier order id</label>
          <input id="st-supplierOrder" maxlength="120" placeholder="Enter the reference the supplier gave you"></div>
        <div class="field"><label for="st-note">Note</label><textarea id="st-note" rows="3" maxlength="1000"></textarea></div>
      </form>`,
      footer: `<button class="btn btn--ghost" data-close>Cancel</button>
               <button class="btn btn--primary" id="st-save">Save status</button>`,
      onMount: ({ root, close }) => {
        qs('#st-save', root).onclick = async () => {
          try {
            await api.patch(`/supplier-fulfillments/${id}/status`, {
              status: qs('#st-status', root).value,
              note: qs('#st-note', root).value || null,
              supplierOrderId: qs('#st-supplierOrder', root).value || null,
            });
            toast('Status updated'); close(); after?.();
          } catch (e) { toastError(e); }
        };
      },
    });
  }

  function trackingDialog(id, after) {
    modal({
      title: 'Record tracking',
      body: `<form id="trForm">
        <div class="field"><label for="tr-number">Tracking number *</label><input id="tr-number" required maxlength="120"></div>
        <div class="field"><label for="tr-carrier">Carrier</label><input id="tr-carrier" maxlength="120" placeholder="DHL, FedEx, local courier…"></div>
        <div class="field"><label for="tr-url">Tracking URL</label><input id="tr-url" type="url" maxlength="400"></div>
        <div class="field"><label for="tr-status">Status</label>
          <select id="tr-status"><option value="SHIPPED">Shipped</option>
            <option value="PARTIALLY_SHIPPED">Partially shipped</option><option value="DELIVERED">Delivered</option></select></div>
      </form>`,
      footer: `<button class="btn btn--ghost" data-close>Cancel</button>
               <button class="btn btn--primary" id="tr-save">Save tracking</button>`,
      onMount: ({ root, close }) => {
        qs('#tr-save', root).onclick = async () => {
          try {
            await api.post(`/supplier-fulfillments/${id}/tracking`, {
              trackingNumber: qs('#tr-number', root).value,
              carrier: qs('#tr-carrier', root).value || null,
              trackingUrl: qs('#tr-url', root).value || null,
              status: qs('#tr-status', root).value,
            });
            toast('Tracking recorded — the customer order status follows automatically.');
            close(); after?.();
          } catch (e) { toastError(e); }
        };
      },
    });
  }

  function raiseDialog(after) {
    modal({
      title: 'Raise fulfilments from an order',
      body: `<form id="raiseForm">
        <div class="field"><label for="r-order">Order reference or id *</label>
          <input id="r-order" required placeholder="OR-XXXXXX or the order id"></div>
        <div class="field"><label for="r-reason">Note</label><input id="r-reason" maxlength="400"></div>
        <div class="alert alert--info">Only the dropshipped remainder of each line becomes a fulfilment.
          N&D-owned stock is shipped by N&D as usual.</div>
      </form>`,
      footer: `<button class="btn btn--ghost" data-close>Cancel</button>
               <button class="btn btn--primary" id="r-save">Find order and raise</button>`,
      onMount: ({ root, close }) => {
        qs('#r-save', root).onclick = async () => {
          const needle = qs('#r-order', root).value.trim();
          if (!needle) return toast('Enter an order reference', 'warning');
          try {
            const { data: orders } = await api.get('/orders', { search: needle, limit: 5 });
            const order = orders[0];
            if (!order) return toast('No order matches that reference', 'error');
            const { data } = await api.post('/supplier-fulfillments/ensure', {
              orderId: order.id, reason: qs('#r-reason', root).value || null,
            });
            close();
            toast(data.message, data.fulfillments.length ? 'success' : 'info');
            if (data.skipped.length) toast(data.skipped.map((s) => `${s.sku}: ${s.reason}`).join(' · '), 'warning');
            after?.();
          } catch (e) { toastError(e); }
        };
      },
    });
  }
}
