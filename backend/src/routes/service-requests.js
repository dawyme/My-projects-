const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect } = require('../middleware/auth');
const { notFound } = require('../lib/errors');
const { audit } = require('../lib/audit');

const router = express.Router();

const createBody = z.object({
  customerId: z.string().trim().min(1),
  serviceType: z.string().trim().min(1).max(120),
  problem: z.string().trim().min(1).max(4000),
  address: z.string().trim().min(1).max(300),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
});

const listQuery = z.object({
  status: z.enum(['NEW', 'REVIEWING', 'ACCEPTED', 'CONVERTED', 'CANCELLED']).optional(),
});

// GET /api/service-requests
router.get('/', protect, validate(listQuery, 'query'), asyncHandler(async (req, res) => {
  const where = req.validatedQuery.status ? { status: req.validatedQuery.status } : {};
  const requests = await prisma.serviceRequest.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: { customer: true },
  });
  res.json({ success: true, data: requests });
}));

// POST /api/service-requests
router.post('/', protect, validate(createBody), asyncHandler(async (req, res) => {
  const customer = await prisma.customer.findUnique({
    where: { id: req.body.customerId },
    select: { id: true },
  });
  if (!customer) throw notFound('Customer not found');

  const request = await prisma.serviceRequest.create({ data: req.body });
  await audit(req, 'CREATE', 'ServiceRequest', request.id, {
    customerId: request.customerId,
    serviceType: request.serviceType,
  });
  res.status(201).json({ success: true, data: request });
}));

// GET /api/service-requests/:id
router.get('/:id', protect, asyncHandler(async (req, res) => {
  const request = await prisma.serviceRequest.findUnique({
    where: { id: req.params.id },
    include: { customer: true, workOrder: true },
  });
  if (!request) throw notFound('Service request not found');
  res.json({ success: true, data: request });
}));

// POST /api/service-requests/:id/convert
router.post('/:id/convert', protect, asyncHandler(async (req, res) => {
  const result = await prisma.$transaction(async (tx) => {
    const request = await tx.serviceRequest.findUnique({ where: { id: req.params.id } });
    if (!request) throw notFound('Service request not found');

    const existing = await tx.workOrder.findUnique({ where: { requestId: request.id } });
    const workOrder = await tx.workOrder.upsert({
      where: { requestId: request.id },
      create: { requestId: request.id },
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
  }
  res.status(result.created ? 201 : 200).json({ success: true, data: result.workOrder });
}));

module.exports = router;
