const ROLE = Object.freeze({ CUSTOMER: 'CUSTOMER', TECHNICIAN: 'TECHNICIAN', TENANT_ADMIN: 'TENANT_ADMIN', SUPER_ADMIN: 'SUPER_ADMIN' });
const PERMISSIONS = Object.freeze({
  [ROLE.CUSTOMER]: Object.freeze(['profile.manage','bookings.create','bookings.read.own','equipment.read.own','estimates.read.own','invoices.read.own','notifications.read.own']),
  [ROLE.TECHNICIAN]: Object.freeze(['profile.manage','jobs.read','jobs.manage','dispatch.read','dispatch.manage','customers.read','equipment.read','work-orders.read','work-orders.manage','service-history.read','inventory.parts.read']),
  [ROLE.TENANT_ADMIN]: Object.freeze(['profile.manage','dashboard.read','customers.manage','bookings.manage','dispatch.manage','calendar.manage','service.manage','inventory.manage','pos.manage','invoices.manage','reports.read','users.manage','marketplace.manage','content.manage','settings.manage','audit.read']),
  [ROLE.SUPER_ADMIN]: Object.freeze(['profile.manage','dashboard.read','tenants.manage','users.manage','plans.manage','subscriptions.manage','billing.manage','marketplace.manage','analytics.read','audit.read','system-health.read','settings.manage']),
});
function roleFor(user) { if (!user) return null; if (user.role === 'ADMIN') return user.businessId ? ROLE.TENANT_ADMIN : ROLE.SUPER_ADMIN; if (user.role === 'STAFF') return ROLE.TECHNICIAN; if (Object.values(ROLE).includes(user.role)) return user.role; return null; }
function hasPermission(user, permission) { const role = roleFor(user); return Boolean(role && PERMISSIONS[role]?.includes(permission)); }
function permissionsFor(user) { const role = roleFor(user); return role ? PERMISSIONS[role] : []; }
module.exports = { ROLE, PERMISSIONS, roleFor, hasPermission, permissionsFor };
