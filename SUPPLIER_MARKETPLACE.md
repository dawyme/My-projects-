# Supplier Marketplace

A production supplier-sourcing layer for N&D'S Air Conditioning & Refrigeration
Services: supplier management, pluggable connectors, catalogue import, automatic
synchronisation, markup pricing, worldwide shipping rules, restricted-goods
controls and dropship fulfilment — all inside the existing Admin Dashboard and
on top of the existing catalogue, checkout, payment and order systems.

It is **not** a second application and **not** a second product catalogue. It is
a dedicated top-level section of `/admin/` backed by eight API routers under
`/api/supplier-*`.

---

## 1. Where it lives

| Layer | Location |
| --- | --- |
| Admin section | `admin/js/pages/supplier-*.js`, `admin/js/pages/suppliers.js` |
| Section chrome | `admin/js/pages/supplier-nav.js` |
| Navigation entry | `admin/js/layout.js` — the **Supplier Marketplace** nav group |
| API routers | `backend/src/routes/suppliers.js`, `supplier-integrations.js`, `supplier-products.js`, `supplier-imports.js`, `supplier-syncs.js`, `supplier-fulfillments.js`, `supplier-shipping.js`, `supplier-settings.js` |
| Domain logic | `backend/src/lib/suppliers/` |
| Connectors | `backend/src/lib/suppliers/connectors/` |
| Feed parsers | `backend/src/lib/suppliers/parsers/` |
| Permissions | `backend/src/middleware/supplierPermissions.js` |
| Order glue | `backend/src/lib/order-flow.js` |
| Schema | `backend/prisma/schema.prisma` + `migrations/20260824000000_supplier_marketplace/` |
| Tests | `backend/tests/suppliers.test.js` (`npm run test:suppliers`) |

### Admin navigation

```
Supplier Marketplace
├── Marketplace Dashboard   #/supplier-marketplace
├── Suppliers               #/suppliers
├── Integrations / Plugins  #/supplier-integrations
├── Import Products         #/supplier-imports
├── Supplier Products       #/supplier-products
├── Fulfillment             #/supplier-fulfillment
├── Shipping                #/supplier-shipping
├── Sync & Automation       #/supplier-sync
├── Sync Logs               #/supplier-logs
└── Marketplace Settings    #/supplier-settings
```

Every page uses the platform's existing shell, authentication, toasts, modals,
tables, pagination, empty/loading/error states and responsive sidebar.

---

## 2. Architecture

```
                 Supplier (REST / GraphQL / CSV / XML / JSON / SFTP / email)
                                        │
                          SupplierIntegration (row: config + encrypted secrets)
                                        │
                            SupplierAdapter (class in connectors/)
                                        │
                  ┌─────────────────────┴─────────────────────┐
                  │        Standard Supplier Interface        │
                  │  connect · testConnection · disconnect    │
                  │  importCatalog · syncProducts             │
                  │  syncInventory · syncPricing              │
                  │  submitOrder · getOrderStatus             │
                  │  getTracking · cancelOrder                │
                  └─────────────────────┬─────────────────────┘
                                        │
      ┌──────────────┬──────────────┬───┴──────────┬───────────────┐
      │ Importer     │ Sync Engine  │ Markup engine│ Shipping      │
      │ (preview →   │ (batch, lock,│ (Product →   │ (rules,       │
      │  commit)     │  retry, log) │  Category →  │  countries,   │
      └──────┬───────┴──────┬───────┤  Supplier →  │  restrictions)│
             │              │       │  Global)     └───────┬───────┘
             ▼              ▼       └──────────┬───────────┘
        SupplierProduct ── publish ──► Product (the ONE catalogue)
                                              │
                            existing storefront · cart · checkout · payments
                                              │
                                          Order + OrderItem
                                              │
                                   SupplierFulfillment (dropship)
```

**The core commerce system contains no supplier-specific logic.** Products,
orders, checkout and payments only know three extra things: a product may carry
`supplierStock`/`fulfillmentType`, an order line records how many units came
from owned stock (`localQuantity`), and an order may have `shippingCountry`.
Everything else is in `lib/suppliers/`.

---

## 3. Data model

Added by `20260824000000_supplier_marketplace` (PostgreSQL via `prisma db push`,
SQLite via the local runner — the SQL is written for both).

| Model | Purpose |
| --- | --- |
| `Supplier` | Trade supplier: country, currency, trade type, fulfilment method, countries served/blocked, shipping methods, lead time, supplier-level markup, status (`ACTIVE`/`DISABLED`/`ARCHIVED`) |
| `SupplierIntegration` | One connector per supplier: type, base URL, auth type, non-secret `config`, `credentialsCipher`, masked `credentialFields`, `capabilities`, status, schedule |
| `SupplierProduct` | The supplier's catalogue line — cost, stock, specs, dimensions, restrictions, sync state, mapping state, price override |
| `SupplierProductMapping` | Supplier SKU ↔ platform `Product`. Unique per product per tenant, so a SKU can never create a duplicate |
| `SupplierCatalogImport` | An import job with its preview, verdicts and error log |
| `SupplierSync` | A sync run: type, trigger, status, counters, errors, attempt, parent (retries) |
| `SupplierSyncLog` | Per-record `CREATE`/`UPDATE`/`SKIP`/`ERROR` lines |
| `SupplierFulfillment` | A dropship purchase order against a real `Order`: status, supplier order id, ship-to, tracking, transmission state |
| `SupplierFulfillmentItem` | The lines of that purchase order |
| `SupplierShippingRule` | Scoped (`GLOBAL`/`CATEGORY`/`SUPPLIER`/`PRODUCT`) destination, method, cost model, delivery estimate, restricted flag |
| `SupplierMarkupRule` | `GLOBAL`/`CATEGORY` markup rules (product- and supplier-level rules live on their own rows) |

Existing tables gained only:

* `Product.fulfillmentType` (`LOCAL` default), `Product.supplierStock`,
  `Product.supplierStockAt`
* `Order.shippingCountry`, `Order.shippingPostalCode`
* `OrderItem.localQuantity` (nullable; `null` on pre-marketplace rows = fully local)

### Multi-tenancy

Every supplier-domain row carries `tenantId` (default `"default"`), indexed and
filtered on every query through `tenantOf(req)` in `lib/suppliers/tenant.js`.
The platform's `User` has no business column today, so there is exactly one
tenant; when a `Business` model is introduced, `tenantOf` is the only function
that changes. Cross-tenant reads return 404 and are covered by tests.

---

## 4. Connectors (plugins)

Registered in `lib/suppliers/registry.js`. The registry also scans
`lib/suppliers/plugins/` for extra modules — that is the seam a future Supplier
Plugin Marketplace would install into.

| id | transport | notes |
| --- | --- | --- |
| `REST_JSON` | API | Fully config-driven: endpoints, item path, page/offset/cursor pagination, column map. Auth: `NONE`, `API_KEY`, `BASIC`, `BEARER`, `OAUTH2` (client credentials, token cached) |
| `GRAPHQL` | API | Paste the catalogue/inventory/pricing queries; auth via header or bearer |
| `CSV_FEED` | FILE | CSV/TSV over HTTP(S); delimiter sniffing; auto column mapping |
| `XML_FEED` | FILE | XML over HTTP(S); item node path; DTD/entity rejection |
| `JSON_FEED` | FILE | JSON array or document over HTTP(S) |
| `SFTP` | FILE | SFTP drop directory; **requires the `ssh2` runtime** (see below) |
| `MANUAL` | MANUAL | No API. Catalogue via uploaded file; purchase orders emailed through the existing mailer |

Not every connector offers every capability. `capabilities()` narrows the static
list against what is actually configured (for example `submitOrder` only appears
once an order endpoint is set), and the Admin UI shows the resulting matrix per
integration.

### Adding a new connector without touching the core

1. Create `backend/src/lib/suppliers/connectors/<name>.js`:

   ```js
   const { SupplierConnector } = require('./base');

   class MyConnector extends SupplierConnector {
     static id = 'MY_SUPPLIER';
     static label = 'My Supplier API';
     static description = 'What it does and who it is for.';
     static transport = 'API';                       // API | FILE | MANUAL
     static formats = ['JSON'];
     static authTypes = ['API_KEY'];
     static capabilities = ['connect', 'testConnection', 'importCatalog', 'syncInventory'];
     static requiresCredentials = true;
     static credentialFields = [{ name: 'apiKey', label: 'API key', type: 'secret', required: true }];
     static configFields = [{ name: 'baseUrl', label: 'Base URL', type: 'url', required: true }];

     isConfiguredFor(cap) { return cap !== 'syncInventory' || Boolean(this.config.stockPath); }
     hasCredentials() { return Boolean(this.secrets.apiKey); }

     async testConnection() { /* real request; throw on failure */ }
     async *fetchCatalog({ limit = 100 } = {}) {
       // yield { records, page, cursor, done } batches of normalised records
     }
   }
   module.exports = { MyConnector };
   ```

2. Register it — one line in `registry.js`, or drop the file into
   `lib/suppliers/plugins/`.
3. Nothing else changes. No product, order, checkout, payment or inventory code
   is touched, and the connector appears in the Admin "Available connectors"
   list immediately.

`normalizeRecord(raw, columnMap)` in `connectors/base.js` converts any feed shape
into the canonical record (SKU, MPN, UPC, name, cost, stock, specs, dimensions,
restrictions, country lists). Use it and the importer/sync engine work unchanged.

### SFTP runtime

SFTP needs an SSH implementation. `ssh2` is **not** a baseline dependency, so the
connector detects it at runtime and, when absent, reports:

> The SFTP runtime (ssh2) is not installed on this server — run `npm install ssh2`
> in the backend directory, then restart the API.

The Admin UI shows the connector as *Runtime required* and the connection test
returns that exact message. Nothing is faked. To enable:

```bash
npm install ssh2
```

---

## 5. Credentials and security

* Secrets are encrypted with **AES-256-GCM** (`lib/suppliers/credentials.js`).
  Envelope: `v1.<iv>.<authTag>.<ciphertext>` (base64url), a fresh IV per record,
  authentication tag verified on read — tampered ciphertext throws.
* Key: `scrypt(SUPPLIER_CREDENTIALS_KEY)`, falling back to `JWT_SECRET`. Set
  `SUPPLIER_CREDENTIALS_KEY` in production; the Settings page reports which is in
  use. Rotating the key requires re-entering each integration's secrets.
* Responses carry `credentialFields` only: `{ name, set, fingerprint, updatedAt }`,
  where the fingerprint is `••••<last 4><sha256 prefix>`. Plaintext is never
  serialised, never logged, and `credentialsCipher` is stripped from every
  response.
* On update, omitting a secret keeps it; sending `null` clears it; an empty
  string is ignored so a re-submitted form cannot wipe a stored value.
* `redactString()` scrubs secrets and `Authorization:` headers from any message
  before it reaches `lastError`, sync logs or the audit log.
* Audit entries record credential **field names**, never values.
* SSRF: supplier URLs may not point at loopback, link-local or private ranges,
  and never at cloud metadata addresses. `SUPPLIER_ALLOWED_HOSTS=a,b` opts
  specific hostnames in (on-premise suppliers, test stubs).
* CSV: RFC 4180 parsing with formula-injection neutralisation (`=`, `+`, `@`,
  `-`-prefixed cells are apostrophe-prefixed), control-character stripping,
  10 MB / 50 000-row / 20 KB-cell caps.
* XML: `<!DOCTYPE>`/`<!ENTITY>` are rejected outright, so XXE and entity
  expansion are impossible; 32-level depth and 200 000-node caps.
* Uploads: extension + MIME allow-list, executables and markup refused, 10 MB.
* Authorisation: `protect` (existing JWT) → `requirePermission(<capability>)`.
  ADMIN holds `*`; STAFF defaults to
  `suppliers.view`, `imports.manage`, `sync.manage`, `fulfillment.manage`.
  Overrides are editable from Marketplace Settings (ADMIN only) and enforced
  immediately. Changing marketplace defaults is ADMIN-only.
* Rate limiting: supplier writes get their own budget
  (`RATE_LIMIT_SUPPLIER_WRITE_MAX`, default 400/min) because imports and bulk
  publish are legitimately bursty.
* Everything the Admin renders goes through the existing `esc()` helper.

---

## 6. Catalogue import

`POST /api/supplier-imports/preview` (pasted content),
`/preview-file` (multipart upload) or `/preview-integration` (pull from the
connector) → a `SupplierCatalogImport` row in `PREVIEWING` with a per-row verdict.

```
NEW: 125   UPDATED: 47   UNCHANGED: 83   ERRORS: 6
```

Each preview row carries the normalised record, the exact field-level diff
(`from` → `to`), the matched platform product and the computed price. Nothing
touches the catalogue until `POST /api/supplier-imports/:id/commit`;
`/cancel` discards the preview.

Matching order: **supplier SKU → manufacturer part number → UPC/EAN**. A match
creates a `SupplierProductMapping` (source `AUTO`), so later imports and syncs
update the same product instead of duplicating it. Operators can override or
create mappings manually from Supplier Products → *Match product*
(source `MANUAL`), and mappings persist through every subsequent sync.

Commits are **one transaction per row**: atomic per record, immune to the
interactive-transaction timeout on large feeds, and a failure in one row never
rolls back the rest. Committing the same file twice yields
`NEW 0 / UPDATED 0 / UNCHANGED n`.

Error rows are skipped and downloadable as CSV
(`GET /api/supplier-imports/:id/errors.csv`).

---

## 7. Pricing

Supplier cost and selling price are always separate. Precedence:

```
Product override → Product markup → Category rule → Supplier markup → Global default → cost passthrough
```

* `PERCENT`: `cost × (1 + value/100)` — 100 @ 30 % ⇒ **130**
* `FIXED`: `cost + value` — 100 + 25 ⇒ **125**
* `roundTo` rounds the result to the nearest multiple (0.05, 1, 5, …)
* A product `priceOverride` short-circuits the engine entirely

`GET /api/supplier-products/price-preview` and the pricing editor show the
winning rule, the whole chain and the resulting margin **before** anything is
published. Publishing writes `price` and `costPrice` onto the platform `Product`.

Currency: `fxRates` in Marketplace Settings maps a supplier currency into the
default currency. A missing rate is reported as *rate not configured* — parity
is never assumed.

---

## 8. Inventory model

`Product.quantity` is **always** N&D-owned stock. A supplier feed never writes
to it. Supplier availability lives in `Product.supplierStock` and only becomes
sellable when the product opts in:

| `fulfillmentType` | available stock | who ships |
| --- | --- | --- |
| `LOCAL` | `quantity` (supplier stock ignored) | N&D |
| `SUPPLIER_FULFILLED` | `quantity + supplierStock` | N&D stock first, then the supplier |
| `HYBRID` | `quantity + supplierStock` | N&D stock first, then the supplier |

`allocate(product, qty)` returns `{ local, dropship, short, available }`.
Checkout, cart validation, the storefront feed and admin order entry all go
through it, so the three numbers stay consistent everywhere. The Inventory page
reports *N&D stock / supplier stock / available* side by side, and stock
*value* is still computed from owned stock only.

At order time the split is frozen onto `OrderItem.localQuantity`; only that many
units are deducted from `Product.quantity`, and only that many are returned if
the order is cancelled.

---

## 9. Synchronisation

`lib/suppliers/sync-engine.js` owns the lifecycle; connectors only produce
records.

* **Types**: `CATALOG`, `PRODUCTS`, `INVENTORY`, `PRICING`, `FULL`
* **Triggers**: `MANUAL`, `SCHEDULED`, `RETRY`
* **Locking**: at most one queued/running sync per supplier (409 otherwise),
  plus a global concurrency cap (`syncConcurrency`, default 2)
* **Batching**: records are consumed in pages (`batch`, default 100) and
  progress is written back to the `SupplierSync` row after each batch, so a
  50 000-line catalogue never loads at once and never blocks the dashboard
* **Idempotency**: every write is compared against the stored row; bookkeeping
  columns (`lastSyncedAt`, `syncStatus`, `lastSyncError`) are excluded from the
  comparison, so a no-op sync reports `updated 0 / skipped n`
* **Failure handling**: per-record errors are logged and skipped; a transport
  failure fails the run, records a redacted message and sets the integration to
  `ERROR`. Retries create a new run linked by `parentSyncId` with `attempt + 1`,
  capped at `maxAttempts`
* **Recovery**: `recoverStale()` marks runs left `RUNNING` after a restart as
  `FAILED` with a `Recovered:` note

**Scheduling** is an in-process interval started in `backend/server.js`
(`SUPPLIER_SCHEDULER_DISABLED=true` turns it off). On a multi-instance
deployment run it on **one** instance only. Each integration carries
`syncEnabled`, `syncIntervalMinutes` and `syncTypes`; scheduling is refused
until the integration is connected.

---

## 10. Shipping and restrictions

There is **no default worldwide rate**. A quote exists only when an operator
has defined a rule that matches the destination.

Rule specificity: `PRODUCT → CATEGORY → SUPPLIER → GLOBAL`. Cost model:
`baseCost + perKgCost × kg + perItemCost × qty`, with optional
`freeOverAmount`, plus `minDays`/`maxDays` estimates and an optional carrier.

Access is evaluated in `lib/suppliers/countries.js`:

* supplier `countriesServed` (allow-list; region codes such as `CARIBBEAN`
  expand to their member countries) and `blockedCountries`
* product `allowedCountries` / `blockedCountries` — these narrow, never widen
* platform `blockedCountries` in Marketplace Settings — always wins

Restricted goods (refrigerants and anything else you flag) carry
`restrictionType`, `restrictionNotes`, `documentationRequired`,
`allowedShippingMethods` and per-country lists. A restricted product is quoted
**only** through its allowed methods; if none are available for the destination
the answer is "cannot ship here".

> No legal requirement is encoded anywhere. Every restriction is
> operator-defined data — the platform records and enforces your decisions, it
> does not make them.

Storefront: `GET /api/public/shipping/quote?productId&country&quantity`.

---

## 11. Fulfilment and dropshipping

```
Customer → existing storefront → existing checkout → existing payment gateway
        → existing Order → SupplierFulfillment → supplier → tracking → customer
```

Checkout and payments are untouched. After an order exists,
`orderFlow.afterOrderCreated()` raises one `SupplierFulfillment` per supplier
for the dropshipped remainder (`PENDING`, `transmissionStatus: NOT_SENT`).

**Transmission is never claimed unless it happened.**

* `API` — the connector POSTed the order and the supplier answered 2xx; the
  supplier order id is captured
* `EMAIL` — the `MANUAL` connector sent the purchase order and the mailer
  confirmed it. If `RESEND_API_KEY` is missing the submit **fails** rather than
  reporting success
* `MANUAL` — no automated channel; the fulfilment moves to `READY` and waits for
  an operator

Lifecycle: `PENDING → READY → SUBMITTED → ACCEPTED → PROCESSING →
PARTIALLY_SHIPPED → SHIPPED → DELIVERED`, plus `CANCELLED` / `FAILED`.

Tracking comes from `getTracking()` when the connector offers it, or is entered
by hand. When the connector offers neither, the UI says so explicitly
("Tracking is not supported for this supplier") instead of inventing a number.
Cancelling calls `cancelOrder()` when available and reports whether the supplier
was actually notified.

`syncOrderStatus()` moves the customer's order forward (`SHIPPED`, `COMPLETED`)
to match its fulfilments — never backwards, and only once the order is paid.
`GET /api/public/orders/:reference` returns the fulfilments and tracking so the
customer sees the real status.

---

## 12. API surface

All routes are behind the existing `protect` middleware plus a capability check.

| Router | Base | Notable endpoints |
| --- | --- | --- |
| Suppliers | `/api/suppliers` | `GET /` · `GET /stats` · `GET /connectors` · `GET /types` · `GET /:id` · `POST /` · `PUT /:id` · `PATCH /:id/status` · `POST /:id/archive` · `POST /:id/restore` · `DELETE /:id` · `GET /:id/products|syncs|fulfillments` |
| Integrations | `/api/supplier-integrations` | `GET /` · `GET /connectors` · `GET /:id` · `POST /` · `PUT /:id` · `POST /:id/test|connect|disconnect` · `PATCH /:id/enabled|schedule` · `POST /:id/suggest-mapping` · `DELETE /:id` |
| Supplier products | `/api/supplier-products` | `GET /` · `GET /price-preview` · `GET /:id` · `PATCH /:id/pricing|status` · `POST /:id/publish|unpublish` · `POST /map` · `DELETE /:id/mapping` · `GET /:id/history` · `POST /bulk-publish|bulk-unpublish` |
| Imports | `/api/supplier-imports` | `GET /` · `GET /template.csv` · `POST /preview|preview-file|preview-integration` · `GET /:id` · `POST /:id/commit|cancel` · `GET /:id/errors.csv` |
| Sync | `/api/supplier-syncs` | `GET /` · `POST /` · `GET /automation` · `PATCH /automation` · `POST /automation/run-now` · `POST /sync-all` · `GET /:id` · `GET /:id/logs` · `POST /:id/retry|cancel` |
| Fulfilment | `/api/supplier-fulfillments` | `GET /` · `GET /for-order/:orderId` · `POST /ensure` · `GET /:id` · `POST /:id/submit|tracking|refresh|cancel` · `PATCH /:id/status` |
| Shipping | `/api/supplier-shipping` | `GET /` · `POST /` · `PUT /:id` · `DELETE /:id` · `POST /quote` · `GET /restrictions` |
| Settings | `/api/supplier-settings` | `GET /` · `PUT /` · `GET|PUT /permissions` · `GET|POST /markup-rules` · `PUT|DELETE /markup-rules/:id` · `POST /markup-preview` |

Public additions: `GET /api/public/shipping/quote` and supplier fulfilment /
tracking data on `GET /api/public/orders/:reference`.

---

## 13. Environment variables

```bash
# Dedicated key for supplier credential encryption (recommended in production).
# Falls back to JWT_SECRET; rotating it requires re-entering each integration's
# credentials.
SUPPLIER_CREDENTIALS_KEY="a-long-random-secret"

# Comma-separated hostnames allowed even though they are private/loopback
# (on-premise supplier appliances, test stubs). Cloud metadata is never allowed.
SUPPLIER_ALLOWED_HOSTS=""

# Set to "true" on every instance except the one that should run the scheduler.
SUPPLIER_SCHEDULER_DISABLED="false"

# Rate-limit budgets (optional)
RATE_LIMIT_API_MAX=300
RATE_LIMIT_WRITE_MAX=120
RATE_LIMIT_SUPPLIER_WRITE_MAX=400

# Required by the MANUAL connector to email purchase orders
RESEND_API_KEY=""

# Required by the SFTP connector (not a baseline dependency)
# npm install ssh2
```

---

## 14. Deployment

```bash
npm install
npm run migrate          # prisma db push on Supabase, SQL runner on local SQLite
npm run seed
npm start
```

The migration is additive: no existing column is renamed, retyped or dropped,
and every new column has a default, so existing products keep
`fulfillmentType = LOCAL` and `supplierStock = 0` and behave exactly as before.

On a multi-instance deployment set `SUPPLIER_SCHEDULER_DISABLED=true` on all but
one instance.

---

## 15. Verification

```bash
npm run test:suppliers   # 107 checks — the Supplier Marketplace suite
npm test                 # all suites
npm run build            # app boots + every admin page bundles
```

`backend/tests/suppliers.test.js` boots the real Express app and a **real HTTP
stub supplier**, so the REST/JSON connector is exercised over the network rather
than mocked. It covers:

supplier CRUD, validation, disable/archive/restore · connector catalogue and
capability detection · encrypted credential storage, masking, rotation and
tamper detection · real connection success **and** honest failure on a bad key ·
`NOT_CONNECTED` reporting · SSRF blocking · CSV/XML/JSON import with preview,
commit, idempotency, `UPDATED` diffing, invalid rows, formula injection and XXE
rejection · markup precedence, overrides and rounding · publishing into the
existing catalogue and onto the storefront feed · manual and duplicate mapping ·
owned/supplier/available stock separation and allocation · catalogue, inventory
and pricing sync, idempotency, failure, retry, stale-run recovery and overlap
locking · shipping rules, quotes, country blocking, region expansion and
restricted-method enforcement · checkout of a zero-owned-stock dropship product,
hybrid splitting, cancellation restock · purchase-order submission, duplicate
submission, status polling, tracking, order-status propagation and cancellation
notification · automation and scheduling · permissions and their overrides ·
tenant isolation · audit logging without secret leakage.

---

## 16. Known limitations

* **SFTP** needs `npm install ssh2`; until then the connector reports
  *Runtime required* rather than pretending to connect.
* **Scheduling** is an in-process interval, not a distributed queue — run it on
  one instance. Replacing it with Bull/SQS means swapping
  `lib/suppliers/scheduler.js` only; the engine interface is unchanged.
* **OAuth2** supports the client-credentials grant. Authorization-code flows and
  refresh-token rotation are not implemented; the credential fields are
  modelled, so adding them is a connector change.
* **Exchange rates** are operator-maintained static values, not a live FX feed.
* **Carrier APIs** are not integrated; shipping is rule-based. The quote
  interface is designed so a carrier connector can supply options later.
* Restricted-goods handling records and enforces operator-defined rules only.
  It encodes no legal opinion and is not a compliance system.
