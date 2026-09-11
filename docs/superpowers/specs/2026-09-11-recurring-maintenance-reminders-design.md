# Recurring AC Maintenance and Customer Reminders Design

**Status:** Approved design; implementation pending written-spec review.

## Goal

Make recurring preventive AC maintenance a core N&D’S capability from initial deployment. After a maintenance job is completed, a tenant can schedule the next maintenance—for example every three months—and N&D’S will generate future appointments and reminders while preserving the customer, equipment, service, and technician context.

## Product rules

1. Basic recurring maintenance is free/core functionality and must not depend on the tenant’s SaaS plan.
2. Basic appointment reminders are free/core functionality. Paid plans may later add higher-cost delivery channels or quotas, but plan gating must never remove the underlying recurring schedule.
3. Historical completed maintenance must never be rewritten when a recurring series is edited, paused, resumed, or cancelled.
4. Every recurring series, occurrence, reminder, customer, equipment record, booking, and work order must remain tenant-scoped.
5. A recurrence series can continue until cancelled or paused, or use a configured end condition.

## Recurrence model

A recurring maintenance series represents the reusable schedule definition. It stores the tenant, customer, optional equipment, service, optional technician, recurrence interval/unit, start date, end date or occurrence limit when configured, lifecycle status, and reminder policy. Generated occurrences are normal tenant bookings linked back to the series and occurrence number. When an occurrence is completed through the existing work-order flow, the next occurrence can be generated without altering prior history.

The first supported maintenance interval set is monthly recurrence with 1, 2, 3, 6, and 12 months plus a custom positive month interval. The scheduling engine must handle month-end dates deterministically: if the target month has fewer days than the source date, use the last valid day of that month. A recurrence must never generate duplicate occurrences for the same series/occurrence number.

## Workflow

1. Technician/admin completes the AC maintenance work order.
2. Completion records service history through the existing flow.
3. The completion UI offers “Schedule next maintenance” and can create a recurring series.
4. The user chooses the interval, first next date, technician, and reminder offsets.
5. N&D’S creates the series and its next booking/occurrence.
6. The calendar and dispatch board display the occurrence as a normal appointment.
7. Reminder processing finds due reminders and sends them through the existing email infrastructure with idempotency/audit protection.
8. When the occurrence is completed, the series advances to the next occurrence according to its recurrence rule.
9. Pausing or cancelling the series stops future generation but does not modify completed occurrences or historical service records.

## Reminder model

Reminder policies support configurable offsets before the appointment. The default basic policy is 30 days, 7 days, 1 day, and same-day. A reminder delivery record is unique for an occurrence/offset/channel so repeated scheduler runs cannot send duplicates. Delivery status and error information are auditable. Existing manual reminder delivery and the current 12–36 hour cron endpoint remain compatible.

## API boundaries

Add tenant-scoped endpoints for creating, listing, reading, updating, pausing/resuming, and cancelling recurring maintenance series; generating/advancing an occurrence where necessary; and listing or processing reminder deliveries. Reuse existing booking/work-order authorization and tenant scoping helpers rather than introducing a parallel authentication model.

## UI boundaries

Extend the existing booking/calendar and work-order completion UI rather than creating a separate application. The maintenance completion flow gets a recurring-maintenance option. The calendar shows recurrence context and allows users to open the series. A series management view provides edit, pause/resume, cancel, and next-occurrence visibility. Reminder settings are part of the series configuration.

## Data integrity and safety

- Use database constraints/unique indexes for series occurrence identity and reminder delivery idempotency.
- Validate customer, equipment, service, and technician ownership inside the tenant before creating a series.
- Do not allow a tenant to reference another tenant’s equipment, customer, booking, or series.
- Do not automatically create invoices or charge customers merely because a future occurrence is generated.
- Do not auto-complete future work orders.
- Preserve existing booking/work-order status transitions and service-history semantics.

## Testing requirements

Tests must be written before implementation for recurrence date calculation, month-end behavior, series creation and lifecycle, occurrence generation/idempotency, equipment/customer linkage, tenant isolation, completion-to-next-occurrence behavior, reminder offset scheduling, reminder idempotency, reminder failure handling, and regression of existing booking/calendar/manual reminder contracts. The relevant backend suites and full CI must pass before the PR is considered ready.

## Deployment constraint

The feature will be implemented on a feature branch. A Prisma migration may be committed with the code, but it must not be applied to production as part of development. Production migration requires the existing backup/parity/review process and separate approval.
