#!/usr/bin/env node
/** Regression coverage for the Admin/Super Admin UI health endpoint. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const files = [
  path.join(__dirname, '../../admin/js/pages/system-health.js'),
  path.join(__dirname, '../../admin/js/pages/superadmin.js'),
];

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  assert.match(source, /fetch\(['"]\/health['"]/, `${path.basename(file)} must call /health`);
  assert.doesNotMatch(source, /fetch\(['"]\.\.\/api\/health['"]/, `${path.basename(file)} must not call the invalid /api/health path`);
}

console.log('Admin health URL regression: passed');
