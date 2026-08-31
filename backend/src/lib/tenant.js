/**
 * Multi-tenant scoping primitives.
 *
 * Every authenticated request is scoped to exactly one tenant (Business).
 * The scope is resolved SERVER-SIDE from the authenticated user record —
 * never from a client-supplied header or body field — so Tenant A can never
 * read or write Tenant B data by manipulating a request.
 */
const DEFAULT_TENANT = process.env.TENANT_ID || 'default';
function tenantOf(req) { if (req?.tenantId) return req.tenantId; if (req?.user?.businessId) return req.user.businessId; return DEFAULT_TENANT; }
function scopeTenant(req, res, next) { req.tenantId = tenantOf(req); next(); }
function tenantWhere(req, extra = {}) { return { ...extra, businessId: tenantOf(req) }; }
function roleForPlatform(user) { return user?.role === 'ADMIN' && !user?.businessId ? 'SUPER_ADMIN' : null; }
function isPlatformAdmin(req) { return Boolean(req?.user && roleForPlatform(req.user) === 'SUPER_ADMIN' && !req.user.businessId); }
function platformAdminOnly(req, res, next) { if (!req.user) return next(require('../lib/errors').unauthorized('Authentication required')); if (!isPlatformAdmin(req)) return next(require('../lib/errors').forbidden('Platform administrator access required')); next(); }
module.exports = { DEFAULT_TENANT, tenantOf, scopeTenant, tenantWhere, isPlatformAdmin, platformAdminOnly };
