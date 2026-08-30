-- Dedicated hybrid POS: counter sales remain separate from online Order records.
CREATE TABLE "Sale" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "businessId" TEXT NOT NULL,
  "saleNumber" TEXT NOT NULL,
  "customerId" TEXT,
  "cashierId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'COMPLETED',
  "paymentMethod" TEXT NOT NULL DEFAULT 'CASH',
  "paymentReference" TEXT,
  "subtotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "tax" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "discount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "total" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "location" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Sale_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Sale_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "Sale_cashierId_fkey" FOREIGN KEY ("cashierId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Sale_businessId_saleNumber_key" ON "Sale"("businessId","saleNumber");
CREATE INDEX "Sale_businessId_idx" ON "Sale"("businessId");
CREATE INDEX "Sale_cashierId_idx" ON "Sale"("cashierId");
CREATE INDEX "Sale_customerId_idx" ON "Sale"("customerId");
CREATE INDEX "Sale_createdAt_idx" ON "Sale"("createdAt");
CREATE INDEX "Sale_status_idx" ON "Sale"("status");

CREATE TABLE "SaleLineItem" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "businessId" TEXT NOT NULL,
  "saleId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "unitPrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "total" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "refundedQty" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SaleLineItem_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SaleLineItem_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SaleLineItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "SaleLineItem_businessId_idx" ON "SaleLineItem"("businessId");
CREATE INDEX "SaleLineItem_saleId_idx" ON "SaleLineItem"("saleId");
CREATE INDEX "SaleLineItem_productId_idx" ON "SaleLineItem"("productId");

CREATE TABLE "SaleRefund" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "businessId" TEXT NOT NULL,
  "saleId" TEXT NOT NULL,
  "refundNumber" TEXT NOT NULL,
  "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "reason" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SaleRefund_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SaleRefund_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SaleRefund_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SaleRefund_businessId_refundNumber_key" ON "SaleRefund"("businessId","refundNumber");
CREATE INDEX "SaleRefund_businessId_idx" ON "SaleRefund"("businessId");
CREATE INDEX "SaleRefund_saleId_idx" ON "SaleRefund"("saleId");
CREATE INDEX "SaleRefund_createdById_idx" ON "SaleRefund"("createdById");

CREATE TABLE "SaleRefundLineItem" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "businessId" TEXT NOT NULL,
  "refundId" TEXT NOT NULL,
  "saleLineItemId" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 0,
  "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  CONSTRAINT "SaleRefundLineItem_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SaleRefundLineItem_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "SaleRefund"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SaleRefundLineItem_saleLineItemId_fkey" FOREIGN KEY ("saleLineItemId") REFERENCES "SaleLineItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "SaleRefundLineItem_businessId_idx" ON "SaleRefundLineItem"("businessId");
CREATE INDEX "SaleRefundLineItem_refundId_idx" ON "SaleRefundLineItem"("refundId");
CREATE INDEX "SaleRefundLineItem_saleLineItemId_idx" ON "SaleRefundLineItem"("saleLineItemId");
