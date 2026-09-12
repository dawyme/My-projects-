const prisma = require('./prisma');
function normalizeRegistryKey(value) { return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80); }

// Authoritative registry for every feature that may be exposed to a tenant.
const TENANT_FEATURE_REGISTRY = [
  { key: 'dashboard', name: 'Dashboard', description: 'Business overview dashboard', category: 'Overview', defaultEnabled: true, core: true, routes: ['/'], apiPrefixes: ['/api/dashboard'] },
  { key: 'reports', name: 'Reports', description: 'Tenant business reports and analytics', category: 'Overview', defaultEnabled: true, routes: ['/analytics'], apiPrefixes: ['/api/analytics'] },
  { key: 'products', name: 'Products', description: 'Product catalogue management', category: 'Catalogue', defaultEnabled: true, routes: ['/products'], apiPrefixes: ['/api/products'] },
  { key: 'categories', name: 'Categories', description: 'Product category management', category: 'Catalogue', defaultEnabled: true, routes: ['/categories'], apiPrefixes: ['/api/categories'] },
  { key: 'inventory', name: 'Inventory', description: 'Stock and inventory management', category: 'Catalogue', defaultEnabled: true, routes: ['/inventory'], apiPrefixes: ['/api/inventory'] },
  { key: 'service-bookings', name: 'Service Bookings', description: 'Customer service bookings', category: 'Operations', defaultEnabled: true, routes: ['/bookings'], apiPrefixes: ['/api/bookings'] },
  { key: 'calendar', name: 'Calendar', description: 'Scheduling calendar', category: 'Operations', defaultEnabled: true, routes: ['/calendar'], apiPrefixes: [] },
  { key: 'dispatch', name: 'Dispatch Board', description: 'Technician dispatch and assignment', category: 'Operations', defaultEnabled: true, routes: ['/dispatch'], apiPrefixes: ['/api/dispatch'] },
  { key: 'services', name: 'Services', description: 'Service catalogue and pricing', category: 'Operations', defaultEnabled: true, routes: ['/services'], apiPrefixes: ['/api/services'] },
  { key: 'equipment', name: 'Equipment', description: 'Customer equipment records', category: 'Operations', defaultEnabled: true, routes: ['/equipment'], apiPrefixes: ['/api/equipment'] },
  { key: 'service-history', name: 'Service History', description: 'Completed service history', category: 'Operations', defaultEnabled: true, routes: ['/service-history'], apiPrefixes: ['/api/service-history'] },
  { key: 'recurring-maintenance', name: 'Recurring Maintenance', description: 'Recurring maintenance schedules', category: 'Operations', defaultEnabled: false, routes: ['/recurring-maintenance'], apiPrefixes: ['/api/recurring-maintenance'] },
  { key: 'estimates', name: 'Estimates', description: 'Quotes and estimates', category: 'Operations', defaultEnabled: true, routes: ['/estimates'], apiPrefixes: ['/api/estimates'] },
  { key: 'invoices', name: 'Invoices', description: 'Invoice management', category: 'Operations', defaultEnabled: true, routes: ['/invoices'], apiPrefixes: ['/api/invoices'] },
  { key: 'orders', name: 'Orders', description: 'Order management', category: 'Operations', defaultEnabled: true, routes: ['/orders'], apiPrefixes: ['/api/orders'] },
  { key: 'point-of-sale', name: 'Point of Sale', description: 'Point of sale operations', category: 'Operations', defaultEnabled: true, routes: ['/pos'], apiPrefixes: ['/api/pos'] },
  { key: 'customers', name: 'Customers', description: 'Customer records and management', category: 'People', defaultEnabled: true, routes: ['/customers'], apiPrefixes: ['/api/customers'] },
  { key: 'messages', name: 'Messages', description: 'Business communications inbox', category: 'People', defaultEnabled: true, routes: ['/messages'], apiPrefixes: ['/api/messages'] },
  { key: 'technicians', name: 'Technicians', description: 'Technician records and assignments', category: 'People', defaultEnabled: true, routes: [], apiPrefixes: ['/api/technicians'] },
  { key: 'notifications', name: 'Notifications & Reminders', description: 'Tenant reminders and notifications', category: 'People', defaultEnabled: true, routes: [], apiPrefixes: ['/api/reminders'] },
  { key: 'team', name: 'Team', description: 'Tenant staff management', category: 'Administration', defaultEnabled: true, routes: ['/users'], apiPrefixes: ['/api/users'] },
  { key: 'settings', name: 'Settings', description: 'Tenant business settings', category: 'Administration', defaultEnabled: true, routes: ['/settings'], apiPrefixes: ['/api/settings'] },
  { key: 'service-requests', name: 'Service Requests', description: 'Service request intake and conversion', category: 'Operations', defaultEnabled: true, routes: [], apiPrefixes: ['/api/service-requests'] },
  { key: 'work-orders', name: 'Work Orders', description: 'Work order lifecycle management', category: 'Operations', defaultEnabled: true, routes: [], apiPrefixes: ['/api/work-orders'] },
  { key: 'supplier-marketplace', name: 'Marketplace Dashboard', description: 'Supplier marketplace dashboard', category: 'Supplier Marketplace', defaultEnabled: true, routes: ['/supplier-marketplace'], apiPrefixes: [] },
  { key: 'suppliers', name: 'Suppliers', description: 'Supplier management', category: 'Supplier Marketplace', defaultEnabled: true, routes: ['/suppliers'], apiPrefixes: ['/api/suppliers'] },
  { key: 'supplier-integrations', name: 'Integrations / Plugins', description: 'Supplier integrations and plugins', category: 'Supplier Marketplace', defaultEnabled: true, routes: ['/supplier-integrations'], apiPrefixes: ['/api/supplier-integrations'] },
  { key: 'supplier-imports', name: 'Import Products', description: 'Supplier product imports', category: 'Supplier Marketplace', defaultEnabled: true, routes: ['/supplier-imports'], apiPrefixes: ['/api/supplier-imports'] },
  { key: 'supplier-products', name: 'Supplier Products', description: 'Supplier product catalogue', category: 'Supplier Marketplace', defaultEnabled: true, routes: ['/supplier-products'], apiPrefixes: ['/api/supplier-products'] },
  { key: 'supplier-fulfillment', name: 'Fulfillment', description: 'Supplier fulfillment workflows', category: 'Supplier Marketplace', defaultEnabled: true, routes: ['/supplier-fulfillment'], apiPrefixes: ['/api/supplier-fulfillments'] },
  { key: 'supplier-shipping', name: 'Shipping', description: 'Supplier shipping management', category: 'Supplier Marketplace', defaultEnabled: true, routes: ['/supplier-shipping'], apiPrefixes: ['/api/supplier-shipping'] },
  { key: 'supplier-sync', name: 'Sync & Automation', description: 'Supplier synchronization and automation', category: 'Supplier Marketplace', defaultEnabled: true, routes: ['/supplier-sync'], apiPrefixes: ['/api/supplier-syncs'] },
  { key: 'supplier-logs', name: 'Sync Logs', description: 'Supplier synchronization logs', category: 'Supplier Marketplace', defaultEnabled: true, routes: ['/supplier-logs'], apiPrefixes: [] },
  { key: 'supplier-settings', name: 'Marketplace Settings', description: 'Supplier marketplace settings', category: 'Supplier Marketplace', defaultEnabled: true, routes: ['/supplier-settings'], apiPrefixes: ['/api/supplier-settings'] },
  { key: 'content-manager', name: 'Content Manager', description: 'Tenant website content management', category: 'Website', defaultEnabled: true, routes: ['/content'], apiPrefixes: ['/api/content', '/api/site-content'] },
  { key: 'media-library', name: 'Media Library', description: 'Tenant media asset library', category: 'Website', defaultEnabled: true, routes: ['/media'], apiPrefixes: ['/api/media'] },
  { key: 'plans-subscription', name: 'Plans & Subscription', description: 'Tenant subscription and billing portal', category: 'Platform', defaultEnabled: true, core: true, routes: ['/subscription'], apiPrefixes: ['/api/tenant'] },
];

const REGISTRY_BY_KEY = new Map(TENANT_FEATURE_REGISTRY.map((feature) => [feature.key, feature]));
function getTenantFeatureDefinition(key) { return REGISTRY_BY_KEY.get(normalizeRegistryKey(key)) || null; }
function getTenantFeatureDefinitions() { return TENANT_FEATURE_REGISTRY.slice(); }
let ensurePromise = null;
async function ensurePlatformFeatures() {
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
  for (const definition of TENANT_FEATURE_REGISTRY) {
    await prisma.platformFeature.upsert({
      where: { key: definition.key },
      create: { key: definition.key, name: definition.name, description: definition.description, isActive: true, isCore: definition.core === true, defaultEnabled: definition.defaultEnabled === true },
      update: { name: definition.name, description: definition.description },
    });
  }
  })().catch((error) => { ensurePromise = null; throw error; });
  return ensurePromise;
}
module.exports = { TENANT_FEATURE_REGISTRY, getTenantFeatureDefinition, getTenantFeatureDefinitions, ensurePlatformFeatures };
