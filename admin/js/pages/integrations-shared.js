/**
 * Shared chrome for the Universal Integrations UI (tenant + platform).
 *
 * Both "Settings → Integrations" (TENANT_ADMIN) and "Platform → Universal
 * Integrations" (SUPER_ADMIN) render provider catalogues, capability grids,
 * connection states and secret-scrubbed event logs. This module keeps those
 * renderers in one provider-agnostic place so a future bank / PSP / POS /
 * accounting adapter never requires UI changes — everything is driven by the
 * provider metadata returned from GET /api/integrations/providers.
 *
 * Security: nothing here ever renders secret VALUES. Stored credentials are
 * shown as name + fingerprint rows only; secret inputs are write-only and are
 * never persisted to localStorage, URLs or logs.
 */
import { esc, icon, statusBadge, titleCase, relative, dateTime } from '../ui.js';

export const isPlatformAdmin = (user) =>
  user?.role === 'SUPER_ADMIN' || (user?.role === 'ADMIN' && !user?.businessId);

export const isTenantAdmin = (user) =>
  user?.role === 'TENANT_ADMIN' || (user?.role === 'ADMIN' && !!user?.businessId);

export const CATEGORY_TONE = {
  BANK: 'info', PSP: 'purple', POS: 'success', ACCOUNTING: 'warning', OTHER: 'muted',
};

export const categoryBadge = (category) =>
  `<span class="badge badge--${CATEGORY_TONE[category] || 'muted'}">${esc(category || 'OTHER')}</span>`;

export const connectionStatusBadge = (status) => statusBadge(status);

/** Human label for a Gateway operation id (testConnection → Test Connection). */
export function operationLabel(op) {
  return String(op || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export const eventResultBadge = (success) =>
  success
    ? `<span class="badge badge--success">${icon('check')} Success</span>`
    : `<span class="badge badge--danger">${icon('x')} Failed</span>`;

/**
 * Capability grid for one provider or one connection matrix entry list.
 * Accepts [{ id, description?, supported }] — the catalogue shape and the
 * connection capabilityMatrix shape both fit.
 */
export function capabilityGrid(capabilities) {
  const caps = capabilities || [];
  if (!caps.length) return '<span class="cell-sub">No capabilities advertised</span>';
  return `<div class="capability-grid">${caps.map((cap) => `
    <div class="capability ${cap.supported ? '' : 'capability--off'}">
      <span>${cap.supported ? icon('check') : icon('x')}</span>
      <span><span class="capability__label">${esc(titleCase(cap.id))}</span>
      ${cap.description ? `<span class="capability__desc">${esc(cap.description)}</span>` : ''}</span>
    </div>`).join('')}</div>`;
}

const methodLabel = (m) => (m && typeof m === 'object' ? m.id : m);

/**
 * Provider catalogue card. `status` is the tenant's connection state for this
 * provider when known ({ connected, count }) — omitted on the platform page,
 * which instead shows platform-wide connection counts via `counts`.
 */
export function providerCard(p, { status = null, counts = null, onConnect = null } = {}) {
  const methods = (p.connectionMethods || []).map(methodLabel);
  const supported = (p.capabilities || []).filter((c) => c.supported);
  // PR #71 identity metadata — rendered generically from provider metadata,
  // never from provider-specific UI branches.
  const envs = p.environments || [];
  const envLabel = envs.length === 1 ? `${envs[0] === 'SANDBOX' ? 'Sandbox only' : 'Production only'}` : '';
  return `
  <div class="list-card" style="margin-bottom:12px" data-provider="${esc(p.id)}">
    <div class="list-card__head">
      <span class="cell-main">${icon('plug')} ${esc(p.label)}${p.version ? ` <span class="badge badge--plain badge--muted">v${esc(p.version)}</span>` : ''}</span>
      <span style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">${categoryBadge(p.category)}
        ${envLabel ? `<span class="badge badge--plain badge--warning">${esc(envLabel)}</span>` : ''}
        ${status ? statusBadge(status.connected ? 'CONNECTED' : 'NOT_CONNECTED', status.connected ? `Connected · ${status.count}` : 'Not connected') : ''}
        ${counts ? `<span class="cell-sub">${counts.total} connection${counts.total === 1 ? '' : 's'} · ${counts.connected} active${counts.error ? ` · ${counts.error} failing` : ''}</span>` : ''}
      </span>
    </div>
    <div class="list-card__body">
      <div>
        <div class="cell-sub">${esc(p.description || '')}</div>
        ${p.docs?.url || p.docs?.guide ? `<a class="cell-sub" href="${esc(p.docs.url || '#')}" ${p.docs.url ? 'target="_blank" rel="noopener"' : ''}>${icon('info')} Provider documentation</a>` : ''}
        <div style="margin:8px 0;display:flex;gap:6px;flex-wrap:wrap">
          ${methods.map((m) => `<span class="badge badge--plain badge--info">${esc(m)}</span>`).join('')}
          ${(p.authTypes || []).map((a) => `<span class="badge badge--plain badge--purple">${esc(a)}</span>`).join('')}
          ${envs.length > 1 ? envs.map((e) => `<span class="badge badge--plain badge--success">${esc(e)}</span>`).join('') : ''}
          ${(p.regions || []).length ? `<span class="badge badge--plain badge--muted">${esc(p.regions.join(' · '))}</span>` : '<span class="badge badge--plain badge--muted">Worldwide</span>'}
          ${p.requiresCredentials ? `<span class="badge badge--plain badge--warning">${icon('shield')} Credentials required</span>` : ''}
        </div>
        <div class="cell-sub"><code>${esc(p.id)}</code></div>
        ${onConnect ? `<div style="margin-top:10px"><button class="btn btn--primary btn--sm" data-connect-provider="${esc(p.id)}">${icon('plus')} Connect</button></div>` : ''}
      </div>
      <div>
        <div class="cell-sub" style="margin-bottom:6px">${supported.length} of ${(p.capabilities || []).length} capabilities supported</div>
        ${capabilityGrid(p.capabilities)}
      </div>
    </div>
  </div>`;
}

/** Masked-secret row: proves a value is stored without ever showing it. */
export function credentialRow(field) {
  return `<div class="cell-flex">
    <div><div class="cell-main">${esc(field.name)}</div>
    <div class="cell-sub"><code>${esc(field.fingerprint || '••••')}</code>${field.updatedAt ? ` · set ${new Date(field.updatedAt).toLocaleDateString()}` : ''}</div></div>
    <span class="badge badge--success">Stored</span></div>`;
}

/**
 * One dynamic non-secret config field, driven by provider metadata.
 * Supported types: text (default), textarea, json, select, boolean, number,
 * url, email, password (non-secret only — real secrets use credential inputs).
 */
export function configFieldMarkup(f, value) {
  const id = `cfg-${f.name}`;
  const val = value ?? f.default ?? '';
  const label = `<label for="${id}">${esc(f.label || f.name)}${f.required ? ' *' : ''}</label>`;
  const hint = f.help ? `<span class="secret-field__hint">${esc(f.help)}</span>` : '';
  const max = f.maxLength ? `maxlength="${Number(f.maxLength)}"` : '';
  const req = f.required ? 'required' : '';
  if (f.type === 'select') {
    return `<div class="field">${label}<select id="${id}" data-config="${esc(f.name)}" ${req}>
      ${(f.options || []).map((o) => {
        const ov = typeof o === 'object' ? o.value : o;
        const ol = typeof o === 'object' ? (o.label || o.value) : o;
        return `<option value="${esc(ov)}" ${String(val) === String(ov) ? 'selected' : ''}>${esc(ol)}</option>`;
      }).join('')}
    </select>${hint}</div>`;
  }
  if (f.type === 'boolean') {
    return `<div class="field"><label class="checkline">
      <input type="checkbox" id="${id}" data-config="${esc(f.name)}" ${val ? 'checked' : ''}> ${esc(f.label || f.name)}</label>${hint}</div>`;
  }
  if (f.type === 'textarea' || f.type === 'json') {
    const text = typeof val === 'object' ? JSON.stringify(val, null, 2) : (val || '');
    return `<div class="field span-2">${label}<textarea id="${id}" data-config="${esc(f.name)}" rows="4" ${max} ${req}>${esc(text)}</textarea>${hint}</div>`;
  }
  if (f.type === 'number') {
    return `<div class="field">${label}<input id="${id}" data-config="${esc(f.name)}" type="number" value="${esc(val)}" ${req}>${hint}</div>`;
  }
  const type = f.type === 'url' ? 'url' : f.type === 'email' ? 'email' : 'text';
  return `<div class="field">${label}<input id="${id}" data-config="${esc(f.name)}" type="${type}" value="${esc(val)}" ${max} ${req}>${hint}</div>`;
}

/**
 * One dynamic SECRET input. Write-only: placeholders show the stored
 * fingerprint, values are never read back. Blank = keep server value.
 */
export function credentialFieldMarkup(f, stored) {
  return `<div class="field secret-field">
    <label for="c-${esc(f.name)}">${esc(f.label || f.name)}${f.required ? ' *' : ''}</label>
    <input id="c-${esc(f.name)}" data-credential="${esc(f.name)}"
      type="password" autocomplete="new-password" spellcheck="false"
      placeholder="${stored ? `stored ${stored.fingerprint || '••••'}` : ''}">
    ${stored
      ? `<span class="secret-field__hint">Stored <code>${esc(stored.fingerprint || '')}</code> — leave blank to keep it, type a new value to rotate.${f.help ? ` ${esc(f.help)}` : ''}</span>`
      : (f.help ? `<span class="secret-field__hint">${esc(f.help)}</span>` : '')}
  </div>`;
}

/** Reads [data-config] inputs, coercing by provider field type. */
export function collectConfig(fields, root) {
  const escAttr = (window.CSS && window.CSS.escape) ? window.CSS.escape : (s) => String(s).replace(/["\\]/g, '\\$&');
  const config = {};
  for (const f of (fields || [])) {
    const node = root.querySelector(`[data-config="${escAttr(f.name)}"]`);
    if (!node) continue;
    if (f.type === 'boolean') { config[f.name] = node.checked; continue; }
    if (f.type === 'number') { config[f.name] = node.value === '' ? null : Number(node.value); continue; }
    if (f.type === 'json') {
      if (!node.value.trim()) { config[f.name] = null; continue; }
      try { config[f.name] = JSON.parse(node.value); }
      catch { config[f.name] = node.value; }
      continue;
    }
    config[f.name] = node.value === '' ? null : node.value;
  }
  return config;
}

/**
 * Reads [data-credential] inputs. Only non-empty values are returned, so an
 * omitted field keeps the server-side secret (rotation semantics: omitted =
 * keep, null = clear, '' is never sent).
 */
export function collectCredentials(root) {
  const out = {};
  root.querySelectorAll('[data-credential]').forEach((node) => {
    if (node.value !== '') out[node.dataset.credential] = node.value;
  });
  return out;
}

/** True when an API error means the tenant's feature entitlement is off. */
export const isFeatureDisabledError = (e) =>
  e?.status === 403 && /not enabled for this tenant/i.test(e?.message || '');

export function featureDisabledNotice() {
  return `<div class="card"><div class="card__body">
    <div class="empty">${icon('shield')}
      <h3>Integrations are not enabled for this business</h3>
      <p>The platform owner has not enabled Universal Integrations for your account. Contact support to request access.</p>
    </div></div></div>`;
}

/** Relative time with an exact-time tooltip. */
export function timeCell(value) {
  if (!value) return '<span class="cell-sub">Never</span>';
  return `<span title="${esc(dateTime(value))}">${esc(relative(value))}</span>`;
}
