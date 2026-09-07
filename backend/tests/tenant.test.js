const assert = require('assert');
const { roleFor, ROLE } = require('../src/lib/permissions');

function run() {
  assert.strictEqual(roleFor({ role: 'ADMIN', businessId: 'tenant-a' }), ROLE.TENANT_ADMIN);
  assert.strictEqual(roleFor({ role: 'ADMIN', businessId: null }), ROLE.SUPER_ADMIN);
  assert.notStrictEqual(roleFor({ role: 'ADMIN', businessId: 'tenant-a' }), ROLE.SUPER_ADMIN);
  console.log('Tenant role contract: PASS');
}
try { run(); } catch (err) { console.error('Tenant role contract: FAIL', err.stack || err); process.exitCode = 1; }
