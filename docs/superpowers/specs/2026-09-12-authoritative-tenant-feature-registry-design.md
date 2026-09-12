# Authoritative Tenant Feature Registry Design

## Goal
Make Feature Management the single control plane for every feature that can be exposed to a tenant business dashboard, while ensuring future tenant-capable platform features cannot bypass it.

## Current findings
- `PlatformFeature` and `TenantFeatureAccess` already exist, but only Recurring Maintenance is registered as a built-in feature.
- `admin/js/layout.js` contains the complete tenant navigation list, while only `/recurring-maintenance` currently has a feature key.
- `/api/features/access` already returns the tenant's effective feature set and `layout.js` filters navigation from it.
- `requireFeature()` exists in `backend/src/lib/features.js` but is only used by the recurring-maintenance route today.
- Content Manager and Media Library are tenant-visible navigation entries and therefore must be governed like every other tenant-capable module.
- SUPER_ADMIN must remain unrestricted and must not be subject to tenant feature access.

## Proposed architecture
### 1. Authoritative built-in registry
Create `backend/src/lib/feature-registry.js` containing stable definitions for every tenant-capable module. Each definition has:
- `key`: immutable stable identifier used by navigation, APIs, plans, and access records.
- `name` and `description`: Feature Management display metadata.
- `category`: dashboard grouping/category for the management UI.
- `tenantCapable`: whether the feature may be exposed to tenant businesses.
- `defaultEnabled`: initial access for new tenants.
- `core`: always available to tenants; cannot be disabled.
- `apiPrefixes`: backend API prefixes that must be protected by this feature.
- `routes`: tenant dashboard paths controlled by the feature.

The registry is code-owned. The database remains the persistent control plane for active/inactive state and per-tenant overrides. Registry synchronization creates missing built-in features without overwriting an administrator's existing access choices.

### 2. Feature Management as master switchboard
The existing Feature Management API/UI will expose all registered tenant-capable features, not only Recurring Maintenance. Content Manager, Media Library, supplier modules, operations, people, catalogue, reporting, and other tenant-visible modules will be included.

The existing per-tenant `TenantFeatureAccess` table remains the source of tenant-specific overrides. Core features are shown but cannot be disabled. SUPER_ADMIN is never filtered by tenant access.

### 3. Navigation enforcement
Every tenant-visible navigation item will declare a feature key. `layout.js` will continue using `/api/features/access` as the effective entitlement list, but navigation entries without a valid registry feature key will be rejected by a regression contract. This prevents a developer from adding a new tenant module to the dashboard without registering it.

Platform-only navigation remains outside tenant feature management and is still protected by the existing role checks.

### 4. Backend/API enforcement
Every tenant-capable API prefix will be associated with a registry feature. A central feature middleware will resolve the feature for the request and enforce the existing `requireFeature` semantics. This closes the current gap where a hidden menu item could still be called directly through its API.

The middleware will bypass enforcement for SUPER_ADMIN, while inactive or disabled tenant features return the existing forbidden response.

### 5. Future-feature guard
Add contract tests that validate:
- every tenant navigation entry has a stable feature key;
- every referenced key exists in the authoritative registry and is tenant-capable;
- every tenant-capable registry entry has a corresponding Feature Management/seed definition;
- every tenant-capable API prefix declared by the registry is mounted behind feature enforcement;
- no platform-only feature is accidentally marked tenant-capable.

This makes Feature Management a mandatory architectural boundary for future tenant-facing features rather than a manual convention.

### 6. Plans and subscriptions
Keep the existing `Plan.features` JSON for compatibility, but use the same stable registry keys for plan feature definitions going forward. The feature registry therefore becomes the shared vocabulary for Feature Management and the future Plan → Features → Tenant Subscription entitlement flow. This change does not alter payment/subscription behavior in this phase.

## Initial tenant-capable feature set
The registry will cover the tenant dashboard modules currently present in the repository, including:
- Dashboard / Overview (core)
- Analytics / Reports
- Products
- Categories
- Inventory
- Service Bookings
- Calendar / Scheduling
- Dispatch Board
- Services
- Equipment
- Service History
- Recurring Maintenance
- Estimates
- Invoices
- Orders
- Point of Sale
- Customers
- Messages
- Team / Users
- Settings (core)
- Plans & Subscription (core)
- Supplier Marketplace Dashboard
- Suppliers
- Supplier Integrations / Plugins
- Supplier Product Import
- Supplier Products
- Supplier Fulfillment
- Supplier Shipping
- Supplier Sync & Automation
- Supplier Sync Logs
- Supplier Marketplace Settings
- Website Content / Content Manager
- Media Library

Platform Dashboard, Tenants & Plans, Feature Management, Platform Analytics, Billing & Subscriptions, System Health, and other SUPER_ADMIN-only functions remain platform-only.

## Safety constraints
- Work only on a feature branch and PR; do not merge or write production data.
- Do not remove or reset the existing `PlatformFeature` / `TenantFeatureAccess` architecture.
- Preserve the existing SUPER_ADMIN bypass and tenant isolation.
- Do not use database seeding as a requirement for production feature availability; registry synchronization must make missing built-ins appear after deployment.
- Existing administrator overrides must not be overwritten by registry synchronization.
