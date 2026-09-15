/**
 * Platform → Universal Integrations (SUPER_ADMIN only).
 *
 * The platform owner's read-only view of the Integration Gateway: provider
 * catalogue, cross-tenant connection visibility, integration activity and
 * webhook reception. All data comes from the read-only platform endpoints
 * (GET /api/integrations/platform/*), which return safe fields only — tenant
 * names, provider info, statuses and timestamps, never credentials, configs
 * or webhook tokens.
 *
 * This page never manages tenant connections (no test / disconnect / edit):
 * connection lifecycle stays with each tenant's own admin on
 * Settings → Integrations.
 */
import { api, auth } from '../api.js';
import { setTitle } from '../layout.js';
import {
  qs, esc, icon, num, statusBadge, skeletonRows, emptyState, modal,
  toastError, pagination, dateTime, titleCase,
} from '../ui.js';
import {
  isPlatformAdmin, categoryBadge, providerCard,
  operationLabel, eventResultBadge, timeCell,
} from './integrations-shared.js';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'providers', label: 'Providers' },
  { id: 'connections', label: 'Connections' },
  { id: 'events', label: 'Events' },
  { id: 'webhooks', label: 'Webhooks' },
];

// Stable Gateway operation taxonomy (see docs/UNIVERSAL_INTEGRATIONS.md).
const OPERATIONS = [
  'configure', 'connect', 'testConnection', 'createPayment', 'getPaymentStatus',
  'verifyPayment', 'refundPayment', 'voidPayment', 'createPaymentLink',
  'receiveWebhook', 'reconcile', 'importStatement', 'disconnect',
  'connectionCreated', 'connectionUpdated', 'connectionDeleted',
];

const STATUSES = ['NOT_CONNECTED', 'CONFIGURED', 'CONNECTED', 'DISCONNECTED', 'DISABLED', 'ERROR'];
const CATEGORIES = ['BANK', 'PSP', 'POS', 'ACCOUNTING', 'OTHER'];

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
        <p>Provider catalogue, tenant connections, integration activity and webhook reception — safe fields only, never secrets.</p></div>
    </div>
    <div id="tabBody"><div class="card"><div class="card__body" style="display:grid;place-items:center;min-height:220px"><div class="spinner"></div></div></div></div>`;

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
      <section class="card"><div class="card__head"><h2>Connection health</h2></div>
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
        <tbody>${(o.recentEvents || []).map((e) => eventRow(e, true)).join('') || `<tr><td colspan="5">${emptyState('No events yet', 'Tenant integration activity will appear here.')}</td></tr>`}</tbody>
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
  if (!rows.length) return emptyState('No connections yet', 'Tenant connections will be summarised here by status.');
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
  if (!rows?.length) return `<div class="alert alert--success">${icon('check')} No failing connections — every tenant connection is healthy, idle or disabled.</div>`;
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
  const [{ data: providers }, { data: o }] = await Promise.all([
    api.get('/integrations/providers'),
    api.get('/integrations/platform/overview'),
  ]);
  const counts = new Map((o.connections.byProvider || []).map((r) => [r.providerId, r]));
  body.innerHTML = `
    <section class="card"><div class="card__head"><h2>Registered providers</h2>
      <span class="cell-sub">${providers.length} provider${providers.length === 1 ? '' : 's'} · catalogue is dynamic — new adapters appear here with no UI changes.</span></div>
      <div class="card__body">
        ${providers.length ? providers.map((p) => providerCard(p, { counts: counts.get(p.id) || { total: 0, connected: 0, error: 0 } })).join('')
          : emptyState('No providers registered', 'The provider registry is empty.')}
      </div></section>`;
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
  const [{ data: providers }] = await Promise.all([api.get('/integrations/providers')]);

  body.innerHTML = `
    <section class="card"><div class="card__head"><h2>Tenant connections</h2>
      <span class="cell-sub">Safe fields only — no credentials, configs or webhook tokens.</span></div>
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

  const grid = qs('#connGrid', body);
  const pager = qs('#connPager', body);
  const form = qs('#connFilters', body);

  async function load() {
    grid.innerHTML = '<div class="card"><div class="card__body">Loading…</div></div>';
    try {
      const params = { page: filters.page, limit: 12 };
      for (const k of ['search', 'providerId', 'status', 'category']) if (filters[k]) params[k] = filters[k];
      const { data, meta } = await api.get('/integrations/platform/connections', params);
      grid.innerHTML = data.length ? data.map(platformConnectionCard).join('')
        : `<div class="card"><div class="card__body">${emptyState('No connections found', 'Try widening the filters.')}</div></div>`;
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

  await load();
}

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
  const [{ data: providers }] = await Promise.all([api.get('/integrations/providers')]);

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
      rows.innerHTML = `<tr><td colspan="5">${emptyState('Could not load events', e.message)}</td></tr>`;
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
    <section class="card"><div class="card__head"><h2>Webhook reception</h2></div>
      <div class="card__body">
        <div class="alert alert--info">${icon('shield')} Providers deliver events to
          <code>/api/integrations/webhooks/:providerId/:webhookToken</code>, where the token is an
          unguessable per-connection secret. Unknown providers and tokens are rejected, signatures are
          verified by the provider adapter, and every verified payload is recorded below. This is the
          Gateway's only webhook receiver — there is no second system.</div>
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
