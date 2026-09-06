/**
 * Super Admin bootstrap utility — contract tests.
 *   node tests/bootstrap-super-admin.test.js
 *
 * Exercises the real (test) database via src/lib/prisma, the same way
 * api.test.js does — no mocking of Prisma.
 */
require('dotenv').config();
const assert = require('assert');
const prisma = require('../src/lib/prisma');
const {
  BootstrapError,
  validateEmail,
  validatePassword,
  generatePassword,
  findExistingSuperAdmin,
  bootstrapSuperAdmin,
} = require('../src/lib/superAdminBootstrap');

const results = [];
let failures = 0;
async function test(name, fn) {
  try { await fn(); results.push(['PASS', name]); }
  catch (e) { failures++; results.push(['FAIL', `${name} — ${e.message}`]); }
}

const unique = (label) => `bootstrap-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
const STRONG_PASSWORD = 'Str0ngPassw0rd!!';

async function cleanupByEmail(email) {
  await prisma.user.deleteMany({ where: { email } }).catch(() => {});
}

async function main() {
  // ---------- pure validation
  await test('validateEmail rejects malformed addresses', () => {
    assert.throws(() => validateEmail('not-an-email'), BootstrapError);
    assert.throws(() => validateEmail(''), BootstrapError);
  });

  await test('validateEmail normalizes case and trims', () => {
    assert.strictEqual(validateEmail('  Owner@Example.COM  '), 'owner@example.com');
  });

  await test('validatePassword rejects short passwords', () => {
    assert.throws(() => validatePassword('Sh0rt!'), (e) => e.code === 'WEAK_PASSWORD');
  });

  await test('validatePassword rejects passwords missing a character class', () => {
    assert.throws(() => validatePassword('alllowercase123'), (e) => e.code === 'WEAK_PASSWORD');
    assert.throws(() => validatePassword('ALLUPPERCASE123'), (e) => e.code === 'WEAK_PASSWORD');
    assert.throws(() => validatePassword('NoDigitsHereAtAll'), (e) => e.code === 'WEAK_PASSWORD');
  });

  await test('validatePassword rejects known-weak passwords', () => {
    assert.throws(() => validatePassword('ChangeMe123'), (e) => e.code === 'WEAK_PASSWORD');
  });

  await test('validatePassword accepts a strong password', () => {
    assert.strictEqual(validatePassword(STRONG_PASSWORD), STRONG_PASSWORD);
  });

  await test('generatePassword produces a password that passes validation', () => {
    for (let i = 0; i < 5; i++) {
      const pw = generatePassword();
      assert.doesNotThrow(() => validatePassword(pw));
    }
  });

  // ---------- bootstrapSuperAdmin against the test database
  const emailA = unique('a');
  const emailB = unique('b');

  try {
    await test('bootstrapSuperAdmin creates a platform-level (SUPER_ADMIN-semantic) account', async () => {
      const { user } = await bootstrapSuperAdmin(prisma, { email: emailA, name: 'Test Super Admin', password: STRONG_PASSWORD });
      assert.ok(user.id);
      assert.strictEqual(user.email, emailA);

      const row = await prisma.user.findUnique({ where: { id: user.id } });
      assert.strictEqual(row.role, 'ADMIN');
      assert.strictEqual(row.businessId, null);
      assert.strictEqual(row.isActive, true);
      assert.notStrictEqual(row.passwordHash, STRONG_PASSWORD); // never stored in plaintext

      const bcrypt = require('bcryptjs');
      assert.ok(await bcrypt.compare(STRONG_PASSWORD, row.passwordHash));
    });

    await test('findExistingSuperAdmin finds the account just created', async () => {
      const existing = await findExistingSuperAdmin(prisma);
      assert.ok(existing);
      assert.strictEqual(existing.email, emailA);
    });

    await test('bootstrapSuperAdmin refuses a second account without force', async () => {
      await assert.rejects(
        bootstrapSuperAdmin(prisma, { email: emailB, name: 'Second', password: STRONG_PASSWORD }),
        (e) => e instanceof BootstrapError && e.code === 'SUPER_ADMIN_EXISTS',
      );
      const shouldNotExist = await prisma.user.findUnique({ where: { email: emailB } });
      assert.strictEqual(shouldNotExist, null);
    });

    await test('bootstrapSuperAdmin allows a second account with force', async () => {
      const { user } = await bootstrapSuperAdmin(prisma, { email: emailB, name: 'Second', password: STRONG_PASSWORD, force: true });
      assert.strictEqual(user.email, emailB);
      const row = await prisma.user.findUnique({ where: { id: user.id } });
      assert.strictEqual(row.role, 'ADMIN');
      assert.strictEqual(row.businessId, null);
    });

    await test('bootstrapSuperAdmin refuses a duplicate email', async () => {
      await assert.rejects(
        bootstrapSuperAdmin(prisma, { email: emailA, name: 'Dup', password: STRONG_PASSWORD, force: true }),
        (e) => e instanceof BootstrapError && e.code === 'EMAIL_IN_USE',
      );
    });

    await test('bootstrapSuperAdmin rejects a weak password before touching the database', async () => {
      const email = unique('weak');
      await assert.rejects(
        bootstrapSuperAdmin(prisma, { email, name: 'Weak', password: 'weak', force: true }),
        (e) => e instanceof BootstrapError && e.code === 'WEAK_PASSWORD',
      );
      const row = await prisma.user.findUnique({ where: { email } });
      assert.strictEqual(row, null);
    });

    await test('bootstrap writes an audit trail entry', async () => {
      const email = unique('audited');
      const { user } = await bootstrapSuperAdmin(prisma, { email, name: 'Audited', password: STRONG_PASSWORD, force: true });
      const entry = await prisma.auditLog.findFirst({
        where: { entity: 'User', entityId: user.id },
        orderBy: { createdAt: 'desc' },
      });
      assert.ok(entry, 'expected an AuditLog row for the bootstrapped user');
      assert.strictEqual(entry.action, 'CREATE');
      await cleanupByEmail(email);
    });
  } finally {
    await cleanupByEmail(emailA);
    await cleanupByEmail(emailB);
  }

  console.log('\n──────── SUMMARY ────────');
  for (const [status, name] of results) console.log(`  ${status === 'PASS' ? '✔' : '✘'} ${name}`);
  console.log(failures ? `\n${failures} test(s) failed.\n` : '\nAll tests passed.\n');
  process.exitCode = failures ? 1 : 0;
  await prisma.$disconnect().catch(() => {});
}

main().catch(async (err) => {
  console.error('Bootstrap test run crashed:', err);
  await prisma.$disconnect().catch(() => {});
  process.exitCode = 1;
});
