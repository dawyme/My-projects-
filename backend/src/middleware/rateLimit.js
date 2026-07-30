const rateLimit = require('express-rate-limit');

const json = (message) => (req, res) => res.status(429).json({ success: false, error: message });

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
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
  max: 120,
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

module.exports = { apiLimiter, authLimiter, writeLimiter, publicFormLimiter };
