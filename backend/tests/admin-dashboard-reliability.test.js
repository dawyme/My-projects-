#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const app = read('backend/src/app.js');
const layout = read('admin/js/layout.js');
const css = read('admin/css/admin.css');
const dashboardRoute = read('backend/src/routes/dashboard.js');
const dashboardPage = read('admin/js/pages/dashboard.js');

assert.match(app, /app\.use\('\/api\/saas\/features',\s*require\('\.\/routes\/features'\)\)/, 'Feature Management must be mounted at /api/saas/features');
assert.match(layout, /await\s+auth\.logout\(\)|void\s+auth\.logout\(\)/, 'Admin shell logout must delegate to auth.logout');
assert.doesNotMatch(layout, /auth\.clear\(\)/, 'Admin shell must not call the nonexistent auth.clear method');
assert.match(layout, /document\.querySelectorAll\('\.nav-link\[data-path\]'\)/, 'Navigation highlighting must evaluate every nav link');
assert.match(layout, /link\.dataset\.path\s*===\s*path/, 'Navigation highlighting must match the active route path');
assert.match(css, /\.nav-group__items\{[^}]*padding-left:/, 'Navigation submenus must have explicit indentation');
assert.match(dashboardRoute, /recurringMaintenanceOccurrence\.findMany/, 'Dashboard upcoming endpoint must explicitly include recurring maintenance occurrences');
assert.match(dashboardRoute, /recurring:\s*recurringBookings/, 'Dashboard upcoming endpoint must expose recurring appointments separately');
assert.match(dashboardPage, /Recurring appointments/, 'Dashboard must render a dedicated recurring appointments section');
assert.match(dashboardPage, /upcomingRes\.recurring/, 'Dashboard must consume the recurring appointment dataset');

console.log('PASS: admin dashboard reliability regression contracts');
