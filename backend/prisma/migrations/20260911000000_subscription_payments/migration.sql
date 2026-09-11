-- Durable SaaS subscription payment state.
-- This migration is committed for deployment but is NOT applied to production by this change.
CREATE TABLE "SubscriptionPayment" (
  "id" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "businessId" TEXT NOT NULL REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "planId" TEXT NOT NULL REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "amount" DOUBLE PRECISION NOT NULL,
  "currency" TEXT NOT NULL,
  "paymentMethod" TEXT NOT NULL,
  "gatewayReference" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "paidAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SubscriptionPayment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SubscriptionPayment_reference_key" ON "SubscriptionPayment"("reference");
CREATE UNIQUE INDEX "SubscriptionPayment_paymentMethod_gatewayReference_key" ON "SubscriptionPayment"("paymentMethod", "gatewayReference");
CREATE INDEX "SubscriptionPayment_businessId_idx" ON "SubscriptionPayment"("businessId");
CREATE INDEX "SubscriptionPayment_planId_idx" ON "SubscriptionPayment"("planId");
CREATE INDEX "SubscriptionPayment_status_idx" ON "SubscriptionPayment"("status");
CREATE INDEX "SubscriptionPayment_gatewayReference_idx" ON "SubscriptionPayment"("gatewayReference");
