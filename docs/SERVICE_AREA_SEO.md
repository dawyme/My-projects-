# National Trinidad & Tobago Service Area SEO — Implementation Plan

Status: proposed for review (see PR "National Trinidad & Tobago Service Area SEO Foundation").

## Goal

Strengthen organic search visibility for **N&D'S Air Conditioning & Refrigeration Services**
across all of Trinidad & Tobago while keeping the brand positioned as a **mobile** service
company: **We Come to You Across Trinidad & Tobago.**

## Non-goals (explicit)

- No changes to PR #73's canonical-host work (non-www strategy is preserved and reused).
- No auth / RBAC / tenant / calendar / recurring maintenance / dispatch / POS / billing /
  subscription / Prisma schema / migration / platform-owner changes.
- No database changes, no migrations, no feature-management changes.
- No Google Business Profile work.
- No thin-content or doorway pages — every page must carry unique, useful local content.

## Architecture

```
/                                    (homepage — new national coverage strip)
/services.html                       (new "service areas" link block)
/services/<slug>.html                (11 core service pages — new "service areas" link block)
/service-areas/index.html            (NEW national hub — both islands)
/service-areas/trinidad.html         (NEW Trinidad regional hub — 27 towns)
/service-areas/tobago.html           (NEW Tobago regional hub — 8 towns)
/service-areas/<town>.html           (NEW — 35 unique town/community pages)
```

### Single source of truth

`assets/data/service-areas.json` holds, for every town: slug, display name, island,
settlement type, a **unique description paragraph**, a **unique "why locals call us"**
sentence, nearby communities, and focus services. The same file drives:

1. the static page generator (`backend/scripts/build-service-areas.js`),
2. the dynamic sitemap (`backend/src/lib/serviceAreas.js` → `/api/public/sitemap`),
3. the SEO test suite (`backend/tests/service-area-seo.test.js`).

### Page generation

`service-areas/*.html` is rendered deterministically from the JSON by
`backend/scripts/build-service-areas.js` (`npm run build:service-areas`) and the output is
committed (the site is served as static files). A test regenerates the pages and asserts
they match what is committed, so content and data can never drift apart.

Each town page contains:

- Unique `<title>` + meta description (town-specific copy, no template-only text).
- Non-www canonical + OG/Twitter URLs matching PR #73's strategy.
- `BreadcrumbList` + `Service`/`HVACBusiness` JSON-LD (`areaServed`, provider telephone/URL).
- Clear **mobile service coverage statement** ("our technicians come to you" +
  "We Come to You Across Trinidad & Tobago").
- Unique intro + "why {town} customers call us" paragraphs.
- Nearby-communities section (links towns that have their own page, plain text otherwise).
- Links to **all 11 core service pages** (back-links to core services).
- Cross-links: island hub, national hub, neighbouring towns.
- Booking / quote / phone CTAs consistent with the rest of the site.

### Internal linking strategy

| From | To |
| --- | --- |
| Town page | all 11 service pages, island hub, national hub, nearby towns |
| Island hub | every town page on that island, national hub, service pages |
| National hub | every town page (both islands), island hubs, homepage, services |
| Service page (×11) | national hub + towns where that service is a focus |
| `services.html` | national hub + island hubs |
| `index.html` | national hub + island hubs + headline towns |
| `sitemap.xml` + `/api/public/sitemap` | all 38 service-area URLs |

### Sitemap & crawlability

- Static `sitemap.xml`: adds all 38 service-area URLs (non-www), priority 0.6–0.8.
- Dynamic `/api/public/sitemap`: gains the same 38 paths via the shared
  `serviceAreas` lib. PR #73's `www → non-www` normalization is untouched.
- `robots.txt`: unchanged (already allows the site and advertises the sitemap).

## Files changed

New:

- `assets/data/service-areas.json`
- `backend/scripts/build-service-areas.js`
- `backend/src/lib/serviceAreas.js`
- `service-areas/index.html`, `service-areas/trinidad.html`, `service-areas/tobago.html`
- `service-areas/<35 town pages>.html`
- `backend/tests/service-area-seo.test.js`
- `docs/SERVICE_AREA_SEO.md` (this file)

Modified:

- `index.html` — national coverage strip + footer quick link.
- `services.html` — service-area link block.
- `services/*.html` (11 files) — service-area link block.
- `sitemap.xml` — service-area URLs.
- `backend/src/routes/public-content.js` — push service-area paths into dynamic sitemap.
- `backend/tests/run-all.js` — register the new suite.
- `package.json` — `build:service-areas` / `test:seo-areas` scripts.
- `CHANGELOG.md` — Unreleased entry.

## Testing

`backend/tests/service-area-seo.test.js` (DB-free, runs with plain Node):

1. Data integrity — all 35 required towns present, unique slugs, unique descriptions,
   valid focus services, non-empty nearby lists.
2. Generator idempotency — regenerated output matches committed pages byte-for-byte.
3. Per-page SEO — non-www canonical matching the file path, unique meta description,
   H1 containing the town name, required tagline + mobile wording present, links to all
   11 service pages, parseable JSON-LD with `areaServed`.
4. Hub coverage — island hubs link every town of their island; national hub links all 35.
5. Reverse links — every service page links back to service-area content.
6. Sitemap coverage — static sitemap contains every service-area URL, all non-www,
   no duplicates; shared lib paths match files on disk.
