#!/usr/bin/env node
/**
 * Bootstrap a platform-level Super Admin account.
 *
 * SAFE BY DEFAULT: without --confirm this is a dry run — it validates
 * input and checks for an existing Super Admin, but never writes to the
 * database. Nothing is created until --confirm is passed explicitly, and
 * production additionally requires SUPER_ADMIN_BOOTSTRAP_PRODUCTION_ACK=yes
 * so a copy-pasted command can't silently provision a production account.
 *
 * Usage:
 *   node scripts/bootstrap-super-admin.js --email=owner@example.com [options]
 *
 * Options:
 *   --email=<email>       Required (or SUPER_ADMIN_EMAIL env var).
 *   --name=<name>         Optional, defaults to "Super Admin".
 *   --password=<pw>       Optional. If omitted, a strong password is
 *                         generated and printed once — store it immediately.
 *   --force               Allow creating an additional Super Admin even if
 *                         one already exists.
 *   --confirm             Actually write to the database. Without this
 *                         flag the script only validates and reports.
 *   --json                Emit machine-readable JSON instead of text.
 *   --help                Show this message.
 *
 * Production guard:
 *   If NODE_ENV=production, --confirm alone is not enough. You must also
 *   set SUPER_ADMIN_BOOTSTRAP_PRODUCTION_ACK=yes for the same invocation,
 *   e.g.:
 *     SUPER_ADMIN_BOOTSTRAP_PRODUCTION_ACK=yes \
 *       node scripts/bootstrap-super-admin.js --email=owner@ndsairconditioning.com --confirm
 *
 * This script performs no other side effects: it does not print the
 * password anywhere but stdout, does not write it to a log file, and does
 * not phone home. Rotate any generated password after first login if your
 * process requires it.
 */
require('dotenv').config();
const {
  BootstrapError,
  validateEmail,
  validatePassword,
  generatePassword,
  findExistingSuperAdmin,
  bootstrapSuperAdmin,
} = require('../src/lib/superAdminBootstrap');

function parseFlags(argv) {
  const flags = { confirm: false, force: false, json: false, help: false };
  for (const arg of argv) {
    if (arg === '--confirm') flags.confirm = true;
    else if (arg === '--force') flags.force = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg.startsWith('--email=')) flags.email = arg.slice('--email='.length);
    else if (arg.startsWith('--name=')) flags.name = arg.slice('--name='.length);
    else if (arg.startsWith('--password=')) flags.password = arg.slice('--password='.length);
  }
  return flags;
}

function printHelp() {
  console.log(`Usage: node scripts/bootstrap-super-admin.js --email=<email> [options]

Options:
  --email=<email>   Required (or SUPER_ADMIN_EMAIL env var)
  --name=<name>     Optional, defaults to "Super Admin"
  --password=<pw>   Optional; a strong password is generated if omitted
  --force           Allow an additional Super Admin if one already exists
  --confirm         Actually write to the database (omit for a dry run)
  --json            Emit JSON output
  --help            Show this message

Without --confirm, nothing is written — this only validates and reports
what would happen. See the file header for the production-write guard.`);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) { printHelp(); return; }

  const email = flags.email || process.env.SUPER_ADMIN_EMAIL;
  const name = flags.name || process.env.SUPER_ADMIN_NAME || 'Super Admin';
  let password = flags.password || process.env.SUPER_ADMIN_PASSWORD;
  let generated = false;

  const out = (obj, text) => {
    if (flags.json) console.log(JSON.stringify(obj, null, 2));
    else console.log(text);
  };

  try {
    validateEmail(email || '');
  } catch (e) {
    out({ ok: false, code: 'INVALID_EMAIL' }, 'Error: --email=<email> (or SUPER_ADMIN_EMAIL) is required and must be a valid address.');
    process.exitCode = 1;
    return;
  }

  if (!password) {
    password = generatePassword();
    generated = true;
  }
  try {
    validatePassword(password);
  } catch (e) {
    out({ ok: false, code: e.code, message: e.message }, `Error: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  // Prisma is required lazily so --help works without a configured database.
  const prisma = require('../src/lib/prisma');

  try {
    const existing = await findExistingSuperAdmin(prisma);
    if (existing && !flags.force) {
      out(
        { ok: false, code: 'SUPER_ADMIN_EXISTS', existing: { email: existing.email, createdAt: existing.createdAt } },
        `A Super Admin already exists (${existing.email}, created ${existing.createdAt.toISOString()}).\n` +
        `Re-run with --force to create an additional account, or manage the existing one instead.`,
      );
      process.exitCode = 1;
      return;
    }

    if (!flags.confirm) {
      out(
        { ok: true, dryRun: true, wouldCreate: { email: email.toLowerCase(), name } },
        `DRY RUN — nothing was written.\n` +
        `Would create Super Admin: ${email.toLowerCase()} (${name})${existing ? ' [additional, --force]' : ''}\n` +
        `Re-run with --confirm to actually create the account.`,
      );
      return;
    }

    if (process.env.NODE_ENV === 'production' && process.env.SUPER_ADMIN_BOOTSTRAP_PRODUCTION_ACK !== 'yes') {
      out(
        { ok: false, code: 'PRODUCTION_ACK_REQUIRED' },
        `Refusing to write: NODE_ENV=production requires SUPER_ADMIN_BOOTSTRAP_PRODUCTION_ACK=yes\n` +
        `in addition to --confirm. This is a deliberate double-confirmation for the\n` +
        `most privileged account in the system — see the script header for the exact command.`,
      );
      process.exitCode = 1;
      return;
    }

    const result = await bootstrapSuperAdmin(prisma, { email, name, password, force: flags.force });

    out(
      { ok: true, user: result.user, generatedPassword: generated ? password : undefined },
      `Super Admin created.\n` +
      `  id:    ${result.user.id}\n` +
      `  email: ${result.user.email}\n` +
      `  name:  ${result.user.name}\n` +
      (generated
        ? `\n  Generated password (shown once — store it securely now):\n    ${password}\n`
        : ''),
    );
  } catch (e) {
    if (e instanceof BootstrapError) {
      out({ ok: false, code: e.code, message: e.message }, `Error: ${e.message}`);
      process.exitCode = 1;
      return;
    }
    throw e;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

main().catch((err) => {
  console.error('Unexpected error during Super Admin bootstrap:', err);
  process.exitCode = 1;
});
