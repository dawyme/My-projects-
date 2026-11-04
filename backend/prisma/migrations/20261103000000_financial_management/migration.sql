-- Financial Management: unified money ledger, expenses and finance audit trail.
-- ADDITIVE ONLY: three new tables, no change to any existing table or column.
CREATE TABLE "FinancialTransaction" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "businessId" TEXT NOT NULL DEFAULT 'default',
  "reference" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'PAYMENT',
  "kind" TEXT NOT NULL DEFAULT 'FULL',
  "status" TEXT NOT NULL DEFAULT 'RECORDED',
  "method" TEXT NOT NULL DEFAULT 'CASH',
  "gateway" TEXT,
  "externalReference" TEXT,
  "idempotencyKey" TEXT,
  "amount" DECIMAL(12,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'TTD',
  "paidAt" TIMESTAMP(3) NOT NULL,
  "estimatedDate" BOOLEAN NOT NULL DEFAULT false,
  "source" TEXT NOT NULL DEFAULT 'MANUAL',
  "customerId" TEXT,
  "invoiceId" TEXT,
  "orderId" TEXT,
  "saleId" TEXT,
  "bookingId" TEXT,
  "relatedTransactionId" TEXT,
  "notes" TEXT,
  "createdById" TEXT,
  "voidedAt" TIMESTAMP(3),
  "voidedById" TEXT,
  "voidReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FinancialTransaction_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "FinancialTransaction_businessId_reference_key" ON "FinancialTransaction"("businessId","reference");
CREATE UNIQUE INDEX "FinancialTransaction_businessId_idempotencyKey_key" ON "FinancialTransaction"("businessId","idempotencyKey");
CREATE UNIQUE INDEX "FinancialTransaction_businessId_gateway_externalReference_key" ON "FinancialTransaction"("businessId","gateway","externalReference");
CREATE INDEX "FinancialTransaction_businessId_paidAt_idx" ON "FinancialTransaction"("businessId","paidAt");
CREATE INDEX "FinancialTransaction_businessId_status_idx" ON "FinancialTransaction"("businessId","status");
CREATE INDEX "FinancialTransaction_invoiceId_idx" ON "FinancialTransaction"("invoiceId");
CREATE INDEX "FinancialTransaction_orderId_idx" ON "FinancialTransaction"("orderId");
CREATE INDEX "FinancialTransaction_saleId_idx" ON "FinancialTransaction"("saleId");
CREATE INDEX "FinancialTransaction_bookingId_idx" ON "FinancialTransaction"("bookingId");
CREATE INDEX "FinancialTransaction_customerId_idx" ON "FinancialTransaction"("customerId");

CREATE TABLE "Expense" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "businessId" TEXT NOT NULL DEFAULT 'default',
  "category" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'TTD',
  "expenseDate" TIMESTAMP(3) NOT NULL,
  "method" TEXT NOT NULL DEFAULT 'CASH',
  "description" TEXT NOT NULL,
  "payee" TEXT,
  "referenceNumber" TEXT,
  "receiptPath" TEXT,
  "receiptMime" TEXT,
  "createdById" TEXT,
  "deletedAt" TIMESTAMP(3),
  "deletedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Expense_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "Expense_businessId_expenseDate_idx" ON "Expense"("businessId","expenseDate");
CREATE INDEX "Expense_businessId_category_idx" ON "Expense"("businessId","category");

CREATE TABLE "FinanceAuditLog" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "businessId" TEXT NOT NULL DEFAULT 'default',
  "userId" TEXT,
  "entity" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "before" TEXT,
  "after" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinanceAuditLog_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "FinanceAuditLog_businessId_entity_entityId_idx" ON "FinanceAuditLog"("businessId","entity","entityId");
CREATE INDEX "FinanceAuditLog_createdAt_idx" ON "FinanceAuditLog"("createdAt");
