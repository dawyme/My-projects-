-- Preserve estimate/invoice tax rates, discounts, notes, and source estimate linkage.
ALTER TABLE "Estimate" ADD COLUMN "taxRate" REAL NOT NULL DEFAULT 0;
ALTER TABLE "Invoice" ADD COLUMN "taxRate" REAL NOT NULL DEFAULT 0;
ALTER TABLE "Invoice" ADD COLUMN "discount" REAL NOT NULL DEFAULT 0;
ALTER TABLE "Invoice" ADD COLUMN "notes" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "estimateId" TEXT;
CREATE UNIQUE INDEX "Invoice_estimateId_key" ON "Invoice"("estimateId");
