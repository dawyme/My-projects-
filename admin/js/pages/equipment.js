import { api, auth } from '../api.js';
import { setTitle } from '../layout.js';
import { qs, esc, date, emptyState, toast, toastError, confirmDialog } from '../ui.js';

const fields = [
  ['type', 'Equipment type', 'text', true],
  ['brand', 'Brand', 'text', false],
  ['model', 'Model', 'text', false],
  ['serialNumber', 'Serial number', 'text', false],
  ['installDate', 'Install date', 'date', false],
  ['warrantyExp', 'Warranty expiry', 'date', false],
  ['refrigerant', 'Refrigerant', 'text', false],
  ['voltage', 'Voltage', 'text', false],
  ['filterSize', 'Filter size', 'text', false],
  ['location', 'Installed location', 'text', false],
];

export async function render(view) {
  setTitle('Equipment');
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Equipment</h1><p>Register and manage customer equipment, warranty details, and installed assets.</p></div>
      <div class="page-head__actions"><button class="btn btn--primary" id="newEquipment">+ Add equipment</button></div>
    </div>
    <section class="card" id="equipmentEditor" hidden>
      <div class="card__head"><h2 id="equipmentFormTitle">Register equipment</h2></div>
      <div class="card__body">
        <form id="equipmentForm" class="form-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1rem">
          <label>Customer <select name="customerId" id="equipmentCustomer" required><option value="">Loading customers…</option></select></label>
          ${fields.map(([name,label,type,required]) => `<label>${label} ${required?'<span aria-hidden="true">*</span>':''}<input name="${name}" type="${type}" ${required?'required':''} maxlength="160"></label>`).join('')}
          <label style="grid-column:1/-1">Notes <textarea name="notes" rows="3" maxlength="2000"></textarea></label>
          <div style="grid-column:1/-1;display:flex;gap:.5rem;align-items:center">
            <button class="btn btn--primary" type="submit" id="saveEquipment">Save equipment</button>
            <button class="btn btn--ghost" type="button" id="cancelEquipment">Cancel</button>
            <span id="equipmentFormMessage" role="status"></span>
          </div>
        </form>
      </div>
    </section>
    <section class="card">
      <div class="toolbar"><input id="equipmentSearch" class="toolbar__search" type="search" placeholder="Search type, brand, model, serial number or location…"></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Equipment</th><th>Customer</th><th>Serial number</th><th>Location</th><th>Installed</th><th>Warranty expiry</th><th style="text-align:right">Actions</th></tr></thead>
        <tbody id="equipmentRows"><tr><td colspan="7">Loading equipment…</td></tr></tbody>
      </table></div>
    </section>`;

  const form = qs('#equipmentForm', view);
  const editor = qs('#equipmentEditor', view);
  const customerSelect = qs('#equipmentCustomer', view);
  const rows = qs('#equipmentRows', view);
  const message = qs('#equipmentFormMessage', view);
  let equipment = [];
  let editingId = null;

  function resetForm() {
    editingId = null;
    form.reset();
    message.textContent = '';
    qs('#equipmentFormTitle', view).textContent = 'Register equipment';
    qs('#saveEquipment', view).textContent = 'Save equipment';
    customerSelect.disabled = false;
    editor.hidden = true;
  }

  async function loadCustomers() {
    const response = await api.get('/customers', { page: 1, limit: 100, sort: 'name', order: 'asc' });
    const customers = Array.isArray(response?.data) ? response.data : [];
    customerSelect.innerHTML = '<option value="">Select a customer</option>' +
      customers.map(c => `<option value="${esc(c.id)}">${esc(c.name)}${c.phone ? ' — ' + esc(c.phone) : ''}</option>`).join('');
    if (!customers.length) customerSelect.innerHTML = '<option value="">Add a customer first</option>';
  }

  function renderRows() {
    const term = qs('#equipmentSearch', view).value.trim().toLowerCase();
    const filtered = equipment.filter(item => [
      item.type, item.brand, item.model, item.serialNumber, item.location, item.customer?.name,
    ].some(v => String(v || '').toLowerCase().includes(term)));
    rows.innerHTML = filtered.length ? filtered.map(item => `<tr data-id="${esc(item.id)}">
      <td><div class="cell-main">${esc(item.type)}</div><div class="cell-sub">${esc([item.brand,item.model].filter(Boolean).join(' ') || 'Brand/model not recorded')}</div></td>
      <td>${esc(item.customer?.name || 'Customer unavailable')}</td>
      <td>${esc(item.serialNumber || '—')}</td>
      <td>${esc(item.location || '—')}</td>
      <td>${esc(date(item.installDate))}</td>
      <td>${esc(date(item.warrantyExp))}</td>
      <td><div class="row-actions">
        <button class="btn btn--ghost btn--small" data-act="edit">Edit</button>
        ${auth.isAdmin ? '<button class="btn btn--ghost btn--small" data-act="delete">Delete</button>' : ''}
      </div></td></tr>`).join('') : `<tr><td colspan="7">${emptyState(term ? 'No equipment matches your search.' : 'No equipment records yet.', term ? 'Try a different search term.' : 'Use “Add equipment” to register a customer’s AC unit or other equipment.')}</td></tr>`;
  }

  async function loadEquipment() {
    rows.innerHTML = '<tr><td colspan="7">Loading equipment…</td></tr>';
    try {
      const response = await api.get('/equipment', { page: 1, limit: 100, sort: 'createdAt', order: 'desc' });
      equipment = Array.isArray(response?.data) ? response.data : [];
      renderRows();
    } catch (error) {
      rows.innerHTML = `<tr><td colspan="7">${emptyState('Could not load equipment.', error.message)}</td></tr>`;
      toastError(error.message);
    }
  }

  qs('#newEquipment', view).addEventListener('click', async () => {
    resetForm();
    editor.hidden = false;
    try { await loadCustomers(); }
    catch (error) { message.textContent = 'Could not load customers: ' + error.message; toastError(error.message); }
    editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  qs('#cancelEquipment', view).addEventListener('click', resetForm);
  qs('#equipmentSearch', view).addEventListener('input', renderRows);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    for (const key of ['installDate', 'warrantyExp']) if (!data[key]) data[key] = null;
    for (const key of ['brand','model','serialNumber','refrigerant','voltage','filterSize','location','notes']) if (!data[key]) data[key] = null;
    const button = qs('#saveEquipment', view);
    button.disabled = true;
    message.textContent = 'Saving…';
    try {
      if (editingId) await api.put('/equipment/' + encodeURIComponent(editingId), data);
      else await api.post('/equipment', data);
      toast(editingId ? 'Equipment updated' : 'Equipment registered');
      resetForm();
      await loadEquipment();
    } catch (error) {
      message.textContent = error.message;
      toastError(error.message);
    } finally {
      button.disabled = false;
    }
  });

  rows.addEventListener('click', async event => {
    const button = event.target.closest('[data-act]');
    if (!button) return;
    const row = button.closest('tr');
    const item = equipment.find(record => record.id === row?.dataset.id);
    if (!item) return;
    if (button.dataset.act === 'edit') {
      editingId = item.id;
      form.reset();
      await loadCustomers().catch(error => toastError(error.message));
      for (const [key] of fields) form.elements.namedItem(key).value = item[key] ? (key === 'installDate' || key === 'warrantyExp' ? String(item[key]).slice(0,10) : item[key]) : '';
      customerSelect.value = item.customerId;
      customerSelect.disabled = true;
      form.elements.namedItem('notes').value = item.notes || '';
      qs('#equipmentFormTitle', view).textContent = 'Edit equipment';
      qs('#saveEquipment', view).textContent = 'Save changes';
      message.textContent = '';
      editor.hidden = false;
      editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (button.dataset.act === 'delete') {
      if (!await confirmDialog({ title: 'Delete equipment', message: `Delete ${item.type} and its associated service history? This cannot be undone.`, confirmLabel: 'Delete' })) return;
      button.disabled = true;
      try { await api.del('/equipment/' + encodeURIComponent(item.id)); toast('Equipment deleted'); await loadEquipment(); }
      catch (error) { toastError(error.message); button.disabled = false; }
    }
  });

  await Promise.all([loadEquipment(), loadCustomers().catch(() => {})]);
}
