/** Supplier Marketplace → Settings: pricing defaults, automation, permissions, security. */
import { api, auth } from '../api.js';
import { setTitle } from '../layout.js';
import {
  qs, qsa, icon, esc, money, num, statusBadge, emptyState, modal, confirmDialog,
  formData, showFieldErrors, toast, toastError, titleCase, debounce,
} from '../ui.js';
import { sectionHead, kvList } from './supplier-nav.js';

let settings = null;
let permissionCatalog = [];
let categories = [];
let countries = [];

export async function render(view) {
  setTitle('Marketplace Settings');

  view.innerHTML = `
    ${sectionHead({
      title: 'Marketplace Settings',
      subtitle: 'Global defaults for pricing, automation, fulfilment, restrictions, permissions and credential security.',
      active: '/supplier-settings',
    })}
    <section class="card">
      <div class="card__head"><h2>Settings</h2></div>
      <div class="card__body" id="settingsBody"><div class="spinner"></div></div>
    </section>
    <section class="card">
      <div class="card__head"><h2>Markup rules</h2>
        <span class="cell-sub">Precedence: Product → Category → Supplier → Global default.</span>
        <button class="btn btn--primary btn--sm" id="newRuleBtn" style="margin-left:auto">${icon('plus')} Add rule</button></div>
      <div class="card__body card__body--flush"><div class="table-wrap"><table class="data">
        <caption class="sr-only">Markup rules</caption>
        <thead><tr><th scope="col">Scope</th><th scope="col">Target</th><th scope="col">Type</th>
          <th scope="col" class="num">Value</th><th scope="col">Rounding</th><th scope="col">Status</th>
          <th scope="col" style="text-align:right">Actions</th></tr></thead>
        <tbody id="ruleRows">${''}</tbody></table></div></div>
    </section>
    <section class="card">
      <div class="card__head"><h2>Permissions</h2>
        <span class="cell-sub">Extends the platform's role system — ADMIN and STAFF. Overrides are stored per role.</span></div>
      <div class="card__body" id="permBody"><div class="spinner"></div></div>
    </section>
    <section class="card">
      <div class="card__head"><h2>Security</h2></div>
      <div class="card__body" id="securityBody"><div class="spinner"></div></div>
    </section>`;

  try {
    const { data } = await api.get('/supplier-settings');
    settings = data.settings;
    permissionCatalog = data.permissions.available;
    countries = data.reference.countries;
    paintSettings(data);
    paintSecurity(data);
  } catch (e) {
    qs('#settingsBody', view).innerHTML = emptyState('Could not load settings', e.message);
    qs('#securityBody', view).innerHTML = emptyState('Could not load security status', e.message);
  }

  try {
    categories = (await api.get('/categories')).data;
  } catch (e) { toastError(e); }

  await loadRules();
  await loadPermissions();

  /* ------------------------------------------------------------- settings */

  function paintSettings(data) {
    const s = data.settings;
    qs('#settingsBody', view).innerHTML = `<form id="settingsForm">
      <div class="field--group" style="margin-bottom:12px"><span class="field--group__label">Pricing defaults</span>
        <div class="field--group__body">
          <div class="field"><label for="s-markupType">Global markup type</label>
            <select id="s-markupType" name="defaultMarkupType">
              <option value="PERCENT" ${s.defaultMarkupType === 'PERCENT' ? 'selected' : ''}>Percentage</option>
              <option value="FIXED" ${s.defaultMarkupType === 'FIXED' ? 'selected' : ''}>Fixed amount</option>
            </select></div>
          <div class="field"><label for="s-markupValue">Global markup value</label>
            <input id="s-markupValue" name="defaultMarkupValue" type="number" step="0.01" value="${s.defaultMarkupValue}">
            <small class="secret-field__hint">Example: cost 100 at 30% ⇒ selling price 130.</small></div>
          <div class="field"><label for="s-roundTo">Round prices to nearest</label>
            <input id="s-roundTo" name="roundTo" type="number" step="0.01" min="0" value="${s.roundTo ?? ''}" placeholder="e.g. 0.05, 1, 5"></div>
          <div class="field"><label for="s-currency">Default currency</label>
            <input id="s-currency" name="defaultCurrency" maxlength="3" value="${esc(s.defaultCurrency)}"></div>
          <div class="field span-2"><label for="s-fx">Exchange rates into the default currency</label>
            <textarea id="s-fx" rows="3" placeholder='{ "EUR": 1.08, "GBP": 1.27 }'>${esc(JSON.stringify(s.fxRates || {}, null, 2))}</textarea>
            <small class="secret-field__hint">A supplier whose currency has no configured rate is reported as “rate not configured” rather than silently assumed to be 1:1.</small></div>
          <div class="field"><button type="button" class="btn btn--subtle btn--sm" id="fxTest">Test a conversion</button></div>
        </div></div>

      <div class="field--group" style="margin-bottom:12px"><span class="field--group__label">Catalogue behaviour</span>
        <div class="field--group__body">
          <div class="field"><label for="s-country">Default destination country</label>
            <input id="s-country" name="defaultCountry" maxlength="2" value="${esc(s.defaultCountry)}"></div>
          <div class="field"><label for="s-fulfillment">Default fulfilment method</label>
            <select id="s-fulfillment" name="defaultFulfillmentType">
              ${['LOCAL', 'SUPPLIER_FULFILLED', 'HYBRID'].map((f) => `<option value="${f}" ${s.defaultFulfillmentType === f ? 'selected' : ''}>${esc(titleCase(f))}</option>`).join('')}
            </select></div>
          <div class="field"><label class="checkline" style="margin-top:26px">
            <input type="checkbox" name="autoPublish" ${s.autoPublish ? 'checked' : ''}> Auto-publish imported products (skip review)</label></div>
          <div class="field"><label class="checkline" style="margin-top:26px">
            <input type="checkbox" name="autoCreateProducts" ${s.autoCreateProducts ? 'checked' : ''}> Create a catalogue product when publishing an unmapped item</label></div>
          <div class="field"><label class="checkline" style="margin-top:26px">
            <input type="checkbox" name="restrictUnmapped" ${s.restrictUnmapped ? 'checked' : ''}> Block checkout when a supplier-fulfilled item has no shipping quote</label></div>
        </div></div>

      <div class="field--group" style="margin-bottom:12px"><span class="field--group__label">Synchronisation</span>
        <div class="field--group__body">
          <div class="field"><label class="checkline">
            <input type="checkbox" name="autoSyncEnabled" ${s.autoSyncEnabled ? 'checked' : ''}> Automatic synchronisation enabled</label></div>
          <div class="field"><label for="s-interval">Default interval (minutes)</label>
            <input id="s-interval" name="syncIntervalMinutes" type="number" min="5" max="10080" value="${s.syncIntervalMinutes}"></div>
          <div class="field"><label for="s-batch">Batch size</label>
            <input id="s-batch" name="batchSize" type="number" min="10" max="1000" value="${s.batchSize}"></div>
          <div class="field"><label for="s-concurrency">Max simultaneous syncs</label>
            <input id="s-concurrency" name="syncConcurrency" type="number" min="1" max="8" value="${s.syncConcurrency}"></div>
          <div class="field"><label for="s-attempts">Max retry attempts</label>
            <input id="s-attempts" name="maxSyncAttempts" type="number" min="1" max="10" value="${s.maxSyncAttempts}"></div>
        </div></div>

      <div class="field--group" style="margin-bottom:12px"><span class="field--group__label">Fulfilment</span>
        <div class="field--group__body">
          <div class="field"><label class="checkline">
            <input type="checkbox" name="autoFulfillOnPaid" ${s.autoFulfillOnPaid ? 'checked' : ''}> Raise supplier fulfilments as soon as an order is paid</label></div>
          <div class="field"><label class="checkline">
            <input type="checkbox" name="autoSubmitOrders" ${s.autoSubmitOrders ? 'checked' : ''}> Transmit purchase orders automatically (no operator confirmation)</label></div>
          <div class="field"><label for="s-method">Default shipping method</label>
            <input id="s-method" name="defaultShippingMethod" maxlength="40" value="${esc(s.defaultShippingMethod)}"></div>
        </div></div>

      <div class="field--group" style="margin-bottom:12px"><span class="field--group__label">Restrictions &amp; vocabularies</span>
        <div class="field--group__body">
          <div class="field span-2"><label for="s-blocked">Platform-blocked countries</label>
            <input id="s-blocked" name="blockedCountriesText" value="${esc((s.blockedCountries || []).join(', '))}"
              placeholder="Comma-separated ISO codes — these are never sold to, regardless of supplier settings"></div>
          <div class="field span-2"><label for="s-types">Supplier types</label>
            <input id="s-types" name="supplierTypesText" value="${esc((s.supplierTypes || []).join(', '))}"></div>
          <div class="field span-2"><label for="s-restrictions">Restriction types</label>
            <input id="s-restrictions" name="restrictionTypesText" value="${esc((s.restrictionTypes || []).join(', '))}">
            <small class="secret-field__hint">Labels only. The platform does not encode any legal requirement — you decide what each restriction means for your trade.</small></div>
        </div></div>

      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button type="button" class="btn btn--ghost" id="resetBtn">Discard changes</button>
        <button type="button" class="btn btn--primary" id="saveBtn">Save settings</button>
      </div></form>`;

    const form = qs('#settingsForm', view);
    qs('#saveBtn', view).onclick = async () => {
      const payload = formData(form);
      let fxRates = {};
      const fxText = qs('#s-fx', view).value.trim();
      if (fxText) {
        try { fxRates = JSON.parse(fxText); }
        catch { return toast('Exchange rates must be valid JSON', 'error'); }
      }
      payload.fxRates = fxRates;
      payload.blockedCountries = String(payload.blockedCountriesText || '').split(',').map((v) => v.trim().toUpperCase()).filter(Boolean);
      payload.supplierTypes = String(payload.supplierTypesText || '').split(',').map((v) => v.trim().toUpperCase()).filter(Boolean);
      payload.restrictionTypes = String(payload.restrictionTypesText || '').split(',').map((v) => v.trim().toUpperCase()).filter(Boolean);
      delete payload.blockedCountriesText; delete payload.supplierTypesText; delete payload.restrictionTypesText;
      if (payload.roundTo === undefined) payload.roundTo = null;
      try {
        const { data: r } = await api.put('/supplier-settings', payload);
        settings = r.settings;
        toast('Marketplace settings saved');
        paintSettings({ settings: r.settings, permissions: { available: permissionCatalog }, security: null, reference: { countries } });
      } catch (e) { showFieldErrors(form, e); }
    };
    qs('#resetBtn', view).onclick = () => paintSettings({ settings, permissions: { available: permissionCatalog }, security: null, reference: { countries } });

    qs('#fxTest', view).onclick = () => fxDialog();
  }

  function paintSecurity(data) {
    const sec = data.security;
    if (!sec) return;
    qs('#securityBody', view).innerHTML = `
      ${kvList([
        ['Credential encryption', sec.dedicatedCredentialKey
          ? '<span class="badge badge--success">Dedicated key configured</span>'
          : '<span class="badge badge--warning">Using the JWT secret</span>'],
        ['Key source', `<code>${esc(sec.credentialKeySource)}</code>`],
        ['Algorithm', 'AES-256-GCM (authenticated, per-record IV)'],
        ['Browser exposure', 'Masked fingerprints only — plaintext is never returned'],
      ])}
      <h4 style="margin:16px 0 6px">Registered connectors</h4>
      <div class="table-wrap"><table class="data"><thead><tr><th>Connector</th><th>Runtime</th></tr></thead>
      <tbody>${sec.connectors.map((c) => `<tr><td>${esc(c.label)} <code>${esc(c.id)}</code></td>
        <td>${c.installed ? '<span class="badge badge--success">Ready</span>' : '<span class="badge badge--warning">Runtime required</span>'}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="alert alert--info" style="margin-top:12px">${icon('shield')}
        To rotate the encryption key: set a new <code>SUPPLIER_CREDENTIALS_KEY</code>, then re-enter each integration's
        credentials from Supplier Integrations. Old ciphertext cannot be read with a new key.</div>`;
  }

  /* ---------------------------------------------------------- markup rules */

  async function loadRules() {
    const rows = qs('#ruleRows', view);
    try {
      const { data } = await api.get('/supplier-settings/markup-rules');
      const rules = data.rules;
      if (!rules.length) {
        rows.innerHTML = `<tr><td colspan="7">${emptyState('No category or global markup rules',
          `The global default from settings applies to everything: ${settings?.defaultMarkupType === 'FIXED' ? money(settings.defaultMarkupValue) : `${settings?.defaultMarkupValue}%`}.`)}</td></tr>`;
        return;
      }
      rows.innerHTML = rules.map((r) => `<tr data-id="${esc(r.id)}">
        <td>${statusBadge(r.scope === 'GLOBAL' ? 'CONNECTED' : 'INFO', titleCase(r.scope))}</td>
        <td>${r.scope === 'GLOBAL' ? 'Everything' : esc(categories.find((c) => c.id === r.categoryId)?.name || r.categoryId)}</td>
        <td>${esc(titleCase(r.markupType))}</td>
        <td class="num">${r.markupType === 'FIXED' ? money(r.markupValue) : `${r.markupValue}%`}</td>
        <td>${r.roundTo ? `nearest ${r.roundTo}` : '—'}</td>
        <td>${r.isActive ? '<span class="badge badge--success">Active</span>' : '<span class="badge badge--muted">Paused</span>'}</td>
        <td><div class="row-actions">
          <button class="btn btn--ghost btn--icon" data-act="edit" aria-label="Edit rule">${icon('edit')}</button>
          <button class="btn btn--ghost btn--icon" data-act="delete" aria-label="Delete rule" ${auth.isAdmin ? '' : 'disabled'}>${icon('trash')}</button>
        </div></td></tr>`).join('');
    } catch (e) { rows.innerHTML = `<tr><td colspan="7">${emptyState('Could not load markup rules', e.message)}</td></tr>`; }
  }

  qs('#newRuleBtn', view).onclick = () => ruleForm({ onSaved: loadRules });

  qs('#ruleRows', view).addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    if (btn.dataset.act === 'edit') {
      const { data } = await api.get('/supplier-settings/markup-rules');
      return ruleForm({ rule: data.rules.find((r) => r.id === id), onSaved: loadRules });
    }
    if (btn.dataset.act === 'delete') {
      const ok = await confirmDialog({ title: 'Delete markup rule?', message: 'Products that relied on it fall back to the supplier or global rule.', confirmLabel: 'Delete' });
      if (!ok) return;
      try { await api.del(`/supplier-settings/markup-rules/${id}`); toast('Markup rule deleted'); loadRules(); }
      catch (err) { toastError(err); }
    }
  });

  function ruleForm({ rule = null, onSaved }) {
    const editing = Boolean(rule);
    const r = rule || {};
    modal({
      title: editing ? 'Edit markup rule' : 'Add markup rule',
      body: `<form id="ruleForm">
        <div class="grid grid--form">
          <div class="field"><label for="r-scope">Scope</label>
            <select id="r-scope" name="scope" ${editing ? 'disabled' : ''}>
              <option value="CATEGORY" ${(r.scope || 'CATEGORY') === 'CATEGORY' ? 'selected' : ''}>Category</option>
              <option value="GLOBAL" ${r.scope === 'GLOBAL' ? 'selected' : ''}>Global</option>
            </select>
            <small class="secret-field__hint">The global default lives in Settings; a GLOBAL rule here overrides it.</small></div>
          <div class="field"><label for="r-category">Category</label>
            <select id="r-category" name="categoryId"><option value="">—</option>
              ${categories.map((c) => `<option value="${esc(c.id)}" ${r.categoryId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
          <div class="field"><label for="r-type">Type</label>
            <select id="r-type" name="markupType">
              <option value="PERCENT" ${(r.markupType || 'PERCENT') === 'PERCENT' ? 'selected' : ''}>Percentage</option>
              <option value="FIXED" ${r.markupType === 'FIXED' ? 'selected' : ''}>Fixed amount</option>
            </select></div>
          <div class="field"><label for="r-value">Value</label>
            <input id="r-value" name="markupValue" type="number" step="0.01" value="${r.markupValue ?? 0}"></div>
          <div class="field"><label for="r-round">Round to nearest</label>
            <input id="r-round" name="roundTo" type="number" step="0.01" min="0" value="${r.roundTo ?? ''}"></div>
          <div class="field"><label class="checkline" style="margin-top:26px">
            <input type="checkbox" name="isActive" ${r.isActive === false ? '' : 'checked'}> Active</label></div>
          <div class="field span-2"><div class="alert alert--info" id="r-preview">${icon('money')} Enter a cost to preview.</div></div>
          <div class="field"><label for="r-cost">Preview cost</label>
            <input id="r-cost" type="number" step="0.01" min="0" value="100"></div>
        </div></form>`,
      footer: `<button class="btn btn--ghost" data-close>Cancel</button>
               <button class="btn btn--primary" id="r-save">${editing ? 'Save rule' : 'Add rule'}</button>`,
      onMount: ({ root, close }) => {
        const previewHost = qs('#r-preview', root);
        const update = debounce(async () => {
          const cost = Number(qs('#r-cost', root).value) || 0;
          try {
            const { data } = await api.post('/supplier-settings/markup-preview', {
              cost, markupType: qs('#r-type', root).value,
              markupValue: Number(qs('#r-value', root).value) || 0,
              roundTo: qs('#r-round', root).value === '' ? null : Number(qs('#r-round', root).value),
            });
            previewHost.innerHTML = `${icon('money')} ${esc(data.explanation)} — margin ${money(data.margin)} (${data.marginPercent}%)`;
          } catch { /* advisory only */ }
        }, 300);
        ['#r-cost', '#r-value', '#r-type', '#r-round'].forEach((sel) => {
          qs(sel, root).addEventListener('input', update);
          qs(sel, root).addEventListener('change', update);
        });
        update();

        qs('#r-save', root).onclick = async () => {
          const payload = formData(root.querySelector('#ruleForm'));
          payload.categoryId = payload.categoryId || null;
          if (payload.roundTo === undefined) payload.roundTo = null;
          if (payload.scope === 'CATEGORY' && !payload.categoryId) return toast('Choose a category for a category rule', 'warning');
          try {
            if (editing) { delete payload.scope; await api.put(`/supplier-settings/markup-rules/${r.id}`, payload); toast('Markup rule updated'); }
            else { await api.post('/supplier-settings/markup-rules', payload); toast('Markup rule added'); }
            close(); onSaved?.();
          } catch (e) { toastError(e); }
        };
      },
    });
  }

  /* ---------------------------------------------------------- permissions */

  async function loadPermissions() {
    const host = qs('#permBody', view);
    try {
      const { data } = await api.get('/supplier-settings/permissions');
      host.innerHTML = `
        <div class="table-wrap"><table class="data"><thead><tr>
          <th>Permission</th><th>Description</th><th>ADMIN</th><th>STAFF</th></tr></thead>
          <tbody>${data.available.map((p) => `<tr>
            <td><div class="cell-main">${esc(p.label)}</div><div class="cell-sub"><code>${esc(p.id)}</code></div></td>
            <td>${esc(p.description)}</td>
            <td>${toggle(data.policy.ADMIN, p.id, 'ADMIN')}</td>
            <td>${toggle(data.policy.STAFF, p.id, 'STAFF')}</td></tr>`).join('')}
          </tbody></table></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
          <button class="btn btn--ghost" id="permReset">Restore defaults</button>
          <button class="btn btn--primary" id="permSave" ${auth.isAdmin ? '' : 'disabled'}>Save permissions</button>
        </div>
        ${auth.isAdmin ? '' : '<div class="alert alert--info" style="margin-top:10px">Only administrators can change the permission policy.</div>'}`;

      const collect = (role) => {
        const boxes = qsa(`input[data-role="${role}"]`, host);
        const all = boxes.every((b) => b.checked);
        return all ? ['*'] : boxes.filter((b) => b.checked).map((b) => b.value);
      };

      qs('#permSave', host).onclick = async () => {
        try {
          await api.put('/supplier-settings/permissions', { role: 'STAFF', permissions: collect('STAFF') });
          if (auth.isAdmin) await api.put('/supplier-settings/permissions', { role: 'ADMIN', permissions: collect('ADMIN') });
          toast('Permission policy saved');
          loadPermissions();
        } catch (e) { toastError(e); }
      };
      qs('#permReset', host).onclick = async () => {
        const ok = await confirmDialog({ title: 'Restore default permissions?', message: 'ADMIN keeps everything; STAFF keeps view, import, sync and fulfilment.', confirmLabel: 'Restore', danger: false });
        if (!ok) return;
        try {
          await api.put('/supplier-settings/permissions', { role: 'ADMIN', permissions: ['*'] });
          await api.put('/supplier-settings/permissions', { role: 'STAFF', permissions: data.defaults.STAFF });
          toast('Defaults restored'); loadPermissions();
        } catch (e) { toastError(e); }
      };
    } catch (e) { host.innerHTML = emptyState('Could not load permissions', e.message); }
  }

  function toggle(policy, id, role) {
    const all = policy.includes('*');
    const checked = all || policy.includes(id);
    return `<label class="checkline"><input type="checkbox" data-role="${role}" value="${esc(id)}"
      ${checked ? 'checked' : ''} ${auth.isAdmin ? '' : 'disabled'}> ${all ? 'All' : ''}</label>`;
  }

  /* ------------------------------------------------------------ fx dialog */

  function fxDialog() {
    modal({
      title: 'Test a currency conversion',
      body: `<form id="fxForm"><div class="grid grid--form">
        <div class="field"><label for="fx-amount">Amount</label><input id="fx-amount" type="number" step="0.01" value="100"></div>
        <div class="field"><label for="fx-from">From</label><input id="fx-from" maxlength="3" value="EUR"></div>
        <div class="field"><label for="fx-to">To</label><input id="fx-to" maxlength="3" value="${esc(settings.defaultCurrency)}"></div>
      </div><div id="fx-result" style="margin-top:12px"></div></form>`,
      footer: '<button class="btn btn--ghost" data-close>Close</button>',
      onMount: ({ root }) => {
        const run = async () => {
          const from = qs('#fx-from', root).value.toUpperCase();
          const to = qs('#fx-to', root).value.toUpperCase();
          const amount = Number(qs('#fx-amount', root).value) || 0;
          const rates = (() => { try { return JSON.parse(qs('#s-fx', view).value || '{}'); } catch { return {}; } })();
          const rate = from === to ? 1 : rates[from];
          const host = qs('#fx-result', root);
          if (!rate) {
            host.innerHTML = `<div class="alert alert--error">${icon('alert')} No rate configured for ${esc(from)} → ${esc(to)}.
              The platform reports this as “rate not configured” rather than assuming parity.</div>`;
            return;
          }
          host.innerHTML = `<div class="alert alert--success">${icon('check')} ${amount} ${esc(from)} × ${rate} =
            <strong>${money(amount * rate)}</strong> ${esc(to)}</div>`;
        };
        ['#fx-amount', '#fx-from', '#fx-to'].forEach((s) => qs(s, root).addEventListener('input', run));
        run();
      },
    });
  }
}
