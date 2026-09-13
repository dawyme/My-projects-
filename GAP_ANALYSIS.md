# N&D'S Air Conditioning & Refrigeration — Full SaaS Platform Gap Analysis

**Repository:** dawyme/My-projects-
**Production:** https://ndsairconditioning.com/
**Date:** 2026-09-12
**Starting Main SHA:** d871766406727f0fa788de2f860580adc00c7eae
**Branch:** arena/01a095d2-my-projects
**Authoritative Owner Model:** Christopher Alexis — SUPER_ADMIN with businessId = NULL

---

## 1. Executive Summary

The platform is a mature multi-tenant field-service SaaS with solid foundations:
- Prisma PostgreSQL schema, JWT rotating refresh tokens, RBAC, CSRF, tenant isolation via `tenantWhere`
- Feature Management registry synchronized to DB
- Admin SPA at `/admin/` with hash router, dashboard, bookings, calendar, recurring maintenance, dispatch, services, equipment, estimates, invoices, orders, POS, customers, messages, supplier marketplace, content manager, media library
- Tenant, Customer, Technician role dashboards (separate HTML shells)
- Public booking form (basic), checkout with payments (Stripe, PayPal, Tilopay, WiPay, COD, bank transfer)
- Supplier Marketplace extensive (107 checks)
- POS, inventory, work orders, service requests, equipment

**Gaps vs Master Prompt Target (SetTime-level + Field-Service ERP + CRM + Scheduling + POS + Inventory + Payments + Marketplace + SaaS):**

- Calendar is month-only; missing Day/3-Day/Week/Agenda/Staff/Technician views, conflict detection, availability, working hours, break periods, closed days, time-off blocking
- Advanced scheduling missing: multiple technicians/staff per appointment, multiple services per appointment, buffers, lead time, booking window, custom working hours, on-request appointments, appointment templates
- Online booking is a simple static form (`booking.html`) not connected to real-time availability, services, staff, custom fields, deposits, policies, branding, shareable URL, embedding
- Communication system: only email via `mailer.js`; SMS, WhatsApp, Telegram provider abstractions missing; no centralized EVENT → RULE → CHANNEL → RECIPIENT → TEMPLATE → DELIVERY → STATUS engine
- Notification templates & logging missing
- Discounts: only promotions, no discount codes, service-specific, customer-specific, expiration, usage limits
- Reviews: only testimonials, no staff/service ratings, review requests, moderation, analytics, Google integration
- Expenses: completely missing
- Analytics: basic dashboard + analytics route, missing appointment/booking/staff/service/financial deep metrics, conversion, popular times
- Calendar integrations: Google Calendar architecture missing
- Data import/migration: only supplier imports, missing customer/staff/services/categories/appointments CSV import/export, validation, duplicate detection, preview, history
- Equipment: exists but missing photos, documents, parts history, warranty, maintenance schedule linking
- Customer portal: minimal role-dashboard.css shell, only dashboard/services/orders, missing appointments, reschedule/cancel, work orders, service history, equipment, estimates, approvals, invoices, payments, receipts, messages, notifications, profile, preferences
- Technician mobile: minimal shell, only jobs list, missing today's schedule, job details, navigation link, start/arrive/pause/resume, notes, photos, parts/labor, status updates, signature, invoice generation, communication
- Tenant Admin mobile: uses same admin SPA but mobile UX not first-class (needs hamburger, drawer, close behavior, touch targets, tables→cards)
- Platform Owner mobile: same issue, needs mobile access to tenants, plans, features, subscriptions, billing, analytics, health, users, notifications, settings
- Responsive design: admin.css has some responsive breakpoints (1024px, 640px) but many pages still use desktop tables without mobile cards, modals larger than viewport risks, forms not optimized for small screens
- Mobile navigation: admin layout has sidebar with backdrop, but highlightNav logic, submenu positioning, back/forward state, refresh behavior need verification; role dashboards have custom mobile nav but need active state, touch targets, persistence
- Auth: login/logout implemented, but logout must be tested across all roles desktop+mobile; session restoration, expired tokens, unauthorized handling need verification
- Feature Management: registry has 37 keys but missing many from target list (online-booking, appointments, recurring-appointments, booking-confirmations, email-reminders, sms-reminders, whatsapp-reminders, telegram-notifications, notification-center, notification-templates, etc). Also current key `service-bookings` vs target `appointments` — need normalization without duplicates
- Plan & Subscription: exists but payment enforcement server-side needs audit, free plan selection bypass risk
- Security: tenant isolation generally good, but need to verify every new capability has backend protection, not just UI hiding
- Testing: extensive suites (21 suites) but missing UI tests for mobile workflows, security tests for cross-tenant, feature disabled tests, RBAC tests per role

---

## 2. Detailed Capability Matrix

| Capability | Already Exists | Partial | Missing | Existing Files/Routes | Feature Key | Tests | Recommended Action |
|---|---|---|---|---|---|---|---|
| **Platform Owner Model** | ✅ | | | `backend/src/lib/permissions.js` ROLE, `tenant.js` isPlatformAdmin, `superAdminBootstrap.js`, `prisma/schema.prisma` User.businessId nullable | platform-only | `platform-owner-consolidation.test.js`, `bootstrap-super-admin.test.js` | Keep authoritative, verify businessId=NULL not tenant |
| **SUPER_ADMIN RBAC** | ✅ | | | `permissions.js`, `auth.js` middleware, `app.js` platformAdminOnly | platform-only | `rbac.test.js` | Verify unrestricted access, no tenant conversion |
| **TENANT_ADMIN** | ✅ | | | `users.js`, `business.js`, `tenant.js` | dashboard, team, settings etc | `tenant.test.js`, `saas.test.js` | Verify scope via tenantWhere |
| **TECHNICIAN** | ✅ | Partial | | `technician-portal.js` route, `technician/index.html`, `WorkOrder` model, `Booking` technicianId | technicians, work-orders, dispatch | `owner-recurring-tenant-team-contract` | Expand mobile workflow, job status |
| **CUSTOMER** | ✅ | Partial | | `customer-portal.js`, `customer/index.html`, `Customer` model | customers | `role-dashboard-mobile-navigation.test.js` | Expand portal to full spec |
| **Feature Management Listing** | ✅ | | | `routes/features.js` GET /api/saas/features, `admin/js/pages/features.js` | — | `platform-feature-access-contract` | Fix #/features load, verify GET works |
| **Feature Registry Sync** | ✅ | | | `lib/feature-registry.js` TENANT_FEATURE_REGISTRY, `ensurePlatformFeatures()` | — | `admin-dashboard-reliability.test.js` | Verify synchronization |
| **Plan → Feature → Tenant Entitlement** | ✅ | Partial | | `saas.js` plans/businesses, `TenantFeatureAccess`, `Plan.features` JSON | — | `saas.test.js`, `subscription-payment.test.js` | Complete feature key binding, enforce server-side |
| **Backend Route Protection** | ✅ | Partial | | `app.js` featureProtectedRoute, `lib/features.js` requireFeature | all tenant keys | `platform-feature-access-contract` | Ensure every tenant API uses same key as registry+nav |
| **Navigation Binding** | ✅ | Partial | | `admin/js/layout.js` NAV array with feature property | same keys | `ui.test.js` | Ensure nav uses same keys, active route state |
| **Admin Navigation Highlighting** | ✅ | Partial | Broken | `layout.js` highlightNav, `admin.css` nav-group | — | `admin-dashboard-reliability.test.js` | Fix current menu highlighting, submenu positioning, desktop/tablet/mobile, back/forward, refresh |
| **Recurring Appointments Data Flow** | ✅ | Partial | Broken | `RecurringMaintenanceSeries`, `RecurringMaintenanceOccurrence`, `Booking`, `dashboard.js` upcoming includes recurring, `admin/js/pages/dashboard.js` recurring section, `calendar.js` only bookings/calendar | recurring-maintenance | `recurring-maintenance-contract`, `recurring-maintenance.test.js` | Trace DB→API→Query→Auth→Filtering→Dashboard→UI, verify recurring bookings appear in calendar and dashboard |
| **Logout Immediate** | ✅ | Partial | | `admin/js/api.js` auth.logout clears local then POST /auth/logout, `auth.js` route revokes refresh token, increments sessionVersion, clears cookies | — | `auth-plan-regression.test.js`, `public-login.test.js` | Test desktop/mobile/Admin/Tenant/Tech/Customer/SUPER_ADMIN, ensure immediate UI update, redirect to login, prevent authenticated nav, no refresh required |
| **Mobile Role Dashboards** | | ✅ | | `role-dashboard.css`, `technician/index.html`, `customer/index.html`, `tenant/index.html`, `admin/css/admin.css` backdrop | — | `role-dashboard-mobile-navigation.test.js` | Implement hamburger, drawer, close behavior, active state, touch targets, sign-out, persistence, tables→cards, forms usable |
| **Calendar Day View** | | | ❌ | `admin/js/pages/calendar.js` only month grid, `bookings.js` /calendar month | calendar | `calendar.test.js` | Build day view |
| **Calendar 3-Day View** | | | ❌ | — | calendar | — | Build 3-day view |
| **Calendar Week View** | | | ❌ | — | calendar | — | Build week view |
| **Calendar Month View** | ✅ | | | `calendar.js` month grid | calendar | — | Keep, enhance filtering |
| **Agenda/List View** | | | ❌ | — | calendar | — | Build agenda |
| **Staff/Technician Calendar** | | ✅ | | `calendar.js` technicianFilter, `bookings/calendar` technicianId query | calendar, technicians | — | Expand to staff-specific, workload |
| **Appointment Filtering** | | ✅ | | `bookings.js` status, technicianId, customerId, from/to, search | service-bookings | — | Add filter by staff, service, customer, status, search |
| **Appointment CRUD** | ✅ | | | `bookings.js` GET/POST/PUT/DELETE, `bookings.js` admin page | service-bookings | `api.test.js` | Keep, add reschedule/cancel/delete/status/notes/log/history/conflict |
| **Availability Checking** | | ✅ | | `recurring-maintenance.js` assertBookingConflict | recurring-maintenance | — | Build centralized availability service, working hours, breaks, closed days, time-off |
| **Advanced Scheduling: Multiple Technicians** | | | ❌ | Booking only single technicianId | — | — | Implement multiple assignment |
| **Multiple Services per Appointment** | | | ❌ | Booking only single serviceId | — | — | Implement junction table or JSON array with duration aggregation |
| **Service Duration** | ✅ | | | `Service.durationMin` | services | — | Use in conflict detection, calendar rendering |
| **Booking Buffers, Lead Time, Window** | | | ❌ | — | — | — | Implement settings per service/business |
| **Working Hours, Breaks, Closed Days** | | | ❌ | `Setting` key-value but not structured for hours | settings | — | Create structured working hours model |
| **On-Request Appointments** | | | ❌ | — | — | — | Add flag |
| **Recurring Appointments Auto-Generation** | ✅ | Partial | | `recurring-maintenance` auto generates next occurrence via `advanceFromCompletedBooking` | recurring-maintenance | `recurring-maintenance.test.js` | Generalize to appointments beyond maintenance, add pause/resume/skip/reschedule |
| **Appointment Templates** | | | ❌ | — | — | — | Add template model |
| **Online Booking Public Flow** | | ✅ | | `booking.html` static form, `public.js` contact/booking, `orders.js` checkout | — | `site.test.js` | Rebuild as SetTime-equivalent: service/category/tech/date/time/customer details/custom fields/review/pay/deposit/confirm/receive confirmation, desktop/mobile responsive, shareable URL, embedding, policies, branding |
| **Customer Management / CRM** | ✅ | Partial | | `customers.js` route, `admin/js/pages/customers.js`, `Customer` model | customers | `api.test.js` | Add categories, custom fields, notes, appointment/service/equipment/communication/invoice/estimate/payment/review history, portal, notification prefs |
| **Service Management** | ✅ | Partial | | `services.js` route, `Service` model, `admin/js/pages/services.js` | services | — | Add categories, images, availability, staff/tech assignment, service-specific scheduling, multiple per appointment, statistics, auto-finish |
| **Staff Management** | ✅ | Partial | | `users.js`, `technicians.js`, `User` model, `Technician` model | team, technicians | — | Add profiles, photos, contact, schedules, working hours, closed days, specific working days, services, availability, calendars, history, workload, performance, notifications |
| **Field Service Workflow** | ✅ | Partial | | `service-requests.js`, `work-orders.js`, `dispatch.js`, `ServiceRequest`, `WorkOrder` models, `equipment.js` | service-requests, work-orders, dispatch, equipment | `service-operations-contract`, `dispatch-reminders-contract` | Integrate Request→WO→Dispatch→Technician→Parts/Labor→Completion→Invoice→Payment→History, add arrival, notes, photos, documents, approval, sign-off |
| **Recurring Services & PM** | ✅ | | | `recurring-maintenance.js` route+lib, `RecurringMaintenanceSeries/Occurrence/Reminder` models, `admin/js/pages/recurring-maintenance.js` | recurring-maintenance | `recurring-maintenance-contract` | Add maintenance contracts, equipment service schedules, due dates, reminders, billing, history, recurrence rules |
| **Communication Centralized Architecture** | | | ❌ | Only `mailer.js`, `email-service.js`, `reminders.js` | notifications | — | Build EVENT→RULE→CHANNEL→RECIPIENT→TEMPLATE→DELIVERY→STATUS engine |
| **Email Notifications** | ✅ | Partial | | `mailer.js`, `email-service.js`, `sendBookingStatusEmail` | notifications | — | Expand to all listed events (booking confirm, reminder, reschedule, cancel, tech assigned/arrival, job started/completed, estimate created/approved, invoice created/due, payment received, maintenance reminder, follow-up, review request) |
| **SMS** | | | ❌ | — | — | — | Provider abstraction, support listed events |
| **WhatsApp** | | | ❌ | — | — | — | Provider abstraction |
| **Telegram** | | | ❌ | — | — | — | Provider abstraction |
| **Booking Confirmations Configurable** | | | ❌ | — | — | — | Tenant config enabled/disabled/timing/template/channel/sender/branding |
| **Notification Templates** | | | ❌ | — | — | — | Tenant-specific + platform defaults, variables {{customer.name}} etc |
| **Notification Logging** | | | ❌ | Only Activity, AuditLog | — | — | Track created/queued/sent/delivered/failed/retry/provider response/timestamp/channel/recipient/related entity |
| **Payments Integration** | ✅ | Partial | | `payments.js` route, `lib/payments` (Stripe, PayPal, Tilopay, WiPay, COD, bank), `pos.js`, `orders.js` checkout | point-of-sale, orders | `payments.test.js`, `tilopay-unit.test.js`, `subscription-payment.test.js` | Integrate scheduling with payments, support full/deposit/fixed/%/fees, enforce server-side, no bypass |
| **Discounts** | | ✅ | | `PromotionItem`, `promotions` but no discount codes | — | — | Implement %/fixed, codes, service/customer-specific, expiration, usage limits, booking/POS |
| **Reviews** | | ✅ | | `Testimonial` model, `testimonials.html` | — | — | Implement customer/staff/service reviews, ratings, requests, moderation, display, history, analytics, Google integration |
| **Expense Management** | | | ❌ | — | — | — | Expenses, categories, recurring, frequency, reminders, history, reporting, revenue vs expense, net income |
| **Analytics** | ✅ | Partial | | `analytics.js` route, `admin/js/pages/analytics.js`, `dashboard.js` stats | reports | — | Expand to appointments (total/completed/cancelled/rescheduled/no-show/upcoming/recurring), booking (visits/bookings/conversion/cancel/popular services/times), staff (jobs/appointments/revenue/completion/workload), services (popular/revenue/frequency/completion), financial (revenue/payments/expenses/net/deposits/refunds/methods) |
| **Calendar Integrations** | | | ❌ | — | — | — | Architecture for Google Calendar, device calendars, sync, disconnect/reconnect, status, errors |
| **Data Import/Migration** | | ✅ | | `supplier-imports.js`, `supplier-products.js` only supplier | supplier-imports | `suppliers.test.js` | Implement customer/staff/services/categories/appointments CSV import/export, validation, duplicate detection, preview, error reporting, history, logs |
| **POS** | ✅ | | | `pos.js` route, `admin/js/pages/pos.js`, `Sale`, `SaleLineItem`, `SaleRefund` models | point-of-sale | `pos.test.js` | Integrate products/services/parts/inventory/customers/payments/discounts/invoices/receipts/stock deduction |
| **Inventory** | ✅ | | | `inventory.js` route, `Product` quantity, `InventoryAdjustment`, `Restock`, `admin/js/pages/inventory.js` | inventory | `api.test.js` | Add stock movements, low-stock alerts, serial numbers, categories, purchase records, supplier association, tech parts usage, history |
| **Supplier Marketplace** | ✅ | | | Extensive: `suppliers.js`, `supplier-integrations.js`, `supplier-products.js`, `supplier-imports.js`, `supplier-fulfillments.js`, `supplier-shipping.js`, `supplier-syncs.js`, `supplier-settings.js`, models Supplier, SupplierProduct, Mapping, Fulfillment, ShippingRule, MarkupRule | suppliers, supplier-integrations, supplier-imports, supplier-products, supplier-fulfillment, supplier-shipping, supplier-sync, supplier-logs, supplier-settings, supplier-marketplace | `suppliers.test.js` (107 checks) | Maintain and expand |
| **Equipment Management** | ✅ | Partial | | `equipment.js` route, `Equipment` model, `admin/js/pages/equipment.js` | equipment | — | Add type, manufacturer, model, serial, install date, warranty, service history, maintenance schedule, photos, docs, parts history, tech notes |
| **Estimates** | ✅ | Partial | | `estimates.js` route, `Estimate` model, `admin/js/pages/estimates.js` | estimates | — | Add create/edit/send/approval/rejection/expiration/convert to WO/invoice/notifications/history |
| **Invoicing** | ✅ | Partial | | `invoices.js` route, `Invoice` model, `admin/js/pages/invoices.js` | invoices | — | Add line items, parts/labor/services/taxes/discounts/deposits/balance/status/PDF/print/delivery/payment link/reminders/receipt |
| **Customer Portal** | | ✅ | | `customer-portal.js` overview, `customer/index.html` minimal | — | `role-dashboard-mobile-navigation` | Build full desktop/mobile portal: dashboard, appointments, booking, reschedule/cancel, work orders, service history, equipment, estimates, approvals, invoices, payments, receipts, messages, notifications, profile, preferences |
| **Technician Mobile Experience** | | ✅ | | `technician-portal.js` overview, `technician/index.html` minimal | — | `role-dashboard-mobile-navigation` | Build phone-first: today's schedule, upcoming jobs, job details, customer/equipment details, nav link, start/arrive/pause/resume, notes, photos, parts/labor, status, signature, completion, invoice, notifications, communication |
| **Tenant Admin Mobile** | | ✅ | | `admin/` SPA responsive partially, `tenant/index.html` boots same layout | dashboard, etc | `role-dashboard-mobile-navigation` | Support dashboard, calendar, bookings, customers, staff, techs, work orders, dispatch, services, products, inventory, estimates, invoices, payments, notifications, reports, settings with mobile-friendly nav |
| **Platform Owner Mobile** | | ✅ | | `admin/` SPA same layout, `superadmin/index.html` redirects | platform-only | — | Mobile access to platform dashboard, tenants, plans, features, subscriptions, billing, analytics, health, users, notifications, settings |
| **Responsive Design Standard** | | ✅ | | `admin.css` has 1024px, 640px breakpoints, but many tables not converted to cards | — | `ui.test.js` | Ensure desktop/laptop/tablet/mobile portrait/landscape work, no horizontal overflow, tiny buttons, desktop-only tables, unusable forms, hidden actions, broken drawers, white screens, nav traps, modals larger than viewport, fixed-width layouts |
| **Mobile Navigation** | | ✅ | | `layout.js` sidebar is-open, backdrop, nav-group toggle, but needs active route, submenu, close on nav, close button, overlay, escape, touch-friendly, sign-out, permissions, feature visibility | — | `role-dashboard-mobile-navigation` | Every role must have functional mobile nav, no duplicate permission logic |
| **Authentication** | ✅ | Partial | | `auth.js` login/refresh/logout, `middleware/auth.js` protect, `api.js` silent refresh, `role-auth.js` requireRole | — | `auth-plan-regression`, `bootstrap-super-admin`, `public-login` | Verify login/logout/session restoration/refresh/expired/unauthorized/role/tenant/SUPER_ADMIN detection/redirects/protected routes, logout immediate update |
| **Security** | ✅ | Partial | | `tenant.js` tenantWhere, `permissions.js`, `features.js` requireFeature, `csrf.js`, `cookies.js` secure, `validate.js`, `audit.js`, `rateLimit.js` | — | `rbac.test.js` | Maintain tenant isolation, RBAC, backend auth, feature entitlement, CSRF, secure token, server-side payment validation, input validation, audit logging, auth before data access, UI hidden + backend protected |
| **Plan & Subscription** | ✅ | Partial | | `saas.js` plans/businesses/subscriptions, `Plan`, `Subscription`, `SubscriptionPayment` models, `admin/js/pages/saas.js`, `billing.js`, `subscription.js` | plans-subscription | `saas.test.js`, `subscription-payment.test.js` | Platform Owner create/edit/enable features/set pricing/billing cycle/descriptions/availability/assign/change/cancel/suspend/view status, prevent free bypass, enforce payment server-side |
| **API Design** | ✅ | Partial | | `app.js` mounts, `routes/*.js` use protect, tenantWhere, validate, featureProtectedRoute | — | `api.test.js` | Every new capability needs auth/authz/tenant isolation/feature protection/validation/error handling/tests, use existing conventions |
| **Database** | ✅ | Partial | | `prisma/schema.prisma` extensive, `migrations/` | — | — | Inspect existing before adding tables, reuse relationships, migrations, preserve data, indexes, tenant/business ownership, isolation, FKs, test migrations isolated |
| **Testing** | ✅ | Partial | | `backend/tests/run-all.js` 21 suites, `api.test.js`, `ui.test.js`, `site.test.js`, etc | — | — | Need unit, API, integration, UI desktop/mobile, regression, security, feature, RBAC tests per capability |
| **POS Schema v2** | ✅ | Partial | | `pos-schema-v2.prisma` file at root, `Sale` models in main schema | point-of-sale | `pos.test.js` | Merge/align v2 with main schema |
| **Content Manager & Media Library** | ✅ | | | `content.js`, `site-content.js`, `media.js`, `public-content.js`, `ContentPage`, `ServiceItem`, `Testimonial`, `GalleryItem`, `FaqItem`, `PromotionItem`, `TeamMember`, `MediaAsset` | content-manager, media-library | `content.test.js` | Maintain, ensure tenant feature controlled |

---

## 3. Separation of Concerns

### Already Implemented (Keep & Extend)
- Multi-tenant core: Business, User, Customer, Product, Category, Service, Booking, Order, InventoryAdjustment, Restock, Setting, Activity, AuditLog
- Field service: ServiceRequest, WorkOrder, Equipment, Technician, JobStatus, ServiceHistory
- Recurring maintenance: Series, Occurrence, Reminder
- Supplier Marketplace: Supplier, SupplierProduct, Mapping, Fulfillment, ShippingRule, MarkupRule, Integration, Import, Sync
- POS: Sale, SaleLineItem, SaleRefund, SaleRefundLineItem
- SaaS: Plan, Subscription, SubscriptionPayment, PlatformFeature, TenantFeatureAccess
- Website Content: ContentPage, ServiceItem, Testimonial, GalleryItem, FaqItem, PromotionItem, TeamMember, MediaAsset
- Auth: RefreshToken, JWT, cookies, CSRF, rate limiting
- Admin SPA: layout, api client, 40+ page modules, responsive CSS, dark mode
- Role dashboards: customer, technician, tenant, superadmin shells

### Partially Implemented (Needs Completion)
- Calendar: month only, no day/week/agenda/staff views
- Booking: public form not integrated with availability engine
- Customer CRM: basic profile, missing categories, custom fields, full histories
- Service management: basic, missing categories, images, availability rules
- Staff: basic User list, missing schedules, working hours, performance
- Dispatch: basic JobStatus, missing workload, assignment UX
- Estimates/Invoices: basic CRUD, missing conversion, PDF, payment links
- Equipment: basic, missing photos, docs, warranty, maintenance schedule
- Customer portal: minimal stats, missing full portal spec
- Technician portal: minimal jobs, missing field workflow
- Payments: gateway integration exists but not tied to scheduling deposits
- Analytics: basic stats, missing detailed appointment/booking/staff/service/financial analytics
- Mobile: responsive breakpoints exist but not first-class for all roles

### Broken (Known Issues)
- Recurring appointments not appearing: dashboard upcoming now includes `recurringMaintenanceOccurrence` but calendar page only queries `bookings/calendar` which may exclude recurring if filtering or if booking creation failed; also `recurring-maintenance` page is ID-based manual form, not user-friendly; trace complete path DB→API→Query→Auth→Filtering→Dashboard→UI
- Admin navigation: highlightNav only checks path equality, but submenus hidden attribute toggling, active group expansion, back/forward navigation state, refresh behavior may lose state; submenu positioning CSS needs verification (`.nav-group__items` padding-left)
- Feature Management #/features load: test `admin-dashboard-reliability.test.js` checks mount at /api/saas/features, but need to verify GET works and registry sync; potential duplicate mount of `/api/features` and `/api/saas/features`
- Logout: `auth.logout()` clears local storage first then POST logout, but role-auth.js signOut delegates to same; need to test across all roles that UI updates immediately without refresh, cookies cleared, sessionVersion incremented, redirect to correct login page, prevent authenticated navigation
- Mobile navigation: admin sidebar backdrop show/hide works but menu-toggle aria-expanded, close on navigation (innerWidth <=1024) only closes on nav-link click, not on route change via hashchange; role dashboards mobile nav toggle works but no escape key, overlay, focus management

### Missing (New Implementation Required)
- Calendar system: day, 3-day, week, agenda, staff, technician, filtering, search, creation/edit/reschedule/cancel/delete/status/notes/activity log/history/conflict detection/availability/time-off/working hours/breaks/closed days/staff-specific schedules
- Advanced scheduling: multiple technicians/staff, multiple services per appointment, buffers, lead time, booking window, custom working hours, specific working days, closed days, time off, on-request, recurring auto-generation, rebooking, templates
- Online booking full experience: service/category/technician/staff selection, date/time availability, customer details, custom fields, review, pay/deposit, confirm, confirmation, responsive, shareable URL, embedding, policies, branding, social links, gallery, service images/descriptions
- Communication centralized: EVENT→RULE→CHANNEL→RECIPIENT→TEMPLATE→DELIVERY→STATUS
- Email/SMS/WhatsApp/Telegram channels with provider abstraction, templates, logging
- Booking confirmations configurable
- Notification templates with variables
- Discounts: codes, service/customer-specific, expiration, usage limits, campaigns
- Reviews: customer/staff/service ratings, requests, moderation, display, history, analytics, Google integration
- Expenses: categories, recurring, frequency, reminders, history, reporting, revenue vs expense, net income
- Calendar integrations: Google, device, sync, disconnect/reconnect, status, errors
- Data import/migration: customer/staff/services/categories/appointments CSV import/export, validation, duplicate detection, preview, error reporting, history, logs
- Equipment photos/docs/parts history
- Estimates: send/approval/rejection/expiration/convert to WO/invoice/notifications/history
- Invoicing: line items, parts/labor/services/taxes/discounts/deposits/balance/status/PDF/print/delivery/payment link/reminders/receipt
- Customer portal full spec
- Technician mobile full spec
- Tenant Admin mobile full spec
- Platform Owner mobile full spec
- Expenses, analytics deep, POS integration with inventory/customers/payments/discounts/invoices/receipts/stock deduction

### Duplicate/Conflicting Implementations
- `admin/index.html` vs `tenant/index.html` vs `superadmin/index.html` vs `customer/index.html` vs `technician/index.html` — separate shells but `tenant/index.html` boots same `admin/js/layout.js` which already has platformOnly/tenantOnly filtering; need to ensure single permission source, no duplication
- `api.js` auth store vs `role-auth.js` store — both use `nds.auth` localStorage but different implementations; need consolidation
- `Product` quantity vs `supplierStock` vs `fulfillmentType` — already documented separation, keep
- `pos-schema-v2.prisma` at root vs main `backend/prisma/schema.prisma` — potential divergence, need alignment
- `/api/features` mounted twice: once for `/api/saas/features` and once for `/api/features` plus `/api/features` access route — need to verify no conflict

### Security Risks
- Booking form `booking.html` posts to static? Actually `assets/js/site-api.js` may post to public API without CSRF? Need to verify public routes bypass CSRF correctly (payment webhooks do, but public booking should)
- Payment method enabled check via `payments.assertMethodEnabled` — ensure server-side validation not bypassable by client
- Feature disabled must hide UI AND protect backend — need audit for every new route
- Tenant isolation: `tenantWhere` used in most routes but `technicians.js`, `equipment.js`, `estimates.js`, `invoices.js` need verification
- Refresh token rotation: implemented but need to ensure sessionVersion increment on logout-all and password change invalidates all sessions
- SUPER_ADMIN businessId NULL must remain unrestricted but not leak tenant data across tenants; verify `teamUserWhere` returns undefined for platform admin (platform-wide roster) is intentional for user management, not for customer data
- No hardcoded production credentials — check `.env.example`, ensure no secrets in repo
- Supplier credentials AES-256-GCM encrypted — verify key management

### Mobile Gaps
- Admin: tables not converted to mobile cards/lists, forms not usable on small screens, modals larger than viewport, touch targets small, hamburger navigation needs close button, overlay, escape key, focus management
- Tenant Admin: same as Admin plus need calendar mobile, bookings mobile, dispatch mobile
- Technician: minimal mobile, needs full field workflow on phone
- Customer: minimal mobile, needs booking, rescheduling, cancellation, service history, equipment, estimates, invoices, payments, notifications, profile
- Platform Owner: needs mobile access to all platform administration

### Desktop Gaps
- Calendar: only month, missing day/week/agenda
- Booking: no real calendar integration, no staff assignment UI
- Dispatch: basic list, missing drag-drop board, workload
- Estimates/Invoices: missing PDF preview, line items UX
- POS: needs product search, barcode, customer assignment, discount, payment method selection, receipt printing
- Supplier Marketplace: extensive but needs mobile responsiveness verification
- Content Manager: rich text editor basic, needs media library integration

### Test Gaps
- Mobile UI tests: `ui.test.js` uses jsdom but not mobile viewport testing
- Security tests: cross-tenant access attempts, feature disabled access, RBAC per role
- Feature tests: disabled feature must be inaccessible backend + UI hidden
- Integration tests: DB+API+service behavior for recurring maintenance, booking conflict, payment capture, supplier fulfillment
- Regression: existing functionality must remain operational after new features
- Calendar: day/week/agenda, conflict detection, availability
- Online booking: desktop+mobile booking flow, payment required enforcement
- Technician mobile workflow: today's schedule, job details, start/arrive/pause/resume, notes, photos, parts/labor, signature, completion, invoice
- Customer portal: booking, rescheduling, cancellation, history, equipment, payments
- Expenses, discounts, reviews, calendar integrations, import/migration not covered

---

## 4. Recommended Implementation Sequence (Phases A-Q)

### Phase A: Inspect and Stabilize Existing Platform
- [x] Complete this gap analysis
- [ ] Run full test suite `npm test` and document failures
- [ ] Verify production build and Vercel build
- [ ] Audit existing schema, routes, pages, tests, feature keys

### Phase B: Finish Admin/Auth/RBAC/Feature Management Reliability
- Fix Feature Management #/features load, GET /api/saas/features, registry sync, tenant-capable keys, backend protection, navigation binding, Plan→Feature→Tenant entitlement
- Fix Admin Navigation: current menu highlighting, submenu positioning, desktop/tablet/mobile, active route, back/forward, refresh
- Fix Logout: immediate clear, refresh token invalidation, UI update, redirect, prevent authenticated nav, test all roles desktop+mobile
- Verify SUPER_ADMIN businessId=NULL authoritative, not tenant
- Add missing feature keys from target list without duplicates: online-booking, appointments (alias service-bookings?), recurring-appointments, booking-confirmations, email-reminders, sms-reminders, whatsapp-reminders, telegram-notifications, notification-center, notification-templates, customers, services, staff, technicians, dispatch, service-requests, work-orders, equipment, service-history, recurring-maintenance, estimates, invoices, payments, point-of-sale, products, inventory, reviews, discounts, expenses, analytics, calendar-integrations, customer-portal, technician-mobile, supplier-marketplace, etc — check existing before adding
- Tests: platform-feature-access-contract, admin-dashboard-reliability, auth-plan-regression, rbac

### Phase C: Complete Calendar and Appointment Foundation — ✅ DELIVERED (see `docs/PHASE_C_CALENDAR_SCHEDULING.md`)
- [x] Day, 3-day, week, month, agenda views + technician/staff filtering and schedules tab (single-technician architecture; multi-tech per appointment stays a Phase E decision)
- [x] Appointment filtering by tech/status/service/customer/search
- [x] Appointment creation (bookings form), edit/reschedule/cancel/delete/status/notes from the calendar; server-side conflict detection, availability checking, time-off blocking, working hours, breaks, closed days, per-technician schedules
- [x] API: GET /api/bookings/calendar?view=day|3day|week|month|agenda&date=...&technicianId=&status=&serviceId=&customerId=&search= + GET /api/bookings/availability
- [x] UI: admin/js/pages/calendar.js expansion, responsive/mobile
- [x] Database: WorkingHours, TimeOff, BreakPeriod, ClosedDay models (+indexes); Booking.durationMin/bufferMin — additive migration `20260912000000_calendar_scheduling`
- [x] Feature key: calendar (already registered; API gated, entitlement tested, SUPER_ADMIN unrestricted)
- [x] Tests: scheduling-rules.test.js (units) + calendar-scheduling-contract.test.js (28-check API contract) in run-all.js; ui.test.js calendar needles extended
- Note: recurring-occurrence and work-order linkage surface on the calendar (`recurring` flag, `workOrder` link); notification event bus added as the Phases G/H foundation

### Phase D: Complete Online Booking
- Public booking experience: service/category/tech/staff/date/time/customer details/custom fields/review/pay/deposit/confirm/receive confirmation
- Desktop/mobile responsive, shareable booking URL, website embedding/linking, policies, lead time, availability rules, booking window, branding, business info, social links, gallery, service images/descriptions
- API: public availability endpoint, booking creation with payment enforcement
- Integrate with existing booking.html or replace with new booking portal at /booking or /book
- Feature key: online-booking
- Tests: site.test.js expansion, payment required enforcement

### Phase E: Complete Customer/Staff/Technician Scheduling
- Customer management: profiles, categories, search, filtering, notes, custom fields, contact info, appointment/service/equipment/communication/invoice/estimate/payment/review history, portal, self-service, booking, reschedule/cancel, notification preferences
- Service management: categories, descriptions, pricing, duration, images, availability, staff/tech assignment, service-specific scheduling, multiple per appointment, statistics, status, auto-finish
- Staff management: accounts, profiles, roles, photos, contact, schedules, working hours, closed days, specific working days, services, availability, calendars, history, workload, performance, notifications
- Feature keys: customers, services, staff, technicians

### Phase F: Complete Recurring Appointments and Preventive Maintenance
- Generalize recurring maintenance to recurring appointments: recurring appointments, maintenance contracts, auto generation, equipment service schedules, due dates, reminders, contract billing, history, recurrence rules, pause/resume/skip/reschedule/generate work orders
- Fix recurring not appearing: ensure calendar includes recurring occurrences, dashboard upcoming includes recurring, recurring-maintenance page user-friendly (customer/equipment/service/tech pickers, not just IDs)
- Feature keys: recurring-appointments, recurring-maintenance

### Phase G: Build Centralized Notification Engine
- EVENT→RULE→CHANNEL→RECIPIENT→TEMPLATE→DELIVERY→STATUS architecture
- Notification model, NotificationRule, NotificationTemplate, NotificationLog
- Tenant-specific templates, platform defaults, variables {{customer.name}} etc
- Channels: Email, SMS, WhatsApp, Telegram, In-app, Push
- Logging: created/queued/sent/delivered/failed/retry/provider response/timestamp/channel/recipient/related entity
- Feature keys: notification-center, notification-templates

### Phase H: Integrate Email/SMS/WhatsApp/Telegram
- Email: booking confirmation, appointment confirmation/reminder, reschedule/cancel, tech assigned/arrival, job started/completed, estimate created/approved, invoice created/due, payment received, maintenance reminder, follow-up, review request
- SMS: confirmation, reminder, reschedule, cancel, tech arrival, job completion, maintenance reminder, payment reminder/confirmation — provider abstraction
- WhatsApp: same — provider abstraction, not hardcoded
- Telegram: notifications, reminders, booking/business/staff notifications — provider abstraction
- Booking confirmations configurable per tenant: enabled/disabled, timing, template, channel, sender identity, branding
- Feature keys: booking-confirmations, email-reminders, sms-reminders, whatsapp-reminders, telegram-notifications

### Phase I: Complete Customer Portal
- Desktop/mobile portal: dashboard, appointments, booking, rescheduling, cancellation, work orders, service history, equipment, estimates, approvals, invoices, payments, receipts, messages, notifications, profile, preferences
- API: customer-portal.js expansion
- Feature key: customer-portal
- Tests: role-dashboard-mobile-navigation, tenant.test.js

### Phase J: Complete Technician Mobile Workflow
- Phone-first: today's schedule, upcoming jobs, job details, customer/equipment details, navigation/location link, start/arrive/pause/resume, notes, photos, parts/labor, status updates, signature, completion, invoice, notifications, communication
- API: technician-portal.js expansion, work-orders, equipment, inventory parts
- Feature key: technician-mobile
- Tests: mobile test matrix for technician

### Phase K: Complete Payments/Deposits/Discounts/Reviews
- Payments: Stripe, PayPal, Tilopay, WiPay, COD, bank transfer, POS, full/deposit/fixed/%/fees, status, refunds, receipts, confirmations, enforce server-side
- Discounts: %/fixed, codes, service/customer-specific, expiration, usage limits, campaigns, booking/POS discounts
- Reviews: customer/staff/service ratings, requests, moderation, display, history, analytics, Google integration
- Feature keys: payments, discounts, reviews

### Phase L: Complete Expenses/Statistics/Calendar Integrations
- Expenses: categories, recurring, frequency, reminders, history, reporting, analytics, revenue vs expense, net income, integration with financial reporting
- Analytics: appointments total/completed/cancelled/rescheduled/no-show/upcoming/recurring, booking visits/bookings/conversion/cancel/popular services/times, staff jobs/appointments/revenue/completion/workload, services popular/revenue/frequency/completion, financial revenue/payments/expenses/net/deposits/refunds/methods
- Calendar integrations: Google Calendar, device calendars, sync, disconnect/reconnect, sync status, error handling
- Feature keys: expenses, analytics, calendar-integrations

### Phase M: Complete Migration/Import Tools
- Customer import, staff import, services import, categories import, appointments import, CSV import/export, validation, duplicate detection, preview, error reporting, history, migration logs
- Never blindly insert imported data
- Feature keys: maybe content-manager for import?

### Phase N: Integrate All Capabilities with Field Service
- Request→Work Order→Dispatch→Technician→Parts/Labor→Completion→Invoice→Payment→History
- Service requests, work orders, dispatch, assignment, job status, tech arrival, notes, customer notes, equipment, parts, labor, photos, docs, approval, digital sign-off, completion, service history

### Phase O: Integrate POS/Inventory/Suppliers
- Products, services, parts, inventory, customers, payments, discounts, invoices, receipts, stock deduction
- Products, parts, stock levels, movements, low-stock alerts, serial numbers, categories, purchase records, supplier association, tech parts usage, history
- Suppliers, products, integrations, imports, fulfillment, shipping, sync, logs, settings, marketplace purchasing

### Phase P: Complete SaaS Plans/Feature Entitlements
- Platform Owner create/edit/enable/disable features, set pricing/billing cycle/descriptions/availability, assign/change/cancel/suspend subscription, view status
- Prevent unrestricted free plan selection where payment required, enforce server-side
- Expand registry as capabilities implemented, stable keys, name, description, category, tenant-capable, backend protection, navigation binding, plan entitlement, tests
- Use same feature key for Feature Registry→Plan→Subscription→Backend→Navigation→UI

### Phase Q: Desktop/Mobile Regression Testing
- Test matrix: SUPER_ADMIN, TENANT_ADMIN, TECHNICIAN, CUSTOMER across Dashboard, Calendar, Booking, CRM, Services, Staff, Dispatch, Work Orders, Equipment, Estimates, Invoices, Payments, POS, Inventory, Notifications, Reports, Settings
- Mobile: login, logout, navigation, booking, calendar, appointment creation/reschedule, customer portal, technician job workflow, dispatch, work order, parts, photos, signature, invoice, payment, notifications
- Accessibility: keyboard nav, ARIA, focus, dialogs, menus, screen reader, touch targets, form labels, error messages, loading states
- Performance: pagination, lazy loading, efficient queries, indexes, caching, debounced search, optimized mobile payloads, efficient calendar queries
- Error handling: loading/empty/error/retry/success/validation feedback, no silent failures
- Audit logging: login/logout/plan creation/modification/feature changes/tenant creation/removal/subscription changes/appointment/work-order/invoice/payment/user/role/notification config changes

---

## 5. Implementation Principles (Non-Negotiable)

- Inspect before creating, reuse existing architecture, no duplicate systems, no competing implementations
- Do not weaken tenant isolation, do not bypass payment, do not bypass Feature Management, do not modify production data, do not reset/reseed production, do not remove existing functionality, no destructive schema changes without migration, no hardcoded credentials, no fake tenant ownership, no RBAC meaning change without evidence, no merge unless tests+CI pass
- Owner model: Christopher Alexis SUPER_ADMIN businessId=NULL, not tenant, unrestricted platform admin
- Mobile first-class, not shrunk desktop
- One platform, one security model, one entitlement system, one data architecture
- Do not build separate SetTime clone, absorb capabilities into N&D'S
- Git workflow: feature branches, commit, push, PR, CI, fix failures, re-run, only merge when verified

---

## 6. Current File Inventory (Key)

- Backend: `backend/src/app.js`, `backend/src/lib/feature-registry.js`, `features.js`, `permissions.js`, `tenant.js`, `prisma/schema.prisma`, `prisma/migrations/*`, `src/routes/*.js` (40+ routes), `src/middleware/*`, `src/lib/*`
- Admin: `admin/index.html`, `admin/js/layout.js`, `api.js`, `ui.js`, `admin/css/admin.css`, `admin/js/pages/*.js` (40+ pages)
- Role dashboards: `customer/index.html`, `technician/index.html`, `tenant/index.html`, `superadmin/index.html`, `role-auth.js`, `assets/css/role-dashboard.css`
- Public: `index.html`, `booking.html`, `services.html`, `products/`, `assets/js/main.js`, `site-api.js`, `login.html`, `register.html`
- Tests: `backend/tests/*.test.js` (21 suites), `run-all.js`
- Docs: `ADMIN_DASHBOARD.md`, `SUPPLIER_MARKETPLACE.md`, `docs/TENANT_FEATURE_MANAGEMENT.md`, `docs/NDS-MASTER-SAAS-APPLICATION-BLUEPRINT.md`

---

## 7. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Breaking tenant isolation when adding multi-tech/multi-service | Always use tenantWhere, validate parent belongs to same tenant, add integration tests for cross-tenant |
| Payment bypass | Server-side validation of paymentMethod, deposit required, no client price trust, captureOrder idempotent |
| Feature duplication | Check registry before adding key, normalize key, use same key everywhere |
| Production data loss | Never reset production, migrations only, test in isolated env, backup confirmation |
| Mobile UX degradation | Test small screens, tables→cards, touch targets >=44px, no horizontal overflow, hamburger drawer with overlay, escape, focus management |
| Calendar performance | Efficient queries with date ranges, indexes on scheduledAt, businessId, technicianId, pagination, lazy loading |
| Notification provider lock-in | Provider abstraction layer, interface not implementation |
| Scope creep | Phased approach A-Q, each phase branch+PR+CI |

---

## 8. Next Steps (Immediate)

1. Run `npm test` locally to capture baseline CI status
2. Create feature branch for Phase B reliability fixes (this branch already serves as gap analysis branch)
3. Fix Feature Management #/features load, GET /api/saas/features, navigation highlighting, submenu positioning, logout immediate, recurring appointments data flow
4. Push branch, open PR, provide branch name, PR number/URL, starting main SHA, latest commit SHA, changed files, CI status
5. After approval, proceed to Phase C calendar foundation

---

## 9. Acceptance Criteria (Final)

Platform: SUPER_ADMIN, Tenant Admin, Technician, Customer, tenant isolation, plans, Feature Management, billing works
Scheduling: calendar, online booking, staff/tech scheduling, recurring, rescheduling, cancellation, multiple staff/services works
Communication: email, SMS architecture, WhatsApp architecture, Telegram architecture, booking confirmations, reminders, notification logging works
Field Service: requests, work orders, dispatch, technician workflow, parts/labor, completion, sign-off works
Financial: estimates, invoices, payments, deposits, discounts, POS, expenses works
Customer: portal, booking, history, equipment, payments, notifications, reviews works
Mobile: Admin, Tenant Admin, Technician, Customer navigation, forms, calendar, booking, field-service workflow works
Desktop: all corresponding workflows work

**Finished product:** Complete multi-tenant field-service business OS combining SetTime-level scheduling+booking with N&D'S CRM, field service, dispatch, technicians, equipment, preventive maintenance, estimates, invoices, payments, POS, inventory, suppliers, analytics, communication automation and SaaS management, working across Desktop+Tablet+Mobile for Platform Owner+Tenant Admin+Technician+Customer with one platform+one security model+one entitlement system+one data architecture.

---

*Generated by inspection of actual codebase on 2026-09-12, not by guessing.*
