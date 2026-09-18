const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const EXCLUDED_DIRS = new Set(['.git', 'admin', 'backend', 'node_modules']);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.html?$/i.test(entry.name)) out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const failures = [];

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);
  const seoTags = text.match(/<(?:link[^>]+rel=["']canonical["'][^>]*|meta[^>]+(?:property|name)=["'](?:og:url|twitter:url)["'][^>]*|link[^>]+rel=["']canonical["'][^>]*)>/gi) || [];
  for (const tag of seoTags) {
    if (/https:\/\/www\.ndsairconditioning\.com/i.test(tag)) {
      failures.push(rel + ': ' + tag);
    }
  }
}

assert.deepStrictEqual(failures, [], 'Found www canonical/URL SEO references:\n' + failures.join('
'));
console.log('SEO canonical host checks passed for ' + files.length + ' public HTML files.');
