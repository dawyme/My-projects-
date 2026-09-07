#!/usr/bin/env node
/** Run the complete regression suite in sequence. */
const { spawnSync } = require('child_process');
const path = require('path');
const SUITES = [
  ['API endpoints', 'api.test.js'],
  ['Service operations contract', 'service-operations-contract.test.js'],
  ['Dispatch and reminders contract', 'dispatch-reminders-contract.test.js'],
  ['Website Content Manager', 'content.test.js'],
  ['Payment gateways', 'payments.test.js'],
  ['Tilopay unit tests', 'tilopay-unit.test.js'],
  ['Supplier Marketplace', 'suppliers.test.js'],
  ['POS / multi-tenant POS', 'pos.test.js'],
  ['SaaS / multi-tenant productization', 'saas.test.js'],
  ['RBAC / security foundation', 'rbac.test.js'],
  ['Tenant portal / subscriptions', 'tenant.test.js'],
  ['Super Admin bootstrap', 'bootstrap-super-admin.test.js'],
  ['Admin Dashboard UI', 'ui.test.js'],
  ['Admin health URL regression', 'admin-health.test.js'],
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
for (const [label, ok] of summary) console.log(`  ${ok ? '✔' : '✘'} ${label}`);
console.log(failed ? `\n${failed} suite(s) failed.\n` : '\nAll suites passed.\n');
process.exit(failed ? 1 : 0);
