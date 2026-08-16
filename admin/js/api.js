/**
 * API client for the CoolAir admin dashboard.
 * Handles CSRF, bearer tokens, silent refresh and typed error surfacing.
 */
const API_BASE = (() => {
  const meta = document.querySelector('meta[name="api-base"]');
  if (meta?.content) return meta.content.replace(/\/$/, '');
  // The backend serves both /admin and /api from the same origin, so same-origin
  // is always correct (production, staging and local). Only a file:// preview
  // needs an explicit host; otherwise override with <meta name="api-base">.
  if (location.protocol === 'file:') return 'http://localhost:3001';
  return location.origin;
})();

const STORAGE_KEY = 'nds.auth';

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details || [];
  }
  /** Maps validation issues to { field: message }. */
  get fieldErrors() {
    return Object.fromEntries((this.details || []).map((d) => [d.field, d.message]));
  }
}

export const store = {
  get() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch { return {}; }
  },
  set(patch) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...this.get(), ...patch }));
  },
  clear() { localStorage.removeItem(STORAGE_KEY); },
};

function csrfCookie() {
  const m = document.cookie.match(/(?:^|;\s*)hvac_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

let csrfReady = null;
async function ensureCsrf() {
  if (csrfCookie()) return csrfCookie();
  if (!csrfReady) {
    csrfReady = fetch(`${API_BASE}/api/csrf-token`, { credentials: 'include' })
      .then((r) => r.json()).then((j) => j?.data?.csrfToken).finally(() => { csrfReady = null; });
  }
  return csrfReady;
}

let refreshing = null;
async function refreshSession() {
  if (!refreshing) {
    refreshing = (async () => {
      const token = await ensureCsrf();
      const res = await fetch(`${API_BASE}/api/auth/refresh`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': token || '' },
        body: JSON.stringify({ refreshToken: store.get().refreshToken || undefined }),
      });
      if (!res.ok) throw new ApiError(401, 'Session expired');
      const json = await res.json();
      store.set({ accessToken: json.data.accessToken, refreshToken: json.data.refreshToken, user: json.data.user });
      return json.data.accessToken;
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}

async function request(method, path, { body, query, raw = false, retry = true } = {}) {
  const url = new URL(`${API_BASE}/api${path}`, location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
  }
  const headers = {};
  const token = store.get().accessToken;
  if (token) headers.Authorization = `Bearer ${token}`;

  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }

  if (method !== 'GET') {
    const csrf = await ensureCsrf();
    if (csrf) headers['x-csrf-token'] = csrf;
  }

  const res = await fetch(url, { method, headers, body: payload, credentials: 'include' });

  if (res.status === 401 && retry && store.get().refreshToken) {
    try {
      await refreshSession();
      return request(method, path, { body, query, raw, retry: false });
    } catch { /* fall through to the error below */ }
  }

  if (raw) {
    if (!res.ok) throw new ApiError(res.status, 'Export failed');
    return res.blob();
  }

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }

  if (!res.ok) {
    if (res.status === 401) {
      store.clear();
      if (!location.pathname.endsWith('login.html')) {
        location.href = `login.html?next=${encodeURIComponent(location.hash || '#/')}`;
      }
    }
    throw new ApiError(res.status, json?.error || `Request failed (${res.status})`, json?.details);
  }
  return json;
}

export const api = {
  get: (p, query) => request('GET', p, { query }),
  post: (p, body) => request('POST', p, { body }),
  put: (p, body) => request('PUT', p, { body }),
  patch: (p, body) => request('PATCH', p, { body }),
  del: (p, body) => request('DELETE', p, { body }),
  upload: (p, formData) => request('POST', p, { body: formData }),
  download: async (p, query, filename) => {
    const blob = await request('GET', p, { query, raw: true });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 4000);
  },
  base: API_BASE,
};

export const auth = {
  get user() { return store.get().user || null; },
  get isAdmin() { return this.user?.role === 'ADMIN'; },
  async login(email, password) {
    const json = await request('POST', '/auth/login', { body: { email, password }, retry: false });
    store.set({ accessToken: json.data.accessToken, refreshToken: json.data.refreshToken, user: json.data.user });
    return json.data.user;
  },
  async me() {
    const json = await api.get('/auth/me');
    store.set({ user: json.data.user });
    return json.data.user;
  },
  async logout() {
    try { await api.post('/auth/logout', { refreshToken: store.get().refreshToken }); } catch { /* ignore */ }
    store.clear();
    location.href = 'login.html';
  },
};

/** Redirects to the login page when there is no usable session. */
export async function requireAuth() {
  if (!store.get().accessToken) {
    location.href = `login.html?next=${encodeURIComponent(location.hash || '#/')}`;
    return null;
  }
  try { return await auth.me(); }
  catch {
    store.clear();
    location.href = 'login.html';
    return null;
  }
}
