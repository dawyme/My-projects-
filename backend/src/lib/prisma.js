require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');
const { ensureSchemaProvider } = require('./schema-provider');

function resolveUrl() {
  const url = process.env.DATABASE_URL || 'file:./data/app.db';
  if (!url.startsWith('file:')) return url;
  const rel = url.slice('file:'.length);
  const abs = path.isAbsolute(rel) ? rel : path.resolve(__dirname, '..', '..', rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  return `file:${abs}`;
}

const url = resolveUrl();
const isPostgres =
  url.startsWith('postgresql://') ||
  url.startsWith('postgres://') ||
  Boolean(process.env.DIRECT_URL) ||
  Boolean(process.env.SUPABASE_URL);

if (isPostgres && !process.env.DIRECT_URL && process.env.DATABASE_URL) {
  process.env.DIRECT_URL = process.env.DATABASE_URL;
}

ensureSchemaProvider();

let prisma;
if (global.__prisma) {
  prisma = global.__prisma;
} else if (isPostgres) {
  // Production / Supabase PostgreSQL (direct or PgBouncer pooler)
  prisma = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
} else {
  // Offline SQLite test fallback
  const { PrismaLibSQL } = require('@prisma/adapter-libsql');
  const adapter = new PrismaLibSQL({ url });
  prisma = new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
}

if (process.env.NODE_ENV !== 'production') {
  global.__prisma = prisma;
}

module.exports = prisma;
