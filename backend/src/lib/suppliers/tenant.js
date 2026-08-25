/**
 * Tenant resolution for the Supplier Marketplace.
 *
 * The platform today is a single-business deployment: `User` carries no
 * business/tenant column, so there is exactly one tenant and every supplier
 * row is stamped with `default`. What this module provides is the seam:
 *
 *   • every marketplace table has a `tenantId` column, indexed and defaulted
 *   • every marketplace query filters by `tenantOf(req)`
 *   • no marketplace query is written without it
 *
 * When multi-tenancy is switched on (a `Business` model plus a `businessId`
 * on `User`, as sketched in pos-schema-v2.prisma), `tenantOf` is the ONLY
 * function that has to change — the queries and the UI already carry the
 * scope, so no supplier code needs rewriting and no cross-tenant read is
 * possible in the meantime.
 *
 * `TENANT_ID` lets a deployment pin the scope explicitly.
 */

/** The tenant the current request belongs to. */
function tenantOf(req) {
  if (req?.tenantId) return req.tenantId;
  if (req?.user?.tenantId) return req.user.tenantId;
  if (req?.user?.businessId) return req.user.businessId;
  return process.env.TENANT_ID || 'default';
}

/** Middleware form: `router.use(scopeTenant)` — sets req.tenantId once. */
function scopeTenant(req, res, next) {
  req.tenantId = tenantOf(req);
  next();
}

module.exports = { tenantOf, scopeTenant };
