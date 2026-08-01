const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect, adminOnly } = require('../middleware/auth');
const { upload, persistMedia } = require('../middleware/upload');
const { badRequest, notFound } = require('../lib/errors');
const { audit } = require('../lib/audit');
const cache = require('../lib/cache');

const router = express.Router();

/** Known editable website pages and their default titles / content. */
const PAGE_DEFAULTS = {
  homepage: {
    title: 'Homepage',
    content: {
      hero: { title: 'Expert HVAC, Refrigeration & Automotive AC Services', subtitle: 'Fast, reliable installation, repair and maintenance across Trinidad & Tobago.', ctaPrimary: { label: 'Book Service Now', url: '/booking.html' }, ctaSecondary: { label: 'Browse Products', url: '/products/index.html' }, ctaEmergency: { label: 'Call (868) 707-4646', url: 'tel:+18687074646' }, backgroundImage: '', backgroundVideo: '', stats: { experience: '10+ Years Experience', jobs: '5,200+ Jobs Completed', satisfaction: '98% Customer Satisfaction' } },
      featuredProductsTitle: 'Featured Products',
      featuredServicesTitle: 'Our Comprehensive Services',
      promoBanner: { enabled: false, title: '', subtitle: '', link: '', image: '' },
      emergencyBanner: { enabled: true, text: '24/7 Emergency Service Available — Call Now', link: 'tel:+18687074646' },
      cta: { title: 'Need Service Today?', subtitle: 'Book your appointment online or call our 24/7 emergency line.', primaryLabel: 'Book Appointment', primaryUrl: '/booking.html', emergencyLabel: 'Call Now', emergencyUrl: 'tel:+18687074646' },
    },
  },
  about: {
    title: 'About Us',
    content: {
      intro: 'Expert HVAC, refrigeration, and automotive AC services since 2008. Serving Trinidad & Tobago with pride.',
      description: 'N&D Air Conditioning and Refrigeration is a family-run business specialising in residential and commercial climate solutions.',
      mission: 'To deliver reliable, honest and high-quality heating, cooling and refrigeration services to every customer.',
      vision: 'To be the most trusted air conditioning and refrigeration company in Trinidad & Tobago.',
      experience: '10+',
      images: { hero: '', about: '', companyHistory: '' },
      certifications: [{ name: 'HVAC Certified Technician', issuer: '' }],
    },
  },
  services: {
    title: 'Services',
    content: { intro: 'Explore our full range of installation, repair and maintenance services.' },
  },
  'products-home': {
    title: 'Products Homepage Settings',
    content: { title: 'Featured Products', subtitle: 'Premium quality parts and equipment in stock.', showFeatured: true, showNewArrivals: true, productsPerRow: 4, featuredIds: [] },
  },
  gallery: {
    title: 'Gallery',
    content: { intro: 'A look at some of the projects we have completed.' },
  },
  testimonials: {
    title: 'Testimonials',
    content: { intro: 'What our customers say about our work.' },
  },
  faq: {
    title: 'FAQ',
    content: { intro: 'Frequently asked questions about our services.' },
  },
  contact: {
    title: 'Contact Information',
    content: {
      phones: ['+1 (868) 707-4646'],
      whatsapp: '+18687074646',
      email: 'ndsairconditioning@gmail.com',
      facebook: '', instagram: '', tiktok: '', youtube: '',
      mapEmbed: '',
      formRecipient: 'ndsairconditioning@gmail.com',
      address: 'Warden Road, East Street Extension, Stanisclause Circ Ave, Trinidad',
    },
  },
  hours: {
    title: 'Business Hours',
    content: { monday: '08:00-17:00', tuesday: '08:00-17:00', wednesday: '08:00-17:00', thursday: '08:00-17:00', friday: '08:00-17:00', saturday: '09:00-13:00', sunday: 'Closed', emergency247: true },
  },
  emergency: {
    title: 'Emergency Banner',
    content: { enabled: true, title: 'Emergency Service', text: 'We offer 24/7 emergency callout service for urgent breakdowns.', link: 'tel:+18687074646', linkLabel: 'Call Now' },
  },
  promotions: {
    title: 'Promotions',
    content: { enabled: true, intro: 'Current offers and seasonal deals.' },
  },
  footer: {
    title: 'Footer',
    content: {
      about: 'Expert HVAC, refrigeration, and automotive AC services since 2008. Serving Trinidad & Tobago with pride.',
      copyright: '© 2026 N&D\'s Air Conditioning and Refrigeration. All rights reserved.',
      serviceLinks: [{ label: 'AC Repair & Installation', url: '/services.html#ac-repair' }, { label: 'Commercial Refrigeration', url: '/services.html#refrigeration' }, { label: 'Automotive AC', url: '/services/automotive-ac.html' }, { label: 'Preventive Maintenance', url: '/services/preventive-maintenance.html' }, { label: 'Emergency Service', url: '/services/emergency-service.html' }],
      quickLinks: [{ label: 'Product Catalog', url: '/products/index.html' }, { label: 'About Us', url: '/about.html' }, { label: 'Project Gallery', url: '/gallery/index.html' }, { label: 'Customer Reviews', url: '/testimonials.html' }, { label: 'Book Service', url: '/booking.html' }],
      social: { facebook: '', instagram: '', tiktok: '', youtube: '' },
      contact: { phone: '+1 (868) 707-4646', email: 'ndsairconditioning@gmail.com', address: 'Warden Road, East Street Extension, Stanisclause Circ Ave, Trinidad', emergencyNote: '24/7 Emergency Service Available' },
    },
  },
  seo: {
    title: 'SEO',
    content: { globalTitle: 'N&D\'s Air Conditioning and Refrigeration | Expert HVAC, Refrigeration & Automotive AC in Trinidad & Tobago', globalDescription: 'Professional HVAC, refrigeration, and automotive air conditioning services. Expert repairs, installation, maintenance, and 24/7 emergency service across Trinidad & Tobago.', keywords: 'HVAC, air conditioning, refrigeration, automotive AC, AC repair, AC installation, maintenance, Trinidad, Tobago', ogImage: '/assets/logo.png', canonicalBase: 'https://www.ndsairconditioning.com', indexable: true, sitemapEnabled: true },
  },
  social: {
    title: 'Social Media',
    content: { facebook: '', instagram: '', tiktok: '', youtube: '', linkedin: '', twitter: '' },
  },
  logo: {
    title: 'Logo Manager',
    content: { logoUrl: '/assets/logo.png', faviconUrl: '/assets/logo.png', alt: 'N&D\'s Air Conditioning and Refrigeration' },
  },
  banners: {
    title: 'Banner/Image Manager',
    content: { heroImage: '', heroVideo: '', promoBannerImage: '', aboutImage: '', ctaBackground: '' },
  },
};

const SEO_SCHEMA = z.object({
  metaTitle: z.string().trim().max(200).optional().nullable(),
  metaDescription: z.string().trim().max(500).optional().nullable(),
  keywords: z.string().trim().max(500).optional().nullable(),
  ogImage: z.string().trim().max(400).optional().nullable(),
  canonicalUrl: z.string().trim().max(400).optional().nullable(),
  robots: z.string().trim().max(120).optional().nullable(),
});

function serialize(value) {
  return typeof value === 'string' ? value : JSON.stringify(value || {});
}

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
/** Deep-merges `extra` into a `base` structure so partial content always renders a complete form. */
function deepMerge(base, extra) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(extra || {})) {
    if (isObj(extra[k]) && isObj(out[k])) out[k] = deepMerge(out[k], extra[k]);
    else out[k] = extra[k];
  }
  return out;
}

async function ensurePage(key) {
  const def = PAGE_DEFAULTS[key];
  if (!def) return null;
  const existing = await prisma.contentPage.findUnique({ where: { key } });
  if (existing) return existing;
  return prisma.contentPage.create({
    data: {
      key,
      title: def.title,
      slug: key,
      content: serialize(def.content),
      status: 'DRAFT',
    },
  });
}

// GET /api/content — list all pages (ensures defaults exist)
router.get('/', protect, asyncHandler(async (req, res) => {
  await Promise.all(Object.keys(PAGE_DEFAULTS).map(ensurePage));
  const pages = await prisma.contentPage.findMany({
    orderBy: [{ title: 'asc' }],
    select: {
      id: true, key: true, title: true, status: true, publishedAt: true, updatedAt: true,
      metaTitle: true, metaDescription: true, robots: true,
    },
  });
  res.json({ success: true, data: pages });
}));

// GET /api/content/:key — get a single page (content + draft + seo)
router.get('/:key', protect, asyncHandler(async (req, res) => {
  const page = await ensurePage(req.params.key);
  if (!page) throw notFound(`Unknown content page '${req.params.key}'`);
  res.json({
    success: true,
    data: {
      key: page.key,
      title: page.title,
      status: page.status,
      publishedAt: page.publishedAt,
      updatedAt: page.updatedAt,
      content: deepMerge(PAGE_DEFAULTS[req.params.key].content, JSON.parse(page.content || '{}')),
      draft: page.draft ? JSON.parse(page.draft) : null,
      seo: {
        metaTitle: page.metaTitle, metaDescription: page.metaDescription,
        keywords: page.keywords, ogImage: page.ogImage,
        canonicalUrl: page.canonicalUrl, robots: page.robots,
      },
    },
  });
}));

const pageBody = z.object({
  content: z.record(z.any()).optional(),
  title: z.string().trim().max(200).optional(),
  seo: SEO_SCHEMA.optional(),
});

// PUT /api/content/:key — update working content (does not publish)
router.put('/:key', protect, validate(pageBody), asyncHandler(async (req, res) => {
  const page = await ensurePage(req.params.key);
  if (!page) throw notFound(`Unknown content page '${req.params.key}'`);
  const data = {};
  if (req.body.content !== undefined) data.content = serialize(req.body.content);
  if (req.body.title !== undefined) data.title = req.body.title;
  if (req.body.seo) {
    data.metaTitle = req.body.seo.metaTitle ?? null;
    data.metaDescription = req.body.seo.metaDescription ?? null;
    data.keywords = req.body.seo.keywords ?? null;
    data.ogImage = req.body.seo.ogImage ?? null;
    data.canonicalUrl = req.body.seo.canonicalUrl ?? null;
    data.robots = req.body.seo.robots ?? 'index,follow';
  }
  const updated = await prisma.contentPage.update({ where: { id: page.id }, data });
  cache.invalidate('public:content');
  await audit(req, 'UPDATE_CONTENT', 'ContentPage', updated.id, { key: updated.key });
  res.json({ success: true, data: { key: updated.key, status: updated.status, content: JSON.parse(updated.content) } });
}));

// POST /api/content/:key/autosave — persist an in-progress draft
router.post('/:key/autosave', protect, validate(z.object({ draft: z.record(z.any()) })), asyncHandler(async (req, res) => {
  const page = await ensurePage(req.params.key);
  if (!page) throw notFound(`Unknown content page '${req.params.key}'`);
  const updated = await prisma.contentPage.update({
    where: { id: page.id },
    data: { draft: serialize(req.body.draft) },
  });
  res.json({ success: true, data: { key: updated.key, draft: JSON.parse(updated.draft) }, message: 'Draft saved' });
}));

// POST /api/content/:key/publish — publish content (optionally from provided body)
router.post('/:key/publish', protect, adminOnly, validate(z.object({ content: z.record(z.any()).optional(), seo: SEO_SCHEMA.optional() }).optional()), asyncHandler(async (req, res) => {
  const page = await ensurePage(req.params.key);
  if (!page) throw notFound(`Unknown content page '${req.params.key}'`);
  const data = { status: 'PUBLISHED', publishedAt: new Date() };
  if (req.body?.content !== undefined) data.content = serialize(req.body.content);
  if (req.body?.seo) {
    data.metaTitle = req.body.seo.metaTitle ?? page.metaTitle;
    data.metaDescription = req.body.seo.metaDescription ?? page.metaDescription;
    data.keywords = req.body.seo.keywords ?? page.keywords;
    data.ogImage = req.body.seo.ogImage ?? page.ogImage;
    data.canonicalUrl = req.body.seo.canonicalUrl ?? page.canonicalUrl;
    data.robots = req.body.seo.robots ?? page.robots;
  }
  const updated = await prisma.contentPage.update({ where: { id: page.id }, data });
  cache.invalidate('public:content');
  await audit(req, 'PUBLISH_CONTENT', 'ContentPage', updated.id, { key: updated.key });
  res.json({ success: true, data: { key: updated.key, status: updated.status, publishedAt: updated.publishedAt }, message: 'Page published' });
}));

// POST /api/content/:key/draft — revert to draft
router.post('/:key/draft', protect, adminOnly, asyncHandler(async (req, res) => {
  const page = await ensurePage(req.params.key);
  if (!page) throw notFound(`Unknown content page '${req.params.key}'`);
  const updated = await prisma.contentPage.update({ where: { id: page.id }, data: { status: 'DRAFT' } });
  cache.invalidate('public:content');
  await audit(req, 'UNPUBLISH_CONTENT', 'ContentPage', updated.id, { key: updated.key });
  res.json({ success: true, data: { key: updated.key, status: updated.status } });
}));

// POST /api/content/:key/upload — upload an image associated with a page
router.post('/:key/upload', protect, upload.single('image'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No image uploaded (field name: image)');
  const page = await ensurePage(req.params.key);
  if (!page) throw notFound(`Unknown content page '${req.params.key}'`);
  const meta = await persistMedia(req.file, { folder: `/content/${req.params.key}` });
  const asset = await prisma.mediaAsset.create({ data: meta });
  await audit(req, 'UPLOAD_MEDIA', 'MediaAsset', asset.id, { folder: asset.folder });
  res.status(201).json({ success: true, data: { url: asset.url, thumbUrl: asset.thumbUrl } });
}));

module.exports = router;
module.exports.PAGE_DEFAULTS = PAGE_DEFAULTS;
module.exports.serialize = serialize;
module.exports.ensurePage = ensurePage;
