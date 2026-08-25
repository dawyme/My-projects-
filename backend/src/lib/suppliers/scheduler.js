/**
 * In-process scheduler for automatic supplier synchronisation.
 *
 * The platform has no external job runner (no Redis/Bull/SQS in this stack), so
 * scheduling is a single guarded interval owned by the API process. It is
 * deliberately conservative:
 *
 *   • the interval callback never throws into the event loop
 *   • only one sweep runs at a time (re-entrancy guard)
 *   • every sync it starts goes through the normal engine, so the concurrency
 *     cap, overlap lock, batching and logging all still apply
 *   • stale runs left RUNNING by a restart are recovered on every sweep
 *
 * On a multi-instance deployment run this on ONE instance only (set
 * SUPPLIER_SCHEDULER_DISABLED=true elsewhere) — documented in
 * docs/SUPPLIER_MARKETPLACE.md §Scheduling.
 */
const syncEngine = require('./sync-engine');
const marketplaceSettings = require('./settings');

const DEFAULT_TICK_MS = 60 * 1000;

let timer = null;
let sweeping = false;
let lastRunAt = null;
let lastResult = null;
let lastError = null;
let sweeps = 0;

async function tick() {
  if (sweeping) return;
  sweeping = true;
  sweeps++;
  try {
    const recovered = await syncEngine.recoverStale({ olderThanMinutes: 30 });
    const result = await syncEngine.runScheduled();
    lastRunAt = new Date();
    lastResult = { ...result, recovered };
    lastError = null;
  } catch (err) {
    lastError = err.message;
    lastRunAt = new Date();
  } finally {
    sweeping = false;
  }
}

function start({ intervalMs = DEFAULT_TICK_MS } = {}) {
  if (timer) return { started: false, reason: 'already running' };
  if (process.env.SUPPLIER_SCHEDULER_DISABLED === 'true') {
    return { started: false, reason: 'SUPPLIER_SCHEDULER_DISABLED=true' };
  }
  timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  // One immediate sweep so a freshly started process does not wait a full tick.
  setTimeout(() => { tick().catch(() => {}); }, 2000).unref?.();
  return { started: true, intervalMs };
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  return { stopped: true };
}

async function status() {
  const settings = await marketplaceSettings.read('default'); // automation sweeps the platform's default tenant
  return {
    running: Boolean(timer),
    autoSyncEnabled: settings.autoSyncEnabled,
    syncIntervalMinutes: settings.syncIntervalMinutes,
    syncConcurrency: settings.syncConcurrency,
    sweeps, sweeping,
    lastRunAt, lastResult, lastError,
    disabledByEnv: process.env.SUPPLIER_SCHEDULER_DISABLED === 'true',
  };
}

/** Runs one sweep immediately (used by the "Run now" button and by tests). */
async function runNow() {
  await tick();
  return { lastRunAt, lastResult, lastError };
}

module.exports = { start, stop, status, runNow, tick };
