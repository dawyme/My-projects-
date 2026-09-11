-- Platform feature catalogue and per-tenant feature access overrides.
CREATE TABLE "PlatformFeature" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "isCore" BOOLEAN NOT NULL DEFAULT false,
  "defaultEnabled" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlatformFeature_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PlatformFeature_key_key" ON "PlatformFeature"("key");
CREATE INDEX "PlatformFeature_isActive_idx" ON "PlatformFeature"("isActive");
CREATE INDEX "PlatformFeature_isCore_idx" ON "PlatformFeature"("isCore");

CREATE TABLE "TenantFeatureAccess" (
  "id" TEXT NOT NULL,
  "featureId" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TenantFeatureAccess_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TenantFeatureAccess_featureId_businessId_key" ON "TenantFeatureAccess"("featureId", "businessId");
CREATE INDEX "TenantFeatureAccess_businessId_idx" ON "TenantFeatureAccess"("businessId");
CREATE INDEX "TenantFeatureAccess_featureId_enabled_idx" ON "TenantFeatureAccess"("featureId", "enabled");

ALTER TABLE "TenantFeatureAccess" ADD CONSTRAINT "TenantFeatureAccess_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "PlatformFeature"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantFeatureAccess" ADD CONSTRAINT "TenantFeatureAccess_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "PlatformFeature" ("id", "key", "name", "description", "isActive", "isCore", "defaultEnabled", "createdAt", "updatedAt")
VALUES ('platform-recurring-maintenance', 'recurring-maintenance', 'Recurring Maintenance', 'Recurring preventive maintenance schedules and customer reminders.', true, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO UPDATE SET "isActive" = true, "isCore" = true, "defaultEnabled" = true, "updatedAt" = CURRENT_TIMESTAMP;
