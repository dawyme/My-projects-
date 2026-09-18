#!/usr/bin/env node
/**
 * National Trinidad & Tobago service-area SEO contracts.
 *
 * Static checks (no database required):
 *   1. Service-area data integrity (all required towns, unique content, valid focus).
 *   2. Generator idempotency — committed pages match a fresh build from the data.
 *   3. Per-page SEO — non-www canonical/OG/Twitter URLs, unique meta descriptions,
 *      town-named H1, mobile-service wording, required tagline, full service links,
 *      valid JSON-LD with areaServed.
 *   4. Hub coverage — island hubs link every town; national hub links all towns.
 *   5. Reverse internal links — service pages + services.html + index.html link
 *      back into the service-area content.
 *   6. Sitemap coverage — static sitemap.xml lists every service-area URL (non-www,
 *      no duplicates) and the shared lib paths match the files on disk.
 *
 *   node backend/tests/service-area-seo.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SA_DIR = path.join(ROOT, 'service-areas');
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'data', 'service-areas.json'), 'utf8'));
const { serviceAreaPaths } = require('../src/lib/serviceAreas');

const BRAND = 'N&D\'S Air Conditioning & Refrigeration Services';
const TAGLINE = 'We Come to You Across Trinidad & Tobago';
const HOST = 'https://ndsairconditioning.com';

const REQUIRED_TRINIDAD = ['Port of Spain', 'San Fernando', 'Chaguanas', 'Arima', 'Point Fortin', 'Princes Town', 'Siparia', 'Penal', 'Debe', 'Couva', 'Sangre Grande', 'Rio Claro', 'Mayaro', 'Diego Martin', 'Tunapuna', 'Arouca', 'Barataria', 'San Juan', 'Marabella', 'La Brea', 'Fyzabad', 'Moruga', 'Claxton Bay', 'Freeport', 'Carapichaima', 'Valencia', 'Toco'];
const REQUIRED_TOBAGO = ['Scarborough', 'Canaan', 'Crown Point', 'Buccoo', 'Black Rock', 'Plymouth', 'Roxborough', 'Charlotteville'];

const failures = [];
const results = [];
const record = (ok, name, extra = '') => {
  results.push([ok ? 'PASS' : 'FAIL', name + (extra ? ` — ${extra}` : '')]);
  if (!ok) failures.push(`${name}${extra ? ` — ${extra}` : ''}`);
};

const read = (p) => fs.readFileSync(p, 'utf8');

/* ------------------------------------------------------------ */
/* 1. Data integrity                                             */
/* ------------------------------------------------------------ */
{
  const regionNames = DATA.regions.map((r) => r.name);
  const slugs = DATA.regions.map((r) => r.slug);
  record(new Set(slugs).size === slugs.length, 'data: slugs are unique');
  record(new Set(regionNames).size === regionNames.length, 'data: region names are unique');

  for (const name of REQUIRED_TRINIDAD) {
    const r = DATA.regions.find((x) => x.name === name);
    record(!!r && r.island === 'trinidad', `data: required Trinidad town present — ${name}`, r ? '' : 'missing');
  }
  for (const name of REQUIRED_TOBAGO) {
    const r = DATA.regions.find((x) => x.name === name);
    record(!!r && r.island === 'tobago', `data: required Tobago town present — ${name}`, r ? '' : 'missing');
  }
  record(DATA.regions.length === REQUIRED_TRINIDAD.length + REQUIRED_TOBAGO.length, 'data: no unexpected extra regions', `found ${DATA.regions.length}`);

  const serviceSlugs = new Set(DATA.services.map((s) => s.slug));
  record(serviceSlugs.size === 11, 'data: 11 core services defined');

  const descriptions = DATA.regions.map((r) => r.description);
  record(new Set(descriptions).size === descriptions.length, 'data: descriptions are unique');
  const whys = DATA.regions.map((r) => r.why);
  record(new Set(whys).size === whys.length, 'data: why-lines are unique');

  for (const r of DATA.regions) {
    record(Array.isArray(r.nearby) && r.nearby.length >= 3, `data: nearby communities for ${r.name}`, r.nearby ? `${r.nearby.length} listed` : 'missing');
    record(Array.isArray(r.focus) && r.focus.length >= 3 && r.focus.every((f) => serviceSlugs.has(f)), `data: valid focus services for ${r.name}`);
    record(/\b(we|our)\b/i.test(r.description) && r.description.length >= 120, `data: substantive description for ${r.name}`);
  }

  // Business wording constants
  record(DATA.business.name === BRAND, 'data: required business wording present', DATA.business.name);
  record(DATA.business.tagline === TAGLINE, 'data: required tagline present', DATA.business.tagline);
}

/* ------------------------------------------------------------ */
/* 2. Generator idempotency (committed output matches the data)  */
/* ------------------------------------------------------------ */
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-seo-'));
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'backend', 'scripts', 'build-service-areas.js'), '--out', tmp], { stdio: 'pipe' });
    const generated = fs.readdirSync(tmp).filter((f) => f.endsWith('.html')).sort();
    const committed = fs.readdirSync(SA_DIR).filter((f) => f.endsWith('.html')).sort();
    record(JSON.stringify(generated) === JSON.stringify(committed), 'build: generated file set matches committed file set', `${generated.length} vs ${committed.length}`);
    let drift = [];
    for (const f of generated) {
      if (read(path.join(tmp, f)) !== read(path.join(SA_DIR, f))) drift.push(f);
    }
    record(drift.length === 0, 'build: committed pages match generator output', drift.join(', '));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------ */
/* 3. Per-page SEO contracts                                     */
/* ------------------------------------------------------------ */
const canonicalOf = (html) => {
  const m = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i);
  return m ? m[1] : null;
};
const metaOf = (html, prop) => {
  const m = html.match(new RegExp(`<meta\\s+name="description"\\s+content="([^"]*)"`, 'i'));
  if (prop === 'description') return m ? m[1] : null;
  const m2 = html.match(new RegExp(`<meta\\s+property="${prop}"\\s+content="([^"]*)"`, 'i'));
  return m2 ? m2[1] : null;
};
const h1Of = (html) => {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim() : null;
};
const jsonLdBlocks = (html) => {
  const out = [];
  const re = /<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try { out.push(JSON.parse(m[1])); } catch (e) { out.push({ __parseError: e.message }); }
  }
  return out;
};
const decode = (s) => (s || '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
const plain = (html) => decode(html); // decode entities before text-presence checks

const descriptions = new Map();
const townFiles = [];

for (const r of DATA.regions) {
  const file = path.join(SA_DIR, `${r.slug}.html`);
  const exists = fs.existsSync(file);
  record(exists, `page: ${r.slug}.html exists`);
  if (!exists) continue;
  const html = read(file);
  townFiles.push(file);
  const canonical = canonicalOf(html);
  record(canonical === `${HOST}/service-areas/${r.slug}.html`, `canonical: ${r.slug}`, canonical || 'missing');
  record(!/www\.ndsairconditioning\.com/i.test(html), `canonical: ${r.slug} has no www references`);
  record(metaOf(html, 'og:url') === canonical, `og:url: ${r.slug} matches canonical`);
  record(metaOf(html, 'twitter:url') === canonical, `twitter:url: ${r.slug} matches canonical`);

  const desc = decode(metaOf(html, 'description'));
  record(desc && desc.toLowerCase().includes(r.name.toLowerCase()), `meta: ${r.slug} description names the town`);
  descriptions.set(desc, (descriptions.get(desc) || 0) + 1);

  const h1 = h1Of(html);
  record(h1 && h1.includes(r.name), `h1: ${r.slug} names the town`, h1 || 'missing');
  record(plain(html).includes(TAGLINE), `tagline: ${r.slug} states "${TAGLINE}"`);
  record(/mobile/i.test(html) && /come to you/i.test(plain(html)), `mobile: ${r.slug} states mobile coverage`);

  for (const s of DATA.services) {
    record(html.includes(`href="../services/${s.slug}.html"`), `links: ${r.slug} -> ${s.slug} service page`);
  }
  record(html.includes(`href="${r.island}.html"`), `links: ${r.slug} -> island hub`);
  record(html.includes('href="index.html"'), `links: ${r.slug} -> national hub`);
  record(html.includes('../booking.html') && html.includes('tel:'), `cta: ${r.slug} has booking + phone CTAs`);

  const ld = jsonLdBlocks(html);
  record(ld.length >= 2 && ld.every((b) => !b.__parseError), `json-ld: ${r.slug} parses (breadcrumb + service)`, ld.map((b) => b.__parseError || '').join(';'));
  const svc = ld.find((b) => b['@type'] === 'Service');
  record(!!svc && JSON.stringify(svc.areaServed).includes(r.name), `json-ld: ${r.slug} areaServed names the town`);
  record(!!svc && svc.provider && svc.provider.name === BRAND, `json-ld: ${r.slug} provider uses required brand wording`);
  record(!!svc && svc.provider && svc.provider.telephone === DATA.business.telephone, `json-ld: ${r.slug} provider telephone`);
  const bc = ld.find((b) => b['@type'] === 'BreadcrumbList');
  record(!!bc && bc.itemListElement.length >= 3, `json-ld: ${r.slug} breadcrumb present`);
}
{
  const dupes = [...descriptions.entries()].filter(([, n]) => n > 1).map(([d]) => d);
  record(dupes.length === 0, 'meta: town descriptions are unique across pages', dupes.slice(0, 3).join(' | '));
}

/* ------------------------------------------------------------ */
/* 4. Hub pages                                                  */
/* ------------------------------------------------------------ */
for (const island of DATA.islands) {
  const file = path.join(SA_DIR, `${island.slug}.html`);
  const html = read(file);
  const towns = DATA.regions.filter((r) => r.island === island.slug);
  record(canonicalOf(html) === `${HOST}/service-areas/${island.slug}.html`, `hub: ${island.slug} canonical`);
  record(plain(html).includes(TAGLINE), `hub: ${island.slug} tagline`);
  for (const t of towns) record(html.includes(`href="${t.slug}.html"`), `hub: ${island.slug} links ${t.slug}`);
  for (const s of DATA.services) record(html.includes(`../services/${s.slug}.html`), `hub: ${island.slug} links service ${s.slug}`);
  record(!/www\.ndsairconditioning\.com/i.test(html), `hub: ${island.slug} no www references`);
}
{
  const html = read(path.join(SA_DIR, 'index.html'));
  record(canonicalOf(html) === `${HOST}/service-areas/index.html`, 'hub: national canonical');
  const h1 = h1Of(html);
  record(h1 && h1.includes(TAGLINE), 'hub: national H1 is the tagline', h1 || 'missing');
  for (const r of DATA.regions) record(html.includes(`href="${r.slug}.html"`), `hub: national links ${r.slug}`);
  for (const island of DATA.islands) record(html.includes(`href="${island.slug}.html"`), `hub: national links island hub ${island.slug}`);
  record(plain(html).includes(BRAND), 'hub: national uses required business wording');
  record(!/www\.ndsairconditioning\.com/i.test(html), 'hub: national no www references');
  const ld = jsonLdBlocks(html);
  const biz = ld.find((b) => b['@type'] === 'HVACBusiness');
  record(!!biz && biz.name === BRAND && Array.isArray(biz.areaServed) && biz.areaServed.length >= DATA.regions.length, 'hub: national HVACBusiness JSON-LD covers all areas');
}

/* ------------------------------------------------------------ */
/* 5. Reverse internal links                                     */
/* ------------------------------------------------------------ */
for (const s of DATA.services) {
  const html = read(path.join(ROOT, 'services', `${s.slug}.html`));
  record(html.includes('../service-areas/index.html'), `reverse: services/${s.slug}.html links service-area hub`);
  record(plain(html).includes(TAGLINE), `reverse: services/${s.slug}.html states the tagline`);
}
{
  const servicesHtml = read(path.join(ROOT, 'services.html'));
  record(servicesHtml.includes('service-areas/index.html') && servicesHtml.includes('service-areas/trinidad.html') && servicesHtml.includes('service-areas/tobago.html'), 'reverse: services.html links service-area hubs');
  const indexHtml = read(path.join(ROOT, 'index.html'));
  record(indexHtml.includes('href="service-areas/index.html"'), 'reverse: index.html links national service-area hub');
  record(plain(indexHtml).includes(TAGLINE), 'reverse: index.html states the tagline');
}

/* ------------------------------------------------------------ */
/* 6. Sitemap + shared lib coverage                              */
/* ------------------------------------------------------------ */
{
  const paths = serviceAreaPaths();
  record(paths.length === 38 && new Set(paths).size === 38, 'lib: serviceAreaPaths returns 38 unique paths', `got ${paths.length}`);
  for (const p of paths) record(fs.existsSync(path.join(ROOT, p)), `lib: path on disk — ${p}`);

  const sitemap = read(path.join(ROOT, 'sitemap.xml'));
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  record(new Set(locs).size === locs.length, 'sitemap: no duplicate locs');
  record(!locs.some((l) => /www\.ndsairconditioning\.com/i.test(l)), 'sitemap: all locs are non-www');
  for (const p of paths) record(locs.includes(`${HOST}${p}`), `sitemap: includes ${p}`);

  const robots = read(path.join(ROOT, 'robots.txt'));
  record(/Sitemap:\s*https:\/\/ndsairconditioning\.com\/sitemap\.xml/i.test(robots), 'robots: sitemap advertised');
}

/* ------------------------------------------------------------ */
console.log('\n=== National service-area SEO checks ===');
for (const [s, n] of results) if (s === 'FAIL') console.log(`  ${s}: ${n}`);
const passed = results.filter(([s]) => s === 'PASS').length;
console.log(`${passed}/${results.length} checks passed.`);
assert.deepStrictEqual(failures, [], `${failures.length} service-area SEO failures:\n- ${failures.join('\n- ')}`);
console.log('National service-area SEO checks passed.');
