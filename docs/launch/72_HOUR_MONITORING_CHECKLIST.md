# N&D's Air Conditioning — First 72-Hour Monitoring Checklist

## Cadence
- **Hours 0–4:** Check every 30–60 minutes
- **Hours 4–24:** Check every 2–3 hours
- **Hours 24–72:** Check morning and evening

## Orders
- [ ] New orders are being created without errors
- [ ] `OrderItem` rows match cart contents (no missing/duplicate items)
- [ ] Order status transitions correctly (PENDING → PAID → etc.)

## Bookings
- [ ] New bookings are being created without errors
- [ ] Scheduled dates/times save correctly
- [ ] No duplicate bookings from double-submits

## Contact Submissions
- [ ] Messages are arriving in the admin inbox
- [ ] Customer confirmation emails are sending (check Resend logs for bounces/failures)

## Payments
- [ ] Watch each enabled gateway's dashboard (Stripe/PayPal/Tilopay) for failed or disputed charges
- [ ] Confirm captured payments have a matching Order record (no orphaned charges)
- [ ] Watch for repeated payment failures from the same source (possible integration issue vs. card issue)

## Emails
- [ ] Monitor Resend delivery logs for bounce/spam-complaint rate spikes
- [ ] Spot-check that order/booking/contact confirmation emails are actually being received (not just "sent")

## Supabase Health
- [ ] Project status stays ACTIVE_HEALTHY
- [ ] Watch `query_logs` / Postgres logs for connection errors or slow queries
- [ ] Re-run security advisors after 24h and 72h to catch anything new

## Vercel Health
- [ ] No failed deployments or crash loops
- [ ] Function/runtime logs show no repeated 500s
- [ ] No unexpected spike in cold starts or timeouts

## Authentication
- [ ] Admin and customer logins succeed
- [ ] No unexpected spike in failed login attempts (could indicate brute-force attempts against production for the first time)
- [ ] Session persistence works across page loads

## Error Monitoring
- [ ] Review error logs at each check-in interval above
- [ ] Triage: is each error a one-off, a pattern, or a launch-blocking issue?
- [ ] Escalate to the Rollback Checklist only if a pattern indicates a broken core flow (orders, bookings, contact, auth, payments)

## End of 72 Hours
- [ ] Compile a short list of any non-blocking issues found → feed into Post-Launch Items
- [ ] Confirm no open payment reconciliation issues remain
- [ ] Move from "active monitoring" cadence to normal operations
