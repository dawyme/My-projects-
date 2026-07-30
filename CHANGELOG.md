# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- Initial project audit completed
- CHANGELOG.md and TASKS.md files created

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
