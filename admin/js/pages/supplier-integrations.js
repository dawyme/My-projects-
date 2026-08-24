/** Supplier Marketplace → Supplier Integrations / Plugins. */
import { api, auth } from '../api.js';
import { setTitle } from '../layout.js';
import {
  el, qs, qsa, icon, esc, num, statusBadge, skeletonRows, emptyState,
  modal, confirmDialog, formData, showFieldErrors, toast, toastError,
  dateTime, relative, titleCase,
} from '../ui.js';
import { sectionHead, credentialRow } from './supplier-nav.js';

let connectors = [];
let capabilityCatalog = [];
let suppliers = [];

export async function render(view) {
  setTitle('Supplier Integrations');

  view.innerHTML = `
    ${sectionHead({
      title: 'Supplier Integrations / Plugins',
      subtitle: 'Connect each supplier through its API, feed or manual channel. Credentials are encrypted and never returned to the browser.',
      active: '/supplier-integrations',
      actions: `<button class="btn btn--primary" id="newBtn">${icon('plug')} Add integration</button>`,
    })}
    <section class="card">
      <div class="card__head"><h2>Configured integrations</h2></div>
      <div class="card__body card__body--flush">
        <div class="table-wrap"><table class="data">
          <caption class="sr-only">Supplier integrations</caption>
          <thead><tr>
            <th scope="col">Supplier</th><th scope="col">Connector</th><th scope="col">Auth</th>
            <th scope="col">Capabilities</th><th scope="col">Status</th>
            <th scope="col">Last test</th><th scope="col">Last sync</th>
            <th scope="col" style="text-align:right">Actions</th>
          </tr></thead>
          <tbody id="rows">${skeletonRows(8)}</tbody></table></table></div>
      </div>
    </section>
    <section class="card">
      <div class="card__head"><h2>Available connectors</h2>
        <span class="cell-sub">Adding a supplier never changes the core commerce system — only a connector is registered.</span></div>
      <div class="card__body" id="catalog"><div class="spinner"></div></div>
    </section>`;

  const rows = qs('#rows', view);

  try {
    const [{ data: connectorList, meta }, { data: supplierPage }] = await Promise.all([
      api.get('/supplier-integrations/connectors'),
      api.get('/suppliers', { status: 'ALL', limit: 100 }),
    ]);
    connectors = connectorList;
    capabilityCatalog = meta.capabilities || [];
    suppliers = supplierPage;
  } catch (e) { toastError(e); }

  async function load() {
    rows.innerHTML = skeletonRows(8);
    try {
      const { data } = await api.get('/supplier-integrations', { limit: 100 });
      if (!data.length) {
        rows.innerHTML = `<tr><td colspan="8">${emptyState('No integrations yet',
          'Connect a supplier to import its catalogue, synchronise stock and dropship orders.')}</td></tr>`;
        return;
      }
      rows.innerHTML = data.map(rowMarkup).join('');
    } catch (e) {
      rows.innerHTML = `<tr><td colspan="8">${emptyState('Could not load integrations', e.message)}</td></tr>`;
    }
  }

  function rowMarkup(i) {
    const caps = i.capabilities || [];
    return `<tr data-id="${esc(i.id)}">
      <td><div class="cell-main">${esc(i.supplier?.name || '—')}</div>
          <div class="cell-sub">${esc(i.name)}</div></td>
      <td><div class="cell-main">${esc(i.connector?.label || i.connectorType)}</div>
          <div class="cell-sub">${esc(i.connector?.transport || '')}</div></td>
      <td>${esc(i.authType)}</td>
      <td>${caps.length
        ? `<span class="cell-sub">${caps.map((c) => esc(c)).join(', ')}</span>`
        : '<span class="badge badge--muted">None detected</span>'}</td>
      <td>${statusBadge(i.status)}${i.lastError ? `<div class="cell-sub" style="color:var(--danger)">${esc(i.lastError.slice(0, 90))}</div>` : ''}</td>
      <td>${i.lastTestedAt ? `${relative(i.lastTestedAt)}` : '<span class="cell-sub">Never</span>'}</td>
      <td>${i.lastSyncAt ? `${relative(i.lastSyncAt)} ${statusBadge(i.lastSyncStatus || 'PENDING')}` : '<span class="cell-sub">Never</span>'}
          ${i.syncEnabled ? '<div class="cell-sub">Auto-sync on</div>' : ''}</td>
      <td><div class="row-actions">
        <button class="btn btn--ghost btn--icon" data-act="test" aria-label="Test connection">${icon('pulse')}</button>
        <button class="btn btn--ghost btn--icon" data-act="edit" aria-label="Configure">${icon('edit')}</button>
        <button class="btn btn--ghost btn--icon" data-act="toggle" aria-label="Enable or disable">${icon(i.status === 'DISABLED' ? 'check' : 'eyeOff')}</button>
        <button class="btn btn--ghost btn--icon" data-act="delete" aria-label="Delete integration" ${auth.isAdmin ? '' : 'disabled'}>${icon('trash')}</button>
      </div></td></tr>`;
  }

  qs('#newBtn', view).onclick = () => integrationWizard({ onSaved: load });

  rows.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    const action = btn.dataset.act;

    if (action === 'test') return runTest(id, load);
    if (action === 'edit') return integrationDetail(id, load);
    if (action === 'toggle') {
      const { data } = await api.get(`/supplier-integrations/${id}`);
      const next = data.status !== 'DISABLED';
      try {
        await api.patch(`/supplier-integrations/${id}/enabled`, { enabled: !next });
        toast(next ? 'Integration disabled' : 'Integration enabled');
        load();
      } catch (err) { toastError(err); }
      return;
    }
    if (action === 'delete') {
      const ok = await confirmDialog({
        title: 'Remove integration?',
        message: 'The connector configuration and its encrypted credentials are destroyed. The supplier and its imported catalogue are kept.',
        confirmLabel: 'Remove',
      });
      if (!ok) return;
      try { const r = await api.del(`/supplier-integrations/${id}`); toast(r.message); load(); }
      catch (err) { toastError(err); }
    }
  });

  renderCatalog();
  await load();

  function renderCatalog() {
    const host = qs('#catalog', view);
    if (!connectors.length) { host.innerHTML = emptyState('No connectors registered', 'The connector registry is empty.'); return; }
    host.innerHTML = connectors.map((c) => `
      <div class="list-card" style="margin-bottom:12px">
        <div class="list-card__head">
          <span class="cell-main">${icon(c.transport === 'FILE' ? 'file' : c.transport === 'MANUAL' ? 'mail' : 'cloud')} ${esc(c.label)}</span>
          <span class="badge badge--${c.installed ? 'success' : 'warning'}">${c.installed ? 'Ready' : 'Runtime required'}</span>
        </div>
        <div class="list-card__body">
          <div class="cell-sub">${esc(c.description)}</div>
          <div style="margin:8px 0"><span class="badge badge--plain badge--info">${esc(c.transport)}</span>
            ${c.formats.map((f) => `<span class="badge badge--plain badge--muted">${esc(f)}</span>`).join('')}
            ${c.authTypes.map((a) => `<span class="badge badge--plain badge--purple">${esc(a)}</span>`).join('')}</div>
          <div class="capability-grid">${c.capabilities.map((cap) => `
            <div class="capability ${cap.supported ? '' : 'capability--off'}">
              <span>${cap.supported ? icon('check') : icon('x')}</span>
              <span><span class="capability__label">${esc(titleCase(cap.id))}</span>
              <span class="capability__desc">${esc(cap.description)}</span></span></div>`).join('')}</div>
          ${c.installed ? '' : '<div class="alert alert--error" style="margin-top:10px">This connector needs an extra runtime package on the server before it can connect.</div>'}
        </div></div>`).join('');
  }
}

/* ------------------------------------------------------------- test action */

async function runTest(id, after) {
  toast('Testing connection…', 'info');
  try {
    const { data } = await api.post(`/supplier-integrations/${id}/test`);
    if (data.connected) toast(data.message || 'Connection successful');
    else if (!data.tested) toast(data.message, 'info');
    else toast(data.message || 'Connection failed', data.status === 'NOT_CONNECTED' ? 'warning' : 'error');
    after?.();
  } catch (e) { toastError(e); after?.(); }
}

/* ------------------------------------------------------------------ detail */

async function integrationDetail(id, onChanged) {
  let data;
  try { ({ data } = await api.get(`/supplier-integrations/${id}`)); }
  catch (e) { return toastError(e); }
  const i = data;

  modal({
    title: i.name,
    size: 'lg',
    body: `
      <div class="grid grid--2">
        <div>
          <h3 style="margin:0 0 8px">Connection</h3>
          ${credentialBlock(i)}
        </div>
        <div>
          <h3 style="margin:0 0 8px">Capabilities</h3>
          <div class="capability-grid" id="caps"></div>
        </div>
      </div>
      <h3 style="margin:18px 0 8px">Synchronisation schedule</h3>
      <form id="scheduleForm">
        <div class="grid grid--form">
          <div class="field"><label class="checkline">
            <input type="checkbox" name="syncEnabled" ${i.syncEnabled ? 'checked' : ''}> Automatic synchronisation enabled</label></div>
          <div class="field"><label for="s-interval">Interval (minutes)</label>
            <input id="s-interval" name="syncIntervalMinutes" type="number" min="5" max="10080" value="${i.syncIntervalMinutes || 60}"></div>
          <div class="field span-2"><label>Sync types</label>
            <div id="syncTypes" style="display:flex;flex-wrap:wrap;gap:10px">${['FULL', 'CATALOG', 'INVENTORY', 'PRICING'].map((t) => `
              <label class="checkline"><input type="checkbox" name="syncType" value="${t}"
                ${(i.syncTypes || ['FULL']).includes(t) ? 'checked' : ''}> ${esc(titleCase(t))}</label>`).join('')}</div></div>
        </div>
      </form>
      <h3 style="margin:18px 0 8px">Recent activity</h3>
      <div class="table-wrap"><table class="data"><thead><tr>
        <th>Type</th><th>Trigger</th><th>Status</th><th class="num">Processed</th><th class="num">Errors</th><th>Started</th></tr></thead>
        <tbody>${(i.syncs || []).length ? i.syncs.map((s) => `<tr>
          <td>${esc(s.type)}</td><td>${esc(s.trigger.toLowerCase())}</td><td>${statusBadge(s.status)}</td>
          <td class="num">${num(s.processed)}</td><td class="num">${num(s.errorCount)}</td><td>${dateTime(s.startedAt)}</td></tr>`).join('')
          : '<tr><td colspan="6">No synchronisations yet</td></tr>'}</tbody></table></div>`,
    footer: `<button class="btn btn--ghost" data-close>Close</button>
      <button class="btn btn--subtle" id="disconnectBtn">Disconnect</button>
      <button class="btn btn--subtle" id="testBtn">${icon('pulse')} Test connection</button>
      <button class="btn btn--subtle" id="configBtn">${icon('settings')} Configure</button>
      <button class="btn btn--primary" id="saveSchedule">Save schedule</button>`,
    onMount: ({ root, close }) => {
      const capsHost = qs('#caps', root);
      const matrix = i.capabilityMatrix || [];
      capsHost.innerHTML = (i.connector?.capabilities || []).map((cap) => {
        const available = matrix.find((m) => m.id === cap.id)?.available ?? cap.supported;
        return `<div class="capability ${available ? '' : 'capability--off'}">
          <span>${available ? icon('check') : icon('x')}</span>
          <span><span class="capability__label">${esc(titleCase(cap.id))}</span>
          <span class="capability__desc">${esc(cap.description)}</span></span></div>`;
      }).join('');

      qs('#testBtn', root).onclick = async () => { await runTest(i.id, onChanged); close(); };
      qs('#disconnectBtn', root).onclick = async () => {
        const ok = await confirmDialog({
          title: 'Disconnect?',
          message: 'The session is dropped and automatic sync stops. Stored credentials are kept so you can reconnect.',
          confirmLabel: 'Disconnect',
        });
        if (!ok) return;
        try { const r = await api.post(`/supplier-integrations/${i.id}/disconnect`); toast(r.message); close(); onChanged?.(); }
        catch (e) { toastError(e); }
      };
      qs('#configBtn', root).onclick = () => { close(); integrationWizard({ integration: i, onSaved: onChanged }); };
      qs('#saveSchedule', root).onclick = async () => {
        const form = qs('#scheduleForm', root);
        const types = qsa('input[name="syncType"]:checked', form).map((n) => n.value);
        if (!types.length) return toast('Choose at least one sync type', 'warning');
        try {
          await api.patch(`/supplier-integrations/${i.id}/schedule`, {
            syncEnabled: qs('input[name="syncEnabled"]', form).checked,
            syncIntervalMinutes: Number(qs('#s-interval', form).value),
            syncTypes: types,
          });
          toast('Schedule saved'); close(); onChanged?.();
        } catch (e) { toastError(e); }
      };
    },
  });
}

function credentialBlock(i) {
  const fields = i.credentialFields || [];
  return `
    <dl class="kv">
      <dt>Supplier</dt><dd>${esc(i.supplier?.name || '—')}</dd>
      <dt>Connector</dt><dd>${esc(i.connector?.label || i.connectorType)}</dd>
      <dt>Base URL</dt><dd>${esc(i.baseUrl || '—')}</dd>
      <dt>Auth</dt><dd>${esc(i.authType)}</dd>
      <dt>Status</dt><dd>${statusBadge(i.status)}</dd>
      <dt>Last test</dt><dd>${i.lastTestedAt ? dateTime(i.lastTestedAt) : 'Never'}</dd>
      <dt>Last connected</dt><dd>${i.lastConnectedAt ? dateTime(i.lastConnectedAt) : 'Never'}</dd>
      <dt>Last error</dt><dd>${i.lastError ? `<span style="color:var(--danger)">${esc(i.lastError)}</span>` : '—'}</dd>
    </dl>
    <h4 style="margin:14px 0 6px">Stored credentials</h4>
    ${fields.length
      ? `<div class="list-editor">${fields.map(credentialRow).join('')}</div>
         <p class="secret-field__hint" style="margin-top:8px">Secrets are encrypted at rest (AES-256-GCM) and are never sent back to the browser. Re-enter a field to rotate it.</p>`
      : `<div class="alert alert--info">${icon('shield')} <strong>Not connected — credentials required.</strong>
         Add the connector's secrets with Configure, then run Test connection.</div>`}
    ${i.dedicatedCredentialKey ? '' : '<p class="secret-field__hint">Using the JWT secret as the encryption key — set SUPPLIER_CREDENTIALS_KEY for a dedicated key.</p>'}`;
}

/* ------------------------------------------------------------------ wizard */

function integrationWizard({ integration = null, onSaved }) {
  const editing = Boolean(integration);
  const i = integration || {};
  const state = {
    connectorType: i.connectorType || connectors[0]?.id || 'REST_JSON',
    authType: i.authType || 'NONE',
    config: (() => { try { return i.config ? JSON.parse(i.config) : {}; } catch { return {}; } })(),
  };

  modal({
    title: editing ? `Configure ${i.name}` : 'Add integration',
    size: 'lg',
    body: `<form id="iForm" novalidate>
      <div class="grid grid--form">
        <div class="field"><label for="i-supplier">Supplier *</label>
          <select id="i-supplier" name="supplierId" ${editing ? 'disabled' : ''}>
            <option value="">Choose a supplier…</option>
            ${suppliers.filter((s) => s.status !== 'ARCHIVED').map((s) => `
              <option value="${esc(s.id)}" ${i.supplierId === s.id ? 'selected' : ''}
                ${s.integration && i.supplierId !== s.id ? 'disabled' : ''}>${esc(s.name)}${s.integration && i.supplierId !== s.id ? ' — already connected' : ''}</option>`).join('')}
          </select></div>
        <div class="field"><label for="i-name">Integration name *</label>
          <input id="i-name" name="name" required maxlength="140" value="${esc(i.name || '')}" placeholder="e.g. CoolTech REST API"></div>
        <div class="field"><label for="i-connector">Connector *</label>
          <select id="i-connector" name="connectorType" ${editing ? '' : ''}>
            ${connectors.map((c) => `<option value="${esc(c.id)}" ${state.connectorType === c.id ? 'selected' : ''}>${esc(c.label)}${c.installed ? '' : ' (runtime required)'}</option>`).join('')}
          </select></div>
        <div class="field"><label for="i-auth">Authentication</label>
          <select id="i-auth" name="authType"></select></div>
        <div class="field span-2"><label for="i-base">Base URL / endpoint</label>
          <input id="i-base" name="baseUrl" type="url" maxlength="400" value="${esc(i.baseUrl || '')}" placeholder="https://api.supplier.com/v2"></div>
      </div>
      <div id="credentialFields" class="grid grid--form" style="margin-top:6px"></div>
      <div id="configFields" style="margin-top:14px"></div>
      <div class="alert alert--info" style="margin-top:12px">
        ${icon('shield')} Secrets are encrypted before they are stored and are never returned to this page.
        Leaving a secret field blank keeps the value already on the server.</div>
    </form>`,
    footer: `<button class="btn btn--ghost" data-close>Cancel</button>
      <button class="btn btn--subtle" id="testBtn" ${editing ? '' : 'disabled'}>${icon('pulse')} Test connection</button>
      <button class="btn btn--primary" id="saveBtn">${editing ? 'Save configuration' : 'Save integration'}</button>`,
    onMount: ({ root, close }) => {
      const form = qs('#iForm', root);
      const authSelect = qs('#i-auth', root);
      const credHost = qs('#credentialFields', root);
      const configHost = qs('#configFields', root);

      function currentConnector() {
        return connectors.find((c) => c.id === qs('#i-connector', root).value) || connectors[0];
      }

      function renderAuth() {
        const c = currentConnector();
        const options = c?.authTypes || ['NONE'];
        const selected = options.includes(state.authType) ? state.authType : options[0];
        state.authType = selected;
        authSelect.innerHTML = options.map((a) => `<option value="${a}" ${a === selected ? 'selected' : ''}>${esc(a)}</option>`).join('');
      }

      function renderCredentials() {
        const c = currentConnector();
        const auth = authSelect.value;
        const existing = new Map((i.credentialFields || []).map((f) => [f.name, f]));
        const fields = (c?.credentialFields || []).filter((f) => !f.authTypes || f.authTypes.includes(auth));
        if (!fields.length) {
          credHost.innerHTML = '<div class="alert alert--info">This connector needs no credentials.</div>';
          return;
        }
        credHost.innerHTML = `<div class="field--group span-2"><span class="field--group__label">Credentials</span>
          <div class="field--group__body">${fields.map((f) => {
            const stored = existing.get(f.name);
            return `<div class="field secret-field">
              <label for="c-${esc(f.name)}">${esc(f.label)}${f.required ? ' *' : ''}</label>
              <input id="c-${esc(f.name)}" data-credential="${esc(f.name)}"
                type="${f.type === 'secret' ? 'password' : 'text'}" autocomplete="off"
                placeholder="${stored ? `stored ${stored.fingerprint || '••••'}` : ''}"
                ${f.type === 'secret' && f.name === 'privateKey' ? '' : ''}>
              ${stored ? `<span class="secret-field__hint">Stored value ${esc(stored.fingerprint || '')} — leave blank to keep it, type a new value to rotate.</span>` : ''}
            </div>`;
          }).join('')}</div></div>`;
      }

      function renderConfig() {
        const c = currentConnector();
        const fields = c?.configFields || [];
        const groups = new Map();
        for (const f of fields) {
          const g = f.group || 'Configuration';
          if (!groups.has(g)) groups.set(g, []);
          groups.get(g).push(f);
        }
        configHost.innerHTML = [...groups.entries()].map(([group, list]) => `
          <div class="field--group" style="margin-bottom:10px">
            <span class="field--group__label">${esc(group)}</span>
            <div class="field--group__body">${list.map((f) => fieldMarkup(f)).join('')}</div>
          </div>`).join('');
      }

      function fieldMarkup(f) {
        const value = f.name === 'baseUrl' ? (i.baseUrl || '') : (state.config[f.name] ?? f.default ?? '');
        const id = `cfg-${f.name}`;
        const label = `<label for="${id}">${esc(f.label)}${f.required ? ' *' : ''}</label>`;
        const hint = f.help ? `<span class="secret-field__hint">${esc(f.help)}</span>` : '';
        if (f.type === 'select') {
          return `<div class="field">${label}<select id="${id}" data-config="${esc(f.name)}">
            ${(f.options || []).map((o) => `<option value="${esc(o)}" ${String(value) === String(o) ? 'selected' : ''}>${esc(o)}</option>`).join('')}
          </select>${hint}</div>`;
        }
        if (f.type === 'boolean') {
          return `<div class="field"><label class="checkline">
            <input type="checkbox" id="${id}" data-config="${esc(f.name)}" ${value ? 'checked' : ''}> ${esc(f.label)}</label>${hint}</div>`;
        }
        if (f.type === 'textarea' || f.type === 'json') {
          const text = typeof value === 'object' ? JSON.stringify(value, null, 2) : (value || '');
          return `<div class="field span-2">${label}<textarea id="${id}" data-config="${esc(f.name)}" rows="4">${esc(text)}</textarea>${hint}</div>`;
        }
        if (f.type === 'map') {
          const mapValue = typeof value === 'object' ? value : {};
          return `<div class="field span-2">${label}
            <div id="map-${esc(f.name)}" class="list-editor">${Object.entries(mapValue).map(([k, v]) => mapRow(k, v)).join('')}</div>
            <button type="button" class="btn btn--subtle btn--sm" data-addmap="${esc(f.name)}" style="margin-top:6px">${icon('plus')} Add mapping</button>${hint}</div>`;
        }
        return `<div class="field">${label}<input id="${id}" data-config="${esc(f.name)}"
          type="${f.type === 'number' ? 'number' : f.type === 'url' ? 'url' : f.type === 'email' ? 'email' : 'text'}"
          value="${esc(value)}">${hint}</div>`;
      }

      const mapRow = (k, v) => `<div class="list-row">
        <input data-mapkey placeholder="platform field" value="${esc(k)}">
        <input data-mapval placeholder="supplier field" value="${esc(v)}">
        <button type="button" class="btn btn--ghost btn--icon" data-rmmap aria-label="Remove">${icon('trash')}</button></div>`;

      function collectConfig() {
        const c = currentConnector();
        const config = {};
        for (const f of (c?.configFields || [])) {
          if (f.name === 'baseUrl') continue;
          if (f.type === 'map') {
            const host = qs(`#map-${f.name}`, root);
            if (!host) continue;
            const map = {};
            qsa('.list-row', host).forEach((row) => {
              const k = qs('[data-mapkey]', row)?.value.trim();
              const v = qs('[data-mapval]', row)?.value.trim();
              if (k && v) map[k] = v;
            });
            config[f.name] = map;
            continue;
          }
          const node = qs(`[data-config="${f.name}"]`, root);
          if (!node) continue;
          if (f.type === 'boolean') config[f.name] = node.checked;
          else if (f.type === 'number') config[f.name] = node.value === '' ? null : Number(node.value);
          else if (f.type === 'json') {
            if (!node.value.trim()) { config[f.name] = null; continue; }
            try { config[f.name] = JSON.parse(node.value); }
            catch { config[f.name] = node.value; }
          } else config[f.name] = node.value === '' ? null : node.value;
        }
        return config;
      }

      function collectCredentials() {
        const out = {};
        qsa('[data-credential]', root).forEach((node) => {
          if (node.value !== '') out[node.dataset.credential] = node.value;
        });
        return out;
      }

      qs('#i-connector', root).onchange = () => { renderAuth(); renderCredentials(); renderConfig(); };
      authSelect.onchange = renderCredentials;
      root.addEventListener('click', (e) => {
        const add = e.target.closest('[data-addmap]');
        if (add) {
          qs(`#map-${add.dataset.addmap}`, root).insertAdjacentHTML('beforeend', mapRow('', ''));
        }
        const rm = e.target.closest('[data-rmmap]');
        if (rm) rm.closest('.list-row').remove();
      });

      renderAuth();
      renderCredentials();
      renderConfig();

      qs('#testBtn', root).onclick = async () => { await runTest(i.id, onSaved); close(); };

      qs('#saveBtn', root).onclick = async () => {
        const payload = formData(form);
        const connector = currentConnector();
        const config = collectConfig();
        const credentials = collectCredentials();
        const body = {
          name: payload.name,
          connectorType: payload.connectorType,
          authType: payload.authType,
          baseUrl: payload.baseUrl || null,
          config,
          credentials: Object.keys(credentials).length ? credentials : undefined,
        };
        try {
          if (editing) {
            await api.put(`/supplier-integrations/${i.id}`, body);
            toast('Integration saved. Run Test connection to verify it.');
          } else {
            if (!payload.supplierId) return toast('Choose a supplier first', 'warning');
            body.supplierId = payload.supplierId;
            const { data } = await api.post('/supplier-integrations', body);
            toast('Integration created. Add credentials and test the connection before enabling sync.');
            close();
            onSaved?.();
            return integrationDetail(data.id, onSaved);
          }
          close();
          onSaved?.();
        } catch (e) { showFieldErrors(form, e); }
      };
    },
  });
}
