import { api } from '../api.js';
import { esc, toastError } from '../ui.js';

function selectorLabel(item, fallback = 'Unnamed') {
  if (item?.name) return item.name;
  if (item?.type) return [item.type, item.brand, item.model].filter(Boolean).join(' — ');
  return item?.email || fallback;
}

function createSelector(root, { searchId, optionsId, hiddenName, placeholder, onSelect, remoteSearch, emptyText = 'No matches found' }) {
  const input = root.querySelector(`#${searchId}`);
  const options = root.querySelector(`#${optionsId}`);
  const hidden = root.querySelector(`[name="${hiddenName}"]`);
  let items = [];
  let requestToken = 0;

  const close = () => { options.hidden = true; input.setAttribute('aria-expanded', 'false'); };
  const choose = (item) => {
    hidden.value = item?.id || '';
    input.value = item ? selectorLabel(item) : '';
    close();
    onSelect?.(item || null);
  };
  const render = (matches) => {
    options.innerHTML = matches.length
      ? matches.map((item) => `<button type="button" class="rm-selector__option" role="option" data-id="${esc(item.id)}">${esc(selectorLabel(item))}${item.email ? ` <span>${esc(item.email)}</span>` : ''}</button>`).join('')
      : `<div class="rm-selector__empty">${esc(emptyText)}</div>`;
    options.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    options.querySelectorAll('[data-id]').forEach((button) => {
      button.onclick = () => choose(items.find((item) => item.id === button.dataset.id));
    });
  };
  const setItems = (next) => { items = Array.isArray(next) ? next : []; if (!options.hidden && document.activeElement === input) render(items); };
  const setLoading = () => { options.innerHTML = '<div class="rm-selector__empty">Searching…</div>'; options.hidden = false; input.setAttribute('aria-expanded', 'true'); };
  const filterLocal = (query) => {
    const q = query.trim().toLowerCase();
    return q ? items.filter((item) => selectorLabel(item).toLowerCase().includes(q) || String(item.email || '').toLowerCase().includes(q)) : items;
  };
  input.addEventListener('focus', () => { if (!input.disabled) render(filterLocal(input.value)); });
  input.addEventListener('input', async () => {
    hidden.value = '';
    onSelect?.(null);
    const q = input.value.trim();
    if (!q) return render(items);
    render(filterLocal(q));
    if (!remoteSearch) return;
    const token = ++requestToken;
    setLoading();
    try { const result = await remoteSearch(q); if (token === requestToken) setItems(result); }
    catch (error) { if (token === requestToken) { options.innerHTML = `<div class="rm-selector__empty">${esc(error.message)}</div>`; options.hidden = false; } }
  });
  input.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
  document.addEventListener('click', (event) => { if (!root.contains(event.target)) close(); });
  input.placeholder = placeholder || input.placeholder;
  return { setItems, choose, clear: () => choose(null), close };
}


export async function render(view) {
  view.innerHTML = `<div class="page-head"><div><h1>Recurring Maintenance</h1><p>Schedule preventive maintenance and keep customers reminded. This core feature is available on every plan.</p></div></div>
    <div id="maintenanceList"><div class="card"><div class="card__body"><div class="spinner"></div></div></div></div>
    <div class="card" style="margin-top:16px"><div class="card__body"><h2>Schedule next maintenance</h2>
      <form id="recurringMaintenanceForm" class="form-grid">
        <div class="field" data-selector="customer"><label for="rm-customer-search">Customer *</label><div class="rm-selector"><input id="rm-customer-search" type="search" autocomplete="off" placeholder="Search customer…" aria-controls="rm-customer-options" aria-expanded="false" required><input name="customerId" type="hidden"><div id="rm-customer-options" class="rm-selector__options" role="listbox" hidden></div></div></div>
        <div class="field" data-selector="equipment"><label for="rm-equipment-search">Equipment</label><div class="rm-selector"><input id="rm-equipment-search" type="search" autocomplete="off" placeholder="Select a customer first" aria-controls="rm-equipment-options" aria-expanded="false" disabled><input name="equipmentId" type="hidden"><div id="rm-equipment-options" class="rm-selector__options" role="listbox" hidden></div></div></div>
        <div class="field" data-selector="service"><label for="rm-service-search">Service</label><div class="rm-selector"><input id="rm-service-search" type="search" autocomplete="off" placeholder="Search service…" aria-controls="rm-service-options" aria-expanded="false"><input name="serviceId" type="hidden"><div id="rm-service-options" class="rm-selector__options" role="listbox" hidden></div></div></div>
        <div class="field" data-selector="technician"><label for="rm-technician-search">Technician</label><div class="rm-selector"><input id="rm-technician-search" type="search" autocomplete="off" placeholder="Search technician…" aria-controls="rm-technician-options" aria-expanded="false"><input name="technicianId" type="hidden"><div id="rm-technician-options" class="rm-selector__options" role="listbox" hidden></div></div></div>
        <label>First appointment<input name="startDate" type="datetime-local" required></label>
        <label>Repeat every<select name="intervalMonths"><option value="1">1 month</option><option value="2">2 months</option><option value="3" selected>3 months</option><option value="6">6 months</option><option value="12">12 months</option></select></label>
        <label>Reminder offsets<input name="reminderOffsets" value="30,7,1,0" aria-label="Reminder offsets in days"></label>
        <div><button class="btn btn--primary" type="submit">Schedule maintenance</button></div>
      </form><p id="maintenanceMessage" class="muted" aria-live="polite"></p>
    </div></div>`;

  const list = view.querySelector('#maintenanceList');
  const message = view.querySelector('#maintenanceMessage');
  async function load() {
    try {
      const { data } = await api.get('/recurring-maintenance');
      const rows = data || [];
      list.innerHTML = rows.length ? rows.map((s) => `<article class="card"><div class="card__body">
        <div class="badge">${esc(s.status)}</div><h2>${esc(s.serviceLabel || s.service?.name || 'Preventive maintenance')}</h2>
        <p>${esc(s.customer?.name || 'Customer')} · every ${esc(s.intervalMonths)} month(s)</p>
        <p>Next: ${s.nextOccurrenceAt ? esc(new Date(s.nextOccurrenceAt).toLocaleString()) : '—'} · Technician: ${esc(s.technician?.name || 'Unassigned')}</p>
        <div class="actions">
          <button class="btn" data-action="pause" data-id="${esc(s.id)}" ${s.status !== 'ACTIVE' ? 'disabled' : ''}>Pause</button>
          <button class="btn" data-action="resume" data-id="${esc(s.id)}" ${s.status !== 'PAUSED' ? 'disabled' : ''}>Resume</button>
          <button class="btn btn--danger" data-action="cancel" data-id="${esc(s.id)}" ${['CANCELLED','COMPLETED'].includes(s.status) ? 'disabled' : ''}>Cancel</button>
          <button class="btn btn--danger" data-action="delete" data-id="${esc(s.id)}" title="Permanently delete this recurring maintenance test schedule">Delete</button>
        </div>
      </div></article>`).join('') : '<div class="card"><div class="card__body">No recurring maintenance schedules yet.</div></div>';
      list.querySelectorAll('[data-action]').forEach((button) => button.onclick = async () => {
        if (button.dataset.action === 'delete' && !window.confirm('Delete this recurring maintenance schedule permanently? Generated appointments for this schedule will also be removed. Completed historical records are protected.')) return;
        button.disabled = true;
        try {
          if (button.dataset.action === 'delete') await api.del(`/recurring-maintenance/${button.dataset.id}`);
          else await api.post(`/recurring-maintenance/${button.dataset.id}/${button.dataset.action}`, {});
          await load();
        }
        catch (error) { button.disabled = false; toastError(error.message); }
      });
    } catch (error) { list.innerHTML = `<div class="card"><div class="card__body">${esc(error.message)}</div></div>`; }
  }

  const customerRoot = view.querySelector('[data-selector="customer"] .rm-selector');
  const equipmentRoot = view.querySelector('[data-selector="equipment"] .rm-selector');
  const serviceRoot = view.querySelector('[data-selector="service"] .rm-selector');
  const technicianRoot = view.querySelector('[data-selector="technician"] .rm-selector');
  const equipmentInput = equipmentRoot.querySelector('#rm-equipment-search');
  const serviceInput = serviceRoot.querySelector('#rm-service-search');
  const technicianInput = technicianRoot.querySelector('#rm-technician-search');

  async function searchCustomers(query) { const { data } = await api.get('/customers', { search: query, page: 1, limit: 100 }); return data || []; }
  let selectedCustomerId = null;
  async function searchEquipment(query = '') {
    if (!selectedCustomerId) return [];
    const { data } = await api.get('/equipment', { customerId: selectedCustomerId, search: query, page: 1, limit: 100 });
    return data || [];
  }
  const customerSelector = createSelector(customerRoot, { searchId: 'rm-customer-search', optionsId: 'rm-customer-options', hiddenName: 'customerId', placeholder: 'Search customer…', remoteSearch: searchCustomers, onSelect: async (customer) => {
    selectedCustomerId = customer?.id || null;
    equipmentSelector.clear();
    equipmentInput.disabled = !customer;
    equipmentInput.placeholder = customer ? 'Search equipment…' : 'Select a customer first';
    if (!customer) return;
    const data = await searchEquipment();
    equipmentSelector.setItems(data);
  } });
  const equipmentSelector = createSelector(equipmentRoot, { searchId: 'rm-equipment-search', optionsId: 'rm-equipment-options', hiddenName: 'equipmentId', placeholder: 'Select a customer first', remoteSearch: searchEquipment });
  const serviceSelector = createSelector(serviceRoot, { searchId: 'rm-service-search', optionsId: 'rm-service-options', hiddenName: 'serviceId', placeholder: 'Search service…' });
  const technicianSelector = createSelector(technicianRoot, { searchId: 'rm-technician-search', optionsId: 'rm-technician-options', hiddenName: 'technicianId', placeholder: 'Search technician…' });

  const [{ data: initialCustomers }, { data: services }, { data: users }] = await Promise.all([
    api.get('/customers', { page: 1, limit: 100 }), api.get('/services'), api.get('/users'),
  ]);
  customerSelector.setItems(initialCustomers || []);
  serviceSelector.setItems(services || []);
  technicianSelector.setItems((users || []).filter((user) => user.role === 'STAFF' && user.isActive));

  view.querySelector('#recurringMaintenanceForm').onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api.post('/recurring-maintenance', {
        customerId: form.get('customerId'), equipmentId: form.get('equipmentId') || null,
        serviceId: form.get('serviceId') || null, technicianId: form.get('technicianId') || null,
        startDate: new Date(form.get('startDate')).toISOString(), intervalMonths: Number(form.get('intervalMonths')),
        reminderOffsets: String(form.get('reminderOffsets')).split(',').map((value) => Number(value.trim())).filter(Number.isFinite),
      });
      message.textContent = 'Maintenance schedule created.'; event.currentTarget.reset(); customerSelector.clear(); equipmentSelector.clear(); serviceSelector.clear(); technicianSelector.clear(); equipmentInput.disabled = true; equipmentInput.placeholder = 'Select a customer first'; await load();
    } catch (error) { message.textContent = error.message; }
  };
  await load();
}
