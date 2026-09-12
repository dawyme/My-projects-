# Authoritative Tenant Feature Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Feature Management the authoritative entitlement boundary for every tenant-facing dashboard feature and every tenant-capable API, with automated guards for future features.

**Architecture:** Add a code-owned backend registry that synchronizes missing built-in features into the existing `PlatformFeature` table, mark every tenant navigation item with a registry key, enforce tenant API access from the same registry, and add contract tests that fail when tenant-facing UI/API additions bypass registration.

**Tech Stack:** Node.js, Express, Prisma/PostgreSQL, Zod, browser ES modules, existing Admin Dashboard routing, Node assertion-based contract tests.

**Spec:** `docs/superpowers/specs/2026-09-12-authoritative-tenant-feature-registry-design.md`

## Global Constraints
- SUPER_ADMIN remains unrestricted.
- Tenant feature access remains per-business through `TenantFeatureAccess`.
- Existing administrator overrides must never be overwritten by registry synchronization.
- Platform-only functions must remain outside tenant feature management.
- No production database writes during implementation or verification.
- Work stays on a feature branch and is merged only through PR review.

---

### Task 1: Add the authoritative feature registry

**Files:**
- Create: `backend/src/lib/feature-registry.js`
- Modify: `backend/src/lib/features.js`
- Modify: `backend/src/routes/features.js`
- Test: `backend/tests/platform-feature-access-contract.test.js`

**Interfaces:**
- Produces `TENANT_FEATURE_REGISTRY`, `getTenantFeatureDefinition(key)`, `getTenantFeatureDefinitions()`, `ensurePlatformFeatures()`.
- `ensurePlatformFeatures()` creates missing registered `PlatformFeature` rows but preserves existing `isActive`, `isCore`, and `defaultEnabled` values.

- [ ] **Step 1: Write failing registry contract tests.**
  Assert that the registry contains every planned tenant module key, keys are unique, every definition has `tenantCapable === true`, and the registry exposes the API prefixes/routes used by the tenant app.

- [ ] **Step 2: Run the focused contract test and verify failure.**
  Run `node backend/tests/platform-feature-access-contract.test.js`.
  Expected: FAIL because the registry module does not yet exist and the current contract only knows Recurring Maintenance.

- [ ] **Step 3: Implement `feature-registry.js`.**
  Define stable kebab-case keys for the complete tenant-capable module set, including `content-manager` and `media-library`. Keep platform-only modules out of this tenant registry.

- [ ] **Step 4: Add registry synchronization.**
  Implement `ensurePlatformFeatures()` using Prisma `upsert` with create values from the registry and update values limited to descriptive metadata. Do not overwrite administrator-controlled activation/default/access settings for existing rows.

- [ ] **Step 5: Call synchronization from the Feature Management API before listing features.**
  Ensure `/api/saas/features` can populate newly registered built-ins without requiring a seed command.

- [ ] **Step 6: Run the focused contract test again.**
  Run `node backend/tests/platform-feature-access-contract.test.js`.
  Expected: PASS for normalization, access resolution, registry completeness, and key uniqueness.

- [ ] **Step 7: Commit the registry unit.**
  Commit message: `feat: add authoritative tenant feature registry`.

---

### Task 2: Make tenant navigation registry-controlled

**Files:**
- Modify: `admin/js/layout.js`
- Test: `backend/tests/platform-feature-access-contract.test.js`
- Test: `backend/tests/ui.test.js` or a new focused tenant-feature-navigation contract test if that file is not suitable

**Interfaces:**
- Tenant navigation continues to consume `user.featureAccess` from `/api/features/access`.
- Every tenant-visible `NAV` item receives a `feature` key matching `TENANT_FEATURE_REGISTRY`.

- [ ] **Step 1: Add a failing navigation contract.**
  Read the layout source in the test and assert that every navigation item which is not `platformOnly` has a feature key, except the explicitly documented core shell links such as Profile. Assert each feature key exists in the registry.

- [ ] **Step 2: Run the navigation contract and verify failure.**
  Run the focused test.
  Expected: FAIL because most current NAV items have no feature key.

- [ ] **Step 3: Add feature keys to all tenant-visible NAV entries.**
  Cover catalogue, operations, people, supplier marketplace, administration, website, subscription, dashboard/reporting, Content Manager, and Media Library. Preserve platform-only role checks.

- [ ] **Step 4: Verify the existing recurring-maintenance behavior still works.**
  Confirm its feature key remains `recurring-maintenance` and that the tenant menu disappears when `/api/features/access` omits that key.

- [ ] **Step 5: Run the navigation/UI contract.**
  Run the focused test file(s).
  Expected: PASS with no unregistered tenant navigation feature keys.

- [ ] **Step 6: Commit the navigation unit.**
  Commit message: `feat: bind tenant navigation to feature registry`.

---

### Task 3: Enforce feature access on tenant APIs

**Files:**
- Modify: `backend/src/app.js`
- Modify: `backend/src/lib/features.js`
- Modify: `backend/src/routes/recurring-maintenance.js`
- Test: `backend/tests/platform-feature-access-contract.test.js`

**Interfaces:**
- Registry API prefixes identify the feature protecting each tenant-capable route family.
- Central middleware resolves a feature from `req.baseUrl`/request path and invokes the existing access semantics.
- SUPER_ADMIN bypass remains unconditional.

- [ ] **Step 1: Add failing route-enforcement contracts.**
  Assert that every tenant-capable `apiPrefix` in the registry is represented by an app-level feature enforcement mapping, and that the existing recurring-maintenance route is not double-enforced.

- [ ] **Step 2: Run the contract and verify failure.**
  Expected: FAIL because only recurring maintenance currently uses `requireFeature`.

- [ ] **Step 3: Implement central API feature enforcement.**
  Add a small middleware in `backend/src/lib/features.js` that maps request base paths to registry feature keys, bypasses SUPER_ADMIN, and invokes the same forbidden semantics for inactive/disabled tenant features. Keep authentication/tenant scoping owned by the existing route middleware.

- [ ] **Step 4: Mount enforcement before tenant-capable route families.**
  Apply the registry middleware in `backend/src/app.js` without changing public routes or platform-only `/api/saas` functionality. Remove any duplicate recurring-maintenance-only enforcement if central enforcement makes it redundant.

- [ ] **Step 5: Run route-enforcement contracts.**
  Run `node backend/tests/platform-feature-access-contract.test.js` and the existing route/auth tests that cover tenant access.
  Expected: PASS for SUPER_ADMIN bypass and tenant blocking semantics.

- [ ] **Step 6: Commit the API enforcement unit.**
  Commit message: `feat: enforce tenant feature access on APIs`.

---

### Task 4: Expand Feature Management to show all tenant-capable features

**Files:**
- Modify: `admin/js/pages/features.js`
- Modify: `backend/src/routes/features.js`
- Test: `backend/tests/platform-feature-access-contract.test.js`

**Interfaces:**
- `/api/saas/features` returns registry-backed feature metadata plus per-tenant enabled state.
- Existing per-tenant checkbox controls remain the write path for `TenantFeatureAccess`.

- [ ] **Step 1: Add a failing response-shape contract.**
  Assert that the feature list includes registry category/tenant-capable metadata and contains Content Manager and Media Library after synchronization.

- [ ] **Step 2: Run the contract and verify failure.**
  Expected: FAIL because the current database-backed list contains only the seeded recurring feature.

- [ ] **Step 3: Extend the feature response.**
  Merge registry metadata into each feature response without removing existing fields used by the current UI.

- [ ] **Step 4: Update the UI grouping and labels.**
  Group tenant-capable features by category and clearly identify core features versus tenant-controllable features. Keep per-tenant toggles and existing edit/remove actions.

- [ ] **Step 5: Run the focused UI/API contracts.**
  Expected: PASS with all registered tenant features represented.

- [ ] **Step 6: Commit the Feature Management unit.**
  Commit message: `feat: expand tenant feature management`.

---

### Task 5: Add future-feature registration guardrails and documentation

**Files:**
- Modify: `backend/tests/platform-feature-access-contract.test.js`
- Create: `docs/TENANT_FEATURE_MANAGEMENT.md`
- Modify: `docs/NDS-MASTER-SAAS-APPLICATION-BLUEPRINT.md` only if the existing blueprint has a feature-entitlement section that should reference the registry

**Interfaces:**
- The contract test is the CI/developer guardrail for future tenant features.
- Documentation defines the required workflow: add registry entry first, then add navigation/API routes using that key.

- [ ] **Step 1: Add the future-feature failure tests.**
  Validate registry key uniqueness, NAV key coverage, API prefix coverage, tenant-capable classification, and absence of tenant-capable modules outside the registry.

- [ ] **Step 2: Run the full relevant backend test command.**
  Use the repository's documented test runner after inspecting `package.json`/`backend/package.json` and run the feature, auth, UI, tenant, and route contracts together.
  Expected: all relevant tests pass in the isolated test environment; do not point tests at production Supabase.

- [ ] **Step 3: Document the mandatory workflow.**
  State that every new tenant-facing platform feature must first be registered with a stable key, then reference that key from tenant navigation and API enforcement, and finally add/update contract tests.

- [ ] **Step 4: Run the guardrail test after documentation changes.**
  Expected: PASS.

- [ ] **Step 5: Commit the guardrail unit.**
  Commit message: `test: enforce tenant feature registration contract`.

---

### Task 6: Final verification and PR review

**Files:**
- No new source files; verify all changed files above.

- [ ] **Step 1: Inspect the complete branch diff against `main`.**
  Confirm no production configuration, credentials, or live database writes were added.

- [ ] **Step 2: Run all feature-management, tenant, auth, and UI tests available in the repository.**
  Record exact pass/fail results; do not claim a suite passed if the environment cannot execute it.

- [ ] **Step 3: Verify the feature list contains every current tenant-facing module.**
  Specifically verify Content Manager and Media Library are present and toggleable, and platform-only modules are not tenant features.

- [ ] **Step 4: Verify SUPER_ADMIN remains unrestricted.**
  Confirm the platform owner is not blocked by tenant feature access.

- [ ] **Step 5: Open a PR from `feature/authoritative-tenant-feature-registry` to `main`.**
  PR title: `feat: make Feature Management authoritative for tenant features`.

- [ ] **Step 6: Report a checkpoint.**
  Include branch, commits, test evidence, PR number, and any limitations that remain before merge.
