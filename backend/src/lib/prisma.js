const path = require('path');
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');
const { PrismaLibSQL } = require('@prisma/adapter-libsql');

function resolveUrl() {
  const url = process.env.DATABASE_URL || 'file:./data/app.db';
  if (!url.startsWith('file:')) return url;
  const rel = url.slice('file:'.length);
  const abs = path.isAbsolute(rel) ? rel : path.resolve(__dirname, '..', '..', rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  return `file:${abs}`;
}

const adapter = new PrismaLibSQL({ url: resolveUrl() });

const prisma = global.__prisma || new PrismaClient({
  adapter,
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});
if (process.env.NODE_ENV !== 'production') global.__prisma = prisma;

module.exports = prisma;
