# Dispatch Board and Customer Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the existing N&D’S dispatch workflow so admins can assign technicians, schedule/reschedule jobs, update status, and send reliable customer reminders without rebuilding the system.

**Architecture:** Reuse the existing Booking, Technician, Calendar, JobStatus, AuditLog, and Resend infrastructure. The Dispatch Board operates on real Booking records; reminders use AuditLog for idempotency and a daily Vercel cron compatible with the current Hobby deployment.

**Tech Stack:** Vanilla admin JavaScript, Express, Prisma/PostgreSQL, Resend, Vercel Cron.

**Spec:** Existing Dispatch Board checkpoint requirements from the current management-system workflow.

## Global Constraints

- Preserve the existing Booking and Contact routes and working flows.
- Do not change authentication/password behavior.
- Do not add mock or placeholder implementations.
- Reuse existing data models and routes where possible; no duplicate booking system.
- Never commit secrets; `RESEND_API_KEY` and `CRON_SECRET` remain environment variables.
- Vercel Hobby cron must run no more than once daily.

---

### Task 1: Regression tests first

**Files:**
- Create: `backend/tests/dispatch-reminders-contract.test.js`
- Modify: `backend/tests/run-all.js`

- [ ] Add failing contract coverage for technician assignment/rescheduling and reminder delivery/idempotency.
- [ ] Run the focused suite and confirm it fails against the current implementation.

### Task 2: Reminder service

**Files:**
- Modify: `backend/src/lib/mailer.js`
- Create: `backend/src/routes/reminders.js`

- [ ] Add a real customer appointment-reminder email using the existing Resend sender.
- [ ] Add an admin manual-reminder endpoint.
- [ ] Add a cron endpoint protected by `CRON_SECRET`.
- [ ] Use AuditLog to ensure a reminder for the same booking/scheduled date is sent only once automatically.
- [ ] Run the focused contract test and make it pass.

### Task 3: Dispatch Board workflow

**Files:**
- Modify: `admin/js/pages/dispatch.js`

- [ ] Show real bookings with technician, scheduled time, status and priority.
- [ ] Provide one dispatch editor for technician assignment, date/time rescheduling, status and priority.
- [ ] Provide an explicit customer reminder action.
- [ ] Preserve the existing admin shell and routes.

### Task 4: Scheduled production reminders

**Files:**
- Modify: `backend/src/app.js`
- Modify: `vercel.json`

- [ ] Mount the reminder route.
- [ ] Configure one daily Vercel cron invocation for the reminder runner.
- [ ] Verify the deployment configuration does not introduce an hourly/more-frequent Hobby cron.

### Task 5: Verification and release

- [ ] Run the focused contract suite.
- [ ] Run the complete existing test suite.
- [ ] Review the diff for Booking/Contact regressions.
- [ ] Open a PR from an isolated feature branch.
- [ ] Merge only after checks pass.
- [ ] Verify Vercel production deployment is READY.
- [ ] Verify the live Dispatch Board route and reminder controls.
