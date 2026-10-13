import { api } from '../api.js';
import { setTitle } from '../layout.js';
import { qs, esc, money, emptyState, toast, toastError } from '../ui.js';

export async function render(view) {
  setTitle('Invoices');
  view.innerHTML = `<div class="page-head"><div><h1>Invoices</h1><p>Create invoices, track balances and follow the source estimate.</p></div></div>
    <section class="card"><form id="invoiceForm" style="padding:1rem;display:grid;gap:.75rem"><h2>Create invoice</h2>
      <label>Customer <select name="customerId" id="invoiceCustomer" required><option value="">Loading customers…</option></select></label>
      <label>Labour / service description <input name="labourDescription" maxlength="300" placeholder="AC service labour"></label>
      <label>Labour amount <input name="labourAmount" type="number" min="0" step="0.01" value="0" required></label>
      <label>Parts description <input name="partsDescription" maxlength="300" placeholder="Parts and materials"></label>
      <label>Parts amount <input name="partsAmount" type="number" min="0" step="0.01" value="0" required></label>
      <label>Tax rate (%) <input name="taxRate" type="number" min="0" max="100" step="0.01" value="0" required></label>
      <label>Discount (amount) <input name="discount" type="number" min="0" step="0.01" value="0" required></label>
      <label>Due date <input name="dueDate" type="date"></label><label>Notes <textarea name="notes" maxlength="4000" rows="2"></textarea></label>
      <button class="btn btn--primary" type="submit">Create invoice</button><p id="invoiceMessage" role="status"></p></form></section>
    <section class="card"><div class="table-wrap"><table class="data"><thead><tr><th>Invoice</th><th>Customer</th><th>Total</th><th>Status</th><th>Source estimate</th></tr></thead><tbody id="invoiceRows"><tr><td colspan="5">Loading…</td></tr></tbody></table></div></section>`;
  const form=qs('#invoiceForm',view),customer=qs('#invoiceCustomer',view),rows=qs('#invoiceRows',view),msg=qs('#invoiceMessage',view);
  const load=async()=>{const r=await api.get('/invoices');const items=Array.isArray(r?.data)?r.data:[];rows.innerHTML=items.length?items.map(i=>`<tr><td>${esc(i.reference||i.id)}</td><td>${esc(i.customer?.name||'—')}</td><td>${esc(money(i.total||0))}</td><td>${esc(i.status||'—')}</td><td>${i.estimateId?`<a href="#/estimates">${esc(i.estimate?.reference||i.estimateId)}</a>`:'Manual invoice'}</td></tr>`).join(''):`<tr><td colspan="5">${emptyState('No invoices found.')}</td></tr>`;};
  try{const r=await api.get('/customers',{limit:100});const items=Array.isArray(r?.data)?r.data:[];customer.innerHTML='<option value="">Select a customer</option>'+items.map(c=>`<option value="${esc(c.id)}">${esc(c.name)}${c.email?' — '+esc(c.email):''}</option>`).join('');await load();}catch(e){rows.innerHTML=`<tr><td colspan="5">${emptyState('Could not load invoices: '+e.message)}</td></tr>`;toastError(e.message);}
  form.addEventListener('submit',async ev=>{ev.preventDefault();const f=new FormData(form);const ld=String(f.get('labourDescription')||'').trim(),pd=String(f.get('partsDescription')||'').trim();const labour=ld?[{description:ld,quantity:1,unitPrice:Number(f.get('labourAmount'))}]:[];const parts=pd?[{description:pd,quantity:1,unitPrice:Number(f.get('partsAmount'))}]:[];try{await api.post('/invoices',{customerId:f.get('customerId'),labour,parts,taxRate:Number(f.get('taxRate')),discount:Number(f.get('discount')),dueDate:f.get('dueDate')||null,notes:f.get('notes')||null});msg.textContent='Invoice created.';toast('Invoice created');form.reset();await load();}catch(e){msg.textContent=e.message;toastError(e.message);}});
}
