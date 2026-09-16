/**
 * Platform → Universal Integrations (SUPER_ADMIN).
 *
 * N&D'S is the platform OWNER-OPERATOR, so this surface is operational for
 * the owner's own integrations — full lifecycle: connect providers, configure,
 * test, enable/disable, disconnect/reconnect, rotate/clear credentials,
 * inspect events, execute supported provider operations and manage webhooks
 * for N&D'S's connections (POST/PUT/DELETE only ever go to
 * /api/integrations/platform/owner/connections… — the owner-scoped alias of
 * the SAME gateway handlers the tenant page uses; one framework, no second
 * architecture). Owner access is never restricted by tenant feature
 * entitlements — that bypass lives in the central server-side boundary.
 *
 * Customer-tenant data stays strictly read-only oversight: the cross-tenant
 * lists come from GET /api/integrations/platform/* and return safe fields
 * only — tenant names, provider info, statuses and timestamps; never
 * credentials, configs or webhook tokens. Each tenant operates its own
 * connections on Settings → Integrations.
 *
 * Credential safety mirrors the tenant page: stored secrets render as name +
 * fingerprint rows, inputs are write-only (blank keeps the stored value), and
 * nothing secret is ever written to localStorage, URLs or logs.
 */
import { api, auth } from '../api.js';
import { setTitle } from '../layout.js';
import {
  qs, qsa, esc, icon, num, statusBadge, skeletonRows, emptyState, modal,
  toast, toastError, dateTime, titleCase, formData, showFieldErrors,
  confirmDialog, pagination,
} from '../ui.js';
import {
  isPlatformAdmin, categoryBadge, providerCard, credentialRow, capabilityGrid,
  configFieldMarkup, credentialFieldMarkup, collectConfig, collectCredentials,
  operationLabel, eventResultBadge, timeCell,
} from './integrations-shared.js';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'providers', label: 'Providers' },
  { id: 'connections', label: 'Connections' },
  { id: 'events', label: 'Events' },
  { id: 'webhooks', label: 'Webhooks' },
];

// Owner operations live on the SUPER_ADMIN alias of the tenant API.
const OWNER_BASE = '/integrations/platform/owner/connections';

// Stable Gateway operation taxonomy (see docs/UNIVERSAL_INTEGRATIONS.md).
const OPERATIONS = [
  'configure', 'connect', 'testConnection', 'createPayment', 'getPaymentStatus',
  'verifyPayment', 'refundPayment', 'voidPayment', 'createPaymentLink',
  'receiveWebhook', 'reconcile', 'importStatement', 'disconnect',
  'connectionCreated', 'connectionUpdated', 'connectionDeleted',
];

// The framework's operation contract (gateway.js EXECUTABLE_OPERATIONS) —
// what the run-operation picker offers, gated per connection by its live
// capability matrix. Provider-agnostic by construction.
const RUNNABLE_OPERATIONS = [
  'testConnection', 'createPayment', 'getPaymentStatus', 'verifyPayment', 'capturePayment',
  'refundPayment', 'voidPayment', 'createPaymentLink',
  'getAccounts', 'getBalance', 'getTransactions', 'initiateTransfer', 'getTransferStatus', 'verifyAccount',
  'createPosTransaction', 'getPosTransaction',
  'syncCustomers', 'syncProducts', 'syncInventory', 'syncInvoices', 'syncPayments', 'pollSync',
  'reconcile', 'importStatement', 'disconnect',
];

const STATUSES = ['NOT_CONNECTED', 'CONFIGURED', 'CONNECTED', 'DISCONNECTED', 'DISABLED', 'ERROR'];
const CATEGORIES = ['BANK', 'PSP', 'POS', 'ACCOUNTING', 'OTHER'];

let providers = [];

export async function render(view, query = {}) {
  setTitle('Universal Integrations');
  if (!isPlatformAdmin(auth.user)) {
    view.innerHTML = '<div class="card"><div class="card__body"><h3>Platform administrators only</h3><p>Universal Integrations oversight is reserved for the platform owner.</p></div></div>';
    return;
  }
  const tab = TABS.some((t) => t.id === query.tab) ? query.tab : 'overview';
  view.innerHTML = `
    <nav class="tabs tabs--scroll" aria-label="Universal Integrations sections">
      ${TABS.map((t) => `<a class="tab ${t.id === tab ? 'is-active' : ''}" href="#/platform-integrations?tab=${t.id}"
        ${t.id === tab ? 'aria-current="page"' : ''}>${esc(t.label)}</a>`).join('')}
    </nav>
    <div class="page-head">
      <div><h1>Universal Integrations</h1>
        <p>Operate N&D'S's own bank / PSP / POS / accounting integrations, and oversee every tenant's connections — tenant rows stay read-only and never expose secrets.</p></div>
    </div>
    <div id="tabBody"><div class="card"><div class="card__body" style="display:grid;place-items:center;min-height:220px"><div class="spinner"></div></div></div></div>`;

  try { ({ data: providers } = await api.get('/integrations/providers')); } catch { providers = []; }

  const body = qs('#tabBody', view);
  try {
    if (tab === 'overview') await renderOverview(body);
    else if (tab === 'providers') await renderProviders(body);
    else if (tab === 'connections') await renderConnections(body, query);
    else if (tab === 'events') await renderEvents(body, query);
    else await renderWebhooks(body, query);
  } catch (e) {
    toastError(e);
    body.innerHTML = `<div class="card"><div class="card__body">${emptyState('Could not load this view', e.message || 'Unexpected error')}</div></div>`;
  }
}

/* --------------------------------------------------------------- overview */

async function renderOverview(body) {
  const [{ data: o }] = await Promise.all([api.get('/integrations/platform/overview')]);
  const byStatus = new Map((o.connections.byStatus || []).map((r) => [r.status, r.count]));
  const failed = byStatus.get('ERROR') || 0;
  const active = byStatus.get('CONNECTED') || 0;

  body.innerHTML = `
    <div class="grid grid--4">
      ${statCard('Total providers', num(o.providers.total))}
      ${statCard('Available providers', num(o.providers.available))}
      ${statCard('Active connections', num(active))}
      ${statCard('Connected tenants', num(o.tenants.connected))}
      ${statCard('Total connections', num(o.connections.total))}
      ${statCard('Integration events', num(o.events.total))}
      ${statCard('Failed events', num(o.events.failed))}
      ${statCard('Failing connections', num(failed))}
    </div>
    <div class="grid grid--2" style="margin-top:16px">
      <section class="card"><div class="card__head"><h2>Connection health</h2>
        <span class="card__actions"><a class="btn btn--subtle btn--sm" href="#/platform-integrations?tab=connections">${icon('plug')} Operate N&D'S integrations</a></span></div>
        <div class="card__body">${healthList(o.connections.byStatus)}</div></section>
      <section class="card"><div class="card__head"><h2>Webhook activity</h2>
        <span class="card__actions"><a class="btn btn--ghost btn--sm" href="#/platform-integrations?tab=webhooks">All webhooks</a></span></div>
        <div class="card__body">${webhookSummary(o)}</div></section>
    </div>
    <section class="card" style="margin-top:16px"><div class="card__head"><h2>Failed integrations</h2></div>
      <div class="card__body">${failedList(o.failedConnections)}</div></section>
    <section class="card" style="margin-top:16px"><div class="card__head"><h2>Recent integration events</h2>
      <span class="card__actions"><a class="btn btn--ghost btn--sm" href="#/platform-integrations?tab=events">All events</a></span></div>
      <div class="card__body card__body--flush"><div class="table-wrap"><table class="data">
        <caption class="sr-only">Recent integration events</caption>
        <thead><tr><th scope="col">Result</th><th scope="col">Operation</th><th scope="col">Tenant</th><th scope="col">Provider</th><th scope="col">Time</th></tr></thead>
        <tbody>${(o.recentEvents || []).map((e) => eventRow(e, true)).join('') || `<tr><td colspan="5">${emptyState('No events yet', 'Integration activity will appear here.')}</td></tr>`}</tbody>
      </table></div></div></section>`;

  body.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-event]');
    if (tr) eventDetail(JSON.parse(decodeURIComponent(tr.dataset.event)));
  });
}

const statCard = (label, value) =>
  `<article class="stat"><div class="stat__label">${esc(label)}</div><div class="stat__value">${esc(value)}</div></article>`;

function healthList(byStatus) {
  const rows = byStatus || [];
  if (!rows.length) return emptyState('No connections yet', 'Owner and tenant connections will be summarised here by status.');
  const total = rows.reduce((n, r) => n + r.count, 0) || 1;
  return rows
    .sort((a, b) => b.count - a.count)
    .map((r) => `<div class="cell-flex" style="justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">
      <span>${statusBadge(r.status)}</span>
      <span class="cell-main">${num(r.count)} <span class="cell-sub">(${Math.round((r.count / total) * 100)}%)</span></span>
    </div>`).join('');
}

function webhookSummary(o) {
  const recent = o.recentWebhooks || [];
  return `<div class="cell-flex" style="justify-content:space-between;margin-bottom:8px">
      <span class="cell-main">${icon('cloud')} ${num(o.events.webhooks)} webhook events received</span></div>
    ${recent.length ? recent.slice(0, 5).map((e) => `
      <div class="cell-flex" style="justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">
        <span><span class="cell-main">${esc(e.businessName)}</span>
          <span class="cell-sub"> · ${esc(e.providerId || '—')}${e.externalReference ? ` · <code>${esc(e.externalReference.slice(0, 32))}</code>` : ''}</span></span>
        <span style="display:flex;gap:6px;align-items:center">${eventResultBadge(e.success)}<span class="cell-sub">${timeCell(e.createdAt)}</span></span>
      </div>`).join('') : '<span class="cell-sub">No webhook activity yet.</span>'}`;
}

function failedList(rows) {
  if (!rows?.length) return `<div class="alert alert--success">${icon('check')} No failing connections — every integration is healthy, idle or disabled.</div>`;
  return `<div class="grid grid--2">${rows.map((c) => `
    <article class="card" style="margin:0"><div class="card__body">
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
        <span class="cell-main">${esc(c.name)}</span>${statusBadge(c.status)}</div>
      <div class="cell-sub">${esc(c.businessName)} · ${esc(c.providerLabel)} (${esc(c.providerId)})</div>
      ${c.lastError ? `<div style="margin-top:6px;color:var(--danger);font-size:13px">${esc(c.lastError.slice(0, 200))}</div>` : ''}
      <div class="cell-sub" style="margin-top:6px">Updated ${timeCell(c.updatedAt)}</div>
    </div></article>`).join('')}</div>`;
}

/* -------------------------------------------------------------- providers */

async function renderProviders(body) {
  const [{ data: o }] = await Promise.all([api.get('/integrations/platform/overview')]);
  const counts = new Map((o.connections.byProvider || []).map((r) => [r.providerId, r]));
  body.innerHTML = `
    <section class="card"><div class="card__head"><h2>Registered providers</h2>
      <span class="cell-sub">${providers.length} provider${providers.length === 1 ? '' : 's'} · catalogue is dynamic — new adapters appear here with no UI changes.</span></div>
      <div class="card__body" id="provHost">
        ${providers.length ? providers.map((p) => providerCard(p, { counts: counts.get(p.id) || { total: 0, connected: 0, error: 0 }, onConnect: true })).join('')
          : emptyState('No providers registered', 'The provider registry is empty.')}
      </div></section>`;

  // The provider catalogue is metadata-driven: "Connect" opens the same
  // dynamic wizard for every provider — no provider-specific forms exist.
  qs('#provHost', body).addEventListener('click', (e) => {
    const btn = e.target.closest('[data-connect-provider]');
    if (btn) ownerConnectionWizard({ providerId: btn.dataset.connectProvider, onSaved: () => renderProviders(body) });
  });
}

/* ------------------------------------------------------------ connections */

async function renderConnections(body, query) {
  const filters = {
    search: query.search || '',
    providerId: query.providerId || '',
    status: query.status || '',
    category: query.category || '',
    page: Number(query.page) || 1,
  };

  body.innerHTML = `
    <section class="card" style="margin-bottom:16px">
      <div class="card__head"><h2>${icon('plug')} N&D'S integrations</h2>
        <span class="card__actions"><button class="btn btn--primary btn--sm" id="ownerConnect">${icon('plus')} Connect provider</button></span></div>
      <div class="card__body"><div class="grid grid--2" id="ownerGrid"><div class="spinner"></div></div></div>
    </section>
    <section class="card"><div class="card__head"><h2>Tenant connections (oversight)</h2>
      <span class="cell-sub">Read-only safe fields — no credentials, configs or webhook tokens.</span></div>
      <div class="card__body">
        <form id="connFilters" class="grid grid--form" style="margin-bottom:14px">
          <div class="field"><label for="f-search">Search</label>
            <input id="f-search" name="search" type="search" value="${esc(filters.search)}" placeholder="Connection, provider or tenant…"></div>
          <div class="field"><label for="f-provider">Provider</label>
            <select id="f-provider" name="providerId"><option value="">All providers</option>
              ${providers.map((p) => `<option value="${esc(p.id)}" ${filters.providerId === p.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select></div>
          <div class="field"><label for="f-status">Status</label>
            <select id="f-status" name="status"><option value="">All statuses</option>
              ${STATUSES.map((s) => `<option ${filters.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
          <div class="field"><label for="f-category">Category</label>
            <select id="f-category" name="category"><option value="">All categories</option>
              ${CATEGORIES.map((c) => `<option ${filters.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
        </form>
        <div class="grid grid--2" id="connGrid"></div>
        <div id="connPager" style="margin-top:12px"></div>
      </div></section>`;

  const ownerGrid = qs('#ownerGrid', body);
  const grid = qs('#connGrid', body);
  const pager = qs('#connPager', body);
  const form = qs('#connFilters', body);
  qs('#ownerConnect', body).onclick = () => ownerConnectionWizard({ onSaved: loadOwner });

  async function loadOwner() {
    ownerGrid.innerHTML = '<div class="card"><div class="card__body">Loading…</div></div>';
    try {
      const { data } = await api.get(OWNER_BASE, { limit: 100 });
      ownerGrid.innerHTML = data.length ? data.map(ownerConnectionCard).join('')
        : emptyState('No N&D\'S integrations yet', 'Connect your bank, payment provider, POS or accounting system to operate it from here.',
            `<button class="btn btn--primary" id="emptyOwnerConnect">${icon('plus')} Connect your first integration</button>`);
      qs('#emptyOwnerConnect', ownerGrid)?.addEventListener('click', () => ownerConnectionWizard({ onSaved: loadOwner }));
    } catch (e) {
      ownerGrid.innerHTML = emptyState('Could not load your integrations', e.message || 'Unexpected error');
    }
  }

  ownerGrid.addEventListener('click', async (e) => {
    const card = e.target.closest('[data-conn]');
    if (!card) return;
    const id = card.dataset.conn;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'test') return runOwnerAction(id, 'test', loadOwner);
    if (act === 'connect') return runOwnerAction(id, 'connect', loadOwner);
    if (act === 'reconnect') return runOwnerAction(id, 'reconnect', loadOwner);
    if (act === 'disconnect') return runOwnerAction(id, 'disconnect', loadOwner);
    if (act === 'manage') return ownerConnectionDetail(id, loadOwner);
    if (act === 'edit') return editOwnerConnection(id, loadOwner);
    if (act === 'toggle') return toggleOwnerEnabled(id, loadOwner);
    if (act === 'delete') return removeOwnerConnection(id, loadOwner);
  });

  async function load() {
    grid.innerHTML = '<div class="card"><div class="card__body">Loading…</div></div>';
    try {
      const params = { page: filters.page, limit: 12 };
      for (const k of ['search', 'providerId', 'status', 'category']) if (filters[k]) params[k] = filters[k];
      const { data, meta } = await api.get('/integrations/platform/connections', params);
      const ownerBusinessId = meta?.ownerBusinessId || null;
      const tenantRows = data.filter((c) => c.businessId !== ownerBusinessId);
      grid.innerHTML = tenantRows.length ? tenantRows.map(platformConnectionCard).join('')
        : `<div class="card"><div class="card__body">${emptyState('No tenant connections found', 'Customer-tenant connections will appear here as read-only oversight.')}</div></div>`;
      pager.innerHTML = '';
      if (meta && meta.pages > 1) pager.appendChild(pagination(meta, (p) => { filters.page = p; syncHash(); load(); }));
    } catch (e) {
      grid.innerHTML = `<div class="card"><div class="card__body">${emptyState('Could not load connections', e.message)}</div></div>`;
    }
  }

  function syncHash() {
    const params = new URLSearchParams({ tab: 'connections' });
    for (const k of ['search', 'providerId', 'status', 'category']) if (filters[k]) params.set(k, filters[k]);
    if (filters.page > 1) params.set('page', filters.page);
    history.replaceState(null, '', `#/platform-integrations?${params.toString()}`);
  }

  let timer;
  form.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      filters.search = qs('#f-search', form).value.trim();
      filters.providerId = qs('#f-provider', form).value;
      filters.status = qs('#f-status', form).value;
      filters.category = qs('#f-category', form).value;
      filters.page = 1;
      syncHash();
      load();
    }, 350);
  });
  form.addEventListener('submit', (e) => e.preventDefault());

  await Promise.all([loadOwner(), load()]);
}

/** N&D'S-operated connection card: full lifecycle affordances. */
function ownerConnectionCard(c) {
  const caps = c.capabilities || [];
  const shown = caps.slice(0, 5);
  return `
  <article class="card" style="margin:0" data-conn="${esc(c.id)}">
    <div class="card__head"><h2 style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.name)}</h2>
      <span class="card__actions">${statusBadge(c.status)}</span></div>
    <div class="card__body">
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
        <span class="cell-main">${icon('plug')} ${esc(c.provider?.label || c.providerId)}</span>
        ${categoryBadge(c.providerCategory)}
        ${c.connectionMethod ? `<span class="badge badge--plain badge--info">${esc(c.connectionMethod)}</span>` : ''}
      </div>
      <div style="margin-bottom:10px">${shown.length
        ? shown.map((cap) => `<span class="badge badge--plain badge--muted">${esc(titleCase(cap))}</span>`).join('')
        : '<span class="cell-sub">No capabilities detected</span>'}${caps.length > shown.length ? `<span class="cell-sub"> +${caps.length - shown.length} more</span>` : ''}</div>
      <dl class="kv">
        <dt>Last test</dt><dd>${timeCell(c.lastTestedAt)}</dd>
        <dt>Last connected</dt><dd>${timeCell(c.lastConnectedAt)}</dd>
        <dt>Last sync</dt><dd>${c.lastSyncAt ? `${timeCell(c.lastSyncAt)}${c.lastSyncStatus ? ` · ${esc(titleCase(c.lastSyncStatus))}` : ''}` : '<span class="cell-sub">Never</span>'}</dd>
        ${c.lastError ? `<dt>Last error</dt><dd><span style="color:var(--danger)">${esc(c.lastError.slice(0, 140))}</span></dd>` : ''}
      </dl>
    </div>
    <div class="card__foot">
      <button class="btn btn--subtle btn--sm" data-act="test">${icon('pulse')} Test</button>
      <button class="btn btn--subtle btn--sm" data-act="manage">${icon('settings')} Manage</button>
      <button class="btn btn--ghost btn--sm" data-act="toggle">${icon(c.status === 'DISABLED' ? 'check' : 'eyeOff')} ${c.status === 'DISABLED' ? 'Enable' : 'Disable'}</button>
      <button class="btn btn--ghost btn--sm" data-act="delete" aria-label="Remove integration">${icon('trash')} Remove</button>
    </div>
  </article>`;
}

async function runOwnerAction(id, action, after) {
  toast(`Running ${action}…`, 'info');
  try {
    const { data } = await api.post(`${OWNER_BASE}/${id}/${action}`);
    // Only a backend-confirmed success is reported as successful.
    if (data && data.ok === false) toast(data.message || `Connection ${action} failed`, 'error');
    else toast(data?.message || `Connection ${action === 'test' ? 'verified' : action}`);
    after?.();
  } catch (e) { toastError(e); after?.(); }
}

async function toggleOwnerEnabled(id, after) {
  try {
    const { data } = await api.get(`${OWNER_BASE}/${id}`);
    await api.post(`${OWNER_BASE}/${id}/${data.status === 'DISABLED' ? 'enable' : 'disable'}`);
    toast(data.status === 'DISABLED' ? 'Integration enabled' : 'Integration disabled');
    after?.();
  } catch (e) { toastError(e); }
}

async function removeOwnerConnection(id, after) {
  const ok = await confirmDialog({
    title: 'Remove integration?',
    message: 'The connection and its encrypted credentials are permanently destroyed. Past activity records are kept.',
    confirmLabel: 'Remove',
  });
  if (!ok) return;
  try {
    const r = await api.del(`${OWNER_BASE}/${id}`);
    toast(r.message || 'Integration removed');
    after?.();
  } catch (e) { toastError(e); }
}

/** One dynamic wizard for EVERY provider — fields come from provider metadata. */
function ownerConnectionWizard({ providerId = null, connection = null, onSaved } = {}) {
  const editing = Boolean(connection);
  const state = {
    providerId: providerId || connection?.providerId || providers[0]?.id || '',
    authType: connection?.authType || '',
    connectionMethod: connection?.connectionMethod || '',
    config: { ...(connection?.config || {}) },
  };
  const c = connection || {};
  const currentProvider = () => providers.find((p) => p.id === state.providerId) || providers[0];

  modal({
    title: editing ? `Reconfigure ${c.name || 'integration'}` : 'Connect integration',
    size: 'lg',
    body: `<form id="poForm" novalidate>
      <div class="grid grid--form">
        <div class="field"><label for="po-provider">Provider *</label>
          <select id="po-provider" name="providerId">
            ${providers.map((p) => `<option value="${esc(p.id)}" ${state.providerId === p.id ? 'selected' : ''}>${esc(p.label)} (${esc(p.category)})</option>`).join('')}
          </select></div>
        <div class="field"><label for="po-name">Connection name *</label>
          <input id="po-name" name="name" required minlength="2" maxlength="120" value="${esc(c.name || '')}" placeholder="e.g. N&D'S main bank account"></div>
        <div class="field"><label for="po-auth">Authentication</label>
          <select id="po-auth" name="authType"></select></div>
        <div class="field" id="poMethodWrap"><label for="po-method">Connection method</label>
          <select id="po-method" name="connectionMethod"></select></div>
      </div>
      <div id="poNote" style="margin-top:6px"></div>
      <div id="poCreds" class="grid grid--form" style="margin-top:6px"></div>
      <div id="poConfig" style="margin-top:14px"></div>
      <div class="alert alert--info" style="margin-top:12px">
        ${icon('shield')} Secrets are encrypted before they are stored and are never returned to this page.
        ${editing ? ' Leaving a secret field blank keeps the value already on the server.' : ''}</div>
    </form>`,
    footer: `<button class="btn btn--ghost" data-close>Cancel</button>
      <button class="btn btn--primary" id="poSave">${editing ? 'Save configuration' : 'Save integration'}</button>`,
    onMount: ({ root, close }) => {
      const form = qs('#poForm', root);
      const providerSelect = qs('#po-provider', root);
      const authSelect = qs('#po-auth', root);
      const methodWrap = qs('#poMethodWrap', root);
      const methodSelect = qs('#po-method', root);
      const noteHost = qs('#poNote', root);
      const credHost = qs('#poCreds', root);
      const configHost = qs('#poConfig', root);

      function renderNote() {
        const p = currentProvider();
        noteHost.innerHTML = `<div class="cell-sub">${esc(p.description || '')}</div>`
          + (editing && p.id !== c.providerId
            ? '<div class="alert alert--error" style="margin-top:8px">Changing the provider resets this connection and destroys its stored secrets.</div>'
            : '');
      }
      function renderAuth() {
        const p = currentProvider();
        const options = p?.authTypes?.length ? p.authTypes : ['NONE'];
        if (!options.includes(state.authType)) state.authType = (p.id === c.providerId && options.includes(c.authType)) ? c.authType : options[0];
        authSelect.innerHTML = options.map((a) => `<option value="${a}" ${a === state.authType ? 'selected' : ''}>${esc(a)}</option>`).join('');
      }
      function renderMethod() {
        const p = currentProvider();
        const methods = (p?.connectionMethods || []).map((m) => (m && m.id) || m);
        if (!methods.length) { methodWrap.style.display = 'none'; methodSelect.innerHTML = ''; return; }
        methodWrap.style.display = '';
        if (!methods.includes(state.connectionMethod)) {
          state.connectionMethod = (p.id === c.providerId && methods.includes(c.connectionMethod)) ? c.connectionMethod : methods[0];
        }
        methodSelect.innerHTML = methods.map((m) => {
          const meta = (p.connectionMethods || []).find((x) => ((x && x.id) || x) === m);
          const desc = meta?.description ? ` — ${meta.description}` : '';
          return `<option value="${esc(m)}" ${m === state.connectionMethod ? 'selected' : ''}>${esc(m)}${esc(desc)}</option>`;
        }).join('');
        methodSelect.disabled = methods.length === 1;
      }
      function renderCredentials() {
        const p = currentProvider();
        const auth = authSelect.value;
        const existing = new Map((c.credentialFields || []).map((f) => [f.name, f]));
        const fields = (p?.credentialFields || []).filter((f) => !f.authTypes || f.authTypes.includes(auth));
        if (!fields.length) {
          credHost.innerHTML = '<div class="alert alert--info span-2">This provider needs no credentials.</div>';
          return;
        }
        credHost.innerHTML = `<div class="field--group span-2"><span class="field--group__label">Credentials</span>
          <div class="field--group__body">${fields.map((f) => {
            const stored = p.id === c.providerId ? existing.get(f.name) : null;
            const clearRow = stored && f.supportsClearing !== false
              ? `<label class="checkline span-2" style="margin-top:-4px"><input type="checkbox" data-cred-clear="${esc(f.name)}"> Remove this stored secret</label>`
              : '';
            return credentialFieldMarkup(f, stored) + clearRow;
          }).join('')}</div></div>`;
      }
      function renderConfig() {
        const p = currentProvider();
        const fields = p?.configFields || [];
        if (!fields.length) { configHost.innerHTML = ''; return; }
        const groups = new Map();
        for (const f of fields) {
          const g = f.group || 'Configuration';
          if (!groups.has(g)) groups.set(g, []);
          groups.get(g).push(f);
        }
        configHost.innerHTML = [...groups.entries()].map(([group, list]) => `
          <div class="field--group" style="margin-bottom:10px">
            <span class="field--group__label">${esc(group)}</span>
            <div class="field--group__body">${list.map((f) => configFieldMarkup(f, state.config[f.name])).join('')}</div>
          </div>`).join('');
      }

      providerSelect.onchange = () => { state.providerId = providerSelect.value; renderNote(); renderAuth(); renderMethod(); renderCredentials(); renderConfig(); };
      authSelect.onchange = () => { state.authType = authSelect.value; renderCredentials(); };
      renderNote(); renderAuth(); renderMethod(); renderCredentials(); renderConfig();

      qs('#poSave', root).onclick = async () => {
        const p = currentProvider();
        const payload = formData(form);
        if (!payload.name || String(payload.name).trim().length < 2) {
          toast('Give the connection a name (2+ characters)', 'warning');
          return;
        }
        const config = collectConfig(p?.configFields || [], root);
        const credentials = collectCredentials(root);
        qsa('[data-cred-clear]:checked', root).forEach((node) => {
          const name = node.dataset.credClear;
          if (!(name in credentials)) credentials[name] = null;
        });
        const body = {
          providerId: p.id,
          name: String(payload.name).trim(),
          authType: authSelect.value,
          connectionMethod: methodSelect.value || null,
          config,
          credentials: Object.keys(credentials).length ? credentials : undefined,
        };
        try {
          if (editing) await api.put(`${OWNER_BASE}/${c.id}`, body);
          else await api.post(OWNER_BASE, body);
          toast(editing ? 'Configuration saved. Run Test connection to verify it.' : 'Integration saved. Test the connection before relying on it.');
          close();
          onSaved?.();
        } catch (e) { showFieldErrors(form, e); }
      };
    },
  });
}

/** Reconfigure an owner connection (credentials/config) through the wizard. */
async function editOwnerConnection(id, after) {
  let detail;
  try { ({ data: detail } = await api.get(`${OWNER_BASE}/${id}`)); }
  catch (e) { return toastError(e); }
  ownerConnectionWizard({ connection: detail, onSaved: after });
}

/** Owner connection manager: lifecycle, credentials, webhook config,
 * provider operations and activity — all metadata-driven. */
async function ownerConnectionDetail(id, onChanged) {
  let detail;
  const c0 = await api.get(`${OWNER_BASE}/${id}`).catch((e) => { toastError(e); return null; });
  if (!c0) return;
  detail = c0.data;
  const c = detail;
  const p = detail.provider || {};
  const matrix = detail.capabilityMatrix || [];
  const supports = (cap) => matrix.some((m) => m.id === cap && m.supported);
  const webhookCapable = supports('receiveWebhook') && c.webhookToken;
  const webhookUrl = webhookCapable
    ? `${location.origin}/api/integrations/webhooks/${c.providerId}/${c.webhookToken}` : null;
  const runnable = RUNNABLE_OPERATIONS.filter((op) => matrix.some((m) => m.id === op && m.supported));

  modal({
    title: c.name,
    size: 'lg',
    body: `
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
        ${statusBadge(c.status)}${categoryBadge(c.providerCategory)}
        <span class="cell-sub">${esc(p.label || c.providerId)} · <code>${esc(c.providerId)}</code>${p.version ? ` · v${esc(p.version)}` : ''} · N&D'S-owned</span>
      </div>
      <div class="grid grid--2">
        <div>
          <h3 style="margin:0 0 8px">Connection</h3>
          <dl class="kv">
            <dt>Provider</dt><dd>${esc(p.label || c.providerId)}</dd>
            <dt>Method</dt><dd>${esc(c.connectionMethod || '—')}</dd>
            <dt>Auth</dt><dd>${esc(c.authType || 'NONE')}</dd>
            <dt>Status</dt><dd>${statusBadge(c.status)}</dd>
            <dt>Last test</dt><dd>${c.lastTestedAt ? dateTime(c.lastTestedAt) : 'Never'}</dd>
            <dt>Last connected</dt><dd>${c.lastConnectedAt ? dateTime(c.lastConnectedAt) : 'Never'}</dd>
            <dt>Last sync</dt><dd>${c.lastSyncAt ? `${dateTime(c.lastSyncAt)}${c.lastSyncStatus ? ` (${esc(titleCase(c.lastSyncStatus))})` : ''}` : 'Never'}</dd>
            <dt>Last error</dt><dd>${c.lastError ? `<span style="color:var(--danger)">${esc(c.lastError)}</span>` : '—'}</dd>
          </dl>
          <h4 style="margin:14px 0 6px">Stored credentials</h4>
          ${(c.credentialFields || []).length
            ? `<div class="list-editor">${c.credentialFields.map(credentialRow).join('')}</div>
               <p class="secret-field__hint" style="margin-top:8px">Secrets are encrypted at rest (AES-256-GCM) and never sent back to the browser. Re-enter a field to rotate it; blank keeps the stored value.</p>`
            : `<div class="alert alert--info">${icon('shield')} No credentials stored${(p.credentialFields || []).length ? ' — add them with Configure, then run Test.' : ' (this provider needs none).'}</div>`}
          ${webhookUrl ? `<h4 style="margin:14px 0 6px">Webhook URL</h4>
            <div class="cell-flex" style="gap:8px"><input id="poWhUrl" readonly value="${esc(webhookUrl)}" style="flex:1;min-width:0" aria-label="Webhook URL">
            <button class="btn btn--subtle btn--sm" id="poWhCopy">${icon('share')} Copy</button></div>
            <p class="secret-field__hint" style="margin-top:6px">Give this URL to ${esc(p.label || 'the provider')} so it can notify N&D'S. It contains a per-connection secret token — treat it like a password.</p>` : ''}
        </div>
        <div>
          <h3 style="margin:0 0 8px">Capabilities</h3>
          ${capabilityGrid(matrix)}
          ${runnable.length ? `
            <h4 style="margin:14px 0 6px">Run provider operation</h4>
            <div class="grid grid--form">
              <div class="field"><label for="poOp">Operation</label>
                <select id="poOp">${runnable.map((op) => `<option value="${esc(op)}">${esc(operationLabel(op))}</option>`).join('')}</select></div>
              <div class="field"><label for="poOpKey">Idempotency key (optional)</label>
                <input id="poOpKey" maxlength="200" placeholder="reuse to safely retry writes"></div>
              <div class="field span-2"><label for="poOpPayload">Payload (JSON)</label>
                <textarea id="poOpPayload" rows="4" placeholder='{"amount":25,"currency":"TTD","reference":"INV-1"}'></textarea></div>
            </div>
            <button class="btn btn--primary btn--sm" id="poOpRun" style="margin-top:6px">${icon('play')} Execute</button>
            <pre id="poOpResult" hidden style="white-space:pre-wrap;font-size:12px;background:var(--surface-2);padding:10px;border-radius:8px;margin-top:8px"></pre>` : ''}
        </div>
      </div>
      <h4 style="margin:14px 0 6px">Recent activity</h4>
      <div class="table-wrap"><table class="data">
        <thead><tr><th scope="col">Result</th><th scope="col">Operation</th><th scope="col">Reference</th><th scope="col">Time</th></tr></thead>
        <tbody>${(detail.recentEvents || []).length ? detail.recentEvents.map((e) => `<tr>
          <td>${eventResultBadge(e.success)}${!e.success && e.errorCategory ? `<div class="cell-sub">${esc(e.errorCategory)}</div>` : ''}</td>
          <td>${esc(operationLabel(e.operation))}</td>
          <td>${e.externalReference ? `<code>${esc(e.externalReference.slice(0, 32))}</code>` : '—'}</td>
          <td>${timeCell(e.createdAt)}</td></tr>`).join('')
          : '<tr><td colspan="4"><span class="cell-sub">No activity recorded yet.</span></td></tr>'}</tbody>
      </table></div>`,
    footer: `
      <button class="btn btn--subtle" data-po="test">${icon('pulse')} Test</button>
      <button class="btn btn--subtle" data-po="connect">${icon('plug')} Connect</button>
      <button class="btn btn--subtle" data-po="reconnect">${icon('refresh')} Reconnect</button>
      <button class="btn btn--subtle" data-po="disconnect">${icon('logout')} Disconnect</button>
      <button class="btn btn--subtle" data-po="configure">${icon('settings')} Configure</button>
      <button class="btn ${c.status === 'DISABLED' ? 'btn--primary' : 'btn--subtle'}" data-po="toggle">${icon(c.status === 'DISABLED' ? 'check' : 'eyeOff')} ${c.status === 'DISABLED' ? 'Enable' : 'Disable'}</button>
      <button class="btn btn--ghost" data-po="close">${icon('x')} Close</button>`,
    onMount: ({ root, close }) => {
      qs('#poWhCopy', root)?.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(qs('#poWhUrl', root).value); toast('Webhook URL copied'); }
        catch { toast('Copy not available — select the URL manually', 'warning'); }
      });
      qs('#poOpRun', root)?.addEventListener('click', async () => {
        const runBtn = qs('#poOpRun', root);
        const out = qs('#poOpResult', root);
        const payloadText = qs('#poOpPayload', root).value.trim();
        let payload = {};
        if (payloadText) {
          try { payload = JSON.parse(payloadText); }
          catch { return toast('Payload must be valid JSON', 'error'); }
        }
        runBtn.disabled = true;
        try {
          const op = qs('#poOp', root).value;
          const key = qs('#poOpKey', root).value.trim();
          const r = await api.post(`${OWNER_BASE}/${c.id}/operations/${op}`, { payload, ...(key ? { idempotencyKey: key } : {}) });
          out.hidden = false;
          out.textContent = JSON.stringify(r.data ?? r, null, 2).slice(0, 4000);
          toast(`Operation ${op} completed`);
        } catch (e) {
          out.hidden = false;
          out.textContent = e.message || 'The operation failed.';
          toastError(e);
        } finally { runBtn.disabled = false; }
      });
      root.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-po]');
        if (!btn) return;
        const act = btn.dataset.po;
        if (act === 'close') return close();
        if (act === 'configure') { close(); return ownerConnectionWizard({ connection: c, onSaved: onChanged }); }
        if (act === 'toggle') {
          try {
            await api.post(`${OWNER_BASE}/${c.id}/${c.status === 'DISABLED' ? 'enable' : 'disable'}`);
            toast(c.status === 'DISABLED' ? 'Integration enabled' : 'Integration disabled');
            close(); onChanged?.();
          } catch (err) { toastError(err); }
          return;
        }
        await runOwnerAction(c.id, act, () => { close(); onChanged?.(); });
      });
    },
  });
}

/* ------------------------------------------- tenant oversight (read-only) */

function platformConnectionCard(c) {
  const caps = c.capabilities || [];
  return `
  <article class="card" style="margin:0">
    <div class="card__head"><h2 style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.name)}</h2>
      <span class="card__actions">${statusBadge(c.status)}</span></div>
    <div class="card__body">
      <div class="cell-main" style="margin-bottom:4px">${icon('briefcase')} ${esc(c.businessName)}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
        <span class="cell-sub">${esc(c.providerLabel)} · <code>${esc(c.providerId)}</code></span>
        ${categoryBadge(c.providerCategory)}
        ${c.connectionMethod ? `<span class="badge badge--plain badge--info">${esc(c.connectionMethod)}</span>` : ''}
      </div>
      <div style="margin-bottom:10px">${caps.length
        ? caps.slice(0, 6).map((cap) => `<span class="badge badge--plain badge--muted">${esc(titleCase(cap))}</span>`).join('')
        : '<span class="cell-sub">No capabilities detected</span>'}${caps.length > 6 ? `<span class="cell-sub"> +${caps.length - 6} more</span>` : ''}</div>
      <dl class="kv">
        <dt>Last test</dt><dd>${timeCell(c.lastTestedAt)}</dd>
        <dt>Last connected</dt><dd>${timeCell(c.lastConnectedAt)}</dd>
        <dt>Last sync</dt><dd>${c.lastSyncAt ? `${timeCell(c.lastSyncAt)}${c.lastSyncStatus ? ` · ${esc(titleCase(c.lastSyncStatus))}` : ''}` : '<span class="cell-sub">Never</span>'}</dd>
        ${c.lastError ? `<dt>Last error</dt><dd><span style="color:var(--danger)">${esc(c.lastError.slice(0, 140))}</span></dd>` : ''}
      </dl>
    </div>
  </article>`;
}

/* ----------------------------------------------------------------- events */

async function renderEvents(body, query) {
  const filters = {
    search: query.search || '',
    providerId: query.providerId || '',
    operation: query.operation || '',
    success: query.success || '',
    page: Number(query.page) || 1,
  };

  body.innerHTML = `
    <section class="card"><div class="card__head"><h2>Integration activity</h2>
      <span class="cell-sub">Secret-scrubbed at write time — safe to review. Select a row for detail.</span></div>
      <div class="card__body">
        <form id="evFilters" class="grid grid--form" style="margin-bottom:14px">
          <div class="field"><label for="f-search">Search</label>
            <input id="f-search" name="search" type="search" value="${esc(filters.search)}" placeholder="Reference, provider or operation…"></div>
          <div class="field"><label for="f-provider">Provider</label>
            <select id="f-provider" name="providerId"><option value="">All providers</option>
              ${providers.map((p) => `<option value="${esc(p.id)}" ${filters.providerId === p.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select></div>
          <div class="field"><label for="f-operation">Operation</label>
            <select id="f-operation" name="operation"><option value="">All operations</option>
              ${OPERATIONS.map((o) => `<option value="${o}" ${filters.operation === o ? 'selected' : ''}>${esc(operationLabel(o))}</option>`).join('')}</select></div>
          <div class="field"><label for="f-success">Result</label>
            <select id="f-success" name="success"><option value="">All results</option>
              <option value="true" ${filters.success === 'true' ? 'selected' : ''}>Success</option>
              <option value="false" ${filters.success === 'false' ? 'selected' : ''}>Failed</option></select></div>
        </form>
        <div class="table-wrap"><table class="data">
          <caption class="sr-only">Integration activity</caption>
          <thead><tr><th scope="col">Result</th><th scope="col">Operation</th><th scope="col">Tenant</th><th scope="col">Provider</th><th scope="col">Time</th></tr></thead>
          <tbody id="evRows">${skeletonRows(5)}</tbody></table></div>
        <div id="evPager" style="margin-top:12px"></div>
      </div></section>`;

  const rows = qs('#evRows', body);
  const pager = qs('#evPager', body);
  const form = qs('#evFilters', body);
  let cache = [];

  async function load() {
    rows.innerHTML = skeletonRows(5);
    try {
      const params = { page: filters.page, limit: 20 };
      for (const k of ['search', 'providerId', 'operation', 'success']) if (filters[k]) params[k] = filters[k];
      const { data, meta } = await api.get('/integrations/platform/events', params);
      cache = data;
      rows.innerHTML = data.length ? data.map((e, i) => eventRow(e, true, i)).join('')
        : `<tr><td colspan="5">${emptyState('No events found', 'Try widening the filters.')}</td></tr>`;
      pager.innerHTML = '';
      if (meta && meta.pages > 1) pager.appendChild(pagination(meta, (p) => { filters.page = p; syncHash(); load(); }));
    } catch (e) {
      rows.innerHTML = `<tr><td colspan="5">${emptyState('Could not load events', e.message)}</tr></tr>`;
    }
  }

  function syncHash() {
    const params = new URLSearchParams({ tab: 'events' });
    for (const k of ['search', 'providerId', 'operation', 'success']) if (filters[k]) params.set(k, filters[k]);
    if (filters.page > 1) params.set('page', filters.page);
    history.replaceState(null, '', `#/platform-integrations?${params.toString()}`);
  }

  let timer;
  form.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      filters.search = qs('#f-search', form).value.trim();
      filters.providerId = qs('#f-provider', form).value;
      filters.operation = qs('#f-operation', form).value;
      filters.success = qs('#f-success', form).value;
      filters.page = 1;
      syncHash();
      load();
    }, 350);
  });
  form.addEventListener('submit', (e) => e.preventDefault());

  rows.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-idx]');
    if (tr && cache[Number(tr.dataset.idx)]) eventDetail(cache[Number(tr.dataset.idx)]);
  });

  await load();
}

function eventRow(e, showTenant, idx = null) {
  return `<tr ${idx === null ? '' : `data-idx="${idx}" style="cursor:pointer"`} ${idx === null ? `data-event="${encodeURIComponent(JSON.stringify(e))}" style="cursor:pointer"` : ''}>
    <td>${eventResultBadge(e.success)}${!e.success && e.errorCategory ? `<div class="cell-sub">${esc(e.errorCategory)}${e.retryable ? ' · retryable' : ''}</div>` : ''}</td>
    <td><div class="cell-main">${esc(operationLabel(e.operation))}</div>
      ${e.externalReference ? `<div class="cell-sub"><code>${esc(e.externalReference.slice(0, 32))}</code></div>` : ''}</td>
    ${showTenant ? `<td><div class="cell-main">${esc(e.businessName || e.businessId)}</div>
      ${e.connectionName ? `<div class="cell-sub">${esc(e.connectionName)}</div>` : ''}</td>` : ''}
    <td><span class="cell-sub">${esc(e.providerId || '—')}</span></td>
    <td>${timeCell(e.createdAt)}</td></tr>`;
}

function eventDetail(e) {
  modal({
    title: operationLabel(e.operation),
    body: `
      <div style="margin-bottom:10px">${eventResultBadge(e.success)}</div>
      <dl class="kv">
        <dt>Tenant</dt><dd>${esc(e.businessName || e.businessId || '—')}</dd>
        <dt>Connection</dt><dd>${esc(e.connectionName || '—')}</dd>
        <dt>Provider</dt><dd>${esc(e.providerId || '—')}</dd>
        <dt>Operation</dt><dd><code>${esc(e.operation)}</code></dd>
        <dt>Reference</dt><dd>${e.externalReference ? `<code>${esc(e.externalReference)}</code>` : '—'}</dd>
        <dt>Error category</dt><dd>${esc(e.errorCategory || '—')}</dd>
        <dt>Retryable</dt><dd>${e.retryable ? 'Yes' : 'No'}</dd>
        <dt>Time</dt><dd>${e.createdAt ? dateTime(e.createdAt) : '—'}</dd>
      </dl>
      ${e.errorMessage ? `<h4 style="margin:12px 0 6px">Error</h4><p style="color:var(--danger)">${esc(e.errorMessage)}</p>` : ''}
      ${e.metadata && Object.keys(e.metadata).length ? `<h4 style="margin:12px 0 6px">Details</h4>
        <pre style="white-space:pre-wrap;font-size:12px;background:var(--surface-2);padding:10px;border-radius:8px">${esc(JSON.stringify(e.metadata, null, 2)).slice(0, 2000)}</pre>` : ''}`,
    footer: '<button class="btn btn--ghost" data-close>Close</button>',
  });
}

/* --------------------------------------------------------------- webhooks */

async function renderWebhooks(body, query) {
  const page = Number(query.page) || 1;
  body.innerHTML = `
    <section class="card"><div class="card__head"><h2>Webhook reception</h2>
      <span class="card__actions"><a class="btn btn--subtle btn--sm" href="#/platform-integrations?tab=connections">${icon('settings')} Webhook URLs (Connections)</a></span></div>
      <div class="card__body">
        <div class="alert alert--info">${icon('shield')} Providers deliver events to
          <code>/api/integrations/webhooks/:providerId/:webhookToken</code>, where the token is an
          unguessable per-connection secret. Unknown providers and tokens are rejected, signatures are
          verified by the provider adapter, identical redeliveries are deduplicated, and every verified
          payload is recorded below and handed to the normalised-event pipeline. This is the Gateway's
          only webhook receiver — there is no second system. Webhook signing secrets are configured per
          connection (Manage → Stored credentials).</div>
        <div class="table-wrap" style="margin-top:12px"><table class="data">
          <caption class="sr-only">Webhook activity</caption>
          <thead><tr><th scope="col">Result</th><th scope="col">Tenant</th><th scope="col">Provider</th><th scope="col">Reference</th><th scope="col">Time</th></tr></thead>
          <tbody id="whRows">${skeletonRows(5)}</tbody></table></div>
        <div id="whPager" style="margin-top:12px"></div>
      </div></section>`;

  const rows = qs('#whRows', body);
  const pager = qs('#whPager', body);

  async function load(p) {
    rows.innerHTML = skeletonRows(5);
    try {
      const { data, meta } = await api.get('/integrations/platform/events', { operation: 'receiveWebhook', page: p, limit: 20 });
      rows.innerHTML = data.length ? data.map((e) => `<tr>
        <td>${eventResultBadge(e.success)}${!e.success && e.errorCategory ? `<div class="cell-sub">${esc(e.errorCategory)}</div>` : ''}</td>
        <td><div class="cell-main">${esc(e.businessName || e.businessId)}</div>
          ${e.connectionName ? `<div class="cell-sub">${esc(e.connectionName)}</div>` : ''}</td>
        <td><span class="cell-sub">${esc(e.providerId || '—')}</span></td>
        <td>${e.externalReference ? `<code>${esc(e.externalReference.slice(0, 40))}</code>` : '<span class="cell-sub">—</span>'}</td>
        <td>${timeCell(e.createdAt)}</td></tr>`).join('')
        : `<tr><td colspan="5">${emptyState('No webhook activity yet', 'Verified provider webhooks will appear here.')}</td></tr>`;
      pager.innerHTML = '';
      if (meta && meta.pages > 1) {
        pager.appendChild(pagination(meta, (next) => {
          history.replaceState(null, '', `#/platform-integrations?tab=webhooks${next > 1 ? `&page=${next}` : ''}`);
          load(next);
        }));
      }
    } catch (e) {
      rows.innerHTML = `<tr><td colspan="5">${emptyState('Could not load webhooks', e.message)}</td></tr>`;
    }
  }

  await load(page);
}
