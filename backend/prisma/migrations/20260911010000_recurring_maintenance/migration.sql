-- Recurring preventive maintenance schedules, generated occurrences, and idempotent reminder deliveries.
CREATE TABLE "RecurringMaintenanceSeries" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "equipmentId" TEXT,
  "serviceId" TEXT,
  "technicianId" TEXT,
  "intervalMonths" INTEGER NOT NULL,
  "startDate" TIMESTAMP(3) NOT NULL,
  "endDate" TIMESTAMP(3),
  "maxOccurrences" INTEGER,
  "occurrenceCount" INTEGER NOT NULL DEFAULT 0,
  "nextOccurrenceAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "reminderOffsets" TEXT NOT NULL DEFAULT '[30,7,1,0]',
  "serviceLabel" TEXT,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RecurringMaintenanceSeries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RecurringMaintenanceSeries_businessId_status_idx" ON "RecurringMaintenanceSeries"("businessId", "status");
CREATE INDEX "RecurringMaintenanceSeries_businessId_nextOccurrenceAt_idx" ON "RecurringMaintenanceSeries"("businessId", "nextOccurrenceAt");
CREATE INDEX "RecurringMaintenanceSeries_customerId_idx" ON "RecurringMaintenanceSeries"("customerId");
CREATE INDEX "RecurringMaintenanceSeries_equipmentId_idx" ON "RecurringMaintenanceSeries"("equipmentId");

CREATE TABLE "RecurringMaintenanceOccurrence" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "seriesId" TEXT NOT NULL,
  "bookingId" TEXT NOT NULL,
  "occurrenceNumber" INTEGER NOT NULL,
  "scheduledAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
  "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RecurringMaintenanceOccurrence_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RecurringMaintenanceOccurrence_bookingId_key" ON "RecurringMaintenanceOccurrence"("bookingId");
CREATE UNIQUE INDEX "RecurringMaintenanceOccurrence_seriesId_occurrenceNumber_key" ON "RecurringMaintenanceOccurrence"("seriesId", "occurrenceNumber");
CREATE INDEX "RecurringMaintenanceOccurrence_businessId_scheduledAt_idx" ON "RecurringMaintenanceOccurrence"("businessId", "scheduledAt");
CREATE INDEX "RecurringMaintenanceOccurrence_seriesId_status_idx" ON "RecurringMaintenanceOccurrence"("seriesId", "status");

CREATE TABLE "RecurringMaintenanceReminder" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "occurrenceId" TEXT NOT NULL,
  "offsetDays" INTEGER NOT NULL,
  "channel" TEXT NOT NULL DEFAULT 'EMAIL',
  "scheduledFor" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "sentAt" TIMESTAMP(3),
  "providerId" TEXT,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RecurringMaintenanceReminder_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RecurringMaintenanceReminder_occurrenceId_offsetDays_channel_key" ON "RecurringMaintenanceReminder"("occurrenceId", "offsetDays", "channel");
CREATE INDEX "RecurringMaintenanceReminder_businessId_scheduledFor_status_idx" ON "RecurringMaintenanceReminder"("businessId", "scheduledFor", "status");

ALTER TABLE "RecurringMaintenanceSeries" ADD CONSTRAINT "RecurringMaintenanceSeries_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecurringMaintenanceSeries" ADD CONSTRAINT "RecurringMaintenanceSeries_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecurringMaintenanceSeries" ADD CONSTRAINT "RecurringMaintenanceSeries_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RecurringMaintenanceSeries" ADD CONSTRAINT "RecurringMaintenanceSeries_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RecurringMaintenanceSeries" ADD CONSTRAINT "RecurringMaintenanceSeries_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RecurringMaintenanceOccurrence" ADD CONSTRAINT "RecurringMaintenanceOccurrence_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecurringMaintenanceOccurrence" ADD CONSTRAINT "RecurringMaintenanceOccurrence_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "RecurringMaintenanceSeries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecurringMaintenanceOccurrence" ADD CONSTRAINT "RecurringMaintenanceOccurrence_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecurringMaintenanceReminder" ADD CONSTRAINT "RecurringMaintenanceReminder_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecurringMaintenanceReminder" ADD CONSTRAINT "RecurringMaintenanceReminder_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "RecurringMaintenanceOccurrence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
