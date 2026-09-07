# One-App Customer, Tenant, and Super Admin Role Experiences Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing N&D'S website/admin codebase into one authenticated application that presents the correct Customer, Tenant, or Super Admin experience from the signed-in user's role while preserving existing public booking, contact, admin/staff, technician, and SaaS behavior.

**Architecture:** Keep the current same-origin Express API, Prisma/PostgreSQL model, static HTML/ES modules, and existing admin hash-router. Add a shared `/app/` authenticated entry and role-aware shell rather than separate applications. Reuse the existing JWT/refresh-cookie auth contract and server-derived `businessId` tenant scope; authorization stays server-side.

**Tech Stack:** Node.js, Express, Prisma/PostgreSQL, Zod, bcryptjs, JWT, cookie-parser, static HTML/CSS/ES modules, existing Node test harness, npm build/test scripts.

**Spec:** `docs/NDS-MASTER-SAAS-APPLICATION-BLUEPRINT.md` plus the approved 2026-09-07 one-app Customer/Tenant/Super Admin requirements.

## Global Constraints

- One application for Customer, Tenant, and Super Admin; no separate apps.
- Modify the existing site; do not rebuild or replace branding, logo, public routes, or navigation foundation.
- Add visible public Sign In / Create Account entry because the current public navigation has no login entry.
- Reuse `/api/auth/login`, `/api/auth/me`, `/api/auth/refresh`, `/api/auth/logout`.
- Customer identity is an existing `User` with semantic `CUSTOMER` role plus a linked `Customer` profile.
- Tenant is an existing `Business`; scope is always derived from authenticated `User.businessId`.
- Tenant users may purchase/subscribe to platform plans but may not create/edit/activate/deactivate platform plans.
- Only platform Super Admin manages platform `Plan` records and tenant `Subscription` records.
- Existing `ADMIN + businessId:null` remains Super Admin; business-bound `ADMIN` remains Tenant Admin; `STAFF` remains Technician.
- Preserve existing public Booking; do not change `/api/public/contact` or Resend templates unless inspection proves a dependency requires it.
- No production DB migration unless the current schema is proven insufficient. Current schema already has `User.businessId`, `Customer.businessId`, `Plan`, and `Subscription`.
- Never trust client-supplied `businessId`; use `req.tenantId` and `tenantWhere(req)`.
- UI hiding is not authorization; protected endpoints must enforce role/ownership server-side.
- Do not repurpose `admin/login.html` as the customer login.
- Do not introduce a new localStorage token/session system; use the existing auth-cookie contract.
- Every implementation task uses TDD: failing test, confirm RED, minimal fix, focused PASS, broader PASS, commit.
- Implement on an isolated feature branch; do not merge directly to `main`.

## Verified File Map

- `backend/prisma/schema.prisma`: User, Business, Customer, Booking, Equipment, ServiceHistory, Estimate, Invoice, Plan, Subscription already exist with tenant relationships.
- `backend/src/middleware/auth.js`: protect/authorize/requirePermission and server-derived `req.tenantId`.
- `backend/src/lib/permissions.js`: semantic roles CUSTOMER, TECHNICIAN, TENANT_ADMIN, SUPER_ADMIN.
- `backend/src/lib/tenant.js`: tenantOf, tenantWhere, isPlatformAdmin, platformAdminOnly.
- `backend/src/routes/auth.js`: login, refresh, me, profile, password, logout.
- `backend/src/routes/saas.js`: platform-only plan/business/subscription management.
- `backend/src/routes/customers.js` and `backend/src/routes/dashboard.js`: existing tenant-scoped APIs.
- `backend/src/app.js`: API registration and `/admin` static serving.
- `backend/tests/api.test.js`, `rbac.test.js`, `saas.test.js`, `site.test.js`, `ui.test.js`: existing regression suites.
- `assets/js/site-api.js`: public form client; booking/contact behavior must remain intact.
- `index.html`: public shell with no account/login entry.
- `admin/login.html`, `admin/index.html`, `admin/js/api.js`, `admin/js/layout.js`: current authenticated admin shell; preserve compatibility.
- `docs/NDS-MASTER-SAAS-APPLICATION-BLUEPRINT.md`: architecture reference.

---

### Task 1: Formalize the shared role/session contract

**Files:** Modify `backend/src/lib/permissions.js`; modify `backend/src/routes/auth.js` only if `/me` needs context; tests `backend/tests/rbac.test.js`, `backend/tests/api.test.js`.

**Interfaces:** Keep `roleFor(user)`, `permissionsFor(user)`, `hasPermission(user, permission)`, and `/api/auth/me` canonical. Keep `req.tenantId` server-derived.

- [ ] Write failing assertions:
```js
assert.strictEqual(roleFor({role:'ADMIN',businessId:null}), ROLE.SUPER_ADMIN);
assert.strictEqual(roleFor({role:'ADMIN',businessId:'biz-a'}), ROLE.TENANT_ADMIN);
assert.strictEqual(roleFor({role:'STAFF',businessId:'biz-a'}), ROLE.TECHNICIAN);
assert.strictEqual(roleFor({role:'CUSTOMER',businessId:'biz-a'}), ROLE.CUSTOMER);
assert.strictEqual(hasPermission({role:'ADMIN',businessId:null},'plans.manage'), true);
assert.strictEqual(hasPermission({role:'ADMIN',businessId:'biz-a'},'plans.manage'), false);
assert.strictEqual(hasPermission({role:'CUSTOMER',businessId:'biz-a'},'bookings.create'), true);
assert.strictEqual(hasPermission({role:'CUSTOMER',businessId:'biz-a'},'customers.manage'), false);
```
- [ ] Run `node backend/tests/rbac.test.js`; confirm any new assertion is RED.
- [ ] Make the minimum permission/session change and preserve raw ADMIN/STAFF compatibility.
- [ ] Extend `/api/auth/me` coverage to assert `id`, `name`, `email`, `role`, and `businessId`.
- [ ] Run `node backend/tests/rbac.test.js` and `node backend/tests/api.test.js`; commit `feat: formalize shared role session contract`.

### Task 2: Add customer registration and Customer profile linkage

**Files:** Modify `backend/src/routes/auth.js`; tests `backend/tests/api.test.js`, `backend/tests/rbac.test.js`.

**Interfaces:** Add registration under `/api/auth`. A successful registration creates a `User` with role CUSTOMER and a linked `Customer` using the existing default-tenant/business mechanism, hashes with bcryptjs, sets the existing auth cookies/tokens, and returns the login session shape.

- [ ] Write failing test:
```js
const r = await anon.post('/api/auth/register', {name:'Portal Customer',email:`portal-${Date.now()}@example.com`,password:'PortalPass123'});
assert.strictEqual(r.status, 201);
assert.strictEqual(r.body.data.user.role, 'CUSTOMER');
assert.ok(r.body.data.accessToken);
assert.ok(r.body.data.refreshToken);
```
Also test duplicate email => 409 and `User.businessId === Customer.businessId`.
- [ ] Run `node backend/tests/api.test.js`; confirm RED because registration is absent.
- [ ] Implement using existing validation, bcrypt, token, cookie, audit, and activity helpers; do not duplicate token logic.
- [ ] Clean test rows and verify duplicate registration creates no second Customer.
- [ ] Run auth/RBAC tests; commit `feat: add customer account registration`.

### Task 3: Create the shared authenticated `/app/` shell and public login entry

**Files:** Create `app/index.html`, `app/js/api.js`, `app/js/app.js`, `app/js/layout.js`, `app/css/app.css`; modify `index.html`, `backend/src/app.js`; tests `backend/tests/site.test.js`, `backend/tests/ui.test.js`.

**Interfaces:** `/app/` is the single authenticated app. `app/js/api.js` exposes `auth.login`, `auth.me`, `auth.refresh`, `auth.logout` and protected same-origin request handling. `app/js/app.js` calls `/api/auth/me` and selects semantic-role routes. `app/js/layout.js` renders role navigation.

- [ ] Write failing site/UI assertions:
```js
const home = await fetch(`${base}/index.html`);
const html = await home.text();
assert.match(html,/Sign In/i);
assert.match(html,/Create Account/i);
assert.strictEqual((await fetch(`${base}/app/`)).status,200);
```
- [ ] Run `node backend/tests/site.test.js` and `node backend/tests/ui.test.js`; confirm RED.
- [ ] Add only an `/app` static mount; do not change `/admin` or public route mounts.
- [ ] Build shared login/register screens using existing auth endpoints, then bootstrap through `/api/auth/me`.
- [ ] Route CUSTOMER, TENANT_ADMIN, SUPER_ADMIN, TECHNICIAN to explicit registries in the same shell; never use browser-provided role/business values for authorization.
- [ ] Add sign-out through `/api/auth/logout` and return to the public site.
- [ ] Run site/UI tests; commit `feat: add shared authenticated app shell`.

### Task 4: Implement Customer portal with own-record isolation

**Files:** Create `backend/src/routes/customer-portal.js`; create `app/js/pages/customer-dashboard.js`, `customer-bookings.js`, `customer-equipment.js`, `customer-history.js`, `customer-estimates.js`, `customer-invoices.js`, `customer-profile.js`; modify `backend/src/app.js`; test `backend/tests/customer-portal.test.js`.

**Interfaces:** `GET /api/customer-portal/dashboard`, `/bookings`, `/equipment`, `/history`, `/estimates`, `/invoices`, plus own-profile update. Every query requires the signed-in Customer relationship and `req.tenantId`. New service booking can link to unchanged public booking flow.

- [ ] Create fixtures for two customers in one tenant and one in another tenant.
- [ ] Write failing tests:
```js
assert.strictEqual((await customerA.get('/api/customer-portal/dashboard')).status,200);
assert.strictEqual((await customerA.get(`/api/customer-portal/bookings/${customerBBookingId}`)).status,404);
assert.strictEqual((await customerA.get(`/api/customer-portal/equipment/${customerCEquipmentId}`)).status,404);
assert.strictEqual((await tenantA.get('/api/customer-portal/dashboard')).status,403);
```
- [ ] Run `node backend/tests/customer-portal.test.js`; confirm RED.
- [ ] Implement `protect` + semantic CUSTOMER authorization and resolve the Customer from authenticated identity, not a client `customerId`.
- [ ] Scope every child query by customer relationship and tenant; cross-customer/cross-tenant IDs return 404.
- [ ] Build the customer pages and link new service requests to the existing booking flow.
- [ ] Run customer/RBAC/API tests; commit `feat: add customer portal with own-record isolation`.

### Task 5: Implement Tenant self-service while preserving platform plan ownership

**Files:** Create `app/js/pages/tenant-dashboard.js`, `tenant-customers.js`, `tenant-jobs.js`, `tenant-calendar.js`, `tenant-equipment.js`, `tenant-history.js`, `tenant-inventory.js`, `tenant-estimates.js`, `tenant-invoices.js`, `tenant-staff.js`, `tenant-reports.js`, `tenant-settings.js`, `tenant-subscription.js`; create or modify a tenant-facing subscription route while keeping `backend/src/routes/saas.js` platform-only; test `backend/tests/tenant-portal.test.js`, modify `backend/tests/saas.test.js`.

**Interfaces:** Reuse existing tenant-scoped APIs for operations. Tenant subscription resolves the current Business from `req.tenantId`, validates an active Plan, and updates only that Business's Subscription. Platform plan CRUD remains behind `platformAdminOnly`.

- [ ] Write failing tests:
```js
assert.strictEqual((await tenantA.get('/api/dashboard/stats')).status,200);
assert.strictEqual((await tenantA.get(`/api/customers/${tenantBCustomerId}`)).status,404);
assert.strictEqual((await tenantA.post('/api/saas/plans',planPayload)).status,403);
assert.strictEqual((await tenantA.patch(`/api/saas/businesses/${businessBId}/subscription`,subscriptionPayload)).status,403);
```
- [ ] Run `node backend/tests/tenant-portal.test.js` and `node backend/tests/saas.test.js`; confirm RED for missing tenant purchase boundary.
- [ ] Implement tenant subscription without accepting target `businessId` from the client.
- [ ] Keep `POST /api/saas/plans` and platform subscription management behind `platformAdminOnly`.
- [ ] Build tenant pages without exposing platform plan controls.
- [ ] Run tenant/SaaS/RBAC tests; commit `feat: add tenant experience and self-service subscription`.

### Task 6: Integrate Super Admin platform control into the same app

**Files:** Create `app/js/pages/super-dashboard.js`, `super-tenants.js`, `super-users.js`, `super-plans.js`, `super-subscriptions.js`, `super-billing.js`, `super-analytics.js`, `super-audit.js`, `super-system-health.js`, `super-settings.js`; test `backend/tests/super-admin-portal.test.js`.

**Interfaces:** Super Admin is semantic SUPER_ADMIN; existing `ADMIN + businessId:null` remains compatible. Reuse `/api/saas/overview`, `/plans`, `/businesses`, and subscription management. Do not auto-create a production account.

- [ ] Write failing tests:
```js
assert.strictEqual((await superAdmin.get('/api/saas/overview')).status,200);
assert.strictEqual((await superAdmin.post('/api/saas/plans',planPayload)).status,201);
```
Also assert forged `businessId` input cannot change platform scope.
- [ ] Run `node backend/tests/super-admin-portal.test.js`; confirm RED.
- [ ] Build Super Admin pages on existing platform-protected SaaS APIs.
- [ ] Register Super Admin routes only in the shared semantic-role registry.
- [ ] Preserve `/admin` compatibility and all existing ADMIN/STAFF/technician pages.
- [ ] Run Super Admin/SaaS/RBAC/API tests; commit `feat: add super admin platform experience`.

### Task 7: Complete role-aware navigation and security regression matrix

**Files:** Modify `app/js/app.js`, `app/js/layout.js`, `admin/js/layout.js` only where compatibility requires it, and `index.html`; create `backend/tests/role-experience-security.test.js`; modify `backend/tests/run-all.js`; test `backend/tests/ui.test.js`, `backend/tests/rbac.test.js`.

**Interfaces:** Shared app maps semantic roles to route registries; existing admin hash routing remains compatible. Security matrix is the release gate.

- [ ] Add UI assertions: Customer sees only customer navigation; Tenant sees operations/subscription but not platform plan management; Super Admin sees platform controls; Technician retains jobs/dispatch/calendar.
- [ ] Add HTTP cases for: anonymous protected request => 401; customer own records => 200; customer other records => 404; Tenant A/B isolation => 404; tenant plan creation => 403; tenant own-plan subscription => 2xx; tenant modifying Tenant B subscription => 403/404; Super Admin plan management => 2xx; ADMIN/STAFF compatibility; forged IDs/businessId cannot bypass scope; logout makes refresh fail; public Booking works; Contact remains `/api/public/contact` and no FormBold reference exists.
- [ ] Run focused RED baseline:
```bash
node backend/tests/role-experience-security.test.js
node backend/tests/ui.test.js
node backend/tests/rbac.test.js
```
- [ ] Implement missing boundaries using `protect`, `authorize`, `requirePermission`, `tenantWhere`, and `platformAdminOnly`.
- [ ] Add the matrix to `backend/tests/run-all.js`.
- [ ] Run:
```bash
node backend/tests/rbac.test.js
node backend/tests/saas.test.js
node backend/tests/role-experience-security.test.js
node backend/tests/api.test.js
node backend/tests/site.test.js
node backend/tests/ui.test.js
npm test
```
- [ ] Commit `test: enforce one-app role and tenant isolation matrix` only after green.

### Task 8: Build, isolated deployment, and real verification

**Files:** Only files proven necessary by preceding failures; verify `vercel.json` and `.github/workflows/*` without changing deployment architecture unless build proves it necessary.

- [ ] Run `npm test` and `npm run build` before deployment.
- [ ] Inspect final diff: no public-site rebuild, no deletion of admin/technician pages, no Booking rewrite, no unnecessary Prisma migration, no FormBold reintroduction.
- [ ] Deploy the feature branch to an isolated preview using existing Vercel configuration; do not merge to `main`.
- [ ] Verify one test account per role: login, correct landing page, navigation, representative data, unauthorized denial, tenant plan purchase, Super Admin plan management, logout.
- [ ] Verify public Home, Book Service, and Contact; Booking route remains unchanged and Contact remains `/api/public/contact`.
- [ ] Rerun full tests/build against the matching environment and capture evidence.
- [ ] Open the review PR only after all checks pass; merge only after review.

## Release Acceptance Checklist

- [ ] Public site has visible Sign In/Create Account entry.
- [ ] One `/app/` authenticated application serves all roles.
- [ ] Customer can register/sign in and sees only own service records.
- [ ] Tenant operates only inside its own Business.
- [ ] Tenant can purchase/subscribe to an active platform plan.
- [ ] Tenant cannot create/manage platform plans.
- [ ] Super Admin can create/manage plans and subscriptions.
- [ ] ADMIN/STAFF/Technician compatibility remains intact.
- [ ] Server-side `businessId` isolation and ID-tamper protection pass.
- [ ] Unauthenticated protected routes are denied.
- [ ] Logout terminates the refresh session.
- [ ] Existing public Booking still works.
- [ ] Existing Contact route/Resend behavior is not regressed.
- [ ] No unnecessary production migration was introduced.
- [ ] `npm test` and `npm run build` pass.
- [ ] Isolated preview passes real role/login/authorization verification.
- [ ] No direct merge to `main` before review.

## Self-Review

- Spec coverage: Customer account/portal, Tenant operations, tenant-only plan purchase, Super Admin plan management, unified app, ADMIN/STAFF compatibility, technician compatibility, tenant isolation, auth lifecycle, and public-flow preservation are covered by Tasks 1–8.
- No placeholders: all tasks have concrete paths, interfaces, tests, commands, and commit points.
- Contract consistency: semantic roles remain CUSTOMER/TECHNICIAN/TENANT_ADMIN/SUPER_ADMIN; raw ADMIN remains compatible through `roleFor`; tenant scope remains `req.tenantId`; platform plan management remains behind `platformAdminOnly`.
