/**
 * Headless UI verification. Boots the real Express app, loads the admin SPA in
 * jsdom, signs in, and navigates to every route asserting real content renders
 * with no console errors and no unresolved placeholders.
 *   node tests/ui.test.js
 */
require('dotenv').config();
const path = require('path');
const assert = require('assert');
const fs = require('fs');
const esbuild = require('esbuild');
const { JSDOM, VirtualConsole } = require('jsdom');
const app = require('../src/app');
const prisma = require('../src/lib/prisma');

const ADMIN_DIR = path.join(__dirname, '..', '..', 'admin');
const ROLE_AUTH_FILE = path.join(__dirname, '..', '..', 'role-auth.js');
const ADMIN_LAYOUT_FILE = path.join(ADMIN_DIR, 'js', 'layout.js');
const ADMIN_LAYOUT_SOURCE = fs.readFileSync(ADMIN_LAYOUT_FILE, 'utf8');
assert.match(ADMIN_LAYOUT_SOURCE, /export async function boot\s*\(/, 'admin layout must export boot()');
assert.match(ADMIN_LAYOUT_SOURCE, /export function setTitle\s*\(/, 'admin layout must export setTitle()');

/**
 * jsdom cannot execute native ES modules (real browsers can), so for the test
 * harness each page's inline module script is extracted and bundled to a
 * classic IIFE with esbuild. The bundle is then injected at runtime via a DOM
 * script element rather than inlined into the HTML: jsdom's HTML tokenizer
 * corrupts large inline scripts that contain HTML-template strings (the Website
 * Content Manager's editor markup), which yields a spurious SyntaxError. Setting
 * script.textContent programmatically bypasses the HTML parser entirely.
 */
const MODULE_TAG = /<script type="module">([\s\S]*?)<\/script>/;

function pageHtml(file) {
  let html = fs.readFileSync(path.join(ADMIN_DIR, file), 'utf8');
  // The remote font stylesheet is unreachable in the sandbox.
  html = html.replace(/<link[^>]+fonts\.googleapis[^>]*>/g, '');

  const match = html.match(MODULE_TAG);
  if (!match) return { html, script: null };

  const entryName = `.test-entry-${path.basename(file, '.html')}.js`;
  const entryPath = path.join(ADMIN_DIR, entryName);
  fs.writeFileSync(entryPath, match[1]);
  let code;
  try {
    code = esbuild.buildSync({
      entryPoints: [entryPath], bundle: true, write: false,
      format: 'iife', platform: 'browser', target: 'es2020',
    }).outputFiles[0].text;
  } finally {
    fs.unlinkSync(entryPath);
  }
  return { html: html.replace(MODULE_TAG, ''), script: code };
}

/** Executes a bundled classic script in the window, bypassing HTML parsing. */
function bootBundle(window, script) {
  if (!script) return;
  const s = window.document.createElement('script');
  s.textContent = script;
  window.document.body.appendChild(s);
}

const ROUTES = [
  ['#/', 'Dashboard', ['Total Products', 'Service Bookings', 'Customers', 'Contact Messages', 'Low Stock', 'Revenue', 'Recent activity']],
  ['#/analytics', 'Analytics', ['Revenue trends', 'Monthly bookings', 'Customer growth', 'Top products', 'Technician performance']],
  ['#/products', 'Products', ['SKU', 'Export CSV', 'New product']],
  ['#/categories', 'Categories', ['Air Conditioners', 'Refrigerants', 'Compressors']],
  ['#/inventory', 'Inventory', ['Total SKUs', 'Low stock', 'Stock value']],
  ['#/bookings', 'Service Bookings', ['Reference', 'Technician', 'Status']],
  ['#/calendar', 'Calendar', ['Mon', 'Pending', 'Completed']],
  ['#/services', 'Services', ['AC Installation', 'Base price']],
  ['#/dispatch', 'Dispatch Board', ['Dispatch Board']],
  ['#/equipment', 'Equipment', ['Equipment']],
  ['#/service-history', 'Service History', ['Service History']],
  ['#/estimates', 'Estimates', ['Estimates']],
  ['#/invoices', 'Invoices', ['Invoices']],
  ['#/orders', 'Orders', ['Reference', 'New order']],
  ['#/customers', 'Customers', ['Bookings', 'Orders', 'Export CSV']],
  ['#/messages', 'Contact Messages', ['Unread', 'Archived']],
  ['#/settings', 'Business Settings', ['Company', 'Business hours', 'Payments', 'SEO']],
  ['#/users', 'Team', ['Role', 'Last sign-in']],
  ['#/audit', 'Audit Log', ['Action', 'IP address']],
];
