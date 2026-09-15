#!/usr/bin/env node
/**
 * Runs as part of `npm run build` on every Vercel deployment.
 *
 * Only syncs the database schema for the real production deployment
 * (VERCEL_ENV === 'production'). Preview deployments and local builds
 * skip this on purpose: this project's preview and production
 * deployments share a single database, so auto-applying an unmerged
 * branch's schema (via `prisma db push --accept-data-loss`, see
 * backend/prisma/migrate.js) on every preview build would let
 * work-in-progress schema changes alter or drop production data
 * before a PR is even reviewed.
 *
 * If you need a preview's new tables to exist before merging, run
 *   npm run migrate
 * manually against that deployment (same command this runs here).
 */
if (process.env.VERCEL_ENV !== 'production') {
  console.log(
    `Skipping schema sync (VERCEL_ENV=${process.env.VERCEL_ENV || 'none'}, not production).`
  );
  process.exit(0);
}

console.log('Production deploy — syncing database schema...');
require('../prisma/migrate.js');
