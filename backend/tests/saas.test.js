require('dotenv').config();
const assert=require('assert'); const app=require('../src/app'); const prisma=require('../src/lib/prisma'); let base;
function c(){let bearer=null,csrf=null;const jar=new Map();return{bearer(t){bearer=t},async req(m,p,b){const h={};if(b!==undefined)h['Content-Type']='application/json';if(bearer)h.Authorization=`Bearer ${bearer}`;const cookie=[...jar].map(([k,v])=>`${k}=${v}`).join('; ');if(cookie)h.Cookie=cookie;if(csrf)h['x-csrf-token']=csrf;const r=await fetch(base+p,{method:m,headers:h,body:b===undefined?undefined:JSON.stringify(b)});for(const set of r.headers.getSetCookie?.()||[]){const pair=set.split(';')[0],i=pair.indexOf('=');const k=pair.slice(0,i),v=pair.slice(i+1);jar.set(k,v);if(k==='hvac_csrf')csrf=v}const text=await r.text();let body;try{body=JSON.parse(text)}catch{}return{status:r.status,body}},get(p){return this.req('GET',p)},post(p,b){return this.req('POST',p,b)},patch(p,b){return this.req('PATCH',p,b)}}}
async function main(){const server=app.listen(0);await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;const a=c();let bid,uid;try{let r=await a.get('/api/csrf-token');assert.strictEqual(r.status,200);r=await a.post('/api/auth/login',{email:'platform@ndsairconditioning.com',password:'Platform@12345'});assert.strictEqual(r.status,200,JSON.stringify(r.body));a.bearer(r.body.data.accessToken);r=await a.get('/api/saas/plans');assert.strictEqual(r.status,200);assert.ok(r.body.data.length>=1);assert.ok(r.body.data.every(x=>x.slug!=='nds'));const planId=r.body.data[0].id;const email=`saas-${Date.now()}@example.com`;r=await a.post('/api/saas/businesses',{name:`SaaS Regression ${Date.now()}`,planId,admin:{name:'Tenant Admin',email,password:'Tenant123'}});assert.strictEqual(r.status,201,JSON.stringify(r.body));bid=r.body.data.id;const u=await prisma.user.findUnique({where:{email}});uid=u.id;const tenant=c();r=await tenant.get('/api/csrf-token');assert.strictEqual(r.status,200);r=await tenant.post('/api/auth/login',{email,password:'Tenant123'});assert.strictEqual(r.status,200,JSON.stringify(r.body));tenant.bearer(r.body.data.accessToken);r=await tenant.get('/api/business/current');assert.strictEqual(r.status,200);assert.strictEqual(r.body.data.id,bid);await prisma.business.update({where:{id:bid},data:{status:'SUSPENDED'}});r=await tenant.get('/api/business/current');assert.strictEqual(r.status,403);console.log('SaaS regression: PASS')}catch(e){console.error('SaaS regression: FAIL',e.stack||e);process.exitCode=1}finally{try{if(bid){await prisma.activity.deleteMany({where:{businessId:bid}});await prisma.auditLog.deleteMany({where:{businessId:bid}});await prisma.subscription.deleteMany({where:{businessId:bid}});await prisma.user.deleteMany({where:{businessId:bid}});await prisma.business.delete({where:{id:bid}})}}catch{}server.close()}} main();


async function logoutRoleRegression(role, email, password) {
  const client = c();
  let r = await client.get('/api/csrf-token');
  assert.strictEqual(r.status, 200);
  r = await client.post('/api/auth/login', { email, password });
  assert.strictEqual(r.status, 200, `${role} login failed`);
  assert.strictEqual(r.body.data.user.role, role);
  const refreshToken = r.body.data.refreshToken;
  client.bearer(r.body.data.accessToken);
  r = await client.get('/api/auth/me');
  assert.strictEqual(r.status, 200);
  r = await client.post('/api/auth/logout', { refreshToken });
  assert.strictEqual(r.status, 200);
  r = await client.get('/api/auth/me');
  assert.strictEqual(r.status, 401, `${role} session remained usable after logout`);
  r = await client.post('/api/auth/refresh', { refreshToken });
  assert.strictEqual(r.status, 401, `${role} refresh token remained usable after logout`);
}

async function runAuthAndPlanRegression() {
  const platform = c();
  let createdPlanId;
  const createdUsers = [];
  const password = process.env.REGRESSION_TEST_PASSWORD;
  const platformEmail = process.env.SEED_PLATFORM_EMAIL;
  const platformPassword = process.env.SEED_PLATFORM_PASSWORD;
  assert.ok(password && platformEmail && platformPassword, 'Regression test credentials must be provided by the isolated test environment');
  try {
    let r = await platform.get('/api/csrf-token');
    assert.strictEqual(r.status, 200);
    r = await platform.post('/api/auth/login', { email: platformEmail, password: platformPassword });
    assert.strictEqual(r.status, 200);
    platform.bearer(r.body.data.accessToken);

    const stamp = Date.now();
    const slug = `regression-edit-${stamp}`;
    r = await platform.post('/api/saas/plans', {
      name: `Regression Edit ${stamp}`, slug, description: 'Before edit', price: 12,
      currency: 'USD', interval: 'month', features: { support: false }, limits: { users: 1 }, isActive: true,
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    createdPlanId = r.body.data.id;
    r = await platform.patch(`/api/saas/plans/${createdPlanId}`, {
      name: `Regression Edited ${stamp}`, slug: `${slug}-updated`, description: 'After edit', price: 29,
      currency: 'USD', interval: 'year', features: { support: true }, limits: { users: 10 }, isActive: false,
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.data.price, 29);
    assert.strictEqual(r.body.data.interval, 'year');
    assert.strictEqual(r.body.data.isActive, false);
    assert.strictEqual(r.body.data.features.support, true);
    assert.strictEqual(r.body.data.limits.users, 10);

    const bcrypt = require('bcryptjs');
    const suffix = Date.now();
    const users = [
      { role: 'TENANT_ADMIN', dbRole: 'ADMIN', email: `logout-tenant-${suffix}@example.com`, name: 'Logout Tenant' },
      { role: 'TECHNICIAN', dbRole: 'STAFF', email: `logout-tech-${suffix}@example.com`, name: 'Logout Technician' },
      { role: 'CUSTOMER', dbRole: 'CUSTOMER', email: `logout-customer-${suffix}@example.com`, name: 'Logout Customer' },
    ];
    const hash = await bcrypt.hash(password, 4);
    for (const spec of users) {
      const u = await prisma.user.create({ data: { name: spec.name, email: spec.email, passwordHash: hash, role: spec.dbRole, businessId: 'default', isActive: true } });
      createdUsers.push(u.id);
      await logoutRoleRegression(spec.role, spec.email, password);
    }
    console.log('Auth/plan regression: PASS');
  } finally {
    try { if (createdPlanId) await prisma.plan.delete({ where: { id: createdPlanId } }); } catch {}
    try { if (createdUsers.length) { await prisma.refreshToken.deleteMany({ where: { userId: { in: createdUsers } } }); await prisma.user.deleteMany({ where: { id: { in: createdUsers } } }); } } catch {}
  }
}

runAuthAndPlanRegression().catch((e) => { console.error('Auth/plan regression: FAIL', e.stack || e); process.exitCode = 1; });
