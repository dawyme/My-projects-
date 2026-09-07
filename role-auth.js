import { auth, store } from '/admin/js/api.js';

const destinations = {
  SUPER_ADMIN: '/superadmin/',
  TENANT_ADMIN: '/tenant/',
  TECHNICIAN: '/technician/',
  CUSTOMER: '/customer/',
  ADMIN: '/admin/',
  STAFF: '/admin/',
};

export function roleHome(role) {
  return destinations[role] || '/login.html';
}

export async function requireRole(requiredRole) {
  if (!store.get().accessToken) {
    location.replace(`/login.html?next=${encodeURIComponent(location.pathname + location.search)}`);
    return null;
  }
  try {
    const user = await auth.me();
    if (user.role !== requiredRole) {
      location.replace(roleHome(user.role));
      return null;
    }
    return user;
  } catch {
    store.clear();
    location.replace('/login.html');
    return null;
  }
}

export async function signOut() {
  await auth.logout();
}
