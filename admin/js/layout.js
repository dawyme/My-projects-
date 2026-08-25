/** Renders the sidebar/topbar shell, theme toggle and hash router. */
import { api, auth, requireAuth } from './api.js';
import { el, qs, icon, esc, initials, setCurrency, toast, toastError } from './ui.js';

const NAV = [
  { group: 'Overview', items: [
    { path: '/', label: 'Dashboard', icon: 'dashboard' },
    { path: '/analytics', label: 'Analytics', icon: 'chart' },
  ] },
  { group: 'Catalogue', items: [
    { path: '/products', label: 'Products', icon: 'box' },
    { path: '/categories', label: 'Categories', icon: 'tag' },
    { path: '/inventory', label: 'Inventory', icon: 'layers', badge: 'lowStock' },
  ] },
  { group: 'Operations', items: [
    { path: '/bookings', label: 'Service Bookings', icon: 'calendar', badge: 'pending' },
    { path: '/calendar', label: 'Calendar', icon: 'clock' },
    { path: '/services', label: 'Services', icon: 'wrench' },
    { path: '/orders', label: 'Orders', icon: 'file' },
  ] },
  { group: 'People', items: [
    { path: '/customers', label: 'Customers', icon: 'users' },
    { path: '/messages', label: 'Messages', icon: 'mail', badge: 'unread' },
  ] },
  { group: 'Administration', items: [
    { path: '/settings', label: 'Settings', icon: 'settings' },
    { path: '/users', label: 'Team', icon: 'user', adminOnly: true },
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
    const items = group.items.filter((i) => !i.adminOnly || user.role === 'ADMIN');
    if (!items.length) return '';
    return `<div class="nav-group"><div class="nav-group__label">${esc(group.group)}</div>
      ${items.map((i) => `<a class="nav-link" href="#${i.path}" data-path="${i.path}">
        ${icon(i.icon)}<span>${esc(i.label)}</span>
        ${i.badge ? `<span class="nav-link__badge" data-badge="${i.badge}" hidden>0</span>` : ''}</a>`).join('')}
    </div>`;
  }).join('');
}

export function renderShell(user) {
  const shell = el(`<div class="layout">
    <aside class="sidebar" id="sidebar" aria-label="Main navigation">
      <div class="sidebar__brand">
        <div class="sidebar__logo">${icon('wrench')}</div>
        <div><div class="sidebar__title">N&D'S Admin</div><div class="sidebar__sub">HVAC &middot; Refrigeration</div></div>
      </div>
      <nav class="sidebar__nav">${navMarkup(user)}</nav>
      <div class="sidebar__footer"><span id="companyName">N&D'S Air Conditioning & Refrigeration Services</span> &middot; v1.0</div>
    </aside>
    <div class="main">
      <header class="topbar">
        <button class="icon-btn menu-toggle" id="menuToggle" aria-label="Toggle navigation" aria-expanded="false">${icon('menu')}</button>
        <span class="topbar__title" id="pageTitle">Dashboard</span>
        <div class="topbar__search">
          <label for="globalSearch" class="sr-only">Search products, bookings and customers</label>
          ${icon('search')}
          <input id="globalSearch" type="search" placeholder="Search products, bookings, customers…" autocomplete="off">
        </div>
        <button class="icon-btn" id="themeToggle" type="button"></button>
        <a class="icon-btn" href="#/messages" id="bellBtn" aria-label="Contact messages">${icon('bell')}<span class="icon-btn__dot" hidden></span></a>
        <div class="usermenu">
          <button class="usermenu__btn" id="userBtn" aria-haspopup="menu" aria-expanded="false">
            <span class="avatar">${esc(initials(user.name))}</span>
            <span><span class="usermenu__name">${esc(user.name)}</span><br><span class="usermenu__role">${esc(user.role)}</span></span>
          </button>
          <div class="dropdown" id="userMenu" role="menu">
            <a class="dropdown__item" href="#/profile" role="menuitem">${icon('user')} My profile</a>
            <a class="dropdown__item" href="#/settings" role="menuitem">${icon('settings')} Settings</a>
            <a class="dropdown__item" href="../index.html" target="_blank" rel="noopener" role="menuitem">${icon('eye')} View website</a>
            <div class="dropdown__sep"></div>
            <button class="dropdown__item" id="logoutBtn" role="menuitem">${icon('logout')} Sign out</button>
          </div>
        </div>
      </header>
      <main class="content" id="view" tabindex="-1"></main>
    </div>
    <div class="backdrop" id="backdrop"></div>
  </div>`);

  document.body.prepend(el('<a class="skip-link" href="#view">Skip to main content</a>'));
  document.body.appendChild(shell);
  applyTheme();

  const sidebar = qs('#sidebar');
  const backdrop = qs('#backdrop');
  const closeNav = () => { sidebar.classList.remove('open'); backdrop.classList.remove('show'); qs('#menuToggle').setAttribute('aria-expanded', 'false'); };
  qs('#menuToggle').onclick = () => {
    const open = sidebar.classList.toggle('open');
    backdrop.classList.toggle('show', open);
    qs('#menuToggle').setAttribute('aria-expanded', String(open));
  };
  backdrop.onclick = closeNav;
  sidebar.addEventListener('click', (e) => { if (e.target.closest('.nav-link') && innerWidth <= 1024) closeNav(); });

  qs('#themeToggle').onclick = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');

  const menu = qs('#userMenu');
  qs('#userBtn').onclick = (e) => {
    e.stopPropagation();
    const open = menu.classList.toggle('open');
    qs('#userBtn').setAttribute('aria-expanded', String(open));
  };
  document.addEventListener('click', () => { menu.classList.remove('open'); qs('#userBtn')?.setAttribute('aria-expanded', 'false'); });
  qs('#logoutBtn').onclick = () => auth.logout();

  const search = qs('#globalSearch');
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !search.value.trim()) return;
    const q = encodeURIComponent(search.value.trim());
    const target = location.hash.slice(1).split('?')[0] || '/products';
    const searchable = ['/products', '/bookings', '/customers', '/messages', '/orders', '/inventory'];
    location.hash = `${searchable.includes(target) ? target : '/products'}?search=${q}`;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/input|textarea|select/i.test(document.activeElement.tagName)) { e.preventDefault(); search.focus(); }
  });
}

export function setTitle(title) {
  const node = qs('#pageTitle');
  if (node) node.textContent = title;
  document.title = `${title} · N&D'S Admin`;
}

export function highlightNav(path) {
  document.querySelectorAll('.nav-link').forEach((link) => {
    if (link.dataset.path === path) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
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

/* ------------------------------------------------------------ router */
const routes = {
  '/': () => import('./pages/dashboard.js'),
  '/analytics': () => import('./pages/analytics.js'),
  '/products': () => import('./pages/products.js'),
  '/categories': () => import('./pages/categories.js'),
  '/inventory': () => import('./pages/inventory.js'),
  '/bookings': () => import('./pages/bookings.js'),
  '/calendar': () => import('./pages/calendar.js'),
  '/services': () => import('./pages/services.js'),
  '/orders': () => import('./pages/orders.js'),
  '/customers': () => import('./pages/customers.js'),
  '/messages': () => import('./pages/messages.js'),
  '/settings': () => import('./pages/settings.js'),
  '/users': () => import('./pages/users.js'),
  '/audit': () => import('./pages/audit.js'),
  '/profile': () => import('./pages/profile.js'),
  '/content': () => import('./pages/content.js'),
  '/media': () => import('./pages/media.js'),
};

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
