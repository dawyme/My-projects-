import { api, auth } from '../api.js';
import { setTitle } from '../layout.js';
import {
  qs, qsa, icon, esc, money, num, dateTime, statusBadge, debounce, skeletonRows,
  emptyState, pagination, modal, confirmDialog, toast, toastError, titleCase,
} from '../ui.js';

const STATUSES = ['PENDING', 'PAID', 'SHIPPED', 'COMPLETED', 'CANCELLED'];
const PAYMENT_METHOD_LABELS = {
  CASH_ON_DELIVERY: 'Cash on delivery',
  BANK_TRANSFER: 'Bank transfer',
  STRIPE: 'Stripe',
  PAYPAL: 'PayPal',
  WIPAY: 'WiPay',
  TILOPAY: 'Tilopay',
};
const state = { page: 1, limit: 20, search: '', status: '', order: 'desc' };

const methodLabel = (m) => PAYMENT_METHOD_LABELS[m] || m || '—';
const payBadge = (s) => statusBadge(s === 'PAID' ? 'PAID' : s === 'REFUNDED' ? 'CANCELLED' : s === 'FAILED' ? 'FAILED' : s || 'PENDING');

export async function render(view, query) {
  setTitle('Orders');
  Object.assign(state, { page: 1, search: query.search || '' });

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Parts &amp; Equipment Orders</h1><p>Product sales, stock reservation and fulfilment status.</p></div>
      <div class="page-head__actions"><button class="btn btn--primary" id="newBtn">${icon('plus')} New order</button></div>
    </div>
    <section class="card">
      <div class="toolbar">
        <label class="sr-only" for="searchInput">Search orders</label>
        <input id="searchInput" class="toolbar__search" type="search" placeholder="Search reference or customer…" value="${esc(state.search)}">
        <label class="sr-only" for="statusFilter">Filter by status</label>
        <select id="statusFilter"><option value="">All statuses</option>
          ${STATUSES.map((s) => `<option value="${s}">${esc(titleCase(s))}</option>`).join('')}</select>
      </div>
      <div class="table-wrap"><table class="data"><caption class="sr-only">Orders</caption>
        <thead><tr><th scope="col">Reference</th><th scope="col">Customer</th><th scope="col">Items</th>
          <th scope="col">Placed</th><th scope="col">Status</th><th scope="col">Payment</th><th scope="col" class="num">Total</th>
          <th scope="col" style="text-align:right">Actions</th></tr></thead>
        <tbody id="rows">${skeletonRows(7)}</tbody></table></div>
      <div class="card__foot" id="pager"></div>
    </section>`;

  const rows = qs('#rows', view);

  async function load() {
    rows.innerHTML = skeletonRows(7);
    try {
      const { data, meta } = await api.get('/orders', { ...state });
      if (!data.length) { rows.innerHTML = `<tr><td colspan="8">${emptyState('No orders', 'Parts orders you record will appear here.')}</td></tr>`; qs('#pager', view).innerHTML = ''; return; }
      rows.innerHTML = data.map((o) => `<tr data-id="${esc(o.id)}">
        <td><code>${esc(o.reference)}</code></td>
        <td><div class="cell-main">${esc(o.customer?.name)}</div><div class="cell-sub">${esc(o.customer?.email)}</div></td>
        <td>${num(o.items.length)} line${o.items.length === 1 ? '' : 's'}<div class="cell-sub">${esc(o.items.map((i) => i.product?.name).filter(Boolean).join(', ').slice(0, 46))}</div></td>
        <td>${esc(dateTime(o.createdAt))}</td>
        <td><select class="statusSel" aria-label="Change status for ${esc(o.reference)}" style="padding:4px 8px;font-size:12.5px">
          ${STATUSES.map((s) => `<option value="${s}" ${o.status === s ? 'selected' : ''}>${esc(titleCase(s))}</option>`).join('')}</select></td>
        <td><div class="cell-main">${esc(methodLabel(o.paymentMethod))}</div><div class="cell-sub">${payBadge(o.paymentStatus)}</div></td>
        <td class="num">${money(o.total)}</td>
        <td><div class="row-actions">
          <button class="btn btn--ghost btn--icon" data-act="view" aria-label="View ${esc(o.reference)}">${icon('eye')}</button>
          <button class="btn btn--ghost btn--icon" data-act="delete" aria-label="Delete ${esc(o.reference)}" ${auth.isAdmin ? '' : 'disabled'}>${icon('trash')}</button>
        </div></td></tr>`).join('');
      const pager = qs('#pager', view);
      pager.innerHTML = '';
      pager.appendChild(pagination(meta, (p) => { state.page = p; load(); }));
    } catch (e) { rows.innerHTML = `<tr><td colspan="8">${emptyState('Could not load orders', e.message)}</td></tr>`; }
  }

  rows.addEventListener('change', async (e) => {
    if (!e.target.classList.contains('statusSel')) return;
    const id = e.target.closest('tr').dataset.id;
    try { await api.patch(`/orders/${id}/status`, { status: e.target.value }); toast('Order status updated'); }
    catch (err) { toastError(err); load(); }
  });

  rows.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    if (btn.dataset.act === 'view') {
      const m = modal({
        title: 'Order details',
        body: '<div style="display:grid;place-items:center;min-height:180px"><div class="spinner"></div></div>',
        footer: '<button class="btn btn--ghost" data-close>Close</button>',
      });
      const renderOrder = async () => {
        try {
          const { data: o } = await api.get(`/orders/${id}`);
          const canCapture = o.paymentStatus === 'PENDING' && o.status !== 'CANCELLED';
          const canRefund = o.paymentStatus === 'PAID' && auth.isAdmin;
          m.body.innerHTML = `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
              <code style="font-weight:700">${esc(o.reference)}</code>${statusBadge(o.status)}</div>
            <dl class="kv" style="margin-bottom:16px">
              <dt>Customer</dt><dd>${esc(o.customer.name)} (${esc(o.customer.email)})</dd>
              <dt>Placed</dt><dd>${esc(dateTime(o.createdAt))}</dd>
              <dt>Payment</dt><dd>${esc(methodLabel(o.paymentMethod))} — ${payBadge(o.paymentStatus)}</dd>
              ${o.paymentReference ? `<dt>Gateway ref</dt><dd><code>${esc(o.paymentReference)}</code></dd>` : ''}
              ${o.paidAt ? `<dt>Paid</dt><dd>${esc(dateTime(o.paidAt))}</dd>` : ''}
              ${o.shippingName ? `<dt>Ship to</dt><dd>${esc(o.shippingName)}${o.shippingCity ? `, ${esc(o.shippingCity)}` : ''}</dd>` : ''}
              ${o.notes ? `<dt>Notes</dt><dd>${esc(o.notes)}</dd>` : ''}</dl>
            <div class="table-wrap"><table class="data">
              <thead><tr><th scope="col">Product</th><th scope="col" class="num">Qty</th><th scope="col" class="num">Unit</th><th scope="col" class="num">Total</th></tr></thead>
              <tbody>${o.items.map((i) => `<tr><td><div class="cell-main">${esc(i.product?.name)}</div><div class="cell-sub">${esc(i.product?.sku)}</div></td>
                <td class="num">${num(i.quantity)}</td><td class="num">${money(i.unitPrice)}</td><td class="num">${money(i.total)}</td></tr>`).join('')}</tbody>
              <tfoot><tr><td colspan="3" class="num">Subtotal</td><td class="num">${money(o.subtotal)}</td></tr>
                <tr><td colspan="3" class="num">Tax</td><td class="num">${money(o.tax)}</td></tr>
                <tr><td colspan="3" class="num"><strong>Total</strong></td><td class="num"><strong>${money(o.total)}</strong></td></tr></tfoot>
            </table></div>
            <div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap">
              ${canCapture ? `<button class="btn btn--primary" id="captureBtn">${icon('check')} Capture payment</button>` : ''}
              ${canRefund ? `<button class="btn btn--ghost" id="refundBtn">${icon('undo')} Refund</button>` : ''}
            </div>`;
          if (canCapture) {
            qs('#captureBtn', m.body).onclick = async () => {
              const trx = window.prompt('Gateway transaction reference (optional):');
              if (trx === null) return;
              try {
                await api.post(`/payments/${o.id}/capture`, { transactionId: trx || undefined });
                toast('Payment captured — order marked as paid');
                renderOrder(); load();
              } catch (err) { toastError(err); }
            };
          }
          if (canRefund) {
            qs('#refundBtn', m.body).onclick = async () => {
              if (!await confirmDialog({ title: 'Refund payment', message: `Refund ${money(o.total)} for ${o.reference}?`, confirmLabel: 'Refund' })) return;
              try { await api.post(`/payments/${o.id}/refund`, {}); toast('Payment refunded'); renderOrder(); load(); }
              catch (err) { toastError(err); }
            };
          }
        } catch (err) { m.body.innerHTML = emptyState('Could not load order', err.message); }
      };
      await renderOrder();
    } else if (btn.dataset.act === 'delete') {
      if (!await confirmDialog({ title: 'Delete order', message: 'Reserved stock will be returned to inventory.', confirmLabel: 'Delete' })) return;
      try { await api.del(`/orders/${id}`); toast('Order deleted and stock restored'); load(); } catch (err) { toastError(err); }
    }
  });

  qs('#searchInput', view).addEventListener('input', debounce((e) => { state.search = e.target.value.trim(); state.page = 1; load(); }));
  qs('#statusFilter', view).onchange = (e) => { state.status = e.target.value; state.page = 1; load(); };

  qs('#newBtn', view).onclick = async () => {
    const [customers, products] = await Promise.all([
      api.get('/customers', { limit: 100, sort: 'name', order: 'asc' }),
      api.get('/products', { limit: 100, active: 'true' }),
    ]);
    const lines = [];
    modal({
      title: 'New order', size: 'lg',
      body: `<div class="field"><label for="of-customer">Customer *</label>
          <select id="of-customer">${customers.data.map((c) => `<option value="${esc(c.id)}">${esc(c.name)} (${esc(c.email)})</option>`).join('')}</select></div>
        <div class="field"><label for="of-tax">Tax rate (%)</label><input id="of-tax" type="number" step="0.01" min="0" max="100" value="0"></div>
        <div class="card"><div class="card__head"><h3>Line items</h3>
          <div class="card__actions"><button class="btn btn--ghost btn--sm" id="addLine">${icon('plus')} Add item</button></div></div>
          <div class="card__body card__body--flush"><div id="lines"></div></div>
          <div class="card__foot"><strong id="orderTotal">Subtotal: —</strong></div></div>`,
      footer: '<button class="btn btn--ghost" data-close>Cancel</button><button class="btn btn--primary" id="saveOrder">Create order</button>',
      onMount: ({ root, close }) => {
        const host = qs('#lines', root);
        const renderLines = () => {
          host.innerHTML = lines.length ? lines.map((l, i) => `<div style="display:flex;gap:9px;align-items:flex-end;padding:11px 15px;border-bottom:1px solid var(--border);flex-wrap:wrap">
              <div class="field" style="flex:2;min-width:190px;margin:0"><label for="ln-p-${i}">Product</label>
                <select id="ln-p-${i}" data-line="${i}" data-key="productId">${products.data.map((p) =>
                  `<option value="${esc(p.id)}" ${l.productId === p.id ? 'selected' : ''}>${esc(p.name)} — ${money(p.price)} (${num(p.quantity)} in stock)</option>`).join('')}</select></div>
              <div class="field" style="width:100px;margin:0"><label for="ln-q-${i}">Qty</label>
                <input id="ln-q-${i}" type="number" min="1" value="${l.quantity}" data-line="${i}" data-key="quantity"></div>
              <button class="btn btn--ghost btn--icon" data-remove="${i}" aria-label="Remove line ${i + 1}">${icon('trash')}</button>
            </div>`).join('') : '<p style="padding:15px;color:var(--text-muted);font-size:13px;margin:0">No line items yet — add at least one product.</p>';
          const subtotal = lines.reduce((s, l) => {
            const p = products.data.find((x) => x.id === l.productId);
            return s + (p ? p.price * l.quantity : 0);
          }, 0);
          qs('#orderTotal', root).textContent = `Subtotal: ${money(subtotal)}`;
        };
        qs('#addLine', root).onclick = () => { lines.push({ productId: products.data[0]?.id, quantity: 1 }); renderLines(); };
        host.addEventListener('change', (e) => {
          const i = e.target.dataset.line;
          if (i === undefined) return;
          lines[i][e.target.dataset.key] = e.target.dataset.key === 'quantity' ? Math.max(1, Number(e.target.value)) : e.target.value;
          renderLines();
        });
        host.addEventListener('click', (e) => {
          const btn = e.target.closest('[data-remove]');
          if (btn) { lines.splice(Number(btn.dataset.remove), 1); renderLines(); }
        });
        lines.push({ productId: products.data[0]?.id, quantity: 1 });
        renderLines();

        qs('#saveOrder', root).onclick = async () => {
          if (!lines.length) return toast('Add at least one line item', 'warning');
          const btn = qs('#saveOrder', root);
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner"></span> Creating…';
          try {
            await api.post('/orders', {
              customerId: qs('#of-customer', root).value,
              taxRate: Number(qs('#of-tax', root).value || 0),
              items: lines,
            });
            toast('Order created and stock reserved');
            close();
            load();
          } catch (err) { toastError(err); btn.disabled = false; btn.textContent = 'Create order'; }
        };
      },
    });
  };

  await load();
}
