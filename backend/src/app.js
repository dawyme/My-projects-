require('dotenv').config();
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');

const { apiLimiter, writeLimiter, supplierWriteLimiter } = require('./middleware/rateLimit');
const { issueCsrf, verifyCsrf } = require('./middleware/csrf');
const { sanitizeBody } = require('./middleware/validate');
const { notFoundHandler, errorHandler } = require('./middleware/error');
const { UPLOAD_DIR } = require('./middleware/upload');
const { supabaseConfig, verifySupabaseConfig } = require('./lib/supabase');
const prisma = require('./lib/prisma');

const app = express();
const ROOT = path.join(__dirname, '..', '..');

app.set('trust proxy', 1);
app.disable('x-powered-by');

// ---------------------------------------------------------------- security
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'", "https:", "http:"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https:", "http:", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https:", "http:", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net"],
      fontSrc: ["'self'", "https:", "http:", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "blob:", "https:", "http:"],
      connectSrc: ["'self'", "https:", "http:", "ws:", "wss:"],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '0'); // superseded by CSP; explicit to avoid legacy filter bugs
  next();
});

const origins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (
      !origin ||
      origins.length === 0 ||
      origins.includes('*') ||
      origins.includes(origin) ||
      origin.includes('localhost') ||
      origin.includes('127.0.0.1') ||
      origin.endsWith('.vercel.app') ||
      origin === process.env.VERCEL_URL ||
      origin === process.env.SUPABASE_URL
    ) {
      return cb(null, true);
    }
    return cb(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Requested-With', 'Accept', 'Origin'],
  exposedHeaders: ['Content-Disposition', 'X-CSRF-Token'],
}));

// ---------------------------------------------------------------- parsing
app.use(compression());
// Payment webhooks need the raw request body for signature verification, so
// they are parsed before the JSON parsers and before CSRF (gateway servers do
// not participate in the double-submit cookie scheme).
app.use('/api/payments/webhook', express.raw({ type: '*/*', limit: '2mb' }));
app.use('/api/payments/webhook', require('./routes/payments').webhookRouter);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());
app.use(sanitizeBody);
app.use(issueCsrf);

// ---------------------------------------------------------------- health
app.get('/health', async (req, res) => {
  let dbOk = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch (e) {
    dbOk = false;
  }
  res.json({
    status: 'healthy',
    database: dbOk ? 'connected' : 'disconnected',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/status', async (req, res) => {
  let dbOk = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch (e) {
    dbOk = false;
  }
  const config = supabaseConfig();
  res.json({
    success: true,
    status: 'ok',
    version: (() => {
      try { return require('../package.json').version; } catch { return '1.0.0'; }
    })(),
    database: {
      connected: dbOk,
      provider: process.env.DATABASE_URL?.startsWith('postgres') ? 'postgresql' : 'sqlite',
    },
    supabase: config,
  });
});

app.get('/api/supabase/status', async (req, res) => {
  let dbOk = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch (e) {
    dbOk = false;
  }
  const verification = verifySupabaseConfig();
  res.json({
    success: true,
    connected: dbOk,
    configured: verification.config.configured,
    environment: verification.config,
    missing: verification.missing,
  });
});

app.get('/api/csrf-token', (req, res) => res.json({ success: true, data: { csrfToken: req.csrfToken } }));

// ---------------------------------------------------------------- static
const staticOpts = { maxAge: '7d', etag: true };
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true }));
app.use('/assets', express.static(path.join(ROOT, 'assets'), staticOpts));
app.use('/admin', express.static(path.join(ROOT, 'admin'), { etag: true }));

// ---------------------------------------------------------------- api
app.use('/api', apiLimiter);
app.use('/api', verifyCsrf);
app.use(['/api/products', '/api/bookings', '/api/customers', '/api/messages', '/api/inventory', '/api/orders', '/api/users', '/api/settings', '/api/categories', '/api/services', '/api/content', '/api/site-content', '/api/media', '/api/service-requests', '/api/work-orders', '/api/business', '/api/pos'], writeLimiter);
// Supplier Marketplace writes are bursty by nature (imports, bulk publish,
// sync triggers) and get their own budget.
app.use([
  '/api/suppliers', '/api/supplier-integrations', '/api/supplier-products',
  '/api/supplier-imports', '/api/supplier-syncs', '/api/supplier-fulfillments',
  '/api/supplier-shipping', '/api/supplier-settings',
], supplierWriteLimiter);

app.use('/api/auth', require('./routes/auth'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/products', require('./routes/products'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/bookings', require('./routes/bookings'));
app.use('/api/services', require('./routes/services'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/pos', require('./routes/pos'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/users', require('./routes/users'));
app.use('/api/business', require('./routes/business'));
app.use('/api/businesses', require('./routes/business'));
app.use('/api/saas', require('./routes/saas'));
app.use('/api/audit-logs', require('./routes/audit'));
app.use('/api/public', require('./routes/public'));
app.use('/api/public', require('./routes/public-content'));
app.use('/api/content', require('./routes/content'));
app.use('/api/site-content', require('./routes/site-content'));
app.use('/api/media', require('./routes/media'));
app.use('/api/technicians', require('./routes/technicians'));
app.use('/api/equipment', require('./routes/equipment'));
app.use('/api/estimates', require('./routes/estimates'));
app.use('/api/invoices', require('./routes/invoices'));
app.use('/api/dispatch', require('./routes/dispatch'));
app.use('/api/reminders', require('./routes/reminders'));
app.use('/api/service-history', require('./routes/service-history'));
app.use('/api/service-requests', require('./routes/service-requests'));
app.use('/api/work-orders', require('./routes/work-orders'));

// ---- Supplier Marketplace (dedicated admin section) ----
app.use('/api/suppliers', require('./routes/suppliers'));
app.use('/api/supplier-integrations', require('./routes/supplier-integrations'));
app.use('/api/supplier-products', require('./routes/supplier-products'));
app.use('/api/supplier-imports', require('./routes/supplier-imports'));
app.use('/api/supplier-syncs', require('./routes/supplier-syncs'));
app.use('/api/supplier-fulfillments', require('./routes/supplier-fulfillments'));
app.use('/api/supplier-shipping', require('./routes/supplier-shipping'));
app.use('/api/supplier-settings', require('./routes/supplier-settings'));

// ---------------------------------------------------------------- site
app.use('/', express.static(ROOT, { ...staticOpts, index: 'index.html', extensions: ['html'] }));

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
