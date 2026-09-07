import { api, auth } from '../api.js';
import { setTitle } from '../layout.js';
import { qs, esc, icon, toastError } from '../ui.js';

const platformAdmin = () => auth.user?.role === 'SUPER_ADMIN' || (auth.user?.role === 'ADMIN' && !auth.user?.businessId);

export async function render(view) {
  setTitle('Platform Dashboard');
  if (!platformAdmin()) { view.innerHTML = '<div class="card"><div class="card__body"><h3>Platform administrators only</h3></div></div>'; return; }
  view.innerHTML = `
<div class="page-head"><div><h1>Platform Dashboard</h1><p>Super Admin control center for N&D’S SaaS operations.</p></div><div class="page-head__actions"><a class="btn btn--primary" href="#/saas">${icon('briefcase')} Manage tenants</a></div></div><div class="grid grid--4" id="stats"><div class="card"><div class="card__body">Loading…</div></div></div><div class="grid grid--2" style="margin-top:16px"><section class="card"><div class="card__head"><h2>Platform controls</h2></div><div class="card__body" id="controls"></div></section><section class="card"><div class="card__head"><h2>System status</h2></div><div class="card__body" id="health">Checking…</div></section></div>`;
  try {
    const { data } = await api.get('/saas/overview');
    qs('#stats', view).innerHTML = [['Businesses',data.businesses],['Active subscriptions',data.activeSubscriptions],['Trials',data.trials],['Suspended',data.suspendedBusinesses]].map(([label,value]) => `<article class="stat"><div class="stat__label">${esc(label)}</div><div class="stat__value">${value}</div></article>`).join('');
    qs('#controls',view).innerHTML = `<div class="list"><a class="list__item" href="#/saas">${icon('briefcase')}<span><strong>Tenants & Plans</strong><small>Provision businesses and manage platform plans.</small></span></a><a class="list__item" href="#/users">${icon('user')}<span><strong>Users</strong><small>Manage platform administrator accounts.</small></span></a><a class="list__item" href="#/billing">${icon('money')}<span><strong>Billing & Subscriptions</strong><small>Review subscription status and plan distribution.</small></span></a><a class="list__item" href="#/audit">${icon('shield')}<span><strong>Audit Log</strong><small>Review security-relevant platform activity.</small></span></a><a class="list__item" href="#/settings">${icon('settings')}<span><strong>Platform Settings</strong><small>Manage global application settings.</small></span></a></div>`;
  } catch (e) { toastError(e); }
  try { const r = await fetch('/health'); qs('#health',view).innerHTML = r.ok ? '<div class="alert alert--success">API is healthy and responding.</div>' : '<div class="alert alert--danger">API health check failed.</div>'; } catch { qs('#health',view).innerHTML = '<div class="alert alert--danger">API health check failed.</div>'; }
}
