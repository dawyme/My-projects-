'use strict';

/**
 * Tenant-safe integration event log.
 *
 * Every Gateway operation records one IntegrationEvent row: provider,
 * operation, success/failure, timestamp, external reference, error category
 * and retry status. The log is the tenant-visible audit trail behind
 * "last successful sync / last error" and the handoff point a future
 * settlement/reconciliation job will consume.
 *
 * Security rules (enforced here, not left to callers):
 *   • rows are ALWAYS stamped with the caller's tenant — there is no
 *     unscoped write path
 *   • `errorMessage` is truncated and secret-scrubbed before insert
 *   • `metadata` is structurally redacted (`redact()`) before insert
 *   • logging failures never break the request (the operation result wins)
 */

const prisma = require('../prisma');
const { redact, redactString } = require('./credentials');

const OPERATIONS = [
  'configure',
  'connect',
  'testConnection',
  'createPayment',
  'getPaymentStatus',
  'verifyPayment',
  'refundPayment',
  'voidPayment',
  'createPaymentLink',
  'receiveWebhook',
  'reconcile',
  'importStatement',
  'disconnect',
  'connectionCreated',
  'connectionUpdated',
  'connectionDeleted',
];

/**
 * Records an integration event. Never throws.
 * @returns {Promise<object|null>} the created row, or null when logging failed
 */
async function logEvent({
  tenantId,
  connectionId = null,
  providerId = null,
  operation,
  success,
  externalReference = null,
  errorCategory = null,
  errorMessage = null,
  retryable = false,
  metadata = null,
} = {}) {
  try {
    if (!tenantId || !operation) return null;
    const safeMetadata = metadata === null || metadata === undefined
      ? null
      : JSON.stringify(redact(metadata)).slice(0, 4000);
    return await prisma.integrationEvent.create({
      data: {
        businessId: tenantId,
        connectionId: connectionId || null,
        providerId: providerId ? String(providerId).slice(0, 80) : null,
        operation: String(operation).slice(0, 60),
        success: Boolean(success),
        externalReference: externalReference ? String(externalReference).slice(0, 200) : null,
        errorCategory: errorCategory ? String(errorCategory).slice(0, 40) : null,
        errorMessage: errorMessage ? redactString(String(errorMessage)).slice(0, 500) : null,
        retryable: Boolean(retryable),
        metadata: safeMetadata,
      },
    });
  } catch (_) {
    return null;
  }
}

/** Parses a stored event row for API responses. */
function presentEvent(row) {
  if (!row) return row;
  let metadata = null;
  try { metadata = row.metadata ? JSON.parse(row.metadata) : null; } catch (_) { metadata = null; }
  return { ...row, metadata };
}

module.exports = { logEvent, presentEvent, OPERATIONS };
