import { api, auth } from '../api.js';
import { setTitle } from '../layout.js';
import {
  qs, qsa, icon, esc, money, num, dateTime, date, relative, statusBadge, initials, debounce,
  skeletonRows, emptyState, pagination, modal, confirmDialog, formData, showFieldErrors,
  toast, toastError, titleCase,
} from '../ui.js';

const STATUSES = ['PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
const state = { page: 1, limit: 20, search: '', status: '', technicianId: '', sort: 'scheduledAt', order: 'desc' };
let technicians = [];
let services = [];

export async function render(view, query) {
  setTitle('Service Bookings');
  Object.assign(state, { page: 1, search: query.search || '', status: query.status || '' });

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Service Bookings</h1><p>Schedule jobs, assign technicians and track work from request to completion.</p></div>
      <div class="page-head__actions">
        <a class="btn btn--ghost" href="#/calendar">${icon('calendar')} Calendar view</a>
        <button class="btn btn--ghost" id="exportBtn">${icon('download')} Export CSV</button>
        <button class="btn btn--primary" id="newBtn">${icon('plus')} New booking</button>
      </div>
    </div>
    <section class="card">
      <div class="toolbar">
        <label class="sr-only" for="searchInput">Search bookings</label>
        <input id="searchInput" class="toolbar__search" type="search" placeholder="Search reference, customer or address…" value="${esc(state.search)}">
        <label class="sr-only" for="statusFilter">Filter by status</label>
        <select id="statusFilter"><option value="">All statuses</option>
          ${STATUSES.map((s) => `<option value="${s}" ${state.status === s ? 'selected' : ''}>${esc(titleCase(s))}</option>`).join('')}</select>
        <label class="sr-only" for="techFilter">Filter by technician</label>
        <select id="techFilter"><option value="">All technicians</option><option value="unassigned">Unassigned</option></select>
        <button class="btn btn--subtle btn--sm" id="resetBtn">Reset</button>
      </div>
      <div class="table-wrap"><table class="data">
        <caption class="sr-only">Service bookings</caption>
        <thead><tr>
          <th scope="col">Reference</th><th scope="col">Customer</th><th scope="col">Service</th>
          <th scope="col" class="sortable" data-sort="scheduledAt">Scheduled</th>
          <th scope="col">Technician</th><th scope="col">Status</th>
          <th scope="col" class="num sortable" data-sort="price">Value</th>
          <th scope="col" style="text-align:right">Actions</th>
        </tr></thead>
        <tbody id="rows">${skeletonRows(8)}</tbody>
      </table></div>
      <div class="card__foot" id="pager"></div>
    </section>`;

  try {
    const [users, svc] = await Promise.all([api.get('/users'), api.get('/services')]);
    technicians = users.data.filter((u) => u.isActive);
    services = svc.data.filter((s) => s.isActive);
    qs('#techFilter', view).innerHTML = `<option value="">All technicians</option><option value="unassigned">Unassigned</option>
      ${technicians.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}`;
  } catch (e) { toastError(e); }

  const rows = qs('#rows', view);
  const pager = qs('#pager', view);

  async function load() {
    rows.innerHTML = skeletonRows(8);
    try {
      const { data, meta } = await api.get('/bookings', { ...state });
      if (!data.length) {
        rows.innerHTML = `<tr><td colspan="8">${emptyState('No bookings found', 'Adjust your filters or create a new booking.')}</td></tr>`;
        pager.innerHTML = '';
        return;
      }
      rows.innerHTML = data.map((b) => `<tr data-id="${esc(b.id)}">
        <td><code>${esc(b.reference)}</code>${b.priority !== 'NORMAL' ? `<br>${statusBadge(b.priority, titleCase(b.priority))}` : ''}</td>
        <td><div class="cell-flex"><span class="avatar">${esc(initials(b.customer?.name))}</span>
          <div><div class="cell-main">${esc(b.customer?.name || '—')}</div><div class="cell-sub">${esc(b.customer?.phone || b.customer?.email || '')}</div></div></div></td>
        <td>${esc(b.service?.name || 'General service')}</td>
        <td><div>${esc(dateTime(b.scheduledAt))}</div><div class="cell-sub">${esc(relative(b.scheduledAt))}</div></td>
        <td>${b.technician ? esc(b.technician.name) : '<span class="badge badge--muted">Unassigned</span>'}</td>
        <td>${statusBadge(b.status)}</td>
        <td class="num">${money(b.price)}</td>
        <td><div class="row-actions">
          <button class="btn btn--ghost btn--icon" data-act="view" aria-label="View booking ${esc(b.reference)}">${icon('eye')}</button>
          <button class="btn btn--ghost btn--icon" data-act="edit" aria-label="Edit booking ${esc(b.reference)}">${icon('edit')}</button>
          <button class="btn btn--ghost btn--icon" data-act="delete" aria-label="Delete booking ${esc(b.reference)}" ${auth.isAdmin ? '' : 'disabled'}>${icon('trash')}</button>
        </div></td></tr>`).join('');
      pager.innerHTML = '';
      pager.appendChild(pagination(meta, (p) => { state.page = p; load(); }));
    } catch (e) {
      rows.innerHTML = `<tr><td colspan="8">${emptyState('Could not load bookings', e.message)}</td></tr>`;
    }
  }

  qs('#searchInput', view).addEventListener('input', debounce((e) => { state.search = e.target.value.trim(); state.page = 1; load(); }));
  qs('#statusFilter', view).onchange = (e) => { state.status = e.target.value; state.page = 1; load(); };
  qs('#techFilter', view).onchange = (e) => { state.technicianId = e.target.value; state.page = 1; load(); };
  qs('#resetBtn', view).onclick = () => {
    Object.assign(state, { page: 1, search: '', status: '', technicianId: '' });
    qs('#searchInput', view).value = '';
    qsa('.toolbar select', view).forEach((s) => (s.value = ''));
    load();
  };
  qsa('th.sortable', view).forEach((th) => {
    th.onclick = () => {
      state.order = state.sort === th.dataset.sort && state.order === 'desc' ? 'asc' : 'desc';
      state.sort = th.dataset.sort;
      load();
    };
  });
  qs('#exportBtn', view).onclick = () => api.download('/bookings', { ...state, format: 'csv' }, 'bookings.csv')
    .then(() => toast('Export downloaded')).catch(toastError);
  qs('#newBtn', view).onclick = () => openForm(null);
  if (query.new === '1') openForm(null);

  rows.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    if (btn.dataset.act === 'view') openDetail(id);
    else if (btn.dataset.act === 'edit') {
      const { data } = await api.get(`/bookings/${id}`);
      openForm(data);
    } else if (btn.dataset.act === 'delete') {
      if (!await confirmDialog({ title: 'Delete booking', message: 'This permanently removes the booking and its notes.', confirmLabel: 'Delete' })) return;
      try { await api.del(`/bookings/${id}`); toast('Booking deleted'); load(); } catch (err) { toastError(err); }
    }
  });

  /* ------------------------------------------------ detail drawer */
  async function openDetail(id) {
    const m = modal({ title: 'Booking details', size: 'lg', body: '<div style="display:grid;place-items:center;min-height:200px"><div class="spinner"></div></div>', footer: '<button class="btn btn--ghost" data-close>Close</button>' });
    try {
      const { data: b } = await api.get(`/bookings/${id}`);
      m.body.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px">
          <code style="font-size:15px;font-weight:700">${esc(b.reference)}</code>
          ${statusBadge(b.status)}${statusBadge(b.priority, `${titleCase(b.priority)} priority`)}
        </div>
        <div class="grid grid--2">
          <div class="card"><div class="card__head"><h3>Appointment</h3></div><div class="card__body">
            <dl class="kv">
              <dt>Service</dt><dd>${esc(b.service?.name || 'General service')}</dd>
              <dt>Scheduled</dt><dd>${esc(dateTime(b.scheduledAt))}</dd>
              <dt>Completed</dt><dd>${esc(b.completedAt ? dateTime(b.completedAt) : '—')}</dd>
              <dt>Technician</dt><dd>${esc(b.technician?.name || 'Unassigned')}</dd>
              <dt>Value</dt><dd>${money(b.price)}</dd>
              <dt>Address</dt><dd>${esc(b.address || '—')}</dd>
            </dl>
            ${b.description ? `<p style="margin:14px 0 0;color:var(--text-muted);font-size:13px">${esc(b.description)}</p>` : ''}
          </div></div>
          <div class="card"><div class="card__head"><h3>Customer</h3></div><div class="card__body">
            <dl class="kv">
              <dt>Name</dt><dd>${esc(b.customer.name)}</dd>
              <dt>Email</dt><dd><a href="mailto:${esc(b.customer.email)}">${esc(b.customer.email)}</a></dd>
              <dt>Phone</dt><dd>${esc(b.customer.phone || '—')}</dd>
              <dt>Company</dt><dd>${esc(b.customer.company || '—')}</dd>
            </dl>
            <h4 style="margin:16px 0 8px;font-size:13px">Booking history</h4>
            ${b.customerHistory.length ? `<ul style="list-style:none;padding:0;margin:0;font-size:13px">${b.customerHistory.map((h) =>
              `<li style="display:flex;justify-content:space-between;gap:10px;padding:5px 0;border-bottom:1px solid var(--border)">
                <span><code>${esc(h.reference)}</code> · ${esc(date(h.scheduledAt))}</span>${statusBadge(h.status)}</li>`).join('')}</ul>`
              : '<p style="color:var(--text-muted);font-size:13px;margin:0">No other bookings for this customer.</p>'}
          </div></div>
        </div>
        <div class="card" style="margin-top:16px"><div class="card__head"><h3>Status &amp; assignment</h3></div><div class="card__body">
          <div class="grid grid--form">
            <div class="field"><label for="dStatus">Status</label>
              <select id="dStatus">${STATUSES.map((s) => `<option value="${s}" ${b.status === s ? 'selected' : ''}>${esc(titleCase(s))}</option>`).join('')}</select></div>
            <div class="field"><label for="dTech">Technician</label>
              <select id="dTech"><option value="">Unassigned</option>${technicians.map((t) =>
                `<option value="${esc(t.id)}" ${b.technicianId === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>
          </div>
          <label class="checkline"><input type="checkbox" id="dNotify" checked> Email the customer about status changes</label>
        </div></div>
        <div class="card" style="margin-top:16px"><div class="card__head"><h3>Notes</h3></div><div class="card__body">
          <div id="noteList">${b.notes.length ? b.notes.map((n) => `<div class="reply">
              <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">${esc(n.user?.name || 'System')} · ${esc(relative(n.createdAt))}</div>
              <div style="font-size:13.5px">${esc(n.body)}</div></div>`).join('')
            : '<p style="color:var(--text-muted);font-size:13px;margin:0">No notes yet.</p>'}</div>
          <div class="field" style="margin-top:14px"><label for="dNote">Add a note</label>
            <textarea id="dNote" rows="2" placeholder="Parts required, access instructions, follow-up actions…"></textarea></div>
          <button class="btn btn--ghost btn--sm" id="addNote">${icon('plus')} Add note</button>
        </div></div>`;

      const notify = () => qs('#dNotify', m.root).checked;
      qs('#dStatus', m.root).onchange = async (e) => {
        try { await api.patch(`/bookings/${id}/status`, { status: e.target.value, notify: notify() }); toast('Status updated'); load(); }
        catch (err) { toastError(err); }
      };
      qs('#dTech', m.root).onchange = async (e) => {
        try { await api.patch(`/bookings/${id}/assign`, { technicianId: e.target.value || null }); toast('Technician updated'); load(); }
        catch (err) { toastError(err); }
      };
      qs('#addNote', m.root).onclick = async () => {
        const box = qs('#dNote', m.root);
        if (!box.value.trim()) return;
        try {
          const { data: note } = await api.post(`/bookings/${id}/notes`, { body: box.value.trim() });
          const list = qs('#noteList', m.root);
          if (list.querySelector('p')) list.innerHTML = '';
          list.insertAdjacentHTML('afterbegin', `<div class="reply">
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">${esc(note.user?.name || 'You')} · just now</div>
            <div style="font-size:13.5px">${esc(note.body)}</div></div>`);
          box.value = '';
          toast('Note added');
        } catch (err) { toastError(err); }
      };
    } catch (e) { m.body.innerHTML = emptyState('Could not load booking', e.message); }
  }

  /* ------------------------------------------------ create / edit */
  function openForm(booking) {
    const isEdit = !!booking;
    const local = (d) => {
      const dt = d ? new Date(d) : new Date(Date.now() + 864e5);
      return new Date(dt.getTime() - dt.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
    };
    modal({
      title: isEdit ? `Edit ${booking.reference}` : 'New service booking',
      size: 'lg',
      body: `<form id="bookingForm" novalidate>
        ${isEdit ? '' : `<div class="card" style="margin-bottom:16px"><div class="card__head"><h3>Customer</h3></div><div class="card__body">
          <div class="field"><label for="bf-existing">Existing customer</label>
            <select id="bf-existing" name="customerId"><option value="">— create a new customer —</option></select></div>
          <div id="newCustomer"><div class="grid grid--form">
            <div class="field"><label for="bf-cname">Name *</label><input id="bf-cname" name="customer.name"></div>
            <div class="field"><label for="bf-cemail">Email *</label><input id="bf-cemail" name="customer.email" type="email"></div>
            <div class="field"><label for="bf-cphone">Phone</label><input id="bf-cphone" name="customer.phone"></div>
          </div></div></div></div>`}
        <div class="grid grid--form">
          <div class="field"><label for="bf-service">Service</label>
            <select id="bf-service" name="serviceId"><option value="">General service</option>${services.map((s) =>
              `<option value="${esc(s.id)}" ${booking?.serviceId === s.id ? 'selected' : ''}>${esc(s.name)} — ${money(s.basePrice)}</option>`).join('')}</select></div>
          <div class="field"><label for="bf-tech">Technician</label>
            <select id="bf-tech" name="technicianId"><option value="">Unassigned</option>${technicians.map((t) =>
              `<option value="${esc(t.id)}" ${booking?.technicianId === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>
          <div class="field"><label for="bf-when">Scheduled date &amp; time *</label>
            <input id="bf-when" name="scheduledAt" type="datetime-local" required value="${local(booking?.scheduledAt)}"></div>
          <div class="field"><label for="bf-status">Status</label>
            <select id="bf-status" name="status">${STATUSES.map((s) => `<option value="${s}" ${booking?.status === s ? 'selected' : ''}>${esc(titleCase(s))}</option>`).join('')}</select></div>
          <div class="field"><label for="bf-priority">Priority</label>
            <select id="bf-priority" name="priority">${PRIORITIES.map((p) => `<option value="${p}" ${(booking?.priority || 'NORMAL') === p ? 'selected' : ''}>${esc(titleCase(p))}</option>`).join('')}</select></div>
          <div class="field"><label for="bf-price">Job value</label>
            <input id="bf-price" name="price" type="number" step="0.01" min="0" value="${booking?.price ?? 0}"></div>
        </div>
        <div class="field"><label for="bf-address">Service address</label><input id="bf-address" name="address" value="${esc(booking?.address || '')}"></div>
        <div class="field"><label for="bf-desc">Job description</label><textarea id="bf-desc" name="description" rows="3">${esc(booking?.description || '')}</textarea></div>
      </form>`,
      footer: `<button class="btn btn--ghost" data-close>Cancel</button>
               <button class="btn btn--primary" id="saveBooking">${isEdit ? 'Save changes' : 'Create booking'}</button>`,
      onMount: async ({ root, close }) => {
        const form = qs('#bookingForm', root);
        if (!isEdit) {
          try {
            const { data } = await api.get('/customers', { limit: 100, sort: 'name', order: 'asc' });
            qs('#bf-existing', root).innerHTML = `<option value="">— create a new customer —</option>${data.map((c) =>
              `<option value="${esc(c.id)}">${esc(c.name)} (${esc(c.email)})</option>`).join('')}`;
          } catch { /* new-customer flow still works */ }
          qs('#bf-existing', root).onchange = (e) => { qs('#newCustomer', root).style.display = e.target.value ? 'none' : ''; };
        }
        qs('#bf-service', root).onchange = (e) => {
          const svc = services.find((s) => s.id === e.target.value);
          if (svc && !isEdit) qs('#bf-price', root).value = svc.basePrice;
        };

        const btn = qs('#saveBooking', root);
        form.addEventListener('submit', (e) => { e.preventDefault(); btn.click(); });
        btn.onclick = async () => {
          const raw = formData(form);
          const payload = {
            serviceId: raw.serviceId || null,
            technicianId: raw.technicianId || null,
            scheduledAt: raw.scheduledAt ? new Date(raw.scheduledAt).toISOString() : undefined,
            status: raw.status, priority: raw.priority,
            price: raw.price ?? 0, address: raw.address || null, description: raw.description || null,
          };
          if (!isEdit) {
            if (raw.customerId) payload.customerId = raw.customerId;
            else payload.customer = { name: raw['customer.name'], email: raw['customer.email'], phone: raw['customer.phone'] || null };
          }
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner"></span> Saving…';
          try {
            if (isEdit) await api.put(`/bookings/${booking.id}`, payload);
            else await api.post('/bookings', payload);
            toast(isEdit ? 'Booking updated' : 'Booking created');
            close();
            load();
          } catch (err) {
            showFieldErrors(form, err);
            btn.disabled = false;
            btn.textContent = isEdit ? 'Save changes' : 'Create booking';
          }
        };
      },
    });
  }

  await load();
}
