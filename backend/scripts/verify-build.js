#!/usr/bin/env node
/**
 * Production build verification.
 *
 * 1. Boots the Express app so every route module is loaded (catches require /
 *    syntax errors across the API).
 * 2. Bundles every admin SPA page with esbuild (catches syntax errors in the
 *    dashboard's ES modules).
 *
 * Exits non-zero on any failure. Safe to run with no database configured —
 * the app is only required, never listened to.
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
let failed = false;
const fail = (msg) => { console.error(`  ✘ ${msg}`); failed = true; };
const pass = (msg) => console.log(`  ✔ ${msg}`);

console.log('Verifying backend modules…');
try {
  require('../src/app'); // loads every route + middleware + lib
  pass('Express app loads (all API routes registered)');
} catch (e) {
  fail(`Express app failed to load: ${e.message}`);
}

console.log('Verifying admin dashboard bundles…');
const ADMIN_DIR = path.join(ROOT, 'admin');
const { buildSync } = require('esbuild');
const entries = fs.readdirSync(ADMIN_DIR)
  .filter((f) => f.endsWith('.html'))
  .sort();
for (const file of entries) {
  const html = fs.readFileSync(path.join(ADMIN_DIR, file), 'utf8');
  const match = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  if (!match) { pass(`${file} (no module script)`); continue; }
  const entryPath = path.join(ADMIN_DIR, `.verify-build-${file.replace('.html', '')}.js`);
  fs.writeFileSync(entryPath, match[1]);
  try {
    buildSync({
      entryPoints: [entryPath], bundle: true, write: false,
      format: 'iife', platform: 'browser', target: 'es2020',
    });
    pass(`${file} bundles cleanly`);
  } catch (e) {
    fail(`${file}: ${e.errors && e.errors[0] ? e.errors[0].text : e.message}`);
  } finally {
    fs.unlinkSync(entryPath);
  }
}

console.log(failed ? '\nBuild verification FAILED.\n' : '\nBuild verification passed.\n');
process.exit(failed ? 1 : 0);
