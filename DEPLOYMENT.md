# Deployment

This document covers setting up the Website Content Manager in development and production (Supabase PostgreSQL + Vercel). The deployment model matches the existing app: an Express API serving the admin dashboard, the public website, and the database layer.

## Prerequisites

- Node.js **18+**
- PostgreSQL (Supabase) for production, or a local SQLite file for offline testing
- An npm install with the bundled Prisma client (`@prisma/client` + `prisma`)

## 1. Install dependencies

```bash
npm install
```

The `postinstall` hook runs `prisma generate`. If the sandbox has no internet access to Prisma's binaries, the project includes offline helpers:

```bash
node backend/scripts/setup-prisma-offline.js
export PRISMA_SCHEMA_ENGINE_BINARY="$(pwd)/node_modules/.bin/schema-engine-wrapper"
export PRISMA_QUERY_ENGINE_LIBRARY="$(pwd)/node_modules/@prisma/client/runtime/library.js"
npx prisma generate --schema=backend/prisma/schema.prisma
```

## 2. Configure environment

Copy `.env.example` to `.env` (root) and set:

```env
DATABASE_URL="postgresql://...:6543/postgres?pgbouncer=true"   # Supabase pooler
DIRECT_URL="postgresql://...:5432/postgres"                    # direct connection
JWT_SECRET="at-least-32-chars"
JWT_REFRESH_SECRET="at-least-32-chars"
PORT=3001
```

For local testing use a SQLite file URL instead:

```env
DATABASE_URL="file:./backend/data/app.db"
```

## 3. Migrate & seed

The Content Manager adds the following tables: `ContentPage`, `ServiceItem`, `Testimonial`, `GalleryItem`, `FaqItem`, `PromotionItem`, `TeamMember`, `MediaAsset`.

```bash
# Supabase / production (syncs schema from schema.prisma)
npm run migrate

# Local SQLite (applies SQL migrations + seeds sample content)
npm run setup          # migrate + seed
# or individually:
npm run migrate && npm run seed
```

Seeding creates an admin user (`admin@coolairhvac.com` / `Admin@12345`), the default staff user, and **sample published content** for every Content Manager module so the site and dashboard are populated out of the box.

## 4. Run the app

```bash
npm start          # http://localhost:3001
npm run dev        # same (dev convenience alias)
```

- Admin dashboard: `http://localhost:3001/admin/`
- Public website: `http://localhost:3001/`
- Health check: `http://localhost:3001/health`

## 5. Tests

```bash
npm test           # runs API, Website Content Manager, Admin UI and Public site suites
```

Each suite can be run alone: `npm run test:api`, `npm run test:site`, `node backend/tests/content.test.js`, `node backend/tests/ui.test.js`.

## 6. Production build

```bash
npm run build      # verifies the build completes
```

The project is deployed as a single Express app on Vercel (see `vercel.json`), which serves the API, admin dashboard, and static website together. The generated admin frontend uses native ES modules (no separate bundling step required).

## 7. Publishing content

- Edit any module and click **Save draft** to keep an in-progress version.
- Click **Publish** to push it live immediately (ADMIN only).
- Auto-save stores drafts as you type; drafts never affect the live site.
- The public website fetches only **published** content via `/api/public/content`.

## 8. Backups & data safety

Migrations are additive (`CREATE TABLE`); existing admin data (products, orders, bookings, customers, users, settings) is preserved. Seeding only runs when invoked manually (`npm run seed`) and resets the demo dataset.

## 8. Payments

The storefront supports six payment methods: **Cash on Delivery**, **Bank Transfer**,
**Stripe**, **PayPal**, **WiPay** and **Tilopay**. Methods are switched on/off in
Admin → Settings → Payments. Gateway credentials always live in the environment
(`.env`), never in the database or the repository.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_live_…` / `sk_test_…`) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret (`whsec_…`) |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | PayPal REST app credentials |
| `PAYPAL_ENV` | `live` or `sandbox` |
| `PAYPAL_WEBHOOK_ID`, `PAYPAL_WEBHOOK_SECRET` | PayPal webhook verification |
| `WIPAY_API_TOKEN`, `WIPAY_MERCHANT_ID` | WiPay developer token + merchant id |
| `WIPAY_BASE_URL` | WiPay checkout endpoint (region-specific) |
| `WIPAY_WEBHOOK_SECRET` | Optional HMAC secret for WiPay webhook verification |
| `TILOPAY_API_KEY`, `TILOPAY_API_USER`, `TILOPAY_API_PASSWORD` | Tilopay integration credentials |
| `TILOPAY_BASE_URL` | Tilopay checkout endpoint (region-specific) |
| `TILOPAY_WEBHOOK_SECRET` | Optional HMAC secret for Tilopay webhook verification |
| `PAYMENT_SANDBOX_SECRET` | Shared secret for sandbox webhook tests (**development only**) |

### How a checkout works

1. The storefront `POST /api/payments/checkout` with customer details, cart
   items and the chosen `paymentMethod`. Prices are always taken from the
   database — client-supplied prices are ignored.
2. The order is created (`PENDING`), stock is reserved, and the payment method
   is started:
   - **COD / Bank Transfer** — no gateway; instructions are returned and the
     order stays `PENDING` until an admin captures the payment.
   - **Stripe / PayPal / WiPay / Tilopay** — a hosted payment page is created
     and the customer is redirected (`payment.url`).
3. The gateway redirects back to `checkout.html?order=<ref>&status=…`.

### Webhooks

Each gateway calls back to `POST /api/payments/webhook/<gateway>` (lowercase),
e.g. `https://yourdomain.com/api/payments/webhook/stripe`. The webhook verifies
the gateway signature, finds the order, and captures the payment (order →
`PAID`, `paymentStatus` → `PAID`, `paidAt` set). Captures are **idempotent**:
replayed webhooks are safe.

- **Stripe**: point the dashboard webhook at `/api/payments/webhook/stripe`
  with the `checkout.session.completed` event.
- **PayPal**: point the webhook at `/api/payments/webhook/paypal` with the
  `PAYMENT.CAPTURE.COMPLETED` event.
- **WiPay / Tilopay**: configure the merchant's callback/webhook URL to
  `/api/payments/webhook/wipay` (or `/tilopay`) and set the HMAC secret if the
  gateway supports signing.

### Test / sandbox mode

When a gateway is enabled in settings but its API keys are **not** configured:

- **Development** (`NODE_ENV != production`): checkout still works in a clearly
  labelled **test mode** — the order is placed and marked `PAID` with a
  `sandbox_…` reference, and webhook tests sign payloads with
  `PAYMENT_SANDBOX_SECRET`.
- **Production**: checkout is rejected with an actionable error telling the
  merchant to configure the keys or disable the method.

### Manual capture & refunds

In Admin → Orders → view an order you can **Capture payment** (COD, bank
transfers, or any offline payment — optionally recording the gateway
transaction reference) and **Refund** (ADMIN only). Marking an order `PAID`
from the status dropdown also records the payment.

## Troubleshooting

- **`@prisma/client did not initialize`** — regenerate the client (see step 1).
- **`Unknown argument publishedAt`** — the generated client is stale; regenerate and re-migrate.
- **Admin UI login fails with "fetch failed"** — ensure `API_BASE` resolves same-origin (it defaults to `location.origin`); for a `file://` preview it points to `http://localhost:3001`.
