import { api, auth } from '../api.js';
import { setTitle } from '../layout.js';
import {
  qs, qsa, icon, esc, money, num, date, dateTime, statusBadge, initials, debounce,
  skeletonRows, emptyState, pagination, modal, confirmDialog, formData, showFieldErrors,
  toast, toastError,
} from '../ui.js';

const state = { page: 1, limit: 20, search: '', sort: 'createdAt', order: 'desc' };

export async function render(view, query) {
  setTitle('Customers');
  Object.assign(state, { page: 1, search: query.search || '' });

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Customers</h1><p>Profiles, contact details, booking history and purchase history.</p></div>
      <div class="page-head__actions">
        <button class="btn btn--ghost" id="exportBtn">${icon('download')} Export CSV</button>
        <button class="btn btn--primary" id="newBtn">${icon('plus')} New customer</button>
      </div>
    </div>
    <section class="card">
      <div class="toolbar">
        <label class="sr-only" for="searchInput">Search customers</label>
        <input id="searchInput" class="toolbar__search" type="search" placeholder="Search name, email, phone or company…" value="${esc(state.search)}">
        <label class="sr-only" for="sortSelect">Sort customers</label>
        <select id="sortSelect">
          <option value="createdAt:desc">Newest first</option><option value="createdAt:asc">Oldest first</option>
          <option value="name:asc">Name A–Z</option><option value="name:desc">Name Z–A</option>
        </select>
      </div>
      <div class="table-wrap"><table class="data">
        <caption class="sr-only">Customer directory</caption>
        <thead><tr><th scope="col">Customer</th><th scope="col">Contact</th><th scope="col">Location</th>
          <th scope="col" class="num">Bookings</th><th scope="col" class="num">Orders</th>
          <th scope="col">Joined</th><th scope="col" style="text-align:right">Actions</th></tr></thead>
        <tbody id="rows">${skeletonRows(7)}</tbody>
      </table></div>
      <div class="card__foot" id="pager"></div>
    </section>`;

  const rows = qs('#rows', view);
  const pager = qs('#pager', view);

  async function load() {
    rows.innerHTML = skeletonRows(7);
    try {
      const { data, meta } = await api.get('/customers', { ...state });
      if (!data.length) {
        rows.innerHTML = `<tr><td colspan="7">${emptyState('No customers found', 'Try a different search, or add your first customer.')}</td></tr>`;
        pager.innerHTML = '';
        return;
      }
      rows.innerHTML = data.map((c) => `<tr data-id="${esc(c.id)}">
        <td><div class="cell-flex"><span class="avatar">${esc(initials(c.name))}</span>
          <div><div class="cell-main">${esc(c.name)}</div><div class="cell-sub">${esc(c.company || 'Private customer')}</div></div></div></td>
        <td><div>${esc(c.email)}</div><div class="cell-sub">${esc(c.phone || '—')}</div></td>
        <td>${esc([c.city, c.state].filter(Boolean).join(', ') || '—')}</td>
        <td class="num">${num(c._count.bookings)}</td>
        <td class="num">${num(c._count.orders)}</td>
        <td>${esc(date(c.createdAt))}</td>
        <td><div class="row-actions">
          <button class="btn btn--ghost btn--icon" data-act="view" aria-label="View ${esc(c.name)}">${icon('eye')}</button>
          <button class="btn btn--ghost btn--icon" data-act="edit" aria-label="Edit ${esc(c.name)}">${icon('edit')}</button>
          <button class="btn btn--ghost btn--icon" data-act="delete" aria-label="Delete ${esc(c.name)}" ${auth.isAdmin ? '' : 'disabled'}>${icon('trash')}</button>
        </div></td></tr>`).join('');
      pager.innerHTML = '';
      pager.appendChild(pagination(meta, (p) => { state.page = p; load(); }));
    } catch (e) { rows.innerHTML = `<tr><td colspan="7">${emptyState('Could not load customers', e.message)}</td></tr>`; }
  }

  qs('#searchInput', view).addEventListener('input', debounce((e) => { state.search = e.target.value.trim(); state.page = 1; load(); }));
  qs('#sortSelect', view).onchange = (e) => { [state.sort, state.order] = e.target.value.split(':'); load(); };
  qs('#exportBtn', view).onclick = () => api.download('/customers', { ...state, format: 'csv' }, 'customers.csv')
    .then(() => toast('Export downloaded')).catch(toastError);
  qs('#newBtn', view).onclick = () => openForm(null);

  rows.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    if (btn.dataset.act === 'view') openProfile(id);
    else if (btn.dataset.act === 'edit') {
      const { data } = await api.get(`/customers/${id}`);
      openForm(data);
    } else if (btn.dataset.act === 'delete') {
      if (!await confirmDialog({ title: 'Delete customer', message: 'This also removes their bookings, orders and messages.', confirmLabel: 'Delete' })) return;
      try { await api.del(`/customers/${id}`); toast('Customer deleted'); load(); } catch (err) { toastError(err); }
    }
  });

  async function openProfile(id) {
    const m = modal({ title: 'Customer profile', size: 'lg',
      body: '<div style="display:grid;place-items:center;min-height:220px"><div class="spinner"></div></div>',
      footer: '<button class="btn btn--ghost" data-close>Close</button>' });
    try {
      const { data: c } = await api.get(`/customers/${id}`);
      m.body.innerHTML = `
        <div style="display:flex;gap:14px;align-items:center;margin-bottom:18px">
          <span class="avatar avatar--lg">${esc(initials(c.name))}</span>
          <div><h3 style="font-size:17px">${esc(c.name)}</h3>
            <p style="margin:2px 0 0;color:var(--text-muted);font-size:13px">${esc(c.company || 'Private customer')} · joined ${esc(date(c.createdAt))}</p></div>
        </div>
        <div class="grid grid--stats" style="margin-bottom:16px">
          <div class="stat"><div class="stat__label">Lifetime value</div><div class="stat__value">${money(c.stats.lifetimeValue)}</div></div>
          <div class="stat"><div class="stat__label">Bookings</div><div class="stat__value">${num(c.stats.totalBookings)}</div>
            <div class="stat__meta">${num(c.stats.completedBookings)} completed</div></div>
          <div class="stat"><div class="stat__label">Orders</div><div class="stat__value">${num(c.stats.totalOrders)}</div></div>
        </div>
        <div class="card" style="margin-bottom:16px"><div class="card__head"><h3>Contact information</h3></div><div class="card__body">
          <dl class="kv">
            <dt>Email</dt><dd><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></dd>
            <dt>Phone</dt><dd>${esc(c.phone || '—')}</dd>
            <dt>Address</dt><dd>${esc([c.address, c.city, c.state, c.postalCode].filter(Boolean).join(', ') || '—')}</dd>
            ${c.notes ? `<dt>Notes</dt><dd>${esc(c.notes)}</dd>` : ''}
          </dl></div></div>
        <div class="card" style="margin-bottom:16px"><div class="card__head"><h3>Booking history</h3></div>
          <div class="card__body card__body--flush">${c.bookings.length ? `<div class="table-wrap"><table class="data">
            <thead><tr><th scope="col">Reference</th><th scope="col">Service</th><th scope="col">Date</th><th scope="col">Status</th><th scope="col" class="num">Value</th></tr></thead>
            <tbody>${c.bookings.slice(0, 12).map((b) => `<tr><td><code>${esc(b.reference)}</code></td>
              <td>${esc(b.service?.name || 'General service')}</td><td>${esc(date(b.scheduledAt))}</td>
              <td>${statusBadge(b.status)}</td><td class="num">${money(b.price)}</td></tr>`).join('')}</tbody></table></div>`
            : emptyState('No bookings', 'This customer has not booked a service yet.')}</div></div>
        <div class="card"><div class="card__head"><h3>Purchase history</h3></div>
          <div class="card__body card__body--flush">${c.orders.length ? `<div class="table-wrap"><table class="data">
            <thead><tr><th scope="col">Order</th><th scope="col">Items</th><th scope="col">Date</th><th scope="col">Status</th><th scope="col" class="num">Total</th></tr></thead>
            <tbody>${c.orders.slice(0, 12).map((o) => `<tr><td><code>${esc(o.reference)}</code></td>
              <td>${esc(o.items.map((i) => `${i.quantity}× ${i.product?.name || 'Item'}`).join(', ').slice(0, 70))}</td>
              <td>${esc(date(o.createdAt))}</td><td>${statusBadge(o.status)}</td><td class="num">${money(o.total)}</td></tr>`).join('')}</tbody></table></div>`
            : emptyState('No purchases', 'This customer has not placed a parts order yet.')}</div></div>`;
    } catch (e) { m.body.innerHTML = emptyState('Could not load profile', e.message); }
  }

  function openForm(customer) {
    const isEdit = !!customer;
    modal({
      title: isEdit ? `Edit ${customer.name}` : 'New customer',
      body: `<form id="customerForm" novalidate><div class="grid grid--form">
          <div class="field"><label for="cf-name">Full name *</label><input id="cf-name" name="name" required value="${esc(customer?.name || '')}"></div>
          <div class="field"><label for="cf-email">Email *</label><input id="cf-email" name="email" type="email" required value="${esc(customer?.email || '')}"></div>
          <div class="field"><label for="cf-phone">Phone</label><input id="cf-phone" name="phone" type="tel" value="${esc(customer?.phone || '')}"></div>
          <div class="field"><label for="cf-company">Company</label><input id="cf-company" name="company" value="${esc(customer?.company || '')}"></div>
          <div class="field"><label for="cf-city">City</label><input id="cf-city" name="city" value="${esc(customer?.city || '')}"></div>
          <div class="field"><label for="cf-state">State / region</label><input id="cf-state" name="state" value="${esc(customer?.state || '')}"></div>
          <div class="field"><label for="cf-postal">Postal code</label><input id="cf-postal" name="postalCode" value="${esc(customer?.postalCode || '')}"></div>
        </div>
        <div class="field"><label for="cf-address">Street address</label><input id="cf-address" name="address" value="${esc(customer?.address || '')}"></div>
        <div class="field"><label for="cf-notes">Internal notes</label><textarea id="cf-notes" name="notes" rows="3">${esc(customer?.notes || '')}</textarea></div>
      </form>`,
      footer: `<button class="btn btn--ghost" data-close>Cancel</button>
               <button class="btn btn--primary" id="saveCustomer">${isEdit ? 'Save changes' : 'Create customer'}</button>`,
      onMount: ({ root, close }) => {
        const form = qs('#customerForm', root);
        const btn = qs('#saveCustomer', root);
        form.addEventListener('submit', (e) => { e.preventDefault(); btn.click(); });
        btn.onclick = async () => {
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner"></span> Saving…';
          try {
            const payload = formData(form);
            if (isEdit) await api.put(`/customers/${customer.id}`, payload);
            else await api.post('/customers', payload);
            toast(isEdit ? 'Customer updated' : 'Customer created');
            close();
            load();
          } catch (err) {
            showFieldErrors(form, err);
            btn.disabled = false;
            btn.textContent = isEdit ? 'Save changes' : 'Create customer';
          }
        };
      },
    });
  }

  await load();
}
