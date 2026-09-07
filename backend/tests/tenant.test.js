const assert = require('assert');
const { roleFor, ROLE } = require('../src/lib/permissions');
const { authorize } = require('../src/middleware/auth');

function run() {
  assert.strictEqual(roleFor({ role: 'ADMIN', businessId: 'tenant-a' }), ROLE.TENANT_ADMIN);
  assert.strictEqual(roleFor({ role: 'ADMIN', businessId: null }), ROLE.SUPER_ADMIN);
  assert.notStrictEqual(roleFor({ role: 'ADMIN', businessId: 'tenant-a' }), ROLE.SUPER_ADMIN);

  let tenantNext = false;
  authorize('TENANT_ADMIN')({ user: { role: 'ADMIN', businessId: 'tenant-a' } }, {}, () => { tenantNext = true; });
  assert.strictEqual(tenantNext, true);

  let platformNext = false;
  authorize('TENANT_ADMIN')({ user: { role: 'ADMIN', businessId: null } }, {}, () => { platformNext = true; });
  assert.strictEqual(platformNext, false);
  console.log('Tenant role contract: PASS');
}
try { run(); } catch (err) { console.error('Tenant role contract: FAIL', err.stack || err); process.exitCode = 1; }
