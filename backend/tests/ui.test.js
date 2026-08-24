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
  ['#/orders', 'Orders', ['Reference', 'New order']],
  ['#/customers', 'Customers', ['Bookings', 'Orders', 'Export CSV']],
  ['#/messages', 'Contact Messages', ['Unread', 'Archived']],
  ['#/settings', 'Business Settings', ['Company', 'Business hours', 'Payments', 'SEO']],
  ['#/users', 'Team', ['Role', 'Last sign-in']],
  ['#/audit', 'Audit Log', ['Action', 'IP address']],
  ['#/profile', 'My Profile', ['Change password', 'Sessions']],
  ['#/content', 'Website Content Manager', ['Homepage', 'About Us', 'Services', 'SEO settings', 'Publish']],
  ['#/media', 'Media Library', ['Upload', 'Folders']],
  ['#/no-such-page', 'Not found', ['Page not found']],
];


/**
 * jsdom has no fetch. Install Node's fetch into the window, resolving relative
 * URLs against the test server and bridging cookies through document.cookie so
 * the CSRF double-submit flow behaves exactly as it does in a browser.
 */
function installFetch(window, base) {
  const jar = new Map();
  const syncFromDoc = () => {
    for (const part of (window.document.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
  };
  window.fetch = async (input, init = {}) => {
    syncFromDoc();
    const url = new URL(String(input && input.url ? input.url : input), base).toString();
    const headers = new Headers(init.headers || {});
    const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.set('cookie', cookie);
    const res = await fetch(url, { ...init, headers, redirect: 'manual' });
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i);
      const v = pair.slice(i + 1);
      // path=/ mirrors the server cookie so jsdom replaces rather than duplicates it.
      if (v === '') jar.delete(k); else { jar.set(k, v); window.document.cookie = `${k}=${v}; path=/`; }
    }
    return res;
  };
  window.Headers = Headers;
  window.FormData = FormData;
  window.Request = Request;
  window.Response = Response;
}

const results = [];
let failures = 0;
const record = (ok, name, extra = '') => {
  results.push([ok ? 'PASS' : 'FAIL', name + (extra ? ` — ${extra}` : '')]);
  if (!ok) failures++;
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls until the predicate is true or the timeout elapses. */
async function until(fn, timeout = 8000, step = 60) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await fn()) return true; } catch (_) {}
    await wait(step);
  }
  return false;
}

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const consoleErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => {
    if (!/Could not parse CSS|Not implemented/.test(e.message)) consoleErrors.push(e.message);
  });
  virtualConsole.on('error', (...args) => {
    const msg = args.join(' ');
    if (!/Not implemented|Could not parse CSS/.test(msg)) consoleErrors.push(msg);
  });

  // ---------- login page
  const loginPage = pageHtml('login.html');
  const loginDom = new JSDOM(loginPage.html, {
    url: `${base}/admin/login.html`,
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      installFetch(window, base);
      window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    },
  });
  const lw = loginDom.window;
  bootBundle(lw, loginPage.script);
  await until(() => lw.document.getElementById('loginForm'));
  record(!!lw.document.getElementById('loginForm'), 'Login page renders the sign-in form');
  record(lw.document.body.textContent.includes('admin@ndsairconditioning.com'), 'Login page shows demo credentials');

  // Submit invalid credentials and expect a visible error.
  lw.document.getElementById('email').value = 'admin@ndsairconditioning.com';
  lw.document.getElementById('password').value = 'definitely-wrong';
  lw.document.getElementById('loginForm').dispatchEvent(new lw.Event('submit', { bubbles: true, cancelable: true }));
  const sawError = await until(() => !lw.document.getElementById('alert').hidden);
  record(sawError, 'Login page surfaces invalid-credential errors',
    sawError ? '' : 'no error alert appeared');

  // Real login — capture the session for the SPA run.
  lw.document.getElementById('password').value = process.env.SEED_ADMIN_PASSWORD || 'Admin@12345';
  lw.document.getElementById('loginForm').dispatchEvent(new lw.Event('submit', { bubbles: true, cancelable: true }));
  await wait(400);
  const loggedIn = await until(() => {
    try { return !!JSON.parse(lw.localStorage.getItem('nds.auth') || '{}').accessToken; } catch { return false; }
  });
  record(loggedIn, 'Login stores a session and redirects to the dashboard');
  const session = lw.localStorage.getItem('nds.auth');
  const cookies = lw.document.cookie;
  loginDom.window.close();

  if (!loggedIn) {
    report();
    server.close();
    return;
  }

  // ---------- SPA
  const spaPage = pageHtml('index.html');
  const dom = new JSDOM(spaPage.html, {
    url: `${base}/admin/index.html`,
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      installFetch(window, base);
      window.localStorage.setItem('nds.auth', session);
      window.scrollTo = () => {};
      window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
      window.URL.createObjectURL = () => 'blob:mock';
      window.URL.revokeObjectURL = () => {};
    },
  });
  const w = dom.window;
  const doc = w.document;
  cookies.split(';').forEach((c) => { if (c.trim()) doc.cookie = c.trim(); });
  bootBundle(w, spaPage.script);

  const shellReady = await until(() => doc.querySelector('.sidebar') && doc.querySelector('#view'));
  record(shellReady, 'Admin shell renders sidebar, topbar and content area');
  record(!!doc.querySelector('.topbar') && !!doc.querySelector('#userBtn'), 'Top navigation with user menu is present');
  record(doc.querySelectorAll('.nav-link').length >= 12, 'Sidebar navigation lists every section',
    `${doc.querySelectorAll('.nav-link').length} links`);
  record(!!doc.querySelector('#menuToggle'), 'Mobile menu toggle exists');
  record(!!doc.querySelector('.skip-link'), 'Accessibility skip link is present');

  // theme toggle
  const before = doc.documentElement.dataset.theme;
  doc.getElementById('themeToggle').click();
  await wait(60);
  record(doc.documentElement.dataset.theme !== before, 'Dark/light mode toggle switches the theme',
    `${before} → ${doc.documentElement.dataset.theme}`);
  doc.getElementById('themeToggle').click();

  // mobile menu behaviour
  doc.getElementById('menuToggle').click();
  await wait(50);
  record(doc.querySelector('.sidebar').classList.contains('open'), 'Mobile menu opens the sidebar');
  doc.getElementById('backdrop').click();
  await wait(50);
  record(!doc.querySelector('.sidebar').classList.contains('open'), 'Mobile menu closes via the backdrop');

  // ---------- every route
  for (const [hash, title, needles] of ROUTES) {
    w.location.hash = hash;
    const ok = await until(() => {
      const view = doc.getElementById('view');
      if (!view || view.querySelector('.spinner') || view.querySelector('.skeleton')) return false;
      const txt = view.textContent;
      return txt.length > 60 && needles.every((n) => txt.includes(n));
    }, 15000);
    const txt = doc.getElementById('view').textContent;
    const missing = needles.filter((n) => !txt.includes(n));
    record(ok, `Route ${hash} renders "${title}"`, ok ? '' : `missing: ${missing.join(', ') || 'still loading'}`);

    if (ok) {
      // Word boundaries keep real content like "Hernandez" from matching "NaN".
      const bad = txt.match(/\bundefined\b|\[object Object\]|\bNaN\b|\bTODO\b|\bPLACEHOLDER\b|Lorem ipsum/);
      record(!bad, `Route ${hash} has no placeholder or undefined output`,
        bad ? `found "${bad[0]}" near: ${txt.slice(Math.max(0, bad.index - 40), bad.index + 40).replace(/\s+/g, ' ')}` : '');
      const skeletons = doc.getElementById('view').querySelectorAll('.skeleton').length;
      record(skeletons === 0, `Route ${hash} finished loading all data`, skeletons ? `${skeletons} skeletons left` : '');
    }
  }

  // ---------- interactive checks
  w.location.hash = '#/products';
  await until(() => doc.querySelector('#rows tr[data-id]'));
  const rowCount = doc.querySelectorAll('#rows tr[data-id]').length;
  record(rowCount > 0, 'Products table lists real records', `${rowCount} rows`);
  record(!!doc.querySelector('#pager .page-btn'), 'Product pagination controls render');

  // open the create-product modal
  const newBtn = doc.getElementById('newBtn');
  if (newBtn) newBtn.click();
  const modalOpen = await until(() => doc.querySelector('.modal-backdrop #productForm'));
  record(modalOpen, 'Product create modal opens with a full form');
  if (modalOpen) {
    const form = doc.querySelector('#productForm');
    record(['name', 'sku', 'categoryId', 'price', 'quantity', 'featured'].every((f) => form.elements[f]),
      'Product form exposes SKU, price, quantity, category and featured fields');
    doc.querySelector('.modal-backdrop [data-close]').click();
    await wait(80);
    record(!doc.querySelector('.modal-backdrop'), 'Modal closes cleanly');
  }

  // search filter round trip
  const searchInput = doc.getElementById('searchInput');
  searchInput.value = 'compressor';
  searchInput.dispatchEvent(new w.Event('input', { bubbles: true }));
  const searched = await until(() => {
    const rows = [...doc.querySelectorAll('#rows tr[data-id]')];
    return rows.length > 0 && rows.every((r) => /compressor/i.test(r.textContent));
  }, 8000);
  record(searched, 'Product search filters the table');

  // bulk selection
  const firstBox = doc.querySelector('.rowsel');
  if (firstBox) {
    firstBox.checked = true;
    firstBox.dispatchEvent(new w.Event('change', { bubbles: true }));
    await wait(80);
    record(doc.getElementById('bulkbar').classList.contains('show'), 'Bulk action bar appears on selection');
  }

  // bookings status control
  w.location.hash = '#/bookings';
  await until(() => doc.querySelector('#rows tr[data-id] [data-act="view"]'), 12000);
  const viewBtn = doc.querySelector('#rows tr[data-id] [data-act="view"]');
  record(!!viewBtn, 'Bookings table renders row actions');
  if (viewBtn) viewBtn.click();
  const detailOpen = viewBtn ? await until(() => doc.querySelector('.modal-backdrop #dStatus'), 12000) : false;
  record(detailOpen, 'Booking detail drawer opens with status, technician and notes controls');
  if (detailOpen) {
    const statuses = [...doc.querySelectorAll('#dStatus option')].map((o) => o.value);
    record(['PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'].every((s) => statuses.includes(s)),
      'Booking status control offers all five statuses');
    record(!!doc.querySelector('#dTech') && !!doc.querySelector('#addNote'),
      'Booking drawer supports technician assignment and notes');
    doc.querySelector('.modal-backdrop [data-close]').click();
  }

  // messages inbox
  w.location.hash = '#/messages';
  await until(() => doc.querySelector('.inbox__item'), 12000);
  await until(() => doc.getElementById('replyBody'), 12000);
  record(doc.querySelectorAll('.inbox__item').length > 0, 'Message inbox lists conversations');
  record(!!doc.querySelector('#detail') && doc.querySelector('#detail').textContent.length > 40,
    'Message detail pane auto-opens the first message');
  record(!!doc.getElementById('replyBody') && !!doc.getElementById('sendReply'), 'Inbox provides a reply composer');

  // settings tabs
  w.location.hash = '#/settings';
  await until(() => doc.querySelector('#form[data-section="company"]'));
  const seoTab = [...doc.querySelectorAll('#tabs .tab')].find((t) => t.dataset.tab === 'seo');
  if (seoTab) seoTab.click();
  const seoShown = await until(() => doc.querySelector('#form[data-section="seo"]'));
  record(seoShown, 'Settings tabs switch between configuration sections');

  // charts render as SVG
  w.location.hash = '#/analytics';
  await until(() => doc.querySelector('#revenueChart svg'), 12000);
  const svgCount = doc.querySelectorAll('#view svg polyline, #view svg rect, #view svg path').length;
  record(doc.querySelectorAll('#view .chart-box svg').length >= 4, 'Analytics renders multiple charts',
    `${doc.querySelectorAll('#view .chart-box svg').length} charts, ${svgCount} shapes`);

  // website content manager tabs
  w.location.hash = '#/content';
  await until(() => doc.querySelector('#contentTabs [data-tab="services"]'), 12000);
  doc.querySelector('#contentTabs [data-tab="services"]').click();
  const svcRendered = await until(() =>
    doc.querySelector('[data-list] table tbody tr') || doc.querySelector('[data-list] .empty'), 12000);
  record(svcRendered, 'Content manager Services tab lists services');

  // ---- Services collection: create/edit/publish/reorder/search/delete ----
  // Regression coverage for the rich-field targeting bug: a collection item
  // with two independent rich-text fields (description, content) must save
  // and reload each field under its own key, and neither field may be
  // silently dropped from the save payload.
  const initialSvcRows = doc.querySelectorAll('[data-list] table tbody tr[data-id]').length;

  doc.querySelector('[data-add]')?.click();
  const svcModalOpen = await until(() => doc.querySelector('.modal-backdrop #collForm'), 8000);
  record(svcModalOpen, 'Services "New Service" modal opens with a form');

  if (svcModalOpen) {
    const form = doc.querySelector('#collForm');
    record(['name', 'icon', 'featured', 'sortOrder'].every((f) => form.elements[f]),
      'Service form exposes name, icon, featured and sortOrder controls');

    const richEditors = [...doc.querySelectorAll('.modal-backdrop .rte__editor')];
    record(richEditors.length === 2, 'Service form renders two independent rich-text editors',
      `${richEditors.length} editor(s) found`);

    const DESC_MARK = `UITEST-DESC-${Date.now()}`;
    const CONTENT_MARK = `UITEST-CONTENT-${Date.now()}`;
    const descEditor = doc.querySelector('.modal-backdrop [data-path="description"]');
    const contentEditor = doc.querySelector('.modal-backdrop [data-path="content"]');
    record(!!descEditor && !!contentEditor, 'Rich editors are individually addressable by field name',
      `description: ${!!descEditor}, content: ${!!contentEditor}`);

    const svcName = `UI Test Service ${Date.now()}`;
    if (descEditor && contentEditor) {
      descEditor.innerHTML = `<p>${DESC_MARK}</p>`;
      contentEditor.innerHTML = `<p>${CONTENT_MARK}</p>`;
      form.elements.name.value = svcName;
      form.elements.name.dispatchEvent(new w.Event('input', { bubbles: true }));

      doc.querySelector('.modal-backdrop [data-save]').click();
      const saved = await until(() => !doc.querySelector('.modal-backdrop'), 8000);
      record(saved, 'Service save closes the modal without error');

      const rowsAfterCreate = await until(() =>
        doc.querySelectorAll('[data-list] table tbody tr[data-id]').length > initialSvcRows, 8000);
      record(rowsAfterCreate, 'New service appears in the list after saving');

      const newRow = [...doc.querySelectorAll('[data-list] table tbody tr[data-id]')]
        .find((r) => r.textContent.includes(svcName));

      if (newRow) {
        // Reopen for edit — each rich field must reload under its own key,
        // not the other field's (the exact failure mode of the targeting bug).
        newRow.querySelector('[data-act="edit"]').click();
        const editOpen = await until(() => doc.querySelector('.modal-backdrop #collForm'), 8000);
        const editDesc = doc.querySelector('.modal-backdrop [data-path="description"]');
        const editContent = doc.querySelector('.modal-backdrop [data-path="content"]');
        record(editOpen && !!editDesc?.innerHTML.includes(DESC_MARK) && !editDesc.innerHTML.includes(CONTENT_MARK),
          'Saved "Short description" reloads its own content, not the other rich field\'s',
          editDesc ? editDesc.innerHTML.slice(0, 80) : 'field missing');
        record(editOpen && !!editContent?.innerHTML.includes(CONTENT_MARK) && !editContent.innerHTML.includes(DESC_MARK),
          'Saved "Full description" reloads its own content, not the other rich field\'s',
          editContent ? editContent.innerHTML.slice(0, 80) : 'field missing');

        doc.querySelector('.modal-backdrop [data-close]')?.click();
        await wait(80);

        // publish/draft toggle
        const statusBefore = newRow.querySelector('.badge')?.textContent.trim();
        newRow.querySelector('[data-act="toggle"]').click();
        const toggled = await until(() => {
          const r = [...doc.querySelectorAll('[data-list] table tbody tr[data-id]')]
            .find((x) => x.dataset.id === newRow.dataset.id);
          return r && r.querySelector('.badge')?.textContent.trim() !== statusBefore;
        }, 8000);
        record(toggled, 'Publish/draft toggle changes the item\'s status');

        // reorder (move up), skipped gracefully if the row is already first
        const rowsBeforeMove = [...doc.querySelectorAll('[data-list] table tbody tr[data-id]')];
        const targetRow = rowsBeforeMove.find((r) => r.dataset.id === newRow.dataset.id);
        const upBtn = targetRow?.querySelector('[data-act="move"][data-dir="-1"]');
        if (upBtn && !upBtn.disabled) {
          const idxBefore = rowsBeforeMove.indexOf(targetRow);
          upBtn.click();
          await wait(150);
          const rowsAfterMove = [...doc.querySelectorAll('[data-list] table tbody tr[data-id]')];
          const idxAfter = rowsAfterMove.findIndex((r) => r.dataset.id === newRow.dataset.id);
          record(idxAfter < idxBefore, 'Reorder "move up" repositions the item in the list',
            `was ${idxBefore}, now ${idxAfter}`);
        }

        // search/filter
        const searchBox = doc.querySelector('[data-search]');
        searchBox.value = svcName;
        searchBox.dispatchEvent(new w.Event('input', { bubbles: true }));
        const filtered = await until(() => {
          const rows = [...doc.querySelectorAll('[data-list] table tbody tr[data-id]')];
          return rows.length === 1 && rows[0].textContent.includes(svcName);
        }, 8000);
        record(filtered, 'Services search filters the list to the matching item');
        searchBox.value = '';
        searchBox.dispatchEvent(new w.Event('input', { bubbles: true }));
        await until(() => doc.querySelectorAll('[data-list] table tbody tr[data-id]').length >= 1, 8000);

        // cleanup: delete the disposable test row via the confirm dialog
        const rowToDelete = [...doc.querySelectorAll('[data-list] table tbody tr[data-id]')]
          .find((r) => r.dataset.id === newRow.dataset.id);
        rowToDelete?.querySelector('[data-act="delete"]').click();
        const confirmOpen = await until(() => doc.querySelector('.modal-backdrop [data-confirm]'), 5000);
        if (confirmOpen) doc.querySelector('.modal-backdrop [data-confirm]').click();
        const deleted = await until(() =>
          ![...doc.querySelectorAll('[data-list] table tbody tr[data-id]')].some((r) => r.dataset.id === newRow.dataset.id), 8000);
        record(deleted, 'Delete action removes the test item via the confirm dialog');
      } else {
        record(false, 'Could not locate newly created service row to verify the save round-trip');
      }
    }
  }

  // ---- Gallery collection: different field shape, sanity pass ----
  doc.querySelector('#contentTabs [data-tab="gallery"]')?.click();
  const galleryRendered = await until(() =>
    doc.querySelector('[data-list] table tbody tr') || doc.querySelector('[data-list] .empty'), 12000);
  record(galleryRendered, 'Content manager Gallery tab renders its list');

  doc.querySelector('[data-add]')?.click();
  const galleryModalOpen = await until(() => doc.querySelector('.modal-backdrop #collForm'), 8000);
  record(galleryModalOpen, 'Gallery "New" modal opens with a form');
  if (galleryModalOpen) {
    const gForm = doc.querySelector('#collForm');
    record(['title', 'category', 'imageUrl', 'alt', 'sortOrder'].every((f) => gForm.elements[f]),
      'Gallery form exposes its configured fields');
    doc.querySelector('.modal-backdrop [data-close]')?.click();
    await wait(80);
  }

  // media library renders tiles
  w.location.hash = '#/media';
  const mediaReady = await until(() => doc.querySelector('.media-tile') || doc.querySelector('.empty'), 12000);
  record(!!mediaReady, 'Media library renders tiles or empty state');

  // accessibility sweep
  w.location.hash = '#/customers';
  await until(() => doc.querySelector('#rows tr[data-id]'));
  const unlabelled = [...doc.querySelectorAll('#view button')].filter((b) =>
    !b.textContent.trim() && !b.getAttribute('aria-label') && !b.getAttribute('title'));
  record(unlabelled.length === 0, 'All icon-only buttons have accessible names',
    unlabelled.length ? `${unlabelled.length} unlabelled` : '');
  const inputsMissingLabels = [...doc.querySelectorAll('#view input, #view select')].filter((i) => {
    if (i.type === 'checkbox' && i.closest('label')) return false;
    if (i.getAttribute('aria-label')) return false;
    return !(i.id && doc.querySelector(`label[for="${i.id}"]`));
  });
  record(inputsMissingLabels.length === 0, 'All form controls are labelled',
    inputsMissingLabels.length ? `${inputsMissingLabels.length} unlabelled` : '');

  record(consoleErrors.length === 0, 'No uncaught JavaScript errors during the session',
    consoleErrors.slice(0, 2).join(' | '));

  dom.window.close();
  server.close();
  await prisma.$disconnect();
  report();
}

function report() {
  const pass = results.filter((r) => r[0] === 'PASS').length;
  console.log('\nUI verification\n===============');
  for (const [state, name] of results) console.log(`  ${state === 'PASS' ? '✔' : '✘'} ${name}`);
  console.log(`\n${pass}/${results.length} checks passed${failures ? ` — ${failures} FAILED` : ''}\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
