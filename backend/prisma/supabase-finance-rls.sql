-- Supabase / PostgreSQL ONLY — do not put this in prisma/migrations (the SQLite test runner cannot execute it).
-- Keeps the finance tables private from the public anon/authenticated API. The app server connects
-- with a role that bypasses RLS. ALREADY APPLIED to the live database on 2026-11-03; re-running is harmless.
ALTER TABLE "FinancialTransaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Expense" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinanceAuditLog" ENABLE ROW LEVEL SECURITY;
