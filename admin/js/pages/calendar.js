import { api, auth } from '../api.js';
import { applyEntitlements } from '../entitlements.js';
import { setTitle } from '../layout.js';
import { qs, icon, esc, statusBadge, emptyState, modal, date, dateTime, money, toast, toastError, titleCase, confirmDialog } from '../ui.js';

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DOW_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const VIEWS = [
  ['day', 'Day'],
  ['3day', '3-Day'],
  ['week', 'Week'],
  ['month', 'Month'],
  ['agenda', 'Agenda'],
];
const STATE_KEY = 'nds.dispatch.calendar';

function readState() {
  try { return JSON.parse(sessionStorage.getItem(STATE_KEY) || '{}'); } catch (_) { return {}; }
}

function saveState(state) {
  try { sessionStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (_) {}
}

const isoDate = (d) => d.toISOString().slice(0, 10);
const addDays = (dateStr, n) => { const d = new Date(`${dateStr}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return isoDate(d); };
const fmtDay = (dateStr) => new Date(`${dateStr}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

export async function render(view) {
  setTitle('Calendar');
  const saved = readState();
  let v = VIEWS.some(([k]) => k === saved.view) ? saved.view : 'month';
  let month = /^\d{4}-\d{2}$/.test(saved.month || '') ? saved.month : new Date().toISOString().slice(0, 7);
  let date = /^\d{4}-\d{2}-\d{2}$/.test(saved.date || '') ? saved.date : new Date().toISOString().slice(0, 10);
  let technicianId = saved.technicianId || '';
  let status = saved.status || '';
  let serviceId = saved.serviceId || '';
  let customerId = saved.customerId || '';
  let search = saved.search || '';
  let panel = saved.panel === 'schedules' ? 'schedules' : 'calendar';

  let technicians = [];
  let services = [];
  let customers = [];
  try {
    const { data } = await api.get('/users', { limit: 100 });
    technicians = Array.isArray(data) ? data.filter((u) => u.role === 'STAFF' && u.isActive !== false) : [];
  } catch (_) { technicians = []; }
  try {
    const { data } = await api.get('/services', { limit: 100 });
    services = Array.isArray(data) ? data : [];
  } catch (_) { services = []; }
  try {
    const { data } = await api.get('/customers', { limit: 100 });
    customers = Array.isArray(data) ? (data.data || data) : [];
  } catch (_) { customers = []; }

  const canManage = auth.isAdmin || auth.user?.role === 'ADMIN';
  const persist = () => saveState({ view: v, month, date, technicianId, status, serviceId, customerId, search, panel });

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Calendar</h1><p>Schedule and dispatch service appointments by date, technician, service and customer.</p></div>
      <div class="page-head__actions">
        <a class="btn btn--primary" href="#/bookings?new=1" data-feature="service-bookings">${icon('plus')} New booking</a>
      </div>
    </div>
    <div class="tabs" role="tablist" id="panelTabs">
      <button class="tab" role="tab" data-panel="calendar" aria-selected="${panel === 'calendar'}">Appointments</button>
      ${canManage ? `<button class="tab" role="tab" data-panel="schedules" aria-selected="${panel === 'schedules'}">Technician schedules</button>` : ''}
    </div>
    <section class="card" style="margin-top:12px" id="calendarPanel" ${panel === 'schedules' ? 'hidden' : ''}>
      <div class="card__head"><h2 id="rangeLabel">—</h2>
        <div class="card__actions legend">
          <span><i style="background:var(--warning)"></i>Pending</span>
          <span><i style="background:var(--info)"></i>Confirmed</span>
          <span><i style="background:var(--purple)"></i>In progress</span>
          <span><i style="background:var(--success)"></i>Completed</span>
          <span><i style="background:var(--danger)"></i>Cancelled</span>
        </div>
      </div>
      <div class="card__body">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:space-between">
          <div class="cal-viewtabs" role="group" aria-label="Calendar view">
            ${VIEWS.map(([k, label]) => `<button class="cal-viewtab" data-view="${k}" aria-pressed="${k === v}">${label}</button>`).join('')}
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <button class="btn btn--ghost btn--icon" id="prevBtn" aria-label="Previous period">‹</button>
            <button class="btn btn--ghost" id="todayBtn">Today</button>
            <button class="btn btn--ghost btn--icon" id="nextBtn" aria-label="Next period">›</button>
            <input id="dateJump" type="date" value="${esc(date)}" aria-label="Jump to date">
          </div>
        </div>
        <div class="filters" style="margin:12px 0 16px;display:flex;gap:10px;flex-wrap:wrap;align-items:end">
          <label style="min-width:170px"><span>Technician</span><select id="technicianFilter">
            <option value="">All technicians</option><option value="unassigned">Unassigned</option>
            ${technicians.filter((t) => t.isActive !== false).map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}
          </select></label>
          <label style="min-width:150px"><span>Status</span><select id="statusFilter">
            <option value="">All statuses</option><option value="PENDING">Pending</option><option value="CONFIRMED">Confirmed</option>
            <option value="IN_PROGRESS">In progress</option><option value="COMPLETED">Completed</option><option value="CANCELLED">Cancelled</option>
          </select></label>
          <label style="min-width:180px"><span>Service</span><select id="serviceFilter">
            <option value="">All services</option>${services.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}
          </select></label>
          <label style="min-width:180px"><span>Customer</span><select id="customerFilter">
            <option value="">All customers</option>${customers.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}
          </select></label>
          <label style="min-width:170px"><span>Search</span><input id="searchInput" type="search" placeholder="Ref, customer, address…" value="${esc(search)}"></label>
          <button class="btn btn--ghost" id="clearFilters">Clear filters</button>
        </div>
        <div id="calendar"></div>
      </div>
    </section>
    <section class="card" style="margin-top:12px" id="schedulesPanel" ${panel === 'calendar' ? 'hidden' : ''}>
      <div class="card__body" id="schedulesBody"><div class="cell-sub" style="padding:24px 0;text-align:center">Select a technician to view and manage their schedule.</div></div>
    </section>`;
  applyEntitlements(view);

  qs('#technicianFilter', view).value = technicianId;
  qs('#statusFilter', view).value = status;
  qs('#serviceFilter', view).value = serviceId;
  qs('#customerFilter', view).value = customerId;

  view.querySelectorAll('#panelTabs .tab').forEach((t) => {
    t.onclick = () => {
      panel = t.dataset.panel;
      persist();
      showPanel();
    };
  });

  function showPanel() {
    view.querySelectorAll('#panelTabs .tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.panel === panel)));
    qs('#calendarPanel', view).hidden = panel !== 'calendar';
    qs('#schedulesPanel', view).hidden = panel !== 'schedules';
    if (panel === 'schedules') loadSchedules();
    else load();
  }

  // ================================================================ calendar
  const query = () => {
    const q = { view: v, date, technicianId, status, serviceId, customerId, search };
    if (v === 'month') { q.month = month; delete q.date; }
    return q;
  };

  async function load() {
    const host = qs('#calendar', view);
    view.querySelectorAll('.cal-viewtab').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === v)));
    host.innerHTML = '<div style="display:grid;place-items:center;min-height:320px"><div class="spinner"></div></div>';
    let data;
    try {
      ({ data } = await api.get('/bookings/calendar', query()));
    } catch (e) {
      host.innerHTML = emptyState('Could not load the calendar', e.message);
      return;
    }
    renderView(host, data);
  }

  function renderView(host, data) {
    const today = isoDate(new Date());
    if (v === 'month') {
      const [year, mon] = month.split('-').map(Number);
      const first = new Date(Date.UTC(year, mon - 1, 1));
      const daysInMonth = new Date(Date.UTC(year, mon, 0)).getUTCDate();
      const offset = (first.getUTCDay() + 6) % 7;
      let cells = DOW.map((d) => `<div class="calendar__dow" aria-hidden="true">${d}</div>`).join('');
      cells += Array.from({ length: offset }, () => '<div class="calendar__day calendar__day--empty"></div>').join('');
      for (let day = 1; day <= daysInMonth; day++) {
        const key = `${month}-${String(day).padStart(2, '0')}`;
        const evs = data.days[key] || [];
        cells += `<div class="calendar__day ${key === today ? 'calendar__day--today' : ''}">
          <span class="calendar__num">${day}</span>
          ${evs.slice(0, 4).map((e) => eventChip(e)).join('')}
          ${evs.length > 4 ? `<span class="cell-sub">+${evs.length - 4} more</span>` : ''}
        </div>`;
      }
      host.innerHTML = `<div class="calendar">${cells}</div>`;
      if (!data.total) host.insertAdjacentHTML('beforeend', emptyState('No bookings this month', 'Use “New booking” to schedule an appointment.'));
    } else if (v === 'day' || v === '3day' || v === 'week') {
      const start = new Date(data.range.start);
      const end = new Date(data.range.end);
      const dayCount = Math.round((end - start) / 864e5);
      host.innerHTML = `<div class="cal-columns cal-columns--${v}">` + Array.from({ length: dayCount }, (_, i) => {
        const colDate = new Date(start.getTime() + i * 864e5);
        const key = isoDate(colDate);
        const evs = data.days[key] || [];
        const label = i === 0
          ? (v === 'day' ? fmtDay(key) : DOW[(start.getUTCDay() + 6) % 7])
          : (v === 'week' ? DOW[(colDate.getUTCDay() + 6) % 7] : colDate.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', timeZone: 'UTC' }));
        return `<div class="cal-column">
          <div class="cal-column__head ${key === today ? 'cal-column__head--today' : ''}">${esc(label)}${key === today ? ' <span class="cal-today-tag">Today</span>' : ''}</div>
          <div class="cal-column__body">
            ${evs.map((e) => `<div class="cal-slot">
              <div class="cal-slot__time">${esc(e.start)}–${esc(e.end)}</div>
              <button class="cal-event cal-event--${esc(e.status)}" data-id="${esc(e.id)}" title="${esc(e.reference)}">${esc(e.customer || 'Booking')}${e.recurring ? ' <span class="cal-flag" title="Recurring">⟳</span>' : ''}${e.workOrder ? ' <span class="cal-flag" title="Linked work order">WO</span>' : ''}</button>
              ${e.technician ? `<div class="cal-slot__tech">${icon('wrench')} ${esc(e.technician)}</div>` : '<div class="cal-slot__tech cal-slot__tech--none">Unassigned</div>'}
            </div>`).join('') || '<div class="cal-slot cal-slot--empty">No bookings</div>'}
          </div>
        </div>`;
      }).join('') + '</div>';
      if (!data.total) host.insertAdjacentHTML('beforeend', emptyState('No bookings in this period', 'Use “New booking” to schedule an appointment.'));
    } else {
      const keys = Object.keys(data.days || {}).sort();
      if (!keys.length) {
        host.innerHTML = emptyState('No bookings in the next 14 days', 'Use “New booking” to schedule an appointment.');
        return;
      }
      host.innerHTML = `<div class="cal-agenda">` + keys.map((key) => `
        <div class="cal-agenda__day">
          <h3 class="cal-agenda__head ${key === today ? 'cal-agenda__head--today' : ''}">${fmtDay(key)} <span class="cell-sub">(${data.days[key].length})</span>${key === today ? ' <span class="cal-today-tag">Today</span>' : ''}</h3>
          ${data.days[key].map((e) => `<div class="cal-agenda__row">
            <span class="cal-agenda__time">${esc(e.start)}–${esc(e.end)}</span>
            <button class="cal-agenda__event cal-event--${esc(e.status)}" data-id="${esc(e.id)}">${esc(e.customer || 'Booking')} ${statusBadge(e.status)}
              <span class="cell-sub">${esc(e.service || '')}${e.technician ? ` · ${esc(e.technician)}` : ' · Unassigned'}</span>
              ${e.recurring ? ' <span class="cal-flag" title="Recurring">⟳</span>' : ''}${e.workOrder ? ' <span class="cal-flag" title="Linked work order">WO</span>' : ''}</button>
          </div>`).join('')}
        </div>`).join('') + '</div>';
    }
    qs('#rangeLabel', view).textContent = rangeLabel(data);
  }

  function eventChip(e) {
    const flags = `${e.recurring ? ' <span title="Recurring maintenance" class="cal-flag">⟳</span>' : ''}${e.workOrder ? ' <span title="Linked work order" class="cal-flag">WO</span>' : ''}`;
    return `<button class="cal-event cal-event--${esc(e.status)}" data-id="${esc(e.id)}"
      title="${esc(e.start)}–${esc(e.end)} ${esc(e.customer || '')}${e.technician ? ` — ${esc(e.technician)}` : ''}">${esc(e.start)} ${esc(e.customer || 'Booking')}${flags}</button>`;
  }

  function rangeLabel(data) {
    const total = `${data.total} booking(s)`;
    if (v === 'month') return `${new Date(`${month}-01T00:00:00Z`).toLocaleString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })} — ${total}`;
    if (v === 'day') return `${fmtDay(date)} — ${total}`;
    if (v === '3day') return `${fmtDay(date)} → ${fmtDay(addDays(date, 2))} — ${total}`;
    if (v === 'week') return `${fmtDay(isoDate(new Date(data.range.start)))} → ${fmtDay(isoDate(new Date(data.range.end - 864e5)))} — ${total}`;
    return `Next 14 days from ${fmtDay(date)} — ${total}`;
  }

  const step = { day: 1, '3day': 3, week: 7, agenda: 14 };
  function shift(delta) {
    if (v === 'month') {
      const [y, m] = month.split('-').map(Number);
      month = new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
    } else {
      date = addDays(date, delta * (step[v] || 1));
    }
    persist(); load();
  }

  qs('#prevBtn', view).onclick = () => shift(-1);
  qs('#nextBtn', view).onclick = () => shift(1);
  qs('#todayBtn', view).onclick = () => { date = isoDate(new Date()); month = date.slice(0, 7); persist(); load(); };
  qs('#dateJump', view).onchange = (e) => { if (!e.target.value) return; date = e.target.value; month = date.slice(0, 7); persist(); load(); };
  qs('#technicianFilter', view).onchange = (e) => { technicianId = e.target.value; persist(); load(); };
  qs('#statusFilter', view).onchange = (e) => { status = e.target.value; persist(); load(); };
  qs('#serviceFilter', view).onchange = (e) => { serviceId = e.target.value; persist(); load(); };
  qs('#customerFilter', view).onchange = (e) => { customerId = e.target.value; persist(); load(); };
  let searchTimer = null;
  qs('#searchInput', view).oninput = (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { search = e.target.value.trim(); persist(); load(); }, 350); };
  qs('#clearFilters', view).onclick = () => {
    technicianId = status = serviceId = customerId = search = '';
    qs('#technicianFilter', view).value = ''; qs('#statusFilter', view).value = ''; qs('#serviceFilter', view).value = '';
    qs('#customerFilter', view).value = ''; qs('#searchInput', view).value = '';
    persist(); load();
  };
  view.querySelectorAll('.cal-viewtab').forEach((b) => {
    b.onclick = () => { v = b.dataset.view; persist(); load(); };
  });

  view.addEventListener('click', async (e) => {
    const btn = e.target.closest('#calendar [data-id]');
    if (!btn) return;
    openDetail(btn.dataset.id);
  });

  async function openDetail(id) {
    const m = modal({
      title: 'Appointment',
      body: '<div style="display:grid;place-items:center;min-height:120px"><div class="spinner"></div></div>',
      footer: '<button class="btn btn--ghost" data-close>Close</button>',
    });
    let booking;
    try {
      ({ data: booking } = await api.get(`/bookings/${id}`));
    } catch (err) {
      m.body.innerHTML = emptyState('Could not load appointment', err.message);
      return;
    }
    m.body.innerHTML = `
      <div style="display:flex;gap:9px;flex-wrap:wrap;margin-bottom:14px;align-items:center">
        <code style="font-weight:700">${esc(booking.reference)}</code>${statusBadge(booking.status)}
        ${booking.recurringOccurrence ? '<span class="badge badge--info">Recurring</span>' : ''}
      </div>
      <div id="conflictBanner"></div>
      <dl class="kv">
        <dt>Customer</dt><dd>${esc(booking.customer?.name)}${booking.customer?.phone ? ` · ${esc(booking.customer.phone)}` : ''}</dd>
        <dt>Service</dt><dd>${esc(booking.service?.name || 'General service')}</dd>
        <dt>When</dt><dd>${esc(dateTime(booking.scheduledAt))}${booking.durationMin || booking.service?.durationMin ? ` · ${booking.durationMin || booking.service.durationMin} min` : ''}</dd>
        <dt>Technician</dt><dd>${esc(booking.technician?.name || 'Unassigned')}</dd>
        <dt>Address</dt><dd>${esc(booking.address || booking.customer?.address || '—')}</dd>
        <dt>Value</dt><dd>${money(booking.price)}</dd>
        ${booking.description ? `<dt>Notes</dt><dd>${esc(booking.description)}</dd>` : ''}
        ${booking.workOrder ? `<dt>Work order</dt><dd><a href="#/work-orders">View work order (${esc(booking.workOrder.status)})</a></dd>` : ''}
      </dl>
      ${(booking.notes?.length || 0) ? `<h3 style="margin:14px 0 6px">Booking notes</h3><ul class="cal-notes">${booking.notes.map((n) => `<li>${esc(n.body)} <span class="cell-sub">— ${esc(n.user?.name || 'Staff')} · ${esc(date(n.createdAt))}</span></li>`).join('')}</ul>` : ''}
      <div id="modalActions"></div>`;

    if (canManage) {
      qs('#modalActions', m.root).innerHTML = `
        <div style="display:grid;gap:12px;margin-top:16px">
          <label><span>Status</span><select id="detailStatus">${['PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'].map((s) => `<option value="${s}" ${booking.status === s ? 'selected' : ''}>${titleCase(s)}</option>`).join('')}</select></label>
          <label><span>Technician</span><select id="detailTechnician"><option value="">Unassigned</option>${technicians.filter((t) => t.isActive !== false).map((t) => `<option value="${esc(t.id)}" ${booking.technician?.id === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
          <label><span>Reschedule</span><input id="detailWhen" type="datetime-local" value="${toLocalInput(booking.scheduledAt)}"></label>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn--ghost" id="saveChanges">Save changes</button>
            <button class="btn btn--ghost" id="cancelBooking">Cancel appointment</button>
            <button class="btn btn--ghost btn--danger" id="deleteBooking">Delete</button>
          </div>
          <label><span>Add note</span><div style="display:flex;gap:8px"><input id="noteInput" placeholder="Note for this appointment…" style="flex:1"><button class="btn btn--ghost" id="addNote">Add</button></div></label>
        </div>`;

      async function refreshConflicts() {
        const banner = qs('#conflictBanner', m.root);
        if (!banner) return;
        const technicianSel = qs('#detailTechnician', m.root);
        const whenSel = qs('#detailWhen', m.root);
        if (!technicianSel || !whenSel) { banner.innerHTML = ''; return; }
        const when = String(whenSel.value);
        const timeMatch = when.match(/(\d{2}):(\d{2})$/);
        const dpart = when.slice(0, 10);
        if (!dpart) { banner.innerHTML = ''; return; }
        const avail = await api.get('/bookings/availability', {
          technicianId: technicianSel.value || undefined,
          date: dpart,
          time: timeMatch ? `${timeMatch[1]}:${timeMatch[2]}` : undefined,
          durationMin: booking.durationMin || booking.service?.durationMin || undefined,
          serviceId: booking.serviceId || undefined,
          ignoreBookingId: booking.id,
        }).catch(() => null);
        if (!avail || !avail.data) { banner.innerHTML = ''; return; }
        const { conflicts, warnings } = avail.data;
        const html = [];
        for (const c of conflicts) html.push(`<div class="alert alert--error" style="margin-bottom:8px">${icon('alert')} ${esc(c.message)}</div>`);
        for (const w of warnings) html.push(`<div class="alert alert--warning" style="margin-bottom:8px">${icon('alert')} ${esc(w.message)}</div>`);
        banner.innerHTML = html.join('');
      }

      qs('#detailTechnician', m.root).addEventListener('change', refreshConflicts);
      qs('#detailWhen', m.root).addEventListener('change', refreshConflicts);
      refreshConflicts();

      qs('#saveChanges', m.root).onclick = async () => {
        const button = qs('#saveChanges', m.root);
        button.disabled = true;
        const body = {
          status: qs('#detailStatus', m.root).value,
          technicianId: qs('#detailTechnician', m.root).value || null,
          notify: false,
        };
        const when = qs('#detailWhen', m.root).value;
        if (when) body.scheduledAt = new Date(when).toISOString();
        try {
          const r = await api.put(`/bookings/${booking.id}`, body);
          if (r.conflicts?.length || r.warnings?.length) toast('Saved — review the scheduling warnings above', 'warning');
          else toast('Appointment updated');
          m.close(); await load();
        } catch (err) {
          toastError(err);
          if (err.details?.conflicts?.length) {
            qs('#conflictBanner', m.root).innerHTML = err.details.conflicts.map((c) => `<div class="alert alert--error" style="margin-bottom:8px">${esc(c.message)}</div>`).join('');
          }
          button.disabled = false;
        }
      };
      qs('#cancelBooking', m.root).onclick = async () => {
        if (!(await confirmDialog({ title: 'Cancel appointment', message: `Cancel ${booking.reference} for ${booking.customer?.name || 'this customer'}?`, confirmLabel: 'Cancel appointment', danger: true }))) return;
        try { await api.patch(`/bookings/${booking.id}/status`, { status: 'CANCELLED' }); toast('Appointment cancelled'); m.close(); await load(); }
        catch (err) { toastError(err); }
      };
      qs('#deleteBooking', m.root).onclick = async () => {
        if (!(await confirmDialog({ title: 'Delete appointment', message: `Permanently delete ${booking.reference}? This cannot be undone.`, confirmLabel: 'Delete', danger: true }))) return;
        try { await api.del(`/bookings/${booking.id}`); toast('Appointment deleted'); m.close(); await load(); }
        catch (err) { toastError(err); }
      };
      qs('#addNote', m.root).onclick = async () => {
        const input = qs('#noteInput', m.root);
        const body = input.value.trim();
        if (!body) return;
        try { await api.post(`/bookings/${booking.id}/notes`, { body }); toast('Note added'); openDetail(booking.id); }
        catch (err) { toastError(err); }
      };
    } else {
      qs('#modalActions', m.root).innerHTML = '<p class="cell-sub" style="margin-top:12px">Read-only — you do not have permission to change this appointment.</p>';
    }
  }

  function toLocalInput(iso) {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // ============================================================== schedules
  async function loadSchedules() {
    const host = qs('#schedulesBody', view);
    if (!technicians.length) {
      host.innerHTML = emptyState('No technicians yet', 'Add staff from the Team page to manage their schedules.');
      return;
    }
    const techId = technicians.some((t) => t.id === technicianId) ? technicianId : technicians[0].id;
    const [roster, businessHours] = await Promise.all([
      api.get('/scheduling/technicians').then((r) => r.data).catch(() => null),
      api.get('/settings').then((r) => r.data?.hours).catch(() => null),
    ]);
    const tech = (roster || technicians).find((t) => t.id === techId) || technicians[0];
    const hoursRows = (tech.workingHours || []).sort((a, b) => a.day - b.day);
    const hourByDay = Object.fromEntries(hoursRows.map((h) => [h.day, h]));
    const defaultByDay = {};
    for (let d = 0; d < 7; d++) defaultByDay[d + 1] = businessHours?.[DOW_FULL[d].toLowerCase()] || '—';

    host.innerHTML = `
      <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:16px">
        <label style="min-width:220px"><span>Technician</span><select id="schedTech">
          ${technicians.map((t) => `<option value="${esc(t.id)}" ${t.id === tech.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
        </select></label>
        <span class="hint">Times are 24-hour (HH:mm). Leave a day blank to inherit the business hours (“${esc(defaultByDay[1] || '08:00-17:00')}…”).</span>
      </div>
      <div class="cal-sched-grid">
        <div class="cal-sched-block">
          <h3>Working hours — ${esc(tech.name)}</h3>
          <table class="cal-sched-table">
            <thead><tr><th>Day</th><th>Start</th><th>End</th><th>Business default</th><th></th></tr></thead>
            <tbody>${DOW_FULL.map((name, i) => {
              const d = i + 1;
              const row = hourByDay[d];
              return `<tr>
                <td>${name}</td>
                <td><input type="time" class="sched-hour-start" data-day="${d}" value="${row ? esc(row.start) : ''}" ${canManage ? '' : 'disabled'}></td>
                <td><input type="time" class="sched-hour-end" data-day="${d}" value="${row ? esc(row.end) : ''}" ${canManage ? '' : 'disabled'}></td>
                <td class="cell-sub">${esc(defaultByDay[d])}</td>
                <td>${canManage ? `<button class="btn btn--ghost btn--icon sched-hour-clear" data-day="${d}" data-id="${row ? esc(row.id) : ''}" aria-label="Clear ${name} hours" title="Clear">✕</button>` : ''}</td>
              </tr>`;
            }).join('')}</tbody>
          </table>
        </div>
        <div class="cal-sched-block">
          <h3>Time off / holidays — ${esc(tech.name)}</h3>
          <ul class="cal-sched-list">${(tech.upcomingTimeOff || []).map((t) => `
            <li><span>${esc(date(t.startsAt))} → ${esc(date(t.endsAt))}${t.reason ? ` <span class="cell-sub">— ${esc(t.reason)}</span>` : ''}</span>
              ${canManage ? `<button class="btn btn--ghost btn--icon sched-timeoff-delete" data-id="${esc(t.id)}" aria-label="Delete time off">✕</button>` : ''}</li>`).join('') || '<li class="cell-sub">None upcoming</li>'}</ul>
          ${canManage ? `
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;align-items:end">
            <label style="flex:1;min-width:130px"><span>From</span><input type="date" id="timeoffFrom"></label>
            <label style="flex:1;min-width:130px"><span>To</span><input type="date" id="timeoffTo"></label>
            <label style="flex:2;min-width:150px"><span>Reason</span><input type="text" id="timeoffReason" placeholder="e.g. Public holiday"></label>
            <button class="btn btn--ghost" id="timeoffAdd">${icon('plus')} Add time off</button>
          </div>` : ''}
        </div>
        <div class="cal-sched-block">
          <h3>Business breaks (all technicians)</h3>
          <table class="cal-sched-table">
            <thead><tr><th>Day</th><th>Start</th><th>End</th></tr></thead>
            <tbody id="breaksBody"><tr><td colspan="3" class="cell-sub">Loading…</td></tr></tbody>
          </table>
        </div>
        <div class="cal-sched-block">
          <h3>Closed days (business-wide)</h3>
          <ul class="cal-sched-list" id="closedDaysList"><li class="cell-sub">Loading…</li></ul>
          ${canManage ? `
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;align-items:end">
            <label style="flex:1;min-width:130px"><span>Date</span><input type="date" id="closedDayDate"></label>
            <label style="flex:2;min-width:150px"><span>Reason</span><input type="text" id="closedDayReason" placeholder="e.g. Christmas"></label>
            <button class="btn btn--ghost" id="closedDayAdd">${icon('plus')} Add closed day</button>
          </div>` : ''}
        </div>
      </div>`;

    if (canManage) {
      host.querySelectorAll('.sched-hour-start, .sched-hour-end').forEach((input) => {
        input.addEventListener('change', async () => {
          const d = Number(input.dataset.day);
          const s = host.querySelector(`.sched-hour-start[data-day="${d}"]`).value;
          const e2 = host.querySelector(`.sched-hour-end[data-day="${d}"]`).value;
          if (!s && !e2) return;
          if (!s || !e2) return toast('Set both start and end times for a day', 'warning');
          try { await api.put('/scheduling/working-hours', { userId: tech.id, day: d, start: s, end: e2 }); toast(`${DOW_FULL[d - 1]} hours saved`); loadSchedules(); }
          catch (err) { toastError(err); }
        });
      });
      host.querySelectorAll('.sched-hour-clear').forEach((btn) => {
        btn.onclick = async () => {
          if (!btn.dataset.id) { btn.closest('tr').querySelector('.sched-hour-start').value = ''; btn.closest('tr').querySelector('.sched-hour-end').value = ''; return; }
          try { await api.del(`/scheduling/working-hours/${btn.dataset.id}`); toast('Hours cleared'); loadSchedules(); }
          catch (err) { toastError(err); }
        };
      });
      qs('#timeoffAdd', host).onclick = async () => {
        const from = qs('#timeoffFrom', host).value;
        const to = qs('#timeoffTo', host).value;
        if (!from || !to) return toast('Choose both dates', 'warning');
        try {
          await api.post('/scheduling/time-off', { userId: tech.id, startsAt: `${from}T00:00:00.000Z`, endsAt: `${to}T23:59:59.000Z`, reason: qs('#timeoffReason', host).value || null });
          toast('Time off added'); loadSchedules();
        } catch (err) { toastError(err); }
      };
      host.querySelectorAll('.sched-timeoff-delete').forEach((btn) => {
        btn.onclick = async () => {
          try { await api.del(`/scheduling/time-off/${btn.dataset.id}`); toast('Time off removed'); loadSchedules(); }
          catch (err) { toastError(err); }
        };
      });
      qs('#closedDayAdd', host).onclick = async () => {
        const d = qs('#closedDayDate', host).value;
        if (!d) return toast('Choose a date', 'warning');
        try {
          await api.post('/scheduling/closed-days', { date: `${d}T00:00:00.000Z`, reason: qs('#closedDayReason', host).value || null });
          toast('Closed day added'); loadSchedules();
        } catch (err) { toastError(err); }
      };
      host.querySelectorAll('.closedday-delete').forEach((btn) => {
        btn.onclick = async () => {
          try { await api.del(`/scheduling/closed-days/${btn.dataset.id}`); toast('Closed day removed'); loadSchedules(); }
          catch (err) { toastError(err); }
        };
      });
    }

    qs('#schedTech', host).onchange = (e) => { technicianId = e.target.value; loadSchedules(); };

    // business-wide breaks + closed days
    try {
      const { data: breaks } = await api.get('/scheduling/breaks');
      const businessBreaks = (breaks || []).filter((b) => !b.userId).sort((a, b) => a.day - b.day);
      const byDay = Object.fromEntries(businessBreaks.map((b) => [b.day, b]));
      qs('#breaksBody', host).innerHTML = DOW_FULL.map((name, i) => {
        const d = i + 1;
        const row = byDay[d];
        return `<tr>
          <td>${name}</td>
          <td><input type="time" class="sched-break-start" data-day="${d}" value="${row ? esc(row.start) : ''}" ${canManage ? '' : 'disabled'}></td>
          <td><input type="time" class="sched-break-end" data-day="${d}" value="${row ? esc(row.end) : ''}" ${canManage ? '' : 'disabled'}></td>
        </tr>`;
      }).join('');
      if (canManage) {
        host.querySelectorAll('.sched-break-start, .sched-break-end').forEach((input) => {
          input.addEventListener('change', async () => {
            const d = Number(input.dataset.day);
            const s = host.querySelector(`.sched-break-start[data-day="${d}"]`).value;
            const e2 = host.querySelector(`.sched-break-end[data-day="${d}"]`).value;
            if (!s && !e2) return;
            if (!s || !e2) return toast('Set both start and end times for a break', 'warning');
            try { await api.put('/scheduling/breaks', { userId: null, day: d, start: s, end: e2 }); toast(`${DOW_FULL[d - 1]} break saved`); loadSchedules(); }
            catch (err) { toastError(err); }
          });
        });
      }
    } catch (_) { qs('#breaksBody', host).innerHTML = '<tr><td colspan="3" class="cell-sub">Could not load breaks</td></tr>'; }

    try {
      const { data: closedDays } = await api.get('/scheduling/closed-days');
      qs('#closedDaysList', host).innerHTML = (closedDays || []).map((c) => `
        <li><span>${esc(date(c.date))}${c.reason ? ` <span class="cell-sub">— ${esc(c.reason)}</span>` : ''}</span>
          ${canManage ? `<button class="btn btn--ghost btn--icon closedday-delete" data-id="${esc(c.id)}" aria-label="Delete closed day">✕</button>` : ''}</li>`).join('') || '<li class="cell-sub">None set</li>';
    } catch (_) { qs('#closedDaysList', host).innerHTML = '<li class="cell-sub">Could not load closed days</li>'; }
  }

  showPanel();
}
