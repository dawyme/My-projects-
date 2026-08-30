-- SaaS productization: commercial plans and one subscription per tenant.
CREATE TABLE "Plan" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "description" TEXT,
  "price" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "interval" TEXT NOT NULL DEFAULT 'month',
  "features" TEXT NOT NULL DEFAULT '{}',
  "limits" TEXT NOT NULL DEFAULT '{}',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Plan_slug_key" ON "Plan"("slug");
CREATE INDEX "Plan_isActive_idx" ON "Plan"("isActive");

CREATE TABLE "Subscription" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'TRIAL',
  "trialEndsAt" TIMESTAMP(3),
  "currentPeriodStart" TIMESTAMP(3),
  "currentPeriodEnd" TIMESTAMP(3),
  "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Subscription_businessId_key" ON "Subscription"("businessId");
CREATE INDEX "Subscription_planId_idx" ON "Subscription"("planId");
CREATE INDEX "Subscription_status_idx" ON "Subscription"("status");
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "Plan" ("id","name","slug","description","price","currency","interval","features","limits","isActive","createdAt","updatedAt") VALUES
('plan_starter','Starter','starter','Core tools for small service businesses',49,'USD','month','{"pos":true,"dispatch":true,"inventory":true,"invoices":true}','{"users":3,"technicians":3}',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('plan_professional','Professional','professional','Full operations for growing teams',99,'USD','month','{"pos":true,"dispatch":true,"inventory":true,"invoices":true,"analytics":true,"marketplace":true}','{"users":10,"technicians":10}',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('plan_business','Business','business','Advanced operations for established companies',199,'USD','month','{"pos":true,"dispatch":true,"inventory":true,"invoices":true,"analytics":true,"marketplace":true,"advancedReports":true}','{"users":25,"technicians":25}',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

INSERT INTO "Subscription" ("id","businessId","planId","status","createdAt","updatedAt")
SELECT 'sub_default_starter','default','plan_professional','ACTIVE',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM "Business" WHERE "id"='default')
  AND NOT EXISTS (SELECT 1 FROM "Subscription" WHERE "businessId"='default');
