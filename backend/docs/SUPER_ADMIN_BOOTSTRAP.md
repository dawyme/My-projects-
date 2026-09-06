# Super Admin Bootstrap

Creates the first platform-level administrator account — the account that
resolves to the `SUPER_ADMIN` semantic role and can manage tenants, plans,
subscriptions, and everything under `/api/saas/*`.

## Background: what "Super Admin" means here

There is no `SUPER_ADMIN` value in the `User.role` column. Per
`src/lib/permissions.js`:

```js
function roleFor(user) {
  if (user.role === 'ADMIN') return user.businessId ? ROLE.TENANT_ADMIN : ROLE.SUPER_ADMIN;
  ...
}
```

A user is a semantic **SUPER_ADMIN** when `role = 'ADMIN'` **and**
`businessId = null` — a platform-level account with no tenant binding
(see `isPlatformAdmin()` in `src/lib/tenant.js`). This bootstrap utility
exists to create exactly that kind of row, safely and repeatably.

## Files

- `src/lib/superAdminBootstrap.js` — pure/testable core logic (validation,
  idempotency check, creation, audit trail). No CLI parsing, no env reads.
- `scripts/bootstrap-super-admin.js` — CLI wrapper: argument/env parsing,
  the dry-run default, the production write-guard, and output formatting.
- `tests/bootstrap-super-admin.test.js` — contract tests against the test
  database (same pattern as `tests/rbac.test.js` / `tests/api.test.js`).

## Safety model

1. **Dry run by default.** Without `--confirm`, the script validates the
   email/password, checks whether a Super Admin already exists, and
   reports what *would* happen. It never writes.
2. **Idempotent by default.** If a platform-level admin already exists,
   the script refuses to create another one unless `--force` is passed.
   This prevents accidentally minting a second super-privileged account.
3. **Production requires a second, explicit acknowledgement.** When
   `NODE_ENV=production`, `--confirm` alone is not enough — the
   environment variable `SUPER_ADMIN_BOOTSTRAP_PRODUCTION_ACK=yes` must
   also be set for the same invocation. This is deliberate friction for
   the single most privileged account in the system.
4. **Passwords are never persisted as plaintext or logged to a file.**
   If no password is supplied, one is generated and printed to stdout
   exactly once.
5. **Password policy is stricter than the ordinary staff/customer policy**
   in `src/routes/users.js` (12+ chars, upper/lower/digit, blocklist of
   common weak passwords) — this account has platform-wide reach.

## Usage

```bash
# Dry run — validates and reports, writes nothing:
node scripts/bootstrap-super-admin.js --email=owner@ndsairconditioning.com

# Actually create the account (non-production):
node scripts/bootstrap-super-admin.js --email=owner@ndsairconditioning.com --confirm

# Production (see "Production runbook" below):
SUPER_ADMIN_BOOTSTRAP_PRODUCTION_ACK=yes \
  node scripts/bootstrap-super-admin.js --email=owner@ndsairconditioning.com --confirm
```

| Flag / env var | Purpose |
|---|---|
| `--email=<email>` / `SUPER_ADMIN_EMAIL` | Required. Address for the new account. |
| `--name=<name>` / `SUPER_ADMIN_NAME` | Optional, defaults to `Super Admin`. |
| `--password=<pw>` / `SUPER_ADMIN_PASSWORD` | Optional. If omitted, a strong password is generated and printed once. |
| `--force` | Create an additional Super Admin even if one already exists. |
| `--confirm` | Actually write. Omit for a dry run. |
| `--json` | Machine-readable output. |
| `SUPER_ADMIN_BOOTSTRAP_PRODUCTION_ACK=yes` | Required in addition to `--confirm` when `NODE_ENV=production`. |

Run `node scripts/bootstrap-super-admin.js --help` for the full reference.

## Testing

```bash
npm run test:bootstrap-super-admin   # this suite only
npm test                             # full regression suite (includes it)
```

Tests run against the same Prisma-backed test database as the rest of the
suite (see `src/lib/prisma.js`'s SQLite offline fallback) — no mocking of
Prisma, consistent with `tests/rbac.test.js` and `tests/api.test.js`.

## What this PR does **not** do

This PR ships the tool. It does **not** run it against the production
database, and no production Super Admin account is created by merging it.
Production bootstrap is a separate, deliberate operational step — see below.

## Production runbook (performed *after* this PR is merged and CI is green)

1. Confirm the branch is merged to `main` and deployed.
2. From an environment with the production `DATABASE_URL` configured, run:
   ```bash
   SUPER_ADMIN_BOOTSTRAP_PRODUCTION_ACK=yes \
     NODE_ENV=production \
     node scripts/bootstrap-super-admin.js --email=<real-owner-email> --confirm
   ```
3. Store the printed credentials (or the password you supplied) in the
   team's password manager immediately; the CLI shows a generated password
   exactly once.
4. Verify, in order:
   - [ ] `https://ndsairconditioning.com/admin/login.html` authenticates
         successfully with the new account.
   - [ ] The authenticated session resolves to the `SUPER_ADMIN` semantic
         role (`roleFor(user) === 'SUPER_ADMIN'` — reflected in whatever
         the admin UI/`/api/auth/me` surfaces for role).
   - [ ] The account can reach `/api/saas/*` endpoints (tenants, plans,
         subscriptions) without a 403.
   - [ ] The account can perform at least one create/update against
         tenants, plans, and subscriptions to confirm `requirePermission`/
         `authorize` checks pass end-to-end, not just that the route responds.
5. If anything in step 4 fails, do not attempt a second bootstrap without
   diagnosing first — `SUPER_ADMIN_EXISTS` will already be blocking a
   plain re-run, which is the intended guard rail.
