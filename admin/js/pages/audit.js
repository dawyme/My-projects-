import { api, auth } from '../api.js';
import { setTitle } from '../layout.js';
import { qs, icon, esc, dateTime, debounce, emptyState, pagination, skeletonRows, toast, toastError } from '../ui.js';

const state = { page: 1, limit: 25, search: '', entity: '', action: '' };
const ENTITIES = ['Product', 'Booking', 'Customer', 'ContactMessage', 'Order', 'User', 'Category', 'Service', 'Setting'];
const ACTIONS = ['LOGIN', 'LOGIN_FAILED', 'LOGOUT_ALL', 'CREATE', 'UPDATE', 'DELETE', 'BULK_DELETE', 'BULK_UPDATE',
  'STATUS_CHANGE', 'ASSIGN', 'RESTOCK', 'ADJUST_STOCK', 'REPLY', 'UPDATE_SETTINGS', 'PASSWORD_CHANGE'];

export async function render(view) {
  setTitle('Audit Log');
  if (!auth.isAdmin) {
    view.innerHTML = `<div class="card"><div class="card__body">${emptyState('Administrators only', 'Audit logs are restricted to administrator accounts.')}</div></div>`;
    return;
  }

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Audit Log</h1><p>Every security-relevant action taken in the dashboard, with actor, IP and payload.</p></div>
      <div class="page-head__actions"><button class="btn btn--ghost" id="exportBtn">${icon('download')} Export CSV</button></div>
    </div>
    <section class="card">
      <div class="toolbar">
        <label class="sr-only" for="searchInput">Search audit log</label>
        <input id="searchInput" class="toolbar__search" type="search" placeholder="Search action, entity or payload…">
        <label class="sr-only" for="entityFilter">Filter by entity</label>
        <select id="entityFilter"><option value="">All entities</option>${ENTITIES.map((e) => `<option value="${e}">${e}</option>`).join('')}</select>
        <label class="sr-only" for="actionFilter">Filter by action</label>
        <select id="actionFilter"><option value="">All actions</option>${ACTIONS.map((a) => `<option value="${a}">${a}</option>`).join('')}</select>
      </div>
      <div class="table-wrap"><table class="data"><caption class="sr-only">Audit log entries</caption>
        <thead><tr><th scope="col">Time</th><th scope="col">User</th><th scope="col">Action</th>
          <th scope="col">Entity</th><th scope="col">IP address</th><th scope="col">Details</th></tr></thead>
        <tbody id="rows">${skeletonRows(6)}</tbody></table></div>
      <div class="card__foot" id="pager"></div>
    </section>`;

  const rows = qs('#rows', view);

  async function load() {
    rows.innerHTML = skeletonRows(6);
    try {
      const { data, meta } = await api.get('/audit-logs', { ...state });
      if (!data.length) { rows.innerHTML = `<tr><td colspan="6">${emptyState('No audit entries', 'Actions performed in the dashboard will be recorded here.')}</td></tr>`; return; }
      rows.innerHTML = data.map((l) => `<tr>
        <td>${esc(dateTime(l.createdAt))}</td>
        <td>${esc(l.user?.name || 'System')}<div class="cell-sub">${esc(l.user?.email || '—')}</div></td>
        <td><code>${esc(l.action)}</code></td>
        <td>${esc(l.entity)}${l.entityId ? `<div class="cell-sub">${esc(l.entityId.slice(0, 8))}…</div>` : ''}</td>
        <td>${esc(l.ip || '—')}</td>
        <td><span class="cell-sub" style="word-break:break-all">${esc((l.data || '').slice(0, 90))}</span></td></tr>`).join('');
      const pager = qs('#pager', view);
      pager.innerHTML = '';
      pager.appendChild(pagination(meta, (p) => { state.page = p; load(); }));
    } catch (e) { rows.innerHTML = `<tr><td colspan="6">${emptyState('Could not load audit log', e.message)}</td></tr>`; }
  }

  qs('#searchInput', view).addEventListener('input', debounce((e) => { state.search = e.target.value.trim(); state.page = 1; load(); }));
  qs('#entityFilter', view).onchange = (e) => { state.entity = e.target.value; state.page = 1; load(); };
  qs('#actionFilter', view).onchange = (e) => { state.action = e.target.value; state.page = 1; load(); };
  qs('#exportBtn', view).onclick = () => api.download('/audit-logs', { ...state, format: 'csv' }, 'audit-logs.csv')
    .then(() => toast('Audit log exported')).catch(toastError);

  await load();
}
