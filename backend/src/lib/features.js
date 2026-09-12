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

function resolveFeatureAccess({ role, feature, access }) {
  if (!feature || !feature.isActive) return false;
  if (role === 'SUPER_ADMIN') return true;
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
  const features = await prisma.platformFeature.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
  if (role === 'SUPER_ADMIN') return features;
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
