import { api } from '../api.js';
import { setTitle } from '../layout.js';
import { esc, money, toast, toastError } from '../ui.js';

const moneySafe = (value, currency) => {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(value || 0)); }
  catch { return `${currency} ${Number(value || 0).toFixed(2)}`; }
};

function planCard(plan, currentId) {
  const features = Object.entries(plan.features || {}).filter(([, v]) => v).map(([k]) => k.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase()));
  const limits = Object.entries(plan.limits || {}).map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1')}: ${v}`);
  const current = plan.id === currentId;
  return `<article class="card" style="height:100%;display:flex;flex-direction:column">
    <div class="card__head"><div><h3>${esc(plan.name)}</h3><p>${esc(plan.description || 'Platform plan')}</p></div>${current ? '<span class="badge badge--success">Current</span>' : ''}</div>
    <div class="card__body" style="flex:1">
      <div style="font-size:28px;font-weight:700">${moneySafe(plan.price, plan.currency)} <span style="font-size:13px;font-weight:500">/ ${esc(plan.interval)}</span></div>
      ${features.length ? `<ul style="margin:18px 0 8px;padding-left:20px">${features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
      ${limits.length ? `<div style="margin-top:12px;font-size:13px;opacity:.8">${limits.map((l) => `<div>${esc(l)}</div>`).join('')}</div>` : ''}
    </div>
    <div class="card__foot"><button class="btn ${current ? '' : 'btn--primary'}" data-plan="${esc(plan.id)}" ${current ? 'disabled' : ''}>${current ? 'Current plan' : 'Choose plan'}</button></div>
  </article>`;
}

export async function render(view) {
  setTitle('Plans & Subscription');
  view.innerHTML = `<div class="page-head"><div><h1>Plans & Subscription</h1><p>Manage your business subscription. Platform plans are managed by N&D’S Super Admin.</p></div></div><div id="tenantSummary" class="grid" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin-bottom:22px"></div><div id="tenantPlans" class="grid" style="grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:18px"><div class="card"><div class="card__body">Loading plans…</div></div></div>`;
  try {
    const [{ data: overview }, { data: plans }] = await Promise.all([api.get('/tenant/overview'), api.get('/tenant/plans')]);
    const s = overview.subscription;
    document.querySelector('#tenantSummary').innerHTML = [
      ['Business', overview.name], ['Customers', overview._count.customers], ['Team', overview._count.users],
      ['Bookings', overview._count.bookings], ['Orders', overview._count.orders], ['Plan', s?.plan?.name || 'Not subscribed'],
    ].map(([label, value]) => `<div class="card"><div class="card__body"><div style="font-size:12px;opacity:.7">${esc(label)}</div><div style="font-size:20px;font-weight:700;margin-top:5px">${esc(String(value))}</div></div></div>`).join('');
    document.querySelector('#tenantPlans').innerHTML = plans.length ? plans.map((p) => planCard(p, s?.planId)).join('') : '<div class="card"><div class="card__body">No active plans are available.</div></div>';
    document.querySelectorAll('[data-plan]').forEach((button) => {
      button.onclick = async () => {
        button.disabled = true;
        try {
          await api.post('/tenant/subscription', { planId: button.dataset.plan });
          toast('Subscription updated');
          await render(view);
        } catch (e) { button.disabled = false; toastError(e.message || 'Could not update subscription'); }
      };
    });
  } catch (e) {
    toastError(e.message || 'Could not load subscription');
    document.querySelector('#tenantPlans').innerHTML = `<div class="card"><div class="card__body"><div class="empty"><h3>Could not load plans</h3><p>${esc(e.message || 'Unexpected error')}</p></div></div></div>`;
  }
}
