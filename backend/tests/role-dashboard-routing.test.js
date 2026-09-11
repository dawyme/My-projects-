const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../../role-auth.js'), 'utf8');
assert.ok(source.includes("SUPER_ADMIN: '/superadmin/'"), 'SUPER_ADMIN must route to the platform dashboard');
assert.ok(!source.includes("SUPER_ADMIN: '/admin/'"), 'SUPER_ADMIN must not route to the tenant/admin shell');

const layout = fs.readFileSync(path.join(__dirname, '../../admin/js/layout.js'), 'utf8');
for (const label of ['Dashboard', 'Reports', 'Customers', 'Products', 'Service Bookings', 'Orders', 'Point of Sale', 'Team', 'Settings', 'Plans & Subscription']) {
  assert.ok(layout.includes(`label: '${label}'`), `tenant navigation must include ${label}`);
}
assert.ok(layout.includes("platformOnly: true"), 'platform-only navigation must remain explicitly gated');

console.log('Role dashboard routing contract: PASS');
