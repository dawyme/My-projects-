# N&D’S Milestone 6 — Service Job Management Design

## Goal
Turn an existing service booking into a complete operational service job without rebuilding the current N&D’S application architecture.

## Scope
Milestone 6 covers the service-job lifecycle from manual conversion of a booking through technician work and completion/service history.

### Workflow
`Booking → Convert to Job → Pending → Scheduled → In Progress → Completed`

`Cancelled` is an available terminal status when the job is cancelled before completion.

## Core Rules
- A booking may produce one service job.
- Booking remains the customer-request record after conversion; it is never deleted by conversion.
- Job inherits customer, service address, service type, and relevant booking details.
- Job assignment remains editable by authorized staff.
- Status transitions are validated rather than accepting arbitrary values.
- Important job actions are auditable.
- Technician notes, work performed, completion notes, and parts/material usage belong to the job.
- Completing a job creates or updates the customer’s service-history record.
- Existing Calendar functionality remains the scheduling surface; Milestone 6 does not replace it.

## Job Record
A service job should expose, using existing project conventions:
- Job number / identifier
- Linked booking
- Customer
- Service address
- Service type
- Scheduled date/time
- Assigned technician
- Status
- Customer problem/request
- Technician notes
- Work performed
- Parts/materials used
- Completion notes
- Created/completed timestamps
- Service-history linkage

## User Experience
Use the existing admin dashboard rather than creating a separate application.

Primary flow:
`Bookings → Convert to Job → Jobs → Job Details`

The Job Details view is the operational workspace for authorized staff. It should expose the current status, assignment, customer/service context, work notes, parts used, and completion action without disrupting existing booking/calendar workflows.

## Architecture
- Follow existing Express route, Prisma, authentication/authorization, audit, and admin-page patterns.
- Prefer existing models and utilities where they already represent the required concept.
- Avoid database/schema changes unless repository inspection proves a required job concept cannot be represented safely with the existing schema.
- Do not introduce WebSockets or real-time infrastructure.
- Keep tenant/business scoping compatible with the long-term multi-tenant direction.
- Keep the existing public website and checkout/payment behavior unchanged except where a shared job API contract requires a regression-safe adjustment.

## API Direction
The implementation should provide the minimum authenticated job operations required by the workflow, following existing API conventions. Expected capabilities are:
- List/search service jobs with useful operational filters.
- Retrieve a job with linked booking/customer/assignment/history information.
- Convert an eligible booking into a job.
- Assign or change the technician.
- Change job status with transition validation.
- Add/update job notes and work-performed information.
- Record parts/materials used using existing inventory conventions where applicable.
- Complete a job and persist service-history linkage.

Exact route names and payload shapes must follow the repository’s established naming conventions after code inspection; they should not be invented independently of existing patterns.

## Authorization
- Public users do not receive job-management access.
- Existing authentication and role checks remain the source of truth.
- Administrative actions use the project’s established admin/staff authorization rules.
- Audit important state-changing operations.

## Error Handling
- Reject conversion when the booking is invalid, missing, cancelled/ineligible, or already linked to a job.
- Reject invalid status transitions with a clear validation response.
- Preserve booking data if a job operation fails.
- Avoid partial writes for operations that must update multiple related records; use the existing transaction pattern where appropriate.
- Inventory errors must not silently create an inconsistent parts-used record.

## Testing / Acceptance Criteria
Milestone 6 is complete only when automated verification covers:
1. Eligible booking can be converted to exactly one job.
2. Duplicate conversion is rejected safely.
3. Job retains its booking/customer/service context.
4. Technician assignment works and is authorized.
5. Valid status progression works; invalid transitions are rejected.
6. Notes/work performed persist and are returned from job details.
7. Parts/material usage follows existing inventory rules and does not corrupt stock.
8. Completion records the completed state and service-history linkage.
9. Important job changes are auditable.
10. Admin UI exposes the complete workflow without placeholder/undefined output.
11. Existing calendar, booking, inventory, authentication, payment, content-manager, and public-site tests remain green.
12. GitHub Actions and Vercel verification pass before merge.

## Explicit Non-Goals
- No application rebuild.
- No replacement of the existing calendar.
- No WebSocket/real-time dispatch system.
- No estimates/invoices implementation in Milestone 6.
- No customer or technician portal in Milestone 6.
- No unrelated refactoring.
