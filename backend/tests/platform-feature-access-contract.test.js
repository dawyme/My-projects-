const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { normalizeFeatureKey, resolveFeatureAccess } = require('../src/lib/features');
const { TENANT_FEATURE_REGISTRY } = require('../src/lib/feature-registry');
function run() {
  assert.strictEqual(normalizeFeatureKey('Recurring Maintenance'), 'recurring-maintenance');
  const keys = TENANT_FEATURE_REGISTRY.map((f) => f.key);
  assert.strictEqual(new Set(keys).size, keys.length);
  assert(keys.includes('content-manager')); assert(keys.includes('media-library')); assert(keys.includes('service-requests')); assert(keys.includes('work-orders'));
  assert(TENANT_FEATURE_REGISTRY.every((f) => Array.isArray(f.routes) && Array.isArray(f.apiPrefixes)));
  const layout=fs.readFileSync(path.join(__dirname,'../../admin/js/layout.js'),'utf8');
  for(const f of TENANT_FEATURE_REGISTRY){ for(const route of f.routes||[]){ if(route==='/' || !layout.includes(`path: '${route}'`)) continue; assert(layout.includes(`feature: '${f.key}'`), `${route} missing feature key`); } }
  const app=fs.readFileSync(path.join(__dirname,'../src/app.js'),'utf8');
  // Every registry apiPrefix mounted in app.js must sit behind its feature's
  // central gate — no exceptions, including core features (their gate is a
  // documented no-op that keeps the mount truthful to the registry).
  for(const f of TENANT_FEATURE_REGISTRY){ for(const prefix of f.apiPrefixes||[]){ if(app.includes(`app.use('${prefix}'`)) assert(app.includes(`featureProtectedRoute('${f.key}')`), `${prefix} missing feature guard`); } }
  // Mounts that are NOT tenant-feature APIs and must stay outside
  // featureProtectedRoute (each has its own documented reason):
  //   /api/payments/webhook + /api/integrations/webhooks — unauthenticated
  //     provider receivers; providers cannot log in, so no tenant gate fits.
  //   /api/payments — mixed router: the storefront checkout is PUBLIC (no
  //     session), so the mount cannot be gated wholesale; instead the authed
  //     order operations inside it (capture/refund) carry the in-router
  //     requireFeature('orders') gate (asserted below).
  //   /api/auth — login/refresh/logout; no tenant session exists yet.
  //   /api/saas + /api/saas/features — platform-owner-only (platformAdminOnly).
  //   /api/features — the entitlement system itself (/access is protect-only
  //     by design; CRUD is platformAdminOnly inside the router).
  //   /api/audit-logs — role-based (adminOnly), not a Feature Management
  //     participant; tenant scope still enforced per row.
  //   /api/public — unauthenticated public website surface.
  //   /api/business + /api/businesses — own-tenant profile (protect) and the
  //     platform tenant roster (platformAdminOnly inside the router).
  //   /api/technician-portal + /api/customer-portal — separate role portals
  //     with their own authorize() gates, not tenant-admin features.
  // Deliberately NOT exempt: /api/tenant (core plans-subscription gate) and
  // /api/site-content (content-manager gate) — both must stay guarded.
  const exempt = new Set(['/api/payments/webhook','/api/integrations/webhooks','/api/payments','/api/auth','/api/saas','/api/saas/features','/api/features','/api/audit-logs','/api/public','/api/business','/api/businesses','/api/technician-portal','/api/customer-portal']);
  const apiMountLines = app.split('\n').filter((line) => line.includes("app.use('/api/"));
  for (const line of apiMountLines) {
    const m = line.match(/app\.use\('(\/api\/[^']+)'/);
    if (!m) continue;
    const prefix = m[1];
    if (!exempt.has(prefix)) assert(line.includes('featureProtectedRoute'), `${prefix} is not exempt and must be registered as a tenant feature`);
  }
  // The /api/payments mount stays exempt ONLY because the storefront checkout
  // is public — the authed order operations must still follow the central
  // `orders` entitlement via the in-router gate (no back door around a
  // disabled orders feature; SUPER_ADMIN bypasses centrally as always).
  const payments=fs.readFileSync(path.join(__dirname,'../src/routes/payments.js'),'utf8');
  assert.match(payments, /router\.post\('\/:orderId\/capture', protect, requireFeature\('orders'\)/, 'order payment capture must follow the central orders entitlement');
  assert.match(payments, /router\.post\('\/:orderId\/refund', protect, requireFeature\('orders'\)/, 'order refunds must follow the central orders entitlement');
  const feature={isActive:true,isCore:false,defaultEnabled:false};
  assert.strictEqual(resolveFeatureAccess({role:'SUPER_ADMIN',feature}),true);
  assert.strictEqual(resolveFeatureAccess({role:'TENANT_ADMIN',feature,access:null}),false);
  assert.strictEqual(resolveFeatureAccess({role:'TENANT_ADMIN',feature,access:{enabled:true}}),true);
  assert.strictEqual(resolveFeatureAccess({role:'TENANT_ADMIN',feature,access:{enabled:false}}),false);
  assert.strictEqual(resolveFeatureAccess({role:'TENANT_ADMIN',feature:{...feature,isCore:true},access:{enabled:false}}),true);
  // No-spillover at the resolver boundary, unit level: even a globally
  // deactivated feature (or an unknown one) never restricts the owner, while
  // customer tenants are denied. The live HTTP proof lives in
  // tenant-entitlement-enforcement.test.js.
  assert.strictEqual(resolveFeatureAccess({role:'SUPER_ADMIN',feature:{...feature,isActive:false},access:{enabled:false}}),true);
  assert.strictEqual(resolveFeatureAccess({role:'SUPER_ADMIN',feature:null,access:null}),true);
  assert.strictEqual(resolveFeatureAccess({role:'TENANT_ADMIN',feature:{...feature,isActive:false},access:{enabled:true}}),false);
  assert.strictEqual(resolveFeatureAccess({role:'TENANT_ADMIN',feature:null,access:null}),false);
  assert.strictEqual(resolveFeatureAccess({role:'TECHNICIAN',feature,access:{enabled:false}}),false);
  assert.strictEqual(resolveFeatureAccess({role:'TECHNICIAN',feature,access:{enabled:true}}),true);
  console.log('Tenant feature registry contracts: PASS');
}
run();
