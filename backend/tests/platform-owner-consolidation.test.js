const assert = require('assert');
const { buildConsolidationPlan, normalizeEmail } = require('../scripts/consolidate-platform-owner');

function run() {
  assert.strictEqual(normalizeEmail('  Christopher@Example.com '), 'christopher@example.com');

  const plan = buildConsolidationPlan({
    target: { id: 'target', email: 'ndsairconditioning@gmail.com', businessId: 'default', isActive: true },
    legacy: { id: 'legacy', email: 'platform@ndsairconditioning.com', isActive: true },
    ndsBusiness: { id: 'default', isDefault: true, isPlatformOwned: true },
  });
  assert.deepStrictEqual(plan, {
    targetId: 'target',
    legacyId: 'legacy',
    targetEmail: 'ndsairconditioning@gmail.com',
    legacyEmail: 'platform@ndsairconditioning.com',
    targetBusinessIdBefore: 'default',
    legacyWasActive: true,
  });

  assert.throws(() => buildConsolidationPlan({
    target: { id: 'target', email: 'x@example.com', businessId: 'other', isActive: true },
    legacy: { id: 'legacy', email: 'legacy@example.com', isActive: true },
    ndsBusiness: { isPlatformOwned: true },
  }), /non-default business/);

  assert.throws(() => buildConsolidationPlan({
    target: { id: 'target', email: 'x@example.com', businessId: 'default', isActive: true },
    legacy: { id: 'legacy', email: 'legacy@example.com', isActive: true },
    ndsBusiness: { isPlatformOwned: false },
  }), /platform-owned/);

  assert.throws(() => buildConsolidationPlan({
    target: { id: 'target', email: 'x@example.com', businessId: null, isActive: true },
    legacy: { id: 'target', email: 'legacy@example.com', isActive: true },
    ndsBusiness: { isPlatformOwned: true },
  }), /same row/);

  console.log('Platform owner consolidation contract: PASS');
}

try { run(); } catch (err) {
  console.error('Platform owner consolidation contract: FAIL', err.stack || err);
  process.exitCode = 1;
}
