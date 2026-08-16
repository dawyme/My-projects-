# HVAC Service Operations Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Customer → Service Request → Work Order → Dispatch → Technician → Parts/Labor → Completion → Invoice → Payment → Service History as the first production slice of the multi-tenant field-service platform.

**Architecture:** Extend the existing Express + Prisma + PostgreSQL backend and admin UI. Reuse existing Customer, Equipment, Technician/User, Booking/dispatch, Estimate, Invoice, JobStatus, inventory, audit, authentication and ServiceHistory concepts. Add only minimum new request/work-order concepts. N&D’S is the first tenant; never hard-code it into domain logic.

**Tech Stack:** Node.js, Express, Prisma 6.x, PostgreSQL/Supabase, existing admin HTML/CSS/JS, existing Jest/Supertest suite.

## Global Constraints
- No rebuild, duplicate systems, WebSockets, or unrelated SEO/payment/website changes.
- Keep `main` untouched; work on `feature/hvac-service-operations-core` and review by PR.
- Preserve existing auth, CSRF, validation, audit, dispatch/calendar, inventory, estimate, invoice and payment conventions.
- Prefer additive migrations. Every task: failing test → minimal implementation → focused/regression verification.

## Existing Baseline
The schema already contains Customer, Service, Booking, Technician, Equipment, ServiceHistory, Estimate, Invoice, JobStatus, inventory and security/audit models. Booking already participates in scheduling/technician work. A Service Request is intake; a Work Order is the accepted operational job.

## Workflow Contract
`Customer → Service Request → Work Order → Dispatch/Schedule → Technician → Parts + Labor → Completion → Estimate/Invoice → Payment → Service History`

Request: `NEW → REVIEWING → ACCEPTED → CONVERTED` or `CANCELLED`.
Work order: `NEW → SCHEDULED → IN_PROGRESS → COMPLETED` or `CANCELLED`.

## Task 1 — API contract tests
**Files:** Create `backend/tests/service-operations-contract.test.js`.
- [ ] Test auth/CSRF, required fields, invalid customer/equipment, creation, filtering and retrieval.
- [ ] Test conversion creates exactly one work order and is idempotent.
- [ ] Test invalid status transitions.
- [ ] Run focused tests and confirm initial failure.

## Task 2 — Persistence
**Files:** Modify `backend/prisma/schema.prisma`; add migration using the repository’s existing pattern; update focused tests.
- [ ] Add `ServiceRequest` with customer, optional equipment/service, service type, address, problem, priority, requested window, status, timestamps and supported tenant/business ownership.
- [ ] Add `WorkOrder` with originating request, customer, optional equipment, technician/dispatch linkage, status, priority, schedule/completion timestamps, notes and timestamps.
- [ ] Add useful indexes; do not create duplicate tenant/customer/equipment/technician models.
- [ ] Generate Prisma client, migrate through existing procedures, rerun tests.

## Task 3 — Service Request API
**Files:** Create `backend/src/routes/service-requests.js`; register narrowly in `backend/src/app.js`; reuse existing middleware/validators.
- [ ] Implement `POST /api/service-requests`, `GET /api/service-requests`, `GET /api/service-requests/:id`, `POST /api/service-requests/:id/convert`.
- [ ] Validate references and enforce authorization/tenant scope.
- [ ] Audit create/status/conversion.
- [ ] Make conversion idempotent.

## Task 4 — Work Order + dispatch handoff
**Files:** Create `backend/src/routes/work-orders.js` and `backend/src/lib/service-operations.js`; modify dispatch integration only where required.
- [ ] Implement `GET /api/work-orders/:id`, assignment and explicit status-transition validation.
- [ ] Reuse existing technician/user and Booking/dispatch/calendar records.
- [ ] Require completion timestamp and technician/job notes for completion.
- [ ] Audit operational changes and run dispatch regressions.

## Task 5 — Parts/labor/completion/invoice handoff
**Files:** Modify the new service layer and existing inventory/estimate/invoice integration points only as needed.
- [ ] Test labor, parts, insufficient stock, completion and invoice handoff.
- [ ] Use existing Product/inventory; make inventory changes atomic.
- [ ] Expose billable labor/parts to existing Estimate/Invoice flow; introduce no new payment gateway.

## Task 6 — Admin UI
**Files:** Extend existing admin architecture with Service Requests queue and Work Order detail; do not replace dispatch/calendar.
- [ ] Request filters/details/convert action.
- [ ] Work-order status, technician, schedule, notes, labor, parts, completion and invoice handoff.
- [ ] Reuse existing admin API client, auth, CSRF and responsive conventions.
- [ ] Add UI tests using existing patterns.

## Task 7 — Verification and PR
**Files:** Create `docs/HVAC_SERVICE_OPERATIONS.md`; update setup docs only if required.
- [ ] Run Prisma validation/generation, focused tests and relevant full backend suite.
- [ ] Verify request → work order → dispatch → technician → parts/labor → completion → invoice → history.
- [ ] Verify auth, tenant scope, duplicate protection, audit logging and rollback.
- [ ] Separate pre-existing failures from regressions.
- [ ] Verify `main` unchanged and create a reviewable PR containing only this phase.

## Definition of Done
A customer request becomes exactly one work order; the work order uses existing dispatch, technicians, inventory, estimate/invoice/payment and service-history systems; security and tenant boundaries are enforced; tests pass; and no unrelated N&D’S behavior changes.
