import { api } from '../api.js';
import { setTitle } from '../layout.js';
import { qs, icon, esc, statusBadge, emptyState, modal, dateTime, money, toastError, titleCase } from '../ui.js';

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export async function render(view) {
  setTitle('Calendar');
  let month = new Date().toISOString().slice(0, 7);

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Booking Calendar</h1><p>Monthly overview of every scheduled service appointment.</p></div>
      <div class="page-head__actions">
        <button class="btn btn--ghost btn--icon" id="prevBtn" aria-label="Previous month">‹</button>
        <button class="btn btn--ghost" id="todayBtn">Today</button>
        <button class="btn btn--ghost btn--icon" id="nextBtn" aria-label="Next month">›</button>
        <a class="btn btn--primary" href="#/bookings?new=1">${icon('plus')} New booking</a>
      </div>
    </div>
    <section class="card">
      <div class="card__head"><h2 id="monthLabel">—</h2>
        <div class="card__actions legend">
          <span><i style="background:var(--warning)"></i>Pending</span>
          <span><i style="background:var(--info)"></i>Confirmed</span>
          <span><i style="background:var(--purple)"></i>In progress</span>
          <span><i style="background:var(--success)"></i>Completed</span>
          <span><i style="background:var(--danger)"></i>Cancelled</span>
        </div></div>
      <div class="card__body"><div id="calendar"></div></div>
    </section>`;

  async function load() {
    const host = qs('#calendar', view);
    host.innerHTML = '<div style="display:grid;place-items:center;min-height:320px"><div class="spinner"></div></div>';
    try {
      const { data } = await api.get('/bookings/calendar', { month });
      const [year, mon] = month.split('-').map(Number);
      const first = new Date(Date.UTC(year, mon - 1, 1));
      const daysInMonth = new Date(Date.UTC(year, mon, 0)).getUTCDate();
      const offset = (first.getUTCDay() + 6) % 7; // Monday-first
      const today = new Date().toISOString().slice(0, 10);

      qs('#monthLabel', view).textContent =
        `${first.toLocaleString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })} — ${data.total} booking(s)`;

      let cells = DOW.map((d) => `<div class="calendar__dow" aria-hidden="true">${d}</div>`).join('');
      cells += Array.from({ length: offset }, () => '<div class="calendar__day calendar__day--empty"></div>').join('');
      for (let day = 1; day <= daysInMonth; day++) {
        const key = `${month}-${String(day).padStart(2, '0')}`;
        const events = data.days[key] || [];
        cells += `<div class="calendar__day ${key === today ? 'calendar__day--today' : ''}">
          <span class="calendar__num">${day}</span>
          ${events.slice(0, 4).map((e) => `<button class="cal-event cal-event--${esc(e.status)}" data-id="${esc(e.id)}"
              title="${esc(e.time)} ${esc(e.customer || '')} — ${esc(titleCase(e.status))}">${esc(e.time)} ${esc(e.customer || 'Booking')}</button>`).join('')}
          ${events.length > 4 ? `<span class="cell-sub">+${events.length - 4} more</span>` : ''}
        </div>`;
      }
      host.innerHTML = `<div class="calendar">${cells}</div>`;
      if (!data.total) host.insertAdjacentHTML('beforeend', emptyState('No bookings this month', 'Use “New booking” to schedule an appointment.'));
    } catch (e) { host.innerHTML = emptyState('Could not load the calendar', e.message); }
  }

  const shift = (delta) => {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    month = d.toISOString().slice(0, 7);
    load();
  };
  qs('#prevBtn', view).onclick = () => shift(-1);
  qs('#nextBtn', view).onclick = () => shift(1);
  qs('#todayBtn', view).onclick = () => { month = new Date().toISOString().slice(0, 7); load(); };

  view.addEventListener('click', async (e) => {
    const btn = e.target.closest('.cal-event');
    if (!btn) return;
    const m = modal({ title: 'Booking', size: 'sm', body: '<div style="display:grid;place-items:center;min-height:120px"><div class="spinner"></div></div>',
      footer: '<button class="btn btn--ghost" data-close>Close</button><a class="btn btn--primary" href="#/bookings">Open bookings</a>' });
    try {
      const { data: b } = await api.get(`/bookings/${btn.dataset.id}`);
      m.body.innerHTML = `<div style="display:flex;gap:9px;flex-wrap:wrap;margin-bottom:14px">
          <code style="font-weight:700">${esc(b.reference)}</code>${statusBadge(b.status)}</div>
        <dl class="kv">
          <dt>Customer</dt><dd>${esc(b.customer.name)}</dd>
          <dt>Phone</dt><dd>${esc(b.customer.phone || '—')}</dd>
          <dt>Service</dt><dd>${esc(b.service?.name || 'General service')}</dd>
          <dt>When</dt><dd>${esc(dateTime(b.scheduledAt))}</dd>
          <dt>Technician</dt><dd>${esc(b.technician?.name || 'Unassigned')}</dd>
          <dt>Value</dt><dd>${money(b.price)}</dd>
          <dt>Address</dt><dd>${esc(b.address || '—')}</dd>
        </dl>`;
    } catch (err) { m.body.innerHTML = emptyState('Could not load booking', err.message); }
  });

  await load();
}
