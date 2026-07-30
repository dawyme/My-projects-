require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');

const { apiLimiter, writeLimiter } = require('./middleware/rateLimit');
const { issueCsrf, verifyCsrf } = require('./middleware/csrf');
const { sanitizeBody } = require('./middleware/validate');
const { notFoundHandler, errorHandler } = require('./middleware/error');
const { UPLOAD_DIR } = require('./middleware/upload');

const app = express();
const ROOT = path.join(__dirname, '..', '..');

app.set('trust proxy', 1);
app.disable('x-powered-by');

// ---------------------------------------------------------------- security
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdn.jsdelivr.net'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc: ["'self'"],
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
    if (!origin || origins.length === 0 || origins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
  exposedHeaders: ['Content-Disposition'],
}));

// ---------------------------------------------------------------- parsing
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());
app.use(sanitizeBody);
app.use(issueCsrf);

// ---------------------------------------------------------------- health
app.get('/health', (req, res) => res.json({ status: 'healthy', uptime: process.uptime(), timestamp: new Date().toISOString() }));
app.get('/api/status', (req, res) => res.json({ success: true, status: 'ok', version: require('../package.json').version }));
app.get('/api/csrf-token', (req, res) => res.json({ success: true, data: { csrfToken: req.csrfToken } }));

// ---------------------------------------------------------------- static
const staticOpts = { maxAge: '7d', etag: true };
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true }));
app.use('/assets', express.static(path.join(ROOT, 'assets'), staticOpts));
app.use('/admin', express.static(path.join(ROOT, 'admin'), { etag: true }));

// ---------------------------------------------------------------- api
app.use('/api', apiLimiter);
app.use('/api', verifyCsrf);
app.use(['/api/products', '/api/bookings', '/api/customers', '/api/messages', '/api/inventory', '/api/orders', '/api/users', '/api/settings', '/api/categories', '/api/services'], writeLimiter);

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
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/users', require('./routes/users'));
app.use('/api/audit-logs', require('./routes/audit'));
app.use('/api/public', require('./routes/public'));

// ---------------------------------------------------------------- site
app.use('/', express.static(ROOT, { ...staticOpts, index: 'index.html', extensions: ['html'] }));

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
