/**
 * Multi-tenant scoping primitives.
 *
 * Every authenticated request is scoped to exactly one tenant (Business).
 * The scope is resolved SERVER-SIDE from the authenticated user record —
 * never from a client-supplied header or body field — so Tenant A can never
 * read or write Tenant B data by manipulating a request.
 *
 * Conventions used by every tenant-owned route:
 *   • list queries    → `where: { businessId: req.tenantId, ...filters }`
 *   • reads by id     → `findFirst({ where: { id, businessId: req.tenantId } })`
 *   • writes          → stamp `businessId: req.tenantId` and validate that any
 *                       referenced parent rows belong to the same tenant
 *   • misses return   → 404 (existence inside another tenant is never leaked)
 *
 * The public website (contact / booking / checkout / published content)
 * belongs to the default tenant unless the deployment pins TENANT_ID.
 */

const DEFAULT_TENANT = process.env.TENANT_ID || 'default';

/** The tenant a request belongs to. */
function tenantOf(req) {
  if (req?.tenantId) return req.tenantId;
  if (req?.user?.businessId) return req.user.businessId;
  return DEFAULT_TENANT;
}

/** Middleware: resolve the tenant scope once per request (after `protect`). */
function scopeTenant(req, res, next) {
  req.tenantId = tenantOf(req);
  next();
}

/** Base where-clause limiting a query to the request's tenant. */
function tenantWhere(req, extra = {}) {
  return { businessId: tenantOf(req), ...extra };
}

/** True when the requester is a platform admin (no tenant binding). */
function isPlatformAdmin(req) {
  return Boolean(req?.user && req.user.role === 'ADMIN' && !req.user.businessId);
}

/**
 * Middleware for platform-admin-only routes (tenant roster management).
 * Must run after `protect`.
 */
function platformAdminOnly(req, res, next) {
  if (!req.user) return next(require('../lib/errors').unauthorized('Authentication required'));
  if (!isPlatformAdmin(req)) {
    return next(require('../lib/errors').forbidden('Platform administrator access required'));
  }
  next();
}

/**
 * Middleware factory: allows the request only when the target row belongs to
 * the caller's tenant. Usage inside a handler:
 *   const row = await prisma.customer.findFirst({ where: tenantWhere(req, { id }) });
 */
module.exports = { DEFAULT_TENANT, tenantOf, scopeTenant, tenantWhere, isPlatformAdmin, platformAdminOnly };
