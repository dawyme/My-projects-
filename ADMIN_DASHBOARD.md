# Admin Dashboard

The admin dashboard lives at `/admin/` and is served by the backend in
`backend/`. See [`backend/README.md`](backend/README.md) for setup.

```bash
cd backend && npm install && cp .env.example .env && npm run setup && npm start
# → http://localhost:3001/admin/
```

## Features

| Area | Capabilities |
| --- | --- |
| Authentication | Login/logout, JWT access + rotating refresh tokens, `/me`, password change, session revocation, Admin/Staff roles |
| Dashboard | Products, bookings, customers, messages, low stock, revenue, pending jobs, stock value widgets; revenue trend, status donut, activity feed, upcoming jobs |
| Products | Full CRUD across all 10 categories, image upload, SKU, price, quantity, featured flag, search, filters, sorting, pagination, bulk delete, bulk edit, CSV export |
| Bookings | List/create/edit, technician assignment, five-state status flow, monthly calendar, notes, customer history, email notifications, CSV export |
| Customers | Profiles, contact details, booking history, purchase history, lifetime value, search, CSV export |
| Messages | Inbox with read/unread/archived, reply by email, bulk actions, search, filters |
| Inventory | Stock levels, low stock alerts, adjustments, restock history, valuation report (JSON + CSV) |
| Analytics | Monthly bookings, sales, product performance, customer growth, revenue trends, technician performance |
| Settings | Company info, logo upload, business hours, social links, email, payments, SEO |
| Security | CSRF, validation, rate limiting, secure cookies, XSS/SQLi protection, audit log |

## Product categories

Air Conditioners · Refrigeration Parts · Refrigerants · Automotive AC Parts ·
Compressors · Capacitors · Fan Motors · Filters · Copper Tubing · Thermostats

## Verification

```bash
cd backend && npm test
```

Runs 182 automated checks across the API, the admin UI (headless DOM) and the
public website forms.
