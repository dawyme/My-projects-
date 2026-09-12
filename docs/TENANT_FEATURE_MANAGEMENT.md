# Tenant Feature Management

Feature Management is the authoritative control plane for every feature that may be exposed to a tenant business.

## Required workflow for a new tenant-capable feature

1. Add a stable key and metadata to `backend/src/lib/feature-registry.js`.
2. Add the tenant dashboard route to the registry when the feature has a dashboard module.
3. Add every tenant API prefix to the registry.
4. Mount the API through `featureProtectedRoute('<key>')` in `backend/src/app.js`.
5. Add the navigation item with the same `feature` key in `admin/js/layout.js`.
6. Add or update the contract tests when the feature introduces a new route family.
7. Use the same stable key in Plan feature definitions.

## What the registry controls

- Tenant Feature Management listing and metadata
- Per-tenant feature access through `TenantFeatureAccess`
- Tenant dashboard navigation visibility
- Tenant API authorization
- Future Plan → Features → Tenant Subscription entitlements

## Rules

- `SUPER_ADMIN` is never restricted by tenant feature access.
- Platform-only features do not belong in the tenant registry.
- Existing tenant access overrides are not overwritten by registry synchronization.
- A new `/api/...` route must either be explicitly platform/public or be protected by a registered tenant feature.
- Content Manager and Media Library are tenant features and must remain controlled by Feature Management.

The registry synchronization creates missing built-in `PlatformFeature` rows after deployment without requiring a production seed/reset. Existing administrator-controlled status, core, default, and tenant access values are preserved.
