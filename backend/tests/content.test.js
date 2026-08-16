/**
 * Website Content Manager — end-to-end API verification.
 *   node tests/content.test.js
 */
require('dotenv').config();
const assert = require('assert');
const app = require('../src/app');
const prisma = require('../src/lib/prisma');

let base = '';
const results = [];
let failures = 0;

async function test(name, fn) {
  try { await fn(); results.push(['PASS', name]); }
  catch (e) { failures++; results.push(['FAIL', `${name} — ${e.message}`]); }
}

function makeClient() {
  const jar = new Map();
  let csrf = null;
  let bearer = null;
  return {
    setBearer(t) { bearer = t; },
    get token() { return bearer; },
    async req(method, path, body, opts = {}) {
      const headers = { ...(opts.headers || {}) };
      if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
      const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookie) headers.Cookie = cookie;
      if (csrf) headers['x-csrf-token'] = csrf;
      if (bearer && !opts.noBearer) headers.Authorization = `Bearer ${bearer}`;
      const res = await fetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : (body instanceof FormData ? body : JSON.stringify(body)),
        redirect: 'manual',
      });
      for (const c of res.headers.getSetCookie?.() || []) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        const k = pair.slice(0, i); const v = pair.slice(i + 1);
        if (v === '') jar.delete(k); else jar.set(k, v);
        if (k === 'hvac_csrf') csrf = v;
      }
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) {}
      return { status: res.status, body: json, text, headers: res.headers };
    },
    get(p, o) { return this.req('GET', p, undefined, o); },
    post(p, b, o) { return this.req('POST', p, b, o); },
    put(p, b, o) { return this.req('PUT', p, b, o); },
    patch(p, b, o) { return this.req('PATCH', p, b, o); },
    del(p, b, o) { return this.req('DELETE', p, b, o); },
  };
}

function pngBuffer() {
  // 1x1 transparent PNG
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  return Buffer.from(b64, 'base64');
}

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const admin = makeClient();
  const staff = makeClient();
  const anon = makeClient();

  await admin.get('/api/csrf-token');
  await staff.get('/api/csrf-token');
  await anon.get('/api/csrf-token');
  const aLogin = await admin.post('/api/auth/login', { email: process.env.SEED_ADMIN_EMAIL || 'admin@ndsairconditioning.com', password: process.env.SEED_ADMIN_PASSWORD || 'Admin@12345' });
  admin.setBearer(aLogin.body.data.accessToken);
  const sLogin = await staff.post('/api/auth/login', { email: process.env.SEED_STAFF_EMAIL || 'staff@ndsairconditioning.com', password: process.env.SEED_STAFF_PASSWORD || 'Staff@12345' });
  staff.setBearer(sLogin.body.data.accessToken);

  // ---------- content pages
  let heroTitle;
  await test('GET /api/content lists all editable pages', async () => {
    const r = await admin.get('/api/content');
    assert.strictEqual(r.status, 200);
    const keys = r.body.data.map((p) => p.key);
    for (const k of ['homepage', 'about', 'services', 'gallery', 'testimonials', 'faq', 'contact', 'hours', 'emergency', 'promotions', 'footer', 'seo', 'social', 'logo', 'banners', 'products-home']) {
      assert.ok(keys.includes(k), `missing page ${k}`);
    }
  });
  await test('GET /api/content/homepage returns seeded content', async () => {
    const r = await admin.get('/api/content/homepage');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.data.content.hero.title);
    heroTitle = r.body.data.content.hero.title;
  });
  await test('PUT /api/content/homepage updates working content', async () => {
    const r = await admin.put('/api/content/homepage', { content: { hero: { title: 'Test Hero Title' }, cta: {} } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.data.content.hero.title, 'Test Hero Title');
  });
  await test('PUT /api/content/homepage persists SEO fields', async () => {
    const r = await admin.put('/api/content/homepage', { seo: { metaTitle: 'N&D'S Home', robots: 'index,follow' } });
    assert.strictEqual(r.status, 200);
    const check = await admin.get('/api/content/homepage');
    assert.strictEqual(check.body.data.seo.metaTitle, 'N&D'S Home');
  });
  await test('POST /api/content/homepage/autosave stores a draft', async () => {
    const r = await admin.post('/api/content/homepage/autosave', { draft: { hero: { title: 'Draft Hero' } } });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.data.draft);
  });
  await test('Autosaved draft does not become the published content', async () => {
    const r = await admin.get('/api/content/homepage');
    assert.strictEqual(r.body.data.draft.hero.title, 'Draft Hero');
    assert.notStrictEqual(r.body.data.content.hero.title, 'Draft Hero');
  });
  await test('POST /api/content/homepage/publish publishes (admin only)', async () => {
    assert.strictEqual((await staff.post('/api/content/homepage/publish')).status, 403);
    const r = await admin.post('/api/content/homepage/publish', { content: { hero: { title: 'Published Hero' }, cta: {} } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.data.status, 'PUBLISHED');
  });
  await test('POST /api/content/homepage/draft reverts to draft', async () => {
    const r = await admin.post('/api/content/homepage/draft');
    assert.strictEqual(r.body.data.status, 'DRAFT');
    await admin.post('/api/content/homepage/publish', { content: { hero: { title: heroTitle }, cta: {} } });
  });
  await test('Unknown content page returns 404', async () => {
    const r = await admin.get('/api/content/nope');
    assert.strictEqual(r.status, 404);
  });

  // ---------- collections
  let serviceId;
  await test('GET /api/site-content/services lists seeded services', async () => {
    const r = await admin.get('/api/site-content/services');
    assert.ok(r.body.data.length >= 8);
    serviceId = r.body.data[0].id;
  });
  await test('GET /api/site-content/services paginates and searches', async () => {
    const r = await admin.get('/api/site-content/services?limit=2&search=AC');
    assert.ok(r.body.data.length >= 1);
    assert.ok(r.body.meta.total > 0);
  });
  await test('GET /api/site-content/services filters by status', async () => {
    const r = await admin.get('/api/site-content/services?status=PUBLISHED');
    assert.ok(r.body.data.every((s) => s.status === 'PUBLISHED'));
  });
  await test('POST /api/site-content/services creates a service', async () => {
    const r = await admin.post('/api/site-content/services', { name: `Test Service ${Date.now()}`, icon: 'fa-cog', featured: false, sortOrder: 99, description: 'A test service' });
    assert.strictEqual(r.status, 201);
    assert.ok(r.body.data.slug);
    serviceId = r.body.data.id;
  });
  await test('POST /api/site-content/services rejects invalid payload', async () => {
    const r = await admin.post('/api/site-content/services', { name: '' });
    assert.strictEqual(r.status, 400);
  });
  await test('PUT /api/site-content/services/:id updates a service', async () => {
    const r = await admin.put(`/api/site-content/services/${serviceId}`, { featured: true, description: 'Updated description' });
    assert.strictEqual(r.body.data.featured, true);
  });
  await test('POST /api/site-content/services/:id/publish publishes (admin only)', async () => {
    assert.strictEqual((await staff.post(`/api/site-content/services/${serviceId}/publish`)).status, 403);
    const r = await admin.post(`/api/site-content/services/${serviceId}/publish`);
    assert.strictEqual(r.body.data.status, 'PUBLISHED');
    await admin.post(`/api/site-content/services/${serviceId}/draft`);
  });
  await test('POST /api/site-content/services/reorder updates ordering', async () => {
    const items = await admin.get('/api/site-content/services?limit=3');
    const payload = { items: items.body.data.map((it, i) => ({ id: it.id, sortOrder: i + 100 })) };
    const r = await admin.post('/api/site-content/services/reorder', payload);
    assert.strictEqual(r.status, 200);
    const check = await admin.get(`/api/site-content/services/${items.body.data[0].id}`);
    assert.strictEqual(check.body.data.sortOrder, 100);
  });
  await test('DELETE /api/site-content/services/:id is admin-only', async () => {
    assert.strictEqual((await staff.del(`/api/site-content/services/${serviceId}`)).status, 403);
    assert.strictEqual((await admin.del(`/api/site-content/services/${serviceId}`)).status, 200);
  });

  // ---------- testimonials / gallery / faqs / promotions / team
  await test('Testimonial round-trip (create/publish/delete)', async () => {
    const created = await admin.post('/api/site-content/testimonials', { name: 'Tester', company: 'Acme', review: 'Great service.', rating: 5 });
    assert.strictEqual(created.status, 201);
    await admin.post(`/api/site-content/testimonials/${created.body.data.id}/publish`);
    const pub = await admin.get(`/api/site-content/testimonials/${created.body.data.id}`);
    assert.strictEqual(pub.body.data.status, 'PUBLISHED');
    await admin.del(`/api/site-content/testimonials/${created.body.data.id}`);
  });
  await test('Gallery supports category filtering', async () => {
    const created = await admin.post('/api/site-content/gallery', { title: 'Img', category: 'Residential', imageUrl: '/uploads/x.png' });
    const r = await admin.get('/api/site-content/gallery?category=Residential');
    assert.ok(r.body.data.length >= 1);
    await admin.del(`/api/site-content/gallery/${created.body.data.id}`);
  });
  await test('FAQ round-trip', async () => {
    const created = await admin.post('/api/site-content/faqs', { question: 'Do you offer warranties?', answer: 'Yes, all work is covered.' });
    assert.strictEqual(created.status, 201);
    const updated = await admin.put(`/api/site-content/faqs/${created.body.data.id}`, { answer: 'A2.' });
    assert.strictEqual(updated.body.data.answer, 'A2.');
    await admin.del(`/api/site-content/faqs/${created.body.data.id}`);
  });
  await test('Promotion round-trip with dates', async () => {
    const created = await admin.post('/api/site-content/promotions', { title: 'Deal', body: 'Save', badge: 'SALE', startAt: new Date().toISOString(), endAt: new Date(Date.now() + 864e5).toISOString() });
    assert.strictEqual(created.status, 201);
    await admin.del(`/api/site-content/promotions/${created.body.data.id}`);
  });
  await test('Team round-trip', async () => {
    const created = await admin.post('/api/site-content/team', { name: 'Jane', role: 'Tech', bio: 'Bio' });
    assert.strictEqual(created.status, 201);
    await admin.del(`/api/site-content/team/${created.body.data.id}`);
  });
  await test('Unknown collection returns 404', async () => {
    assert.strictEqual((await admin.get('/api/site-content/bogus')).status, 404);
  });

  // ---------- media library
  let assetId;
  await test('POST /api/media/upload stores an image', async () => {
    const fd = new FormData();
    fd.append('images', new File([pngBuffer()], 'test-image.png', { type: 'image/png' }));
    fd.append('folder', '/uploads');
    const r = await admin.post('/api/media/upload', fd);
    assert.strictEqual(r.status, 201);
    assert.ok(r.body.data[0].url.startsWith('/uploads/'));
    assetId = r.body.data[0].id;
  });
  await test('GET /api/media lists and searches assets', async () => {
    const r = await admin.get('/api/media?search=test-image');
    assert.ok(r.body.data.length >= 1);
    assert.ok(Array.isArray(r.body.folders));
  });
  await test('PATCH /api/media/:id updates metadata', async () => {
    const r = await admin.patch(`/api/media/${assetId}`, { alt: 'Test alt text', folder: '/logos' });
    assert.strictEqual(r.body.data.alt, 'Test alt text');
    assert.strictEqual(r.body.data.folder, '/logos');
  });
  await test('POST /api/media/:id/replace swaps the file', async () => {
    const fd = new FormData();
    fd.append('image', new File([pngBuffer()], 'replacement.png', { type: 'image/png' }));
    const r = await admin.post(`/api/media/${assetId}/replace`, fd);
    assert.strictEqual(r.status, 200);
  });
  await test('DELETE /api/media/:id is admin-only', async () => {
    assert.strictEqual((await staff.del(`/api/media/${assetId}`)).status, 403);
    assert.strictEqual((await admin.del(`/api/media/${assetId}`)).status, 200);
  });

  // ---------- public content
  await test('GET /api/public/content exposes published pages', async () => {
    const r = await anon.get('/api/public/content');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.data.homepage);
    assert.ok(r.body.data.about.content.description);
  });
  await test('GET /api/public/content/homepage returns a single page', async () => {
    const r = await anon.get('/api/public/content/homepage');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.data.content.hero);
  });
  await test('Unpublished pages are hidden from public API', async () => {
    const created = await admin.post('/api/site-content/services', { name: `Hidden ${Date.now()}`, description: 'hidden', sortOrder: 500 });
    const r = await anon.get('/api/public/site-content/services');
    assert.ok(!r.body.data.some((s) => s.id === created.body.data.id));
    await admin.del(`/api/site-content/services/${created.body.data.id}`);
  });
  await test('GET /api/public/site-content/services returns published services', async () => {
    const r = await anon.get('/api/public/site-content/services');
    assert.ok(r.body.data.length >= 7);
  });
  await test('GET /api/public/site-content/services/:slug returns a service', async () => {
    const r = await anon.get('/api/public/site-content/services/ac-repair-installation');
    assert.strictEqual(r.status, 200);
  });
  await test('GET /api/public/sitemap returns XML', async () => {
    const r = await anon.get('/api/public/sitemap');
    assert.strictEqual(r.status, 200);
    assert.ok(r.text.includes('<urlset'));
  });
  await test('Content routes require authentication', async () => {
    assert.strictEqual((await anon.get('/api/content')).status, 401);
    assert.strictEqual((await anon.get('/api/site-content/services')).status, 401);
    assert.strictEqual((await anon.get('/api/media')).status, 401);
  });

  server.close();
  await prisma.$disconnect();

  const pass = results.filter((r) => r[0] === 'PASS').length;
  console.log('\nWebsite Content Manager verification\n======================================');
  for (const [state, name] of results) console.log(`  ${state === 'PASS' ? '✔' : '✘'} ${name}`);
  console.log(`\n${pass}/${results.length} checks passed${failures ? ` — ${failures} FAILED` : ''}\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
