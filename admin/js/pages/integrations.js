/**
 * Settings → Integrations (TENANT_ADMIN).
 *
 * The business-facing Universal Integration Gateway page. A tenant admin sees
 * ONLY their own tenant's data: the provider catalogue available to them,
 * their own connections, and their own integration events. Tenant isolation is
 * enforced by the backend (every request is scoped server-side from the
 * session); this page simply consumes the tenant-scoped API and never sends a
 * businessId.
 *
 * The page is provider-agnostic: connection forms, credential inputs and
 * capability displays are all generated from the provider metadata returned by
 * GET /api/integrations/providers, so a future bank / PSP / POS / accounting
 * adapter works here with no UI changes.
 *
 * Credential safety: stored secrets are shown as name + fingerprint rows
 * only. Secret inputs are write-only (blank = keep the server value) and are
 * never written to localStorage, URLs or logs.
 */
import { api, auth } from '../api.js';
import { setTitle } from '../layout.js';
import {
  qs, qsa, icon, esc, skeletonRows, emptyState, modal, confirmDialog,
  formData, showFieldErrors, toast, toastError, dateTime, relative,
  pagination, statusBadge, titleCase,
} from '../ui.js';
import {
  categoryBadge, capabilityGrid, providerCard, credentialRow,
  configFieldMarkup, credentialFieldMarkup, collectConfig, collectCredentials,
  isFeatureDisabledError, featureDisabledNotice, operationLabel,
  eventResultBadge, timeCell,
} from './integrations-shared.js';

let providers = [];

export async function render(view) {
  setTitle('Integrations');
  if (!auth.isAdmin) {
    view.innerHTML = '<div class="card"><div class="card__body"><h3>Administrators only</h3><p>Only business administrators can manage integrations.</p></div></div>';
    return;
  }

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Integrations</h1>
        <p>Connect your bank, payment provider, point-of-sale or accounting system. Credentials are encrypted and never shown back to you.</p></div>
      <div class="page-head__actions"><button class="btn btn--primary" id="connectBtn">${icon('plug')} Connect integration</button></div>
    </div>
    <section class="card" style="margin-bottom:16px">
      <div class="card__head"><h2>Your connections</h2></div>
      <div class="card__body" id="connBody"><div class="grid grid--2" id="connGrid"></div></div>
    </section>
    <section class="card">
      <div class="card__head"><h2>Available integrations</h2>
        <span class="cell-sub">Every registered provider, with the capabilities it supports.</span></div>
      <div class="card__body" id="catalog"><div class="spinner"></div></div>
    </section>`;

  qs('#connectBtn', view).onclick = () => connectionWizard({ onSaved: load });

  // Delegated handlers live on nodes inside the view (discarded on
  // navigation), never on #view itself, so they cannot stack across renders.
  // They are attached before the async loads so early clicks are never lost.
  qs('#catalog', view).addEventListener('click', (e) => {
    const connectBtn = e.target.closest('[data-connect-provider]');
    if (connectBtn) connectionWizard({ providerId: connectBtn.dataset.connectProvider, onSaved: load });
  });
  qs('#connBody', view).addEventListener('click', async (e) => {
    const card = e.target.closest('[data-conn]');
    if (!card) return;
    const id = card.dataset.conn;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'test') return runTest(id, load);
    if (act === 'manage') return connectionDetail(id, load);
    if (act === 'toggle') return toggleEnabled(id, load);
    if (act === 'delete') return removeConnection(id, load);
  });

  try {
    const [provRes] = await Promise.all([api.get('/integrations/providers')]);
    providers = provRes.data || [];
  } catch (e) {
    if (isFeatureDisabledError(e)) {
      qs('#connBody', view).innerHTML = '';
      view.querySelectorAll('section.card')[1]?.remove();
      qs('#connectBtn', view)?.remove();
      view.insertAdjacentHTML('beforeend', featureDisabledNotice());
      return;
    }
    toastError(e);
    qs('#catalog', view).innerHTML = emptyState('Could not load providers', e.message || 'Unexpected error');
  }

  renderCatalog(view);
  await load();

  async function load() {
    // The empty state replaces the grid container, so restore it first.
    if (!qs('#connGrid', view)) {
      qs('#connBody', view).innerHTML = '<div class="grid grid--2" id="connGrid"></div>';
    }
    const grid = qs('#connGrid', view);
    grid.innerHTML = `<div class="card"><div class="card__body">${icon('pulse')} Loading…</div></div>`;
    try {
      const { data } = await api.get('/integrations', { limit: 100 });
      if (!data.length) {
        qs('#connBody', view).innerHTML = emptyState('No integrations yet',
          'Connect your bank or payment provider to get started.',
          `<button class="btn btn--primary" id="emptyConnect">${icon('plus')} Connect your first integration</button>`);
        qs('#emptyConnect', view).onclick = () => connectionWizard({ onSaved: load });
        renderCatalog(view, []);
        return;
      }
      qs('#connBody', view).innerHTML = '<div class="grid grid--2" id="connGrid"></div>';
      qs('#connGrid', view).innerHTML = data.map(connectionCard).join('');
      renderCatalog(view, data);
    } catch (e) {
      if (isFeatureDisabledError(e)) {
        view.innerHTML = `<div class="page-head"><div><h1>Integrations</h1></div></div>${featureDisabledNotice()}`;
        return;
      }
      qs('#connBody', view).innerHTML = emptyState('Could not load connections', e.message || 'Unexpected error');
    }
  }

}

function connectionCard(c) {
  const caps = c.capabilities || [];
  const shown = caps.slice(0, 5);
  return `
  <article class="card" data-conn="${esc(c.id)}">
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
        <dt>Last sync</dt><dd>${c.lastSyncAt ? `${timeCell(c.lastSyncAt)}${c.lastSyncStatus ? ` ${statusBadge(c.lastSyncStatus)}` : ''}` : '<span class="cell-sub">Never</span>'}</dd>
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

function renderCatalog(view, connections = null) {
  const host = qs('#catalog', view);
  if (!host) return;
  if (!providers.length) {
    host.innerHTML = emptyState('No providers registered', 'The provider catalogue is empty.');
    return;
  }
  const byProvider = new Map();
  for (const c of (connections || [])) {
    const entry = byProvider.get(c.providerId) || { count: 0, connected: false };
    entry.count += 1;
    if (c.status === 'CONNECTED') entry.connected = true;
    byProvider.set(c.providerId, entry);
  }
  host.innerHTML = providers.map((p) => providerCard(p, {
    status: connections ? (byProvider.get(p.id) || { count: 0, connected: false }) : null,
    onConnect: true,
  })).join('');
}

/* ------------------------------------------------------------- actions */

async function runTest(id, after) {
  toast('Testing connection…', 'info');
  try {
    const { data } = await api.post(`/integrations/${id}/test`);
    // Only a backend-confirmed success is reported as successful.
    if (data && data.ok === false) toast(data.message || 'Connection test failed', 'error');
    else toast(data?.message || 'Connection successful');
    after?.();
  } catch (e) { toastError(e); after?.(); }
}

async function toggleEnabled(id, after) {
  try {
    const { data } = await api.get(`/integrations/${id}`);
    const enable = data.status === 'DISABLED';
    await api.patch(`/integrations/${id}/enabled`, { enabled: enable });
    toast(enable ? 'Integration enabled' : 'Integration disabled');
    after?.();
  } catch (e) { toastError(e); }
}

async function removeConnection(id, after) {
  const ok = await confirmDialog({
    title: 'Remove integration?',
    message: 'The connection and its encrypted credentials are permanently destroyed. Past activity records are kept.',
    confirmLabel: 'Remove',
  });
  if (!ok) return;
  try {
    const r = await api.del(`/integrations/${id}`);
    toast(r.message || 'Integration removed');
    after?.();
  } catch (e) { toastError(e); }
}

/* ---------------------------------------------------------------- detail */

async function connectionDetail(id, onChanged) {
  let detail;
  try { ({ data: detail } = await api.get(`/integrations/${id}`)); }
  catch (e) { return toastError(e); }
  const c = detail;
  const p = detail.provider || {};
  const supports = (cap) => (detail.capabilityMatrix || []).some((m) => m.id === cap && m.supported);
  const webhookCapable = supports('receiveWebhook') && c.webhookToken;
  const webhookUrl = webhookCapable
    ? `${location.origin}/api/integrations/webhooks/${c.providerId}/${c.webhookToken}` : null;

  modal({
    title: c.name,
    size: 'lg',
    body: `
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
        ${statusBadge(c.status)}${categoryBadge(c.providerCategory)}
        <span class="cell-sub">${esc(p.label || c.providerId)} · <code>${esc(c.providerId)}</code></span>
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
               <p class="secret-field__hint" style="margin-top:8px">Secrets are encrypted at rest (AES-256-GCM) and are never sent back to the browser. Re-enter a field to rotate it.</p>`
            : `<div class="alert alert--info">${icon('shield')} No credentials stored${(p.credentialFields || []).length ? ' — add them with Edit configuration, then run Test connection.' : ' (this provider needs none).'}</div>`}
          ${webhookUrl ? `<h4 style="margin:14px 0 6px">Webhook URL</h4>
            <div class="cell-flex" style="gap:8px"><input id="whUrl" readonly value="${esc(webhookUrl)}" style="flex:1;min-width:0" aria-label="Webhook URL">
            <button class="btn btn--subtle btn--sm" id="copyWh">${icon('share')} Copy</button></div>
            <p class="secret-field__hint" style="margin-top:6px">Give this URL to ${esc(p.label || 'the provider')} so it can notify this business. It contains a per-connection secret token — treat it like a password.</p>` : ''}
        </div>
        <div>
          <h3 style="margin:0 0 8px">Capabilities</h3>
          ${capabilityGrid(detail.capabilityMatrix)}
          <h4 style="margin:14px 0 6px">Configuration</h4>
          ${configSummary(c.config)}
        </div>
      </div>`,
    footer: `<button class="btn btn--ghost" data-close>Close</button>
      <button class="btn btn--subtle" id="eventsBtn">${icon('history')} View events</button>
      ${supports('testConnection') ? `<button class="btn btn--subtle" id="testBtn">${icon('pulse')} Test connection</button>` : ''}
      ${c.status === 'CONNECTED' && supports('disconnect')
        ? '<button class="btn btn--subtle" id="discBtn">Disconnect</button>'
        : (supports('connect') ? '<button class="btn btn--subtle" id="connBtn">Connect</button>' : '')}
      <button class="btn btn--primary" id="editBtn">${icon('edit')} Edit configuration</button>`,
    onMount: ({ root, close }) => {
      const copyBtn = qs('#copyWh', root);
      if (copyBtn) copyBtn.onclick = async () => {
        try { await navigator.clipboard.writeText(qs('#whUrl', root).value); toast('Webhook URL copied'); }
        catch { qs('#whUrl', root).select(); toast('Copy the selected URL', 'info'); }
      };
      qs('#eventsBtn', root).onclick = () => connectionEvents(c.id, c.name);
      const testBtn = qs('#testBtn', root);
      if (testBtn) testBtn.onclick = async () => { close(); await runTest(c.id, onChanged); };
      const discBtn = qs('#discBtn', root);
      if (discBtn) discBtn.onclick = async () => {
        const ok = await confirmDialog({
          title: 'Disconnect?', confirmLabel: 'Disconnect', danger: false,
          message: 'The session is closed. Stored credentials are kept so you can reconnect without re-entering them.',
        });
        if (!ok) return;
        try { const r = await api.post(`/integrations/${c.id}/disconnect`); toast(r.message || 'Disconnected'); }
        catch (e) { toastError(e); }
        close(); onChanged?.();
      };
      const connBtn = qs('#connBtn', root);
      if (connBtn) connBtn.onclick = async () => {
        try { const r = await api.post(`/integrations/${c.id}/connect`); toast(r.data?.message || 'Connected'); }
        catch (e) { toastError(e); }
        close(); onChanged?.();
      };
      qs('#editBtn', root).onclick = () => { close(); connectionWizard({ connection: c, onSaved: onChanged }); };
    },
  });
}

function configSummary(config) {
  const entries = Object.entries(config || {}).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!entries.length) return '<span class="cell-sub">No configuration stored.</span>';
  return `<dl class="kv">${entries.map(([k, v]) =>
    `<dt>${esc(titleCase(k))}</dt><dd>${esc(typeof v === 'object' ? JSON.stringify(v) : String(v)).slice(0, 200)}</dd>`).join('')}</dl>`;
}

/* ---------------------------------------------------------------- events */

function connectionEvents(id, name) {
  modal({
    title: `Activity — ${name}`,
    size: 'lg',
    body: `<div class="table-wrap"><table class="data">
      <caption class="sr-only">Integration activity</caption>
      <thead><tr><th scope="col">Result</th><th scope="col">Operation</th><th scope="col">Reference</th><th scope="col">Time</th></tr></thead>
      <tbody id="evRows">${skeletonRows(4)}</tbody></table></div>
      <div id="evPager" style="margin-top:10px"></div>`,
    footer: '<button class="btn btn--ghost" data-close>Close</button>',
    onMount: ({ root }) => {
      const host = qs('#evRows', root);
      const pager = qs('#evPager', root);
      const loadPage = async (page) => {
        host.innerHTML = skeletonRows(4, 3);
        try {
          const { data, meta } = await api.get(`/integrations/${id}/events`, { page, limit: 15 });
          host.innerHTML = data.length ? data.map(eventRow).join('')
            : `<tr><td colspan="4">${emptyState('No activity yet', 'Operations on this connection will appear here.')}</td></tr>`;
          pager.innerHTML = '';
          if (meta && meta.pages > 1) pager.appendChild(pagination(meta, loadPage));
        } catch (e) {
          host.innerHTML = `<tr><td colspan="4">${emptyState('Could not load activity', e.message)}</td></tr>`;
        }
      };
      loadPage(1);
    },
  });
}

export function eventRow(e) {
  return `<tr>
    <td>${eventResultBadge(e.success)}${!e.success && e.errorCategory ? `<div class="cell-sub">${esc(e.errorCategory)}${e.retryable ? ' · retryable' : ''}</div>` : ''}</td>
    <td><div class="cell-main">${esc(operationLabel(e.operation))}</div>
      ${e.errorMessage ? `<div class="cell-sub" style="color:var(--danger)">${esc(e.errorMessage.slice(0, 120))}</div>` : ''}</td>
    <td>${e.externalReference ? `<code>${esc(e.externalReference.slice(0, 40))}</code>` : '<span class="cell-sub">—</span>'}</td>
    <td>${timeCell(e.createdAt)}</td></tr>`;
}

/* ---------------------------------------------------------------- wizard */

function connectionWizard({ providerId = null, connection = null, onSaved }) {
  const editing = Boolean(connection);
  const c = connection || {};
  const state = {
    providerId: c.providerId || providerId || providers[0]?.id,
    authType: c.authType || null,
    connectionMethod: c.connectionMethod || null,
    config: { ...(c.config || {}) },
  };

  modal({
    title: editing ? `Edit ${c.name}` : 'Connect integration',
    size: 'lg',
    body: `<form id="iForm" novalidate>
      <div class="grid grid--form">
        <div class="field"><label for="i-provider">Provider *</label>
          <select id="i-provider" name="providerId">
            ${providers.map((p) => `<option value="${esc(p.id)}" ${state.providerId === p.id ? 'selected' : ''}>${esc(p.label)} (${esc(p.category)})</option>`).join('')}
          </select></div>
        <div class="field"><label for="i-name">Connection name *</label>
          <input id="i-name" name="name" required minlength="2" maxlength="120" value="${esc(c.name || '')}" placeholder="e.g. Main business account"></div>
        <div class="field"><label for="i-auth">Authentication</label>
          <select id="i-auth" name="authType"></select></div>
        <div class="field" id="methodWrap"><label for="i-method">Connection method</label>
          <select id="i-method" name="connectionMethod"></select></div>
      </div>
      <div id="providerNote" style="margin-top:6px"></div>
      <div id="credentialFields" class="grid grid--form" style="margin-top:6px"></div>
      <div id="configFields" style="margin-top:14px"></div>
      <div class="alert alert--info" style="margin-top:12px">
        ${icon('shield')} Secrets are encrypted before they are stored and are never returned to this page.
        ${editing ? 'Leaving a secret field blank keeps the value already on the server.' : ''}</div>
    </form>`,
    footer: `<button class="btn btn--ghost" data-close>Cancel</button>
      <button class="btn btn--primary" id="saveBtn">${editing ? 'Save configuration' : 'Save integration'}</button>`,
    onMount: ({ root, close }) => {
      const form = qs('#iForm', root);
      const providerSelect = qs('#i-provider', root);
      const authSelect = qs('#i-auth', root);
      const methodWrap = qs('#methodWrap', root);
      const methodSelect = qs('#i-method', root);
      const noteHost = qs('#providerNote', root);
      const credHost = qs('#credentialFields', root);
      const configHost = qs('#configFields', root);

      const currentProvider = () => providers.find((p) => p.id === providerSelect.value) || providers[0];

      function renderNote() {
        const p = currentProvider();
        noteHost.innerHTML = `<div class="cell-sub">${esc(p.description || '')}</div>`;
        if (editing && p.id !== c.providerId) {
          noteHost.insertAdjacentHTML('beforeend',
            '<div class="alert alert--error" style="margin-top:8px">Changing the provider resets this connection and destroys its stored secrets.</div>');
        }
      }

      function renderAuth() {
        const p = currentProvider();
        const options = p?.authTypes?.length ? p.authTypes : ['NONE'];
        if (!options.includes(state.authType)) state.authType = options.includes(c.authType) && p.id === c.providerId ? c.authType : options[0];
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
        // Only the fields this provider + auth combination actually needs.
        const fields = (p?.credentialFields || []).filter((f) => !f.authTypes || f.authTypes.includes(auth));
        if (!fields.length) {
          credHost.innerHTML = '<div class="alert alert--info span-2">This provider needs no credentials.</div>';
          return;
        }
        credHost.innerHTML = `<div class="field--group span-2"><span class="field--group__label">Credentials</span>
          <div class="field--group__body">${fields.map((f) => {
            const stored = p.id === c.providerId ? existing.get(f.name) : null;
            return credentialFieldMarkup(f, stored)
              + (stored ? `<label class="checkline span-2" style="margin-top:-4px"><input type="checkbox" data-credential-clear="${esc(f.name)}"> Remove this stored secret</label>` : '');
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

      providerSelect.onchange = () => { renderNote(); renderAuth(); renderMethod(); renderCredentials(); renderConfig(); };
      authSelect.onchange = () => { state.authType = authSelect.value; renderCredentials(); };
      methodSelect.onchange = () => { state.connectionMethod = methodSelect.value; };

      renderNote(); renderAuth(); renderMethod(); renderCredentials(); renderConfig();

      qs('#saveBtn', root).onclick = async () => {
        const p = currentProvider();
        const payload = formData(form);
        if (!payload.name || String(payload.name).trim().length < 2) {
          toast('Give the connection a name (2+ characters)', 'warning');
          return;
        }
        const config = collectConfig(p?.configFields || [], root);
        const credentials = collectCredentials(root);
        // Explicit "remove stored secret" ticks are sent as null (clear).
        qsa('[data-credential-clear]:checked', root).forEach((node) => {
          const name = node.dataset.credentialClear;
          if (!(name in credentials)) credentials[name] = null;
        });
        // Client-side required check mirrors the provider metadata; the
        // backend re-validates everything, so this is UX only.
        const existing = new Map((c.credentialFields || []).map((f) => [f.name, f]));
        for (const f of (p?.credentialFields || []).filter((x) => !x.authTypes || x.authTypes.includes(authSelect.value))) {
          if (!f.required) continue;
          const stored = p.id === c.providerId && existing.has(f.name) && credentials[f.name] !== null;
          if (!stored && !(f.name in credentials)) {
            toast(`${f.label || f.name} is required`, 'warning');
            return;
          }
        }
        const body = {
          providerId: p.id,
          name: String(payload.name).trim(),
          authType: authSelect.value,
          connectionMethod: methodSelect.value || null,
          config,
          credentials: Object.keys(credentials).length ? credentials : undefined,
        };
        try {
          if (editing) {
            await api.put(`/integrations/${c.id}`, body);
            toast('Configuration saved. Run Test connection to verify it.');
            close();
            onSaved?.();
          } else {
            const { data } = await api.post('/integrations', body);
            toast('Integration saved. Test the connection before relying on it.');
            close();
            onSaved?.();
            connectionDetail(data.id, onSaved);
          }
        } catch (e) { showFieldErrors(form, e); }
      };
    },
  });
}
