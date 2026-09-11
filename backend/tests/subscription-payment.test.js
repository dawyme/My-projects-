const assert = require('assert');
const fs = require('fs');
const path = require('path');

const routeSource = fs.readFileSync(path.join(__dirname, '../src/routes/tenant.js'), 'utf8');

function fakeTx() {
  const calls = [];
  return {
    calls,
    subscriptionPayment: {
      update: async (args) => { calls.push(['subscriptionPayment.update', args]); return args.data; },
    },
    subscription: {
      upsert: async (args) => { calls.push(['subscription.upsert', args]); return { id: 'sub-1', ...args.create }; },
    },
    business: {
      update: async (args) => { calls.push(['business.update', args]); return args.data; },
    },
  };
}

async function run() {
  const billing = require('../src/lib/subscription-billing');

  assert.ok(routeSource.includes("router.post('/subscription/checkout'"), 'tenant checkout endpoint must exist');
  assert.ok(!routeSource.includes("router.post('/subscription',"), 'legacy direct-activation endpoint must be removed');

  const pending = billing.createPendingSubscriptionPayment({
    businessId: 'tenant-a',
    planId: 'plan-pro',
    amount: 149.99,
    currency: 'USD',
    paymentMethod: 'STRIPE',
  });
  assert.strictEqual(pending.businessId, 'tenant-a');
  assert.strictEqual(pending.planId, 'plan-pro');
  assert.strictEqual(pending.amount, 149.99);
  assert.strictEqual(pending.currency, 'USD');
  assert.strictEqual(pending.status, 'PENDING');
  assert.match(pending.reference, /^SUB-/);

  assert.strictEqual(billing.validateGatewayPayment(pending, {
    paid: true, amount: 149.99, currency: 'USD', transactionId: 'pi_123',
  }).ok, true);

  assert.strictEqual(billing.validateGatewayPayment(pending, {
    paid: true, amount: 149.98, currency: 'USD', transactionId: 'pi_bad_amount',
  }).ok, false, 'gateway amount mismatch must be rejected');

  assert.strictEqual(billing.validateGatewayPayment(pending, {
    paid: true, amount: 149.99, currency: 'EUR', transactionId: 'pi_bad_currency',
  }).ok, false, 'gateway currency mismatch must be rejected');

  const tx = fakeTx();
  await billing.activatePaidSubscription(tx, {
    ...pending,
    id: 'payment-1',
  }, 'pi_123');
  assert.ok(tx.calls.some(([name]) => name === 'subscriptionPayment.update'));
  assert.ok(tx.calls.some(([name]) => name === 'subscription.upsert'));
  assert.ok(tx.calls.some(([name]) => name === 'business.update'));

  console.log('Subscription payment gating contracts: PASS');
}

run().catch((err) => {
  console.error('Subscription payment gating contracts: FAIL', err.stack || err);
  process.exitCode = 1;
});
