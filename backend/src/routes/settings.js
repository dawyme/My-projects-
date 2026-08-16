const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect, adminOnly } = require('../middleware/auth');
const { upload, persistImage } = require('../middleware/upload');
const { badRequest } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { sendMail } = require('../lib/mailer');
const cache = require('../lib/cache');

const router = express.Router();

const DEFAULTS = {
  company: {
    name: 'N&D\'S Air Conditioning & Refrigeration Services',
    tagline: 'HVAC, Refrigeration & Automotive AC Specialists',
    email: 'info@ndsairconditioning.com',
    phone: '+1 (555) 010-2030',
    whatsapp: '+15550102030',
    address: '124 Industrial Way, Springfield',
    city: 'Springfield',
    country: 'United States',
    registrationNo: '',
    taxNo: '',
    logoUrl: '/assets/logo.png',
  },
  hours: {
    monday: '08:00-17:00', tuesday: '08:00-17:00', wednesday: '08:00-17:00',
    thursday: '08:00-17:00', friday: '08:00-17:00', saturday: '09:00-13:00', sunday: 'Closed',
    emergency247: true,
  },
  social: { facebook: '', instagram: '', twitter: '', linkedin: '', youtube: '', tiktok: '' },
  email: { fromName: 'N&D\'S Air Conditioning & Refrigeration Services', fromEmail: 'no-reply@ndsairconditioning.com', replyTo: 'info@ndsairconditioning.com', notifyBookings: true, notifyMessages: true },
  payment: {
    currency: 'USD', currencySymbol: '$', taxRate: 0,
    bankTransfer: true, bankTransferDetails: 'Bank transfer — please use your order reference as the payment memo.',
    cashOnDelivery: true,
    stripeEnabled: false, stripePublicKey: '',
    paypalEnabled: false, paypalClientId: '',
    wipayEnabled: false, tilopayEnabled: false,
  },
  seo: { title: 'N&D\'S Air Conditioning & Refrigeration Services | AC, Refrigeration & Automotive AC', description: 'Professional HVAC installation, refrigeration servicing and automotive AC repair. Parts, refrigerants and compressors in stock.', keywords: 'hvac, air conditioning, refrigeration, automotive ac, compressors, refrigerants', ogImage: '/assets/logo.png', googleAnalyticsId: '', indexable: true },
};

const SCHEMAS = {
  company: z.object({
    name: z.string().trim().min(2).max(120), tagline: z.string().trim().max(200).default(''),
    email: z.string().email(), phone: z.string().trim().max(40).default(''),
    whatsapp: z.string().trim().max(40).default(''), address: z.string().trim().max(300).default(''),
    city: z.string().trim().max(80).default(''), country: z.string().trim().max(80).default(''),
    registrationNo: z.string().trim().max(60).default(''), taxNo: z.string().trim().max(60).default(''),
    logoUrl: z.string().trim().max(400).default(''),
  }),
  hours: z.object({
    monday: z.string().max(40), tuesday: z.string().max(40), wednesday: z.string().max(40),
    thursday: z.string().max(40), friday: z.string().max(40), saturday: z.string().max(40),
    sunday: z.string().max(40), emergency247: z.coerce.boolean().default(false),
  }),
  social: z.object({
    facebook: z.string().trim().max(300).default(''), instagram: z.string().trim().max(300).default(''),
    twitter: z.string().trim().max(300).default(''), linkedin: z.string().trim().max(300).default(''),
    youtube: z.string().trim().max(300).default(''), tiktok: z.string().trim().max(300).default(''),
  }),
  email: z.object({
    fromName: z.string().trim().max(120), fromEmail: z.string().email(), replyTo: z.string().email(),
    notifyBookings: z.coerce.boolean().default(true), notifyMessages: z.coerce.boolean().default(true),
  }),
  payment: z.object({
    currency: z.string().trim().length(3), currencySymbol: z.string().trim().max(4),
    taxRate: z.coerce.number().min(0).max(100).default(0),
    bankTransfer: z.coerce.boolean().default(true),
    bankTransferDetails: z.string().trim().max(500).default(''),
    cashOnDelivery: z.coerce.boolean().default(true),
    stripeEnabled: z.coerce.boolean().default(false), stripePublicKey: z.string().trim().max(200).default(''),
    paypalEnabled: z.coerce.boolean().default(false), paypalClientId: z.string().trim().max(200).default(''),
    wipayEnabled: z.coerce.boolean().default(false), tilopayEnabled: z.coerce.boolean().default(false),
  }),
  seo: z.object({
    title: z.string().trim().max(180), description: z.string().trim().max(400),
    keywords: z.string().trim().max(400).default(''), ogImage: z.string().trim().max(400).default(''),
    googleAnalyticsId: z.string().trim().max(60).default(''), indexable: z.coerce.boolean().default(true),
  }),
};

async function readAll() {
  const rows = await prisma.setting.findMany();
  const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  const out = {};
  for (const key of Object.keys(DEFAULTS)) out[key] = { ...DEFAULTS[key], ...(stored[key] || {}) };
  return out;
}

// GET /api/settings
router.get('/', protect, asyncHandler(async (req, res) => {
  res.json({ success: true, data: await cache.wrap('settings:all', 15000, readAll) });
}));

// PUT /api/settings/:section
router.put('/:section', protect, adminOnly, asyncHandler(async (req, res) => {
  const section = req.params.section;
  const schema = SCHEMAS[section];
  if (!schema) throw badRequest(`Unknown settings section '${section}'`);
  const parsed = schema.safeParse({ ...DEFAULTS[section], ...req.body });
  if (!parsed.success) {
    throw badRequest('Validation failed', parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
  }
  await prisma.setting.upsert({
    where: { key: section },
    update: { value: JSON.stringify(parsed.data) },
    create: { key: section, value: JSON.stringify(parsed.data) },
  });
  cache.invalidate('settings');
  await audit(req, 'UPDATE_SETTINGS', 'Setting', section, parsed.data);
  res.json({ success: true, data: { [section]: parsed.data } });
}));

// POST /api/settings/logo
router.post('/logo', protect, adminOnly, upload.single('logo'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No logo uploaded (field name: logo)');
  const logoUrl = await persistImage(req.file);
  const current = await readAll();
  const value = { ...current.company, logoUrl };
  await prisma.setting.upsert({ where: { key: 'company' }, update: { value: JSON.stringify(value) }, create: { key: 'company', value: JSON.stringify(value) } });
  cache.invalidate('settings');
  await audit(req, 'UPLOAD_LOGO', 'Setting', 'company', { logoUrl });
  res.json({ success: true, data: { logoUrl } });
}));

// POST /api/settings/test-email
router.post('/test-email', protect, adminOnly, validate(z.object({ to: z.string().email() })), asyncHandler(async (req, res) => {
  const result = await sendMail({
    to: req.body.to,
    subject: 'N&D\'S Air Conditioning & Refrigeration Services — test email',
    text: 'This is a test email from your admin dashboard. Email delivery is configured correctly.',
  });
  await audit(req, 'TEST_EMAIL', 'Setting', 'email', { to: req.body.to });
  res.json({
    success: true,
    message: result.delivered ? 'Test email sent via SMTP' : 'SMTP is not configured — the message was written to backend/data/outbox.log',
    data: result,
  });
}));

module.exports = router;
module.exports.readAll = readAll;
