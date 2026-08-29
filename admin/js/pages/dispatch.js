import { api } from '../api.js';
import { setTitle } from '../layout.js';
import { qs, esc, emptyState, skeletonRows, toast, toastError, titleCase, dateTime, statusBadge, modal } from '../ui.js';

const STATUSES = ['PENDING','CONFIRMED','IN_PROGRESS','COMPLETED','CANCELLED'];
const PRIORITIES = ['LOW','NORMAL','HIGH','URGENT'];
let technicians = [];

function localDateTime(value) {
  const dt = value ? new Date(value) : new Date(Date.now() + 86400000);
  return new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export async function render(view) {
  setTitle('Dispatch Board');
  view.innerHTML = `<div class="page-head"><div><h1>Dispatch Board</h1><p>Assign technicians, schedule or reschedule jobs, update status and notify customers.</p></div><div class="page-head__actions"><a class="btn btn--ghost" href="#/calendar">Calendar</a></div></div>
    <section class="card"><div class="toolbar"><select id="dispatchStatus"><option value="">All statuses</option>${STATUSES.map(s => `<option value="${s}">${titleCase(s)}</option>`).join('')}</select><select id="dispatchTech"><option value="">All technicians</option><option value="unassigned">Unassigned</option></select><button class="btn btn--subtle btn--sm" id="dispatchRefresh">Refresh</button></div>
    <div class="table-wrap"><table class="data"><thead><tr><th>Booking</th><th>Customer</th><th>Scheduled</th><th>Technician</th><th>Status</th><th>Priority</th><th>Action</th></tr></thead><tbody id="dispatchRows">${skeletonRows(8)}</tbody></table></div></section>`;
  const rows = qs('#dispatchRows', view);
  try {
    const { data } = await api.get('/users', { limit: 100 });
    technicians = Array.isArray(data) ? data.filter(u => u.isActive !== false && ['STAFF','ADMIN'].includes(u.role)) : [];
    qs('#dispatchTech', view).innerHTML = `<option value="">All technicians</option><option value="unassigned">Unassigned</option>${technicians.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}`;
  } catch (e) { toastError(e); }

  async function load() {
    rows.innerHTML = skeletonRows(8);
    try {
      const query = { limit: 100, sort: 'scheduledAt', order: 'asc' };
      const status = qs('#dispatchStatus', view).value;
      const tech = qs('#dispatchTech', view).value;
      if (status) query.status = status;
      if (tech) query.technicianId = tech;
      const { data } = await api.get('/bookings', query);
      rows.innerHTML = data.length ? data.map(b => `<tr data-id="${esc(b.id)}"><td><code>${esc(b.reference)}</code></td><td>${esc(b.customer?.name || '—')}</td><td>${esc(dateTime(b.scheduledAt))}</td><td>${esc(b.technician?.name || 'Unassigned')}</td><td>${statusBadge(b.status)}</td><td>${statusBadge(b.priority, titleCase(b.priority))}</td><td><button class="btn btn--primary btn--sm" data-edit="${esc(b.id)}">Dispatch / Reschedule</button></td></tr>`).join('') : `<tr><td colspan="7">${emptyState('No dispatch jobs found','Create or schedule a service booking first.')}</td></tr>`;
    } catch (e) { rows.innerHTML = `<tr><td colspan="7">${emptyState('Could not load dispatch board', e.message)}</td></tr>`; }
  }

  async function openEditor(id) {
    const m = modal({ title: 'Dispatch / Reschedule', size: 'sm', body: '<div class="spinner"></div>', footer: '<button class="btn btn--ghost" data-close>Close</button><button class="btn btn--primary" id="saveDispatch">Save dispatch</button>' });
    try {
      const { data: b } = await api.get(`/bookings/${id}`);
      m.body.innerHTML = `<div style="display:grid;gap:14px"><div><strong>${esc(b.reference)}</strong> · ${esc(b.customer?.name || 'Customer')}</div><label><span>Scheduled date & time</span><input id="dispatchWhen" type="datetime-local" value="${localDateTime(b.scheduledAt)}"></label><label><span>Technician</span><select id="dispatchTechnician"><option value="">Unassigned</option>${technicians.map(t => `<option value="${esc(t.id)}" ${b.technicianId === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label><label><span>Status</span><select id="dispatchNewStatus">${STATUSES.map(s => `<option value="${s}" ${b.status === s ? 'selected' : ''}>${titleCase(s)}</option>`).join('')}</select></label><label><span>Priority</span><select id="dispatchPriority">${PRIORITIES.map(p => `<option value="${p}" ${(b.priority || 'NORMAL') === p ? 'selected' : ''}>${titleCase(p)}</option>`).join('')}</select></label><label class="checkline"><input id="dispatchNotify" type="checkbox" checked> Notify customer about status/schedule change</label><button class="btn btn--ghost btn--sm" id="sendReminder" type="button">Send customer reminder now</button></div>`;
      qs('#sendReminder', m.root).onclick = async () => { const btn = qs('#sendReminder', m.root); btn.disabled = true; try { const { data } = await api.post(`/reminders/bookings/${id}`); toast(data.alreadySent ? 'Reminder already sent for this appointment date' : 'Customer reminder sent'); } catch (e) { toastError(e); } finally { btn.disabled = false; } };
      qs('#saveDispatch', m.root).onclick = async () => {
        const btn = qs('#saveDispatch', m.root); btn.disabled = true;
        try {
          const notify = qs('#dispatchNotify', m.root).checked;
          await api.put(`/bookings/${id}`, { scheduledAt: new Date(qs('#dispatchWhen', m.root).value).toISOString(), technicianId: qs('#dispatchTechnician', m.root).value || null, status: qs('#dispatchNewStatus', m.root).value, priority: qs('#dispatchPriority', m.root).value, notify: false });
          if (notify) await api.post(`/reminders/bookings/${id}`);
          toast('Dispatch updated'); m.close(); await load();
        } catch (e) { toastError(e); btn.disabled = false; }
      };
    } catch (e) { m.body.innerHTML = emptyState('Could not load booking', e.message); }
  }

  rows.addEventListener('click', e => { const btn = e.target.closest('[data-edit]'); if (btn) openEditor(btn.dataset.edit); });
  qs('#dispatchStatus', view).onchange = load;
  qs('#dispatchTech', view).onchange = load;
  qs('#dispatchRefresh', view).onclick = load;
  await load();
}
