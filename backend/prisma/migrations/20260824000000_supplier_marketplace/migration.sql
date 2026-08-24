-- Global Supplier Marketplace
-- Dialect notes: written with types accepted by both PostgreSQL (Supabase, where
-- the schema is also synced via `prisma db push`) and SQLite (local offline
-- dev/test runner in prisma/migrate.js). Foreign keys are declared as separate
-- ALTER statements — the SQLite runner skips them and Prisma's client-side
-- engine enforces the relations at the application layer.

-- AddColumn: supplier awareness on the existing Product (never inflates owned stock)
ALTER TABLE "Product" ADD COLUMN "fulfillmentType" TEXT NOT NULL DEFAULT 'LOCAL';
ALTER TABLE "Product" ADD COLUMN "supplierStock" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Product" ADD COLUMN "supplierStockAt" TIMESTAMP(3);

-- AddColumn: international shipping destination on the existing Order
ALTER TABLE "Order" ADD COLUMN "shippingCountry" TEXT;
ALTER TABLE "Order" ADD COLUMN "shippingPostalCode" TEXT;

-- AddColumn: how much of each order line came from N&D-owned stock. The rest is
-- dropshipped. Nullable so pre-existing order lines keep working unchanged.
ALTER TABLE "OrderItem" ADD COLUMN "localQuantity" INTEGER;

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT '',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "website" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "contactName" TEXT,
    "accountRef" TEXT,
    "type" TEXT NOT NULL DEFAULT 'GENERAL',
    "fulfillmentType" TEXT NOT NULL DEFAULT 'HYBRID',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "countriesServed" TEXT,
    "blockedCountries" TEXT,
    "shippingMethods" TEXT,
    "leadTimeDays" INTEGER NOT NULL DEFAULT 0,
    "minOrderValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "paymentTerms" TEXT,
    "dropshipEnabled" BOOLEAN NOT NULL DEFAULT true,
    "markupType" TEXT,
    "markupValue" DOUBLE PRECISION,
    "notes" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Supplier_tenantId_code_key" ON "Supplier"("tenantId", "code");
CREATE INDEX "Supplier_tenantId_idx" ON "Supplier"("tenantId");
CREATE INDEX "Supplier_status_idx" ON "Supplier"("status");
CREATE INDEX "Supplier_type_idx" ON "Supplier"("type");

-- CreateTable
CREATE TABLE "SupplierIntegration" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "supplierId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "connectorType" TEXT NOT NULL,
    "baseUrl" TEXT,
    "authType" TEXT NOT NULL DEFAULT 'NONE',
    "config" TEXT,
    "credentialsCipher" TEXT,
    "credentialFields" TEXT,
    "capabilities" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NOT_CONNECTED',
    "lastTestedAt" TIMESTAMP(3),
    "lastConnectedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "syncEnabled" BOOLEAN NOT NULL DEFAULT false,
    "syncIntervalMinutes" INTEGER NOT NULL DEFAULT 0,
    "syncTypes" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierIntegration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SupplierIntegration_supplierId_key" ON "SupplierIntegration"("supplierId");
CREATE INDEX "SupplierIntegration_tenantId_idx" ON "SupplierIntegration"("tenantId");
CREATE INDEX "SupplierIntegration_status_idx" ON "SupplierIntegration"("status");

-- CreateTable
CREATE TABLE "SupplierProduct" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "supplierId" TEXT NOT NULL,
    "supplierSku" TEXT NOT NULL,
    "manufacturerPart" TEXT,
    "upc" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "brand" TEXT,
    "categoryText" TEXT,
    "categoryId" TEXT,
    "supplierCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "msrp" DOUBLE PRECISION,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "stockStatus" TEXT,
    "imageUrl" TEXT,
    "gallery" TEXT,
    "specs" TEXT,
    "weightKg" DOUBLE PRECISION,
    "lengthCm" DOUBLE PRECISION,
    "widthCm" DOUBLE PRECISION,
    "heightCm" DOUBLE PRECISION,
    "restricted" BOOLEAN NOT NULL DEFAULT false,
    "restrictionType" TEXT,
    "restrictionNotes" TEXT,
    "documentationRequired" TEXT,
    "allowedCountries" TEXT,
    "blockedCountries" TEXT,
    "allowedShippingMethods" TEXT,
    "fulfillmentType" TEXT,
    "priceOverride" DOUBLE PRECISION,
    "markupOverrideType" TEXT,
    "markupOverrideValue" DOUBLE PRECISION,
    "sellingPrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "markupApplied" TEXT,
    "syncStatus" TEXT NOT NULL DEFAULT 'NEW',
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "mappingStatus" TEXT NOT NULL DEFAULT 'UNMAPPED',
    "published" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierProduct_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SupplierProduct_tenantId_supplierId_supplierSku_key" ON "SupplierProduct"("tenantId", "supplierId", "supplierSku");
CREATE INDEX "SupplierProduct_tenantId_idx" ON "SupplierProduct"("tenantId");
CREATE INDEX "SupplierProduct_supplierId_idx" ON "SupplierProduct"("supplierId");
CREATE INDEX "SupplierProduct_published_idx" ON "SupplierProduct"("published");
CREATE INDEX "SupplierProduct_syncStatus_idx" ON "SupplierProduct"("syncStatus");

-- CreateTable
CREATE TABLE "SupplierProductMapping" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "supplierId" TEXT NOT NULL,
    "supplierProductId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "supplierSku" TEXT NOT NULL,
    "matchKey" TEXT NOT NULL DEFAULT 'SKU',
    "source" TEXT NOT NULL DEFAULT 'AUTO',
    "confidence" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierProductMapping_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SupplierProductMapping_supplierProductId_key" ON "SupplierProductMapping"("supplierProductId");
CREATE UNIQUE INDEX "SupplierProductMapping_tenantId_productId_key" ON "SupplierProductMapping"("tenantId", "productId");
CREATE INDEX "SupplierProductMapping_supplierId_idx" ON "SupplierProductMapping"("supplierId");

-- CreateTable
CREATE TABLE "SupplierCatalogImport" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "supplierId" TEXT NOT NULL,
    "integrationId" TEXT,
    "source" TEXT NOT NULL,
    "filename" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PREVIEWING',
    "rowsRead" INTEGER NOT NULL DEFAULT 0,
    "rowsCreated" INTEGER NOT NULL DEFAULT 0,
    "rowsUpdated" INTEGER NOT NULL DEFAULT 0,
    "rowsUnchanged" INTEGER NOT NULL DEFAULT 0,
    "rowsFailed" INTEGER NOT NULL DEFAULT 0,
    "preview" TEXT,
    "errorLog" TEXT,
    "committedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierCatalogImport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupplierCatalogImport_tenantId_idx" ON "SupplierCatalogImport"("tenantId");
CREATE INDEX "SupplierCatalogImport_supplierId_idx" ON "SupplierCatalogImport"("supplierId");
CREATE INDEX "SupplierCatalogImport_status_idx" ON "SupplierCatalogImport"("status");

-- CreateTable
CREATE TABLE "SupplierSync" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "supplierId" TEXT NOT NULL,
    "integrationId" TEXT,
    "type" TEXT NOT NULL DEFAULT 'FULL',
    "trigger" TEXT NOT NULL DEFAULT 'MANUAL',
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "inventoryUpdates" INTEGER NOT NULL DEFAULT 0,
    "priceUpdates" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "errorLog" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "parentSyncId" TEXT,
    "batch" INTEGER NOT NULL DEFAULT 100,
    "cursor" TEXT,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierSync_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupplierSync_tenantId_idx" ON "SupplierSync"("tenantId");
CREATE INDEX "SupplierSync_supplierId_idx" ON "SupplierSync"("supplierId");
CREATE INDEX "SupplierSync_status_idx" ON "SupplierSync"("status");
CREATE INDEX "SupplierSync_startedAt_idx" ON "SupplierSync"("startedAt");

-- CreateTable
CREATE TABLE "SupplierSyncLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "syncId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "supplierProductId" TEXT,
    "sku" TEXT,
    "action" TEXT NOT NULL,
    "field" TEXT,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierSyncLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupplierSyncLog_syncId_idx" ON "SupplierSyncLog"("syncId");
CREATE INDEX "SupplierSyncLog_supplierId_idx" ON "SupplierSyncLog"("supplierId");
CREATE INDEX "SupplierSyncLog_action_idx" ON "SupplierSyncLog"("action");

-- CreateTable
CREATE TABLE "SupplierFulfillment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "supplierId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "supplierOrderId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "fulfillmentType" TEXT NOT NULL DEFAULT 'SUPPLIER_FULFILLED',
    "transmissionMethod" TEXT NOT NULL DEFAULT 'MANUAL',
    "transmissionStatus" TEXT NOT NULL DEFAULT 'NOT_SENT',
    "transmissionRef" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "submittedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "shippedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "trackingNumber" TEXT,
    "carrier" TEXT,
    "trackingUrl" TEXT,
    "shipTo" TEXT,
    "shippingMethod" TEXT,
    "shippingCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "totalCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierFulfillment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SupplierFulfillment_tenantId_orderId_supplierId_key" ON "SupplierFulfillment"("tenantId", "orderId", "supplierId");
CREATE INDEX "SupplierFulfillment_tenantId_idx" ON "SupplierFulfillment"("tenantId");
CREATE INDEX "SupplierFulfillment_status_idx" ON "SupplierFulfillment"("status");
CREATE INDEX "SupplierFulfillment_orderId_idx" ON "SupplierFulfillment"("orderId");

-- CreateTable
CREATE TABLE "SupplierFulfillmentItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "fulfillmentId" TEXT NOT NULL,
    "supplierProductId" TEXT,
    "productId" TEXT,
    "supplierSku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unitPrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "trackingNumber" TEXT,

    CONSTRAINT "SupplierFulfillmentItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupplierFulfillmentItem_fulfillmentId_idx" ON "SupplierFulfillmentItem"("fulfillmentId");
CREATE INDEX "SupplierFulfillmentItem_supplierProductId_idx" ON "SupplierFulfillmentItem"("supplierProductId");

-- CreateTable
CREATE TABLE "SupplierShippingRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "scope" TEXT NOT NULL DEFAULT 'SUPPLIER',
    "name" TEXT NOT NULL,
    "supplierId" TEXT,
    "supplierProductId" TEXT,
    "categoryId" TEXT,
    "countries" TEXT,
    "excludedCountries" TEXT,
    "regions" TEXT,
    "method" TEXT NOT NULL DEFAULT 'STANDARD',
    "methodName" TEXT NOT NULL DEFAULT 'Standard shipping',
    "carrier" TEXT,
    "baseCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "perKgCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "perItemCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "freeOverAmount" DOUBLE PRECISION,
    "minDays" INTEGER NOT NULL DEFAULT 0,
    "maxDays" INTEGER NOT NULL DEFAULT 0,
    "restricted" BOOLEAN NOT NULL DEFAULT false,
    "restrictionNote" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierShippingRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupplierShippingRule_tenantId_idx" ON "SupplierShippingRule"("tenantId");
CREATE INDEX "SupplierShippingRule_supplierId_idx" ON "SupplierShippingRule"("supplierId");
CREATE INDEX "SupplierShippingRule_scope_idx" ON "SupplierShippingRule"("scope");
CREATE INDEX "SupplierShippingRule_isActive_idx" ON "SupplierShippingRule"("isActive");

-- CreateTable
CREATE TABLE "SupplierMarkupRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "scope" TEXT NOT NULL DEFAULT 'CATEGORY',
    "categoryId" TEXT,
    "markupType" TEXT NOT NULL DEFAULT 'PERCENT',
    "markupValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "roundTo" DOUBLE PRECISION,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierMarkupRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupplierMarkupRule_tenantId_idx" ON "SupplierMarkupRule"("tenantId");
CREATE INDEX "SupplierMarkupRule_scope_idx" ON "SupplierMarkupRule"("scope");
CREATE INDEX "SupplierMarkupRule_categoryId_idx" ON "SupplierMarkupRule"("categoryId");

-- Foreign keys (PostgreSQL; the SQLite runner skips ALTER … ADD CONSTRAINT)
ALTER TABLE "SupplierIntegration" ADD CONSTRAINT "SupplierIntegration_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupplierProduct" ADD CONSTRAINT "SupplierProduct_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupplierProductMapping" ADD CONSTRAINT "SupplierProductMapping_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupplierProductMapping" ADD CONSTRAINT "SupplierProductMapping_supplierProductId_fkey" FOREIGN KEY ("supplierProductId") REFERENCES "SupplierProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupplierProductMapping" ADD CONSTRAINT "SupplierProductMapping_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupplierCatalogImport" ADD CONSTRAINT "SupplierCatalogImport_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupplierCatalogImport" ADD CONSTRAINT "SupplierCatalogImport_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "SupplierIntegration"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupplierSync" ADD CONSTRAINT "SupplierSync_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupplierSync" ADD CONSTRAINT "SupplierSync_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "SupplierIntegration"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupplierSyncLog" ADD CONSTRAINT "SupplierSyncLog_syncId_fkey" FOREIGN KEY ("syncId") REFERENCES "SupplierSync"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupplierFulfillment" ADD CONSTRAINT "SupplierFulfillment_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupplierFulfillment" ADD CONSTRAINT "SupplierFulfillment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupplierFulfillmentItem" ADD CONSTRAINT "SupplierFulfillmentItem_fulfillmentId_fkey" FOREIGN KEY ("fulfillmentId") REFERENCES "SupplierFulfillment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupplierFulfillmentItem" ADD CONSTRAINT "SupplierFulfillmentItem_supplierProductId_fkey" FOREIGN KEY ("supplierProductId") REFERENCES "SupplierProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupplierShippingRule" ADD CONSTRAINT "SupplierShippingRule_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupplierShippingRule" ADD CONSTRAINT "SupplierShippingRule_supplierProductId_fkey" FOREIGN KEY ("supplierProductId") REFERENCES "SupplierProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;
