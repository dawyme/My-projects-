/** Supplier Marketplace → Sync & Automation. */
import { api, auth } from '../api.js';
import { setTitle } from '../layout.js';
import {
  qs, qsa, icon, esc, num, statusBadge, emptyState, modal, confirmDialog,
  toast, toastError, dateTime, relative, titleCase,
} from '../ui.js';
import { sectionHead, kvList } from './supplier-nav.js';

let suppliers = [];
let pollTimer = null;

export async function render(view) {
  setTitle('Sync & Automation');

  view.innerHTML = `
    ${sectionHead({
      title: 'Sync & Automation',
      subtitle: 'Manual and scheduled synchronisation. Runs are queued in the background — large catalogues never block the dashboard.',
      active: '/supplier-sync',
      actions: `<button class="btn btn--ghost" id="refreshBtn">${icon('refresh')} Refresh</button>
                <button class="btn btn--primary" id="syncAllBtn">${icon('pulse')} Sync all suppliers</button>`,
    })}
    <div class="grid grid--2">
      <section class="card">
        <div class="card__head"><h2>Automation</h2></div>
        <div class="card__body" id="automation"><div class="spinner"></div></div>
      </section>
      <section class="card">
        <div class="card__head"><h2>Running now</h2></div>
        <div class="card__body" id="running"><div class="spinner"></div></div>
      </section>
    </div>
    <section class="card">
      <div class="card__head"><h2>Per-supplier schedule</h2></div>
      <div class="card__body card__body--flush"><div class="table-wrap"><table class="data">
        <caption class="sr-only">Supplier sync schedules</caption>
        <thead><tr><th scope="col">Supplier</th><th scope="col">Connector</th><th scope="col">Auto sync</th>
          <th scope="col">Interval</th><th scope="col">Types</th><th scope="col">Last sync</th>
          <th scope="col" style="text-align:right">Actions</th></tr></thead>
        <tbody id="rows"></tbody></table></div></div>
    </section>
    <section class="card">
      <div class="card__head"><h2>Recent runs</h2>
        <a class="btn btn--ghost btn--sm" href="#/supplier-logs">All sync logs</a></div>
      <div class="card__body card__body--flush"><div class="table-wrap"><table class="data">
        <thead><tr><th>Supplier</th><th>Type</th><th>Trigger</th><th>Status</th>
          <th class="num">Processed</th><th class="num">Created</th><th class="num">Updated</th>
          <th class="num">Stock</th><th class="num">Price</th><th class="num">Errors</th><th>When</th></tr></thead>
        <tbody id="syncRows"></tbody></table></div></div>
    </section>`;

  try {
    const { data } = await api.get('/suppliers', { status: 'ACTIVE', limit: 100 });
    suppliers = data;
  } catch (e) { toastError(e); }

  async function loadAutomation() {
    const host = qs('#automation', view);
    try {
      const { data } = await api.get('/supplier-syncs/automation');
      const sch = data.scheduler;
      host.innerHTML = `
        ${kvList([
          ['Scheduler process', sch.running ? '<span class="badge badge--success">Running</span>' : `<span class="badge badge--muted">Stopped</span> ${esc(sch.reason || sch.disabledByEnv ? '(disabled by env)' : '')}`],
          ['Automatic sync', sch.autoSyncEnabled ? '<span class="badge badge--success">Enabled</span>' : '<span class="badge badge--muted">Disabled</span>'],
          ['Default interval', `${num(sch.syncIntervalMinutes)} minute(s)`],
          ['Concurrency', `${num(sch.syncConcurrency)} simultaneous supplier(s)`],
          ['Sweeps since start', num(sch.sweeps)],
          ['Last sweep', sch.lastRunAt ? relative(sch.lastRunAt) : 'never'],
          ['Last error', sch.lastError ? `<span style="color:var(--danger)">${esc(sch.lastError)}</span>` : '—'],
        ])}
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn--subtle btn--sm" id="toggleAuto">${sch.autoSyncEnabled ? 'Disable automatic sync' : 'Enable automatic sync'}</button>
          <button class="btn btn--subtle btn--sm" id="runNow">${icon('pulse')} Run a sweep now</button>
          <a class="btn btn--subtle btn--sm" href="#/supplier-settings">${icon('settings')} Automation settings</a>
        </div>`;
      qs('#toggleAuto', host).onclick = async () => {
        try {
          const { data: r } = await api.patch('/supplier-syncs/automation', { autoSyncEnabled: !sch.autoSyncEnabled });
          toast(r.settings.autoSyncEnabled ? 'Automatic synchronisation enabled' : 'Automatic synchronisation disabled');
          loadAutomation();
        } catch (e) { toastError(e); }
      };
      qs('#runNow', host).onclick = async () => {
        toast('Running a scheduler sweep…', 'info');
        try { const { data: r } = await api.post('/supplier-syncs/automation/run-now'); toast(`Sweep finished — ${r.lastResult?.started ?? 0} run(s) started`); loadAll(); }
        catch (e) { toastError(e); }
      };
    } catch (e) { host.innerHTML = emptyState('Could not load automation', e.message); }
  }

  async function loadRunning() {
    const host = qs('#running', view);
    try {
      const { data } = await api.get('/supplier-syncs', { status: 'RUNNING,QUEUED', limit: 20 });
      const active = data.filter((s) => ['RUNNING', 'QUEUED'].includes(s.status));
      if (!active.length) {
        host.innerHTML = emptyState('Nothing running', 'Start a sync from the table below or let the scheduler do it.');
        return;
      }
      host.innerHTML = active.map((s) => `<div class="list-card" style="margin-bottom:10px">
        <div class="list-card__head"><span class="cell-main">${esc(s.supplier?.name || '—')}</span>
          ${statusBadge(s.status)}</div>
        <div class="list-card__body">
          <div class="cell-sub">${esc(s.type)} · ${esc(s.trigger.toLowerCase())} · batch ${num(s.batch)}</div>
          <div class="progress" style="margin-top:8px"><div class="progress__bar" style="width:${s.status === 'RUNNING' ? '55' : '10'}%"></div></div>
          <div class="cell-sub" style="margin-top:6px">${esc(s.message || '')} · ${num(s.processed)} processed</div>
        </div></div>`).join('');
    } catch (e) { host.innerHTML = emptyState('Could not load running syncs', e.message); }
  }

  function loadSchedules() {
    const rows = qs('#rows', view);
    if (!suppliers.length) {
      rows.innerHTML = `<tr><td colspan="7">${emptyState('No active suppliers', 'Add a supplier first.')}</td></tr>`;
      return;
    }
    rows.innerHTML = suppliers.map((s) => `<tr data-id="${esc(s.id)}">
      <td><div class="cell-main">${esc(s.name)}</div><div class="cell-sub"><code>${esc(s.code)}</code></div></td>
      <td>${s.integration ? `${esc(s.integration.connectorType)} ${statusBadge(s.integration.status)}` : '<span class="badge badge--muted">No connector</span>'}</td>
      <td>${s.integration?.syncEnabled ? '<span class="badge badge--success">On</span>' : '<span class="badge badge--muted">Off</span>'}</td>
      <td>${s.integration?.syncIntervalMinutes ? `${num(s.integration.syncIntervalMinutes)} min` : '<span class="cell-sub">default</span>'}</td>
      <td>${s.integration ? esc((s.integration.syncTypes || ['FULL']).join(', ')) : '—'}</td>
      <td>${s.integration?.lastSyncAt ? `${relative(s.integration.lastSyncAt)} ${statusBadge(s.integration.lastSyncStatus || 'PENDING')}` : '<span class="cell-sub">never</span>'}</td>
      <td><div class="row-actions">
        <button class="btn btn--ghost btn--icon" data-act="sync" aria-label="Sync now" ${s.integration ? '' : 'disabled'}>${icon('refresh')}</button>
        <button class="btn btn--ghost btn--icon" data-act="schedule" aria-label="Schedule" ${s.integration ? '' : 'disabled'}>${icon('clock')}</button>
      </div></td></tr>`).join('');
  }

  async function loadRecent() {
    const rows = qs('#syncRows', view);
    try {
      const { data } = await api.get('/supplier-syncs', { limit: 10 });
      if (!data.length) { rows.innerHTML = '<tr><td colspan="11">No synchronisations yet</td></tr>'; return; }
      rows.innerHTML = data.map((s) => `<tr>
        <td>${esc(s.supplier?.name || '—')}</td>
        <td>${esc(s.type)}</td><td>${esc(s.trigger.toLowerCase())}</td><td>${statusBadge(s.status)}</td>
        <td class="num">${num(s.processed)}</td><td class="num">${num(s.created)}</td>
        <td class="num">${num(s.updated)}</td><td class="num">${num(s.inventoryUpdates)}</td>
        <td class="num">${num(s.priceUpdates)}</td>
        <td class="num">${s.errorCount ? `<span class="badge badge--danger">${num(s.errorCount)}</span>` : '0'}</td>
        <td>${relative(s.startedAt)}</td></tr>`).join('');
    } catch (e) { rows.innerHTML = `<tr><td colspan="11">${esc(e.message)}</td></tr>`; }
  }

  function loadAll() { loadAutomation(); loadRunning(); loadSchedules(); loadRecent(); }

  qs('#refreshBtn', view).onclick = loadAll;
  qs('#syncAllBtn', view).onclick = async () => {
    const ok = await confirmDialog({
      title: 'Synchronise every supplier?',
      message: 'A full sync is queued for each active supplier with a connector. The queue respects the concurrency limit.',
      confirmLabel: 'Sync all', danger: false,
    });
    if (!ok) return;
    try {
      const { data } = await api.post('/supplier-syncs/sync-all', { type: 'FULL' });
      toast(`Queued ${data.queued.length} sync(s)${data.skipped.length ? `, ${data.skipped.length} skipped` : ''}`, data.skipped.length ? 'warning' : 'success');
      loadAll();
    } catch (e) { toastError(e); }
  };

  qs('#rows', view).addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const id = btn.closest('tr').dataset.id;
    const supplier = suppliers.find((s) => s.id === id);
    if (btn.dataset.act === 'sync') return syncDialog(supplier, loadAll);
    if (btn.dataset.act === 'schedule') return scheduleDialog(supplier, loadAll);
  });

  loadAll();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (!document.body.contains(view)) { clearInterval(pollTimer); pollTimer = null; return; }
    loadRunning(); loadRecent();
  }, 8000);
}

function syncDialog(supplier, after) {
  modal({
    title: `Synchronise ${supplier.name}`,
    body: `<form id="syncForm">
      <div class="field"><label for="sy-type">Sync type</label>
        <select id="sy-type">
          <option value="FULL">Full — catalogue, inventory and pricing</option>
          <option value="CATALOG">Catalogue only — products and content</option>
          <option value="INVENTORY">Inventory only — stock levels</option>
          <option value="PRICING">Pricing only — cost and selling price</option>
        </select></div>
      <div class="alert alert--info">The run happens in the background. Progress appears under “Running now” and in Sync Logs.</div>
    </form>`,
    footer: `<button class="btn btn--ghost" data-close>Cancel</button>
             <button class="btn btn--primary" id="sy-run">Start sync</button>`,
    onMount: ({ root, close }) => {
      qs('#sy-run', root).onclick = async () => {
        try {
          const { data } = await api.post('/supplier-syncs', { supplierId: supplier.id, type: qs('#sy-type', root).value });
          toast(data.message);
          close(); after?.();
        } catch (e) { toastError(e); }
      };
    },
  });
}

function scheduleDialog(supplier, after) {
  const integration = supplier.integration || {};
  modal({
    title: `Schedule — ${supplier.name}`,
    body: `<form id="schForm">
      <div class="grid grid--form">
        <div class="field span-2"><label class="checkline">
          <input type="checkbox" name="syncEnabled" ${integration.syncEnabled ? 'checked' : ''}> Automatic synchronisation for this supplier</label></div>
        <div class="field"><label for="sch-interval">Interval (minutes)</label>
          <input id="sch-interval" type="number" min="5" max="10080" value="${integration.syncIntervalMinutes || 60}"></div>
        <div class="field span-2"><label>Sync types</label>
          <div style="display:flex;flex-wrap:wrap;gap:10px">
            ${['FULL', 'CATALOG', 'INVENTORY', 'PRICING'].map((t) => `<label class="checkline">
              <input type="checkbox" name="syncType" value="${t}" ${(integration.syncTypes || ['FULL']).includes(t) ? 'checked' : ''}> ${esc(titleCase(t))}</label>`).join('')}
          </div></div>
      </div></form>`,
    footer: `<button class="btn btn--ghost" data-close>Cancel</button>
             <button class="btn btn--primary" id="sch-save">Save schedule</button>`,
    onMount: ({ root, close }) => {
      qs('#sch-save', root).onclick = async () => {
        const types = qsa('input[name="syncType"]:checked', root).map((n) => n.value);
        if (!types.length) return toast('Choose at least one sync type', 'warning');
        try {
          await api.patch(`/supplier-integrations/${integration.id}/schedule`, {
            syncEnabled: qs('input[name="syncEnabled"]', root).checked,
            syncIntervalMinutes: Number(qs('#sch-interval', root).value),
            syncTypes: types,
          });
          toast('Schedule saved'); close(); after?.();
        } catch (e) { toastError(e); }
      };
    },
  });
}
