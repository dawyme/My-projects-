const assert = require('assert');
const { ROLE, roleFor, hasPermission, PERMISSIONS } = require('../src/lib/permissions');
const { tenantWhere } = require('../src/lib/tenant');
function run() {
  assert.strictEqual(roleFor({ role: 'ADMIN', businessId: null }), ROLE.SUPER_ADMIN);
  assert.strictEqual(roleFor({ role: 'ADMIN', businessId: 'biz-a' }), ROLE.TENANT_ADMIN);
  assert.strictEqual(roleFor({ role: 'STAFF', businessId: 'biz-a' }), ROLE.TECHNICIAN);
  assert.strictEqual(roleFor({ role: 'CUSTOMER', businessId: 'biz-a' }), ROLE.CUSTOMER);
  assert.strictEqual(roleFor({ role: 'TECHNICIAN', businessId: 'biz-a' }), ROLE.TECHNICIAN);
  assert.strictEqual(roleFor({ role: 'TENANT_ADMIN', businessId: 'biz-a' }), ROLE.TENANT_ADMIN);
  assert.strictEqual(roleFor({ role: 'SUPER_ADMIN', businessId: null }), ROLE.SUPER_ADMIN);
  assert.ok(PERMISSIONS[ROLE.SUPER_ADMIN].includes('tenants.manage'));
  assert.ok(PERMISSIONS[ROLE.TENANT_ADMIN].includes('customers.manage'));
  assert.ok(PERMISSIONS[ROLE.TECHNICIAN].includes('jobs.manage'));
  assert.ok(PERMISSIONS[ROLE.CUSTOMER].includes('bookings.create'));
  assert.strictEqual(hasPermission({ role: 'ADMIN', businessId: null }, 'tenants.manage'), true);
  assert.strictEqual(hasPermission({ role: 'ADMIN', businessId: 'biz-a' }, 'tenants.manage'), false);
  assert.strictEqual(hasPermission({ role: 'STAFF', businessId: 'biz-a' }, 'jobs.manage'), true);
  assert.strictEqual(hasPermission({ role: 'STAFF', businessId: 'biz-a' }, 'billing.manage'), false);
  assert.strictEqual(hasPermission({ role: 'CUSTOMER', businessId: 'biz-a' }, 'customers.manage'), false);
  assert.strictEqual(hasPermission({ role: 'CUSTOMER', businessId: 'biz-a' }, 'bookings.create'), true);
  const scoped = tenantWhere({ tenantId: 'biz-a' }, { id: 'record-1', businessId: 'biz-b' });
  assert.strictEqual(scoped.businessId, 'biz-a');
  assert.strictEqual(scoped.id, 'record-1');
  console.log('RBAC contract: PASS');
}
try { run(); } catch (err) { console.error('RBAC contract: FAIL', err.stack || err); process.exitCode = 1; }
