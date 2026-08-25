/**
 * Supplier Marketplace permissions.
 *
 * This EXTENDS the existing authorization system — it does not replace it.
 * Routes still run through `protect` (JWT + active user) and the role check is
 * still the platform's `User.role` (ADMIN | STAFF). What is added here is a
 * capability vocabulary so the marketplace can express finer intent, with a
 * role-based default policy that administrators can override from
 * Supplier Marketplace → Settings without touching code.
 */
const marketplaceSettings = require('../lib/suppliers/settings');
const { forbidden, unauthorized } = require('../lib/errors');

const PERMISSIONS = {
  'suppliers.view': { label: 'View suppliers', description: 'Read suppliers, integrations, catalogue, fulfilments and logs' },
  'suppliers.manage': { label: 'Manage suppliers', description: 'Create, edit, disable and archive suppliers' },
  'integrations.manage': { label: 'Manage integrations', description: 'Add, configure, connect, disconnect and delete supplier connectors' },
  'imports.manage': { label: 'Import products', description: 'Upload feeds, preview and commit catalogue imports' },
  'pricing.manage': { label: 'Edit supplier pricing', description: 'Change markup rules and price overrides' },
  'products.publish': { label: 'Publish products', description: 'Publish and unpublish supplier products to the storefront' },
  'fulfillment.manage': { label: 'Manage fulfillment', description: 'Submit, update, track and cancel supplier fulfilments' },
  'shipping.manage': { label: 'Manage shipping', description: 'Create and edit supplier shipping rules and restrictions' },
  'sync.manage': { label: 'Manage synchronization', description: 'Run, retry and cancel synchronisations and change the schedule' },
};

const PERMISSION_IDS = Object.keys(PERMISSIONS);

/** True when a granted list covers the requested permission. */
function granted(grants, permission) {
  const list = Array.isArray(grants) ? grants : [];
  return list.includes('*') || list.includes(permission);
}

/** The effective permission list for a role, including operator overrides. */
async function permissionsFor(role, tenantId = 'default') {
  const settings = await marketplaceSettings.read(tenantId);
  const policy = settings.permissions || {};
  if (Array.isArray(policy[role])) return policy[role];
  return marketplaceSettings.DEFAULTS.permissions[role] || [];
}

/** Express middleware: `router.get('/', protect, requirePermission('suppliers.view'), …)`. */
const requirePermission = (permission) => async (req, res, next) => {
  try {
    if (!req.user) return next(unauthorized('Authentication required'));
    if (!PERMISSIONS[permission]) return next(new Error(`Unknown supplier permission "${permission}"`));
    const grants = await permissionsFor(req.user.role, req.tenantId);
    if (!granted(grants, permission)) {
      return next(forbidden(`Your role does not include the "${PERMISSIONS[permission].label}" permission`));
    }
    req.supplierPermissions = grants;
    next();
  } catch (err) { next(err); }
};

/** Attaches the caller's marketplace permissions for UI-driven rendering. */
async function attach(req) {
  if (!req.user) return [];
  const grants = await permissionsFor(req.user.role, req.tenantId);
  req.supplierPermissions = grants;
  return grants;
}

const can = (grants, permission) => granted(grants, permission);

module.exports = { PERMISSIONS, PERMISSION_IDS, requirePermission, permissionsFor, granted, can, attach };
