const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { sendPublicBookingEmails, sendPublicContactEmails } = require('../lib/mailer');

const router = express.Router();

const SERVICE_MAP = {
  'ac-repair': 'AC Repair & Diagnostics',
  'ac-install': 'AC Installation',
  refrigeration: 'Refrigeration Servicing',
  'automotive-ac': 'Automotive AC Re-gas',
  maintenance: 'Preventive Maintenance',
  emergency: 'Emergency Callout',
};

const TIME_MAP = { '': '10:00', morning: '09:00', afternoon: '13:00', evening: '17:00' };

const contactBody = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(180).optional().or(z.literal('')),
  phone: z.string().trim().max(40).optional().nullable(),
  subject: z.string().trim().max(180).optional().nullable(),
  serviceType: z.string().trim().max(120).optional().nullable(),
  message: z.string().trim().min(1).max(5000),
});

const bookingBody = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(180).optional().or(z.literal('')),
  phone: z.string().trim().min(7).max(40),
  address: z.string().trim().max(300).optional().nullable(),
  serviceType: z.enum(Object.keys(SERVICE_MAP)),
  scheduledAt: z.coerce.date(),
  description: z.string().trim().max(2000).optional().nullable(),
  emergency: z.boolean().optional(),
});

function normalizeEmail(email) {
  return email ? String(email).trim().toLowerCase() : null;
}

async function resolveCustomer({ name, email, phone, address }) {
  if (email) {
    const existing = await prisma.customer.findUnique({ where: { email } });
    if (existing) {
      return prisma.customer.update({
        where: { id: existing.id },
        data: { name, phone: phone || existing.phone, address: address || existing.address },
      });
    }
  }
  if (!email) {
    const customer = await prisma.customer.findFirst({ where: { phone: phone || undefined } });
    if (customer) return customer;
  }
  return prisma.customer.create({
    data: { name, email: email || `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@invalid.local`, phone, address },
  });
}

router.get('/services', asyncHandler(async (_req, res) => {
  const services = await prisma.service.findMany({ where: { isActive: true }, select: { id: true, name: true, slug: true } });
  res.json({ success: true, data: services });
}));

router.post('/bookings', validate(bookingBody, 'body'), asyncHandler(async (req, res) => {
  const input = req.body;
  const email = normalizeEmail(input.email);
  const serviceName = SERVICE_MAP[input.serviceType];
  const service = await prisma.service.findFirst({ where: { name: serviceName, isActive: true } });
  if (!service) return res.status(503).json({ success: false, error: 'Service catalog is not ready. Please call us.' });

  const customer = await resolveCustomer({ ...input, email });
  const scheduledAt = new Date(input.scheduledAt);
  const timeHint = Object.entries(TIME_MAP).find(([, v]) => v === scheduledAt.toISOString().slice(11, 16));
  const description = [
    input.emergency ? '[EMERGENCY]' : null,
    input.description || null,
    timeHint ? `Preferred time: ${timeHint[0] || 'Any time'}` : null,
  ].filter(Boolean).join('\n');

  const booking = await prisma.booking.create({
    data: {
      reference: `BK-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      customerId: customer.id,
      serviceId: service.id,
      scheduledAt,
      status: 'PENDING',
      priority: input.emergency ? 'URGENT' : 'NORMAL',
      address: input.address || customer.address || null,
      description: description || `${service.name} requested via website.`,
      price: service.basePrice || 0,
    },
    include: { customer: true, service: true },
  });

  sendPublicBookingEmails(booking, customer, serviceName).catch(() => {});
  res.status(201).json({ success: true, message: 'Booking request received.', data: booking });
}));

router.post('/contact', validate(contactBody, 'body'), asyncHandler(async (req, res) => {
  const input = req.body;
  const email = normalizeEmail(input.email);
  const serviceType = input.serviceType || 'General Inquiry';
  const subject = input.subject || `${serviceType} enquiry`;
  const body = `Service Type: ${serviceType}\n\n${input.message}`;
  const customer = email ? await resolveCustomer({ name: input.name, email, phone: input.phone, address: null }) : null;
  const message = await prisma.contactMessage.create({
    data: { name: input.name, email: email || 'no-email@invalid.local', phone: input.phone || null, subject, body, customerId: customer?.id || null },
  });

  sendPublicContactEmails(message, serviceType).catch(() => {});
  res.status(201).json({ success: true, message: 'Message received. We will get back to you shortly.', data: { id: message.id } });
}));

module.exports = router;
