const rateLimit = require('express-rate-limit');

const json = (message) => (req, res) => res.status(429).json({ success: false, error: message });

// Budgets are configurable so a deployment behind a shared office IP (or a
// load/stability test run) can widen them without a code change. Defaults are
// deliberately conservative.
const intEnv = (name, fallback) => {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: intEnv('RATE_LIMIT_API_MAX', 300),
  standardHeaders: true,
  legacyHeaders: false,
  handler: json('Too many requests, please slow down.'),
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  handler: json('Too many login attempts. Try again in 15 minutes.'),
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: intEnv('RATE_LIMIT_WRITE_MAX', 120),
  standardHeaders: true,
  legacyHeaders: false,
  handler: json('Too many write operations, please slow down.'),
});

const publicFormLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  // Generous enough for a shared office IP, strict enough to stop form spam.
  max: parseInt(process.env.PUBLIC_FORM_LIMIT || '20', 10),
  standardHeaders: true,
  legacyHeaders: false,
  handler: json('Submission limit reached. Please try again later.'),
});

/**
 * Supplier Marketplace writes get their own budget. Catalogue imports, preview
 * commits, bulk publish and sync triggers are legitimately write-heavy and
 * bursty, so sharing the general admin write budget would throttle a normal
 * operator mid-import.
 */
const supplierWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: intEnv('RATE_LIMIT_SUPPLIER_WRITE_MAX', 400),
  standardHeaders: true,
  legacyHeaders: false,
  handler: json('Too many supplier operations, please slow down.'),
});

module.exports = { apiLimiter, authLimiter, writeLimiter, publicFormLimiter, supplierWriteLimiter };
