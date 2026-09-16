# Provider Integration Framework (PR #71)

The provider-agnostic framework layer on top of the Universal Integration
Gateway (PR #68) and the Admin Integration UI (PR #69). It makes
**“add an integration” a packaging problem, not an architecture change**:
future payment service providers, Trinidad & Tobago banks, international
banks, open-banking interfaces, POS systems, accounting platforms, file/SFTP
feeds and webhook providers all arrive as one self-contained adapter file —
without touching the gateway, tenant UI, event system, credential handling
or transaction flows.

```
N&D'S Application → Integration Gateway → Provider Adapter → Provider
                      │        │        │        │        │
                      │        │        │        │        └─ one file per institution
                      │        │        │        └─ lifecycle.js (confirmed transitions)
                      │        │        └─ idempotency.js + retry.js
                      │        └─ results.js + fields.js (normalised contracts)
                      └─ registry.js + base.js (adapter contract)
```

| Module | Responsibility |
|---|---|
| `backend/src/lib/integrations/base.js` | Standard Provider Interface — identity metadata, 28 capabilities, categories, connection methods, error taxonomy, safe defaults |
| `backend/src/lib/integrations/fields.js` | Metadata-driven configuration/credential schema + server-side validation |
| `backend/src/lib/integrations/results.js` | Normalised result shapes + richer error classification |
| `backend/src/lib/integrations/lifecycle.js` | Connection state machine + confirm-before-success guard |
| `backend/src/lib/integrations/idempotency.js` | Replay protection (in-process ledger + durable event-log recovery + webhook fingerprinting) |
| `backend/src/lib/integrations/retry.js` | Bounded, operation-class-aware retries with event telemetry |
| `backend/src/lib/integrations/pipeline.js` | Normalised-event dispatch seam to application flows |
| `backend/src/lib/integrations/registry.js` | Provider registry — discovery, duplicate handling, per-provider metadata |
| `backend/src/lib/integrations/gateway.js` | Runtime facade wiring all of the above per operation |
| `backend/src/lib/integrations/credentials.js` | *(PR #68, reused verbatim)* AES-256-GCM envelope shared with the Supplier Marketplace |
| `backend/src/lib/integrations/events.js` | *(PR #68, extended)* tenant-safe `IntegrationEvent` log — now also carries retry/rotation/lifecycle operations |

Everything is **additive**: every PR #68 module, endpoint, response shape and
test still works unchanged, and the PR #69 UI consumes the richer provider
metadata without any provider-specific branching. **No Prisma schema changes
were required** — the framework lives entirely in code plus the existing
JSON-string columns (`config`, `capabilities`, `credentialFields`,
`metadata`).

---

## 1. Provider adapter contract

`IntegrationProvider` (base.js) is the whole contract. Identity:

| Static | Meaning |
|---|---|
| `id` | unique registry key (e.g. `MANUAL_BANK_TRANSFER`) |
| `label`, `description` | catalogue display strings |
| `category` | `BANK` · `PSP` · `POS` · `ACCOUNTING` · `OTHER` — provider-agnostic, never branched on in core |
| `version` | adapter semver, surfaced to the UI (`v1.1.0` badges) |
| `environments` | `['SANDBOX']` / `['PRODUCTION']` / both — e.g. the demo PSP declares sandbox-only and still hard-refuses production at runtime |
| `docs` | `{ url?, guide?, note? }` documentation metadata |
| `connectionMethods` | `API_KEY`, `OAUTH2`, `BASIC`, `BEARER`, `HOSTED_GATEWAY`, `OPEN_BANKING`, `WEBHOOK`, `SFTP`, `FILE_IMPORT`, `PAYMENT_LINK`, `MANUAL` |
| `authTypes` | accepted auth schemes; validated on connection create/update |
| `providerIdempotency` | **true only if the provider itself dedupes writes by our reference** — gates write retries (see §7) |
| `capabilities` | the opt-in subset this adapter can offer (see §2) |
| `credentialFields` / `configFields` | metadata-driven forms (see §3) |
| `regions`, `requiresCredentials` | catalogue hints + enforced credential presence |

Standard methods (all safe by default — unimplemented ones throw
`UnsupportedCapabilityError`, which the Gateway turns into a standard
`UNSUPPORTED_CAPABILITY` response; nothing pretends to succeed):

`configure` · `connect` · `testConnection` · `disconnect` · `handleWebhook` ·
`validateCredentials` · `createPayment` · `getPaymentStatus` ·
`verifyPayment` · `capturePayment` · `refundPayment` · `voidPayment` ·
`createPaymentLink` · `verifyWebhook` / `parseWebhook` · `reconcile` ·
`importStatement` · `getAccounts` · `getBalance` · `getTransactions` ·
`initiateTransfer` · `getTransferStatus` · `verifyAccount` ·
`createPosTransaction` · `getPosTransaction` · `syncCustomers` ·
`syncProducts` · `syncInventory` · `syncInvoices` · `syncPayments` · `pollSync`

Adapters receive `{ connection, secrets, config, tenantId }` at construction:
secrets are decrypted server-side only, per operation, and are never
reachable from any API response (`redactForLog()` scrubs everything the
Gateway persists about an adapter run).

## 2. Capabilities (dynamic discovery)

28 capability ids grouped for presentation (`CAPABILITY_GROUPS`):

- **payments** — `createPayment`, `getPaymentStatus`, `verifyPayment`, `capturePayment`, `refundPayment`, `voidPayment`, `createPaymentLink`
- **banking** — `getAccounts`, `getBalance`, `getTransactions`, `initiateTransfer`, `getTransferStatus`, `verifyAccount`, `reconcile`, `importStatement`
- **pos** — `createPosTransaction`, `getPosTransaction`, plus `syncProducts` / `syncInventory` / `syncCustomers`
- **accounting** — `syncCustomers`, `syncInvoices`, `syncPayments`, `syncProducts` (products covers products *and* services)
- **data** — `receiveWebhook`, `pollSync`, `importStatement` (file import; manual import = `importStatement` + `MANUAL` method; SFTP settlement = `reconcile`/`importStatement` + `SFTP` method)
- **lifecycle** — `configure`, `connect`, `testConnection`, `disconnect`

Rules:

- Only **declared** capabilities are ever exposed: `GET /providers/:id/capabilities`
  lists just those; `GET /providers/:id` and the connection detail carry the
  full matrix with `supported: false` entries so the UI can grey them out.
- Per-connection narrowing: `isConfiguredFor()` lets an adapter drop a
  capability when the tenant's configuration doesn't enable it; the live
  matrix is `GET /:id/capabilities`.
- The Gateway checks `supports()` before every call; unsupported → standard
  `400 UNSUPPORTED_CAPABILITY` (`retryable: false`), logged as a failed
  event but never marking a healthy connection `ERROR`.

## 3. Configuration schema (metadata-driven forms)

Each field descriptor normalises to a canonical shape (fields.js):

```
{ name, key, label, type,                       // text|textarea|number|boolean|select|password|url|email|json|checkbox
  required, secret, writeOnly,                  // secrets ⇒ writeOnly always true
  supportsRotation, supportsClearing,           // default true for secrets
  environmentSpecific,                          // field value differs per environment
  validation: { required, minLength, maxLength, min, max, pattern, oneOf, message },
  help, placeholder, default, options, group, authTypes, ... }   // extras preserved
```

- The PR #69 connection wizard renders these verbatim — there are **no
  provider-specific forms in the UI**, and `help`/`environmentSpecific`/
  `supportsClearing`/`supportsRotation` are honoured by the shared renderers.
- Secret fields belong to `credentialFields` only; declaring `secret: true`
  on a config field is flagged as a validation error.
- `GET /api/integrations/providers/:id/schema` returns the full normalised
  schema (wizard metadata).
- `POST /api/integrations/providers/:id/validate` pre-flights a DRAFT
  (authType/method match + required/optional/secret validation + patterns +
  select options) with **nothing persisted and no provider contacted**.
- The same `validateConfiguration()` runs server-side, so client checks are
  UX only; secret **values are never echoed** by validation output.

## 4. Connection lifecycle

Canonical lifecycle `DISCONNECTED → CONNECTING → CONNECTED → DISABLED → ERROR`
is implemented over PR #68's persisted statuses (lifecycle.js) — **no new
stored status values**:

| Spec phase | Stored status |
|---|---|
| `DISCONNECTED` | `NOT_CONNECTED` / `CONFIGURED` / `DISCONNECTED` |
| `CONNECTING` | transient — reported as `lifecyclePhase: 'CONNECTING'` while a connect/test/reconnect is in flight; never persisted |
| `CONNECTED` | `CONNECTED` — **only after adapter confirmation** |
| `DISABLED` | `DISABLED` |
| `ERROR` | `ERROR` |

Operations (all tenant-scoped): `POST /:id/connect`, `POST /:id/test`,
`POST /:id/reconnect`, `POST /:id/disconnect`, `POST /:id/enable`,
`POST /:id/disable` (aliases of `PATCH /:id/enabled`), and credential
rotation via `POST /:id/credentials`.

**Never a fake success.** `lifecycle.assertConfirmed()` runs inside every
connect/test/reconnect: the transition to `CONNECTED` happens only when the
adapter result confirms (`{ ok|success|connected: true }`, or a non-throwing
void result; an `{ ok:false }` result produces `502 PROVIDER_UNCONFIRMED`
and `ERROR` status without retry). The typed `/test` and `/connect` routes
therefore report truth: whatever the provider said, never more.

**Rotation is atomic** where practical: merge (omitted = keep, `null` =
clear, value = replace) → required-credential check → optional adapter
`validateCredentials()` against the *proposed* secrets → one `UPDATE` swaps
cipher + descriptors together. Any failure leaves the previous envelope
untouched. A rotation invalidates the previous `CONNECTED` claim
(`CONFIGURED` until the next successful test).

## 5. Normalised results (results.js)

Provider response blobs stop at the adapter. The generic operation endpoint
returns framework shapes:

- **connection result** — `{ success, provider, connectionId, status, message, errorCategory? }`
- **payment result** — `{ provider, externalReference, transactionId, internalReference, status, amount, currency, action?, url?, instructions?, sandbox, createdAt?, updatedAt?, metadata }` with `status ∈ PENDING | AUTHORIZED | PAID | FAILED | CANCELLED | REFUNDED | PARTIALLY_REFUNDED | UNKNOWN` (provider aliases like `SUCCESS`/`SETTLED`/`APPROVED` normalise to `PAID`)
- **transfer result** — `{ provider, externalReference, transactionId, status ∈ PENDING | SUBMITTED | PROCESSING | COMPLETED | FAILED | RETURNED | UNKNOWN, amount, currency, timestamps, metadata }`
- **transaction line** — `{ provider, externalTransactionId, amount, currency, status, type ∈ DEBIT | CREDIT | REFUND | CHARGEBACK | FEE | TRANSFER | PAYMENT | SALE | VOID, timestamp, counterparty, metadata }`
- **sync result** — `{ provider, resource, created, updated, unchanged, failed, total, truncated, nextCursor, completedAt, metadata }`

Safe metadata only; the Gateway additionally runs `adapter.redactForLog()`
before anything is persisted, so provider diagnostics survive where safe and
secrets never do. The typed payment endpoints keep returning the adapter's
own result object verbatim for PR #68/#69 compatibility — normalisation is
what the **generic** endpoint and future application flows consume.

## 6. Error taxonomy

`IntegrationError { code, category, retryable, status }`, categories:

| Category | Meaning | Typical HTTP | Retryable |
|---|---|---|---|
| `CONFIG` | merchant must fix settings | 400 | no |
| `AUTH` | authentication failure (bad/expired credentials) | 401 | no |
| `AUTHZ` | authenticated but not permitted (scopes/entitlement) | 403 | no |
| `VALIDATION` | caller input rejected | 400 | no |
| `NETWORK` | transport failure reaching the provider | 502 | **yes** |
| `TIMEOUT` | provider didn't answer — *the request may have executed* | 504 | **yes** |
| `RATE_LIMIT` | provider throttling | 429 | **yes** (back off) |
| `PROVIDER` | provider rejected (declines, validation, 5xx) | 400–502 | only when transient |
| `UNSUPPORTED` | capability not declared | 400 | never |
| `INTERNAL` | framework fault | 502 | no |
| `UNKNOWN` | unclassified | 502 | no |

`AUTHZ`, `TIMEOUT`, `RATE_LIMIT` and `UNKNOWN` are the PR #71 refinement of
PR #68's taxonomy — purely additive; existing categories and codes
(`UNSUPPORTED_CAPABILITY`, `INTEGRATION_NOT_CONFIGURED`,
`WEBHOOK_VERIFICATION_FAILED`, `CONNECTION_NOT_FOUND`, …) are unchanged.
`results.classifyError()` derives the classification from HTTP-like status
codes, error codes and message heuristics, and is used identically by the
retry executor, the event log (including each `retryAttempt`) and the failure
normalisation, so those three never disagree. Provider diagnostics are kept
only after `redactForLog()`; secrets are never included.

## 7. Idempotency

Keyed operations accept `idempotencyKey` (body field or `Idempotency-Key`
header) on `POST /:id/payments`, `POST /:id/refunds` and the generic
`POST /:id/operations/:operation` (writes: createPayment, capture, refund,
void, payment links, transfers, verifyAccount, all syncs, poll, reconcile,
importStatement). Semantics follow the established Stripe-style contract:

1. first request executes and its result is cached per
   (tenant, connection, operation, key) for a bounded TTL;
2. a **duplicate** request (same key + same payload digest) replays the
   original result — `meta.replayed: true`, HTTP 200 — and **never re-invokes
   the provider**;
3. the same key with a **different** payload → `409 IDEMPOTENCY_CONFLICT`;
4. a concurrent identical request → `409 IDEMPOTENCY_IN_FLIGHT` (retry with
   the same key to receive the outcome);
5. a failed request **releases** the slot — retrying after a timeout is the
   caller's deliberate, visible choice;
6. restart resilience without a new table: each keyed success stores
   `dedupeRef` (a truncated SHA-256 of the key — never the key itself) in the
   existing `IntegrationEvent` metadata. If the in-process ledger is cold,
   the Gateway finds the completed event and replays a durable marker
   (`meta.durableReplay: true`) instead of re-executing. No second idempotency
   system was invented — the PR #68 event log *is* the durable record.

**Webhook processing** is idempotent through the same mechanism's fingerprint
layer: verified events are canonicalised (`results.providerEvent`) and
fingerprinted (connection + reference + payload digest); an identical
redelivery is answered `duplicate: true` and recorded as such, while a
redelivery whose previous pipeline dispatch `FAILED` is safely re-processed
(at-least-once delivery + idempotent handling).

## 8. Bounded retries

retry.js — **policy is derived from the operation class, never assumed**:

- safe operations (reads, status polling, tests, sync/pull jobs,
  reconciliation, webhook handling) retry on retryable categories
  (`NETWORK`, `TIMEOUT`, `RATE_LIMIT`, transient `PROVIDER` 5xx);
- state-mutating writes (createPayment, refunds, transfers, links, imports)
  retry **only** when the adapter declares `providerIdempotency = true`,
  i.e. the provider itself dedupes by our reference. Otherwise a timeout
  after “the money moved” could become a double charge, so the Gateway does
  not resend — callers retry explicitly with an idempotency key instead;
- `AUTH`, `AUTHZ`, `CONFIG`, `VALIDATION`, `UNSUPPORTED`, `UNKNOWN` and any
  `retryable: false` error are never retried.

Attempts: `1 + INTEGRATION_RETRY_ATTEMPTS` (default 2 → max 3 tries, hard
ceiling 6 regardless of configuration). Backoff: exponential with full
jitter, capped by `INTEGRATION_RETRY_MAX_MS` (default 8s). Every retry writes
a `retryAttempt` IntegrationEvent — `{ operation, attempt, maxAttempts,
backoffMs }` with the adapter-redacted error message — so tenants and the
platform owner can see provider flakiness in the same log as everything else.

## 9. Webhook normalisation

**One receiver, unchanged**: `POST /api/integrations/webhooks/:providerId/:webhookToken`
(raw-body mount before CSRF, unguessable per-connection token, the same
unauthenticated path PR #68 shipped — no second webhook system, no duplicate
infrastructure). `gateway.handleWebhook` now runs the full pipeline:

1. **identify** — provider id → registry; token → exactly one connection row
   (unknown provider/token → 404, disabled connection → ignored);
2. **verify** — `adapter.verifyWebhook` on raw bytes, timing-safe, never
   throws; non-production sandbox fallback only for connections with **no**
   stored secrets (unchanged);
3. **normalise** — `adapter.parseWebhook` → canonical event
   (`type/reference/transactionId/status/amount/currency/occurredAt`);
4. **idempotency** — fingerprint dedupe against the event log (§7);
5. **record** — success-scrubbed `IntegrationEvent` with the dispatch outcome;
6. **handoff** — `pipeline.dispatch()` runs named application subscribers
   with `{ tenantId, connectionId, providerId, event }`.

Tenant safety is structural: the tenant is the **connection row's**
`businessId`, never anything derived from the payload, so a webhook can
never select another tenant; handlers receive that scope and must resolve
internal records within it. This phase registers **no production handler** —
wiring provider events into orders/invoices remains the separately reviewed
follow-up PR #68 deferred (webhooks still never mutate orders).

## 10. Credentials (unchanged from PR #68, hardened)

- Storage/encryption: the reviewed AES-256-GCM supplier envelope via
  `lib/integrations/credentials.js` — no second mechanism, no new key path.
- Responses expose name + fingerprint descriptors only; plaintext secrets
  never leave the server and never appear in URLs, localStorage, logs,
  audit entries or `IntegrationEvent` payloads (enforced in events.js +
  `redactForLog`; covered by leak checks in both suites).
- Wizard semantics: blank write-only field = keep existing value; explicit
  per-field “remove stored secret” = `null` clear; new value = rotate.
  Rotation/clear availability is field metadata (§3), not UI branching.
- `DELETE /:id` destroys the connection and its secrets; events survive,
  scrubbed and detached.

## 11. Registry

`registry.register(Provider, { source, force })` — adapters (built-in or
dropped into `backend/src/lib/integrations/plugins/`) are the only thing a
new integration requires. Discovery/validation APIs: `list()`, `ids()`,
`entry(id)`, `getMetadata(id)`, `getCapabilities(id)`,
`getConfigurationSchema(id)`, `declaredCapabilities(id)`,
`supportsOperation(id, capability)`, `validate(ProviderClass)`,
`create({ connection, … })`, plus `capabilities()/categories()/connectionMethods()`
catalogue metadata (now including capability groups).

Duplicate handling: re-registering the same class is a no-op; a different
class under a taken id **throws** unless `{ force: true }` (no silent
plugin shadowing of built-ins). `loadFromDirectory()` keeps the plugin
convention: marketplace-style distribution with zero core changes.

## 12. API surface (PR #71 additions)

```
GET  /api/integrations/providers/:id                metadata (identity + contract)
GET  /api/integrations/providers/:id/capabilities  declared capability list
GET  /api/integrations/providers/:id/schema        config/credential schema
POST /api/integrations/providers/:id/validate      draft pre-flight (nothing stored)
POST /api/integrations/:id/enable · /:id/disable   lifecycle aliases (PATCH parity)
POST /api/integrations/:id/reconnect                confirmed re-establishment
POST /api/integrations/:id/credentials              atomic rotation (+ adapter validation)
GET  /api/integrations/:id/capabilities             live per-connection matrix
POST /api/integrations/:id/operations/:operation    normalised generic execution
GET  /api/integrations/:id/events?operation=&success=  filtered event inspection
```

Every addition inherits the existing rules unchanged: `protect` +
`adminOnly`, tenant scope from the session (`tenantOf`) with 404-on-miss,
`universal-integrations` feature entitlement (`featureProtectedRoute` in
`app.js`), write rate limiting, CSRF on management routes, and the single
unauthenticated webhook exception. Cross-tenant access fails server-side on
every new route (verified in both directions by the suites).

### Owner-first access model (PR #71 correction)

N&D'S (SUPER_ADMIN) is the platform owner-**operator**, so every management
route above is ALSO served under `/api/integrations/platform/owner/connections…`
— guarded by `platformAdminOnly` and delegating to the SAME handler
instances with the scope pinned server-side to N&D'S's own business
(`DEFAULT_TENANT`). No second implementation, no fake business id on the
owner (their user record keeps `businessId = NULL`; N&D'S is not re-modelled
as a customer tenant), and no separate permission system:

- **SUPER_ADMIN**: full operations for N&D'S's connections (connect,
  configure, test, enable/disable, disconnect/reconnect, credential
  rotate/clear, capabilities, normalised operations, events, webhook URLs)
  + read-only cross-tenant oversight (`platform/overview|connections|events`).
  Tenant feature switches NEVER restrict the owner — the bypass is
  implemented first inside the central `resolveFeatureAccess`
  (`lib/features.js`), which every `featureProtectedRoute` and
  `/api/features/access` consumer shares.
- **Customer tenants**: normal tenant RBAC (`protect` + `adminOnly`) and
  strict isolation; when Feature Management disables `universal-integrations`
  for a tenant, the admin shell (driven by `/api/features/access`) hides it
  from that tenant's navigation, blocks the direct route, and the API
  returns 403. Re-enabling restores access exactly as configured.
- Owner-scope tenant ids 404 through `/platform/owner/*` — the owner alias
  cannot be used to operate another tenant's connection.
- The admin UI on `Platform → Universal Integrations` mirrors this: writes
  only ever target `OWNER_BASE = /integrations/platform/owner/connections`
  (statically asserted); tenant rows stay read-only cards.

## 13. Adding a future provider

Rules of the road, then a complete example.

1. One file under `adapters/` (or dropped into `plugins/`) extending
   `IntegrationProvider`.
2. Declare identity + category from the five provider-agnostic buckets;
   declare only the capabilities the institution truly supports; declare the
   configuration schema; implement only the declared methods.
3. Never hard-code a bank/PSP list, one auth model, one transfer format or
   one webhook style in the core — the framework deliberately supports API,
   OAuth2, open banking, hosted gateways, SFTP, secure file import, webhooks
   and manual reconciliation as *parallel* mechanisms, not as variants of one.
4. Do not fabricate an API: an adapter ships when the provider's real
   integration mechanism is documented and reachable; capabilities for
   unsupported operations simply stay undeclared (the UI then offers no
   button for them and the API answers `UNSUPPORTED_CAPABILITY`).
5. No payment-flow migration: existing Stripe/PayPal/WiPay/Tilopay/COD/
   BANK_TRANSFER checkout keeps running through `lib/payments` unchanged.
   A PSP may later be representable through the Gateway (see §15) — that is
   a separate, explicitly reviewed phase.

### Worked example — a hypothetical provider

```js
// backend/src/lib/integrations/adapters/hypo-bank.js  (illustration only —
// there is no real institution behind it; do NOT ship names of T&T banks
// against invented APIs)
const { IntegrationProvider } = require('../base');

class HypoBankProvider extends IntegrationProvider {
  static id = 'HYPO_BANK';
  static label = 'Hypo Bank (example)';
  static description = 'Example open-banking-style provider demonstrating the adapter contract.';
  static category = 'BANK';
  static version = '1.0.0';
  static environments = ['SANDBOX', 'PRODUCTION'];
  static docs = { url: 'https://example.invalid/hypo-bank/api' };
  static connectionMethods = ['OPEN_BANKING', 'WEBHOOK'];
  static authTypes = ['OAUTH2'];
  static providerIdempotency = true;      // the API dedupes by our reference
  static capabilities = ['connect', 'testConnection', 'getAccounts', 'getBalance',
    'getTransactions', 'initiateTransfer', 'getTransferStatus', 'receiveWebhook', 'disconnect'];
  static requiresCredentials = true;
  static credentialFields = [
    { name: 'clientId', label: 'OAuth client ID', type: 'text', required: true },
    { name: 'clientSecret', label: 'OAuth client secret', type: 'password', required: true },
    { name: 'webhookSecret', label: 'Webhook signing secret', type: 'password', required: false },
  ];
  static configFields = [
    { name: 'baseUri', label: 'API base URL', type: 'url', required: true, environmentSpecific: true },
    { name: 'consentId', label: 'Open-banking consent ID', type: 'text', required: false },
  ];

  async testConnection() { /* GET /accounts (1 item) — side-effect-free */ return { ok: true }; }
  async getAccounts()    { /* map provider payloads… */ return [{ externalId: 'ACC-1', currency: 'TTD', maskedIdentifier: '••••1234' }]; }
  async initiateTransfer(t) { /* POST with Idempotency-Key: t.reference */ return { reference: t.reference, status: 'SUBMITTED' }; }
  async verifyWebhook(rawBody, headers) { /* timing-safe HMAC; never throws */ return false; }
  async parseWebhook(rawBody, headers, body) { /* → { reference, transactionId, status, amount, currency } */ return null; }
}
module.exports = { HypoBankProvider };
```

`registry.register(HypoBankProvider)` (or plugin-directory loading) is the
whole integration. The tenant immediately gains: catalogue + wizard
(metadata-driven, zero UI work), encrypted credential handling, lifecycle
(test/connect/reconnect/enable/disable), capability matrix, idempotent
transfers with bounded retries, normalised results, webhook reception with
dedupe, event history and platform visibility. A future T&T bank with only a
statement-drop SFTP feed registers the same way with
`connectionMethods = ['SFTP']` and `capabilities = ['importStatement', 'reconcile']`
— same tenant UI, same event log, no core changes.

## 14. Test fixtures vs real providers

`backend/tests/provider-framework.test.js` registers temporary fixture
providers (flaky transport, rate limiter, unconfirmed verifier, strict
credentials, idempotent PSP writer, POS syncer, file importer) to exercise
every framework path deterministically — in-process, unregistered at the end.
Real-world provider names are not attached to invented APIs anywhere in this
PR.

## 15. Relationship to the existing payment system

`lib/payments` (Stripe, PayPal, WiPay, Tilopay, COD, bank transfer) is the
production checkout path and is **untouched** by this phase. Conceptual
mapping for a later, separately reviewed migration:

| Existing | Gateway representation (later phase) |
|---|---|
| Stripe / PayPal / WiPay | PSP adapter: `createPayment`, `getPaymentStatus`, `refundPayment`, `receiveWebhook`, `providerIdempotency: true` (Stripe supports idempotency keys) |
| Tilopay | PSP adapter: `createPayment` + `verifyPayment` (consult-on-return; no webhooks for one-off payments → `receiveWebhook` simply undeclared) |
| BANK_TRANSFER (checkout) | `MANUAL_BANK_TRANSFER` is already the generalised version; tenant-specific banks arrive as `MANUAL` or `FILE_IMPORT`/`SFTP` BANK adapters |
| CASH_ON_DELIVERY | stays an internal payment method — no external provider to adapt |

Nothing in this PR wires checkout through the Gateway; the mapping exists so
that when (and only when) a migration is approved it is an adapter +
routing-review task rather than a rewrite.

## 16. Verification

`node backend/tests/provider-framework.test.js` — 39 checks: registry
(discovery/duplicates/validation), configuration (required/optional/secret/
validation/rotation/clear), lifecycle (connect/test/enable/disable/disconnect/
reconnect + failed-connection), capabilities (supported/unsupported), error
categories over HTTP (AUTH/AUTHZ/VALIDATION/TIMEOUT/NETWORK/RATE_LIMIT/
PROVIDER), idempotency (duplicate requests, changed-body conflict, durable
replay marker, duplicate webhooks), retry (retryable vs non-retryable,
bounded attempts, `retryAttempt` events), security (secret containment across
responses/events/audits, bidirectional tenant isolation, RBAC, webhook
verification-before-dedupe), and both proof providers working through the
new paths. Existing suites — PR #68 gateway (41), PR #69 admin UI (24),
payments (33+12) — run unchanged as part of `npm test`.
