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

## Troubleshooting

- **`@prisma/client did not initialize`** — regenerate the client (see step 1).
- **`Unknown argument publishedAt`** — the generated client is stale; regenerate and re-migrate.
- **Admin UI login fails with "fetch failed"** — ensure `API_BASE` resolves same-origin (it defaults to `location.origin`); for a `file://` preview it points to `http://localhost:3001`.
