# N&D’S Management System — Master SaaS Application Blueprint

**Status:** Architecture approved for formal specification and phased implementation  
**Repository:** `dawyme/My-projects-`  
**Main commit at blueprint approval:** `5f95b3c9`  
**Database:** PostgreSQL / Supabase  
**ORM:** Prisma 6.19.3  
**Tenant boundary:** `businessId`

## Purpose

This blueprint defines the target architecture for extending the existing N&D’S Management System into a multi-tenant SaaS platform with four distinct application experiences. It preserves the existing production architecture and does not call for a rebuild.

## Four Application Experiences

### Customer App
- Sign up / login
- Profile and addresses
- Request/book service
- Appointment status and reminders
- Technician/dispatch status where enabled
- Service history and equipment
- Estimates and estimate approval
- Invoices, payments and receipts
- Notifications and support/contact

### Technician App
- Mobile-first job queue
- Today's jobs and calendar
- Dispatch and navigation
- Customer, equipment and service history
- Work orders
- Job notes and photos
- Parts/materials and labor
- Checklists
- Customer signature
- Completion report
- Offline-friendly field workflow
- Notifications

Job lifecycle: `Assigned → Accepted → En Route → Arrived → Diagnosing → Work In Progress → Completed → Customer Signature → Work Order Closed`

### Tenant / Business App
- Business dashboard
- Customers
- Bookings
- Service Requests
- Work Orders
- Dispatch
- Calendar
- Reminders
- Service History
- Equipment
- Products and Categories
- Inventory
- POS
- Estimates
- Invoices
- Payments
- Reports and analytics
- Staff, technicians, users, roles and permissions
- Business settings
- Notifications
- Content Manager
- Marketplace
- Subscription, plan and usage

Each tenant must only see and manage its own business data.

### Owner / Super Admin App
- Platform dashboard
- Total, active, trial and suspended tenants
- Platform revenue and usage
- System health
- Tenant management and onboarding
- Tenant users and usage
- Tenant subscriptions
- Suspend/reactivate tenant
- Plans, features and entitlements
- Billing
- Platform analytics
- Marketplace administration
- Audit logs
- Security administration
- Platform settings

## Shared Platform Architecture

```text
                    N&D’S SAAS PLATFORM
                             |
                  Authentication + RBAC
                  + Permissions + Tenancy
                             |
                       Existing API
                             |
       +---------------------+---------------------+
       |                     |                     |
 CUSTOMER APP        TECHNICIAN APP        TENANT APP
       |                     |                     |
       +---------------------+---------------------+
                             |
                    OWNER / SUPER ADMIN
                             |
                    PostgreSQL / Supabase
```

All four applications reuse the existing backend/API and business logic.

## Shared Backend Services

Authentication and sessions; users, businesses, roles and permissions; customers; bookings; service requests; work orders; dispatch; calendar; reminders; service history; equipment; products, categories and inventory; POS; estimates, invoices and payments; notifications; Content Manager; Marketplace; plans, subscriptions and billing; audit logging.

## Tenant Isolation and Security

Every protected request follows:

```text
Request
  → Authentication
  → User
  → Role
  → Business/Tenant
  → Permission
  → Resource Authorization
  → Database Query
```

**Non-negotiable rule: Tenant A must never access Tenant B data.**

| Actor | Expected scope |
|---|---|
| Customer | Own account and authorized service records |
| Technician | Authorized jobs and required tenant resources |
| Tenant Admin | Only their business/tenant |
| Owner / Super Admin | Authorized platform administration |

## End-to-End Business Workflow

```text
CUSTOMER
  → BOOKING
  → SERVICE REQUEST
  → DISPATCH
  → TECHNICIAN
  → WORK ORDER
  → SERVICE COMPLETED
  → ESTIMATE / INVOICE
  → PAYMENT
  → SERVICE HISTORY
  → CUSTOMER NOTIFICATION
```

## Application Navigation

**Customer:** Home / Book Service / Appointments / Services / Equipment / Estimates / Invoices / Notifications / Profile

**Technician:** Today / Jobs / Calendar / Dispatch / Customers / Equipment / Work Orders / Parts / Service History / Profile

**Tenant:** Dashboard / Operations / Customers / Dispatch / Calendar / Service / Inventory / POS / Invoices / Reports / Staff / Marketplace / Content / Settings

**Super Admin:** Dashboard / Tenants / Users / Plans / Subscriptions / Billing / Marketplace / Analytics / Audit Logs / System Health / Settings

## Notification Architecture

A shared notification service should support, where configured, email, SMS and push notifications.

Events include booking received/confirmed, appointment reminders, technician assigned, technician en route/arrived, job completed, estimate ready/approved, invoice created, payment received, subscription events and system alerts.

## Reporting

**Tenant reports:** revenue, sales, jobs, technician performance, customer growth, outstanding invoices, inventory, parts usage, service types and booking conversion.

**Platform reports:** tenant growth, subscription revenue, plan distribution, platform usage, tenant activity and system health.

## Testing and Verification

```text
Unit Tests
   → API Tests
   → RBAC Tests
   → Tenant Isolation Tests
   → Integration Tests
   → End-to-End Tests
   → Production Smoke Tests
```

Required security cases include Tenant A → Tenant A allowed; Tenant A → Tenant B denied; technicians restricted to authorized jobs; customers restricted to their own records; tenant administrators restricted to their tenant; and Super Admin operations requiring appropriate platform authorization.

## Development Roadmap

| Phase | Scope |
|---|---|
| 1 | Shared identity, security, tenant context and permissions |
| 2 | Tenant / Business application |
| 3 | Technician application |
| 4 | Customer application |
| 5 | Owner / Super Admin application |
| 6 | Notifications and payments |
| 7 | Testing and security audit |
| 8 | Controlled production rollout |

## Non-Negotiable Architecture Rules

1. Do not rebuild the existing N&D’S system from scratch.
2. Reuse existing backend APIs and business logic.
3. Preserve the existing production architecture.
4. Keep `businessId` as the tenant boundary.
5. Never permit cross-tenant data access.
6. Keep Customer, Technician, Tenant and Super Admin scopes distinct.
7. Verify before modifying production.
8. Do not run destructive production database operations.
9. Every major feature requires automated and end-to-end verification.
10. Production rollout must be controlled and reversible.

## Target State

```text
Existing N&D’S Management System
            +
Shared SaaS Identity
            +
RBAC / Permissions
            +
Tenant Isolation
            +
Customer App
            +
Technician App
            +
Tenant / Business App
            +
Owner / Super Admin App
            +
Testing / Security / Monitoring
            =
N&D’S MULTI-TENANT SAAS PLATFORM
```

## Implementation Boundary

This document is an architecture blueprint. It does not authorize immediate implementation of every phase. Each implementation phase must be planned, reviewed, tested and verified before production rollout.
