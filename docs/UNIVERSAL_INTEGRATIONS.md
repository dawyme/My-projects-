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
| `backend/src/lib/integrations/base.js` | Standard Provider Interface: `IntegrationProvider`, capability catalogue (13), provider categories, connection methods, error taxonomy |
| `backend/src/lib/integrations/registry.js` | Provider registry: `register/get/create/list`, plugin directory loading |
| `backend/src/lib/integrations/gateway.js` | Runtime facade: tenant-scoped dispatch, capability gating, webhook handling, bookkeeping |
| `backend/src/lib/integrations/events.js` | Tenant-safe event log writer (`logEvent`, `presentEvent`) |
| `backend/src/lib/integrations/credentials.js` | Credential protection — reuses the reviewed AES-256-GCM supplier envelope, no second crypto implementation |
| `backend/src/lib/integrations/adapters/manual-bank-transfer.js` | BANK adapter with **no API** (manual reconciliation) |
| `backend/src/lib/integrations/adapters/sandbox-psp.js` | Sandbox-only demo PSP (hosted checkout + webhooks, zero network) |
| `backend/src/routes/integrations.js` | Management API + hardened webhook receiver |
| `backend/prisma/schema.prisma` | `IntegrationConnection` + `IntegrationEvent` models (tenant-scoped) |
| `backend/prisma/migrations/20260915120000_universal_integrations/` | Additive migration (no existing table altered) |
| `backend/tests/integrations.test.js` | 41-check verification suite (wired into `run-all.js`) |

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
`disconnect`

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

## 6. Multi-tenancy

- Every connection and event carries `businessId`, resolved **server-side**
  from the session (`tenantOf(req)`). Client-supplied `businessId` values are
  stripped by validation and ignored.
- All reads use find-first-by-(id, tenant); misses return **404** so Tenant A
  can never discover Tenant B's connections, credentials, transactions or sync
  data.
- Management API is tenant-admin-only (`protect` + `adminOnly`, reusing the
  existing auth/RBAC — no new roles, no weakened isolation).
- The platform owner uses the same tenant-scoped API (default tenant scope,
  exactly like the existing payment capture path); there is no cross-tenant
  escape parameter anywhere on this API.
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

All tenant-admin-only. See `backend/src/routes/integrations.js` for schemas.

```
GET    /api/integrations/providers
GET    /api/integrations?providerId=&status=&category=&search=
POST   /api/integrations
GET    /api/integrations/:id
PUT    /api/integrations/:id
POST   /api/integrations/:id/test
POST   /api/integrations/:id/connect
POST   /api/integrations/:id/disconnect
POST   /api/integrations/:id/payments
GET    /api/integrations/:id/payments/:reference
POST   /api/integrations/:id/refunds
GET    /api/integrations/:id/events
PATCH  /api/integrations/:id/enabled
DELETE /api/integrations/:id
POST   /api/integrations/webhooks/:providerId/:webhookToken
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
- Webhooks are logged, not yet wired into orders/invoices/payments.
- `reconcile` / `importStatement` / `voidPayment` / `createPaymentLink` have no
  phase-1 providers yet. The interface defines all four and Gateway dispatch
  exists for `reconcile`; `voidPayment` / `createPaymentLink` /
  `importStatement` dispatch arrives with the first provider that needs it.
- No Admin UI page yet — the API is the foundation `Settings → Integrations`
  will be built on.
- Credential envelope shares the supplier key derivation; a dedicated
  `INTEGRATION_CREDENTIALS_KEY` with re-encryption migration is deferred to a
  later phase if key separation is required.
