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

const STATUSES = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

const transitions = {
  NEW: new Set(['ASSIGNED', 'IN_PROGRESS', 'CANCELLED']),
  ASSIGNED: new Set(['IN_PROGRESS', 'CANCELLED']),
  IN_PROGRESS: new Set(['COMPLETED', 'CANCELLED']),
  COMPLETED: new Set(),
  CANCELLED: new Set(),
};

const parseLines = (v) => { try { return v ? JSON.parse(v) : []; } catch { return []; } };
const decorate = (w) => ({
  ...w,
  labour: parseLines(w.labour),
  parts: parseLines(w.parts),
});

/** Tenant-scoped work-order fetch or 404. */
async function findWorkOrder(req, id, include) {
  const workOrder = await prisma.workOrder.findFirst({
    where: tenantWhere(req, { id }),
    include: include || {
      request: true,
      customer: { select: { id: true, name: true, email: true, phone: true, address: true } },
      equipment: true,
      technician: { select: { id: true, name: true, email: true } },
      booking: { select: { id: true, reference: true, scheduledAt: true, status: true } },
    },
  });
  if (!workOrder) throw notFound('Work order not found');
  return workOrder;
}

async function resolveTechnician(req, technicianId) {
  if (!technicianId) return null;
  const tech = await prisma.user.findFirst({
    where: { id: technicianId, isActive: true, OR: [{ businessId: req.tenantId }, { businessId: null }] },
  });
  if (!tech) throw badRequest('Technician not found or inactive');
  return tech;
}

// GET /api/work-orders
router.get('/', protect, validate(z.object({
  status: z.string().optional(),
  technicianId: z.string().optional(),
  customerId: z.string().optional(),
  search: z.string().optional(),
}).passthrough(), 'query'), asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const where = tenantWhere(req);
  if (q.status) where.status = { in: q.status.split(',').map((s) => s.trim().toUpperCase()).filter((s) => STATUSES.includes(s)) };
  if (q.technicianId) where.technicianId = q.technicianId === 'unassigned' ? null : q.technicianId;
  if (q.customerId) where.customerId = q.customerId;
  const orders = await prisma.workOrder.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: {
      request: { select: { id: true, serviceType: true, problem: true, priority: true, address: true } },
      customer: { select: { id: true, name: true, email: true, phone: true } },
      equipment: { select: { id: true, type: true, brand: true, model: true } },
      technician: { select: { id: true, name: true } },
      booking: { select: { id: true, reference: true, scheduledAt: true, status: true } },
    },
  });
  res.json({ success: true, data: orders.map(decorate) });
}));

// GET /api/work-orders/:id
router.get('/:id', protect, asyncHandler(async (req, res) => {
  const workOrder = await findWorkOrder(req, req.params.id);
  res.json({ success: true, data: decorate(workOrder) });
}));

// POST /api/work-orders/:id/assign — dispatch to a technician
router.post('/:id/assign', protect, authorize('ADMIN', 'STAFF'),
  validate(z.object({ technicianId: z.string().uuid().nullable() })),
  asyncHandler(async (req, res) => {
    const workOrder = await findWorkOrder(req, req.params.id);
    if (['COMPLETED', 'CANCELLED'].includes(workOrder.status)) {
      throw badRequest(`A ${workOrder.status.toLowerCase()} work order cannot be reassigned`);
    }
    if (req.body.technicianId) await resolveTechnician(req, req.body.technicianId);
    const updated = await prisma.workOrder.update({
      where: { id: workOrder.id },
      data: { technicianId: req.body.technicianId, status: req.body.technicianId ? 'ASSIGNED' : workOrder.status },
    });
    await audit(req, 'ASSIGN', 'WorkOrder', workOrder.id, { technicianId: req.body.technicianId });
    res.json({ success: true, data: decorate(updated) });
  }));

// POST /api/work-orders/:id/schedule — dispatch handoff to the booking calendar.
// Idempotent: the linked booking is created once and reused afterwards.
router.post('/:id/schedule', protect, authorize('ADMIN', 'STAFF'),
  validate(z.object({
    scheduledAt: z.coerce.date(),
    serviceId: z.string().uuid().nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })),
  asyncHandler(async (req, res) => {
    const workOrder = await findWorkOrder(req, req.params.id);
    if (['COMPLETED', 'CANCELLED'].includes(workOrder.status)) {
      throw badRequest(`A ${workOrder.status.toLowerCase()} work order cannot be scheduled`);
    }
    let service = null;
    if (req.body.serviceId) {
      service = await prisma.service.findFirst({ where: tenantWhere(req, { id: req.body.serviceId }) });
      if (!service) throw badRequest('Service not found');
    }

    const booking = await prisma.$transaction(async (tx) => {
      if (workOrder.bookingId) return tx.booking.findUnique({ where: { id: workOrder.bookingId } });
      const reference = `WO-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const created = await tx.booking.create({
        data: {
          businessId: req.tenantId,
          reference,
          customerId: workOrder.customerId,
          serviceId: service?.id || null,
          technicianId: workOrder.technicianId,
          scheduledAt: req.body.scheduledAt,
          status: 'CONFIRMED',
          priority: workOrder.priority,
          address: workOrder.request?.address || null,
          description: req.body.notes || (workOrder.request ? `${workOrder.request.serviceType}: ${workOrder.request.problem}` : null),
        },
      });
      await tx.workOrder.update({ where: { id: workOrder.id }, data: { bookingId: created.id, scheduledAt: req.body.scheduledAt } });
      return created;
    });

    await audit(req, 'SCHEDULE', 'WorkOrder', workOrder.id, { bookingId: booking.id, scheduledAt: req.body.scheduledAt });
    await activity(req.user.id, 'work-order', `${req.user.name} scheduled work order on ${booking.reference}`, undefined, req);
    const updated = await findWorkOrder(req, req.params.id);
    res.status(200).json({ success: true, data: decorate(updated), booking });
  }));

// POST /api/work-orders/:id/parts — bill parts from tenant inventory (atomic stock move)
const partsBody = z.object({
  productId: z.string().uuid(),
  quantity: z.coerce.number().int().min(1).max(999),
  unitPrice: z.coerce.number().min(0).optional(),
});
router.post('/:id/parts', protect, authorize('ADMIN', 'STAFF'), validate(partsBody), asyncHandler(async (req, res) => {
  const workOrder = await findWorkOrder(req, req.params.id);
  if (workOrder.status === 'COMPLETED') throw badRequest('Parts cannot be added to a completed work order');

  const product = await prisma.product.findFirst({ where: tenantWhere(req, { id: req.body.productId }) });
  if (!product) throw badRequest('Product not found');
  const unitPrice = req.body.unitPrice ?? product.price;

  const updated = await prisma.$transaction(async (tx) => {
    // Atomic stock guard: decrement only if enough owned units remain.
    const depleted = await tx.product.updateMany({
      where: { id: product.id, businessId: req.tenantId, quantity: { gte: req.body.quantity } },
      data: { quantity: { decrement: req.body.quantity } },
    });
    if (depleted.count === 0) throw badRequest(`Insufficient stock for ${product.name} (${product.quantity} available)`);

    await tx.inventoryAdjustment.create({
      data: {
        businessId: req.tenantId,
        productId: product.id,
        userId: req.user.id,
        change: -req.body.quantity,
        before: product.quantity,
        after: product.quantity - req.body.quantity,
        reason: `Work order parts ${req.params.id}`,
      },
    });

    const current = parseLines(workOrder.parts);
    const existingLine = current.find((l) => l.productId === product.id && l.unitPrice === unitPrice);
    if (existingLine) {
      existingLine.quantity += req.body.quantity;
      existingLine.amount = round(existingLine.quantity * existingLine.unitPrice);
    } else {
      current.push({
        productId: product.id,
        description: `${product.name} (${product.sku})`,
        quantity: req.body.quantity,
        unitPrice,
        amount: round(req.body.quantity * unitPrice),
      });
    }
    return tx.workOrder.update({ where: { id: workOrder.id }, data: { parts: JSON.stringify(current) } });
  });

  await audit(req, 'ADD_PARTS', 'WorkOrder', workOrder.id, { productId: product.id, quantity: req.body.quantity });
  res.json({ success: true, data: decorate(updated) });
}));

// POST /api/work-orders/:id/labour — billable labour lines
const labourBody = z.object({
  description: z.string().trim().min(2).max(300),
  hours: z.coerce.number().min(0.1).max(200),
  rate: z.coerce.number().min(0),
});
router.post('/:id/labour', protect, authorize('ADMIN', 'STAFF'), validate(labourBody), asyncHandler(async (req, res) => {
  const workOrder = await findWorkOrder(req, req.params.id);
  if (workOrder.status === 'COMPLETED') throw badRequest('Labour cannot be added to a completed work order');
  const current = parseLines(workOrder.labour);
  current.push({
    description: req.body.description,
    quantity: req.body.hours,
    unitPrice: req.body.rate,
    amount: round(req.body.hours * req.body.rate),
  });
  const updated = await prisma.workOrder.update({
    where: { id: workOrder.id },
    data: { labour: JSON.stringify(current) },
  });
  await audit(req, 'ADD_LABOUR', 'WorkOrder', workOrder.id, req.body);
  res.json({ success: true, data: decorate(updated) });
}));

// POST /api/work-orders/:id/status — explicit lifecycle guard
const statusBody = z.object({
  status: z.enum(STATUSES),
  completionNotes: z.string().trim().max(4000).optional(),
});
router.post('/:id/status', protect, authorize('ADMIN', 'STAFF'), validate(statusBody), asyncHandler(async (req, res) => {
  const workOrder = await findWorkOrder(req, req.params.id);
  const nextStatus = req.body.status;
  if (nextStatus === workOrder.status) {
    return res.json({ success: true, data: decorate(workOrder) });
  }
  if (!transitions[workOrder.status]?.has(nextStatus)) {
    throw badRequest(`Work order cannot transition from ${workOrder.status} to ${nextStatus}`);
  }
  if (nextStatus === 'COMPLETED') {
    if (!req.body.completionNotes || req.body.completionNotes.trim().length < 5) {
      throw badRequest('Completion requires work notes describing what was done');
    }
  }
  const updated = await prisma.workOrder.update({
    where: { id: workOrder.id },
    data: {
      status: nextStatus,
      completionNotes: nextStatus === 'COMPLETED' ? req.body.completionNotes : workOrder.completionNotes,
      completedAt: nextStatus === 'COMPLETED' ? new Date() : null,
    },
  });
  await audit(req, 'STATUS_CHANGE', 'WorkOrder', updated.id, { from: workOrder.status, to: updated.status });

  // Completion side-effects: service history for the equipment record.
  if (nextStatus === 'COMPLETED' && workOrder.equipmentId) {
    await prisma.serviceHistory.create({
      data: {
        businessId: req.tenantId,
        equipmentId: workOrder.equipmentId,
        serviceDate: new Date(),
        description: req.body.completionNotes || (workOrder.request ? workOrder.request.serviceType : 'Work order completed'),
        technicianId: workOrder.technicianId,
        notes: `Work order completed (${workOrder.id})`,
      },
    }).catch(() => {});
  }
  if (nextStatus === 'COMPLETED') {
    await activity(req.user.id, 'work-order', `${req.user.name} completed a work order`, undefined, req);
  }
  res.json({ success: true, data: decorate(updated) });
}));

// POST /api/work-orders/:id/invoice — hand labour + parts off to invoicing
router.post('/:id/invoice', protect, authorize('ADMIN', 'STAFF'),
  validate(z.object({ taxRate: z.coerce.number().min(0).max(100).default(0) })),
  asyncHandler(async (req, res) => {
    const workOrder = await findWorkOrder(req, req.params.id);
    if (workOrder.status !== 'COMPLETED') throw badRequest('Only a completed work order can be invoiced');

    const labour = parseLines(workOrder.labour);
    const parts = parseLines(workOrder.parts);
    if (!labour.length && !parts.length) throw badRequest('Add labour or parts before invoicing');

    const subtotal = round([...labour, ...parts].reduce((s, l) => s + (l.amount ?? (l.quantity || 0) * (l.unitPrice || 0)), 0));
    const tax = round(subtotal * ((req.body.taxRate || 0) / 100));
    const reference = `INV-WO-${workOrder.id.slice(0, 8).toUpperCase()}`;

    const invoice = await prisma.$transaction(async (tx) => {
      const dupe = await tx.invoice.findFirst({ where: { businessId: req.tenantId, reference } });
      if (dupe) return dupe;
      return tx.invoice.create({
        data: {
          businessId: req.tenantId,
          reference,
          customerId: workOrder.customerId,
          status: 'PENDING',
          subtotal,
          tax,
          total: round(subtotal + tax),
          labour: workOrder.labour,
          parts: workOrder.parts,
        },
      });
    });

    await audit(req, 'INVOICE', 'WorkOrder', workOrder.id, { invoiceId: invoice.id, total: invoice.total });
    await activity(req.user.id, 'invoice', `${req.user.name} invoiced a completed work order (${invoice.reference})`, undefined, req);
    res.status(201).json({ success: true, data: invoice });
  }));

module.exports = router;
