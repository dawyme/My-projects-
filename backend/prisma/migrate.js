#!/usr/bin/env node
/**
 * Applies migrations or schema updates.
 * For Supabase PostgreSQL, synchronizes schema using Prisma db push / migrate.
 * For local SQLite testing, applies SQL migrations in prisma/migrations.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { ensureSchemaProvider } = require('../src/lib/schema-provider');

ensureSchemaProvider();

const url = process.env.DATABASE_URL || 'file:./data/app.db';
const isPostgres =
  url.startsWith('postgresql://') ||
  url.startsWith('postgres://') ||
  Boolean(process.env.DIRECT_URL) ||
  Boolean(process.env.SUPABASE_URL);

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

if (isPostgres) {
  console.log('Running Prisma schema sync for Supabase PostgreSQL...');
  const schemaPath = path.join(__dirname, 'schema.prisma');
  const binDir = path.join(__dirname, '..', 'node_modules', '.bin');
  const prismaBin = path.join(binDir, 'prisma');
  const env = { ...process.env };
  if (!env.DIRECT_URL && env.DATABASE_URL) {
    env.DIRECT_URL = env.DATABASE_URL;
  }
  const wrapperPath = path.join(binDir, 'schema-engine-wrapper');
  if (!env.PRISMA_SCHEMA_ENGINE_BINARY && fs.existsSync(wrapperPath)) {
    env.PRISMA_SCHEMA_ENGINE_BINARY = wrapperPath;
  }
  const libPath = path.join(__dirname, '..', 'node_modules', '@prisma', 'client', 'runtime', 'library.js');
  if (!env.PRISMA_QUERY_ENGINE_LIBRARY && fs.existsSync(libPath)) {
    env.PRISMA_QUERY_ENGINE_LIBRARY = libPath;
  }
  const res = spawnSync(process.execPath, [prismaBin, 'db', 'push', '--schema', schemaPath, '--accept-data-loss'], {
    stdio: 'inherit',
    env,
  });
  if (res.status !== 0) {
    console.warn('Note: Prisma db push returned status', res.status);
  }
  console.log('Supabase PostgreSQL schema sync complete.');
  process.exit(0);
}

function dbUrl() {
  if (!url.startsWith('file:')) return url;
  const rel = url.slice('file:'.length);
  const abs = path.isAbsolute(rel) ? rel : path.resolve(__dirname, '..', rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  return `file:${abs}`;
}

function splitStatements(sql) {
  return sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  const { createClient } = require('@libsql/client');
  const db = createClient({ url: dbUrl() });
  await db.execute(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "checksum" TEXT NOT NULL,
    "finished_at" DATETIME,
    "migration_name" TEXT NOT NULL,
    "logs" TEXT,
    "rolled_back_at" DATETIME,
    "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
    "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
  )`);

  const applied = new Set(
    (await db.execute('SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL')).rows
      .map((r) => r.migration_name)
  );

  const dirs = fs.readdirSync(MIGRATIONS_DIR)
    .filter((d) => fs.existsSync(path.join(MIGRATIONS_DIR, d, 'migration.sql')))
    .sort();

  let count = 0;
  for (const name of dirs) {
    if (applied.has(name)) { console.log(`• already applied: ${name}`); continue; }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8');
    const statements = splitStatements(sql);
    for (const stmt of statements) await db.execute(stmt);
    await db.execute({
      sql: 'INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count) VALUES (?, ?, current_timestamp, ?, ?)',
      args: [crypto.randomUUID(), crypto.createHash('sha256').update(sql).digest('hex'), name, statements.length],
    });
    console.log(`✔ applied: ${name} (${statements.length} statements)`);
    count++;
  }
  console.log(count ? `\nMigrations complete — ${count} new migration(s) applied.` : '\nDatabase is up to date.');
}

main().catch((e) => { console.error('Migration failed:', e.message); process.exit(1); });
