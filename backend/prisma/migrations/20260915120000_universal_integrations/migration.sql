-- Universal Banking & Payment Integration Framework (Phase 1).
-- Tenant-scoped provider connection registry + secret-scrubbed event log.
-- No existing table is altered; no data is modified.

-- CreateTable
CREATE TABLE "IntegrationConnection" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL DEFAULT 'default',
    "providerId" TEXT NOT NULL,
    "providerCategory" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "authType" TEXT NOT NULL DEFAULT 'NONE',
    "connectionMethod" TEXT,
    "config" TEXT,
    "credentialsCipher" TEXT,
    "credentialFields" TEXT,
    "capabilities" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NOT_CONNECTED',
    "webhookToken" TEXT NOT NULL,
    "lastTestedAt" TIMESTAMP(3),
    "lastConnectedAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncStatus" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IntegrationConnection_webhookToken_key" ON "IntegrationConnection"("webhookToken");
CREATE UNIQUE INDEX "IntegrationConnection_businessId_name_key" ON "IntegrationConnection"("businessId", "name");
CREATE INDEX "IntegrationConnection_businessId_idx" ON "IntegrationConnection"("businessId");
CREATE INDEX "IntegrationConnection_providerId_idx" ON "IntegrationConnection"("providerId");
CREATE INDEX "IntegrationConnection_status_idx" ON "IntegrationConnection"("status");

-- CreateTable
CREATE TABLE "IntegrationEvent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL DEFAULT 'default',
    "connectionId" TEXT,
    "providerId" TEXT,
    "operation" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL DEFAULT false,
    "externalReference" TEXT,
    "errorCategory" TEXT,
    "errorMessage" TEXT,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "IntegrationEvent_businessId_idx" ON "IntegrationEvent"("businessId");
CREATE INDEX "IntegrationEvent_connectionId_idx" ON "IntegrationEvent"("connectionId");
CREATE INDEX "IntegrationEvent_operation_idx" ON "IntegrationEvent"("operation");
CREATE INDEX "IntegrationEvent_createdAt_idx" ON "IntegrationEvent"("createdAt");

-- Foreign keys (PostgreSQL; the SQLite runner skips ALTER … ADD CONSTRAINT)
ALTER TABLE "IntegrationConnection" ADD CONSTRAINT "IntegrationConnection_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IntegrationEvent" ADD CONSTRAINT "IntegrationEvent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IntegrationEvent" ADD CONSTRAINT "IntegrationEvent_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
