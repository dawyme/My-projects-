import { api } from '../api.js';
import { el, esc, toastError } from '../ui.js';

export async function render(view) {
  view.innerHTML = `<div class="page-head"><div><h1>Recurring Maintenance</h1><p>Schedule preventive maintenance and keep customers reminded. This core feature is available on every plan.</p></div></div>
    <div id="maintenanceList"><div class="card"><div class="card__body"><div class="spinner"></div></div></div></div>
    <div class="card" style="margin-top:16px"><div class="card__body"><h2>Schedule next maintenance</h2>
      <form id="recurringMaintenanceForm" class="form-grid">
        <label>Customer ID<input name="customerId" required placeholder="Customer ID"></label>
        <label>Equipment ID<input name="equipmentId" placeholder="Optional equipment ID"></label>
        <label>Service ID<input name="serviceId" placeholder="Optional service ID"></label>
        <label>Technician ID<input name="technicianId" placeholder="Optional technician ID"></label>
        <label>First appointment<input name="startDate" type="datetime-local" required></label>
        <label>Repeat every<select name="intervalMonths"><option value="1">1 month</option><option value="2">2 months</option><option value="3" selected>3 months</option><option value="6">6 months</option><option value="12">12 months</option></select></label>
        <label>Reminder offsets<input name="reminderOffsets" value="30,7,1,0" aria-label="Reminder offsets in days"></label>
        <div><button class="btn btn--primary" type="submit">Schedule maintenance</button></div>
      </form><p id="maintenanceMessage" class="muted" aria-live="polite"></p>
    </div></div>`;

  const list = el('#maintenanceList');
  const message = el('#maintenanceMessage');
  async function load() {
    try {
      const { data } = await api.get('/recurring-maintenance');
      const rows = data || [];
      list.innerHTML = rows.length ? rows.map((s) => `<article class="card"><div class="card__body">
        <div class="badge">${esc(s.status)}</div><h2>${esc(s.serviceLabel || s.service?.name || 'Preventive maintenance')}</h2>
        <p>${esc(s.customer?.name || 'Customer')} · every ${esc(s.intervalMonths)} month(s)</p>
        <p>Next: ${s.nextOccurrenceAt ? esc(new Date(s.nextOccurrenceAt).toLocaleString()) : '—'} · Technician: ${esc(s.technician?.name || 'Unassigned')}</p>
        <div class="actions">
          <button class="btn" data-action="pause" data-id="${esc(s.id)}" ${s.status !== 'ACTIVE' ? 'disabled' : ''}>Pause</button>
          <button class="btn" data-action="resume" data-id="${esc(s.id)}" ${s.status !== 'PAUSED' ? 'disabled' : ''}>Resume</button>
          <button class="btn btn--danger" data-action="cancel" data-id="${esc(s.id)}" ${['CANCELLED','COMPLETED'].includes(s.status) ? 'disabled' : ''}>Cancel</button>
        </div>
      </div></article>`).join('') : '<div class="card"><div class="card__body">No recurring maintenance schedules yet.</div></div>';
      list.querySelectorAll('[data-action]').forEach((button) => button.onclick = async () => {
        button.disabled = true;
        try { await api.post(`/recurring-maintenance/${button.dataset.id}/${button.dataset.action}`, {}); await load(); }
        catch (error) { button.disabled = false; toastError(error.message); }
      });
    } catch (error) { list.innerHTML = `<div class="card"><div class="card__body">${esc(error.message)}</div></div>`; }
  }

  el('#recurringMaintenanceForm').onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api.post('/recurring-maintenance', {
        customerId: form.get('customerId'), equipmentId: form.get('equipmentId') || null,
        serviceId: form.get('serviceId') || null, technicianId: form.get('technicianId') || null,
        startDate: new Date(form.get('startDate')).toISOString(), intervalMonths: Number(form.get('intervalMonths')),
        reminderOffsets: String(form.get('reminderOffsets')).split(',').map((value) => Number(value.trim())).filter(Number.isFinite),
      });
      message.textContent = 'Maintenance schedule created.'; event.currentTarget.reset(); await load();
    } catch (error) { message.textContent = error.message; }
  };
  await load();
}
