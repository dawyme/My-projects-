require('dotenv').config();
const prisma = require('../src/lib/prisma');

const DEFAULT_TARGET_EMAIL = 'ndsairconditioning@gmail.com';
const DEFAULT_LEGACY_EMAIL = 'platform@ndsairconditioning.com';

function normalizeEmail(value, fallback) {
  const email = String(value || fallback).trim().toLowerCase();
  if (!email || !email.includes('@')) throw new Error(`Invalid owner email: ${email}`);
  return email;
}

function buildConsolidationPlan({ target, legacy, ndsBusiness }) {
  if (!target) throw new Error('Target Christopher Alexis account not found');
  if (!legacy) throw new Error('Legacy Platform Owner account not found');
  if (target.id === legacy.id) throw new Error('Target and legacy accounts are the same row');
  if (target.businessId && target.businessId !== 'default') {
    throw new Error('Target account is attached to a non-default business; refusing to detach it automatically');
  }
  if (!ndsBusiness || ndsBusiness.isPlatformOwned !== true) {
    throw new Error('N&D business is not marked platform-owned; refusing consolidation');
  }

  return {
    targetId: target.id,
    legacyId: legacy.id,
    targetEmail: target.email,
    legacyEmail: legacy.email,
    targetBusinessIdBefore: target.businessId || null,
    legacyWasActive: legacy.isActive === true,
  };
}

async function loadState(db, targetEmail, legacyEmail) {
  const [target, legacy] = await Promise.all([
    db.user.findUnique({ where: { email: targetEmail }, select: { id: true, name: true, email: true, role: true, businessId: true, isActive: true } }),
    db.user.findUnique({ where: { email: legacyEmail }, select: { id: true, name: true, email: true, role: true, businessId: true, isActive: true } }),
  ]);
  const rows = await db.$queryRaw`SELECT id, "isDefault", "isPlatformOwned" FROM "Business" WHERE id = 'default'`;
  return { target, legacy, ndsBusiness: rows[0] || null };
}

async function consolidatePlatformOwner(db, options = {}) {
  const targetEmail = normalizeEmail(options.targetEmail, DEFAULT_TARGET_EMAIL);
  const legacyEmail = normalizeEmail(options.legacyEmail, DEFAULT_LEGACY_EMAIL);
  const state = await loadState(db, targetEmail, legacyEmail);
  const plan = buildConsolidationPlan(state);

  if (options.dryRun !== false) {
    return { dryRun: true, plan };
  }

  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: plan.targetId },
      data: { role: 'ADMIN', businessId: null, isActive: true },
    });

    await tx.refreshToken.updateMany({
      where: { userId: plan.legacyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    // Retire rather than delete the duplicate identity so existing audit/history
    // rows keep their original actor reference.
    await tx.user.update({
      where: { id: plan.legacyId },
      data: { isActive: false },
    });

    const activePlatformOwners = await tx.user.count({
      where: { role: 'ADMIN', businessId: null, isActive: true },
    });
    if (activePlatformOwners !== 1) {
      throw new Error(`Expected exactly one active platform owner after consolidation; found ${activePlatformOwners}`);
    }
  });

  const verified = await loadState(db, targetEmail, legacyEmail);
  const activePlatformOwners = await db.user.count({
    where: { role: 'ADMIN', businessId: null, isActive: true },
  });
  if (verified.target.businessId !== null || verified.target.role !== 'ADMIN' || verified.target.isActive !== true) {
    throw new Error('Post-consolidation target verification failed');
  }
  if (verified.legacy.isActive !== false) throw new Error('Post-consolidation legacy verification failed');
  if (activePlatformOwners !== 1) throw new Error(`Post-consolidation platform-owner count is ${activePlatformOwners}`);

  return {
    dryRun: false,
    plan,
    verified: {
      target: { id: verified.target.id, email: verified.target.email, role: verified.target.role, businessId: verified.target.businessId, isActive: verified.target.isActive },
      legacy: { id: verified.legacy.id, email: verified.legacy.email, isActive: verified.legacy.isActive },
      activePlatformOwners,
      ndsPlatformOwned: verified.ndsBusiness?.isPlatformOwned === true,
    },
  };
}

async function main() {
  const apply = process.env.PLATFORM_OWNER_CONSOLIDATION_ACK === 'YES';
  const result = await consolidatePlatformOwner(prisma, {
    targetEmail: process.env.PLATFORM_OWNER_TARGET_EMAIL,
    legacyEmail: process.env.PLATFORM_OWNER_LEGACY_EMAIL,
    dryRun: !apply,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!apply) console.log('Dry run only. Set PLATFORM_OWNER_CONSOLIDATION_ACK=YES to apply the transaction.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  }).finally(async () => {
    await prisma.$disconnect();
  });
}

module.exports = { buildConsolidationPlan, consolidatePlatformOwner, normalizeEmail };
