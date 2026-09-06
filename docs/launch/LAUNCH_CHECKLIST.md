# N&D's Air Conditioning — Launch Checklist

**Production:** ndsairconditioning.com
**Deployed SHA:** `622e9365e892216497ed1ac32c70c34b06ef0c8a` (matches `main`)

## Pre-flight (all verified during this pass)
- [x] `main` SHA matches production deployment SHA
- [x] Latest production deployment status = READY / PROMOTED
- [x] `ndsairconditioning.com`, `www.ndsairconditioning.com`, and the Vercel default domain all return HTTP 200
- [x] Verification test data removed from Orders, Bookings, Contact
- [x] Required secrets present in Production environment (see Settings Verification below)

## Orders
- [ ] Place one real or staff test order end-to-end (browse → cart → checkout)
- [ ] Confirm order appears in admin dashboard with correct status
- [ ] Confirm `OrderItem` rows are created correctly (quantity, pricing)

## Bookings
- [ ] Submit one staff test booking through the live booking form
- [ ] Confirm booking appears in admin dashboard
- [ ] Confirm technician/scheduling fields behave as expected

## Contact Submissions
- [ ] Submit one staff test contact message
- [ ] Confirm it lands in admin inbox with status UNREAD
- [ ] Confirm customer confirmation email is received (Resend)

## Payments
- [ ] Confirm Stripe keys are live-mode (not test-mode) if launching with real payments, or intentionally left in test mode if not yet accepting live payments — verify this matches business intent
- [ ] Confirm PayPal environment (`PAYPAL_ENV`) matches intended mode (sandbox vs live)
- [ ] Confirm Tilopay credentials point to production endpoint
- [ ] Run one $0.01–$1 live transaction per enabled gateway if going live with real payments today

## Emails (Resend)
- [ ] Confirm DMARC/SPF/DKIM still pass for `ndsairconditioning.com` (previously fixed)
- [ ] Send a test email through each transactional flow (order confirmation, booking confirmation, contact confirmation)

## Supabase
- [ ] Confirm project status is ACTIVE_HEALTHY
- [ ] Run `get_advisors` (security) one final time — confirm no new high-severity findings
- [ ] Confirm RLS remains enabled on all public tables (previously verified across all 43 tables)

## Vercel
- [ ] Confirm production deployment is the one aliased to all three domains
- [ ] Confirm environment variables are scoped correctly to Production (not just Preview)
- [ ] Confirm no failed/queued deployments are blocking the pipeline

## Authentication
- [ ] Log in as an admin user on production and confirm session persists
- [ ] Confirm `JWT_SECRET` / `JWT_REFRESH_SECRET` are production-only values (not shared with preview/dev)
- [ ] Confirm password reset / auth error paths return sane messages (no stack traces)

## Error Monitoring
- [ ] Confirm a way to observe production errors post-launch (Vercel function logs, Supabase logs, or third-party tool)
- [ ] Confirm someone (you) is watching logs for the first hours after go-live

## Settings Verification (presence only — confirmed present in Production)
| Variable | Status |
|---|---|
| JWT_SECRET | ✅ Present |
| JWT_REFRESH_SECRET | ✅ Present |
| DATABASE_URL | ✅ Present |
| DIRECT_URL | ✅ Present |
| RESEND_API_KEY | ✅ Present |
| STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / VITE_STRIPE_PUBLISHABLE_KEY | ✅ Present |
| PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / PAYPAL_ENV | ✅ Present |
| TILOPAY_API_KEY / TILOPAY_API_PASSWORD / TILOPAY_API_USER / TILOPAY_BASE_URL | ✅ Present |
