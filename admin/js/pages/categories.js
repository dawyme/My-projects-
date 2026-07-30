import { api, auth } from '../api.js';
import { setTitle } from '../layout.js';
import { qs, icon, esc, num, date, emptyState, modal, confirmDialog, formData, showFieldErrors, toast, toastError, skeletonRows } from '../ui.js';

export async function render(view) {
  setTitle('Categories');
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Categories</h1><p>Product groupings used across the catalogue and public website.</p></div>
      <div class="page-head__actions"><button class="btn btn--primary" id="newBtn">${icon('plus')} New category</button></div>
    </div>
    <section class="card"><div class="table-wrap"><table class="data">
      <caption class="sr-only">Product categories</caption>
      <thead><tr><th scope="col">Category</th><th scope="col">Slug</th><th scope="col" class="num">Products</th>
        <th scope="col" class="num">Sort order</th><th scope="col">Created</th><th scope="col" style="text-align:right">Actions</th></tr></thead>
      <tbody id="rows">${skeletonRows(6)}</tbody></table></div></section>`;

  const rows = qs('#rows', view);

  async function load() {
    rows.innerHTML = skeletonRows(6);
    try {
      const { data } = await api.get('/categories');
      if (!data.length) { rows.innerHTML = `<tr><td colspan="6">${emptyState('No categories', 'Create a category before adding products.')}</td></tr>`; return; }
      rows.innerHTML = data.map((c) => `<tr data-id="${esc(c.id)}">
        <td><div class="cell-main">${esc(c.name)}</div><div class="cell-sub">${esc(c.description || '—')}</div></td>
        <td><code>${esc(c.slug)}</code></td>
        <td class="num">${num(c._count.products)}</td>
        <td class="num">${num(c.sortOrder)}</td>
        <td>${esc(date(c.createdAt))}</td>
        <td><div class="row-actions">
          <button class="btn btn--ghost btn--icon" data-act="edit" aria-label="Edit ${esc(c.name)}">${icon('edit')}</button>
          <button class="btn btn--ghost btn--icon" data-act="delete" aria-label="Delete ${esc(c.name)}" ${auth.isAdmin ? '' : 'disabled'}>${icon('trash')}</button>
        </div></td></tr>`).join('');
    } catch (e) { rows.innerHTML = `<tr><td colspan="6">${emptyState('Could not load categories', e.message)}</td></tr>`; }
  }

  rows.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    if (btn.dataset.act === 'edit') {
      const { data } = await api.get(`/categories/${id}`);
      openForm(data);
    } else {
      if (!await confirmDialog({ title: 'Delete category', message: 'Categories that still contain products cannot be deleted.', confirmLabel: 'Delete' })) return;
      try { await api.del(`/categories/${id}`); toast('Category deleted'); load(); } catch (err) { toastError(err); }
    }
  });
  qs('#newBtn', view).onclick = () => openForm(null);

  function openForm(category) {
    const isEdit = !!category;
    modal({
      title: isEdit ? `Edit ${category.name}` : 'New category',
      body: `<form id="catForm" novalidate>
        <div class="field"><label for="kf-name">Name *</label><input id="kf-name" name="name" required value="${esc(category?.name || '')}" placeholder="Air Conditioners"></div>
        <div class="field"><label for="kf-desc">Description</label><textarea id="kf-desc" name="description" rows="3">${esc(category?.description || '')}</textarea></div>
        <div class="field"><label for="kf-sort">Sort order</label><input id="kf-sort" name="sortOrder" type="number" min="0" value="${category?.sortOrder ?? 0}"></div>
      </form>`,
      footer: `<button class="btn btn--ghost" data-close>Cancel</button><button class="btn btn--primary" id="saveCat">${isEdit ? 'Save changes' : 'Create category'}</button>`,
      onMount: ({ root, close }) => {
        const form = qs('#catForm', root);
        const btn = qs('#saveCat', root);
        form.addEventListener('submit', (e) => { e.preventDefault(); btn.click(); });
        btn.onclick = async () => {
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner"></span> Saving…';
          try {
            const payload = formData(form);
            if (isEdit) await api.put(`/categories/${category.id}`, payload); else await api.post('/categories', payload);
            toast(isEdit ? 'Category updated' : 'Category created');
            close();
            load();
          } catch (err) { showFieldErrors(form, err); btn.disabled = false; btn.textContent = isEdit ? 'Save changes' : 'Create category'; }
        };
      },
    });
  }

  await load();
}
