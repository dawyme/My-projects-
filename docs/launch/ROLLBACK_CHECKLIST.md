# N&D's Air Conditioning — Rollback Checklist

Use this if a launch-blocking issue appears in production. This does not modify application code — it reverts to the last known-good state.

## Decide: Do you actually need to roll back?
Roll back if: checkout is broken, bookings/contact forms are failing to save, authentication is broken, or the site is down/erroring for most visitors.
Do NOT roll back for: a single failed test submission, a cosmetic issue, or a non-blocking error affecting a small subset of users — fix forward instead.

## 1. Application Rollback (Vercel)
- [ ] Open the Vercel dashboard → Deployments for `my-projects`
- [ ] Identify the last known-good production deployment (the one before the current one — currently `dpl_D14dsUrbZaFh9BRn2wkHmuM1wubB`, commit `7f100ef4...`, if the current deploy is the one that needs reverting)
- [ ] Promote that deployment to Production ("Instant Rollback" in Vercel, or re-alias manually)
- [ ] Confirm all three domains (`ndsairconditioning.com`, `www.ndsairconditioning.com`, Vercel default) now serve the rolled-back deployment
- [ ] Re-run the domain HTTP check (expect 200s) after rollback

## 2. Database Rollback (Supabase) — only if a migration caused the issue
- [ ] Confirm whether the issue is code-only or requires a schema/data revert
- [ ] If schema: identify the migration that needs reverting via `list_migrations`
- [ ] Do NOT run destructive DDL against production without a fresh backup taken first
- [ ] If data corruption occurred, restore from the most recent verified backup
- [ ] Never attempt an untested rollback migration directly against production — validate on a branch first if time allows

## 3. Orders / Bookings / Contact — data integrity check after rollback
- [ ] Check for any orders/bookings/contact messages created *during* the broken window
- [ ] Determine if those records are valid (real customer data) or need manual reconciliation
- [ ] Do not delete real customer data without confirming with the business owner first

## 4. Payments — reconciliation after rollback
- [ ] Check Stripe/PayPal/Tilopay dashboards for any transactions during the broken window
- [ ] Cross-reference against Order records — flag any payment captured without a matching order
- [ ] Do not issue refunds automatically — flag for manual review

## 5. Communication
- [ ] If customer-facing downtime occurred, note the start/end time for your own records
- [ ] Decide whether any affected customers need a follow-up email/call

## 6. Post-Rollback Verification
- [ ] Re-run the full Launch Checklist before attempting to re-launch
- [ ] Confirm root cause is understood before redeploying the reverted change
