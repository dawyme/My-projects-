-- Calendar & Scheduling foundation (Phase C).
-- Technician availability data + appointment duration/buffer on Booking.
-- Additive only: new tables, new nullable columns. No data changes, no
-- destructive operations. Applies to SQLite (CI/local) via the migration
-- runner and to Supabase PostgreSQL via `prisma db push` at deploy time.
-- Day convention: ISO weekday 1 = Monday … 7 = Sunday. Times are "HH:mm".

CREATE TABLE "WorkingHours" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL DEFAULT 'default',
  "userId" TEXT NOT NULL,
  "day" INTEGER NOT NULL,
  "start" TEXT NOT NULL,
  "end" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkingHours_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkingHours_businessId_userId_day_key" ON "WorkingHours"("businessId", "userId", "day");
CREATE INDEX "WorkingHours_businessId_userId_idx" ON "WorkingHours"("businessId", "userId");

CREATE TABLE "TimeOff" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL DEFAULT 'default',
  "userId" TEXT NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "reason" TEXT,
  "status" TEXT NOT NULL DEFAULT 'APPROVED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TimeOff_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TimeOff_businessId_userId_idx" ON "TimeOff"("businessId", "userId");
CREATE INDEX "TimeOff_businessId_startsAt_idx" ON "TimeOff"("businessId", "startsAt");

CREATE TABLE "BreakPeriod" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL DEFAULT 'default',
  "userId" TEXT,
  "day" INTEGER NOT NULL,
  "start" TEXT NOT NULL,
  "end" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BreakPeriod_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BreakPeriod_businessId_day_idx" ON "BreakPeriod"("businessId", "day");
CREATE INDEX "BreakPeriod_businessId_userId_idx" ON "BreakPeriod"("businessId", "userId");

CREATE TABLE "ClosedDay" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL DEFAULT 'default',
  "date" TIMESTAMP(3) NOT NULL,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ClosedDay_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ClosedDay_businessId_date_key" ON "ClosedDay"("businessId", "date");
CREATE INDEX "ClosedDay_businessId_date_idx" ON "ClosedDay"("businessId", "date");

ALTER TABLE "Booking" ADD COLUMN "durationMin" INTEGER;
ALTER TABLE "Booking" ADD COLUMN "bufferMin" INTEGER;

-- Foreign keys (PostgreSQL only; skipped on SQLite where the Prisma client
-- engine emulates relations, matching the existing migration convention).
ALTER TABLE "WorkingHours" ADD CONSTRAINT "WorkingHours_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkingHours" ADD CONSTRAINT "WorkingHours_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TimeOff" ADD CONSTRAINT "TimeOff_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TimeOff" ADD CONSTRAINT "TimeOff_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BreakPeriod" ADD CONSTRAINT "BreakPeriod_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BreakPeriod" ADD CONSTRAINT "BreakPeriod_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ClosedDay" ADD CONSTRAINT "ClosedDay_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
