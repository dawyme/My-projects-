-- Multi-tenant core: Business tenants, per-tenant ownership on every
-- tenant-owned table and per-tenant uniqueness for business keys.
-- PostgreSQL deployments sync through `prisma db push`; this script is the
-- SQLite-compatible delta used by `npm run migrate` for local/test databases.

-- CreateTable
CREATE TABLE "Business" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "taxRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Business_pkey" PRIMARY KEY ("id")
);

-- Add tenant ownership columns (existing rows join the default tenant).
ALTER TABLE "User" ADD COLUMN "businessId" TEXT;
ALTER TABLE "Customer" ADD COLUMN "businessId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "Category" ADD COLUMN "businessId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "Product" ADD COLUMN "businessId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "Service" ADD COLUMN "businessId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "ServiceItem" ADD COLUMN "businessId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "ServiceRequest" ADD COLUMN "businessId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "ServiceRequest" ADD COLUMN "equipmentId" TEXT;
ALTER TABLE "ServiceRequest" ADD COLUMN "serviceId" TEXT;
ALTER TABLE "WorkOrder" ADD COLUMN "businessId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "WorkOrder" ADD COLUMN "customerId" TEXT;
ALTER TABLE "WorkOrder" ADD COLUMN "equipmentId" TEXT;
ALTER TABLE "WorkOrder" ADD COLUMN "technicianId" TEXT;
ALTER TABLE "WorkOrder" ADD COLUMN "bookingId" TEXT;
ALTER TABLE "WorkOrder" ADD COLUMN "priority" TEXT NOT NULL DEFAULT 'NORMAL';
ALTER TABLE "WorkOrder" ADD COLUMN "scheduledAt" TIMESTAMP(3);
ALTER TABLE "WorkOrder" ADD COLUMN "completedAt" TIMESTAMP(3);
ALTER TABLE "WorkOrder" ADD COLUMN "completionNotes" TEXT;
ALTER TABLE "WorkOrder" ADD COLUMN "labour" TEXT;
ALTER TABLE "WorkOrder" ADD COLUMN "parts" TEXT;
ALTER TABLE "Booking" ADD COLUMN "businessId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "BookingNote" ADD COLUMN "businessId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "Order" ADD COLUMN "businessId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "OrderItem" ADD COLUMN "businessId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "ContactMessage" ADD COLUMN "businessId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "MessageReply" ADD COLUMN "businessId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "InventoryAdjustment" ADD COLUMN "businessId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "Restock" ADD COLUMN "businessId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "Activity" ADD COLUMN "businessId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "AuditLog" ADD COLUMN "businessId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "ContentPage" ADD COLUMN "businessId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "Testimonial" ADD COLUMN "businessId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "GalleryItem" ADD COLUMN "businessId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "FaqItem" ADD COLUMN "businessId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "PromotionItem" ADD COLUMN "businessId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "TeamMember" ADD COLUMN "businessId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "MediaAsset" ADD COLUMN "businessId" TEXT NOT NULL DEFAULT 'default';

-- Existing staff belong to the default (N&D'S) tenant.
UPDATE "User" SET "businessId" = 'default' WHERE "businessId" IS NULL;

-- Setting: rebuild with a per-tenant composite primary key.
CREATE TABLE "Setting_new" (
    "businessId" TEXT NOT NULL DEFAULT 'default',
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_new_pkey" PRIMARY KEY ("businessId", "key")
);
INSERT INTO "Setting_new" ("businessId", "key", "value", "updatedAt")
SELECT 'default', "key", "value", "updatedAt" FROM "Setting";
DROP TABLE "Setting";
ALTER TABLE "Setting_new" RENAME TO "Setting";

-- Per-tenant uniqueness for business keys (replaces global uniques).
DROP INDEX IF EXISTS "Customer_email_key";
DROP INDEX IF EXISTS "Category_name_key";
DROP INDEX IF EXISTS "Category_slug_key";
DROP INDEX IF EXISTS "Product_sku_key";
DROP INDEX IF EXISTS "Product_slug_key";
DROP INDEX IF EXISTS "Service_name_key";
DROP INDEX IF EXISTS "Service_slug_key";
DROP INDEX IF EXISTS "ServiceItem_slug_key";
DROP INDEX IF EXISTS "ContentPage_key_key";
DROP INDEX IF EXISTS "ContentPage_slug_key";
DROP INDEX IF EXISTS "Booking_reference_key";
DROP INDEX IF EXISTS "Order_reference_key";
DROP INDEX IF EXISTS "Technician_employeeId_key";
DROP INDEX IF EXISTS "Estimate_reference_key";
DROP INDEX IF EXISTS "Invoice_reference_key";

CREATE UNIQUE INDEX "Customer_businessId_email_key" ON "Customer"("businessId", "email");
CREATE UNIQUE INDEX "Category_businessId_name_key" ON "Category"("businessId", "name");
CREATE UNIQUE INDEX "Category_businessId_slug_key" ON "Category"("businessId", "slug");
CREATE UNIQUE INDEX "Product_businessId_sku_key" ON "Product"("businessId", "sku");
CREATE UNIQUE INDEX "Product_businessId_slug_key" ON "Product"("businessId", "slug");
CREATE UNIQUE INDEX "Service_businessId_name_key" ON "Service"("businessId", "name");
CREATE UNIQUE INDEX "Service_businessId_slug_key" ON "Service"("businessId", "slug");
CREATE UNIQUE INDEX "ServiceItem_businessId_slug_key" ON "ServiceItem"("businessId", "slug");
CREATE UNIQUE INDEX "ContentPage_businessId_key_key" ON "ContentPage"("businessId", "key");
CREATE UNIQUE INDEX "ContentPage_businessId_slug_key" ON "ContentPage"("businessId", "slug");
CREATE UNIQUE INDEX "Booking_businessId_reference_key" ON "Booking"("businessId", "reference");
CREATE UNIQUE INDEX "Order_businessId_reference_key" ON "Order"("businessId", "reference");
CREATE UNIQUE INDEX "WorkOrder_bookingId_key" ON "WorkOrder"("bookingId");

-- Tenant scoping indexes.
CREATE INDEX "User_businessId_idx" ON "User"("businessId");
CREATE INDEX "Customer_businessId_idx" ON "Customer"("businessId");
CREATE INDEX "Category_businessId_idx" ON "Category"("businessId");
CREATE INDEX "Product_businessId_idx" ON "Product"("businessId");
CREATE INDEX "Service_businessId_idx" ON "Service"("businessId");
CREATE INDEX "ServiceItem_businessId_idx" ON "ServiceItem"("businessId");
CREATE INDEX "ServiceRequest_businessId_idx" ON "ServiceRequest"("businessId");
CREATE INDEX "WorkOrder_businessId_idx" ON "WorkOrder"("businessId");
CREATE INDEX "WorkOrder_technicianId_idx" ON "WorkOrder"("technicianId");
CREATE INDEX "WorkOrder_customerId_idx" ON "WorkOrder"("customerId");
CREATE INDEX "Booking_businessId_idx" ON "Booking"("businessId");
CREATE INDEX "BookingNote_businessId_idx" ON "BookingNote"("businessId");
CREATE INDEX "Order_businessId_idx" ON "Order"("businessId");
CREATE INDEX "OrderItem_businessId_idx" ON "OrderItem"("businessId");
CREATE INDEX "ContactMessage_businessId_idx" ON "ContactMessage"("businessId");
CREATE INDEX "MessageReply_businessId_idx" ON "MessageReply"("businessId");
CREATE INDEX "InventoryAdjustment_businessId_idx" ON "InventoryAdjustment"("businessId");
CREATE INDEX "Restock_businessId_idx" ON "Restock"("businessId");
CREATE INDEX "Activity_businessId_idx" ON "Activity"("businessId");
CREATE INDEX "AuditLog_businessId_idx" ON "AuditLog"("businessId");
CREATE INDEX "ContentPage_businessId_idx" ON "ContentPage"("businessId");
CREATE INDEX "Testimonial_businessId_idx" ON "Testimonial"("businessId");
CREATE INDEX "GalleryItem_businessId_idx" ON "GalleryItem"("businessId");
CREATE INDEX "FaqItem_businessId_idx" ON "FaqItem"("businessId");
CREATE INDEX "PromotionItem_businessId_idx" ON "PromotionItem"("businessId");
CREATE INDEX "TeamMember_businessId_idx" ON "TeamMember"("businessId");
CREATE INDEX "MediaAsset_businessId_idx" ON "MediaAsset"("businessId");

-- Foreign keys (applied by Prisma on PostgreSQL; skipped on SQLite where the
-- application layer enforces the relationships).
ALTER TABLE "User" ADD CONSTRAINT "User_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ServiceRequest" ADD CONSTRAINT "ServiceRequest_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ServiceRequest" ADD CONSTRAINT "ServiceRequest_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;
