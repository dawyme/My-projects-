#!/usr/bin/env node
/** Runs the API, admin UI and public website suites in sequence. */
const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
  ['API endpoints', 'api.test.js'],
  ['Service operations contract', 'service-operations-contract.test.js'],
  ['Website Content Manager', 'content.test.js'],
  ['Payment gateways', 'payments.test.js'],
  ['Tilopay unit tests', 'tilopay-unit.test.js'],
  ['Supplier Marketplace', 'suppliers.test.js'],
  ['Admin dashboard UI', 'ui.test.js'],
  ['Public website', 'site.test.js'],
];

let failed = 0;
const summary = [];
for (const [label, file] of SUITES) {
  console.log(`\n──────── ${label} ────────`);
  const res = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
  if (res.status !== 0) failed++;
  summary.push([label, res.status === 0]);
}

console.log('\n════════ SUMMARY ════════');
for (const [label, ok] of summary) console.log(`  ${ok ? '✔' : '✘'} ${label}`);
console.log(failed ? `\n${failed} suite(s) failed.\n` : '\nAll suites passed.\n');
process.exit(failed ? 1 : 0);
