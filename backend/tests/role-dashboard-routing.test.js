const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../../role-auth.js'), 'utf8');
assert.ok(source.includes("SUPER_ADMIN: '/superadmin/'"), 'SUPER_ADMIN must route to the platform dashboard');
assert.ok(!source.includes("SUPER_ADMIN: '/admin/'"), 'SUPER_ADMIN must not route to the tenant/admin shell');
console.log('Role dashboard routing contract: PASS');
