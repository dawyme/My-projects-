import { api, auth } from '../api.js';
import { setTitle } from '../layout.js';
import { qs, esc, toast, toastError, icon } from '../ui.js';

export async function render(view) {
  setTitle('SaaS / Clients');
  if (auth.user?.businessId) { view.innerHTML='<div class="card"><div class="card__body"><h3>Platform administrators only</h3></div></div>'; return; }
  view.innerHTML=`<div class="page-head"><div><h1>SaaS / Clients</h1><p>Provision businesses, assign plans and manage subscriptions.</p></div><button class="btn btn--primary" id="newClient">${icon('plus')} New client</button></div><div class="grid grid--4" id="stats"></div><section class="card"><div class="table-wrap"><table class="data"><thead><tr><th>Business</th><th>Status</th><th>Plan</th><th>Users</th><th>Customers</th><th>Products</th><th>Actions</th></tr></thead><tbody id="clients"><tr><td colspan="7">Loading…</td></tr></tbody></table></div></section>`;
  async function load(){ try { const [o,b,p]=await Promise.all([api.get('/saas/overview'),api.get('/saas/businesses'),api.get('/saas/plans')]); qs('#stats',view).innerHTML=[['Businesses',o.data.businesses],['Active',o.data.activeSubscriptions],['Trials',o.data.trials],['Suspended',o.data.suspendedBusinesses]].map(x=>`<div class="card"><div class="card__body"><div class="cell-sub">${x[0]}</div><div style="font-size:28px;font-weight:700">${x[1]}</div></div></div>`).join(''); qs('#clients',view).innerHTML=b.data.map(x=>`<tr data-id="${esc(x.id)}"><td><strong>${esc(x.name)}</strong><div class="cell-sub">${esc(x.slug)}</div></td><td>${esc(x.status)}</td><td>${esc(x.subscription?.plan?.name||'—')} · ${esc(x.subscription?.status||'—')}</td><td>${x.counts?.users??0}</td><td>${x.counts?.customers??0}</td><td>${x.counts?.products??0}</td><td><select data-plan><option value="">Change status…</option><option value="ACTIVE">Activate</option><option value="SUSPENDED">Suspend</option></select></td></tr>`).join(''); view._plans=p.data; } catch(e){toastError(e)} }
  qs('#newClient',view).onclick=()=>openClient(view);
  qs('#clients',view).addEventListener('change',async e=>{if(!e.target.matches('[data-plan]')||!e.target.value)return;const row=e.target.closest('tr');const client=(await api.get('/saas/businesses')).data.find(x=>x.id===row.dataset.id);try{await api.patch(`/saas/businesses/${row.dataset.id}/subscription`,{planId:client.subscription?.plan?.id||view._plans[0].id,status:e.target.value});toast('Subscription updated');load()}catch(err){toastError(err)}});
  await load();
}

function openClient(view){
  const plans=view._plans||[]; const name=prompt('Business name'); if(!name)return; const adminName=prompt('First administrator name'); if(!adminName)return; const email=prompt('Administrator email'); if(!email)return; const password=prompt('Temporary password (8+ chars, letter + number)'); if(!password)return; const planId=plans[0]?.id; if(!planId){toast('No active plan configured');return;}
  api.post('/saas/businesses',{name,planId,admin:{name:adminName,email,password}}).then(()=>{toast('Client provisioned');render(view)}).catch(toastError);
}
