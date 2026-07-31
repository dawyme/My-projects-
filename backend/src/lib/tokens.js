const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const prisma = require('./prisma');

const ACCESS_TTL = process.env.ACCESS_TOKEN_TTL || '15m';
const REFRESH_DAYS = parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || '7', 10);

function accessSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not configured');
  return s;
}
function refreshSecret() {
  return process.env.JWT_REFRESH_SECRET || accessSecret() + ':refresh';
}

function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, name: user.name, typ: 'access' },
    accessSecret(),
    { expiresIn: ACCESS_TTL, issuer: 'hvac-admin' }
  );
}

function verifyAccessToken(token) {
  const payload = jwt.verify(token, accessSecret(), { issuer: 'hvac-admin' });
  if (payload.typ !== 'access') throw new Error('Wrong token type');
  return payload;
}

const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');

async function issueRefreshToken(user, { ip, userAgent } = {}) {
  const jti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + REFRESH_DAYS * 864e5);
  const token = jwt.sign({ sub: user.id, jti, typ: 'refresh' }, refreshSecret(), {
    expiresIn: `${REFRESH_DAYS}d`,
    issuer: 'hvac-admin',
  });
  await prisma.refreshToken.create({
    data: { tokenHash: hash(token), userId: user.id, expiresAt, ip: ip || null, userAgent: userAgent || null },
  });
  return { token, expiresAt };
}

async function verifyRefreshToken(token) {
  const payload = jwt.verify(token, refreshSecret(), { issuer: 'hvac-admin' });
  if (payload.typ !== 'refresh') throw new Error('Wrong token type');
  const record = await prisma.refreshToken.findUnique({ where: { tokenHash: hash(token) } });
  if (!record || record.revokedAt || record.expiresAt < new Date()) throw new Error('Refresh token revoked or expired');
  return { payload, record };
}

async function revokeRefreshToken(token) {
  if (!token) return;
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hash(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

async function revokeAllForUser(userId) {
  await prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}

module.exports = {
  signAccessToken, verifyAccessToken, issueRefreshToken,
  verifyRefreshToken, revokeRefreshToken, revokeAllForUser, REFRESH_DAYS,
};
