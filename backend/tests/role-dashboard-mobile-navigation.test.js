const assert = require('assert');
const fs = require('fs');
const path = require('path');

for (const role of ['technician', 'customer']) {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', role, 'index.html'), 'utf8');
  assert.match(html, /class=\"role-mobile-nav-toggle\"/, `${role} dashboard must provide a mobile navigation toggle`);
  assert.match(html, /class=\"role-mobile-nav\"/, `${role} dashboard must provide a mobile navigation container`);
}

const css = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'css', 'role-dashboard.css'), 'utf8');
assert.match(css, /\.role-mobile-nav-toggle\{/, 'role dashboard CSS must define the mobile navigation toggle');
assert.match(css, /\.role-mobile-nav\{/, 'role dashboard CSS must define the mobile navigation container');
assert.doesNotMatch(css, /@media\(max-width:900px\)\{[^}]*\.role-sidebar\{display:none\}/, 'mobile breakpoint must not hide role navigation without a replacement');
console.log('role dashboard mobile navigation contract: PASS');
