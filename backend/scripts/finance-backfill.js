#!/usr/bin/env node
/**
 * Copies pre-existing paid orders, POS sales, POS refunds and paid invoices
 * into the Financial Management ledger.
 *
 *   node backend/scripts/finance-backfill.js                # DRY RUN (default): reports, writes NOTHING
 *   node backend/scripts/finance-backfill.js --apply        # writes — only after you have reviewed the dry run
 *   node backend/scripts/finance-backfill.js --business <id>
 *
 * Idempotent: every row uses the same idempotency key the live code uses, so it
 * can be re-run, and live captures that already wrote a row are skipped.
 * Never deletes or edits any legacy record. Orders/invoices without a recorded
 * payment date use their best available date and are flagged estimatedDate.
 * NEVER point this at production without a backup and explicit approval.
 */
const prisma = require('../src/lib/prisma');
const ledger = require('../src/lib/finance/ledger');
const { fromCents, toCents } = require('../src/lib/finance/money');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const only = args.includes('--business') ? args[args.indexOf('--business') + 1] : null;

class DryRunRollback extends Error {}
const stats = {};
const bump = (kind, outcome, cents = 0, estimated = false) => {
  const s = (stats[kind] ||= { created: 0, alreadyRecorded: 0, failed: 0, cents: 0, estimatedDates: 0 });
  s[outcome]++; if (outcome === 'created') { s.cents += cents; if (estimated) s.estimatedDates++; }
};

/** Runs fn in its own transaction; in dry-run mode the transaction is always rolled back. */
async function unit(kind, fn) {
  let outcome = null;
  try {
    await prisma.$transaction(async (tx) => {
      outcome = await fn(tx);
      if (!APPLY) throw new DryRunRollback();
    });
  } catch (e) {
    if (!(e instanceof DryRunRollback)) { bump(kind, 'failed'); console.error(`  ! ${kind} failed: ${e.message}`); return; }
  }
  if (!outcome || !outcome.record) return;
  if (outcome.created) bump(kind, 'created', toCents(outcome.record.amount), outcome.record.estimatedDate); else bump(kind, 'alreadyRecorded');
}

async function run() {
  const host = (() => { try { return new URL(process.env.DATABASE_URL || '').host || 'local file'; } catch { return 'local file'; } })();
  console.log(`Finance backfill — ${APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'} — database: ${host}`);
  const businesses = await prisma.business.findMany({ where: only ? { id: only } : {}, select: { id: true, name: true } });
  for (const b of businesses) {
    console.log(`\nBusiness ${b.id} (${b.name})`);
    const orders = await prisma.order.findMany({ where: { businessId: b.id, paymentStatus: { in: ['PAID', 'REFUNDED'] } } });
    for (const o of orders) {
      await unit('order payments', (tx) => ledger.recordOrderPayment(tx, o, { estimated: true }));
      if (o.paymentStatus === 'REFUNDED') await unit('order refunds', async (tx) => (await ledger.recordOrderRefund(tx, o, { at: o.updatedAt })));
    }
    const sales = await prisma.sale.findMany({ where: { businessId: b.id, status: { not: 'VOIDED' } }, include: { refunds: true } });
    for (const s of sales) {
      await unit('POS payments', (tx) => ledger.recordSalePayment(tx, s));
      for (const r of s.refunds) await unit('POS refunds', (tx) => ledger.recordSaleRefund(tx, s, r));
    }
    const invoices = await prisma.invoice.findMany({ where: { businessId: b.id, status: 'PAID' } });
    for (const i of invoices) {
      const has = await prisma.financialTransaction.count({ where: { businessId: b.id, invoiceId: i.id } });
      if (has) { bump('invoice payments', 'alreadyRecorded'); continue; } // the live ledger already holds this invoice's money
      await unit('invoice payments', (tx) => ledger.recordLegacyInvoicePayment(tx, i));
    }
  }
  console.log('\nSummary');
  for (const [kind, s] of Object.entries(stats)) {
    console.log(`  ${kind}: ${APPLY ? 'created' : 'would create'} ${s.created} (TTD ${fromCents(s.cents)}, ${s.estimatedDates} with estimated dates), already recorded ${s.alreadyRecorded}, failed ${s.failed}`);
  }
  if (!Object.keys(stats).length) console.log('  nothing to backfill');
  if (!APPLY) console.log('\nDry run only — nothing was written. Re-run with --apply after review.');
}

run().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
