# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- **Global Supplier Marketplace** — a dedicated top-level Admin Dashboard
  section (`#/supplier-marketplace`) with ten pages: Dashboard, Suppliers,
  Integrations / Plugins, Import Products, Supplier Products, Fulfillment,
  Shipping, Sync & Automation, Sync Logs and Settings. Built on the existing
  shell, authentication, components and styling — no second dashboard, no second
  product catalogue, no second auth system. See
  [`SUPPLIER_MARKETPLACE.md`](SUPPLIER_MARKETPLACE.md).
- **Supplier plugin/connector architecture** (`backend/src/lib/suppliers/`) with
  a standard supplier interface (`connect`, `testConnection`, `disconnect`,
  `importCatalog`, `syncProducts`, `syncInventory`, `syncPricing`,
  `submitOrder`, `getOrderStatus`, `getTracking`, `cancelOrder`) and seven
  connectors: REST/JSON, GraphQL, CSV feed, XML feed, JSON feed, SFTP and
  manual/email. Per-integration capability detection is shown in the Admin UI;
  a new supplier transport can be added by registering one file, with no change
  to products, orders, checkout or payments.
- **Supplier management** — CRUD, disable, archive/restore, trade types
  (extensible), countries served/blocked, shipping methods, lead time,
  supplier-level markup, and per-supplier views of catalogue, sync history and
  fulfilments.
- **Encrypted supplier credentials** — AES-256-GCM envelopes, masked
  fingerprints in the UI, secrets never serialised or logged, SSRF-safe supplier
  URLs (`SUPPLIER_ALLOWED_HOSTS` opt-in for on-premise hosts).
- **Catalogue import** — CSV/XML/JSON upload or live pull from a connector,
  always previewed (`NEW / UPDATED / UNCHANGED / ERRORS` with per-row diffs)
  before commit, with formula-injection and XXE hardening, duplicate prevention
  by supplier SKU → manufacturer part → UPC/EAN, manual mapping and a
  downloadable error report.
- **Markup engine** — `Product → Category → Supplier → Global` precedence,
  percentage or fixed, optional rounding, price overrides, and a price preview
  before publishing.
- **Inventory separation** — `Product.quantity` stays N&D-owned; supplier
  availability lives in `Product.supplierStock` and only becomes sellable under
  `SUPPLIER_FULFILLED`/`HYBRID`. Checkout, cart, storefront feed, order entry
  and the Inventory page all report owned / supplier / available separately.
- **Sync engine** — batched, paginated, locked per supplier, concurrency-capped,
  idempotent, with retries, per-record logs, stale-run recovery and an
  in-process scheduler (`Sync & Automation`).
- **Supplier shipping** — scoped rules (product/category/supplier/global),
  country and region allow/block lists, per-kg/per-item cost models, delivery
  estimates, restricted-goods rules, and no default worldwide rate.
- **Dropship fulfilment** — supplier purchase orders raised from real customer
  orders, transmitted by API or email (never reported as sent unless a transport
  accepted them), with tracking, lifecycle statuses, cancellation and automatic
  customer-order status propagation.
- **Restricted-product controls** — configurable restriction type, notes,
  documentation requirements, allowed shipping methods and per-country lists.
  Nothing legal is encoded; every restriction is operator-defined.
- **Supplier permissions** — nine capabilities layered on the existing role
  system, with admin-editable per-role overrides.
- **Automated Supplier Marketplace suite** (`backend/tests/suppliers.test.js`,
  `npm run test:suppliers`) — 107 checks driving the real API against a real
  HTTP stub supplier, covering connectors, credentials, imports, pricing,
  inventory, sync, shipping, fulfilment, permissions and tenant isolation.

- **Calendar & Scheduling foundation (Phase C)** — the dispatch calendar at
  `#/calendar` now offers **Day / 3-Day / Week / Month / Agenda** views with
  per-view navigation, date jump, and filtering by technician (incl.
  unassigned), status, service, customer and text search, plus a second
  **Technician schedules** tab (per-day working hours, time off / holidays,
  business breaks, closed days) for admins. Booking events show start→end,
  duration, technician, recurring-maintenance flag and work-order linkage; the
  appointment modal supports status changes, technician assignment,
  reschedule (with a live availability check), notes, cancel and delete.
  See [`docs/PHASE_C_CALENDAR_SCHEDULING.md`](docs/PHASE_C_CALENDAR_SCHEDULING.md).
- **Server-side appointment conflict detection** (`src/lib/scheduling-rules.js`)
  on booking create / reschedule / assign: technician double-booking and
  overlaps (using effective duration `Booking.durationMin ?? Service.durationMin ?? 60`
  plus an optional travel buffer), approved time-off, working hours (technician
  overrides → business hours), breaks, closed days, minimum lead time and max
  booking window. Tenant policy lives in the Settings `scheduling` section:
  `conflictPolicy: "warn" | "block"` (default **warn** — no behaviour change for
  existing flows; block returns 400 with the conflict list), `minLeadHours`,
  `maxBookingDays`, `strictWorkingHours` (promotes working-hours / break /
  closed-day warnings to blocking conflicts).
- **New scheduling APIs** at `/api/scheduling` (feature-gated on the existing
  `calendar` feature, tenant-scoped server-side): working hours
  (`GET/PUT/DELETE`), time off (`GET/POST`, `PATCH` status, `DELETE`), breaks
  (`GET/PUT/DELETE`), closed days (`GET/POST/DELETE`) and a technician roster
  (`GET /technicians`) for the staff/technician views. `Booking` gains
  nullable `durationMin` / `bufferMin`; new models `WorkingHours`, `TimeOff`,
  `BreakPeriod`, `ClosedDay` (additive migration
  `20260912000000_calendar_scheduling`; not applied to production by this change).
- **Calendar / availability endpoints** — `GET /api/bookings/calendar` extends
  the month-only endpoint with `view=day|3day|week|month|agenda`, `date`,
  `serviceId`, `customerId`, `search` and richer events (`end`, `durationMin`,
  `bufferMin`, `customerId`, `serviceId`, `technicianId`, `workOrder`,
  `recurring`); `GET /api/bookings/availability` pre-flight checks a slot
  (`{ available, start, end, conflicts, warnings }`). Recurring maintenance
  occurrences (real bookings) appear on the calendar flagged `recurring`;
  Phase B behaviour is untouched.
- **Scheduling notification event bus** (`src/lib/scheduling-events.js`) —
  in-process `booking.created / updated / rescheduled / assigned / cancelled`
  events for future email/SMS/WhatsApp channels (Phases G/H); existing Resend
  calls are unchanged.
- **Tests** — `backend/tests/scheduling-rules.test.js` (pure unit contracts)
  and `backend/tests/calendar-scheduling-contract.test.js` (28-check API
  contract: views, filters, availability, warn/block conflicts, time-off,
  working hours + strict, breaks/closed days, lead time/window, duration,
  recurring, cancellation, event bus, SUPER_ADMIN, tenant isolation, feature
  entitlement). Registered in `run-all.js` (22 → 24 suites); `ui.test.js`
  calendar needles extended.
- **Settings → Scheduling tab** — admin UI for the booking rules
  (conflict policy, lead time, booking window, strict working hours).
- **Universal Banking & Payment Integration Framework (Phase 1)** — a
  provider-agnostic Integration Gateway
  (`N&D'S App → Gateway → Provider Adapter → Bank/PSP/POS/Accounting`) with a
  standard provider interface (13 opt-in capabilities, 5 provider categories,
  11 connection methods spanning API, OAuth, hosted gateways, open banking,
  webhooks, SFTP, file import, payment links and manual reconciliation), a
  provider registry with plugin loading, tenant-scoped connections
  (`IntegrationConnection`) with AES-256-GCM encrypted secrets (reusing the
  reviewed supplier envelope — no new crypto), a secret-scrubbed event log
  (`IntegrationEvent`), a stable `{ code, category, retryable }` error
  taxonomy, and a tenant-admin management API plus hardened webhook receiver
  (`/api/integrations/*`, `/api/integrations/webhooks/:provider/:token`).
  Ships with two safe proof-of-design adapters — `MANUAL_BANK_TRANSFER` (BANK,
  no API required) and `SANDBOX_DEMO` (sandbox-only PSP that refuses to run in
  production) — and a 41-check suite (`backend/tests/integrations.test.js`,
  registered in `run-all.js`). No existing payment behaviour changed; webhooks
  are logged, not yet wired into orders. See
  [`docs/UNIVERSAL_INTEGRATIONS.md`](docs/UNIVERSAL_INTEGRATIONS.md).

### Changed
- `PUT /api/settings/:section` now merges the submitted body over the
  previously stored value (defaults → stored → body) so partial updates no
  longer reset sibling fields to their defaults. Full-form saves from the
  admin UI behave identically.
- `Order` gained `shippingCountry` / `shippingPostalCode` and `OrderItem` gained
  `localQuantity` so an order records how much of each line came from N&D-owned
  stock; `Product` gained `fulfillmentType` / `supplierStock` /
  `supplierStockAt`. All additive with safe defaults — existing products keep
  `LOCAL` fulfilment and zero supplier stock.
- Checkout and admin order creation now validate against *available* stock and
  deduct only the owned portion; cancelling an order returns exactly the units
  that were owned.
- `GET /api/public/products` reports `availableStock` and `shipsFromSupplier`,
  so dropshipped products are purchasable without inflating owned stock.
- Supplier write endpoints get their own rate-limit budget
  (`RATE_LIMIT_SUPPLIER_WRITE_MAX`, default 400/min) because imports and bulk
  publish are legitimately bursty; all three limiters are now env-configurable.

### Fixed
- `prisma/migrate.js` could not apply `ALTER TABLE … ALTER COLUMN … DROP NOT
  NULL` on the local SQLite database, which broke `npm run migrate` on a fresh
  checkout. It now performs the equivalent table rebuild.
- `lib/schema-provider.js` looked for `@prisma/client` only under
  `backend/node_modules`, so `prisma generate` silently failed when dependencies
  were hoisted to the repository root.

### Added (previously)
- **Storefront checkout & payment gateways** — the checkout page now submits
  real orders to the backend (`POST /api/payments/checkout`) with server-side
  pricing, stock reservation and payment handling for **Cash on Delivery**,
  **Bank Transfer**, **Stripe**, **PayPal**, **WiPay** and **Tilopay**.
- **Gateway layer** (`backend/src/lib/payments`) with hosted-checkout
  integrations for Stripe (Checkout Sessions), PayPal (Orders v2), WiPay and
  Tilopay, plus HMAC / Stripe-style webhook signature verification and
  idempotent capture (`POST /api/payments/webhook/:gateway`).
- **Payment tracking on orders** — `paymentMethod`, `paymentStatus`,
  `paymentReference`, `paidAt` and shipping fields with migration
  `20260802000000_order_payments`; admin Orders page shows payment method,
  status and gateway reference, with **Capture payment** and **Refund**
  (ADMIN) actions.
- **Test / sandbox mode** for unconfigured gateways during development
  (clearly labelled; production rejects them with an actionable error).
- Automated **payment gateway verification suite**
  (`backend/tests/payments.test.js`, `npm run test:payments`) — 30 checks
  covering every method, webhook signatures, idempotency, stock deduction and
  admin capture/refund. Total automated checks now 262.
- `npm run build` now verifies the app boots and every admin page bundles
  cleanly (`backend/scripts/verify-build.js`).
- Documentation: payment environment variables in `.env.example`,
  `backend/.env.example` and DEPLOYMENT.md § Payments.

### Fixed
- `multer` upgraded 1.x → 2.x, `nodemailer` → 9.x, `sharp` → 0.35.x —
  `npm audit` now reports **0 vulnerabilities**.
- Product catalogue no longer interpolates API data into inline
  `onclick` handlers unescaped (XSS hardening) — names/images are escaped in
  `products/index.html` and the cart/checkout renderers.
- Local SQLite migration runner tolerates the shared PostgreSQL baseline
  (`CREATE SCHEMA`, `ALTER TABLE ADD CONSTRAINT`) and is idempotent for
  `CREATE` statements, so `npm run setup` works on a fresh clone.
- Removed dead code: unused legacy `assets/js/checkout.js`, `cart.js`,
  `product-catalog.js` and `testimonials.js`.
- Order status `PAID` now also records `paymentStatus`/`paidAt`; webhook and
  manual captures are idempotent against refunded/failed orders.

## [Website Content Manager release]

### Added
- **Website Content Manager** (`/admin/#/content`) with modules for Homepage,
  About, Services, Products Homepage, Gallery, Testimonials, FAQ, Contact,
  Business Hours, Emergency Banner, Promotions, Footer, SEO, Social Media,
  Logo and Banner/Image Manager.
- Publish / Draft workflow with auto-save, rich text editing, image upload and
  live preview for every editable page and collection.
- **Media Library** (`/admin/#/media`) with upload, search, folder organisation,
  replace, delete and image optimisation.
- Content Manager REST API (`/api/content`, `/api/site-content`, `/api/media`)
  plus public read endpoints (`/api/public/content`, `/site-content`, `/media`,
  `/sitemap`) — JWT protected, role-protected, validated and rate-limited.
- Prisma models `ContentPage`, `ServiceItem`, `Testimonial`, `GalleryItem`,
  `FaqItem`, `PromotionItem`, `TeamMember` and `MediaAsset`, with migration and
  seeded sample content.
- Public website now loads dynamic content from the database via
  `assets/js/site-content.js` (hard-coded markup retained as fallback).
- Documentation: `WEBSITE_CONTENT_MANAGER.md`, `CONTENT_API.md`, `DEPLOYMENT.md`.
- Automated Website Content Manager verification suite added to `npm test`.

### Fixed
- Admin API client now resolves the API to the same origin, so local and
  same-origin deployments work out of the box.
- Test harness injects the bundled admin SPA via a DOM script element, avoiding
  a jsdom inline-script parsing quirk with large HTML-template bundles.

### Changed
- Nothing yet

### Fixed
- Nothing yet

### Removed
- Nothing yet
## Admin Dashboard release

### Added
- Express + Prisma backend (`backend/`) with 60+ REST endpoints.
- Admin dashboard at `/admin/` with 15 pages, dark/light themes and full
  responsive layout.
- Authentication with bcrypt hashing, JWT access tokens, rotating refresh
  tokens and Admin/Staff role-based access control.
- Product, booking, customer, message, inventory, order, analytics, settings,
  team and audit-log management.
- Public API powering the storefront catalogue and the contact, booking and
  quote forms.
- Automated verification suites (`npm test`) covering the API, admin UI and
  public website.

### Changed
- Website contact, booking and quote forms now submit to the backend instead of
  a third-party form endpoint, landing directly in the admin dashboard.
- Replaced the placeholder `admin/dashboard.html` with the full application.
