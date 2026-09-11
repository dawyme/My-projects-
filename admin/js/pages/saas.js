import { api, auth } from '../api.js';
import { setTitle } from '../layout.js';
import { qs, esc, toast, toastError, icon } from '../ui.js';

const planForm = () => `<form id="planForm" class="form-grid">
  <label>Plan name<input name="name" required minlength="2" maxlength="80"></label>
  <label>Slug<input name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" maxlength="60"></label>
  <label>Description<textarea name="description" maxlength="300"></textarea></label>
  <label>Price<input name="price" type="number" min="0" step="0.01" required></label>
  <label>Currency<input name="currency" value="USD" minlength="3" maxlength="3" required></label>
  <label>Interval<select name="interval"><option value="month">Monthly</option><option value="year">Yearly</option></select></label>
  <label>Active<select name="isActive"><option value="true">Active</option><option value="false">Inactive</option></select></label>
  <label>Features (JSON)<textarea name="features">{}</textarea></label>
  <label>Limits (JSON)<textarea name="limits">{}</textarea></label>
  <div class="page-head__actions"><button type="button" class="btn btn--ghost" id="cancelPlan">Cancel</button><button class="btn btn--primary" type="submit">Create plan</button></div>
</form>`;

export async function render(view) {
  setTitle('Tenants & Plans');
  const platform = auth.user?.role === 'SUPER_ADMIN' || (auth.user?.role === 'ADMIN' && !auth.user?.businessId);
  if (!platform) { view.innerHTML='<div class="card"><div class="card__body"><h3>Platform administrators only</h3></div></div>'; return; }
  view.innerHTML=`<div class="page-head"><div><h1>Tenants & Plans</h1><p>Create platform plans and provision, manage, suspend or remove SaaS tenants.</p></div><div class="page-head__actions"><button class="btn btn--ghost" id="newPlan">${icon('plus')} Create plan</button><button class="btn btn--primary" id="newClient">${icon('plus')} Add tenant</button></div></div>
  <section class="card" id="planPanel" hidden><div class="card__head"><h2>Create platform plan</h2></div><div class="card__body">${planForm()}</div></section>
  <div class="grid grid--4" id="stats"></div>
  <section class="card" style="margin-top:16px"><div class="card__head"><h2>Platform plans</h2></div><div class="card__body" id="plans">Loading…</div></section>
  <section class="card" style="margin-top:16px"><div class="card__head"><h2>SaaS tenants</h2></div><div class="table-wrap"><table class="data"><thead><tr><th>Business</th><th>Status</th><th>Plan</th><th>Users</th><th>Customers</th><th>Products</th><th>Actions</th></tr></thead><tbody id="clients"><tr><td colspan="7">Loading…</td></tr></tbody></table></div></section>`;
  const load=async()=>{try{const [o,b,p]=await Promise.all([api.get('/saas/overview'),api.get('/saas/businesses'),api.get('/saas/plans')]);qs('#stats',view).innerHTML=[['Tenants',o.data.businesses],['Active',o.data.activeSubscriptions],['Trials',o.data.trials],['Suspended',o.data.suspendedBusinesses]].map(([l,v])=>`<article class="stat"><div class="stat__label">${esc(l)}</div><div class="stat__value">${esc(v)}</div></article>`).join('');qs('#plans',view).innerHTML=p.data.length?p.data.map(x=>`<div class="list__item"><strong>${esc(x.name)}</strong><span>${esc(x.currency)} ${Number(x.price).toFixed(2)} / ${esc(x.interval)} · ${x.isActive?'Active':'Inactive'}</span></div>`).join(''):'<div class="empty">No plans yet.</div>';qs('#clients',view).innerHTML=b.data.length?b.data.map(x=>`<tr data-id="${esc(x.id)}"><td><strong>${esc(x.name)}</strong><div class="cell-sub">${esc(x.slug)}</div></td><td>${esc(x.status)} · ${esc(x.subscription?.status||'NONE')}</td><td>${esc(x.subscription?.plan?.name||'—')}</td><td>${x.counts?.users??0}</td><td>${x.counts?.customers??0}</td><td>${x.counts?.products??0}</td><td><select data-status aria-label="Change status for ${esc(x.name)}"><option value="">Change status…</option><option value="ACTIVE">Activate</option><option value="SUSPENDED">Suspend</option></select> <button class="btn btn--danger btn--sm" data-remove>Remove</button></td></tr>`).join(''):'<tr><td colspan="7">No SaaS tenants yet.</td></tr>';view._plans=p.data;view._tenants=b.data;}catch(e){toastError(e)}};
  qs('#newPlan',view).onclick=()=>{qs('#planPanel',view).hidden=false;qs('#planForm input[name=name]',view)?.focus()};
  qs('#cancelPlan',view).onclick=()=>{qs('#planPanel',view).hidden=true};
  qs('#planForm',view).onsubmit=async(e)=>{e.preventDefault();const f=new FormData(e.target);let features,limits;try{features=JSON.parse(f.get('features')||'{}');limits=JSON.parse(f.get('limits')||'{}')}catch{toast('Features and limits must be valid JSON');return}try{await api.post('/saas/plans',{name:f.get('name'),slug:f.get('slug'),description:f.get('description')||null,price:Number(f.get('price')),currency:String(f.get('currency')).toUpperCase(),interval:f.get('interval'),features,limits,isActive:f.get('isActive')==='true'});toast('Plan created');e.target.reset();qs('#planPanel',view).hidden=true;await load()}catch(err){toastError(err)}};
  qs('#newClient',view).onclick=()=>openTenant(view);
  qs('#clients',view).addEventListener('change',async e=>{if(!e.target.matches('[data-status]')||!e.target.value)return;const row=e.target.closest('tr');const tenant=view._tenants.find(x=>x.id===row.dataset.id);if(!tenant?.subscription?.plan?.id){toast('Tenant has no subscription plan');return}try{await api.patch(`/saas/businesses/${row.dataset.id}/subscription`,{planId:tenant.subscription.plan.id,status:e.target.value});toast('Tenant status updated');await load()}catch(err){toastError(err)}});
  qs('#clients',view).addEventListener('click',async e=>{if(!e.target.matches('[data-remove]'))return;const row=e.target.closest('tr');if(!confirm(`Remove ${row.querySelector('strong')?.textContent||'this tenant'} from the SaaS platform? Their operational history will be retained and access disabled.`))return;try{await api.del(`/saas/businesses/${row.dataset.id}`);toast('Tenant removed');await load()}catch(err){toastError(err)}});
  await load();
}
function openTenant(view){const plans=view._plans||[];const planId=plans.find(p=>p.isActive)?.id;if(!planId){toast('Create an active plan first');return}const name=prompt('Business name');if(!name)return;const adminName=prompt('Tenant administrator name');if(!adminName)return;const email=prompt('Tenant administrator email');if(!email)return;const password=prompt('Temporary password (8+ chars, letter + number)');if(!password)return;api.post('/saas/businesses',{name,planId,admin:{name:adminName,email,password}}).then(()=>{toast('Tenant provisioned');render(view)}).catch(toastError)}
