# Universal Banking & Payment Integration Framework (Phase 1)

A provider-agnostic Integration Gateway for the N&D'S multi-tenant SaaS — the
foundation for “any bank / any payment system / any POS / any accounting
system” without locking the platform into a Trinidad-only or Stripe-only
architecture.

Phase 1 establishes the architecture plus two safe proof-of-design adapters.
It does **not** implement real banking integrations, and it does **not** change
existing checkout/payment behaviour.

---

## 1. Architecture

```
N&D'S Application (invoices, orders, checkout, payments, tenants)
        │  provider-agnostic calls only — no vendor branches
        ▼
Integration Gateway  (backend/src/lib/integrations/gateway.js)
  tenant scoping · adapter resolution · capability gating ·
  error normalisation · secret-scrubbed event logging
        │
        ▼
Provider Adapter  (extends IntegrationProvider, one file per institution)
        │
        ▼
Bank / PSP / POS / Accounting provider
```

Application code never imports an adapter directly. It calls the Gateway; the
Gateway loads the tenant's `IntegrationConnection` row, instantiates the
registered adapter, enforces capability detection, executes, and records a
secret-scrubbed `IntegrationEvent`.

This mirrors the proven Supplier Marketplace connector pattern
(`backend/src/lib/suppliers/`): registry + base interface + capability
detection + encrypted credentials + tenant scoping.

## 2. File map

| Path | Purpose |
|---|---|
| `backend/src/lib/integrations/base.js` | Standard Provider Interface: `IntegrationProvider`, capability catalogue (28 — extended by PR #71), provider categories, connection methods, error taxonomy, identity metadata (version/environments/docs) |
| `backend/src/lib/integrations/registry.js` | Provider registry: `register/get/create/list`, duplicate handling, per-provider discovery APIs, plugin directory loading |
| `backend/src/lib/integrations/gateway.js` | Runtime facade: tenant-scoped dispatch, capability gating, idempotency, bounded retries, confirmed lifecycle, normalised results, webhook handling + pipeline handoff, bookkeeping |
| `backend/src/lib/integrations/fields.js` | Metadata-driven configuration schema + server-side validation (PR #71) |
| `backend/src/lib/integrations/results.js` | Normalised connection/payment/transfer/transaction/sync results + error classification (PR #71) |
| `backend/src/lib/integrations/lifecycle.js` | Connection state machine; success only after adapter confirmation (PR #71) |
| `backend/src/lib/integrations/idempotency.js` | Replay protection + webhook dedupe on the existing event log (PR #71) |
| `backend/src/lib/integrations/retry.js` | Bounded, operation-class-aware retries with event telemetry (PR #71) |
| `backend/src/lib/integrations/pipeline.js` | Normalised-event dispatch seam to application flows (PR #71) |
| `backend/src/lib/integrations/events.js` | Tenant-safe event log writer (`logEvent`, `presentEvent`) |
| `backend/src/lib/integrations/credentials.js` | Credential protection — reuses the reviewed AES-256-GCM supplier envelope, no second crypto implementation |
| `backend/src/lib/integrations/adapters/manual-bank-transfer.js` | BANK adapter with **no API** (manual reconciliation) |
| `backend/src/lib/integrations/adapters/sandbox-psp.js` | Sandbox-only demo PSP (hosted checkout + webhooks, zero network) |
| `backend/src/routes/integrations.js` | Management API + hardened webhook receiver + PR #71 framework endpoints |
| `backend/prisma/schema.prisma` | `IntegrationConnection` + `IntegrationEvent` models (tenant-scoped) — PR #71 requires **no schema change** |
| `backend/prisma/migrations/20260915120000_universal_integrations/` | Additive migration (no existing table altered) |
| `backend/tests/integrations.test.js` | 41-check verification suite (wired into `run-all.js`) |
| `backend/tests/provider-framework.test.js` | 39-check Provider Integration Framework suite — PR #71 (wired into `run-all.js`) |

**PR #71 (Provider Integration Framework)** builds on everything above
without altering it — the framework contract (capabilities, configuration
schemas, normalised results, error categories, idempotency, retries, webhook
normalisation and how to add a future provider) is specified in
[`docs/PROVIDER_INTEGRATION_FRAMEWORK.md`](PROVIDER_INTEGRATION_FRAMEWORK.md).

## 3. Provider categories

`BANK` · `PSP` · `POS` · `ACCOUNTING` · `OTHER`

`BANK` covers Trinidad & Tobago banks, Caribbean banks, US/Canadian/UK banks,
international banks and any future institution — **the core never hardcodes a
bank list**. `PSP` covers Stripe, PayPal, WiPay, Tilopay and future PSPs; `POS`
covers Square, Clover, Shopify POS and future systems; `ACCOUNTING` covers
QuickBooks, Xero and future systems.

## 4. Capabilities (opt-in, never forced)

`configure` · `connect` · `testConnection` · `createPayment` ·
`getPaymentStatus` · `verifyPayment` · `refundPayment` · `voidPayment` ·
`createPaymentLink` · `receiveWebhook` · `reconcile` · `importStatement` ·
`disconnect` — plus the PR #71 additions: `capturePayment`, banking
(`getAccounts` · `getBalance` · `getTransactions` · `initiateTransfer` ·
`getTransferStatus` · `verifyAccount`), POS (`createPosTransaction` ·
`getPosTransaction`) and synchronisation (`syncCustomers` · `syncProducts` ·
`syncInventory` · `syncInvoices` · `syncPayments` · `pollSync`) — 28 in
total, grouped as payments / banking / pos / accounting / data / lifecycle.
See [`PROVIDER_INTEGRATION_FRAMEWORK.md`](PROVIDER_INTEGRATION_FRAMEWORK.md) §2.

Each adapter declares only what its institution supports. The Gateway checks
`supports()` before every call; anything unadvertised fails safely with
`UNSUPPORTED_CAPABILITY` (HTTP 400, `retryable: false`) instead of pretending
it succeeded. Unsupported attempts are recorded in the event log but never flip
a healthy connection into `ERROR`.

## 5. Connection methods (no API assumed)

`API_KEY` · `OAUTH2` · `BASIC` · `BEARER` · `HOSTED_GATEWAY` · `OPEN_BANKING` ·
`WEBHOOK` · `SFTP` · `FILE_IMPORT` · `PAYMENT_LINK` · `MANUAL`

Each adapter declares its mechanisms so the UI and Gateway set correct
expectations: a `MANUAL` connection never attempts HTTP; a `FILE_IMPORT`
connection never asks for OAuth credentials. A future SFTP-settlement bank, an
open-banking bank and a manual-reconciliation bank all fit the same interface
with different capability/method subsets.

## 6. Multi-tenancy & the owner-first access model

- Every connection and event carries `businessId`, resolved **server-side**
  from the session (`tenantOf(req)` — or pinned for the owner surface below).
  Client-supplied `businessId` values are stripped by validation and ignored.
- **TENANT_ADMIN (customer tenants)** — full operations (own tenant only):
  all `/api/integrations…` routes. Every read uses find-first-by-(id, tenant);
  misses return **404** so Tenant A can never discover Tenant B's
  connections, credentials, transactions or sync data.
- **SUPER_ADMIN (N&D'S — the platform owner/operator)** — Universal
  Integrations is an OPERATIONAL surface, not a viewer:
  `/api/integrations/platform/owner/connections…` exposes the complete
  management + lifecycle + credential-rotation + normalised-operations API
  for N&D'S's own integrations, delegating to the same handlers, gateway,
  credential envelope and audit trail (one architecture, no second system).
  The owner scope is pinned server-side to the owner business
  (`DEFAULT_TENANT`) — the owner's user record keeps `businessId = NULL`,
  N&D'S is not modelled as a customer tenant, and no owner session ever
  carries a fake business id. Customer-tenant connections are visible only
  through the read-only oversight GETs (`platform/overview|connections|events`,
  safe fields) — the owner never operates or holds another tenant's secrets.
- **RBAC** — management API is admin-only (`protect` + `adminOnly`);
  `/platform/owner/*` additionally requires `platformAdminOnly`; staff never
  gain integration management on any surface.
- Webhook URLs are token-scoped (`/webhooks/:providerId/:webhookToken`) with
  an unguessable per-connection token — no tenant id appears in the URL.

## 7. Credentials & secrets

- Secrets are encrypted at rest with the existing AES-256-GCM envelope
  (`SUPPLIER_CREDENTIALS_KEY`, falling back to `JWT_SECRET`) — the same
  reviewed implementation as supplier credentials. Phase 1 deliberately
  introduces **no** divergent key path or new crypto.
- API responses carry fingerprint descriptors (`••••ab12hash`) — never
  plaintext, never the cipher envelope.
- Event metadata and error messages are structurally redacted (`redact()` /
  `redactString()`) before insert; audit entries record field *names* only.
- Rotation semantics: omitted fields keep their secret, `null` clears it
  (descriptor included), `""` is treated as “no change”.
- `DELETE` destroys the row and its secrets; the scrubbed audit events are
  retained but detached.

## 8. Connection lifecycle

```
NOT_CONNECTED → CONFIGURED → CONNECTED ⇄ DISCONNECTED
                     ↓              ↓
                   ERROR         DISABLED
```

- `POST /:id/test` — real side-effect-free check; success → `CONNECTED`.
- `POST /:id/connect` / `POST /:id/disconnect` — session lifecycle
  (disconnect keeps secrets for reconnect).
- `PATCH /:id/enabled` — disable without deleting secrets.
- Credential/config changes invalidate a previous `CONNECTED` claim;
  changing provider resets to `NOT_CONNECTED` and destroys old secrets.
- Nothing is ever reported `CONNECTED` before a real test succeeds.

## 9. Webhooks

`POST /api/integrations/webhooks/:providerId/:webhookToken`

- Mounted with a raw-body parser **before** CSRF in `app.js`, exactly like the
  existing payment webhooks (providers sign exact bytes; no CSRF weakening for
  normal routes).
- Unknown provider → 404 · unknown token → 404 · bad signature → 401.
- Verification is strictly the adapter's job (`verifyWebhook`, timing-safe,
  never throws on hostile input); only verified payloads reach `parseWebhook`.
- Non-production sandbox fallback mirrors the existing payment webhooks and
  applies **only** to connections with no stored secrets; it can never verify
  a connection that has real secrets, and never runs in production.
- **Phase-1 scope:** verified webhooks are recorded as `IntegrationEvent`s
  (the handoff point). They do **not** mutate orders, invoices or payments —
  wiring provider events into the payment lifecycle is a later, separately
  reviewed phase.

## 10. Error taxonomy

Every Gateway failure normalises to `{ code, category, retryable }`:

| Category | Meaning |
|---|---|
| `CONFIG` | Merchant must fix settings (HTTP 400) |
| `AUTH` | Provider authentication failed (webhook: HTTP 401) |
| `NETWORK` | Transport failure reaching the provider |
| `PROVIDER` | Provider rejected the request |
| `VALIDATION` | Caller input invalid (HTTP 400) |
| `UNSUPPORTED` | Capability not advertised (HTTP 400, never retry) |
| `INTERNAL` | Unexpected failure (HTTP 502) |

## 11. Phase-1 adapters

**`MANUAL_BANK_TRANSFER`** (BANK · `MANUAL`) — proves the framework does not
assume an API: published banking instructions + manual reconciliation, with
`configure` / `connect` / `testConnection` / `createPayment` / `disconnect`
only — no refund/status/webhook surface, making it the regression fixture for safe
unsupported-capability failures. Framework-level only — the existing
`BANK_TRANSFER` checkout path is untouched.

**`SANDBOX_DEMO`** (PSP · `HOSTED_GATEWAY` + `WEBHOOK`) — proves the
hosted-checkout side: redirect creation, status polling, verification,
refunds, HMAC webhooks. In-memory ledger, zero network, every result stamped
`sandbox: true`, redirect URL on the unresolvable `.invalid` TLD, and a hard
refusal to run in production.

## 12. Adding a future provider (example: a T&T bank)

```js
// backend/src/lib/integrations/adapters/first-citizens-tt.js
const { IntegrationProvider } = require('../base');

class FirstCitizensTTProvider extends IntegrationProvider {
  static id = 'FIRST_CITIZENS_TT';
  static label = "First Citizens (T&T)";
  static category = 'BANK';
  static connectionMethods = ['OPEN_BANKING', 'WEBHOOK']; // or API_KEY / SFTP / MANUAL…
  static authTypes = ['OAUTH2'];
  static capabilities = ['connect', 'testConnection', 'createPayment',
    'getPaymentStatus', 'receiveWebhook', 'reconcile', 'disconnect'];
  static regions = ['TT'];
  static requiresCredentials = true;
  static credentialFields = [ /* client secret, webhook secret… */ ];
  static configFields = [ /* environment, account ids… */ ];

  async testConnection() { /* side-effect-free check */ }
  async createPayment(payment) { /* hosted checkout / transfer */ }
  async verifyWebhook(rawBody, headers) { /* timing-safe check */ }
  async parseWebhook(rawBody, headers, body) { /* canonical shape */ }
  // …only what the bank actually supports
}

module.exports = { FirstCitizensTTProvider };
```

```js
// backend/src/lib/integrations/registry.js — one line, or drop it in
// backend/src/lib/integrations/plugins/ for zero-touch loading:
register(require('./adapters/first-citizens-tt').FirstCitizensTTProvider);
```

No changes to invoices, orders, checkout, tenants or core payment logic. The
provider instantly gains: tenant-scoped connections, encrypted secrets,
capability matrix, test/disconnect, event logging, webhook reception and the
`Settings → Integrations` API surface.

## 13. Management API summary

Tenant-admin-only on the tenant paths (entitlement-gated); SUPER_ADMIN-only
on `/platform/owner/*` (N&D'S operations) and the cross-tenant overview GETs
(read-only oversight). See `backend/src/routes/integrations.js` for schemas.

```
GET    /api/integrations/providers
GET    /api/integrations/providers/:id · /:id/capabilities · /:id/schema
POST   /api/integrations/providers/:id/validate
GET    /api/integrations?providerId=&status=&category=&search=
POST   /api/integrations
GET    /api/integrations/:id
PUT    /api/integrations/:id
POST   /api/integrations/:id/test
POST   /api/integrations/:id/connect
POST   /api/integrations/:id/disconnect
POST   /api/integrations/:id/reconnect
POST   /api/integrations/:id/enable · /:id/disable
PATCH  /api/integrations/:id/enabled
POST   /api/integrations/:id/credentials
GET    /api/integrations/:id/capabilities
POST   /api/integrations/:id/operations/:operation
POST   /api/integrations/:id/payments
GET    /api/integrations/:id/payments/:reference
POST   /api/integrations/:id/refunds
GET    /api/integrations/:id/events?operation=&success=
DELETE /api/integrations/:id
POST   /api/integrations/webhooks/:providerId/:webhookToken

# owner-first (PR #71 correction): the SAME management routes above,
# alias-mounted for SUPER_ADMIN with the scope pinned to N&D'S's business —
# swap the base to /api/integrations/platform/owner/connections
# e.g. POST /api/integrations/platform/owner/connections
#      POST /api/integrations/platform/owner/connections/:id/operations/getBalance

# platform oversight (read-only, cross-tenant, safe fields only)
GET    /api/integrations/platform/overview
GET    /api/integrations/platform/connections
GET    /api/integrations/platform/events
```

## 14. Security considerations

- Reuses existing auth (`protect`), RBAC (`adminOnly`), rate limiting,
  CSRF (webhook path exempt pre-parse, identical to payment webhooks),
  validation (zod) and audit trails — no parallel security system.
- Secrets encrypted at rest, fingerprinted in transit to the browser, redacted
  in logs; no plaintext secret is ever logged, returned or stored.
- Tenant isolation enforced at the data-access layer with 404-on-miss; covered
  by symmetric cross-tenant tests in both directions.
- Demo adapter cannot run in production; manual adapter cannot move money.
- No existing payment behaviour changed; no credentials rotated or required.

## 15. Limitations & next phases

- No real bank/PSP/POS/accounting adapters yet — later phases add them behind
  this interface (each with its own review, tests and credentials story).
- Webhooks are logged and dispatched to the normalised-event pipeline, but no
  production pipeline handler mutates orders/invoices/payments yet — the
  lifecycle wiring remains a separately reviewed phase.
- `reconcile` / `importStatement` / `voidPayment` / `createPaymentLink` have no
  phase-1 providers; since PR #71 the Gateway dispatches them (typed and via
  the generic normalised operation endpoint), so the first provider that
  declares them works with no further core work.
- Credential envelope shares the supplier key derivation; a dedicated
  `INTEGRATION_CREDENTIALS_KEY` with re-encryption migration is deferred to a
  later phase if key separation is required.

## 16. Admin UI (PR #69)

PR #68 provided the backend foundation above; PR #69 adds the two admin
surfaces on top of it, inside the existing dashboard shell and navigation (no
second dashboard). Both pages are provider-agnostic: catalogues, connection
forms, credential inputs and capability displays are generated from the
provider metadata returned by `GET /api/integrations/providers`, so a future
bank / PSP / POS / accounting adapter works in the UI with no changes.

### 16.1 Settings → Integrations (TENANT_ADMIN)

Route `#/integrations`, in the Administration nav group (tenant-only) and
linked from the Settings tab bar. A tenant admin sees only their own tenant:

- **Your connections** — responsive cards with provider, category, status,
  capabilities, last test / connect / sync, and last error. Actions: Test
  Connection, Manage (detail), Enable/Disable, Remove.
- **Available integrations** — the provider catalogue with per-provider
  connection status and a Connect entry point.
- **Connect workflow** — one dynamic wizard for every connection method
  (`API_KEY`, `BASIC`/`BEARER`, `OAUTH2`, hosted gateway, open banking,
  webhook, SFTP, file import, payment links, manual): provider, auth type and
  method selects come from the provider metadata, and only the config /
  credential fields that provider actually declares are rendered.
- **Manage (detail)** — capability matrix, non-secret configuration summary,
  stored-credential fingerprints, webhook URL (for webhook-capable providers),
  Test / Connect / Disconnect actions, and the secret-scrubbed activity log.

Credential handling mirrors the supplier UI: stored secrets are shown as
name + fingerprint only, inputs are write-only (blank = keep the server
value), rotation is supported per field, and an explicit per-field control
clears a secret (`null` semantics). Nothing secret is ever written to
localStorage, URLs or logs. Success is only ever reported when the backend
confirms it.

### 16.2 Platform → Universal Integrations (SUPER_ADMIN)

Route `#/platform-integrations`, in the Platform nav group between Feature
Management and Platform Analytics (platform-only). Owner-first (PR #71
correction): N&D'S is the platform operator, so this page is a full
operational surface for N&D'S's own integrations — connect, configure, test,
enable/disable, disconnect/reconnect, rotate/clear credentials, execute
supported provider operations (with idempotency keys) and manage webhook
URLs/secrets — while every customer-tenant connection stays a read-only
oversight card. Owner writes exclusively target
`/api/integrations/platform/owner/connections…` (verified by static test);
the owner is never gated by tenant feature entitlements.

Five tabs, backed by the owner-alias endpoints plus three read-only
cross-tenant endpoints:

```
GET /api/integrations/platform/overview      stats + recent activity + failures
GET /api/integrations/platform/connections   every tenant's connections (paginated, filterable)
GET /api/integrations/platform/events        every tenant's integration events (paginated, filterable)
```

- **Overview** — total / available providers, active connections, connected
  tenants, event totals, connection health by status, failing connections,
  recent events and webhook activity. Every figure comes from live API data.
- **Providers** — the dynamic provider catalogue with platform-wide
  connection counts per provider and a Connect action (opens the same
  metadata-driven wizard as the tenant page, saving through the owner alias).
- **Connections** — two clearly separated zones: *N&D'S integrations*
  (operable: Test / Manage — lifecycle buttons, credential Configure,
  capability matrix, webhook URL, Run provider operation with idempotency
  key, recent activity / Remove) and *Tenant connections* (read-only
  oversight cards: tenant/business, provider, name, category, status,
  capabilities, last tested / connected / sync, last error — filterable by
  search, provider, status, category).
- **Events** — filterable (search, provider, operation, result) activity log
  with tenant, provider, operation, success/failure, error category,
  retryable flag, external reference and timestamp; row click shows detail.
- **Webhooks** — the Gateway receiver explained plus received-webhook
  activity, with signing secrets configured per connection. There is
  deliberately no second webhook system.

Everything on this page is guarded by `platformAdminOnly`. The cross-tenant
oversight GETs return an explicit safe-field allowlist — no
`credentialsCipher`, no secret values or descriptors, no connection config,
no webhook tokens for OTHER tenants. Owner-scope detail naturally carries the
same credential-safe rules as the tenant API: fingerprints only, write-only
secret inputs, blank keeps the stored value.

### 16.3 Tenancy, RBAC and feature entitlement

- The tenant API and UI never accept a client-supplied `businessId`; scope
  always comes from the session, and cross-tenant reads return 404.
- `SUPER_ADMIN` (platform owner, `businessId = NULL`) operates Universal
  Integrations for N&D'S through the operational platform surface
  (`/platform/owner/*` + the Connections/Providers tabs) and oversees every
  tenant read-only; `TENANT_ADMIN` operates the tenant surface for their own
  business only. The owner is never re-modelled as a customer tenant, no
  second owner account exists, and no fake business id is granted to the
  owner's session — the owner alias pins the operational scope server-side
  to N&D'S's own business, the same way every other owner-operated surface
  resolves it.
- Tenant access is controlled by the existing feature-entitlement system via
  the `universal-integrations` feature (`defaultEnabled: true`,
  `routes: ['/integrations']`, `apiPrefixes: ['/api/integrations']`),
  manageable per tenant from Feature Management. The central
  `resolveFeatureAccess` exempts `SUPER_ADMIN` first — a tenant switch can
  NEVER restrict the owner, and integrations implement no private permission
  system. When a tenant disables the feature, the shell hides it from that
  tenant's navigation, blocks the direct route and rejects the API — all
  driven by the same server-computed `/api/features/access` set (PR #71
  correction). The unauthenticated webhook receiver stays outside the gate
  (providers cannot log in), exactly like the payment webhooks.
- Both pages are responsive (card/list layouts, no wide fixed tables) and
  honour the shell conventions: active-menu highlighting, direct-URL and
  refresh support, and back/forward navigation (tab and filter state lives in
  the hash query).
