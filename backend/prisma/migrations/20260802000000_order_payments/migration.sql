-- Order payment tracking (storefront checkout + payment gateways)
-- Dialect notes: written with types accepted by both PostgreSQL (Supabase,
-- where the schema is also synced via `prisma db push`) and SQLite (local
-- offline test/dev runner in prisma/migrate.js).

-- Payment method: CASH_ON_DELIVERY | BANK_TRANSFER | STRIPE | PAYPAL | WIPAY | TILOPAY
ALTER TABLE "Order" ADD COLUMN "paymentMethod" TEXT NOT NULL DEFAULT 'CASH_ON_DELIVERY';

-- Payment status: PENDING | PAID | FAILED | REFUNDED
ALTER TABLE "Order" ADD COLUMN "paymentStatus" TEXT NOT NULL DEFAULT 'PENDING';

-- Gateway transaction / session id (PaymentIntent id, PayPal capture id, …)
ALTER TABLE "Order" ADD COLUMN "paymentReference" TEXT;

-- When the payment was captured
ALTER TABLE "Order" ADD COLUMN "paidAt" TIMESTAMP(3);

-- Storefront shipping / contact details captured at checkout
ALTER TABLE "Order" ADD COLUMN "shippingName" TEXT;
ALTER TABLE "Order" ADD COLUMN "shippingPhone" TEXT;
ALTER TABLE "Order" ADD COLUMN "shippingAddress" TEXT;
ALTER TABLE "Order" ADD COLUMN "shippingCity" TEXT;
ALTER TABLE "Order" ADD COLUMN "notes" TEXT;

CREATE INDEX "Order_paymentMethod_idx" ON "Order"("paymentMethod");
CREATE INDEX "Order_paymentStatus_idx" ON "Order"("paymentStatus");
