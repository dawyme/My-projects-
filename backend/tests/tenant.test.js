const assert = require('assert');
const { roleFor, ROLE } = require('../src/lib/permissions');
const { authorize } = require('../src/middleware/auth');

function run() {
  assert.strictEqual(roleFor({ role: 'ADMIN', businessId: 'tenant-a' }), ROLE.TENANT_ADMIN);
  assert.strictEqual(roleFor({ role: 'ADMIN', businessId: null }), ROLE.SUPER_ADMIN);
  assert.notStrictEqual(roleFor({ role: 'ADMIN', businessId: 'tenant-a' }), ROLE.SUPER_ADMIN);

  let tenantNext = false;
  let tenantError = null;
  authorize('TENANT_ADMIN')(
    { user: { role: 'ADMIN', businessId: 'tenant-a' } },
    {},
    (err) => { tenantError = err || null; tenantNext = !err; }
  );
  assert.strictEqual(tenantError, null);
  assert.strictEqual(tenantNext, true);

  let platformNext = false;
  let platformError = null;
  authorize('TENANT_ADMIN')(
    { user: { role: 'ADMIN', businessId: null } },
    {},
    (err) => { platformError = err || null; platformNext = !err; }
  );
  assert.ok(platformError);
  assert.strictEqual(platformNext, false);

  console.log('Tenant role contract: PASS');
}
try { run(); } catch (err) { console.error('Tenant role contract: FAIL', err.stack || err); process.exitCode = 1; }
