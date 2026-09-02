const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect, authorize } = require('../middleware/auth');
const { tenantWhere } = require('../lib/tenant');
const { badRequest, notFound } = require('../lib/errors');
const { audit, activity } = require('../lib/audit');

const router = express.Router();

const STATUSES = ['NEW', 'REVIEWING', 'ACCEPTED', 'CONVERTED', 'CANCELLED'];

const createBody = z.object({
  customerId: z.string().trim().min(1),
  equipmentId: z.string().uuid().nullable().optional(),
  serviceId: z.string().uuid().nullable().optional(),
  serviceType: z.string().trim().min(1).max(120),
  problem: z.string().trim().min(1).max(4000),
  address: z.string().trim().min(1).max(300),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
});

const listQuery = z.object({
  status: z.string().optional(),
  customerId: z.string().optional(),
  priority: z.string().optional(),
  search: z.string().optional(),
});

/** Validates that referenced parent rows belong to the caller's tenant. */
async function resolveReferences(req, { customerId, equipmentId, serviceId }) {
  const customer = await prisma.customer.findFirst({ where: tenantWhere(req, { id: customerId }), select: { id: true } });
  if (!customer) throw notFound('Customer not found');
  if (equipmentId) {
    const equipment = await prisma.equipment.findFirst({ where: tenantWhere(req, { id: equipmentId }), select: { id: true } });
    if (!equipment) throw badRequest('Equipment not found');
  }
  if (serviceId) {
    const service = await prisma.service.findFirst({ where: tenantWhere(req, { id: serviceId }), select: { id: true } });
    if (!service) throw badRequest('Service not found');
  }
}

// GET /api/service-requests
router.get('/', protect, validate(listQuery, 'query'), asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const where = tenantWhere(req);
  if (q.status) where.status = { in: q.status.split(',').map((s) => s.trim().toUpperCase()).filter((s) => STATUSES.includes(s)) };
  if (q.customerId) where.customerId = q.customerId;
  if (q.priority) where.priority = { in: q.priority.split(',').map((s) => s.trim().toUpperCase()) };
  if (q.search) {
    where.OR = [
      { serviceType: { contains: q.search } }, { problem: { contains: q.search } },
      { address: { contains: q.search } }, { customer: { name: { contains: q.search } } },
    ];
  }
  const requests = await prisma.serviceRequest.findMany({
    where,
    orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
    include: {
      customer: { select: { id: true, name: true, email: true, phone: true } },
      equipment: { select: { id: true, type: true, brand: true, model: true } },
      workOrder: { select: { id: true, status: true } },
    },
  });
  res.json({ success: true, data: requests });
}));

// POST /api/service-requests
router.post('/', protect, validate(createBody), asyncHandler(async (req, res) => {
  await resolveReferences(req, req.body);
  const request = await prisma.serviceRequest.create({ data: { ...req.body, businessId: req.tenantId } });
  await audit(req, 'CREATE', 'ServiceRequest', request.id, {
    customerId: request.customerId,
    serviceType: request.serviceType,
  });
  await activity(req.user.id, 'service-request', `${req.user.name} logged a service request (${request.serviceType})`, undefined, req);
  res.status(201).json({ success: true, data: request });
}));

// GET /api/service-requests/:id
router.get('/:id', protect, asyncHandler(async (req, res) => {
  const request = await prisma.serviceRequest.findFirst({
    where: tenantWhere(req, { id: req.params.id }),
    include: {
      customer: true,
      equipment: true,
      workOrder: true,
    },
  });
  if (!request) throw notFound('Service request not found');
  res.json({ success: true, data: request });
}));

// PATCH /api/service-requests/:id/status — intake review workflow
router.patch('/:id/status', protect, authorize('ADMIN', 'STAFF'),
  validate(z.object({ status: z.enum(STATUSES) })),
  asyncHandler(async (req, res) => {
    const request = await prisma.serviceRequest.findFirst({ where: tenantWhere(req, { id: req.params.id }) });
    if (!request) throw notFound('Service request not found');

    const next = req.body.status;
    const allowed = {
      NEW: ['REVIEWING', 'ACCEPTED', 'CANCELLED'],
      REVIEWING: ['ACCEPTED', 'CANCELLED'],
      ACCEPTED: ['CONVERTED', 'CANCELLED'],
      CONVERTED: [],
      CANCELLED: [],
    };
    if (next === request.status) {
      return res.json({ success: true, data: request });
    }
    if (!allowed[request.status]?.includes(next)) {
      throw badRequest(`Service request cannot transition from ${request.status} to ${next}`);
    }
    const updated = await prisma.serviceRequest.update({ where: { id: request.id }, data: { status: next } });
    await audit(req, 'STATUS_CHANGE', 'ServiceRequest', request.id, { from: request.status, to: next });
    res.json({ success: true, data: updated });
  }));

// POST /api/service-requests/:id/convert — creates exactly one work order
router.post('/:id/convert', protect, authorize('ADMIN', 'STAFF'), asyncHandler(async (req, res) => {
  const result = await prisma.$transaction(async (tx) => {
    const request = await tx.serviceRequest.findFirst({
      where: { id: req.params.id, businessId: req.tenantId },
    });
    if (!request) throw notFound('Service request not found');

    const existing = await tx.workOrder.findUnique({ where: { requestId: request.id } });
    const workOrder = await tx.workOrder.upsert({
      where: { requestId: request.id },
      create: {
        requestId: request.id,
        businessId: req.tenantId,
        customerId: request.customerId,
        equipmentId: request.equipmentId,
        priority: request.priority,
      },
      update: {},
    });
    if (request.status !== 'CONVERTED') {
      await tx.serviceRequest.update({
        where: { id: request.id },
        data: { status: 'CONVERTED' },
      });
    }
    return { workOrder, created: !existing };
  });

  if (result.created) {
    await audit(req, 'CONVERT', 'ServiceRequest', req.params.id, { workOrderId: result.workOrder.id });
    await activity(req.user.id, 'work-order', `${req.user.name} converted a service request into a work order`, undefined, req);
  }
  res.status(result.created ? 201 : 200).json({ success: true, data: result.workOrder });
}));

module.exports = router;
