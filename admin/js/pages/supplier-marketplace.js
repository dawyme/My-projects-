/** Supplier Marketplace → Dashboard: the section's landing overview. */
import { api, auth } from '../api.js';
import { setTitle } from '../layout.js';
import {
  el, qs, icon, esc, money, num, statusBadge, skeletonRows, emptyState,
  relative, toast, toastError,
} from '../ui.js';
import { sectionHead } from './supplier-nav.js';

export async function render(view) {
  setTitle('Supplier Marketplace');

  view.innerHTML = `
    ${sectionHead({
      title: 'Supplier Marketplace',
      subtitle: 'Supplier catalogues, connectors, synchronisation and worldwide dropship fulfilment.',
      active: '/supplier-marketplace',
      actions: `<a class="btn btn--ghost" href="#/suppliers">${icon('warehouse')} Suppliers</a>
                <a class="btn btn--primary" href="#/supplier-integrations">${icon('plug')} Add integration</a>`,
    })}
    <div class="grid grid--stats" id="stats"><div class="card"><div class="card__body"><div class="spinner"></div></div></div></div>
    <div class="grid grid--2">
      <section class="card">
        <div class="card__head"><h2>Recent synchronisations</h2>
          <a class="btn btn--ghost btn--sm" href="#/supplier-logs">All logs</a></div>
        <div class="card__body card__body--flush"><div class="table-wrap"><table class="data">
          <thead><tr><th>Supplier</th><th>Type</th><th>Trigger</th><th>Status</th><th>Records</th><th>When</th></tr></thead>
          <tbody id="syncRows">${skeletonRows(6, 5)}</tbody></table></div></div>
      </section>
      <section class="card">
        <div class="card__head"><h2>Connector availability</h2></div>
        <div class="card__body" id="connectors"><div class="spinner"></div></div>
      </section>
    </div>
    <section class="card">
      <div class="card__head"><h2>Start here</h2></div>
      <div class="card__body"><ol class="timeline" id="workflow"></ol></div>
    </section>`;

  const statsEl = qs('#stats', view);
  const syncRows = qs('#syncRows', view);
  const connectorsEl = qs('#connectors', view);

  try {
    const { data } = await api.get('/suppliers/stats');
    paintSyncs(data);
    statsEl.innerHTML = [
      statTile('warehouse', 'Suppliers', num(data.suppliers.active), `${num(data.suppliers.total)} total · ${num(data.suppliers.disabled)} disabled`),
      statTile('plug', 'Connected integrations', `${num(data.integrations.connected)}/${num(data.integrations.total)}`,
        data.integrations.notConnected ? `${num(data.integrations.notConnected)} need credentials` : 'All integrations connected',
        data.integrations.notConnected ? 'warning' : 'success'),
      statTile('box', 'Supplier products', num(data.products.total),
        `${num(data.products.published)} published · ${num(data.products.unmapped)} unmapped`,
        data.products.unmapped ? 'warning' : 'info'),
      statTile('layers', 'Supplier stock', num(data.inventory.supplierUnits),
        `${money(data.inventory.supplierCostValue)} at cost`),
      statTile('truck', 'Fulfilments', num(data.fulfillment.total),
        `${num(data.fulfillment.pending)} pending · ${num(data.fulfillment.shipped)} shipped`,
        data.fulfillment.failed ? 'danger' : 'info'),
      statTile('globe', 'Shipping rules', num(data.shipping.activeRules), 'Active destination rules'),
    ].join('');

    const security = await api.get('/supplier-settings');
    if (!security.data.security.dedicatedCredentialKey) {
      statsEl.insertAdjacentHTML('afterend', `<div class="alert alert--info" style="margin-top:12px">
        ${icon('shield')} Supplier credentials are encrypted with the JWT secret. Set
        <code>SUPPLIER_CREDENTIALS_KEY</code> for a dedicated encryption key before connecting live suppliers.
        <a href="#/supplier-settings">Marketplace Settings</a></div>`);
    }
  } catch (e) {
    statsEl.innerHTML = `<div class="card"><div class="card__body">${emptyState('Could not load marketplace stats', e.message)}</div></div>`;
    paintSyncs(null, e.message);
  }

  function paintSyncs(data, errorMessage) {
    if (errorMessage) {
      syncRows.innerHTML = `<tr><td colspan="6">${emptyState('Could not load recent syncs', errorMessage)}</td></tr>`;
      return;
    }
    const list = data?.recentSyncs || [];
    if (!list.length) {
      syncRows.innerHTML = `<tr><td colspan="6">${emptyState('No synchronisations yet',
        'Add a supplier, configure its connector, then run a sync.')}</td></tr>`;
      return;
    }
    syncRows.innerHTML = list.map((s) => `<tr>
      <td><div class="cell-main">${esc(s.supplier?.name || '—')}</div><div class="cell-sub">${esc(s.supplier?.code || '')}</div></td>
      <td>${esc(s.type)}</td><td>${esc(s.trigger.toLowerCase())}</td>
      <td>${statusBadge(s.status)}</td>
      <td class="num">${num(s.processed)}${s.errorCount ? ` <span class="badge badge--danger">${num(s.errorCount)} err</span>` : ''}</td>
      <td>${relative(s.startedAt)}</td></tr>`).join('');
  }

  try {
    const { data } = await api.get('/suppliers/connectors');
    connectorsEl.innerHTML = data.map((c) => `<div class="list-card" style="margin-bottom:10px">
      <div class="list-card__head">
        <span class="cell-main">${esc(c.label)}</span>
        <span class="badge badge--${c.installed ? 'success' : 'warning'}">${c.installed ? 'Ready' : 'Runtime required'}</span>
      </div>
      <div class="list-card__body">
        <div class="cell-sub">${esc(c.description)}</div>
        <div style="margin-top:6px"><span class="badge badge--plain badge--info">${esc(c.transport)}</span>
          ${c.formats.map((f) => `<span class="badge badge--plain badge--muted">${esc(f)}</span>`).join('')}</div>
        <div class="cell-sub" style="margin-top:6px">${c.capabilities.filter((x) => x.supported).length}/${c.capabilities.length} capabilities</div>
      </div></div>`).join('');
  } catch (e) {
    connectorsEl.innerHTML = emptyState('Could not load connectors', e.message);
  }

  qs('#workflow', view).innerHTML = [
    ['warehouse', 'Add a supplier', 'Name, country, trade, countries served and fulfilment method.', '#/suppliers'],
    ['plug', 'Choose a connector', 'REST/JSON, GraphQL, CSV, XML, JSON feed, SFTP or manual email.', '#/supplier-integrations'],
    ['shield', 'Enter credentials', 'Encrypted at rest and masked in the UI — never sent back to the browser.', '#/supplier-integrations'],
    ['check', 'Test the connection', 'A real request to the supplier. Nothing is marked connected until it passes.', '#/supplier-integrations'],
    ['upload', 'Import the catalogue', 'Preview NEW / UPDATED / UNCHANGED / ERRORS before anything is written.', '#/supplier-imports'],
    ['percent', 'Configure pricing', 'Product → Category → Supplier → Global markup precedence.', '#/supplier-settings'],
    ['globe', 'Configure shipping', 'Countries, methods, costs, estimates and restricted-goods rules.', '#/supplier-shipping'],
    ['refresh', 'Enable sync', 'Scheduled or on-demand product, stock and price synchronisation.', '#/supplier-sync'],
    ['box', 'Publish products', 'Publish into the existing storefront catalogue — no second product system.', '#/supplier-products'],
    ['truck', 'Fulfil orders', 'Dropship the supplier-fulfilled remainder of each order, with tracking.', '#/supplier-fulfillment'],
  ].map(([ic, title, body, href], i) => `<li>
    <div class="timeline__icon">${icon(ic)}</div>
    <div class="timeline__body"><strong>${i + 1}. ${esc(title)}</strong>
      <div class="cell-sub">${esc(body)}</div>
      <a href="${href}" style="font-size:12.5px">Open →</a></div></li>`).join('');
}

function statTile(iconName, label, value, sub, tone = 'info') {
  return `<div class="card"><div class="card__body"><div class="stat">
    <div class="stat__top"><div class="stat__icon i-${tone}">${icon(iconName)}</div>
      <div class="stat__label">${esc(label)}</div></div>
    <div class="stat__value">${value}</div>
    <div class="stat__meta">${esc(sub)}</div></div></div></div>`;
}
