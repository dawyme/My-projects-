const prisma = require('./prisma');
const { roleFor } = require('./permissions');
const { forbidden } = require('./errors');
const { ensurePlatformFeatures, getTenantFeatureDefinition, getTenantFeatureDefinitions } = require('./feature-registry');

function normalizeFeatureKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

/**
 * Central tenant-entitlement resolver — the ONLY place that decides whether
 * a tenant-facing feature is available in a given access context.
 *
 * Evaluation order (identical for every feature, current and future):
 *   1. Platform-owner context (SUPER_ADMIN, businessId NULL) → ALWAYS true.
 *      Tenant switches, the global active flag and per-tenant rows govern
 *      customer tenants ONLY and must NEVER restrict SUPER_ADMIN / N&D'S.
 *      This first line is the no-spillover guarantee every consumer shares.
 *   2. Unknown or globally deactivated feature → false for customer tenants.
 *   3. Core platform features (dashboard, plans-subscription) → true.
 *   4. Explicit per-tenant row (Feature Management toggle) wins when present.
 *   5. Otherwise the feature's defaultEnabled decides (new-tenant default).
 *
 * Consumers: featureProtectedRoute (API mounts), requireFeature (in-router
 * endpoint gates such as order payment capture), accessibleFeatures (the
 * /api/features/access set that drives tenant nav + direct-route + dashboard
 * visibility). No consumer may reimplement or shortcut this function.
 */
function resolveFeatureAccess({ role, feature, access }) {
  // Platform owners are NEVER restricted by Feature Management. Tenant
  // switches govern customer tenants only; SUPER_ADMIN permissions gate
  // owner operation (this is the central authorization boundary that every
  // featureProtectedRoute and /api/features/access consumer shares).
  if (role === 'SUPER_ADMIN') return true;
  if (!feature || !feature.isActive) return false;
  if (feature.isCore) return true;
  if (access && typeof access.enabled === 'boolean') return access.enabled;
  return feature.defaultEnabled === true;
}

async function featureForKey(key) {
  await ensurePlatformFeatures();
  return prisma.platformFeature.findUnique({ where: { key: normalizeFeatureKey(key) } });
}

async function accessibleFeatures(user) {
  await ensurePlatformFeatures();
  const role = roleFor(user);
  // The platform owner has every feature: tenant switches (and even the
  // global active flag) must never restrict SUPER_ADMIN. This endpoint is
  // what the admin shell uses for nav visibility, so owners always see the
  // full surface — enforced centrally, not per page.
  if (role === 'SUPER_ADMIN') return prisma.platformFeature.findMany({ orderBy: { name: 'asc' } });
  const features = await prisma.platformFeature.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
  if (!user?.businessId) return [];
  const access = await prisma.tenantFeatureAccess.findMany({ where: { businessId: user.businessId } });
  const byFeature = new Map(access.map((row) => [row.featureId, row]));
  return features.filter((feature) => resolveFeatureAccess({ role, feature, access: byFeature.get(feature.id) }));
}

function requireFeature(key) {
  const normalized = normalizeFeatureKey(key);
  return async (req, res, next) => {
    try {
      const feature = await featureForKey(normalized);
      const role = roleFor(req.user);
      const access = req.user?.businessId && feature
        ? await prisma.tenantFeatureAccess.findUnique({ where: { featureId_businessId: { featureId: feature.id, businessId: req.user.businessId } } })
        : null;
      if (!resolveFeatureAccess({ role, feature, access })) {
        return next(forbidden(`Feature '${normalized}' is not enabled for this tenant`));
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}


function featureProtectedRoute(key) { const definition = getTenantFeatureDefinition(key); if (!definition) throw new Error(`Tenant feature '${normalizeFeatureKey(key)}' is not registered`); return [require('./../middleware/auth').protect, requireFeature(definition.key)]; }

module.exports = { normalizeFeatureKey, resolveFeatureAccess, featureForKey, accessibleFeatures, requireFeature, featureProtectedRoute, getTenantFeatureDefinitions };
