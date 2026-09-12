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
  for(const f of TENANT_FEATURE_REGISTRY){ for(const prefix of f.apiPrefixes||[]){ if(prefix==='/api/tenant') continue; if(app.includes(`app.use('${prefix}'`)) assert(app.includes(`featureProtectedRoute('${f.key}')`), `${prefix} missing feature guard`); } }
  const exempt = new Set(['/api/payments/webhook','/api/payments','/api/auth','/api/saas','/api/saas/features','/api/features','/api/audit-logs','/api/public','/api/site-content','/api/business','/api/businesses','/api/tenant','/api/technician-portal','/api/customer-portal']);
  const apiMountLines = app.split('\n').filter((line) => line.includes("app.use('/api/"));
  for (const line of apiMountLines) {
    const m = line.match(/app\.use\('(\/api\/[^']+)'/);
    if (!m) continue;
    const prefix = m[1];
    if (!exempt.has(prefix)) assert(line.includes('featureProtectedRoute'), `${prefix} is not exempt and must be registered as a tenant feature`);
  }
  const feature={isActive:true,isCore:false,defaultEnabled:false};
  assert.strictEqual(resolveFeatureAccess({role:'SUPER_ADMIN',feature}),true);
  assert.strictEqual(resolveFeatureAccess({role:'TENANT_ADMIN',feature,access:null}),false);
  assert.strictEqual(resolveFeatureAccess({role:'TENANT_ADMIN',feature,access:{enabled:true}}),true);
  assert.strictEqual(resolveFeatureAccess({role:'TENANT_ADMIN',feature,access:{enabled:false}}),false);
  assert.strictEqual(resolveFeatureAccess({role:'TENANT_ADMIN',feature:{...feature,isCore:true},access:{enabled:false}}),true);
  console.log('Tenant feature registry contracts: PASS');
}
run();
