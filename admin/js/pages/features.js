import { api, auth } from '../api.js';
import { setTitle } from '../layout.js';
import { qs, esc, toast, toastError, icon } from '../ui.js';

const form = (feature = null) => `<form id="featureForm" class="form-grid">
  <input type="hidden" name="id" value="${esc(feature?.id || '')}">
  <label>Feature name<input name="name" value="${esc(feature?.name || '')}" required minlength="2" maxlength="100"></label>
  <label>Feature key<input name="key" value="${esc(feature?.key || '')}" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" maxlength="80"></label>
  <label>Description<textarea name="description" maxlength="500">${esc(feature?.description || '')}</textarea></label>
  <label>Active<select name="isActive"><option value="true" ${feature?.isActive !== false ? 'selected' : ''}>Active</option><option value="false" ${feature?.isActive === false ? 'selected' : ''}>Inactive</option></select></label>
  <label>Core platform feature<select name="isCore"><option value="false" ${feature?.isCore !== true ? 'selected' : ''}>No — tenant access can be controlled</option><option value="true" ${feature?.isCore === true ? 'selected' : ''}>Yes — always available</option></select></label>
  <label>Default access<select name="defaultEnabled"><option value="false" ${feature?.defaultEnabled !== true ? 'selected' : ''}>Disabled for new tenants</option><option value="true" ${feature?.defaultEnabled === true ? 'selected' : ''}>Enabled for new tenants</option></select></label>
  <div class="page-head__actions"><button type="button" class="btn btn--ghost" id="cancelFeature">Cancel</button><button class="btn btn--primary" type="submit">${feature ? 'Save changes' : 'Add feature'}</button></div>
</form>`;

export async function render(view) {
  setTitle('Feature Management');
  const platform = auth.isAdmin;
  if (!platform) { view.innerHTML='<div class="card"><div class="card__body"><h3>Platform administrators only</h3></div></div>'; return; }
  view.innerHTML = `<div class="page-head"><div><h1>Feature Management</h1><p>Add platform features and control which SaaS tenants can use them.</p></div><button class="btn btn--primary" id="newFeature">${icon('plus')} Add feature</button></div>
    <section class="card" id="featurePanel" hidden><div class="card__head"><h2 id="featurePanelTitle">Add platform feature</h2></div><div class="card__body" id="featurePanelBody">${form()}</div></section>
    <section class="card"><div class="card__head"><h2>Platform features</h2></div><div class="table-wrap"><table class="data"><thead><tr><th>Feature</th><th>Category</th><th>Default</th><th>Core</th><th>Status</th><th>Tenant access</th><th>Actions</th></tr></thead><tbody id="features"><tr><td colspan="7">Loading…</td></tr></tbody></table></div></section>`;

  const load = async () => {
    try {
      const response = await api.get('/saas/features');
      view._features = response.data || [];
      qs('#features', view).innerHTML = view._features.length ? view._features.map((feature) => {
        const enabled = feature.tenants.filter((t) => t.enabled).length;
        const tenantControls = feature.tenants.length ? feature.tenants.map((tenant) => `<label style="display:inline-flex;align-items:center;gap:5px;margin:3px 10px 3px 0"><input type="checkbox" data-tenant-toggle data-feature-id="${esc(feature.id)}" data-business-id="${esc(tenant.id)}" ${tenant.enabled ? 'checked' : ''} ${feature.isCore ? 'disabled' : ''}>${esc(tenant.name)}</label>`).join('') : '<span class="cell-sub">No customer tenants</span>';
        return `<tr data-feature-id="${esc(feature.id)}"><td><strong>${esc(feature.name)}</strong><div class="cell-sub">${esc(feature.key)}${feature.description ? ` · ${esc(feature.description)}` : ''}</div></td><td>${esc(feature.category || 'Platform')}</td><td>${feature.defaultEnabled ? 'Enabled' : 'Disabled'}</td><td>${feature.isCore ? 'Yes' : 'No'}</td><td>${feature.isActive ? 'Active' : 'Inactive'}</td><td>${enabled}/${feature.tenants.length}<div style="margin-top:5px">${tenantControls}</div></td><td><button class="btn btn--ghost btn--sm" data-edit-feature="${esc(feature.id)}">Edit</button> <button class="btn btn--danger btn--sm" data-remove-feature="${esc(feature.id)}" ${feature.isActive ? '' : 'disabled'}>Remove</button></td></tr>`;
      }).join('') : '<tr><td colspan="7">No platform features registered.</td></tr>';
    } catch (e) { toastError(e); }
  };

  const bindForm = () => {
    qs('#cancelFeature', view).onclick = () => { qs('#featurePanel', view).hidden = true; };
    qs('#featureForm', view).onsubmit = async (event) => {
      event.preventDefault(); const f = new FormData(event.target); const id = f.get('id');
      const payload = { key:f.get('key'), name:f.get('name'), description:f.get('description') || null, isActive:f.get('isActive') === 'true', isCore:f.get('isCore') === 'true', defaultEnabled:f.get('defaultEnabled') === 'true' };
      try { if (id) { await api.patch(`/saas/features/${id}`, payload); toast('Feature updated'); } else { await api.post('/saas/features', payload); toast('Feature added'); } qs('#featurePanel', view).hidden = true; await load(); } catch (e) { toastError(e); }
    };
  };
  qs('#newFeature', view).onclick = () => { qs('#featurePanel', view).hidden = false; qs('#featurePanelTitle', view).textContent = 'Add platform feature'; qs('#featurePanelBody', view).innerHTML = form(); bindForm(); };
  qs('#features', view).addEventListener('click', async (event) => {
    const edit = event.target.closest('[data-edit-feature]');
    if (edit) { const feature = view._features.find((f) => f.id === edit.dataset.editFeature); qs('#featurePanel', view).hidden = false; qs('#featurePanelTitle', view).textContent = `Edit ${feature.name}`; qs('#featurePanelBody', view).innerHTML = form(feature); bindForm(); return; }
    const remove = event.target.closest('[data-remove-feature]');
    if (remove && confirm('Remove this feature from the platform? Existing tenant access will be retained for audit history but the feature will become unavailable.')) { try { await api.del(`/saas/features/${remove.dataset.removeFeature}`); toast('Feature removed'); await load(); } catch (e) { toastError(e); } }
  });
  qs('#features', view).addEventListener('change', async (event) => {
    const toggle = event.target.closest('[data-tenant-toggle]'); if (!toggle) return;
    try { await api.patch(`/saas/features/${toggle.dataset.featureId}/access/${toggle.dataset.businessId}`, { enabled: toggle.checked }); toast(toggle.checked ? 'Feature enabled for tenant' : 'Feature disabled for tenant'); await load(); }
    catch (e) { toggle.checked = !toggle.checked; toastError(e); }
  });
  bindForm(); await load();
}
