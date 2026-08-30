require('dotenv').config();
const assert = require('assert');
const app = require('../src/app');
const prisma = require('../src/lib/prisma');

let base;
function client(){const jar=new Map();let csrf=null,bearer=null;return{setBearer(t){bearer=t},async req(method,path,body){const headers={};if(body!==undefined)headers['Content-Type']='application/json';const cookie=[...jar].map(([k,v])=>`${k}=${v}`).join('; ');if(cookie)headers.Cookie=cookie;if(csrf)headers['x-csrf-token']=csrf;if(bearer)headers.Authorization=`Bearer ${bearer}`;const r=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});for(const c of r.headers.getSetCookie?.()||[]){const pair=c.split(';')[0],i=pair.indexOf('=');jar.set(pair.slice(0,i),pair.slice(i+1));if(pair.startsWith('hvac_csrf='))csrf=pair.slice('hvac_csrf='.length)}const text=await r.text();let json=null;try{json=JSON.parse(text)}catch{}return{status:r.status,body:json,text}},get(p){return this.req('GET',p)},post(p,b){return this.req('POST',p,b)},patch(p,b){return this.req('PATCH',p,b)}}}
async function main(){const server=app.listen(0);await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;const admin=client();let productId,customerId,saleId,secondBusinessId;
try{
 let r=await admin.get('/api/csrf-token');assert.strictEqual(r.status,200);
 r=await admin.post('/api/auth/login',{email:'admin@ndsairconditioning.com',password:'Admin@12345'});assert.strictEqual(r.status,200,JSON.stringify(r.body));admin.setBearer(r.body.data.accessToken);
 r=await admin.get('/api/categories?limit=1');assert.strictEqual(r.status,200);const categoryId=r.body.data[0].id;
 r=await admin.post('/api/products',{sku:`POS-${Date.now()}`,name:'POS Regression Product',categoryId,price:125,costPrice:60,quantity:10,lowStockLevel:2});assert.strictEqual(r.status,201);productId=r.body.data.id;
 r=await admin.post('/api/customers',{name:'POS Regression Customer',email:`pos-${Date.now()}@example.com`,phone:'+1868 000 0000'});assert.strictEqual(r.status,201);customerId=r.body.data.id;
 r=await admin.post('/api/pos/sales',{customerId,items:[{productId,quantity:2}],discount:5,taxRate:12.5,paymentMethod:'CASH',location:'shop'});assert.strictEqual(r.status,201,JSON.stringify(r.body));saleId=r.body.data.id;assert.strictEqual(r.body.data.businessId,'default');assert.strictEqual(r.body.data.subtotal,250);assert.strictEqual(r.body.data.discount,5);assert.strictEqual(r.body.data.total,275.63);r=await admin.get(`/api/products/${productId}`);assert.strictEqual(r.body.data.quantity,8);
 const saleLineItemId = r.body.data.lineItems[0].id;
 r=await admin.post('/api/pos/refunds',{saleId,items:[{saleLineItemId,quantity:1}],reason:'Regression test'});assert.strictEqual(r.status,201,JSON.stringify(r.body));
 r=await admin.get(`/api/pos/sales/${saleId}`);assert.strictEqual(r.status,200);assert.strictEqual(r.body.data.status,'PARTIALLY_REFUNDED');assert.strictEqual(r.body.data.lineItems[0].refundedQty,1);
 // Cross-tenant isolation: a second tenant's product must never appear in tenant A POS search.
 secondBusinessId=`pos-test-${Date.now()}`;await prisma.business.create({data:{id:secondBusinessId,name:'POS Isolation Tenant',slug:secondBusinessId,currency:'TTD'}});const c2=await prisma.category.create({data:{businessId:secondBusinessId,name:'Isolation',slug:'isolation'}});const p2=await prisma.product.create({data:{businessId:secondBusinessId,sku:`ISO-${Date.now()}`,name:'Secret Tenant Product',slug:`secret-${Date.now()}`,categoryId:c2.id,price:999,quantity:50}});r=await admin.get('/api/pos/products?q=Secret%20Tenant%20Product');assert.strictEqual(r.status,200);assert.strictEqual(r.body.data.some(p=>p.id===p2.id),false);
 r=await admin.get(`/api/pos/sales/${saleId}`);assert.strictEqual(r.body.data.businessId,'default');console.log('POS regression: PASS');
}catch(e){console.error('POS regression: FAIL',e.stack||e);process.exitCode=1}finally{try{if(saleId){await prisma.saleRefund.deleteMany({where:{saleId}});await prisma.sale.delete({where:{id:saleId}})}}catch{}try{if(productId)await prisma.product.delete({where:{id:productId}})}catch{}try{if(customerId)await prisma.customer.delete({where:{id:customerId}})}catch{}try{if(secondBusinessId)await prisma.business.delete({where:{id:secondBusinessId}})}catch{}server.close()}}
main();
