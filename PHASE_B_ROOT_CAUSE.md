# Phase B Reliability — Root Cause & Fix Notes

> **Provenance.** The original Phase B working tree (commit `a07c120`, branch
> `arena/01a095d2-my-projects`) was lost with its sandbox before it could be
> committed or pushed, and the SHA is confirmed unrecoverable (GitHub returns
> `422 No commit found`; no PR ref, stash, or clone contains the changes).
> This document and the accompanying commit are an **authorized
> re-implementation of the Phase B scope from `GAP_ANALYSIS.md`**, produced by
> inspecting `main` (base `b5155620`) and fixing the defects that were still
> present. It is **not** a byte-for-byte restore of the lost tree.

Scope: Phase B — "Finish Admin/Auth/RBAC/Feature Management Reliability"
(`GAP_ANALYSIS.md` §4). All fixes are limited to the intended reliability
work; no database, authentication-server, or role-architecture changes.

---

## 1. Immediate logout / authentication reliability

**Root cause.** `auth.logout()` already cleared local state before calling
`POST /api/auth/logout` (refresh-token revocation + `sessionVersion` bump are
server-side and were intact). The remaining gap was the **back/forward
cache**: after signing out, a Back/Forward navigation could restore the
authenticated admin/portal shell from the browser cache with stale UI, because
nothing re-checked the session on a bfcache restore (`requireAuth` runs only
on a full load).

**Fix.** `admin/js/api.js` registers a module-level `pageshow` guard that, on
`event.persisted` restores only, sends the stale page to
`/login.html?next=…` when no access token is present. Login pages
(`/login.html`, `/admin/login.html`) are excluded so the guard can never
interfere with the sign-in form.

## 2. Admin navigation highlighting / submenu behavior

**Root cause.** `highlightNav()` in `admin/js/layout.js` iterated every nav
group and set `items.hidden = !isActiveGroup` — i.e. **every navigation
force-collapsed all groups except the active one**, throwing away any group
the user had manually expanded. Submenus also had no visible keyboard focus
state.

**Fix.** `highlightNav()` now keeps `aria-current` in sync across all links,
auto-expands only the group containing the active link, and **leaves the
expansion state of every other group untouched** (closing a group is
explicitly the user's toggle click). `admin/css/admin.css` adds
`:focus-visible` outlines for nav links and group toggles.

## 3. Recurring appointments dashboard handling

**Root cause.** Series-generated bookings are real `Booking` rows (stamped by
`RecurringMaintenanceOccurrence`), so `GET /api/dashboard/upcoming` returned
**the same upcoming recurring appointment twice** — once in `data` (plain
booking list) and once in `recurring`. Additionally, an occurrence whose
linked booking was individually cancelled stayed `SCHEDULED` and surfaced as
upcoming "ghost" work.

**Fix.** `backend/src/routes/dashboard.js` excludes series-linked bookings
from the one-off list (`recurringOccurrence: { is: null }`) and skips
occurrences whose booking is `CANCELLED`
(`booking: { is: { status: { not: 'CANCELLED' } } }`). The admin dashboard
page consumes only the dedicated `recurring` dataset
(`upcomingRes.recurring`), matching the existing reliability contract.

## 4. Duplicate dashboard API mount

**Root cause.** This repo has a history of dashboard mount incidents (PR #54
removed and PR #56 had to restore the tenant dashboard mount). The Phase B
investigation confirmed `backend/src/app.js` currently mounts `/api/dashboard`
**exactly once** and no route module remounts the dashboard router; the other
repeated prefixes (`/api/features`, `/api/public`, `/api/payments/webhook`)
are intentional middleware/router layering.

**Fix.** The single-mount invariant is now locked by
`backend/tests/phase-b-reliability.test.js` (mount count must be exactly 1 and
no other route file may require `./routes/dashboard`), so the earlier
duplicate-mount failure mode cannot silently return.

## 5. Tenant-aware recurring dashboard query

**Root cause.** The occurrence query hardcoded `businessId: req.tenantId`,
bypassing the `tenantWhere()` scoping primitive used by every other dashboard
query. Same resolved value today, but two sources of truth for tenant scope is
exactly how isolation regressions slip in later.

**Fix.** The occurrence query uses `...tenantWhere(req)` like its sibling
queries. Tenant scope continues to be resolved server-side by `protect` from
the authenticated user record only; **SUPER_ADMIN `businessId = NULL`
semantics are unchanged** (platform owner is never tenant-bound).

## 6. Role dashboard mobile navigation

**Root cause.** PR #60 gave the customer/technician shells a mobile nav
toggle, but dismissal was only wired to link clicks: opening a link in a new
context, using **browser Back**, or pressing **Escape** left the overlay
hanging over the content with no way to close it except re-toggling.

**Fix.** `customer/index.html` and `technician/index.html` now share one
`closeMobileNav()` helper that also runs on `hashchange` and on `Escape`
(returning focus to the toggle for keyboard users).

## 7. Regression tests

`backend/tests/phase-b-reliability.test.js` locks in all of the above as
source contracts (same style as the existing reliability suites) and is wired
into `backend/tests/run-all.js` so CI enforces it. The pre-existing
`admin-dashboard-reliability.test.js` contracts continue to pass unchanged.

---

## Constraints honored

- **Platform owner architecture unchanged** — no changes to `role-auth.js`,
  `admin/index.html`, `/superadmin/`, role mappings, or owner routing.
- **`businessId = NULL` remains SUPER_ADMIN behavior** — auth middleware and
  tenant primitives untouched; scope only made consistent.
- **Tenant isolation not weakened** — every changed query keeps (and
  tightens) the server-resolved `tenantWhere` scope.
- **No production database changes** — no schema or migration changes.
- **No authentication/security bypass** — server auth untouched; the only
  auth-adjacent change is a client guard that *strengthens* post-logout
  behavior.
- **`/login.html` not changed.**

## Verification

- `node --test backend/tests/phase-b-reliability.test.js` — pass
- `node --test backend/tests/admin-dashboard-reliability.test.js` — pass
- `node --test backend/tests/role-dashboard-mobile-navigation.test.js` — pass
- `node --test backend/tests/admin-health.test.js` — pass
- `npm test` (full 22-suite run against a local database) — all pass
