/**
 * Service-area data access — single source of truth for the national
 * Trinidad & Tobago service-area SEO content.
 *
 * Everything here is driven by `assets/data/service-areas.json`:
 *  - the static page generator (backend/scripts/build-service-areas.js)
 *  - the dynamic sitemap (backend/src/routes/public-content.js)
 *  - the SEO test suite (backend/tests/service-area-seo.test.js)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DATA_FILE = path.join(ROOT, 'assets', 'data', 'service-areas.json');
const SERVICE_AREAS_DIR = 'service-areas';

let cache = null;

function loadServiceAreas() {
  if (!cache) cache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  return cache;
}

function serviceAreaPaths() {
  const data = loadServiceAreas();
  const paths = [
    `/${SERVICE_AREAS_DIR}/index.html`,
    ...data.islands.map((i) => `/${SERVICE_AREAS_DIR}/${i.slug}.html`),
    ...data.regions.map((r) => `/${SERVICE_AREAS_DIR}/${r.slug}.html`),
  ];
  return [...new Set(paths)];
}

module.exports = { ROOT, DATA_FILE, SERVICE_AREAS_DIR, loadServiceAreas, serviceAreaPaths };
