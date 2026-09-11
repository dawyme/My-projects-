/** Renders the sidebar/topbar shell, theme toggle and hash router. */
import { api, auth, requireAuth } from './api.js';
import { el, qs, icon, esc, initials, setCurrency, toast, toastError } from './ui.js';

const NAV = [
  { group: 'Overview', items: [
    { path: '/', label: 'Dashboard', icon: 'dashboard' },
    { path: '/analytics', label: 'Analytics', icon: 'chart', platformOnly: true },
    { path: '/analytics', label: 'Reports', icon: 'chart', tenantOnly: true },
  ] },
  { group: 'Catalogue', items: [
    { path: '/products', label: 'Products', icon: 'box' },
    { path: '/categories', label: 'Categories', icon: 'tag' },
    { path: '/inventory', label: 'Inventory', icon: 'layers', badge: 'lowStock' },
  ] },
  { group: 'Operations', items: [
    { path: '/bookings', label: 'Service Bookings', icon: 'calendar', badge: 'pending' },
    { path: '/calendar', label: 'Calendar', icon: 'clock' },
    { path: '/dispatch', label: 'Dispatch Board', icon: 'truck' },
    { path: '/services', label: 'Services', icon: 'wrench' },
    { path: '/equipment', label: 'Equipment', icon: 'settings' },
    { path: '/service-history', label: 'Service History', icon: 'history' },
    { path: '/recurring-maintenance', label: 'Recurring Maintenance', icon: 'calendar', feature: 'recurring-maintenance' },
    { path: '/estimates', label: 'Estimates', icon: 'file' },
    { path: '/invoices', label: 'Invoices', icon: 'file' },
    { path: '/orders', label: 'Orders', icon: 'file' },
    { path: '/pos', label: 'Point of Sale', icon: 'cart' },
  ] },
  { group: 'People', items: [
    { path: '/customers', label: 'Customers', icon: 'users' },
    { path: '/messages', label: 'Messages', icon: 'mail', badge: 'unread' },
  ] },
  { group: 'Supplier Marketplace', items: [
    { path: '/supplier-marketplace', label: 'Marketplace Dashboard', icon: 'dashboard' },
    { path: '/suppliers', label: 'Suppliers', icon: 'warehouse' },
    { path: '/supplier-integrations', label: 'Integrations / Plugins', icon: 'plug' },
    { path: '/supplier-imports', label: 'Import Products', icon: 'upload' },
    { path: '/supplier-products', label: 'Supplier Products', icon: 'box' },
    { path: '/supplier-fulfillment', label: 'Fulfillment', icon: 'truck' },
    { path: '/supplier-shipping', label: 'Shipping', icon: 'globe' },
    { path: '/supplier-sync', label: 'Sync & Automation', icon: 'refresh' },
    { path: '/supplier-logs', label: 'Sync Logs', icon: 'history' },
    { path: '/supplier-settings', label: 'Marketplace Settings', icon: 'settings' },
  ] },
  { group: 'Platform', items: [
    { path: '/platform', label: 'Platform Dashboard', icon: 'dashboard', platformOnly: true },
    { path: '/saas', label: 'Tenants & Plans', icon: 'briefcase', platformOnly: true },
    { path: '/features', label: 'Feature Management', icon: 'settings', platformOnly: true },
    { path: '/platform-analytics', label: 'Platform Analytics', icon: 'chart', platformOnly: true },
    { path: '/billing', label: 'Billing & Subscriptions', icon: 'money', platformOnly: true },
    { path: '/system-health', label: 'System Health', icon: 'shield', platformOnly: true },
    { path: '/subscription', label: 'Plans & Subscription', icon: 'briefcase', tenantOnly: true },
  ] },
  { group: 'Administration', items: [
    { path: '/settings', label: 'Settings', icon: 'settings' },
    { path: '/users', label: 'Team', icon: 'user' },
    { path: '/audit', label: 'Audit Log', icon: 'shield', adminOnly: true },
  ] },
  { group: 'Website', items: [
    { path: '/content', label: 'Website Content', icon: 'edit' },
    { path: '/media', label: 'Media Library', icon: 'image' },
  ] },
];

/* ------------------------------------------------------------ theme */
export function applyTheme(theme) {
  const value = theme || localStorage.getItem('nds.theme')
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = value;
  localStorage.setItem('nds.theme', value);
  const btn = qs('#themeToggle');
  if (btn) {
    btn.innerHTML = icon(value === 'dark' ? 'sun' : 'moon');
    btn.setAttribute('aria-label', value === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  }
  document.dispatchEvent(new CustomEvent('themechange', { detail: value }));
  return value;
}
applyTheme();

/* ------------------------------------------------------------ shell */
export const badges = { pending: 0, unread: 0, lowStock: 0 };

function navMarkup(user) {
  return NAV.map((group) => {
    const isPlatform = user.role === 'SUPER_ADMIN' || (user.role === 'ADMIN' && !user.businessId);
    const isTenant = user.role === 'TENANT_ADMIN' || (user.role === 'ADMIN' && !!user.businessId);
    const featureAccess = new Set((user.featureAccess || []).map((f) => f.key));
    const items = group.items.filter((i) => (!i.feature || featureAccess.has(i.feature)) && (!i.adminOnly || user.role === 'ADMIN' || isPlatform) && (!i.platformOnly || isPlatform) && (!i.tenantOnly || isTenant));
    if (!items.length) return '';
    const groupId = `nav-group-${NAV.indexOf(group)}`;
    return `<section class="nav-group">
      <button type="button" class="nav-group__toggle" aria-expanded="false" aria-controls="${groupId}">
        <span class="nav-group__label">${esc(group.group)}</span><span class="nav-group__chevron" aria-hidden="true">⌄</span>
      </button>
      <div class="nav-group__items" id="${groupId}" hidden>
        ${items.map((i) => `<a class="nav-link" href="#${i.path}" data-path="${i.path}">
          ${icon(i.icon)}<span>${esc(i.label)}</span>${i.badge ? `<span class="nav-link__badge" data-badge="${i.badge}" hidden>0</span>` : ''}</a>`).join('')}
      </div>
    </section>`;
  }).join('');
}

export function renderShell(user) {
  const root = qs('#app');
  if (!root) return;
  root.innerHTML = `<div class="app-shell">
    <aside class="sidebar" id="sidebar" aria-label="Main navigation">
      <div class="sidebar__brand"><a href="#/" aria-label="N&D'S Admin"><span class="brand-mark">N&D'S</span><span class="brand-text">HVAC · Refrigeration</span></a></div>
      <nav class="sidebar__nav">${navMarkup(user)}</nav>
      <div class="sidebar__footer"><a href="#/profile" class="nav-link">${icon('user')}<span>Profile</span></a><button class="nav-link nav-link--button" id="logoutBtn">${icon('logout')}<span>Sign out</span></button></div>
    </aside>
    <main class="main"><header class="topbar"><button class="icon-btn menu-toggle" id="menuToggle" aria-label="Toggle navigation" aria-expanded="false">${icon('menu')}</button><div class="topbar__title"><h1 id="pageTitle">Dashboard</h1><p id="pageSubtitle"></p></div><div class="topbar__actions"><button class="icon-btn" id="themeToggle" aria-label="Toggle theme"></button><div class="user-menu"><button class="user-menu__trigger" id="userMenuTrigger" aria-expanded="false"><span class="avatar">${esc(initials(user.name))}</span><span class="user-menu__text"><strong>${esc(user.name)}</strong><small>${esc(user.role)}</small></span></button><div class="user-menu__dropdown" id="userMenuDropdown" hidden><a href="#/profile">Profile</a><button id="logoutMenuBtn">Sign out</button></div></div></div></header><div class="main__content" id="view"></div></main></div>`;
  bindShell();
  applyTheme();
}

function bindShell() {
  const sidebar = qs('#sidebar');
  const toggleBtn = qs('#menuToggle');
  const closeNav = () => { sidebar?.classList.remove('is-open'); toggleBtn?.setAttribute('aria-expanded', 'false'); };
  toggleBtn?.addEventListener('click', () => { const open = sidebar.classList.toggle('is-open'); toggleBtn.setAttribute('aria-expanded', String(open)); });
  sidebar?.addEventListener('click', (e) => {
    const toggle = e.target.closest('.nav-group__toggle');
    if (toggle) {
      const group = toggle.closest('.nav-group');
      const items = group?.querySelector('.nav-group__items');
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!expanded));
      if (items) items.hidden = expanded;
    }
    if (e.target.closest('.nav-link') && innerWidth <= 1024) closeNav();
  });
  qs('#themeToggle')?.addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  const userMenuTrigger = qs('#userMenuTrigger');
  const dropdown = qs('#userMenuDropdown');
  userMenuTrigger?.addEventListener('click', () => { const open = !dropdown.hidden; dropdown.hidden = open; userMenuTrigger.setAttribute('aria-expanded', String(!open)); });
  const logout = async () => {
    try { await api.post('/auth/logout', {}); } catch (_) {}
    auth.clear(); window.location.href = '/login.html';
  };
  qs('#logoutBtn')?.addEventListener('click', logout);
  qs('#logoutMenuBtn')?.addEventListener('click', logout);
}

/* ------------------------------------------------------------ router */
const routes = {
  '/': () => import('./pages/dashboard.js'),
  '/analytics': () => import('./pages/analytics.js'),
  '/products': () => import('./pages/products.js'),
  '/categories': () => import('./pages/categories.js'),
  '/inventory': () => import('./pages/inventory.js'),
  '/bookings': () => import('./pages/bookings.js'),
  '/calendar': () => import('./pages/calendar.js'),
  '/dispatch': () => import('./pages/dispatch.js'),
  '/services': () => import('./pages/services.js'),
  '/equipment': () => import('./pages/equipment.js'),
  '/service-history': () => import('./pages/service-history.js'),
  '/recurring-maintenance': () => import('./pages/recurring-maintenance.js'),
  '/estimates': () => import('./pages/estimates.js'),
  '/invoices': () => import('./pages/invoices.js'),
  '/orders': () => import('./pages/orders.js'),
  '/pos': () => import('./pages/pos.js'),
  '/customers': () => import('./pages/customers.js'),
  '/messages': () => import('./pages/messages.js'),
  '/settings': () => import('./pages/settings.js'),
  '/users': () => import('./pages/users.js'),
  '/audit': () => import('./pages/audit.js'),
  '/saas': () => import('./pages/saas.js'),
  '/features': () => import('./pages/features.js'),
  '/platform': () => import('./pages/superadmin.js'),
  '/platform-analytics': () => import('./pages/platform-analytics.js'),
  '/billing': () => import('./pages/billing.js'),
  '/system-health': () => import('./pages/system-health.js'),
  '/subscription': () => import('./pages/subscription.js'),
  '/profile': () => import('./pages/profile.js'),
  '/content': () => import('./pages/content.js'),
  '/media': () => import('./pages/media.js'),
  '/supplier-marketplace': () => import('./pages/supplier-marketplace.js'),
  '/suppliers': () => import('./pages/suppliers.js'),
  '/supplier-integrations': () => import('./pages/supplier-integrations.js'),
  '/supplier-imports': () => import('./pages/supplier-imports.js'),
  '/supplier-products': () => import('./pages/supplier-products.js'),
  '/supplier-fulfillment': () => import('./pages/supplier-fulfillment.js'),
  '/supplier-shipping': () => import('./pages/supplier-shipping.js'),
  '/supplier-sync': () => import('./pages/supplier-sync.js'),
  '/supplier-logs': () => import('./pages/supplier-logs.js'),
  '/supplier-settings': () => import('./pages/supplier-settings.js'),
};

export function setTitle(title) {
  const node = qs('#pageTitle');
  if (node) node.textContent = title;
  document.title = `${title} · N&D'S Admin`;
}

export function highlightNav(path) {
  document.querySelectorAll('.nav-group').forEach((group) => {
    const active = group.querySelector(`.nav-link[data-path="${path}"]`);
    const toggle = group.querySelector('.nav-group__toggle');
    const items = group.querySelector('.nav-group__items');
    const isActiveGroup = !!active;
    if (toggle && items) {
      toggle.setAttribute('aria-expanded', String(isActiveGroup));
      items.hidden = !isActiveGroup;
    }
    group.querySelectorAll('.nav-link').forEach((link) => {
      if (link.dataset.path === path) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  });
}

export async function refreshBadges() {
  try {
    const { data } = await api.get('/dashboard/stats');
    badges.pending = data.bookings.pending;
    badges.unread = data.messages.unread;
    badges.lowStock = data.inventory.lowStockCount;
    for (const [key, value] of Object.entries(badges)) {
      document.querySelectorAll(`[data-badge="${key}"]`).forEach((n) => {
        n.textContent = value > 99 ? '99+' : value;
        n.hidden = !value;
      });
    }
    const dot = document.querySelector('#bellBtn .icon-btn__dot');
    if (dot) dot.hidden = !badges.unread;
    return data;
  } catch { return null; }
}

function parseHash() {
  const raw = location.hash.slice(1) || '/';
  const [path, queryString] = raw.split('?');
  return { path: path || '/', query: Object.fromEntries(new URLSearchParams(queryString || '')) };
}

let currentToken = 0;
async function renderRoute() {
  const token = ++currentToken;
  const { path, query } = parseHash();
  const view = qs('#view');
  const loader = routes[path];

  if (!loader) {
    view.innerHTML = `<div class="card"><div class="card__body">
      <div class="empty">${icon('alert')}<h3>Page not found</h3><p>The route <code>${esc(path)}</code> does not exist.</p>
      <div style="margin-top:14px"><a class="btn btn--primary" href="#/">Back to dashboard</a></div></div></div></div>`;
    setTitle('Not found');
    return;
  }

  highlightNav(path);
  view.innerHTML = `<div class="card"><div class="card__body" style="display:grid;place-items:center;min-height:300px">
    <div class="spinner" role="status" aria-label="Loading"></div></div></div>`;

  try {
    const mod = await loader();
    if (token !== currentToken) return; // a newer navigation won
    view.innerHTML = '';
    await mod.render(view, query);
    view.focus({ preventScroll: true });
    scrollTo({ top: 0, behavior: 'smooth' });
  } catch (e) {
    if (token !== currentToken) return;
    console.error(e);
    view.innerHTML = `<div class="card"><div class="card__body"><div class="empty">${icon('alert')}
      <h3>Could not load this page</h3><p>${esc(e.message || 'Unexpected error')}</p>
      <div style="margin-top:14px"><button class="btn btn--primary" onclick="location.reload()">Reload</button></div></div></div></div>`;
  }
  refreshBadges();
}

export async function boot() {
  const user = await requireAuth();
  if (!user) return;
  try { user.featureAccess = (await api.get('/features/access')).data || []; } catch { user.featureAccess = []; }
  renderShell(user);
  try {
    const { data } = await api.get('/settings');
    setCurrency({ code: data.payment.currency, symbol: data.payment.currencySymbol });
    const nameNode = qs('#companyName');
    if (nameNode) nameNode.textContent = data.company.name;
  } catch { /* defaults are fine */ }

  addEventListener('hashchange', renderRoute);
  await renderRoute();
  refreshBadges();
  setInterval(refreshBadges, 60000);
}

export { toast, toastError };
