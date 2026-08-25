require('dotenv').config();
const app = require('./src/app');
const prisma = require('./src/lib/prisma');

const PORT = parseInt(process.env.PORT || '3001', 10);

if (!process.env.JWT_SECRET && process.env.NODE_ENV === "production") {
  console.error('FATAL: JWT_SECRET is not set. Copy .env.example to .env and configure it.');
  process.exit(1);
}

const server = app.listen(PORT, () => {
  console.log(`\n  N&D'S Air Conditioning & Refrigeration Services backend listening on http://localhost:${PORT}`);
  console.log(`  Admin dashboard:  http://localhost:${PORT}/admin/`);
  console.log(`  Public website:   http://localhost:${PORT}/`);
  console.log(`  Environment:      ${process.env.NODE_ENV || 'development'}\n`);
});

async function shutdown(signal) {
  console.log(`\n${signal} received — shutting down gracefully.`);
  server.close(async () => {
    await prisma.$disconnect().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => { console.error('[uncaughtException]', err); shutdown('uncaughtException'); });

module.exports = server;
