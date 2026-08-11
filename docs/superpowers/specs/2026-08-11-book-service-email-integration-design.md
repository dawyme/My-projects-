# Book Service Email Integration Design

## Goal
Connect the existing public Book Service form to the N&D’S backend booking workflow so every valid service request is stored once, triggers a business notification to `ndsairconditioning@gmail.com`, and sends a customer confirmation, while preserving the existing page and route.

## Architecture
The existing `booking.html` page remains the public UI and route. Its FormBold submission is replaced with a same-page JavaScript submission to the existing `/api/bookings` endpoint. The backend remains the single source of truth: it validates and persists the booking, then uses the existing mailer rather than introducing another email provider or booking system.

## Data Flow
1. Customer completes the existing Book Service form.
2. Client validates required fields and submits JSON to the existing booking API.
3. Backend resolves/creates the customer and creates the booking using the existing Prisma model.
4. Backend sends the existing booking notification through the mailer to `ndsairconditioning@gmail.com`.
5. Backend sends the customer confirmation to the submitted customer email when present.
6. Successful bookings remain available to the existing admin Dispatch/Calendar views.
7. Client shows the existing success state only after the API confirms creation; failures remain visible and do not falsely report success.

## Scope and Constraints
- Preserve `booking.html` and its current route.
- Preserve the existing form fields and branding unless a minimal submission-state message is required.
- Do not retain FormBold as a parallel submission path.
- Reuse the existing `/api/bookings` endpoint, Prisma booking/customer models, and mailer.
- Do not create a duplicate booking table, route, or email provider integration.
- Business notification recipient: `ndsairconditioning@gmail.com`.
- Keep secrets server-side; no Resend/API credentials in browser code.
- Do not modify `main` directly; work only on `feature/milestone-5-calendar-integration`.

## Error Handling
- Client-side validation prevents incomplete submissions.
- API validation errors are rendered to the customer without creating a fake success state.
- Network/server failures show a retryable error.
- Email delivery failures must not delete a successfully persisted booking; the backend should continue to report the booking creation result while logging the delivery failure according to the existing mailer behavior.
- The implementation must not create duplicate bookings when the customer double-clicks or retries after a successful response.

## Testing
- Add/extend backend tests for the public booking payload expected by the form and email notification behavior.
- Add a frontend submission test or deterministic browser-level test covering success and failure states if the repository's existing test setup supports it.
- Verify an actual booking reaches the backend, is persisted, triggers the business notification, and produces the customer confirmation in a non-production/test environment before production deployment.
- Verify the booking appears in the existing Dispatch/Calendar flow.

## Acceptance Criteria
- A customer can use the existing Book Service page without being redirected to FormBold.
- A successful request creates exactly one backend booking.
- `ndsairconditioning@gmail.com` receives the business booking notification.
- The customer receives the confirmation when an email address is supplied.
- The booking is visible to the existing admin/dispatch/calendar workflow.
- Failed submissions do not display a false success message.
- `main` remains unchanged until the feature branch has passed verification and review.
