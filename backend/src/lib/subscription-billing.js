const crypto = require('crypto');

const round = (value) => Math.round(Number(value) * 100) / 100;

function createReference() {
  return `SUB-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function createPendingSubscriptionPayment({ businessId, planId, amount, currency, paymentMethod }) {
  return {
    reference: createReference(),
    businessId,
    planId,
    amount: round(amount),
    currency: String(currency).toUpperCase(),
    paymentMethod: String(paymentMethod).toUpperCase(),
    status: 'PENDING',
  };
}

function validateGatewayPayment(payment, gateway) {
  if (!gateway || gateway.paid !== true) {
    return { ok: false, reason: 'PAYMENT_NOT_CONFIRMED' };
  }
  if (gateway.amount === undefined || gateway.amount === null || round(gateway.amount) !== round(payment.amount)) {
    return { ok: false, reason: 'AMOUNT_MISMATCH' };
  }
  if (!gateway.currency || String(gateway.currency).toUpperCase() !== String(payment.currency).toUpperCase()) {
    return { ok: false, reason: 'CURRENCY_MISMATCH' };
  }
  if (!gateway.transactionId) {
    return { ok: false, reason: 'MISSING_TRANSACTION_REFERENCE' };
  }
  return { ok: true };
}

async function activatePaidSubscription(tx, payment, transactionId) {
  if (payment.status === 'PAID') {
    return { payment, subscription: await tx.subscription.upsert({
      where: { businessId: payment.businessId },
      update: { planId: payment.planId, status: 'ACTIVE', cancelAtPeriodEnd: false },
      create: { businessId: payment.businessId, planId: payment.planId, status: 'ACTIVE' },
    }) };
  }
  if (payment.status !== 'PENDING') throw new Error('Subscription payment is no longer pending');

  const subscription = await tx.subscription.upsert({
    where: { businessId: payment.businessId },
    update: { planId: payment.planId, status: 'ACTIVE', cancelAtPeriodEnd: false },
    create: { businessId: payment.businessId, planId: payment.planId, status: 'ACTIVE' },
  });
  const updatedPayment = await tx.subscriptionPayment.update({
    where: { id: payment.id },
    data: { status: 'PAID', gatewayReference: transactionId, paidAt: new Date() },
  });
  await tx.business.update({ where: { id: payment.businessId }, data: { status: 'ACTIVE' } });
  return { payment: updatedPayment, subscription };
}

async function failSubscriptionPayment(tx, payment, reason) {
  if (payment.status !== 'PENDING') return payment;
  return tx.subscriptionPayment.update({
    where: { id: payment.id },
    data: { status: 'FAILED', failedAt: new Date() },
  });
}

async function cancelSubscriptionPayment(tx, payment) {
  if (payment.status !== 'PENDING') return payment;
  return tx.subscriptionPayment.update({
    where: { id: payment.id },
    data: { status: 'CANCELLED' },
  });
}

module.exports = {
  round,
  createReference,
  createPendingSubscriptionPayment,
  validateGatewayPayment,
  activatePaidSubscription,
  failSubscriptionPayment,
  cancelSubscriptionPayment,
};
