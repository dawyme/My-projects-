-- Field-service tables that postdate the shared baseline. Created here for
-- SQLite deployments; PostgreSQL deployments get them via `prisma db push`.
-- Every table is tenant-scoped from day one.

-- CreateTable
CREATE TABLE IF NOT EXISTS "Technician" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL DEFAULT 'default',
    "employeeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "profilePhoto" TEXT,
    "skills" TEXT,
    "certifications" TEXT,
    "serviceAreas" TEXT,
    "employmentStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
    "availability" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Technician_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Equipment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL DEFAULT 'default',
    "customerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "brand" TEXT,
    "model" TEXT,
    "serialNumber" TEXT,
    "installDate" TIMESTAMP(3),
    "warrantyExp" TIMESTAMP(3),
    "refrigerant" TEXT,
    "voltage" TEXT,
    "filterSize" TEXT,
    "location" TEXT,
    "photos" TEXT,
    "manuals" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Equipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ServiceHistory" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL DEFAULT 'default',
    "equipmentId" TEXT NOT NULL,
    "serviceDate" TIMESTAMP(3) NOT NULL,
    "description" TEXT NOT NULL,
    "technicianId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Estimate" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL DEFAULT 'default',
    "reference" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "subtotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tax" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "discount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "labour" TEXT,
    "parts" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Estimate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Invoice" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL DEFAULT 'default',
    "reference" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "subtotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tax" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "dueDate" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "branding" TEXT,
    "labour" TEXT,
    "parts" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "JobStatus" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL DEFAULT 'default',
    "bookingId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "technicianId" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobStatus_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Technician_businessId_employeeId_key" ON "Technician"("businessId", "employeeId");
CREATE INDEX IF NOT EXISTS "Technician_businessId_idx" ON "Technician"("businessId");
CREATE INDEX IF NOT EXISTS "Equipment_businessId_idx" ON "Equipment"("businessId");
CREATE INDEX IF NOT EXISTS "Equipment_customerId_idx" ON "Equipment"("customerId");
CREATE INDEX IF NOT EXISTS "ServiceHistory_businessId_idx" ON "ServiceHistory"("businessId");
CREATE INDEX IF NOT EXISTS "ServiceHistory_equipmentId_idx" ON "ServiceHistory"("equipmentId");
CREATE UNIQUE INDEX IF NOT EXISTS "Estimate_businessId_reference_key" ON "Estimate"("businessId", "reference");
CREATE INDEX IF NOT EXISTS "Estimate_businessId_idx" ON "Estimate"("businessId");
CREATE INDEX IF NOT EXISTS "Estimate_customerId_idx" ON "Estimate"("customerId");
CREATE UNIQUE INDEX IF NOT EXISTS "Invoice_businessId_reference_key" ON "Invoice"("businessId", "reference");
CREATE INDEX IF NOT EXISTS "Invoice_businessId_idx" ON "Invoice"("businessId");
CREATE INDEX IF NOT EXISTS "Invoice_customerId_idx" ON "Invoice"("customerId");
CREATE INDEX IF NOT EXISTS "JobStatus_businessId_idx" ON "JobStatus"("businessId");
CREATE INDEX IF NOT EXISTS "JobStatus_bookingId_idx" ON "JobStatus"("bookingId");

-- Foreign keys (PostgreSQL applies these via `prisma db push`; the SQLite
-- runner skips ALTER-based FK constraints and the data layer enforces them).
ALTER TABLE "Technician" ADD CONSTRAINT "Technician_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Equipment" ADD CONSTRAINT "Equipment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Equipment" ADD CONSTRAINT "Equipment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceHistory" ADD CONSTRAINT "ServiceHistory_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ServiceHistory" ADD CONSTRAINT "ServiceHistory_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceRequest" ADD CONSTRAINT "ServiceRequest_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Estimate" ADD CONSTRAINT "Estimate_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "JobStatus" ADD CONSTRAINT "JobStatus_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
