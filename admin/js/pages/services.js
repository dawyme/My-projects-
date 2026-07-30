import { api, auth } from '../api.js';
import { setTitle } from '../layout.js';
import { qs, icon, esc, money, num, emptyState, modal, confirmDialog, formData, showFieldErrors, toast, toastError, skeletonRows } from '../ui.js';

export async function render(view) {
  setTitle('Services');
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Services</h1><p>The service catalogue offered for HVAC, refrigeration and automotive AC bookings.</p></div>
      <div class="page-head__actions"><button class="btn btn--primary" id="newBtn">${icon('plus')} New service</button></div>
    </div>
    <section class="card"><div class="table-wrap"><table class="data">
      <caption class="sr-only">Service catalogue</caption>
      <thead><tr><th scope="col">Service</th><th scope="col" class="num">Base price</th><th scope="col" class="num">Duration</th>
        <th scope="col" class="num">Bookings</th><th scope="col">Status</th><th scope="col" style="text-align:right">Actions</th></tr></thead>
      <tbody id="rows">${skeletonRows(6)}</tbody></table></div></section>`;

  const rows = qs('#rows', view);

  async function load() {
    rows.innerHTML = skeletonRows(6);
    try {
      const { data } = await api.get('/services');
      if (!data.length) { rows.innerHTML = `<tr><td colspan="6">${emptyState('No services', 'Add the services your team offers.')}</td></tr>`; return; }
      rows.innerHTML = data.map((s) => `<tr data-id="${esc(s.id)}">
        <td><div class="cell-main">${esc(s.name)}</div><div class="cell-sub">${esc(s.description || '—')}</div></td>
        <td class="num">${money(s.basePrice)}</td>
        <td class="num">${num(s.durationMin)} min</td>
        <td class="num">${num(s._count.bookings)}</td>
        <td>${s.isActive ? '<span class="badge badge--success">Active</span>' : '<span class="badge badge--muted">Inactive</span>'}</td>
        <td><div class="row-actions">
          <button class="btn btn--ghost btn--icon" data-act="edit" aria-label="Edit ${esc(s.name)}">${icon('edit')}</button>
          <button class="btn btn--ghost btn--icon" data-act="delete" aria-label="Delete ${esc(s.name)}" ${auth.isAdmin ? '' : 'disabled'}>${icon('trash')}</button>
        </div></td></tr>`).join('');
    } catch (e) { rows.innerHTML = `<tr><td colspan="6">${emptyState('Could not load services', e.message)}</td></tr>`; }
  }

  rows.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const tr = btn.closest('tr');
    if (btn.dataset.act === 'edit') {
      const { data } = await api.get('/services');
      openForm(data.find((s) => s.id === tr.dataset.id));
    } else {
      if (!await confirmDialog({ title: 'Delete service', message: 'Services used by existing bookings cannot be deleted — deactivate them instead.', confirmLabel: 'Delete' })) return;
      try { await api.del(`/services/${tr.dataset.id}`); toast('Service deleted'); load(); } catch (err) { toastError(err); }
    }
  });
  qs('#newBtn', view).onclick = () => openForm(null);

  function openForm(service) {
    const isEdit = !!service;
    modal({
      title: isEdit ? `Edit ${service.name}` : 'New service',
      body: `<form id="svcForm" novalidate>
        <div class="field"><label for="sf-name">Service name *</label><input id="sf-name" name="name" required value="${esc(service?.name || '')}" placeholder="AC Installation"></div>
        <div class="field"><label for="sf-desc">Description</label><textarea id="sf-desc" name="description" rows="3">${esc(service?.description || '')}</textarea></div>
        <div class="grid grid--form">
          <div class="field"><label for="sf-price">Base price</label><input id="sf-price" name="basePrice" type="number" step="0.01" min="0" value="${service?.basePrice ?? 0}"></div>
          <div class="field"><label for="sf-duration">Duration (minutes)</label><input id="sf-duration" name="durationMin" type="number" min="15" max="1440" value="${service?.durationMin ?? 60}"></div>
        </div>
        <label class="checkline"><input type="checkbox" name="isActive" ${service?.isActive !== false ? 'checked' : ''}> Available for booking</label>
      </form>`,
      footer: `<button class="btn btn--ghost" data-close>Cancel</button><button class="btn btn--primary" id="saveSvc">${isEdit ? 'Save changes' : 'Create service'}</button>`,
      onMount: ({ root, close }) => {
        const form = qs('#svcForm', root);
        const btn = qs('#saveSvc', root);
        form.addEventListener('submit', (e) => { e.preventDefault(); btn.click(); });
        btn.onclick = async () => {
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner"></span> Saving…';
          try {
            const payload = formData(form);
            if (isEdit) await api.put(`/services/${service.id}`, payload); else await api.post('/services', payload);
            toast(isEdit ? 'Service updated' : 'Service created');
            close();
            load();
          } catch (err) { showFieldErrors(form, err); btn.disabled = false; btn.textContent = isEdit ? 'Save changes' : 'Create service'; }
        };
      },
    });
  }

  await load();
}
