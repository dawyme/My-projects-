#!/usr/bin/env node
/**
 * Production build verification.
 *
 * 1. Boots the Express app so every route module is loaded (catches require /
 *    syntax errors across the API).
 * 2. Bundles every admin SPA page with esbuild (catches syntax errors in the
 *    dashboard's ES modules).
 *
 * Root-absolute browser imports (e.g. "/admin/js/api.js") resolve against the
 * repository root, matching how Express serves static files in production.
 * The esbuild resolver plugin maps those web-root specifiers to on-disk paths
 * so the bundle step sees the same module graph as the browser.
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
const esbuild = require('esbuild');

/**
 * Resolves root-relative web imports to on-disk paths under ROOT, matching
 * how Express serves static files in production. Browser code uses
 * single-leading-slash paths like "/admin/js/api.js"; esbuild has no web
 * root so we intercept imports whose first segment names a project
 * directory or a root-level .js/.mjs/.css file. Absolute filesystem paths
 * produced by esbuild (starting with ROOT) and protocol-relative URLs
 * ("//host/...") are excluded by the filter.
 */
const WEB_ROOT_DIRS = 'admin|tenant|technician|customer|superadmin|assets|auth';
const ROOT_FILE_RE = '\\/[a-zA-Z0-9._-]+\\.(?:js|mjs|css)(?:$|[?#])';
const rootResolverPlugin = {
  name: 'root-absolute-resolver',
  setup(build) {
    build.onResolve({
      filter: new RegExp(`^\\/(?:${WEB_ROOT_DIRS})(?:\\/|$)|^${ROOT_FILE_RE}`),
    }, (args) => {
      if (args.path.startsWith(ROOT)) return null;
      const clean = args.path.split('?')[0].split('#')[0];
      const candidates = [
        path.join(ROOT, clean),
        path.join(ROOT, clean) + '.js',
        path.join(ROOT, clean, 'index.js'),
      ];
      for (const c of candidates) {
        if (fs.existsSync(c)) return { path: c };
      }
      return null;
    });
  },
};

async function bundleFile(file) {
  const html = fs.readFileSync(path.join(ADMIN_DIR, file), 'utf8');
  const match = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  if (!match) return { file, ok: true, reason: '(no module script)' };
  const entryPath = path.join(ADMIN_DIR, `.verify-build-${file.replace('.html', '')}.js`);
  fs.writeFileSync(entryPath, match[1]);
  try {
    await esbuild.build({
      entryPoints: [entryPath], bundle: true, write: false,
      format: 'iife', platform: 'browser', target: 'es2020',
      plugins: [rootResolverPlugin],
      logLevel: 'silent',
    });
    return { file, ok: true };
  } catch (e) {
    const msg = e.errors && e.errors[0] ? e.errors[0].text : e.message;
    return { file, ok: false, reason: msg };
  } finally {
    try { fs.unlinkSync(entryPath); } catch (_) {}
  }
}

(async () => {
  const entries = fs.readdirSync(ADMIN_DIR).filter((f) => f.endsWith('.html')).sort();
  for (const file of entries) {
    const r = await bundleFile(file);
    if (r.ok) pass(`${file}${r.reason ? ' ' + r.reason : ' bundles cleanly'}`);
    else fail(`${file}: ${r.reason}`);
  }
  console.log(failed ? '\nBuild verification FAILED.\n' : '\nBuild verification passed.\n');
  process.exit(failed ? 1 : 0);
})();
