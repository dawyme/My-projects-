/**
 * Super Admin bootstrap — core logic.
 *
 * A "Super Admin" is not a distinct role value in the database. Per
 * `src/lib/permissions.js`'s `roleFor()`, the semantic role SUPER_ADMIN is
 * derived at request time from a User whose raw `role` is `'ADMIN'` and
 * whose `businessId` is `null` (a platform-level account with no tenant
 * binding — see `isPlatformAdmin()` in `src/lib/tenant.js`).
 *
 * This module contains the pure/testable logic used by the CLI wrapper in
 * `scripts/bootstrap-super-admin.js`. It performs no I/O other than the
 * Prisma calls the caller explicitly asks for, and never touches
 * `process.argv`, `process.env`, or stdin — that belongs to the CLI layer.
 */
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const BCRYPT_COST = 12; // matches src/routes/users.js
const MIN_PASSWORD_LENGTH = 12; // stricter than the ordinary 8-char staff/customer minimum
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WEAK_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'changeme', 'changeme123',
  'admin', 'administrator', 'superadmin', 'letmein', 'welcome1',
]);

class BootstrapError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BootstrapError';
    this.code = code;
  }
}

/** Validates an email address (shape only — uniqueness is checked against the DB separately). */
function validateEmail(email) {
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    throw new BootstrapError('INVALID_EMAIL', 'A valid email address is required');
  }
  return email.trim().toLowerCase();
}

/**
 * Validates password strength. Deliberately stricter than the ordinary
 * staff/customer policy in src/routes/users.js, since this account has
 * platform-wide (SUPER_ADMIN) permissions across every tenant.
 */
function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new BootstrapError('WEAK_PASSWORD', `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    throw new BootstrapError('WEAK_PASSWORD', 'Password must contain upper case, lower case, and a number');
  }
  if (WEAK_PASSWORDS.has(password.toLowerCase())) {
    throw new BootstrapError('WEAK_PASSWORD', 'Password is on a known weak-password list');
  }
  return password;
}

/** Generates a random password that satisfies validatePassword(). */
function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#%^&*-_=+';
  let out = '';
  // 24 random chars is comfortably above MIN_PASSWORD_LENGTH and high entropy.
  const bytes = crypto.randomBytes(24);
  for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
  // Guarantee the character-class requirements deterministically rather than by luck.
  out = `Aa1${out}`;
  return out;
}

/** Finds an existing platform-level (semantic SUPER_ADMIN) account, if any. */
async function findExistingSuperAdmin(prisma) {
  return prisma.user.findFirst({
    where: { role: 'ADMIN', businessId: null },
    select: { id: true, email: true, name: true, isActive: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Creates a platform-level Super Admin account.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{ email: string, name?: string, password: string, force?: boolean }} options
 * @returns {Promise<{ user: { id: string, email: string, name: string } }>}
 *
 * Throws BootstrapError with a `.code` of:
 *   INVALID_EMAIL       — malformed email
 *   WEAK_PASSWORD        — fails the password policy
 *   EMAIL_IN_USE         — a user (any role) already has this email
 *   SUPER_ADMIN_EXISTS   — a platform-level admin already exists and `force` was not set
 */
async function bootstrapSuperAdmin(prisma, options = {}) {
  const email = validateEmail(options.email);
  const name = (options.name || 'Super Admin').trim().slice(0, 120) || 'Super Admin';
  const password = validatePassword(options.password);

  const existingBySameEmail = await prisma.user.findUnique({ where: { email } });
  if (existingBySameEmail) {
    throw new BootstrapError('EMAIL_IN_USE', `A user with email ${email} already exists`);
  }

  if (!options.force) {
    const existingSuperAdmin = await findExistingSuperAdmin(prisma);
    if (existingSuperAdmin) {
      throw new BootstrapError(
        'SUPER_ADMIN_EXISTS',
        `A Super Admin account already exists (${existingSuperAdmin.email}). Re-run with force to create an additional one.`,
      );
    }
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const user = await prisma.user.create({
    data: { name, email, passwordHash, role: 'ADMIN', businessId: null, isActive: true },
  });

  // Reuse the codebase's existing audit/activity helpers so this shows up
  // in the same trails as every other admin action — see src/lib/audit.js.
  // The bootstrap runs outside an HTTP request, so we hand it a minimal
  // req-like shape rather than duplicating its logic.
  try {
    const { audit, activity } = require('./audit');
    const fauxReq = { tenantId: 'default', user: { id: null }, ip: null, get: () => 'bootstrap-cli' };
    await audit(fauxReq, 'CREATE', 'User', user.id, { email: user.email, role: user.role, bootstrap: true });
    await activity(null, 'system', `Super Admin account bootstrapped for ${user.email}`, { userId: user.id });
  } catch (_) {
    // Auditing must never fail the bootstrap itself (matches lib/audit.js's own contract).
  }

  return { user: { id: user.id, email: user.email, name: user.name } };
}

module.exports = {
  BootstrapError,
  MIN_PASSWORD_LENGTH,
  validateEmail,
  validatePassword,
  generatePassword,
  findExistingSuperAdmin,
  bootstrapSuperAdmin,
};
