import { api, auth } from '../api.js';
import { setTitle } from '../layout.js';
import { qs, icon, esc, dateTime, initials, formData, showFieldErrors, toast, toastError } from '../ui.js';

export async function render(view) {
  setTitle('My Profile');
  const { data } = await api.get('/auth/me');
  const user = data.user;

  view.innerHTML = `
    <div class="page-head"><div><h1>My Profile</h1><p>Your account details and password.</p></div></div>
    <div class="grid grid--2">
      <section class="card"><div class="card__head"><h2>Account details</h2></div><div class="card__body">
        <div style="display:flex;gap:13px;align-items:center;margin-bottom:18px">
          <span class="avatar avatar--lg">${esc(initials(user.name))}</span>
          <div><div style="font-weight:650">${esc(user.name)}</div>
            <div style="color:var(--text-muted);font-size:13px">${esc(user.email)} · ${esc(user.role)}</div>
            <div style="color:var(--text-soft);font-size:12px">Last sign-in ${esc(user.lastLoginAt ? dateTime(user.lastLoginAt) : '—')}</div></div>
        </div>
        <form id="profileForm" novalidate>
          <div class="field"><label for="pf-name">Full name</label><input id="pf-name" name="name" value="${esc(user.name)}" required></div>
          <div class="field"><label for="pf-phone">Phone</label><input id="pf-phone" name="phone" type="tel" value="${esc(user.phone || '')}"></div>
          <button class="btn btn--primary" id="saveProfile" type="submit">Save profile</button>
        </form>
      </div></section>

      <section class="card"><div class="card__head"><h2>Change password</h2></div><div class="card__body">
        <form id="passwordForm" novalidate>
          <div class="field"><label for="cp-current">Current password</label><input id="cp-current" name="currentPassword" type="password" autocomplete="current-password" required></div>
          <div class="field"><label for="cp-new">New password</label><input id="cp-new" name="newPassword" type="password" autocomplete="new-password" required>
            <span class="hint">At least 8 characters, including a letter and a number.</span></div>
          <div class="field"><label for="cp-confirm">Confirm new password</label><input id="cp-confirm" type="password" autocomplete="new-password" required></div>
          <button class="btn btn--primary" id="savePassword" type="submit">Update password</button>
          <p class="hint" style="margin-top:10px">Changing your password signs you out of every device.</p>
        </form>
      </div></section>

      <section class="card"><div class="card__head"><h2>Sessions</h2></div><div class="card__body">
        <p style="margin-top:0;color:var(--text-muted);font-size:13.5px">Revoke every active refresh token if you suspect your account has been used elsewhere.</p>
        <button class="btn btn--ghost" id="logoutAll">${icon('shield')} Sign out of all devices</button>
      </div></section>
    </div>`;

  qs('#profileForm', view).addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = qs('#saveProfile', view);
    btn.disabled = true;
    try {
      await api.patch('/auth/me', formData(form));
      await auth.me();
      toast('Profile updated');
      location.reload();
    } catch (err) { showFieldErrors(form, err); }
    btn.disabled = false;
  });

  qs('#passwordForm', view).addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    if (form.newPassword.value !== qs('#cp-confirm', view).value) return toast('New passwords do not match', 'error');
    const btn = qs('#savePassword', view);
    btn.disabled = true;
    try {
      await api.post('/auth/change-password', { currentPassword: form.currentPassword.value, newPassword: form.newPassword.value });
      toast('Password updated — please sign in again');
      setTimeout(() => auth.logout(), 1400);
    } catch (err) { showFieldErrors(form, err); btn.disabled = false; }
  });

  qs('#logoutAll', view).onclick = async () => {
    try { await api.post('/auth/logout-all'); toast('All sessions revoked'); setTimeout(() => auth.logout(), 1000); }
    catch (e) { toastError(e); }
  };
}
