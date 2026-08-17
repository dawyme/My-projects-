const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect } = require('../middleware/auth');
const { badRequest, notFound } = require('../lib/errors');
const { audit } = require('../lib/audit');

const router = express.Router();

const statusBody = z.object({
  status: z.enum(['NEW', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']),
});

const transitions = {
  NEW: new Set(['ASSIGNED', 'CANCELLED']),
  ASSIGNED: new Set(['IN_PROGRESS', 'CANCELLED']),
  IN_PROGRESS: new Set(['COMPLETED', 'CANCELLED']),
  COMPLETED: new Set(),
  CANCELLED: new Set(),
};

// POST /api/work-orders/:id/status
router.post('/:id/status', protect, validate(statusBody), asyncHandler(async (req, res) => {
  const workOrder = await prisma.workOrder.findUnique({ where: { id: req.params.id } });
  if (!workOrder) throw notFound('Work order not found');

  const nextStatus = req.body.status;
  if (nextStatus === workOrder.status) {
    return res.json({ success: true, data: workOrder });
  }
  if (!transitions[workOrder.status]?.has(nextStatus)) {
    throw badRequest(`Work order cannot transition from ${workOrder.status} to ${nextStatus}`);
  }

  const updated = await prisma.workOrder.update({
    where: { id: workOrder.id },
    data: { status: nextStatus },
  });
  await audit(req, 'STATUS_CHANGE', 'WorkOrder', updated.id, {
    from: workOrder.status,
    to: updated.status,
  });
  res.json({ success: true, data: updated });
}));

module.exports = router;
