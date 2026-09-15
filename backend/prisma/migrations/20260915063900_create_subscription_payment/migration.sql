CREATE TABLE "SubscriptionPayment" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "reference" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "amount" DOUBLE PRECISION NOT NULL,
  "currency" TEXT NOT NULL,
  "paymentMethod" TEXT NOT NULL,
  "gatewayReference" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "paidAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SubscriptionPayment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SubscriptionPayment_reference_key" ON "SubscriptionPayment"("reference");
CREATE INDEX "SubscriptionPayment_businessId_idx" ON "SubscriptionPayment"("businessId");
CREATE INDEX "SubscriptionPayment_planId_idx" ON "SubscriptionPayment"("planId");
CREATE INDEX "SubscriptionPayment_status_idx" ON "SubscriptionPayment"("status");
CREATE INDEX "SubscriptionPayment_gatewayReference_idx" ON "SubscriptionPayment"("gatewayReference");
CREATE UNIQUE INDEX "SubscriptionPayment_paymentMethod_gatewayReference_key" ON "SubscriptionPayment"("paymentMethod", "gatewayReference");

ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
