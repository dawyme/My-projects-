import { api, auth } from '../api.js';
import { setTitle } from '../layout.js';
import { esc, toastError } from '../ui.js';
export async function render(view) {
  setTitle('Billing & Subscriptions');
  if (!(auth.user?.role === 'SUPER_ADMIN' || (auth.user?.role === 'ADMIN' && !auth.user?.businessId))) { view.innerHTML='<div class="card"><div class="card__body"><h3>Platform administrators only</h3></div></div>'; return; }
  view.innerHTML='<div class="page-head"><div><h1>Billing & Subscriptions</h1><p>Platform subscription status and tenant plan assignments.</p></div></div><section class="card"><div class="table-wrap"><table class="data"><thead><tr><th>Business</th><th>Plan</th><th>Subscription</th><th>Business status</th></tr></thead><tbody id="rows"><tr><td colspan="4">Loading…</td></tr></tbody></table></div></section>';
  try { const {data}=await api.get('/saas/businesses'); document.querySelector('#rows').innerHTML=data.map(x=>`<tr><td><strong>${esc(x.name)}</strong><div class="cell-sub">${esc(x.slug)}</div></td><td>${esc(x.subscription?.plan?.name||'—')}</td><td>${esc(x.subscription?.status||'No subscription')}</td><td>${esc(x.status||'—')}</td></tr>`).join('') || '<tr><td colspan="4">No tenants yet.</td></tr>'; } catch(e){ toastError(e); }
}
