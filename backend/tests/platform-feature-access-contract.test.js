const assert = require('assert');
const { normalizeFeatureKey, resolveFeatureAccess } = require('../src/lib/features');

function run() {
  assert.strictEqual(normalizeFeatureKey('Recurring Maintenance'), 'recurring-maintenance');
  assert.strictEqual(normalizeFeatureKey(' Advanced Reports '), 'advanced-reports');

  const feature = { isActive: true, isCore: false, defaultEnabled: false };
  assert.strictEqual(resolveFeatureAccess({ role: 'SUPER_ADMIN', feature }), true, 'platform owner always has platform feature access');
  assert.strictEqual(resolveFeatureAccess({ role: 'TENANT_ADMIN', feature, access: null }), false, 'tenant feature is disabled until granted');
  assert.strictEqual(resolveFeatureAccess({ role: 'TENANT_ADMIN', feature, access: { enabled: true } }), true, 'tenant feature can be enabled explicitly');
  assert.strictEqual(resolveFeatureAccess({ role: 'TENANT_ADMIN', feature, access: { enabled: false } }), false, 'tenant feature can be disabled explicitly');
  assert.strictEqual(resolveFeatureAccess({ role: 'TENANT_ADMIN', feature: { ...feature, defaultEnabled: true }, access: null }), true, 'default-enabled feature is available when not overridden');
  assert.strictEqual(resolveFeatureAccess({ role: 'TENANT_ADMIN', feature: { ...feature, isCore: true }, access: { enabled: false } }), true, 'core platform features cannot be disabled for tenants');
  assert.strictEqual(resolveFeatureAccess({ role: 'TENANT_ADMIN', feature: { ...feature, isActive: false }, access: { enabled: true } }), false, 'inactive platform features are unavailable');

  console.log('Platform feature access contracts: PASS');
}

run();
