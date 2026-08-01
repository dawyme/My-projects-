# Website Content Manager

The Website Content Manager is a full CMS built into the existing admin dashboard. Every editable part of the public website — pages, sections, collections and the media library — can be created, edited, saved as a draft, auto-saved, published and previewed from the dashboard. Content changes only go live once you click **Publish**.

## Access

1. Sign in to the admin dashboard (`/admin/`).
2. Open **Website → Website Content** in the sidebar.
3. Open **Website → Media Library** for image management.

> Staff users can view and edit drafts but only **ADMIN** users can publish content (this is enforced both in the UI and on the API).

## Modules

The Content Manager is organised into tabs, one per editable module:

| Module | What you can edit | Type |
| ------ | ----------------- | ---- |
| **Homepage** | Hero title/subtitle, CTA buttons, hero background image/video, featured products & services titles, promo banner, emergency banner, call-to-action section | Page |
| **About Us** | Company description, mission, vision, team members, images, certifications, experience | Page + Team |
| **Services** | Add/edit/delete services, icons, images, descriptions, ordering, featured | Page + Collection |
| **Products Homepage Settings** | Featured products title/subtitle, per-row layout, featured IDs | Page |
| **Gallery** | Multiple image uploads, categories, drag/sort ordering, delete, replace, image optimisation | Page + Collection |
| **Testimonials** | Customer name, company, review, rating, photo, publish/unpublish | Page + Collection |
| **FAQ** | Questions and answers, categories, ordering | Page + Collection |
| **Contact Information** | Phone numbers, WhatsApp, email, social links, map embed, contact form recipient | Page |
| **Business Hours** | Per-day hours + 24/7 emergency toggle | Page |
| **Emergency Banner** | Text, link and on/off toggle | Page |
| **Promotions** | Banners/deals with badge, image, link, start/end dates | Page + Collection |
| **Footer** | Copyright, about text, quick links, contact block | Page |
| **SEO** | Global title, description, keywords, OG image, canonical base, robots | Page |
| **Social Media** | Facebook, Instagram, TikTok, YouTube, LinkedIn, Twitter | Page |
| **Logo Manager** | Logo & favicon URL, alt text | Page |
| **Banner / Image Manager** | Hero image/video, promo banner, about image, CTA background | Page |

## Key features

- **Create / Read / Update / Delete** — full CRUD for pages and every collection item.
- **Publish / Draft** — content stays in draft until published; unpublished pages are hidden from the public API.
- **Auto-save** — drafts are saved automatically ~1 second after you stop typing and on structural changes.
- **Image upload** — upload via the Media Library or inline; images are optimised to WebP and a 400px thumbnail is generated.
- **Rich text editing** — long fields (descriptions, reviews, answers, bios) use a toolbar-based rich text editor.
- **Live preview** — the **Preview** button renders the current content as an HTML preview.
- **SEO per page** — each page has its own meta title, description, keywords, OG image, canonical URL and robots setting (managed on the page editor; global SEO lives in the SEO tab).

## Media Library

- Upload multiple images (JPG/PNG/WebP/GIF/SVG).
- Search by filename/alt text and filter by file type or folder.
- Edit alt text, move to a folder, rename, replace the file or delete it.
- Uploaded images are validated (allowed image types only, 5 MB limit per file).

## Website integration

The public website (`index.html`, `about.html`, `services.html`, `contact.html`, `gallery/`, `testimonials.html`) loads `assets/js/site-content.js`, which fetches **published** content from the admin backend and fills the page. Every editable section pulls from the Content Manager. If the API is unreachable or a field is unpublished, the page keeps its built-in fallback markup, so the site never breaks.

## Configuration

See [DEPLOYMENT.md](./DEPLOYMENT.md) for database and environment setup, and [CONTENT_API.md](./CONTENT_API.md) for the REST API reference.
