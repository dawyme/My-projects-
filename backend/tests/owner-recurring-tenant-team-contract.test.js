const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { teamUserWhere } = require('../src/lib/tenant');
const { roleFor, ROLE } = require('../src/lib/permissions');

function run() {
  // Tenant team roster must be strictly limited to the caller's business.
  assert.deepStrictEqual(
    teamUserWhere({ tenantId: 'tenant-a', user: { role: 'ADMIN', businessId: 'tenant-a' } }),
    { businessId: 'tenant-a' }
  );

  // Platform owner retains the platform-wide roster rather than becoming tenant-scoped.
  assert.strictEqual(
    teamUserWhere({ tenantId: 'default', user: { role: 'ADMIN', businessId: null } }),
    undefined
  );
  assert.strictEqual(roleFor({ role: 'ADMIN', businessId: null }), ROLE.SUPER_ADMIN);

  // Recurring maintenance is operationally available to the owner dashboard too.
  const layout = fs.readFileSync(path.join(__dirname, '../../admin/js/layout.js'), 'utf8');
  const navEntry = layout.match(/\{ path: '\/recurring-maintenance'[^}]*\}/)?.[0];
  assert.ok(navEntry, 'recurring maintenance navigation entry must exist');
  assert.ok(!/tenantOnly\s*:\s*true/.test(navEntry), 'recurring maintenance must not be tenant-only');

  // Tenant Team must explicitly expose the existing STAFF role as technician/field staff.
  const usersPage = fs.readFileSync(path.join(__dirname, '../../admin/js/pages/users.js'), 'utf8');
  assert.match(usersPage, /Technician/i, 'tenant Team UI must identify STAFF as a technician');

  console.log('Owner recurring + tenant team contracts: PASS');
}

try {
  run();
} catch (error) {
  console.error(`Owner recurring + tenant team contracts: FAIL — ${error.stack || error.message}`);
  process.exitCode = 1;
}
