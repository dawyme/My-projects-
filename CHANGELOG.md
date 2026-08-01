# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- **Website Content Manager** (`/admin/#/content`) with modules for Homepage,
  About, Services, Products Homepage, Gallery, Testimonials, FAQ, Contact,
  Business Hours, Emergency Banner, Promotions, Footer, SEO, Social Media,
  Logo and Banner/Image Manager.
- Publish / Draft workflow with auto-save, rich text editing, image upload and
  live preview for every editable page and collection.
- **Media Library** (`/admin/#/media`) with upload, search, folder organisation,
  replace, delete and image optimisation.
- Content Manager REST API (`/api/content`, `/api/site-content`, `/api/media`)
  plus public read endpoints (`/api/public/content`, `/site-content`, `/media`,
  `/sitemap`) — JWT protected, role-protected, validated and rate-limited.
- Prisma models `ContentPage`, `ServiceItem`, `Testimonial`, `GalleryItem`,
  `FaqItem`, `PromotionItem`, `TeamMember` and `MediaAsset`, with migration and
  seeded sample content.
- Public website now loads dynamic content from the database via
  `assets/js/site-content.js` (hard-coded markup retained as fallback).
- Documentation: `WEBSITE_CONTENT_MANAGER.md`, `CONTENT_API.md`, `DEPLOYMENT.md`.
- Automated Website Content Manager verification suite added to `npm test`.

### Fixed
- Admin API client now resolves the API to the same origin, so local and
  same-origin deployments work out of the box.
- Test harness injects the bundled admin SPA via a DOM script element, avoiding
  a jsdom inline-script parsing quirk with large HTML-template bundles.

### Changed
- Nothing yet

### Fixed
- Nothing yet

### Removed
- Nothing yet
## Admin Dashboard release

### Added
- Express + Prisma backend (`backend/`) with 60+ REST endpoints.
- Admin dashboard at `/admin/` with 15 pages, dark/light themes and full
  responsive layout.
- Authentication with bcrypt hashing, JWT access tokens, rotating refresh
  tokens and Admin/Staff role-based access control.
- Product, booking, customer, message, inventory, order, analytics, settings,
  team and audit-log management.
- Public API powering the storefront catalogue and the contact, booking and
  quote forms.
- Automated verification suites (`npm test`) covering the API, admin UI and
  public website.

### Changed
- Website contact, booking and quote forms now submit to the backend instead of
  a third-party form endpoint, landing directly in the admin dashboard.
- Replaced the placeholder `admin/dashboard.html` with the full application.
