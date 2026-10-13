import { api } from '../api.js';
import { setTitle } from '../layout.js';
import { qs, esc, money, emptyState, toast, toastError } from '../ui.js';

export async function render(view) {
  setTitle('Estimates');
  view.innerHTML = `<div class="page-head"><div><h1>Estimates</h1><p>Create customer estimates and convert approved work to invoices.</p></div></div>
    <section class="card"><form id="estimateForm" class="form-grid" style="padding:1rem;display:grid;gap:.75rem">
      <h2>Create estimate</h2><label>Customer <select name="customerId" required id="estimateCustomer"><option value="">Loading customers…</option></select></label>
      <label>Labour / service description <input name="labourDescription" maxlength="300" placeholder="AC service labour"></label>
      <label>Labour amount <input name="labourAmount" type="number" min="0" step="0.01" value="0" required></label>
      <label>Parts description <input name="partsDescription" maxlength="300" placeholder="Parts and materials"></label>
      <label>Parts amount <input name="partsAmount" type="number" min="0" step="0.01" value="0" required></label>
      <label>Tax rate (%) <input name="taxRate" type="number" min="0" max="100" step="0.01" value="0" required></label>
      <label>Discount (amount) <input name="discount" type="number" min="0" step="0.01" value="0" required></label>
      <label>Notes <textarea name="notes" maxlength="4000" rows="2"></textarea></label>
      <button class="btn btn--primary" type="submit">Create estimate</button><p id="estimateMessage" role="status"></p>
    </form></section>
    <section class="card"><div class="table-wrap"><table class="data"><thead><tr><th>Estimate</th><th>Customer</th><th>Total</th><th>Status</th><th>Actions</th></tr></thead><tbody id="estimateRows"><tr><td colspan="5">Loading…</td></tr></tbody></table></div></section>`;
  const form=qs('#estimateForm',view), customer=qs('#estimateCustomer',view), rows=qs('#estimateRows',view), msg=qs('#estimateMessage',view);
  const load=async()=>{const r=await api.get('/estimates');const items=Array.isArray(r?.data)?r.data:[];rows.innerHTML=items.length?items.map(e=>`<tr><td>${esc(e.reference||e.id)}</td><td>${esc(e.customer?.name||'—')}</td><td>${esc(money(e.total||0))}</td><td>${esc(e.status||'—')}</td><td>${e.status==='CANCELLED'||e.status==='DECLINED'||e.status==='EXPIRED'?'—':`<button class="btn btn--small btn--primary" data-convert="${esc(e.id)}">Convert to invoice</button>`}</td></tr>`).join(''):`<tr><td colspan="5">${emptyState('No estimates found.')}</td></tr>`;};
  try {const r=await api.get('/customers',{limit:100});const items=Array.isArray(r?.data)?r.data:[];customer.innerHTML='<option value="">Select a customer</option>'+items.map(c=>`<option value="${esc(c.id)}">${esc(c.name)}${c.email?' — '+esc(c.email):''}</option>`).join('');await load();}catch(e){rows.innerHTML=`<tr><td colspan="5">${emptyState('Could not load estimates: '+e.message)}</td></tr>`;toastError(e.message);}
  form.addEventListener('submit',async ev=>{ev.preventDefault();const f=new FormData(form);const labourDesc=String(f.get('labourDescription')||'').trim(),partsDesc=String(f.get('partsDescription')||'').trim();const labour=labourDesc?[{description:labourDesc,quantity:1,unitPrice:Number(f.get('labourAmount'))}]:[];const parts=partsDesc?[{description:partsDesc,quantity:1,unitPrice:Number(f.get('partsAmount'))}]:[];try{await api.post('/estimates',{customerId:f.get('customerId'),labour,parts,taxRate:Number(f.get('taxRate')),discount:Number(f.get('discount')),notes:f.get('notes')||null});msg.textContent='Estimate created.';toast('Estimate created');form.reset();await load();}catch(e){msg.textContent=e.message;toastError(e.message);}});
  rows.addEventListener('click',async ev=>{const b=ev.target.closest('[data-convert]');if(!b)return;b.disabled=true;try{const r=await api.post(`/estimates/${encodeURIComponent(b.dataset.convert)}/convert`,{});toast(r.message||'Invoice ready');await load();}catch(e){toastError(e.message);}finally{b.disabled=false;}});
}
