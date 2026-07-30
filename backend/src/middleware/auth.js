const prisma = require('../lib/prisma');
const { verifyAccessToken } = require('../lib/tokens');
const { ACCESS_COOKIE } = require('../lib/cookies');
const { unauthorized, forbidden } = require('../lib/errors');

function extractToken(req) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7).trim();
  return req.cookies?.[ACCESS_COOKIE] || null;
}

/** Requires a valid access token and an active user account. */
async function protect(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) throw unauthorized('Authentication required');
    let payload;
    try { payload = verifyAccessToken(token); }
    catch (e) {
      throw unauthorized(e.name === 'TokenExpiredError' ? 'Access token expired' : 'Invalid token');
    }
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, name: true, email: true, role: true, isActive: true, avatarUrl: true, phone: true },
    });
    if (!user || !user.isActive) throw unauthorized('Account not found or disabled');
    req.user = user;
    next();
  } catch (err) { next(err); }
}

/** Restricts a route to the given roles. */
const authorize = (...roles) => (req, res, next) => {
  if (!req.user) return next(unauthorized('Authentication required'));
  if (!roles.includes(req.user.role)) return next(forbidden('Insufficient role for this action'));
  next();
};

const adminOnly = authorize('ADMIN');

/** Attaches req.user when a token is present, but never rejects. */
async function optionalAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return next();
  try {
    const payload = verifyAccessToken(token);
    req.user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, name: true, email: true, role: true, isActive: true },
    }) || undefined;
  } catch (_) {}
  next();
}

module.exports = { protect, authorize, adminOnly, optionalAuth, extractToken };
