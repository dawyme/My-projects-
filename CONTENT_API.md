# Website Content Manager — REST API

All Content Manager endpoints live under `/api` and are grouped as follows. Authentication uses the same JWT bearer tokens / cookies as the rest of the dashboard. Protected routes require a valid session; destructive/publishing actions are **ADMIN-only** and return `403` for staff.

## Conventions

- Successful responses: `{ "success": true, "data": ... }`
- Errors: `{ "success": false, "error": "...", "details": [...] }` with the appropriate HTTP status (`400`, `401`, `403`, `404`).
- List endpoints support `page`, `limit`, `search`, `status`, `featured`, `category` and `sort`/`order` query parameters, returning `meta` with pagination info.
- Content payloads are stored as JSON. Page bodies use dot-notated nested keys (e.g. `hero.title`).

## Content pages — `/api/content`

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/content` | List all editable pages (admin) |
| GET | `/api/content/:key` | Get one page (content merged with defaults, draft + SEO). `key` ∈ `homepage, about, services, products-home, gallery, testimonials, faq, contact, hours, emergency, promotions, footer, seo, social, logo, banners` |
| PUT | `/api/content/:key` | Save working content (body `{ content, seo?, title? }`) |
| POST | `/api/content/:key/autosave` | Save a draft (`{ draft }`) without affecting published content |
| POST | `/api/content/:key/publish` | Publish content (ADMIN; body optional `{ content, seo }`) |
| POST | `/api/content/:key/draft` | Move a page back to draft (ADMIN) |
| POST | `/api/content/:key/upload` | Upload an image for a page (multipart `image`) |

### Example — update and publish the homepage hero

```bash
curl -X PUT http://localhost:3001/api/content/homepage \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "content": { "hero": { "title": "New hero title" } },
        "seo": { "metaTitle": "N&D'S Home" } }'

curl -X POST http://localhost:3001/api/content/homepage/publish \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "content": { "hero": { "title": "New hero title" } } }'
```

## Collections — `/api/site-content/:collection`

`collection` ∈ `services, testimonials, gallery, faqs, promotions, team`.

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/site-content/:collection` | List items (pagination/search/filter/sort) |
| GET | `/api/site-content/:collection/:id` | Get one item |
| POST | `/api/site-content/:collection` | Create an item |
| PUT | `/api/site-content/:collection/:id` | Update an item |
| DELETE | `/api/site-content/:collection/:id` | Delete an item (ADMIN) |
| POST | `/api/site-content/:collection/:id/publish` | Publish an item (ADMIN) |
| POST | `/api/site-content/:collection/:id/draft` | Move to draft (ADMIN) |
| POST | `/api/site-content/:collection/reorder` | Bulk reorder `{ items: [{ id, sortOrder }] }` (ADMIN) |

### Example — create a testimonial

```bash
curl -X POST http://localhost:3001/api/site-content/testimonials \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "name": "Jane Doe", "company": "Acme", "review": "Great service!", "rating": 5 }'
```

## Media library — `/api/media`

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/media` | List/search/filter assets + folders |
| GET | `/api/media/:id` | Get one asset |
| POST | `/api/media/upload` | Upload images (multipart `images[]`, up to 8) |
| PATCH | `/api/media/:id` | Update metadata (`alt`, `folder`, `filename`) |
| POST | `/api/media/:id/replace` | Replace the file, keeping the id |
| DELETE | `/api/media/:id` | Delete an asset (ADMIN) |

## Public endpoints (no auth)

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/public/content` | All **published** pages (`{ key: { content, seo } }`) |
| GET | `/api/public/content/:key` | One published page (404 if not published) |
| GET | `/api/public/site-content/:collection` | Published collection items |
| GET | `/api/public/site-content/:collection/:slug` | One published item by slug/id |
| GET | `/api/public/media` | Public media feed (optional `folder`) |
| GET | `/api/public/sitemap` | XML sitemap combining static + published pages, products and services |

These are the endpoints consumed by `assets/js/site-content.js` on the public website. Unpublished content is never exposed.

## Validation & security

- All write endpoints are JWT-protected; publish/reorder/delete are ADMIN-only.
- Payloads are validated with Zod and rejected with `400` + `details` on failure.
- Uploaded files are filtered to image types, size-limited, and optimised (WebP, 1600px max, 400px thumbnail) via `sharp`.
- Input is sanitised (HTML/script payloads neutralised) and rate-limited.
