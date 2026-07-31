const crypto = require('crypto');
const { CSRF_COOKIE, setCsrfCookie } = require('../lib/cookies');
const { forbidden } = require('../lib/errors');

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Issues a CSRF cookie for every session. */
function issueCsrf(req, res, next) {
  if (!req.cookies?.[CSRF_COOKIE]) {
    const token = crypto.randomBytes(24).toString('hex');
    setCsrfCookie(res, token);
    req.csrfToken = token;
  } else {
    req.csrfToken = req.cookies[CSRF_COOKIE];
  }
  next();
}

/**
 * Double-submit cookie verification. Only enforced for cookie-authenticated
 * mutations — Bearer-token API clients are immune to CSRF by design.
 */
function verifyCsrf(req, res, next) {
  if (SAFE.has(req.method)) return next();
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return next();
  const cookieToken = req.cookies?.[CSRF_COOKIE];
  const headerToken = req.get('x-csrf-token') || req.body?._csrf;
  if (!cookieToken || !headerToken) return next(forbidden('CSRF token missing'));
  const a = Buffer.from(String(cookieToken));
  const b = Buffer.from(String(headerToken));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return next(forbidden('CSRF token invalid'));
  next();
}

module.exports = { issueCsrf, verifyCsrf };
