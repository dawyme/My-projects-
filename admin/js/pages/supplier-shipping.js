/** Supplier Marketplace → Shipping: rules, restrictions and live quotes. */
import { api, auth } from '../api.js';
import { setTitle } from '../layout.js';
import {
  qs, qsa, icon, esc, money, num, statusBadge, skeletonRows, emptyState,
  pagination, modal, confirmDialog, formData, showFieldErrors, toast, toastError, titleCase,
} from '../ui.js';
import { sectionHead } from './supplier-nav.js';

const state = { page: 1, limit: 20, scope: '', supplierId: '', restricted: '', search: '' };
let suppliers = [];
let categories = [];
let vocabulary = { shippingMethods: [], countries: [], regions: [] };

export async function render(view) {
  setTitle('Supplier Shipping');

  view.innerHTML = `
    ${sectionHead({
      title: 'Shipping',
      subtitle: 'Destination rules, costs and delivery estimates. No worldwide default rate exists — if no rule matches, the item cannot ship there.',
      active: '/supplier-shipping',
      actions: `<button class="btn btn--ghost" id="quoteBtn">${icon('globe')} Test a quote</button>
                <button class="btn btn--primary" id="newBtn">${icon('plus')} Add shipping rule</button>`,
    })}
    <section class="card">
      <div class="toolbar">
        <label class="sr-only" for="searchInput">Search rules</label>
        <input id="searchInput" class="toolbar__search" type="search" placeholder="Search by name, method or carrier…" value="${esc(state.search)}">
        <label class="sr-only" for="scopeFilter">Scope</label>
        <select id="scopeFilter"><option value="">All scopes</option>
          <option value="GLOBAL">Global</option><option value="CATEGORY">Category</option>
          <option value="SUPPLIER">Supplier</option><option value="PRODUCT">Product</option></select>
        <label class="sr-only" for="supplierFilter">Supplier</label>
        <select id="supplierFilter"><option value="">All suppliers</option></select>
        <label class="sr-only" for="restrictedFilter">Restricted</label>
        <select id="restrictedFilter"><option value="">All rules</option><option value="true">Restricted goods only</option></select>
      </div>
      <div class="table-wrap"><table class="data">
        <caption class="sr-only">Shipping rules</caption>
        <thead><tr><th scope="col">Rule</th><th scope="col">Scope</th><th scope="col">Destinations</th>
          <th scope="col">Method</th><th scope="col" class="num">Cost</th><th scope="col">Estimate</th>
          <th scope="col">Status</th><th scope="col" style="text-align:right">Actions</th></tr></thead>
        <tbody id="rows">${skeletonRows(8)}</tbody></table></div>
      <div class="card__foot" id="pager"></div>
    </section>
    <section class="card">
      <div class="card__head"><h2>Restricted products</h2>
        <span class="cell-sub">Refrigerants, pressurised goods and anything else you have flagged. Every restriction here is operator-defined.</span></div>
      <div class="card__body" id="restrictions"><div class="spinner"></div></div>
    </section>`;

  const rows = qs('#rows', view);
  const pager = qs('#pager', view);

  try {
    const [{ data: supplierPage }, { data: categoryPage }, { data: types }] = await Promise.all([
      api.get('/suppliers', { status: 'ALL', limit: 100 }),
      api.get('/categories'),
      api.get('/suppliers/types'),
    ]);
    suppliers = supplierPage;
    categories = categoryPage;
    vocabulary = types;
    qs('#supplierFilter', view).innerHTML = `<option value="">All suppliers</option>${suppliers.map((s) =>
      `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}`;
  } catch (e) { toastError(e); }

  async function load() {
    rows.innerHTML = skeletonRows(8);
    try {
      const { data, meta } = await api.get('/supplier-shipping', {
        page: state.page, limit: state.limit, search: state.search, scope: state.scope,
        supplierId: state.supplierId, restricted: state.restricted,
      });
      if (!data.length) {
        rows.innerHTML = `<tr><td colspan="8">${emptyState('No shipping rules yet',
          'Add at least one rule before publishing supplier products, otherwise nothing can be quoted for shipment.',
          '<button class="btn btn--primary" id="emptyAdd">Add shipping rule</button>')}</td></tr>`;
        qs('#emptyAdd', view)?.addEventListener('click', () => ruleForm({ onSaved: load }));
        pager.innerHTML = '';
        return;
      }
      rows.innerHTML = data.map(rowMarkup).join('');
      pager.innerHTML = '';
      pager.appendChild(pagination(meta, (p) => { state.page = p; load(); }));
    } catch (e) {
      rows.innerHTML = `<tr><td colspan="8">${emptyState('Could not load shipping rules', e.message)}</td></tr>`;
    }
  }

  function rowMarkup(r) {
    const dest = r.countries.length
      ? `${num(r.countries.length)} countries`
      : r.regions.length ? r.regions.map((x) => esc(titleCase(x))).join(', ') : 'Anywhere not excluded';
    return `<tr data-id="${esc(r.id)}">
      <td><div class="cell-main">${esc(r.name)}</div>
          <div class="cell-sub">${esc(r.carrier || '—')}${r.restricted ? ' · restricted goods' : ''}</div></td>
      <td>${statusBadge(r.scope === 'GLOBAL' ? 'LOCAL' : r.scope === 'SUPPLIER' ? 'HYBRID' : 'INFO', titleCase(r.scope))}
          <div class="cell-sub">${esc(r.supplier?.name || r.supplierProduct?.supplierSku || '')}</div></td>
      <td>${dest}${r.excludedCountries.length ? `<div class="cell-sub">excl. ${esc(r.excludedCountries.join(', '))}</div>` : ''}</td>
      <td><code>${esc(r.method)}</code><div class="cell-sub">${esc(r.methodName)}</div></td>
      <td class="num">${money(r.baseCost)}
        <div class="cell-sub">${r.perKgCost ? `+${money(r.perKgCost)}/kg` : ''}${r.perItemCost ? ` +${money(r.perItemCost)}/item` : ''}
        ${r.freeOverAmount ? ` · free over ${money(r.freeOverAmount)}` : ''}</div></td>
      <td>${r.minDays || r.maxDays ? `${num(r.minDays)}–${num(r.maxDays)} day(s)` : '—'}</td>
      <td>${r.isActive ? '<span class="badge badge--success">Active</span>' : '<span class="badge badge--muted">Paused</span>'}</td>
      <td><div class="row-actions">
        <button class="btn btn--ghost btn--icon" data-act="edit" aria-label="Edit rule">${icon('edit')}</button>
        <button class="btn btn--ghost btn--icon" data-act="test" aria-label="Test a quote">${icon('globe')}</button>
        <button class="btn btn--ghost btn--icon" data-act="delete" aria-label="Delete rule" ${auth.isAdmin ? '' : 'disabled'}>${icon('trash')}</button>
      </div></td></tr>`;
  }

  const bind = (id, key) => { qs(id, view).onchange = (e) => { state[key] = e.target.value; state.page = 1; load(); }; };
  bind('#scopeFilter', 'scope'); bind('#supplierFilter', 'supplierId'); bind('#restrictedFilter', 'restricted');
  qs('#searchInput', view).oninput = (e) => { state.search = e.target.value.trim(); state.page = 1; clearTimeout(window.__shipT); window.__shipT = setTimeout(load, 320); };
  qs('#newBtn', view).onclick = () => ruleForm({ onSaved: load });
  qs('#quoteBtn', view).onclick = () => quoteDialog();

  rows.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    const act = btn.dataset.act;
    if (act === 'edit') {
      const { data } = await api.get('/supplier-shipping', { limit: 100 });
      const rule = data.find((r) => r.id === id);
      return ruleForm({ rule, onSaved: load });
    }
    if (act === 'test') {
      const { data } = await api.get('/supplier-shipping', { limit: 100 });
      const rule = data.find((r) => r.id === id);
      return quoteDialog({ supplierId: rule.supplierId || undefined });
    }
    if (act === 'delete') {
      const ok = await confirmDialog({ title: 'Delete shipping rule?', message: 'Destinations it covered will stop quoting until another rule matches.', confirmLabel: 'Delete' });
      if (!ok) return;
      try { await api.del(`/supplier-shipping/${id}`); toast('Shipping rule deleted'); load(); }
      catch (err) { toastError(err); }
    }
  });

  await load();
  loadRestrictions();

  async function loadRestrictions() {
    const host = qs('#restrictions', view);
    try {
      const { data } = await api.get('/supplier-shipping/restrictions');
      if (!data.products.length) {
        host.innerHTML = emptyState('No restricted products', 'Flag a supplier product as restricted (for example a refrigerant) to manage its handling rules here.');
        return;
      }
      host.innerHTML = `<div class="table-wrap"><table class="data"><thead><tr>
        <th>Product</th><th>Type</th><th>Supplier</th><th>Documents required</th>
        <th>Allowed countries</th><th>Blocked</th><th>Shipping methods</th><th>Published</th></tr></thead>
        <tbody>${data.products.map((p) => `<tr>
          <td><div class="cell-main">${esc(p.name)}</div><div class="cell-sub"><code>${esc(p.supplierSku)}</code></div></td>
          <td><span class="badge badge--danger">${esc(titleCase(p.restrictionType || 'Restricted'))}</span>
              ${p.restrictionNotes ? `<div class="cell-sub">${esc(p.restrictionNotes)}</div>` : ''}</td>
          <td>${esc(p.supplier?.name || '—')}</td>
          <td>${p.documentationRequired.length ? esc(p.documentationRequired.join(', ')) : '—'}</td>
          <td>${p.allowedCountries.length ? esc(p.allowedCountries.join(', ')) : 'Follows supplier'}</td>
          <td>${p.blockedCountries.length ? esc(p.blockedCountries.join(', ')) : '—'}</td>
          <td>${p.allowedShippingMethods.length ? esc(p.allowedShippingMethods.join(', ')) : 'Any'}</td>
          <td>${p.published ? '<span class="badge badge--success">Live</span>' : '<span class="badge badge--muted">Draft</span>'}</td></tr>`).join('')}
        </tbody></table></div>
        ${data.rules.length ? `<h4 style="margin:14px 0 6px">Restricted-goods shipping rules</h4>
          <div class="table-wrap"><table class="data"><thead><tr><th>Rule</th><th>Method</th><th>Note</th></tr></thead>
          <tbody>${data.rules.map((r) => `<tr><td>${esc(r.name)}</td><td><code>${esc(r.method)}</code></td><td>${esc(r.restrictionNote || '—')}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
    } catch (e) { host.innerHTML = emptyState('Could not load restrictions', e.message); }
  }

  /* -------------------------------------------------------------- dialogs */

  function ruleForm({ rule = null, onSaved }) {
    const editing = Boolean(rule);
    const r = rule || {};
    modal({
      title: editing ? `Edit ${r.name}` : 'Add shipping rule',
      size: 'lg',
      body: `<form id="shipForm" novalidate>
        <div class="grid grid--form">
          <div class="field span-2"><label for="sh-name">Rule name *</label>
            <input id="sh-name" name="name" required maxlength="140" value="${esc(r.name || '')}" placeholder="Caribbean standard freight"></div>
          <div class="field"><label for="sh-scope">Scope</label>
            <select id="sh-scope" name="scope">
              ${['GLOBAL', 'CATEGORY', 'SUPPLIER', 'PRODUCT'].map((s) =>
                `<option value="${s}" ${(r.scope || 'SUPPLIER') === s ? 'selected' : ''}>${esc(titleCase(s))}</option>`).join('')}
            </select>
            <small class="secret-field__hint">Product beats Category, Category beats Supplier, Supplier beats Global.</small></div>
          <div class="field"><label for="sh-supplier">Supplier</label>
            <select id="sh-supplier" name="supplierId"><option value="">—</option>
              ${suppliers.map((s) => `<option value="${esc(s.id)}" ${r.supplierId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
          <div class="field"><label for="sh-category">Category</label>
            <select id="sh-category" name="categoryId"><option value="">—</option>
              ${categories.map((c) => `<option value="${esc(c.id)}" ${r.categoryId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
          <div class="field"><label for="sh-method">Method code</label>
            <select id="sh-method" name="method">
              ${vocabulary.shippingMethods.map((m) => `<option value="${esc(m.code)}" ${(r.method || 'STANDARD') === m.code ? 'selected' : ''}>${esc(m.code)}</option>`).join('')}
            </select></div>
          <div class="field"><label for="sh-methodName">Method name</label>
            <input id="sh-methodName" name="methodName" maxlength="120" value="${esc(r.methodName || 'Standard shipping')}"></div>
          <div class="field"><label for="sh-carrier">Carrier</label>
            <input id="sh-carrier" name="carrier" maxlength="120" value="${esc(r.carrier || '')}"></div>
          <div class="field"><label for="sh-base">Base cost</label>
            <input id="sh-base" name="baseCost" type="number" step="0.01" min="0" value="${r.baseCost ?? 0}"></div>
          <div class="field"><label for="sh-perKg">Cost per kg</label>
            <input id="sh-perKg" name="perKgCost" type="number" step="0.01" min="0" value="${r.perKgCost ?? 0}"></div>
          <div class="field"><label for="sh-perItem">Cost per item</label>
            <input id="sh-perItem" name="perItemCost" type="number" step="0.01" min="0" value="${r.perItemCost ?? 0}"></div>
          <div class="field"><label for="sh-free">Free shipping over</label>
            <input id="sh-free" name="freeOverAmount" type="number" step="0.01" min="0" value="${r.freeOverAmount ?? ''}" placeholder="Leave blank for never"></div>
          <div class="field"><label for="sh-min">Minimum days</label>
            <input id="sh-min" name="minDays" type="number" min="0" max="365" value="${r.minDays ?? 0}"></div>
          <div class="field"><label for="sh-max">Maximum days</label>
            <input id="sh-max" name="maxDays" type="number" min="0" max="365" value="${r.maxDays ?? 0}"></div>
          <div class="field span-2"><label for="sh-countries">Allowed countries / regions</label>
            <input id="sh-countries" name="countriesText" placeholder="CARIBBEAN, TT, JM — blank means anywhere not excluded"
              value="${esc((r.countries || []).join(', '))}"></div>
          <div class="field span-2"><label for="sh-excluded">Excluded countries / regions</label>
            <input id="sh-excluded" name="excludedCountriesText" value="${esc((r.excludedCountries || []).join(', '))}"></div>
          <div class="field span-2"><label class="checkline">
            <input type="checkbox" name="restricted" ${r.restricted ? 'checked' : ''}> This rule applies only to restricted goods (refrigerants, pressurised items…)</label></div>
          <div class="field span-2"><label for="sh-note">Restriction note</label>
            <input id="sh-note" name="restrictionNote" maxlength="400" value="${esc(r.restrictionNote || '')}"></div>
          <div class="field"><label for="sh-sort">Sort order</label>
            <input id="sh-sort" name="sortOrder" type="number" min="0" value="${r.sortOrder ?? 0}"></div>
          <div class="field"><label class="checkline" style="margin-top:26px">
            <input type="checkbox" name="isActive" ${r.isActive === false ? '' : 'checked'}> Rule is active</label></div>
        </div></form>`,
      footer: `<button class="btn btn--ghost" data-close>Cancel</button>
               <button class="btn btn--primary" id="sh-save">${editing ? 'Save rule' : 'Add rule'}</button>`,
      onMount: ({ root, close }) => {
        const form = qs('#shipForm', root);
        qs('#sh-save', root).onclick = async () => {
          const payload = formData(form);
          const split = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
          payload.countries = split(payload.countriesText);
          payload.excludedCountries = split(payload.excludedCountriesText);
          delete payload.countriesText;
          delete payload.excludedCountriesText;
          payload.supplierId = payload.supplierId || null;
          payload.categoryId = payload.categoryId || null;
          if (payload.freeOverAmount === undefined) payload.freeOverAmount = null;
          try {
            if (editing) { await api.put(`/supplier-shipping/${r.id}`, payload); toast('Shipping rule updated'); }
            else { await api.post('/supplier-shipping', payload); toast('Shipping rule added'); }
            close(); onSaved?.();
          } catch (e) { showFieldErrors(form, e); }
        };
      },
    });
  }

  function quoteDialog(preset = {}) {
    modal({
      title: 'Test a shipping quote',
      body: `<form id="qForm">
        <div class="grid grid--form">
          <div class="field"><label for="q-country">Destination country *</label>
            <select id="q-country" required>${vocabulary.countries.map((c) =>
              `<option value="${esc(c.code)}">${esc(c.name)}</option>`).join('')}</select></div>
          <div class="field"><label for="q-supplier">Supplier</label>
            <select id="q-supplier"><option value="">—</option>
              ${suppliers.map((s) => `<option value="${esc(s.id)}" ${preset.supplierId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
          <div class="field"><label for="q-weight">Weight (kg)</label>
            <input id="q-weight" type="number" step="0.01" min="0" value="0"></div>
          <div class="field"><label for="q-qty">Quantity</label>
            <input id="q-qty" type="number" min="1" value="1"></div>
          <div class="field"><label for="q-subtotal">Order subtotal</label>
            <input id="q-subtotal" type="number" step="0.01" min="0" value="0"></div>
        </div>
        <div id="q-result" style="margin-top:12px"></div></form>`,
      footer: `<button class="btn btn--ghost" data-close>Close</button>
               <button class="btn btn--primary" id="q-run">Get quote</button>`,
      onMount: ({ root }) => {
        qs('#q-run', root).onclick = async () => {
          const host = qs('#q-result', root);
          host.innerHTML = '<div class="spinner"></div>';
          try {
            const { data } = await api.post('/supplier-shipping/quote', {
              country: qs('#q-country', root).value,
              supplierId: qs('#q-supplier', root).value || undefined,
              weightKg: Number(qs('#q-weight', root).value) || 0,
              quantity: Number(qs('#q-qty', root).value) || 1,
              subtotal: Number(qs('#q-subtotal', root).value) || 0,
            });
            host.innerHTML = data.shippable
              ? `<div class="table-wrap"><table class="data"><thead><tr><th>Method</th><th>Carrier</th>
                  <th class="num">Cost</th><th>Estimate</th><th>Scope</th></tr></thead>
                  <tbody>${data.options.map((o) => `<tr><td>${esc(o.methodName)}</td><td>${esc(o.carrier || '—')}</td>
                    <td class="num">${o.freeShipping ? '<span class="badge badge--success">Free</span>' : money(o.cost)}</td>
                    <td>${esc(o.estimate || '—')}</td><td>${esc(titleCase(o.scope))}</td></tr>`).join('')}</tbody></table></div>`
              : `<div class="alert alert--error">${icon('alert')} <strong>Cannot ship here.</strong> ${esc(data.blocked || '')}</div>`;
          } catch (e) { host.innerHTML = `<div class="alert alert--error">${esc(e.message)}</div>`; }
        };
      },
    });
  }
}
