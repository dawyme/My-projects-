# CoolAir HVAC — Admin Backend & Dashboard

Production backend and admin dashboard for the HVAC, Refrigeration and Automotive AC website.

## Quick start

```bash
cd backend
npm install
cp .env.example .env      # set JWT_SECRET and JWT_REFRESH_SECRET
npm run setup             # apply migrations + seed demo data
npm start                 # http://localhost:3001
```

| URL | Description |
| --- | --- |
| `http://localhost:3001/` | Public website |
| `http://localhost:3001/admin/` | Admin dashboard |
| `http://localhost:3001/health` | Health probe |

Seeded logins:

| Role | Email | Password |
| --- | --- | --- |
| Administrator | `admin@coolairhvac.com` | `Admin@12345` |
| Staff | `staff@coolairhvac.com` | `Staff@12345` |

> Change both seeded passwords before deploying.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm start` | Run the server |
| `npm run migrate` | Apply pending SQL migrations |
| `npm run seed` | Reset and seed demo data |
| `npm run setup` | Migrate + seed |
| `npm test` | Run all three verification suites |
| `npm run test:api` | API endpoint suite |
| `npm run test:ui` | Admin dashboard UI suite |
| `npm run test:site` | Public website suite |

## Configuration

All settings live in `backend/.env` (see `.env.example`):

- `DATABASE_URL` — SQLite by default. For PostgreSQL or MySQL change the
  `datasource` provider in `prisma/schema.prisma` and supply a connection URL.
- `JWT_SECRET` / `JWT_REFRESH_SECRET` — **required**, use long random values.
- `COOKIE_SECURE=true` behind HTTPS.
- `CORS_ORIGINS` — comma-separated allow-list when the site is hosted separately.
- `SMTP_*` — when unset, outgoing email is written to `backend/data/outbox.log`.

If the website is served from a different origin than the API, add
`<meta name="api-base" content="https://api.example.com">` to the page head.

## Architecture

```
backend/
  prisma/          schema, SQL migrations, migration runner, seed
  src/
    lib/           prisma client, tokens, cookies, mailer, cache, audit, helpers
    middleware/    auth, RBAC, CSRF, rate limiting, validation, uploads, errors
    routes/        auth, dashboard, products, categories, customers, bookings,
                   services, messages, inventory, orders, analytics, settings,
                   users, audit logs, public
  tests/           api / ui / site verification suites
admin/
  index.html       dashboard shell (hash-routed SPA)
  login.html       sign-in page
  css/admin.css    design system (light + dark)
  js/              api client, ui toolkit, layout/router, 15 page modules
```

## Security

JWT access tokens (15 min) with rotating refresh tokens stored hashed and
revocable; bcrypt password hashing (cost 12); role-based access control;
double-submit CSRF protection; per-route rate limiting; zod validation on every
input; output escaping throughout the dashboard; parameterised queries via
Prisma; audit logging of every mutating action.
