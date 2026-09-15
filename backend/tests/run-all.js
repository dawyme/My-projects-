#!/usr/bin/env node
/* Run the complete regression suite in sequence. */
const { spawnSync } = require('child_process');
const path = require('path');
const SUITES = [
  ['Admin Dashboard reliability contracts', 'admin-dashboard-reliability.test.js'],
  ['Phase B reliability contracts', 'phase-b-reliability.test.js'],
  ['Recurring maintenance recurrence unit contracts', 'recurring-maintenance.test.js'],
  ['Scheduling rules unit contracts', 'scheduling-rules.test.js'],
  ['Recurring maintenance API contract', 'recurring-maintenance-contract.test.js'],
  ['Calendar & scheduling contract', 'calendar-scheduling-contract.test.js'],
  ['Owner recurring + tenant team contracts', 'owner-recurring-tenant-team-contract.test.js'],
  ['API endpoints', 'api.test.js'],
  ['Service operations contract', 'service-operations-contract.test.js'],
  ['Dispatch and reminders contract', 'dispatch-reminders-contract.test.js'],
  ['Website Content Manager', 'content.test.js'],
  ['Payment gateways', 'payments.test.js'],
  ['Tilopay unit tests', 'tilopay-unit.test.js'],
  ['Universal Integration Gateway', 'integrations.test.js'],
  ['Tenant feature registry contracts', 'platform-feature-access-contract.test.js'],
  ['Universal Integrations Admin UI', 'integration-admin-ui.test.js'],
  ['Supplier Marketplace', 'suppliers.test.js'],
  ['POS / multi-tenant POS', 'pos.test.js'],
  ['SaaS / multi-tenant productization', 'saas.test.js'],
  ['Auth + plan + role logout regression', 'auth-plan-regression.test.js'],
  ['RBAC / security foundation', 'rbac.test.js'],
  ['Tenant portal / subscriptions', 'tenant.test.js'],
  ['Super Admin bootstrap', 'bootstrap-super-admin.test.js'],
  ['Admin Dashboard UI', 'ui.test.js'],
  ['Customer contacts picker (Contact Picker API)', 'customer-contacts-picker.test.js'],
  ['Admin health URL regression', 'admin-health.test.js'],
  ['Public login path', 'public-login.test.js'],
  ['Public website', 'site.test.js'],
];
let failed = 0;
const summary = [];
for (const [label, file] of SUITES) {
  console.log(`\n▶ ${label}`);
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
  summary.push([label, r.status === 0]);
}
console.log('\n=== SUMMARY ===');
for (const [label, ok] of summary) console.log(`  ${ok ? '✓' : '✗'} ${label}`);
console.log(failed ? `\n${failed} suite(s) failed.\n` : '\nAll suites passed.\n');
process.exit(failed ? 1 : 0);
