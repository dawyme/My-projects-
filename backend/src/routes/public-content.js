const express = require('express');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { notFound } = require('../lib/errors');
const cache = require('../lib/cache');

const router = express.Router();

const PAGE_PATH = {
  homepage: '/', about: '/about.html', services: '/services.html', 'products-home': '/products/index.html',
  gallery: '/gallery/index.html', testimonials: '/testimonials.html', faq: '/faq.html',
  contact: '/contact.html', promotions: '/', footer: '/', seo: '/', social: '/', logo: '/', banners: '/',
  hours: '/', emergency: '/',
};

const PUBLIC_COLLECTIONS = ['services', 'testimonials', 'gallery', 'faqs', 'promotions', 'team'];

async function publishedPages() {
  return cache.wrap('public:content:pages:default', 15000, async () => {
    const pages = await prisma.contentPage.findMany({ where: { businessId: 'default', status: 'PUBLISHED' } });
    const map = {};
    for (const p of pages) {
      map[p.key] = {
        key: p.key, title: p.title, content: JSON.parse(p.content || '{}'),
        seo: {
          metaTitle: p.metaTitle, metaDescription: p.metaDescription, keywords: p.keywords,
          ogImage: p.ogImage, canonicalUrl: p.canonicalUrl, robots: p.robots,
        },
        publishedAt: p.publishedAt,
      };
    }
    return map;
  });
}

// GET /api/public/content — all published pages
router.get('/content', asyncHandler(async (req, res) => {
  const pages = await publishedPages();
  res.json({ success: true, data: pages });
}));

// GET /api/public/content/:key — one published page
router.get('/content/:key', asyncHandler(async (req, res) => {
  const pages = await publishedPages();
  const page = pages[req.params.key];
  if (!page) throw notFound(`Page '${req.params.key}' is not published`);
  res.json({ success: true, data: page });
}));

// GET /api/public/site-content/:collection — published collection items
router.get('/site-content/:collection', asyncHandler(async (req, res) => {
  const name = req.params.collection;
  if (!PUBLIC_COLLECTIONS.includes(name)) throw notFound(`Unknown collection '${name}'`);
  const items = await prisma[name === 'services' ? 'serviceItem' : {
    testimonials: 'testimonial', gallery: 'galleryItem', faqs: 'faqItem', promotions: 'promotionItem', team: 'teamMember',
  }[name]].findMany({ where: { businessId: 'default', status: 'PUBLISHED' }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
  res.json({ success: true, data: items });
}));

// GET /api/public/site-content/:collection/:slug — single published item by slug or id
router.get('/site-content/:collection/:slug', asyncHandler(async (req, res) => {
  const name = req.params.collection;
  const model = { services: 'serviceItem', testimonials: 'testimonial', gallery: 'galleryItem', faqs: 'faqItem', promotions: 'promotionItem', team: 'teamMember' }[name];
  if (!model) throw notFound(`Unknown collection '${name}'`);
  const item = await prisma[model].findFirst({
    where: { businessId: 'default', status: 'PUBLISHED', OR: [{ id: req.params.slug }, { slug: req.params.slug }] },
  });
  if (!item) throw notFound(`${name} item not found`);
  res.json({ success: true, data: item });
}));

// GET /api/public/media — public media feed (optionally filtered by folder)
router.get('/media', asyncHandler(async (req, res) => {
  const where = req.query.folder ? { folder: String(req.query.folder) } : {};
  const items = await cache.wrap('public:media:default', 30000, () => prisma.mediaAsset.findMany({ where: { ...where, businessId: 'default' }, orderBy: { createdAt: 'desc' }, take: 200 }));
  res.json({ success: true, data: items });
}));

// GET /api/public/sitemap — XML sitemap combining static pages and SEO pages
router.get('/sitemap', asyncHandler(async (req, res) => {
  const pages = await publishedPages();
  const base = (pages.seo?.content?.canonicalBase) || 'https://www.ndsairconditioning.com';
  const [products, services, serviceItems] = await Promise.all([
    prisma.product.findMany({ where: { businessId: 'default', isActive: true }, select: { slug: true, updatedAt: true } }),
    prisma.service.findMany({ where: { businessId: 'default', isActive: true }, select: { slug: true, updatedAt: true } }),
    prisma.serviceItem.findMany({ where: { businessId: 'default', status: 'PUBLISHED' }, select: { slug: true, updatedAt: true } }),
  ]);
  const urls = [];
  const push = (loc, mod = 'weekly', prio = '0.8') => urls.push(`  <url><loc>${base}${loc}</loc><changefreq>${mod}</changefreq><priority>${prio}</priority></url>`);
  push('/', 'daily', '1.0');
  for (const key of Object.keys(PAGE_PATH)) if (pages[key]) push(PAGE_PATH[key]);
  push('/about.html'); push('/services.html'); push('/contact.html'); push('/gallery/index.html'); push('/testimonials.html');
  push('/products/index.html'); push('/booking.html'); push('/quote-request.html');
  for (const p of products) push(`/products/product-detail.html?slug=${encodeURIComponent(p.slug)}`, 'weekly', '0.6');
  for (const s of services) push(`/services.html#${encodeURIComponent(s.slug)}`, 'weekly', '0.7');
  for (const s of serviceItems) if (s.slug) push(`/services.html#${encodeURIComponent(s.slug)}`, 'weekly', '0.7');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`;
  res.set('Content-Type', 'application/xml');
  res.send(xml);
}));

module.exports = router;
