import { api, auth } from '../api.js';
import { setTitle } from '../layout.js';
import {
  el, qs, qsa, icon, esc, money, num, statusBadge, debounce, skeletonRows, emptyState,
  pagination, modal, confirmDialog, formData, showFieldErrors, toast, toastError, titleCase,
} from '../ui.js';

const state = { page: 1, limit: 20, search: '', category: '', featured: '', active: '', lowStock: '', sort: 'createdAt', order: 'desc' };
let categories = [];
let selected = new Set();

export async function render(view, query) {
  setTitle('Products');
  Object.assign(state, { page: 1, search: query.search || '', category: query.category || '', lowStock: query.lowStock || '' });
  selected = new Set();

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Products</h1><p>Manage air conditioners, refrigeration parts, refrigerants and automotive AC stock.</p></div>
      <div class="page-head__actions">
        <button class="btn btn--ghost" id="exportBtn">${icon('download')} Export CSV</button>
        <button class="btn btn--primary" id="newBtn">${icon('plus')} New product</button>
      </div>
    </div>
    <section class="card">
      <div class="toolbar">
        <label class="sr-only" for="searchInput">Search products</label>
        <input id="searchInput" class="toolbar__search" type="search" placeholder="Search by name, SKU or brand…" value="${esc(state.search)}">
        <label class="sr-only" for="catFilter">Filter by category</label>
        <select id="catFilter"><option value="">All categories</option></select>
        <label class="sr-only" for="stockFilter">Filter by stock</label>
        <select id="stockFilter">
          <option value="">All stock levels</option>
          <option value="true" ${state.lowStock === 'true' ? 'selected' : ''}>Low stock only</option>
        </select>
        <label class="sr-only" for="featFilter">Filter by featured</label>
        <select id="featFilter"><option value="">Featured &amp; standard</option><option value="true">Featured only</option><option value="false">Not featured</option></select>
        <label class="sr-only" for="activeFilter">Filter by status</label>
        <select id="activeFilter"><option value="">Any status</option><option value="true">Active</option><option value="false">Archived</option></select>
        <button class="btn btn--subtle btn--sm" id="resetBtn">Reset</button>
      </div>
      <div class="bulkbar" id="bulkbar">
        <span class="bulkbar__count" id="bulkCount">0 selected</span>
        <button class="btn btn--ghost btn--sm" id="bulkEditBtn">${icon('edit')} Bulk edit</button>
        <button class="btn btn--danger btn--sm" id="bulkDeleteBtn" ${auth.isAdmin ? '' : 'disabled title="Administrators only"'}>${icon('trash')} Delete selected</button>
        <button class="btn btn--subtle btn--sm" id="clearSelBtn">Clear</button>
      </div>
      <div class="table-wrap"><table class="data">
        <caption class="sr-only">Product catalogue</caption>
        <thead><tr>
          <th style="width:38px"><input type="checkbox" id="selectAll" aria-label="Select all products on this page"></th>
          <th scope="col" class="sortable" data-sort="name">Product</th>
          <th scope="col">Category</th>
          <th scope="col" class="sortable" data-sort="sku">SKU</th>
          <th scope="col" class="num sortable" data-sort="price">Price</th>
          <th scope="col" class="num sortable" data-sort="quantity">Stock</th>
          <th scope="col">Status</th>
          <th scope="col" style="text-align:right">Actions</th>
        </tr></thead>
        <tbody id="rows">${skeletonRows(8)}</tbody>
      </table></div>
      <div class="card__foot" id="pager"></div>
    </section>`;

  const rows = qs('#rows', view);
  const pager = qs('#pager', view);

  try {
    categories = (await api.get('/categories')).data;
    qs('#catFilter', view).innerHTML = `<option value="">All categories</option>${categories.map((c) =>
      `<option value="${esc(c.id)}" ${state.category === c.id ? 'selected' : ''}>${esc(c.name)} (${c._count.products})</option>`).join('')}`;
  } catch (e) { toastError(e); }

  async function load() {
    rows.innerHTML = skeletonRows(8);
    try {
      const { data, meta } = await api.get('/products', {
        page: state.page, limit: state.limit, search: state.search, category: state.category,
        featured: state.featured, active: state.active, lowStock: state.lowStock, sort: state.sort, order: state.order,
      });
      if (!data.length) {
        rows.innerHTML = `<tr><td colspan="8">${emptyState('No products found',
          state.search || state.category ? 'Try adjusting your search or filters.' : 'Create your first product to get started.')}</td></tr>`;
        pager.innerHTML = '';
        return;
      }
      rows.innerHTML = data.map(rowMarkup).join('');
      pager.innerHTML = '';
      pager.appendChild(pagination(meta, (p) => { state.page = p; load(); }));
      syncSelection();
    } catch (e) {
      rows.innerHTML = `<tr><td colspan="8">${emptyState('Could not load products', e.message)}</td></tr>`;
    }
  }

  function rowMarkup(p) {
    const stockTone = p.quantity === 0 ? 'out' : p.quantity <= p.lowStockLevel ? 'low' : 'ok';
    return `<tr data-id="${esc(p.id)}">
      <td><input type="checkbox" class="rowsel" value="${esc(p.id)}" aria-label="Select ${esc(p.name)}" ${selected.has(p.id) ? 'checked' : ''}></td>
      <td><div class="cell-flex">
        <img class="thumb" src="${esc(p.imageUrl || '../assets/images/placeholder-product.svg')}" alt="" loading="lazy" decoding="async"
             onerror="this.src='../assets/images/placeholder-product.svg'">
        <div><div class="cell-main">${esc(p.name)}${p.featured ? ' <span class="badge badge--purple badge--plain">Featured</span>' : ''}</div>
        <div class="cell-sub">${esc(p.brand || '—')}${p.model ? ` · ${esc(p.model)}` : ''}</div></div></div></td>
      <td>${esc(p.category?.name || '—')}</td>
      <td><code>${esc(p.sku)}</code></td>
      <td class="num">${money(p.price)}</td>
      <td class="num">${num(p.quantity)} ${statusBadge(stockTone, stockTone === 'ok' ? 'OK' : stockTone === 'low' ? 'Low' : 'Out')}</td>
      <td>${p.isActive ? '<span class="badge badge--success">Active</span>' : '<span class="badge badge--muted">Archived</span>'}</td>
      <td><div class="row-actions">
        <button class="btn btn--ghost btn--icon" data-act="edit" aria-label="Edit ${esc(p.name)}">${icon('edit')}</button>
        <button class="btn btn--ghost btn--icon" data-act="image" aria-label="Upload image for ${esc(p.name)}">${icon('upload')}</button>
        <button class="btn btn--ghost btn--icon" data-act="delete" aria-label="Delete ${esc(p.name)}" ${auth.isAdmin ? '' : 'disabled'}>${icon('trash')}</button>
      </div></td></tr>`;
  }

  /* ------------------------------------------------ selection */
  function syncSelection() {
    const bar = qs('#bulkbar', view);
    bar.classList.toggle('show', selected.size > 0);
    qs('#bulkCount', view).textContent = `${selected.size} selected`;
    const boxes = qsa('.rowsel', view);
    qs('#selectAll', view).checked = boxes.length > 0 && boxes.every((b) => selected.has(b.value));
  }
  rows.addEventListener('change', (e) => {
    if (!e.target.classList.contains('rowsel')) return;
    if (e.target.checked) selected.add(e.target.value); else selected.delete(e.target.value);
    syncSelection();
  });
  qs('#selectAll', view).onchange = (e) => {
    qsa('.rowsel', view).forEach((b) => { b.checked = e.target.checked; if (e.target.checked) selected.add(b.value); else selected.delete(b.value); });
    syncSelection();
  };
  qs('#clearSelBtn', view).onclick = () => { selected.clear(); qsa('.rowsel', view).forEach((b) => (b.checked = false)); syncSelection(); };

  /* ------------------------------------------------ filters */
  qs('#searchInput', view).addEventListener('input', debounce((e) => { state.search = e.target.value.trim(); state.page = 1; load(); }));
  qs('#catFilter', view).onchange = (e) => { state.category = e.target.value; state.page = 1; load(); };
  qs('#stockFilter', view).onchange = (e) => { state.lowStock = e.target.value; state.page = 1; load(); };
  qs('#featFilter', view).onchange = (e) => { state.featured = e.target.value; state.page = 1; load(); };
  qs('#activeFilter', view).onchange = (e) => { state.active = e.target.value; state.page = 1; load(); };
  qs('#resetBtn', view).onclick = () => {
    Object.assign(state, { page: 1, search: '', category: '', featured: '', active: '', lowStock: '' });
    qs('#searchInput', view).value = '';
    qsa('.toolbar select', view).forEach((s) => (s.value = ''));
    load();
  };
  qsa('th.sortable', view).forEach((th) => {
    th.onclick = () => {
      const field = th.dataset.sort;
      state.order = state.sort === field && state.order === 'desc' ? 'asc' : 'desc';
      state.sort = field;
      load();
    };
  });
  qs('#exportBtn', view).onclick = () => api.download('/products', { ...state, format: 'csv', limit: 100 }, 'products.csv')
    .then(() => toast('Export downloaded')).catch(toastError);

  /* ------------------------------------------------ row actions */
  rows.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    const act = btn.dataset.act;
    if (act === 'edit') {
      const { data } = await api.get(`/products/${id}`);
      openForm(data);
    } else if (act === 'image') {
      openImageDialog(id);
    } else if (act === 'delete') {
      const name = btn.closest('tr').querySelector('.cell-main').textContent;
      if (!await confirmDialog({ title: 'Delete product', message: `Delete “${name}”? Products with sales history are archived instead.`, confirmLabel: 'Delete' })) return;
      try { const r = await api.del(`/products/${id}`); toast(r.message || 'Product deleted'); selected.delete(id); load(); }
      catch (err) { toastError(err); }
    }
  });

  qs('#newBtn', view).onclick = () => openForm(null);

  /* ------------------------------------------------ create / edit */
  function openForm(product) {
    const isEdit = !!product;
    const specs = (() => { try { return product?.specs ? JSON.parse(product.specs) : {}; } catch { return {}; } })();
    const specText = Object.entries(specs).map(([k, v]) => `${k}: ${v}`).join('\n');

    modal({
      title: isEdit ? `Edit ${product.name}` : 'New product',
      size: 'lg',
      body: `<form id="productForm" novalidate>
        <div class="grid grid--form">
          <div class="field"><label for="pf-name">Product name *</label>
            <input id="pf-name" name="name" required value="${esc(product?.name || '')}" placeholder="12,000 BTU Inverter Split AC"></div>
          <div class="field"><label for="pf-sku">SKU *</label>
            <input id="pf-sku" name="sku" required value="${esc(product?.sku || '')}" placeholder="CA-INV12"></div>
          <div class="field"><label for="pf-cat">Category *</label>
            <select id="pf-cat" name="categoryId" required>${categories.map((c) =>
              `<option value="${esc(c.id)}" ${product?.categoryId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
          <div class="field"><label for="pf-brand">Brand</label>
            <input id="pf-brand" name="brand" value="${esc(product?.brand || '')}"></div>
          <div class="field"><label for="pf-model">Model</label>
            <input id="pf-model" name="model" value="${esc(product?.model || '')}"></div>
          <div class="field"><label for="pf-unit">Unit</label>
            <input id="pf-unit" name="unit" value="${esc(product?.unit || 'unit')}"></div>
          <div class="field"><label for="pf-price">Selling price *</label>
            <input id="pf-price" name="price" type="number" step="0.01" min="0" required value="${product?.price ?? 0}"></div>
          <div class="field"><label for="pf-cost">Cost price</label>
            <input id="pf-cost" name="costPrice" type="number" step="0.01" min="0" value="${product?.costPrice ?? 0}"></div>
          <div class="field"><label for="pf-qty">Quantity in stock</label>
            <input id="pf-qty" name="quantity" type="number" min="0" value="${product?.quantity ?? 0}"></div>
          <div class="field"><label for="pf-low">Low stock threshold</label>
            <input id="pf-low" name="lowStockLevel" type="number" min="0" value="${product?.lowStockLevel ?? 5}"></div>
        </div>
        <div class="field"><label for="pf-desc">Description</label>
          <textarea id="pf-desc" name="description" rows="3">${esc(product?.description || '')}</textarea></div>
        <div class="field"><label for="pf-specs">Specifications</label>
          <textarea id="pf-specs" name="_specs" rows="3" placeholder="Capacity: 12000 BTU&#10;Warranty: 24 months">${esc(specText)}</textarea>
          <span class="hint">One specification per line, formatted as <code>Key: value</code>.</span></div>
        <div style="display:flex;gap:20px;flex-wrap:wrap">
          <label class="checkline"><input type="checkbox" name="featured" ${product?.featured ? 'checked' : ''}> Featured product</label>
          <label class="checkline"><input type="checkbox" name="isActive" ${product?.isActive !== false ? 'checked' : ''}> Active / visible on website</label>
        </div>
      </form>`,
      footer: `<button class="btn btn--ghost" data-close>Cancel</button>
               <button class="btn btn--primary" id="saveProduct">${isEdit ? 'Save changes' : 'Create product'}</button>`,
      onMount: ({ root, close }) => {
        const form = qs('#productForm', root);
        const saveBtn = qs('#saveProduct', root);
        form.addEventListener('submit', (e) => { e.preventDefault(); saveBtn.click(); });
        saveBtn.onclick = async () => {
          const payload = formData(form);
          const specLines = (payload._specs || '').split('\n').map((l) => l.trim()).filter(Boolean);
          delete payload._specs;
          payload.specs = Object.fromEntries(specLines.map((l) => {
            const i = l.indexOf(':');
            return i === -1 ? [l, ''] : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
          }));
          saveBtn.disabled = true;
          saveBtn.innerHTML = '<span class="spinner"></span> Saving…';
          try {
            if (isEdit) await api.put(`/products/${product.id}`, payload);
            else await api.post('/products', payload);
            toast(isEdit ? 'Product updated' : 'Product created');
            close();
            load();
          } catch (err) {
            showFieldErrors(form, err);
            saveBtn.disabled = false;
            saveBtn.textContent = isEdit ? 'Save changes' : 'Create product';
          }
        };
      },
    });
  }

  /* ------------------------------------------------ image upload */
  function openImageDialog(id) {
    modal({
      title: 'Upload product image', size: 'sm',
      body: `<div class="dz" id="dz" role="button" tabindex="0" aria-label="Choose an image to upload">
          ${icon('upload')}<p><strong>Click to choose</strong> or drag an image here</p>
          <p class="hint" style="margin-top:5px">JPG, PNG, WebP, GIF or SVG · max 5MB</p></div>
        <input type="file" id="fileInput" accept="image/*" hidden>
        <div id="previewWrap"></div>`,
      footer: '<button class="btn btn--ghost" data-close>Cancel</button><button class="btn btn--primary" id="uploadBtn" disabled>Upload</button>',
      onMount: ({ root, close }) => {
        const dz = qs('#dz', root);
        const input = qs('#fileInput', root);
        const uploadBtn = qs('#uploadBtn', root);
        let file = null;

        const choose = (f) => {
          if (!f) return;
          if (!f.type.startsWith('image/')) return toast('Please choose an image file', 'error');
          if (f.size > 5 * 1024 * 1024) return toast('Image must be 5MB or smaller', 'error');
          file = f;
          uploadBtn.disabled = false;
          qs('#previewWrap', root).innerHTML = `<img class="preview-img" alt="Selected image preview" src="${URL.createObjectURL(f)}">`;
        };
        dz.onclick = () => input.click();
        dz.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } };
        input.onchange = () => choose(input.files[0]);
        ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
        ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
        dz.addEventListener('drop', (e) => choose(e.dataTransfer.files[0]));

        uploadBtn.onclick = async () => {
          uploadBtn.disabled = true;
          uploadBtn.innerHTML = '<span class="spinner"></span> Uploading…';
          try {
            const fd = new FormData();
            fd.append('image', file);
            await api.upload(`/products/${id}/image`, fd);
            toast('Image uploaded');
            close();
            load();
          } catch (err) { toastError(err); uploadBtn.disabled = false; uploadBtn.textContent = 'Upload'; }
        };
      },
    });
  }

  /* ------------------------------------------------ bulk */
  qs('#bulkDeleteBtn', view).onclick = async () => {
    if (!selected.size) return;
    if (!await confirmDialog({ title: 'Delete products', message: `Delete ${selected.size} product(s)? Items with sales history will be archived instead.`, confirmLabel: 'Delete' })) return;
    try {
      const { data } = await api.post('/products/bulk-delete', { ids: [...selected] });
      toast(`${data.deleted} deleted${data.archived ? `, ${data.archived} archived` : ''}`);
      selected.clear();
      load();
    } catch (e) { toastError(e); }
  };

  qs('#bulkEditBtn', view).onclick = () => {
    if (!selected.size) return;
    modal({
      title: `Bulk edit ${selected.size} product(s)`,
      body: `<p style="margin-top:0;color:var(--text-muted);font-size:13px">Only the fields you fill in are applied — leave the rest blank.</p>
        <form id="bulkForm" novalidate>
          <div class="grid grid--form">
            <div class="field"><label for="bf-cat">Move to category</label>
              <select id="bf-cat" name="categoryId"><option value="">— unchanged —</option>${categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></div>
            <div class="field"><label for="bf-brand">Set brand</label><input id="bf-brand" name="brand" placeholder="— unchanged —"></div>
            <div class="field"><label for="bf-price">Set price</label><input id="bf-price" name="price" type="number" step="0.01" min="0" placeholder="— unchanged —"></div>
            <div class="field"><label for="bf-adjust">Adjust price by %</label><input id="bf-adjust" name="priceAdjustPercent" type="number" step="0.1" placeholder="e.g. 5 or -10"></div>
            <div class="field"><label for="bf-qty">Set quantity</label><input id="bf-qty" name="quantity" type="number" min="0" placeholder="— unchanged —"></div>
            <div class="field"><label for="bf-low">Set low stock level</label><input id="bf-low" name="lowStockLevel" type="number" min="0" placeholder="— unchanged —"></div>
            <div class="field"><label for="bf-feat">Featured</label>
              <select id="bf-feat" name="featured"><option value="">— unchanged —</option><option value="true">Featured</option><option value="false">Not featured</option></select></div>
            <div class="field"><label for="bf-active">Status</label>
              <select id="bf-active" name="isActive"><option value="">— unchanged —</option><option value="true">Active</option><option value="false">Archived</option></select></div>
          </div>
        </form>`,
      footer: '<button class="btn btn--ghost" data-close>Cancel</button><button class="btn btn--primary" id="applyBulk">Apply changes</button>',
      onMount: ({ root, close }) => {
        qs('#applyBulk', root).onclick = async () => {
          const form = qs('#bulkForm', root);
          const updates = {};
          for (const field of form.elements) {
            if (!field.name || field.value === '') continue;
            if (field.name === 'featured' || field.name === 'isActive') updates[field.name] = field.value === 'true';
            else if (field.type === 'number') updates[field.name] = Number(field.value);
            else updates[field.name] = field.value;
          }
          if (!Object.keys(updates).length) return toast('Nothing to update — fill in at least one field', 'warning');
          const btn = qs('#applyBulk', root);
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner"></span> Applying…';
          try {
            const { data } = await api.post('/products/bulk-update', { ids: [...selected], updates });
            toast(`${data.updated} product(s) updated`);
            close();
            load();
          } catch (err) { toastError(err); btn.disabled = false; btn.textContent = 'Apply changes'; }
        };
      },
    });
  };

  await load();
}
