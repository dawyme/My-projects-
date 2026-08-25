const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect, adminOnly } = require('../middleware/auth');
const { badRequest, notFound } = require('../lib/errors');
const { tenantWhere } = require('../lib/tenant');
const { audit } = require('../lib/audit');

const router = express.Router();
const slugify = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

const body = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2000).optional().nullable(),
  basePrice: z.coerce.number().min(0).default(0),
  durationMin: z.coerce.number().int().min(15).max(1440).default(60),
  isActive: z.coerce.boolean().default(true),
});

router.get('/', protect, asyncHandler(async (req, res) => {
  const services = await prisma.service.findMany({
    where: tenantWhere(req), orderBy: { name: 'asc' }, include: { _count: { select: { bookings: true } } },
  });
  res.json({ success: true, data: services });
}));

router.post('/', protect, validate(body), asyncHandler(async (req, res) => {
  const slug = slugify(req.body.name);
  const clash = await prisma.service.findFirst({ where: tenantWhere(req, { slug }) });
  if (clash) throw badRequest('A service with that name already exists in this business');
  const service = await prisma.service.create({ data: { ...req.body, slug, businessId: req.tenantId } });
  await audit(req, 'CREATE', 'Service', service.id, { name: service.name });
  res.status(201).json({ success: true, data: service });
}));

router.put('/:id', protect, validate(body.partial()), asyncHandler(async (req, res) => {
  const existing = await prisma.service.findFirst({ where: tenantWhere(req, { id: req.params.id }) });
  if (!existing) throw notFound('Service not found');
  const data = { ...req.body };
  if (data.name) {
    data.slug = slugify(data.name);
    const clash = await prisma.service.findFirst({ where: tenantWhere(req, { slug: data.slug, NOT: { id: existing.id } }) });
    if (clash) throw badRequest('A service with that name already exists in this business');
  }
  const service = await prisma.service.update({ where: { id: existing.id }, data });
  await audit(req, 'UPDATE', 'Service', service.id, data);
  res.json({ success: true, data: service });
}));

router.delete('/:id', protect, adminOnly, asyncHandler(async (req, res) => {
  const existing = await prisma.service.findFirst({ where: tenantWhere(req, { id: req.params.id }) });
  if (!existing) throw notFound('Service not found');
  const count = await prisma.booking.count({ where: { businessId: req.tenantId, serviceId: existing.id } });
  if (count > 0) throw badRequest(`Service is used by ${count} booking(s); deactivate it instead.`);
  await prisma.service.delete({ where: { id: existing.id } });
  await audit(req, 'DELETE', 'Service', existing.id);
  res.json({ success: true, message: 'Service deleted' });
}));

module.exports = router;
