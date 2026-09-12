#!/usr/bin/env node
/**
 * Phase B reliability regression contracts.
 *
 * Covers the Phase B scope from GAP_ANALYSIS.md §"Finish Admin/Auth/RBAC/
 * Feature Management Reliability":
 *   1. immediate logout / authentication reliability (bfcache restore guard)
 *   2. admin navigation highlighting + submenu behavior
 *   3. recurring appointments dashboard handling (no duplicates, no ghosts)
 *   4. exactly one /api/dashboard API mount
 *   5. tenant-aware recurring dashboard query
 *   6. role dashboard mobile navigation dismissal
 *   7. platform owner architecture + public login page invariants
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const apiClient = read('admin/js/api.js');
const layout = read('admin/js/layout.js');
const css = read('admin/css/admin.css');
const dashboardPage = read('admin/js/pages/dashboard.js');
const app = read('backend/src/app.js');
const dashboardRoute = read('backend/src/routes/dashboard.js');
const customerShell = read('customer/index.html');
const technicianShell = read('technician/index.html');
const loginPage = read('login.html');

// 1. Immediate logout / authentication reliability ----------------------------------
assert.match(apiClient, /store\.clear\(\);\s*try\s*\{\s*await api\.post\('\/auth\/logout'/,
  'Logout must clear local session state before the server revocation call');
assert.match(apiClient, /addEventListener\('pageshow'/,
  'API client must watch for back/forward cache restores');
assert.match(apiClient, /event\.persisted/,
  'bfcache guard must only act on pages restored from the cache');
assert.match(apiClient, /location\.pathname\.endsWith\('login\.html'\)\s*\) return;/,
  'bfcache guard must never interfere with the login pages');
assert.match(apiClient, /if\s*\(!store\.get\(\)\.accessToken\)\s*\{\s*location\.replace\(`\/login\.html\?next=/,
  'bfcache guard must send stale authenticated pages to the login screen');

// 2. Admin navigation highlighting + submenu behavior ------------------------------
assert.match(layout, /export function highlightNav/, 'Layout must keep the highlightNav export');
assert.match(layout, /document\.querySelectorAll\('\.nav-link\[data-path\]'\)/,
  'Navigation highlighting must evaluate every nav link');
assert.match(layout, /link\.dataset\.path\s*===\s*path/,
  'Navigation highlighting must match the active route path');
assert.doesNotMatch(layout, /items\.hidden\s*=\s*!isActiveGroup/,
  'Navigation must not force-collapse every non-active group on route change');
assert.match(layout, /toggle\.setAttribute\('aria-expanded',\s*'true'\);\s*items\.hidden\s*=\s*false;/,
  'Navigation must auto-expand the active group without collapsing the others');
assert.match(css, /\.nav-link:focus-visible,\.nav-group__toggle:focus-visible\{outline:/,
  'Navigation must keep a visible keyboard focus indicator');

// 3. Recurring appointments dashboard handling -------------------------------------
assert.match(dashboardRoute, /recurringOccurrence:\s*\{\s*is:\s*null\s*\}/,
  'Upcoming one-off bookings must exclude series-generated bookings (they have their own dataset)');
assert.match(dashboardRoute, /booking:\s*\{\s*is:\s*\{\s*status:\s*\{\s*not:\s*'CANCELLED'\s*\}\s*\}\s*\}/,
  'Recurring occurrences whose booking was cancelled must not surface as upcoming');
assert.match(dashboardPage, /upcomingRes\.recurring/,
  'Dashboard must consume the dedicated recurring dataset');
assert.doesNotMatch(dashboardPage, /upcomingRes\.data\?\.recurring/,
  'Dashboard must not read a phantom recurring field off the bookings array');

// 4. Exactly one /api/dashboard API mount ------------------------------------------
const dashboardMounts = app.match(/app\.use\('\/api\/dashboard'/g) || [];
assert.strictEqual(dashboardMounts.length, 1, 'The dashboard API must be mounted exactly once');
const collectRouteFiles = (dir, acc = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectRouteFiles(full, acc);
    else if (entry.name.endsWith('.js')) acc.push(full);
  }
  return acc;
};
for (const file of collectRouteFiles(path.join(ROOT, 'backend', 'src', 'routes'))) {
  if (file.endsWith(`${path.sep}dashboard.js`)) continue;
  const source = fs.readFileSync(file, 'utf8');
  assert.ok(!source.includes("require('./routes/dashboard')"),
    `${path.relative(ROOT, file)} must not remount the dashboard router`);
}

// 5. Tenant-aware recurring dashboard query ----------------------------------------
const upcomingSource = dashboardRoute.split("router.get('/upcoming'")[1] || '';
assert.ok(upcomingSource, 'Dashboard route must expose /upcoming');
const upcomingScoped = upcomingSource.split("router.get('/low-stock'")[0];
assert.match(upcomingScoped, /\.\.\.tenantWhere\(req\)/,
  'Upcoming queries must use the shared tenantWhere scope primitive');
assert.doesNotMatch(upcomingScoped, /businessId:\s*req\.tenantId/,
  'Upcoming queries must not bypass tenantWhere with a raw businessId filter');
assert.match(upcomingScoped, /status:\s*'SCHEDULED'/,
  'Recurring dashboard query must keep occurrence status filtering');

// 6. Role dashboard mobile navigation dismissal ------------------------------------
for (const [label, shell] of [['customer', customerShell], ['technician', technicianShell]]) {
  assert.match(shell, /class="role-mobile-nav-toggle"/, `${label} dashboard must keep its mobile navigation toggle`);
  assert.match(shell, /class="role-mobile-nav"/, `${label} dashboard must keep its mobile navigation container`);
  assert.match(shell, /closeMobileNav/, `${label} dashboard must centralize mobile navigation dismissal`);
  assert.match(shell, /addEventListener\('hashchange',\s*closeMobileNav\)/, `${label} dashboard must close the mobile navigation on hashchange`);
  assert.match(shell, /e\.key==='Escape'/, `${label} dashboard must close the mobile navigation on Escape`);
}

// 7. Platform owner architecture + public login page invariants --------------------
assert.match(loginPage, /await auth\.login\(email, password\);/,
  'Public login page must keep its existing auth integration');
assert.doesNotMatch(loginPage, /pageshow/,
  'Public login page must remain untouched by the bfcache guard');
assert.match(app, /app\.use\('\/api\/tenant', require\('\.\/routes\/tenant'\)\)/,
  'Tenant API mount must remain intact');

console.log('PASS: Phase B reliability regression contracts');
