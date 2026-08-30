const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect } = require('../middleware/auth');
const { platformAdminOnly } = require('../lib/tenant');
const { badRequest, notFound, conflict } = require('../lib/errors');
const { audit } = require('../lib/audit');
const bcrypt = require('bcryptjs');

const router = express.Router();
const planSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(60),
  description: z.string().trim().max(300).nullable().optional(),
  price: z.number().min(0), currency: z.string().trim().length(3).toUpperCase(),
  interval: z.enum(['month','year']), features: z.record(z.boolean()).default({}),
  limits: z.record(z.number().int().nonnegative()).default({}), isActive: z.boolean().default(true),
});
const businessSchema = z.object({
  name: z.string().trim().min(2).max(160), slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(60).optional(),
  phone: z.string().trim().max(40).nullable().optional(), email: z.string().email().nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(), currency: z.string().length(3).toUpperCase().default('USD'), taxRate: z.number().min(0).max(1).default(0),
  planId: z.string().min(1), admin: z.object({ name: z.string().trim().min(2).max(120), email: z.string().email(), password: z.string().min(8).max(200).regex(/[A-Za-z]/).regex(/[0-9]/) }),
});
const subscriptionSchema = z.object({ planId: z.string().min(1), status: z.enum(['TRIAL','ACTIVE','PAST_DUE','SUSPENDED','CANCELLED']), trialEndsAt: z.string().datetime().nullable().optional(), cancelAtPeriodEnd: z.boolean().optional() });
const publicPlan = (p) => ({ id:p.id,name:p.name,slug:p.slug,description:p.description,price:p.price,currency:p.currency,interval:p.interval,features:JSON.parse(p.features||'{}'),limits:JSON.parse(p.limits||'{}'),isActive:p.isActive });
const publicBusiness = (b) => ({ id:b.id,name:b.name,slug:b.slug,status:b.status,currency:b.currency,taxRate:b.taxRate,createdAt:b.createdAt,counts:b._count||null,subscription:b.subscription ? { ...b.subscription, plan:b.subscription.plan ? publicPlan(b.subscription.plan):null } : null });

router.use(protect, platformAdminOnly);

router.get('/overview', asyncHandler(async (req,res)=>{
  const [businesses,active,trial,suspended] = await Promise.all([prisma.business.count(),prisma.subscription.count({where:{status:'ACTIVE'}}),prisma.subscription.count({where:{status:'TRIAL'}}),prisma.business.count({where:{status:'SUSPENDED'}})]);
  res.json({success:true,data:{businesses,activeSubscriptions:active,trials:trial,suspendedBusinesses:suspended}});
}));

router.get('/plans', asyncHandler(async (req,res)=>{ const plans=await prisma.plan.findMany({orderBy:{price:'asc'}}); res.json({success:true,data:plans.map(publicPlan)}); }));

router.post('/plans', validate(planSchema), asyncHandler(async(req,res)=>{
  const exists=await prisma.plan.findFirst({where:{OR:[{slug:req.body.slug},{name:req.body.name}]}}); if(exists) throw conflict('A plan with that name or slug already exists');
  const p=await prisma.plan.create({data:{...req.body,features:JSON.stringify(req.body.features),limits:JSON.stringify(req.body.limits)}}); await audit(req,'CREATE','Plan',p.id,{slug:p.slug}); res.status(201).json({success:true,data:publicPlan(p)});
}));

router.get('/businesses', asyncHandler(async(req,res)=>{
  const rows=await prisma.business.findMany({orderBy:{createdAt:'asc'},include:{subscription:{include:{plan:true}},_count:{select:{users:true,customers:true,products:true,bookings:true,orders:true}}}});
  res.json({success:true,data:rows.map(publicBusiness)});
}));

router.post('/businesses', validate(businessSchema), asyncHandler(async(req,res)=>{
  const {admin,planId,...payload}=req.body; const plan=await prisma.plan.findFirst({where:{id:planId,isActive:true}}); if(!plan) throw badRequest('Active plan not found');
  const slug=payload.slug || payload.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60);
  if(!slug) throw badRequest('A valid business slug is required');
  const existing=await prisma.business.findFirst({where:{OR:[{slug},{name:payload.name}]}}); if(existing) throw conflict('A business with that name or slug already exists');
  const email=admin.email.toLowerCase(); if(await prisma.user.findUnique({where:{email}})) throw conflict('A user with that email already exists');
  const hash=await bcrypt.hash(admin.password,12);
  const business=await prisma.$transaction(async(tx)=>{
    const b=await tx.business.create({data:{...payload,slug,users:{create:{name:admin.name,email,passwordHash:hash,role:'ADMIN'}}}});
    await tx.subscription.create({data:{businessId:b.id,planId:plan.id,status:'TRIAL',trialEndsAt:new Date(Date.now()+14*86400000)}});
    return tx.business.findUnique({where:{id:b.id},include:{subscription:{include:{plan:true}},_count:{select:{users:true,customers:true,products:true,bookings:true,orders:true}}}});
  });
  await audit(req,'CREATE','Business',business.id,{slug,planId:plan.id}); res.status(201).json({success:true,data:publicBusiness(business)});
}));

router.patch('/businesses/:id/subscription', validate(subscriptionSchema), asyncHandler(async(req,res)=>{
  const business=await prisma.business.findUnique({where:{id:req.params.id},include:{subscription:true}}); if(!business) throw notFound('Business not found');
  const plan=await prisma.plan.findFirst({where:{id:req.body.planId,isActive:true}}); if(!plan) throw badRequest('Active plan not found');
  const subscription=await prisma.subscription.upsert({where:{businessId:business.id},update:{...req.body,trialEndsAt:req.body.trialEndsAt?new Date(req.body.trialEndsAt):null},create:{businessId:business.id,planId:plan.id,status:req.body.status,trialEndsAt:req.body.trialEndsAt?new Date(req.body.trialEndsAt):null,cancelAtPeriodEnd:req.body.cancelAtPeriodEnd||false},include:{plan:true}});
  if(req.body.status==='SUSPENDED') await prisma.business.update({where:{id:business.id},data:{status:'SUSPENDED'}});
  if(req.body.status==='ACTIVE' || req.body.status==='TRIAL') await prisma.business.update({where:{id:business.id},data:{status:'ACTIVE'}});
  await audit(req,'UPDATE','Subscription',subscription.id,{businessId:business.id,status:subscription.status,planId:subscription.planId}); res.json({success:true,data:subscription});
}));

module.exports=router;
