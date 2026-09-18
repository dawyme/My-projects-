# PR #73 CI investigation — "Integrations owner-first access" + "Tenant entitlement enforcement"

**PR:** #73 — *SEO canonical host consistency: non-www*
**PR head branch:** `fix/seo-canonical-host`
**Base:** `main` @ `299c4fe` (merge of PR #72)
**Investigation branch (this work):** `arena/01a0b412-my-projects`
**Date:** 2026-09-18

---

## 1. Verdict

> **The two failures are NOT present on `main`. They are introduced by PR #73 itself, by an
> out-of-scope commit (`c0c473b`) that edits tenant-navigation / entitlement code.**
>
> **With that one commit dropped, PR #73 is safe for review.** Its SEO changes are correct,
> self-consistent, and the whole suite is green (apart from one flake that also fails on plain `main`).

---

## 2. Root cause

Commit `c0c473b` — *"fix: force-refresh tenant feature entitlements on every shell boot"* — is the
last commit on the PR branch and is **not SEO work**. It changes the admin shell bootstrap:

```diff
--- a/admin/js/layout.js
+++ b/admin/js/layout.js
@@ -379,7 +379,7 @@ export async function boot() {
-  try { await auth.refreshFeatures(); } catch { /* fail open client-side */ }
+  try { await auth.refreshFeatures(true); } catch { /* fail open client-side */ }
```

Two static contract tests pin the **exact source shape** of that line:

| Test file | Line | Assertion |
| --- | --- | --- |
| `backend/tests/platform-owner-integrations.test.js` | 415 | `assert.match(layout, /await auth\.refreshFeatures\(\)/, 'boot must load the central feature set')` |
| `backend/tests/tenant-entitlement-enforcement.test.js` | 629 | `assert.match(layout, /await auth\.refreshFeatures\(\)/, 'boot must load the central feature set')` |

The regex requires a literal `refreshFeatures()` with an empty argument list. Passing `true`
no longer matches, so both tests fail with:

```
static: shell gates tenant nav + direct routes through the central /features/access
        — boot must load the central feature set
```

This is a **source-shape pin, not a behavioural test**: every live HTTP, E2E and RBAC check in both
suites still passed *with* the `(true)` change — only the static regex broke.

### Why the commit is out of scope for PR #73

`admin/js/layout.js` boot/entitlement wiring is exactly the "central feature bootstrap" /
"tenant navigation gating" surface that this PR is required to leave alone. The commit was an
attempt to patch a perceived stale-cache issue in `auth.refreshFeatures()`, but:

* both entitlement suites pass on `main` **without** it (including the E2E shell tests that
  re-authenticate as a different tenant mid-suite), so it is not needed for green CI;
* if a real caching bug does exist, the fix belongs in a **separate PR** that changes the
  entitlement code **and** the two static pins together, as one reviewed unit.

### Secondary defect found in PR #73

The PR's own new test file `backend/tests/seo-canonical-host.test.js` shipped with a **JavaScript
syntax error** — a single-quoted message string spanning literal newlines:

```js
assert.deepStrictEqual(failures, [], 'Found www canonical/URL SEO references:
' + failures.join('
'));
```

`node backend/tests/seo-canonical-host.test.js` → `SyntaxError: Invalid or unexpected token`.
It went unnoticed because the new suite is **not registered in `backend/tests/run-all.js`**, so
`npm test` never loads it. Fixed by escaping the newlines (`\n`) — a one-line change inside the
PR's own new file, no behaviour change.

---

## 3. CI history on the PR branch (independent confirmation)

| Commit | What it is | `Backend tests` | `N&D'S AI Agent Checks` (verify) |
| --- | --- | --- | --- |
| `308144c` | SEO fix — **but** `backend/tests/run-all.js` overwritten with homepage HTML | ✗ FAIL (34 s) | ✗ FAIL |
| `b4faabe` | Restore `backend/tests/run-all.js` (the corruption fix to preserve) | ✓ **SUCCESS** | ✗ FAIL (pre-existing flake) |
| `c0c473b` | `layout.js` → `refreshFeatures(true)` | ✗ **FAIL** — the 2 suites | ✗ FAIL |

`Backend tests` was **green at `b4faabe` and broke at `c0c473b`**. That isolates the regression to
that single commit and confirms the `run-all.js` restoration in `b4faabe` must be kept (it was —
`run-all.js` is untouched on this branch and identical to `main`).

---

## 4. Test results — before / after

Environment for every run: `NODE_ENV=test`, SQLite (`backend/data/app.db`) restored from a
pristine seeded snapshot before each run, `JWT_SECRET` / `JWT_REFRESH_SECRET` / `COOKIE_SECURE`
set as in `.github/workflows/backend-tests.yml`.

### Baseline — clean `main` @ `299c4fe` (requirement 1)

| Suite | Result |
| --- | --- |
| `tenant-entitlement-enforcement.test.js` | ✓ **31/31** |
| `platform-owner-integrations.test.js` | ✓ **16/16** |
| `npm test` (full, run 1) | 30/31 suites — only `Admin Dashboard UI` fails |
| `npm test` (full, run 2) | 30/31 suites — only `Admin Dashboard UI` fails |

**Neither of the two reported suites fails on `main`.**

### PR #73 as it stands (head `c0c473b`)

| Suite | Result |
| --- | --- |
| `tenant-entitlement-enforcement.test.js` | ✗ **30/31** — `boot must load the central feature set` |
| `platform-owner-integrations.test.js` | ✗ **15/16** — `boot must load the central feature set` |
| `npm test` (full) | **3 suites failed** — the two above + `Admin Dashboard UI` |
| `seo-canonical-host.test.js` | ✗ `SyntaxError` (never executed by CI) |

### After the fix — PR #73 minus `c0c473b`, plus the SEO test syntax fix

| Suite | Result |
| --- | --- |
| `npm test` (full) | **30/31** — only the pre-existing `Admin Dashboard UI` flake |
| `tenant-entitlement-enforcement.test.js` | ✓ **31/31** |
| `platform-owner-integrations.test.js` | ✓ **16/16** |
| `site.test.js` (public website) | ✓ **44/44** |
| `content.test.js` (sitemap canonical assertions) | ✓ **37/37** |
| `seo-canonical-host.test.js` | ✓ PASS — 33 public HTML files |

**Before → after: 2 red suites → 0 red suites.** The two named CI failures are gone.

### The `Admin Dashboard UI` failure is a pre-existing flake, unrelated to PR #73

* Fails on **plain `main`** in the full sequential run — **2 out of 2** runs.
* The test itself documents it (`backend/tests/ui.test.js`, comment above the assertion):
  *"on loaded machines, 12s was tight (the same intermittent failure reproduces on plain `main`)"*
* Standalone on this branch: passes 2 of 3 runs (`190/190`), fails once (`189/190`) — timing.
* It is a jsdom render-timeout on `Content manager Services tab lists services`, with no
  relationship to canonical hosts, entitlements or the shell feature set.

**Recommendation:** track separately (a longer/condition-based wait, or quarantine). Do **not**
fold into PR #73.

---

## 5. Files changed on `arena/01a0b412-my-projects`

Net diff vs `main` (`299c4fe`) — **SEO canonical-host work only**:

| File | Change |
| --- | --- |
| `contact.html` | Canonical / `og:url` / `og:image` / `twitter:image` → non-www (4 tags) |
| `backend/src/routes/content.js` | Default `canonicalBase` → `https://ndsairconditioning.com` |
| `backend/src/routes/public-content.js` | New `CANONICAL_ORIGIN`; sitemap normalises a configured `www` base down to non-www |
| `backend/tests/content.test.js` | Sitemap assertions: contains non-www, must not contain `www.ndsairconditioning.com` |
| `backend/tests/seo-canonical-host.test.js` | **New** — scans all 33 public HTML files for `www` canonical / `og:url` / `twitter:url` tags (*with the syntax fix*) |

**Explicitly NOT changed** (per the scope rules):

* `admin/js/layout.js` — reverted to `main` (`await auth.refreshFeatures();`); `c0c473b` dropped
* Entitlement, Feature Management, tenant-navigation and integrations code — untouched
* `backend/tests/run-all.js` — untouched; `b4faabe`'s restoration preserved (byte-identical to `main`)
* No database changes, no migrations, no Prisma schema change
* No new PR opened; nothing merged

---

## 6. Proof the new SEO test is meaningful (not vacuously green)

Temporarily restoring `main`'s `contact.html` makes it fail as intended:

```
AssertionError: Found www canonical/URL SEO references:
contact.html: <link rel="canonical" href="https://www.ndsairconditioning.com/contact.html">
contact.html: <meta property="og:url" content="https://www.ndsairconditioning.com/contact.html">
```

With PR #73's `contact.html` restored: `SEO canonical host checks passed for 33 public HTML files.`

---

## 7. SEO suite registration — **approved and applied**

`backend/tests/seo-canonical-host.test.js` was **not** registered in `backend/tests/run-all.js`, so
the new SEO check did not run under `npm test` and CI could not enforce it (that is precisely why its
syntax error survived review). Approved and wired in with the requested line:

```js
  ['Public login path', 'public-login.test.js'],
  ['SEO canonical host', 'seo-canonical-host.test.js'],   // ← added
  ['Public website', 'site.test.js'],
```

A one-line insertion into the file restored by `b4faabe`; no other change to that file.

## 7b. Final verified result

`npm test` → **32/32 suites passed**, `All suites passed`, exit 0 — including the new
`SEO canonical host` suite and `Admin Dashboard UI`.

| Suite | Result |
| --- | --- |
| `npm test` (full, 32 suites) | ✓ **all passed** — `SEO canonical host` included |
| `platform-owner-integrations.test.js` | ✓ **16/16** |
| `tenant-entitlement-enforcement.test.js` | ✓ **31/31** |
| `seo-canonical-host.test.js` | ✓ PASS — 33 public HTML files |
| `site.test.js` (public website) | ✓ **44/44** |
| `content.test.js` (sitemap canonical assertions) | ✓ **37/37** |

Final diff vs `main` after registration:

```
backend/src/routes/content.js            |  2 +-
backend/src/routes/public-content.js     |  5 +-
backend/tests/content.test.js            |  2 +
backend/tests/run-all.js                 |  1 +
backend/tests/seo-canonical-host.test.js | 34 ++
contact.html                             |  8 +-
```

No `admin/js/layout.js`. No entitlement / feature-management / integrations changes.
No Prisma, DB or migration changes (`git diff main -- backend/prisma/` is empty).

Commits on the session branch `arena/01a0b412-my-projects`:

| SHA | Subject |
| --- | --- |
| `c080264` | SEO canonical host fix: non-www canonicals, sitemap normalisation, SEO checks |
| `a4bc53d` | Register the SEO canonical-host suite in the test runner |

---

## 8. Recommended next steps (for approval)

1. **Drop `c0c473b` from `fix/seo-canonical-host`** (revert `admin/js/layout.js` to `main`) — this
   is the entire fix for the two CI failures. Done here on `arena/01a0b412-my-projects`; needs to be
   applied to the PR branch.
2. **Keep the SEO-test syntax fix** — otherwise the PR's own new check cannot execute.
3. **Optionally** register the SEO suite in `run-all.js` (one line) so CI actually enforces it.
4. **Separate PR** for the `refreshFeatures()` stale-cache concern raised by `c0c473b`, updating
   `admin/js/layout.js` and the two static pins together.
5. **Separate issue** for the pre-existing `Admin Dashboard UI` flake.
6. Do not merge PR #73 until items 1–2 land; re-run `npm test` afterwards.
