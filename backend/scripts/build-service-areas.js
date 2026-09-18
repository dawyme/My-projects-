#!/usr/bin/env node
/**
 * Build the national Trinidad & Tobago service-area pages.
 *
 * Renders service-areas/*.html deterministically from the single source of
 * truth in assets/data/service-areas.json. The generated files are committed
 * (the site is served as static HTML); backend/tests/service-area-seo.test.js
 * regenerates them and fails if they drift from the data.
 *
 * Usage:
 *   node backend/scripts/build-service-areas.js            # write service-areas/*.html
 *   node backend/scripts/build-service-areas.js --out DIR  # write into DIR instead
 */
const fs = require('fs');
const path = require('path');
const { ROOT, SERVICE_AREAS_DIR, loadServiceAreas } = require('../src/lib/serviceAreas');

const OUT = (() => {
  const i = process.argv.indexOf('--out');
  return i > 0 ? path.resolve(process.argv[i + 1]) : path.join(ROOT, SERVICE_AREAS_DIR);
})();

const data = loadServiceAreas();
const B = data.business;
const SERVICES = data.services;
const ISLANDS = data.islands;
const REGIONS = data.regions;
const BASE = B.url; // https://ndsairconditioning.com (non-www, per PR #73)

const bySlug = new Map(REGIONS.map((r) => [r.slug, r]));
const nameToRegion = new Map(REGIONS.map((r) => [r.name.toLowerCase(), r]));
const townsOf = (island) => REGIONS.filter((r) => r.island === island);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const serviceBySlug = (slug) => SERVICES.find((s) => s.slug === slug);

/* ------------------------------------------------------------------ */
/* Shared page parts                                                    */
/* ------------------------------------------------------------------ */

function head({ title, description, canonicalPath, jsonLd }) {
  const canonical = `${BASE}${canonicalPath}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <meta name="description" content="${esc(description)}">
    <link rel="canonical" href="${canonical}">

    <!-- Open Graph / Facebook -->
    <meta property="og:type" content="website">
    <meta property="og:url" content="${canonical}">
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${esc(description)}">
    <meta property="og:image" content="${BASE}/assets/logo.png">
    <meta property="og:locale" content="en_US">

    <!-- Twitter -->
    <meta property="twitter:card" content="summary_large_image">
    <meta property="twitter:url" content="${canonical}">
    <meta property="twitter:title" content="${title}">
    <meta property="twitter:description" content="${esc(description)}">
    <meta property="twitter:image" content="${BASE}/assets/logo.png">

    <!-- Structured Data -->
${jsonLd.map((obj) => `    <script type="application/ld+json">\n    ${JSON.stringify(obj, null, 2).replace(/\n/g, '\n    ')}\n    </script>`).join('\n')}

    <link rel="stylesheet" href="../assets/css/style.css">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700&amp;family=Open+Sans:wght@300;400;500;600&amp;display=swap" rel="stylesheet">
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-4CPWJYXKQH"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());

  gtag('config', 'G-4CPWJYXKQH');
</script>
    <link rel="icon" type="image/png" sizes="64x64" href="/assets/favicon.png">
</head>
`;
}

function header() {
  return `<body>
    <!-- Header -->
    <header class="site-header">
        <div class="container">
            <div class="header-content">
                <div class="logo"><a href="../index.html"><img src="../assets/logo.png" alt="N&amp;D logo" class="site-logo" width="512" height="512"></a></div>
                <nav class="main-nav">
                    <button class="nav-toggle" aria-label="Toggle navigation" aria-controls="primary-menu" aria-expanded="false">
                        <span class="hamburger"></span>
                    </button>
                    <ul class="nav-menu" id="primary-menu">
                        <li><a href="../index.html">Home</a></li>
                        <li><a href="../services.html">Services</a></li>
                        <li><a href="index.html" class="active">Service Areas</a></li>
                        <li><a href="../booking.html">Book Service</a></li>
                        <li><a href="../contact.html">Contact</a></li>
                    </ul>
                </nav>
            </div>
        </div>
    </header>
`;
}

function footer() {
  return `
    <!-- Footer -->
    <footer class="site-footer">
        <div class="container">
            <div class="footer-content">
                <div class="footer-column">
                    <h3>${esc(B.name)}</h3>
                    <p>Mobile HVAC and refrigeration services for residential and commercial clients. ${esc(B.tagline)}.</p>
                </div>
                <div class="footer-column">
                    <h3>Quick Links</h3>
                    <ul>
                        <li><a href="../index.html">Home</a></li>
                        <li><a href="../services.html">Services</a></li>
                        <li><a href="index.html">Service Areas</a></li>
                        <li><a href="../booking.html">Book Service</a></li>
                        <li><a href="../contact.html">Contact</a></li>
                    </ul>
                </div>
                <div class="footer-column">
                    <h3>Contact Info</h3>
                    <p><i class="fas fa-phone"></i> ${esc(B.telephoneDisplay)}</p>
                    <p><i class="fas fa-envelope"></i> ${esc(B.email)}</p>
                    <p><i class="fas fa-truck"></i> Fully mobile — we come to you</p>
                </div>
                <div class="footer-column">
                    <h3>Emergency Service</h3>
                    <p>Available 24/7 for urgent HVAC needs across Trinidad &amp; Tobago</p>
                    <a href="tel:${B.telephone.replace(/[^+\d]/g, '')}" class="btn-emergency">Call for Emergency Service</a>
                </div>
            </div>
            <div class="footer-bottom">
                <p>&copy; 2026 ${esc(B.name)}. All rights reserved.</p>
            </div>
        </div>
    </footer>

    <script src="../assets/js/main.js"></script>
</body>
</html>
`;
}

function breadcrumbLd(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map(([name, url], idx) => ({
      '@type': 'ListItem',
      position: idx + 1,
      name,
      ...(url ? { item: url } : {}),
    })),
  };
}

function serviceGrid(prefix, heading, sub, focusSlugSet) {
  const cards = SERVICES.map((s) => {
    const badge = focusSlugSet && focusSlugSet.has(s.slug)
      ? '\n                        <span style="display:inline-block;margin-top:8px;font-size:0.78rem;font-weight:700;color:#2A9D8F;"><i class="fas fa-star"></i> Popular locally</span>'
      : '';
    return `                    <div class="feature-item">
                        <h4><a href="${prefix}services/${s.slug}.html">${esc(s.name)}</a></h4>
                        <p>${esc(s.blurb)}</p>${badge}
                    </div>`;
  }).join('\n');
  return `
    <section class="service-overview" style="background:#f8f9fa;">
        <div class="container">
            <div class="section-header">
                <h2 class="section-title">${heading}</h2>
                <p>${sub}</p>
            </div>
            <div class="features-grid">
${cards}
            </div>
        </div>
    </section>
`;
}

function ctaSection(label) {
  return `
    <!-- Call to Action -->
    <section class="cta-section">
        <div class="container">
            <h2>${label}</h2>
            <p>Book online, request a quote, or call our 24/7 emergency line — ${esc(B.tagline)}.</p>
            <div style="display:flex; gap:20px; justify-content:center; flex-wrap:wrap; margin-top:20px;">
                <a href="../booking.html" class="btn-primary btn-large">Book Appointment</a>
                <a href="../quote-request.html" class="btn-secondary btn-large">Request a Quote</a>
                <a href="tel:${B.telephone.replace(/[^+\d]/g, '')}" class="btn-emergency btn-large"><i class="fas fa-phone"></i> ${esc(B.telephoneDisplay)}</a>
            </div>
        </div>
    </section>
`;
}

/* ------------------------------------------------------------------ */
/* Town pages                                                           */
/* ------------------------------------------------------------------ */

function townPage(region) {
  const islandName = ISLANDS.find((i) => i.slug === region.island).name;
  const canonicalPath = `/${SERVICE_AREAS_DIR}/${region.slug}.html`;
  const title = `${region.name} AC &amp; Refrigeration Services | ${esc(B.name)}`;
  const firstSentence = region.description.split('. ')[0] + '.';
  const description = `${firstSentence} Mobile service in ${region.name} — ${B.tagline}.`;
  const focus = new Set(region.focus);

  const jsonLd = [
    breadcrumbLd([
      ['Home', `${BASE}/`],
      ['Service Areas', `${BASE}/${SERVICE_AREAS_DIR}/index.html`],
      [islandName, `${BASE}/${SERVICE_AREAS_DIR}/${region.island}.html`],
      [region.name, `${BASE}${canonicalPath}`],
    ]),
    {
      '@context': 'https://schema.org',
      '@type': 'Service',
      name: `AC & Refrigeration Services in ${region.name}`,
      serviceType: 'Mobile air conditioning and refrigeration services',
      url: `${BASE}${canonicalPath}`,
      areaServed: { '@type': 'Place', name: `${region.name}, ${islandName}, Trinidad and Tobago` },
      provider: {
        '@type': 'HVACBusiness',
        name: B.name,
        url: `${BASE}/`,
        telephone: B.telephone,
        areaServed: [region.name, ...region.nearby],
      },
    },
  ];

  const nearbyChips = region.nearby
    .map((n) => {
      const linked = nameToRegion.get(n.toLowerCase());
      return linked
        ? `<a href="${linked.slug}.html" style="display:inline-block;margin:4px 6px 4px 0;padding:6px 14px;border:1px solid #d7dde6;border-radius:999px;text-decoration:none;">${esc(n)}</a>`
        : `<span style="display:inline-block;margin:4px 6px 4px 0;padding:6px 14px;border:1px solid #d7dde6;border-radius:999px;">${esc(n)}</span>`;
    })
    .join('\n                ');

  const siblingLinks = townsOf(region.island)
    .filter((r) => r.slug !== region.slug)
    .slice(0, 6)
    .map((r) => `<a href="${r.slug}.html">${esc(r.name)}</a>`)
    .join(' · ');

  return `${head({ title, description, canonicalPath, jsonLd })}
${header()}
    <!-- Breadcrumbs -->
    <nav aria-label="Breadcrumb" style="background:#f1f4f8;">
        <div class="container" style="padding:10px 0;font-size:0.9rem;">
            <a href="../index.html">Home</a> &rsaquo;
            <a href="index.html">Service Areas</a> &rsaquo;
            <a href="${region.island}.html">${esc(islandName)}</a> &rsaquo;
            <strong>${esc(region.name)}</strong>
        </div>
    </nav>

    <!-- Page Header -->
    <section class="page-header">
        <div class="container">
            <h1>${esc(region.name)} AC &amp; Refrigeration Services</h1>
            <p>${esc(B.name)} — ${esc(B.tagline)}</p>
        </div>
    </section>

    <!-- Mobile service commitment -->
    <section style="background:#0A66C2;color:#fff;padding:28px 0;">
        <div class="container" style="display:flex;flex-wrap:wrap;align-items:center;gap:20px;">
            <i class="fas fa-truck" style="font-size:2.2rem;"></i>
            <div style="flex:1;min-width:260px;">
                <h2 style="color:#fff;margin:0 0 6px;font-size:1.25rem;">Mobile service in ${esc(region.name)} — we come to you</h2>
                <p style="margin:0;">${esc(B.mobileStatement)}</p>
            </div>
            <a href="tel:${B.telephone.replace(/[^+\d]/g, '')}" class="btn-emergency">Call ${esc(B.telephoneDisplay)}</a>
        </div>
    </section>

    <!-- Local overview -->
    <section class="service-overview">
        <div class="container">
            <div class="service-hero">
                <h2>AC &amp; Refrigeration Service in ${esc(region.name)}, ${esc(islandName)}</h2>
                <p>${esc(region.description)}</p>
                <p>${esc(region.why)}</p>
                <a href="../booking.html" class="btn-primary">Book Service in ${esc(region.name)}</a>
            </div>
        </div>
    </section>
${serviceGrid('../', `Our services available in ${esc(region.name)}`, 'Every N&amp;D&#39;S service is delivered on site by our mobile teams — tap a service to learn more.', focus)}
    <!-- Nearby communities -->
    <section class="service-overview">
        <div class="container">
            <div class="service-hero">
                <h2>Areas we also serve near ${esc(region.name)}</h2>
                <p>Our mobile teams cover ${esc(region.name)} and the surrounding communities, including:</p>
                <div style="margin:14px 0 22px;">
                ${nearbyChips}
                </div>
                <p>Don't see your community? ${esc(B.tagline)} — <a href="index.html">see every area we serve</a> or call <a href="tel:${B.telephone.replace(/[^+\d]/g, '')}">${esc(B.telephoneDisplay)}</a>.</p>
            </div>
            <p style="margin-top:10px;">More ${esc(islandName)} service areas: ${siblingLinks}</p>
        </div>
    </section>
${ctaSection(`Ready for service in ${esc(region.name)}?`)}
${footer()}`;
}

/* ------------------------------------------------------------------ */
/* Island hub pages                                                     */
/* ------------------------------------------------------------------ */

function islandPage(island) {
  const towns = townsOf(island.slug);
  const canonicalPath = `/${SERVICE_AREAS_DIR}/${island.slug}.html`;
  const title = `AC &amp; Refrigeration Service Across ${island.name} | ${esc(B.name)}`;
  const description = `${B.name} provides mobile AC & refrigeration services across ${island.name} — ${towns.length} towns and communities covered. ${B.tagline}.`;

  const jsonLd = [
    breadcrumbLd([
      ['Home', `${BASE}/`],
      ['Service Areas', `${BASE}/${SERVICE_AREAS_DIR}/index.html`],
      [island.name, `${BASE}${canonicalPath}`],
    ]),
    {
      '@context': 'https://schema.org',
      '@type': 'HVACBusiness',
      name: B.name,
      url: `${BASE}/`,
      telephone: B.telephone,
      areaServed: towns.map((t) => t.name),
    },
  ];

  const cards = towns
    .map((t) => `                    <div class="feature-item">
                        <h4><a href="${t.slug}.html">${esc(t.name)}</a></h4>
                        <p>${esc(t.description.split('. ')[0])}.</p>
                    </div>`)
    .join('\n');
  const other = ISLANDS.find((i) => i.slug !== island.slug);

  return `${head({ title, description, canonicalPath, jsonLd })}
${header()}
    <!-- Breadcrumbs -->
    <nav aria-label="Breadcrumb" style="background:#f1f4f8;">
        <div class="container" style="padding:10px 0;font-size:0.9rem;">
            <a href="../index.html">Home</a> &rsaquo;
            <a href="index.html">Service Areas</a> &rsaquo;
            <strong>${esc(island.name)}</strong>
        </div>
    </nav>

    <!-- Page Header -->
    <section class="page-header">
        <div class="container">
            <h1>${esc(island.name)} Service Areas</h1>
            <p>${esc(B.name)} — ${esc(B.tagline)}</p>
        </div>
    </section>

    <!-- Mobile service commitment -->
    <section style="background:#0A66C2;color:#fff;padding:28px 0;">
        <div class="container" style="display:flex;flex-wrap:wrap;align-items:center;gap:20px;">
            <i class="fas fa-truck" style="font-size:2.2rem;"></i>
            <div style="flex:1;min-width:260px;">
                <h2 style="color:#fff;margin:0 0 6px;font-size:1.25rem;">Mobile service across ${esc(island.name)}</h2>
                <p style="margin:0;">${esc(B.mobileStatement)}</p>
            </div>
            <a href="tel:${B.telephone.replace(/[^+\d]/g, '')}" class="btn-emergency">Call ${esc(B.telephoneDisplay)}</a>
        </div>
    </section>

    <!-- Island overview -->
    <section class="service-overview">
        <div class="container">
            <div class="service-hero">
                <h2>AC &amp; Refrigeration Coverage Across ${esc(island.name)}</h2>
                <p>From busy commercial centres to coastal and rural communities, ${esc(B.name)} brings the workshop to you. Our technicians travel across ${esc(island.name)} with the tools, parts and expertise to service homes, businesses, guesthouses and vehicles — ${towns.length} towns and communities, and the areas around them.</p>
                <p>Wherever you are on ${esc(island.name)}, you can book online or call <a href="tel:${B.telephone.replace(/[^+\d]/g, '')}">${esc(B.telephoneDisplay)}</a>. ${esc(B.tagline)}.</p>
            </div>
            <div class="features-grid" style="margin-top:30px;">
${cards}
            </div>
        </div>
    </section>
${serviceGrid('../', `Services we deliver on ${esc(island.name)}`, 'Every core N&amp;D&#39;S service is available across the island via our mobile teams.')}
    <section class="service-overview" style="background:#f8f9fa;">
        <div class="container" style="text-align:center;">
            <p>Looking for coverage on ${esc(other.name)}? <a href="${other.slug}.html">Explore ${esc(other.name)} service areas</a> or <a href="index.html">view all of Trinidad &amp; Tobago</a>.</p>
        </div>
    </section>
${ctaSection(`Book service anywhere in ${esc(island.name)}`)}
${footer()}`;
}

/* ------------------------------------------------------------------ */
/* National hub page                                                    */
/* ------------------------------------------------------------------ */

function nationalPage() {
  const canonicalPath = `/${SERVICE_AREAS_DIR}/index.html`;
  const title = `Service Areas Across Trinidad &amp; Tobago | ${esc(B.name)}`;
  const description = `${B.name} is a fully mobile HVAC & refrigeration company covering all ${REGIONS.length} service areas in Trinidad & Tobago. ${B.tagline}.`;

  const jsonLd = [
    breadcrumbLd([
      ['Home', `${BASE}/`],
      ['Service Areas', `${BASE}${canonicalPath}`],
    ]),
    {
      '@context': 'https://schema.org',
      '@type': 'HVACBusiness',
      name: B.name,
      url: `${BASE}/`,
      telephone: B.telephone,
      slogan: B.tagline,
      areaServed: [...ISLANDS.map((i) => i.name), ...REGIONS.map((r) => r.name)],
    },
  ];

  const islandSections = ISLANDS.map((island) => {
    const towns = townsOf(island.slug);
    const links = towns
      .map((t) => `                        <li><a href="${t.slug}.html">${esc(t.name)}</a></li>`)
      .join('\n');
    return `
            <div class="footer-column" style="flex:1;min-width:260px;">
                <h3><a href="${island.slug}.html">${esc(island.name)}</a></h3>
                <ul style="list-style:none;padding:0;columns:2;column-gap:30px;line-height:2;">
${links}
                </ul>
                <p><a href="${island.slug}.html">All ${esc(island.name)} service areas &rarr;</a></p>
            </div>`;
  }).join('\n');

  return `${head({ title, description, canonicalPath, jsonLd })}
${header()}
    <!-- Breadcrumbs -->
    <nav aria-label="Breadcrumb" style="background:#f1f4f8;">
        <div class="container" style="padding:10px 0;font-size:0.9rem;">
            <a href="../index.html">Home</a> &rsaquo; <strong>Service Areas</strong>
        </div>
    </nav>

    <!-- Page Header -->
    <section class="page-header">
        <div class="container">
            <h1>${esc(B.tagline)}</h1>
            <p>${esc(B.name)} — mobile AC &amp; refrigeration coverage across all of Trinidad &amp; Tobago</p>
        </div>
    </section>

    <!-- How mobile service works -->
    <section class="service-overview">
        <div class="container">
            <div class="service-hero">
                <h2>One Mobile Team, Every Corner of the Nation</h2>
                <p>${esc(B.name)} is built around mobile service. ${esc(B.mobileStatement)}</p>
                <p>We cover ${REGIONS.length} named service areas — ${townsOf('trinidad').length} across Trinidad and ${townsOf('tobago').length} across Tobago — plus the surrounding communities around each one. Whether you need a split system installed in Chaguanas, a walk-in cooler repaired in Scarborough, or an emergency call-out in Toco, our technicians travel to you.</p>
                <a href="../booking.html" class="btn-primary">Book Mobile Service</a>
            </div>
            <div class="features-grid" style="margin-top:30px;">
                <div class="feature-item">
                    <i class="fas fa-truck"></i>
                    <h4>We Come to You</h4>
                    <p>Fully equipped service vehicles reach homes, businesses and job sites nationwide — no shop visits, no transporting equipment.</p>
                </div>
                <div class="feature-item">
                    <i class="fas fa-map-marked-alt"></i>
                    <h4>Both Islands Covered</h4>
                    <p>From Port of Spain to Charlotteville, our coverage spans Trinidad and Tobago and the communities in between.</p>
                </div>
                <div class="feature-item">
                    <i class="fas fa-clock"></i>
                    <h4>24/7 Emergency Response</h4>
                    <p>Cooling or refrigeration emergency? Our emergency line is answered around the clock, anywhere in our service area.</p>
                </div>
            </div>
        </div>
    </section>

    <!-- Coverage by island -->
    <section class="service-overview" style="background:#f8f9fa;">
        <div class="container">
            <div class="section-header">
                <h2 class="section-title">Every Area We Serve</h2>
                <p>Choose your island to see local details, nearby communities and popular services.</p>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:40px;">
${islandSections}
            </div>
            <p style="margin-top:20px;">Not listed? ${esc(B.tagline)} — call <a href="tel:${B.telephone.replace(/[^+\d]/g, '')}">${esc(B.telephoneDisplay)}</a> and ask about your area.</p>
        </div>
    </section>
${serviceGrid('../', 'Our Services — Delivered Everywhere', 'Mobile delivery of every core service, across all of Trinidad &amp; Tobago.')}
    <!-- FAQ -->
    <section class="service-overview">
        <div class="container">
            <div class="section-header">
                <h2 class="section-title">Service Area Questions</h2>
            </div>
            <div style="max-width:820px;margin:0 auto;">
                <h3>Do you really cover all of Trinidad &amp; Tobago?</h3>
                <p>Yes. Our mobile teams serve ${REGIONS.length} named areas across both islands — including remote communities like Toco and Charlotteville — along with the surrounding districts of each.</p>
                <h3>Is N&amp;D'S a shop-based or mobile company?</h3>
                <p>We are a mobile service company. ${esc(B.mobileStatement)}</p>
                <h3>What if my area is not listed?</h3>
                <p>If you are anywhere in Trinidad &amp; Tobago, call <a href="tel:${B.telephone.replace(/[^+\d]/g, '')}">${esc(B.telephoneDisplay)}</a> or <a href="../contact.html">contact us</a> — our dispatch team will confirm coverage for your exact location.</p>
            </div>
        </div>
    </section>
${ctaSection('Book Service Anywhere in Trinidad &amp; Tobago')}
${footer()}`;
}

/* ------------------------------------------------------------------ */
/* Build                                                                */
/* ------------------------------------------------------------------ */

fs.mkdirSync(OUT, { recursive: true });
const written = [];
const write = (name, html) => {
  fs.writeFileSync(path.join(OUT, name), html);
  written.push(name);
};

write('index.html', nationalPage());
for (const island of ISLANDS) write(`${island.slug}.html`, islandPage(island));
for (const region of REGIONS) write(`${region.slug}.html`, townPage(region));

console.log(`Built ${written.length} service-area pages into ${path.relative(ROOT, OUT) || OUT}`);
