import { api, auth } from '../api.js';
import { setTitle } from '../layout.js';
import { qs, icon, esc, num, date, dateTime, statusBadge, initials, emptyState, modal, confirmDialog, formData, showFieldErrors, toast, toastError, skeletonRows } from '../ui.js';

export async function render(view) {
  setTitle('Team');
  if (!auth.isAdmin) {
    view.innerHTML = `<div class="card"><div class="card__body">${emptyState('Administrators only', 'You need an administrator account to manage team members.')}</div></div>`;
    return;
  }

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Team</h1><p>Administrator and staff accounts, roles and technician assignments.</p></div>
      <div class="page-head__actions"><button class="btn btn--primary" id="newBtn">${icon('plus')} New team member</button></div>
    </div>
    <section class="card"><div class="table-wrap"><table class="data">
      <caption class="sr-only">Team members</caption>
      <thead><tr><th scope="col">Member</th><th scope="col">Contact</th><th scope="col">Role</th>
        <th scope="col" class="num">Assigned jobs</th><th scope="col">Last sign-in</th><th scope="col">Status</th>
        <th scope="col" style="text-align:right">Actions</th></tr></thead>
      <tbody id="rows">${skeletonRows(7)}</tbody></table></div></section>`;

  const rows = qs('#rows', view);

  async function load() {
    rows.innerHTML = skeletonRows(7);
    try {
      const { data } = await api.get('/users');
      rows.innerHTML = data.map((u) => `<tr data-id="${esc(u.id)}">
        <td><div class="cell-flex"><span class="avatar">${esc(initials(u.name))}</span>
          <div><div class="cell-main">${esc(u.name)}</div><div class="cell-sub">Joined ${esc(date(u.createdAt))}</div></div></div></td>
        <td><div>${esc(u.email)}</div><div class="cell-sub">${esc(u.phone || '—')}</div></td>
        <td>${statusBadge(u.role)}</td>
        <td class="num">${num(u._count.bookings)}</td>
        <td>${esc(u.lastLoginAt ? dateTime(u.lastLoginAt) : 'Never')}</td>
        <td>${u.isActive ? '<span class="badge badge--success">Active</span>' : '<span class="badge badge--muted">Disabled</span>'}</td>
        <td><div class="row-actions">
          <button class="btn btn--ghost btn--icon" data-act="edit" aria-label="Edit ${esc(u.name)}">${icon('edit')}</button>
          <button class="btn btn--ghost btn--icon" data-act="delete" aria-label="Delete ${esc(u.name)}">${icon('trash')}</button>
        </div></td></tr>`).join('');
    } catch (e) { rows.innerHTML = `<tr><td colspan="7">${emptyState('Could not load team', e.message)}</td></tr>`; }
  }

  rows.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    if (btn.dataset.act === 'edit') {
      const { data } = await api.get('/users');
      openForm(data.find((u) => u.id === id));
    } else {
      if (!await confirmDialog({ title: 'Delete team member', message: 'Their bookings will be left unassigned.', confirmLabel: 'Delete' })) return;
      try { await api.del(`/users/${id}`); toast('Team member deleted'); load(); } catch (err) { toastError(err); }
    }
  });
  qs('#newBtn', view).onclick = () => openForm(null);

  function openForm(user) {
    const isEdit = !!user;
    modal({
      title: isEdit ? `Edit ${user.name}` : 'New team member',
      body: `<form id="userForm" novalidate><div class="grid grid--form">
          <div class="field"><label for="uf-name">Full name *</label><input id="uf-name" name="name" required value="${esc(user?.name || '')}"></div>
          <div class="field"><label for="uf-email">Email *</label><input id="uf-email" name="email" type="email" required value="${esc(user?.email || '')}"></div>
          <div class="field"><label for="uf-phone">Phone</label><input id="uf-phone" name="phone" type="tel" value="${esc(user?.phone || '')}"></div>
          <div class="field"><label for="uf-role">Role *</label><select id="uf-role" name="role">
            <option value="STAFF" ${user?.role === 'STAFF' ? 'selected' : ''}>Staff — day-to-day operations</option>
            <option value="ADMIN" ${user?.role === 'ADMIN' ? 'selected' : ''}>Administrator — full access</option></select></div>
        </div>
        <div class="field"><label for="uf-password">${isEdit ? 'New password (leave blank to keep current)' : 'Password *'}</label>
          <input id="uf-password" name="password" type="password" autocomplete="new-password" ${isEdit ? '' : 'required'}>
          <span class="hint">Minimum 8 characters, including at least one letter and one number.</span></div>
        ${isEdit ? `<label class="checkline"><input type="checkbox" name="isActive" ${user.isActive ? 'checked' : ''}> Account is active</label>` : ''}
      </form>`,
      footer: `<button class="btn btn--ghost" data-close>Cancel</button><button class="btn btn--primary" id="saveUser">${isEdit ? 'Save changes' : 'Create account'}</button>`,
      onMount: ({ root, close }) => {
        const form = qs('#userForm', root);
        const btn = qs('#saveUser', root);
        form.addEventListener('submit', (e) => { e.preventDefault(); btn.click(); });
        btn.onclick = async () => {
          const payload = formData(form);
          if (isEdit && !payload.password) delete payload.password;
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner"></span> Saving…';
          try {
            if (isEdit) await api.put(`/users/${user.id}`, payload); else await api.post('/users', payload);
            toast(isEdit ? 'Team member updated' : 'Account created');
            close();
            load();
          } catch (err) { showFieldErrors(form, err); btn.disabled = false; btn.textContent = isEdit ? 'Save changes' : 'Create account'; }
        };
      },
    });
  }

  await load();
}
