import { api } from '../api.js';
import { setTitle } from '../layout.js';
import { qs, esc, emptyState, skeletonRows, toast, toastError } from '../ui.js';

const STATUSES = ['NEW','SCHEDULED','IN_PROGRESS','COMPLETED','CANCELLED'];
export async function render(view) {
  setTitle('Dispatch Board');
  view.innerHTML = `<div class="page-head"><div><h1>Dispatch Board</h1><p>Assign, schedule and track service jobs from one operations board.</p></div></div><section class="card"><div class="table-wrap"><table class="data"><thead><tr><th>Booking</th><th>Scheduled</th><th>Status</th><th>Priority</th><th>Technician</th><th>Action</th></tr></thead><tbody id="dispatchRows">${skeletonRows(6)}</tbody></table></div></section>`;
  const rows = qs('#dispatchRows', view);
  async function load() {
    try {
      const response = await api.get('/dispatch', { query: { limit: 100 } });
      const data = Array.isArray(response?.data) ? response.data : [];
      rows.innerHTML = data.length ? data.map(job => `<tr><td>${esc(job.booking?.reference || job.bookingId || job.id)}</td><td>${esc(job.booking?.scheduledAt || '—')}</td><td><select class="dispatch-status" data-id="${esc(job.id)}">${STATUSES.map(s => `<option value="${s}" ${job.status === s ? 'selected' : ''}>${s.replaceAll('_',' ')}</option>`).join('')}</select></td><td>${esc(job.priority || 'NORMAL')}</td><td>${esc(job.technician?.name || job.technicianId || 'Unassigned')}</td><td><button class="btn btn--primary btn--sm" data-save="${esc(job.id)}">Save</button></td></tr>`).join('') : `<tr><td colspan="6">${emptyState('No dispatch jobs found. Create a dispatch job from a service booking.')}</td></tr>`;
    } catch (error) { rows.innerHTML = `<tr><td colspan="6">${emptyState(`Could not load dispatch jobs: ${error.message}`)}</td></tr>`; }
  }
  rows.addEventListener('click', async e => { const btn = e.target.closest('[data-save]'); if (!btn) return; const id = btn.dataset.save; const select = rows.querySelector(`.dispatch-status[data-id="${CSS.escape(id)}"]`); btn.disabled = true; try { await api.put(`/dispatch/${id}`, { status: select.value }); toast('Dispatch job updated'); } catch (error) { toastError(error); } finally { btn.disabled = false; } });
  await load();
}
