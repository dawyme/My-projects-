# N&D SaaS Productization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Productize the existing multi-tenant N&D management system so a platform owner can provision businesses, assign plans, manage subscriptions, and onboard client administrators without disrupting the existing tenant application.

**Architecture:** Extend the existing `Business` tenant model and server-side tenant resolution. Add first-class `Plan` and `Subscription` records, platform-admin-only SaaS APIs, a platform administration UI, and automated isolation/onboarding tests. Existing POS, service operations, inventory, payments, marketplace, and public-site flows remain unchanged.

**Tech Stack:** Node.js, Express, Prisma/PostgreSQL, Zod, vanilla ES modules/admin UI, existing authentication/CSRF/rate limiting, GitHub Actions/Vercel.

**Spec:** Approved SaaS productization design in conversation (2026-08-29).

## Global Constraints

- Preserve the existing N&D'S tenant (`businessId=default`) and production data.
- Never derive tenant scope from a client-supplied businessId/header.
- Platform administration requires an authenticated platform administrator (ADMIN with no businessId under the current auth model).
- Client users may access only their own business.
- Do not replace the existing Order/POS, dispatch, inventory, payment, supplier, or public-site flows.
- No production migration or deployment is considered successful until automated regression checks pass.

---

### Task 1: SaaS data model and migration

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/<timestamp>_saas_productization/migration.sql`

**Interfaces:**
- Produces `Plan` and `Subscription` Prisma models linked to `Business`.
- Subscription has one active record per business, plan/status/trial/current-period metadata, and feature/limit snapshots.

- [ ] Write schema-level expectations/tests for plan uniqueness and one subscription per business.
- [ ] Add Prisma models and Business relations.
- [ ] Add PostgreSQL migration with safe defaults and no destructive changes.
- [ ] Generate/validate Prisma client in CI.

### Task 2: SaaS service/API

**Files:**
- Create: `backend/src/routes/saas.js`
- Modify: `backend/src/app.js`
- Modify: `backend/src/lib/tenant.js` only if a narrowly scoped helper is required

**Interfaces:**
- `GET /api/saas/overview` → platform-only tenant/subscription counts.
- `GET /api/saas/plans` → active plans.
- `POST /api/saas/plans` → create/update commercial plan definition.
- `GET /api/saas/businesses` → tenant roster with subscription/usage summary.
- `POST /api/saas/businesses` → provision tenant + first admin + selected plan.
- `PATCH /api/saas/businesses/:id/subscription` → activate/suspend/change plan.

- [ ] Write failing API tests for platform-only access and tenant denial.
- [ ] Implement validation, tenant creation, subscription assignment and audit logging.
- [ ] Verify duplicate business/admin handling.
- [ ] Verify suspended tenants cannot use tenant APIs.

### Task 3: Commercial onboarding/admin UI

**Files:**
- Create: `admin/js/pages/saas.js`
- Modify: `admin/js/layout.js`

**Interfaces:**
- Platform administrators get a `SaaS / Clients` section.
- Dashboard shows tenant counts and subscription states.
- Client table supports provisioning, plan assignment, suspension/reactivation.
- Onboarding form creates business + first admin + plan in one operation.

- [ ] Add route/nav guarded to platform administrators.
- [ ] Add loading/error/empty states.
- [ ] Connect forms to SaaS APIs using existing CSRF/auth helpers.
- [ ] Verify tenant administrators do not see platform controls.

### Task 4: Onboarding and entitlement tests

**Files:**
- Create: `backend/tests/saas.test.js`
- Modify: `backend/tests/run-all.js`

- [ ] Test platform admin can create an isolated tenant.
- [ ] Test created admin authenticates with the new tenant.
- [ ] Test tenant cannot enumerate or mutate another tenant.
- [ ] Test plan/subscription state changes are tenant-safe.
- [ ] Test suspension blocks tenant application access without deleting data.
- [ ] Test cleanup removes temporary tenants and related fixtures.

### Task 5: Full regression and deployment

**Files:**
- Modify only if CI/deployment configuration requires a verified compatibility fix.

- [ ] Run complete backend regression suite.
- [ ] Run admin UI tests.
- [ ] Run POS/multi-tenant isolation tests.
- [ ] Run payment, marketplace, service operations, dispatch/reminder and public-site suites.
- [ ] Review migration SQL for production safety.
- [ ] Open PR from isolated feature branch.
- [ ] Merge only after checks pass.
- [ ] Verify Vercel production deployment and live health.
- [ ] Produce a final commercial-readiness report with every gate and result.
