'use strict';

/**
 * Universal Integration Gateway API.
 *
 * Management (tenant admin only — credentials-adjacent):
 *   GET    /api/integrations/providers              provider catalogue
 *   GET    /api/integrations                        list tenant connections
 *   POST   /api/integrations                        create a connection + store secrets
 *   GET    /api/integrations/:id                    detail (secrets masked)
 *   PUT    /api/integrations/:id                    update connection / rotate secrets
 *   POST   /api/integrations/:id/test               test the connection
 *   POST   /api/integrations/:id/connect            establish the session
 *   POST   /api/integrations/:id/disconnect         close the session (secrets kept)
 *   POST   /api/integrations/:id/payments           initiate a payment
 *   GET    /api/integrations/:id/payments/:reference poll a payment's status
 *   POST   /api/integrations/:id/refunds            refund a payment
 *   GET    /api/integrations/:id/events             secret-scrubbed event log
 *   DELETE /api/integrations/:id                    remove (destroys secrets)
 *
 * Webhooks (no session auth by design — provider servers cannot log in):
 *   POST   /api/integrations/webhooks/:providerId/:webhookToken
 * mounted with a raw-body parser before CSRF in app.js, exactly like the
 * existing payment webhooks. Unknown provider → 404, unknown token → 404,
 * bad signature → 401; only verified payloads are ever parsed.
 *
 * Tenant isolation: every query is scoped with the server-resolved tenant
 * (`tenantOf(req)` — never a client-supplied businessId, which zod strips).
 * Misses return 404 so Tenant A can never discover Tenant B's connections.
 *
 * Credential handling (mirrors supplier-integrations.js):
 *   • secrets arrive in the request body and are encrypted immediately
 *   • they are stored ONLY in `credentialsCipher` (AES-256-GCM)
 *   • responses carry `credentialFields` fingerprints — never plaintext
 *   • on update, omitting a field keeps the secret; `null` clears it
 */

const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const asyncHandler = require('../lib/async');
const { validate } = require('../middleware/validate');
const { protect, adminOnly } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { tenantOf, platformAdminOnly } = require('../lib/tenant');
const { paginationSchema, meta } = require('../lib/pagination');
const { badRequest, notFound, conflict } = require('../lib/errors');
const { audit, activity } = require('../lib/audit');
const registry = require('../lib/integrations/registry');
const gateway = require('../lib/integrations/gateway');
const integrationCredentials = require('../lib/integrations/credentials');
const { logEvent, presentEvent } = require('../lib/integrations/events');
const { CONNECTION_METHOD_IDS, IntegrationError } = require('../lib/integrations/base');
const cache = require('../lib/cache');

const router = express.Router();
const webhookRouter = express.Router();

/** Translates Gateway IntegrationErrors into stable HTTP responses. */
const gatewayHandler = (fn) => asyncHandler(async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (err) {
    if (err && (err instanceof IntegrationError || err.notFound || err.unauthorized)) {
      const http = gateway.toHttpError(err);
      return res.status(http.status).json({
        success: false,
        error: http.message,
        code: http.code,
        ...(http.category ? { category: http.category, retryable: http.retryable } : {}),
      });
    }
    return next(err);
  }
});

const AUTH_TYPES = ['NONE', 'API_KEY', 'BASIC', 'BEARER', 'OAUTH2', 'SFTP'];

const connectionBody = z.object({
  providerId: z.string().trim().min(2).max(80).toUpperCase(),
  name: z.string().trim().min(2).max(120),
  authType: z.enum(AUTH_TYPES).default('NONE'),
  connectionMethod: z.string().trim().max(40).toUpperCase().optional().nullable(),
  config: z.record(z.any()).optional().nullable(),
  credentials: z.record(z.union([z.string(), z.null()])).optional().nullable(),
});

// NOTE: deliberately not `connectionBody.partial()` — partial() preserves the
// create-time `.default()`s, which would silently reset authType to NONE on
// every update that omits it. Updates must leave absent fields untouched.
const updateBody = z.object({
  providerId: z.string().trim().min(2).max(80).toUpperCase().optional(),
  name: z.string().trim().min(2).max(120).optional(),
  authType: z.enum(AUTH_TYPES).optional(),
  connectionMethod: z.string().trim().max(40).toUpperCase().optional().nullable(),
  config: z.record(z.any()).optional().nullable(),
  credentials: z.record(z.union([z.string(), z.null()])).optional().nullable(),
});

const paymentBody = z.object({
  amount: z.coerce.number().positive().max(1000000000),
  currency: z.string().trim().length(3).toUpperCase().default('USD'),
  reference: z.string().trim().min(1).max(200),
  description: z.string().trim().max(300).optional().nullable(),
  customer: z.object({
    name: z.string().trim().max(120).optional().nullable(),
    email: z.string().trim().max(180).optional().nullable(),
    phone: z.string().trim().max(40).optional().nullable(),
  }).optional().nullable(),
  returnUrls: z.object({
    success: z.string().trim().max(500).optional().nullable(),
    cancel: z.string().trim().max(500).optional().nullable(),
  }).optional().nullable(),
});

const refundBody = z.object({
  reference: z.string().trim().min(1).max(200),
  amount: z.coerce.number().positive().max(1000000000).optional().nullable(),
});

router.use(protect, adminOnly);

/**
 * Merges an incoming `credentials` object with what is already stored.
 * Omitted keys keep their secret; explicit null clears it; '' is treated as
 * "no change" so a form that re-submits a masked field cannot wipe a secret.
 */
function mergeSecrets(existingPlain, incoming) {
  const next = { ...existingPlain };
  const submitted = {};
  const cleared = [];
  for (const [key, value] of Object.entries(incoming || {})) {
    if (value === undefined || value === '') continue;
    if (value === null) { delete next[key]; cleared.push(key); continue; }
    next[key] = String(value);
    submitted[key] = String(value);
  }
  return { next, submitted, cleared };
}

function snapshotCapabilities(connection) {
  try {
    return gateway.capabilityMatrix(connection).filter((c) => c.supported).map((c) => c.id);
  } catch (_) {
    return [];
  }
}

function validateProviderSelection(providerId, authType, connectionMethod) {
  const Provider = registry.get(providerId);
  if (!Provider) {
    throw badRequest(`Unknown provider "${providerId}"`, [
      { field: 'providerId', message: 'Select one of the registered providers from GET /api/integrations/providers' },
    ]);
  }
  if (authType && !Provider.authTypes.includes(authType)) {
    throw badRequest(`${Provider.label} does not support ${authType} authentication`, [
      { field: 'authType', message: `Supported: ${Provider.authTypes.join(', ')}` },
    ]);
  }
  if (connectionMethod) {
    if (!CONNECTION_METHOD_IDS.includes(connectionMethod)) {
      throw badRequest(`Unknown connection method "${connectionMethod}"`, [
        { field: 'connectionMethod', message: `Supported: ${CONNECTION_METHOD_IDS.join(', ')}` },
      ]);
    }
    if (Provider.connectionMethods.length && !Provider.connectionMethods.includes(connectionMethod)) {
      throw badRequest(`${Provider.label} does not support the ${connectionMethod} connection method`, [
        { field: 'connectionMethod', message: `Supported: ${Provider.connectionMethods.join(', ')}` },
      ]);
    }
  }
  return Provider;
}

// GET /api/integrations/providers — available integrations catalogue.
router.get('/providers', asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: registry.list(),
    meta: {
      categories: registry.categories(),
      capabilities: registry.capabilities(),
      connectionMethods: registry.connectionMethods(),
    },
  });
}));

/* =====================================================================
 * Platform Owner (SUPER_ADMIN) — read-only, cross-tenant visibility for
 * "Platform → Universal Integrations".
 *
 * These three GET endpoints are the ONLY cross-tenant surface of the
 * Integration Gateway API. They are strictly read-only (no POST/PUT/PATCH/
 * DELETE), guarded by `platformAdminOnly`, and return an explicit safe-field
 * allowlist: tenant/business name, provider, connection name, category,
 * status, capabilities and timestamps. They NEVER return `credentialsCipher`,
 * plaintext secrets, credential descriptors, connection config or webhook
 * tokens — a platform owner manages tenants, never their secrets.
 *
 * They MUST stay registered above the `/:id` routes so `/platform/*` can
 * never be mistaken for a connection id.
 * ===================================================================== */

/** Cross-tenant connection shape: safe fields only (see block comment above). */
function platformConnection(row) {
  const Provider = registry.get(row.providerId);
  return {
    id: row.id,
    businessId: row.businessId,
    businessName: row.business?.name || row.businessId,
    providerId: row.providerId,
    providerLabel: Provider ? Provider.label : row.providerId,
    providerCategory: row.providerCategory,
    name: row.name,
    authType: row.authType,
    connectionMethod: row.connectionMethod,
    capabilities: gateway.parseJson(row.capabilities, []),
    status: row.status,
    lastTestedAt: row.lastTestedAt,
    lastConnectedAt: row.lastConnectedAt,
    lastSyncAt: row.lastSyncAt,
    lastSyncStatus: row.lastSyncStatus,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Cross-tenant event shape: the scrubbed event plus tenant/connection names. */
function platformEvent(row) {
  const { business, connection, ...rest } = row;
  return {
    ...presentEvent(rest),
    businessName: business?.name || row.businessId,
    connectionName: connection?.name || null,
  };
}

const businessInclude = {
  business: { select: { id: true, name: true } },
  connection: { select: { id: true, name: true } },
};

// GET /api/integrations/platform/overview — platform-wide integration stats.
router.get('/platform/overview', platformAdminOnly, asyncHandler(async (req, res) => {
  const providers = registry.list();
  const [
    totalConnections,
    byStatus,
    byProviderStatus,
    tenantsWithConnections,
    connectedTenants,
    totalEvents,
    failedEvents,
    webhookEvents,
    recentEvents,
    failedConnections,
    recentWebhooks,
  ] = await Promise.all([
    prisma.integrationConnection.count(),
    prisma.integrationConnection.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.integrationConnection.groupBy({ by: ['providerId', 'status'], _count: { _all: true } }),
    prisma.integrationConnection.groupBy({ by: ['businessId'] }),
    prisma.integrationConnection.groupBy({ by: ['businessId'], where: { status: 'CONNECTED' } }),
    prisma.integrationEvent.count(),
    prisma.integrationEvent.count({ where: { success: false } }),
    prisma.integrationEvent.count({ where: { operation: 'receiveWebhook' } }),
    prisma.integrationEvent.findMany({
      orderBy: { createdAt: 'desc' }, take: 10, include: businessInclude,
    }),
    prisma.integrationConnection.findMany({
      where: { status: 'ERROR' }, orderBy: { updatedAt: 'desc' }, take: 10,
      include: { business: { select: { id: true, name: true } } },
    }),
    prisma.integrationEvent.findMany({
      where: { operation: 'receiveWebhook' }, orderBy: { createdAt: 'desc' }, take: 10,
      include: businessInclude,
    }),
  ]);

  const byCategory = new Map();
  for (const p of providers) byCategory.set(p.category, (byCategory.get(p.category) || 0) + 1);

  const providerStats = new Map();
  for (const row of byProviderStatus) {
    const entry = providerStats.get(row.providerId) || { total: 0, connected: 0, error: 0 };
    entry.total += row._count._all;
    if (row.status === 'CONNECTED') entry.connected += row._count._all;
    if (row.status === 'ERROR') entry.error += row._count._all;
    providerStats.set(row.providerId, entry);
  }

  res.json({
    success: true,
    data: {
      providers: {
        // Every registered provider is connectable — PR #68 defines no
        // provider-level disable flag, so available === total by design.
        total: providers.length,
        available: providers.length,
        byCategory: [...byCategory.entries()].map(([id, count]) => ({ id, count })),
      },
      connections: {
        total: totalConnections,
        byStatus: byStatus.map((r) => ({ status: r.status, count: r._count._all })),
        byProvider: [...providerStats.entries()].map(([providerId, stats]) => {
          const Provider = registry.get(providerId);
          return {
            providerId,
            label: Provider ? Provider.label : providerId,
            category: Provider ? Provider.category : null,
            ...stats,
          };
        }),
      },
      tenants: {
        withConnections: tenantsWithConnections.length,
        connected: connectedTenants.length,
      },
      events: { total: totalEvents, failed: failedEvents, webhooks: webhookEvents },
      recentEvents: recentEvents.map(platformEvent),
      failedConnections: failedConnections.map(platformConnection),
      recentWebhooks: recentWebhooks.map(platformEvent),
    },
  });
}));

// GET /api/integrations/platform/connections — every tenant's connections, safe fields only.
router.get('/platform/connections', platformAdminOnly, validate(paginationSchema.extend({
  providerId: z.string().optional(),
  status: z.string().optional(),
  category: z.string().optional(),
  businessId: z.string().optional(),
}), 'query'), asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const where = {};
  if (q.providerId) where.providerId = q.providerId.toUpperCase();
  if (q.status) where.status = q.status.toUpperCase();
  if (q.category) where.providerCategory = q.category.toUpperCase();
  if (q.businessId) where.businessId = q.businessId;
  if (q.search) {
    where.OR = [
      { name: { contains: q.search } },
      { providerId: { contains: q.search.toUpperCase() } },
      { business: { name: { contains: q.search } } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.integrationConnection.findMany({
      where,
      orderBy: { createdAt: q.order },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      include: { business: { select: { id: true, name: true } } },
    }),
    prisma.integrationConnection.count({ where }),
  ]);
  res.json({ success: true, data: items.map(platformConnection), meta: meta(total, q.page, q.limit) });
}));

// GET /api/integrations/platform/events — every tenant's integration activity.
router.get('/platform/events', platformAdminOnly, validate(paginationSchema.extend({
  providerId: z.string().optional(),
  operation: z.string().max(60).optional(),
  success: z.string().max(10).optional(),
  businessId: z.string().optional(),
  connectionId: z.string().optional(),
}), 'query'), asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const where = {};
  if (q.providerId) where.providerId = q.providerId.toUpperCase();
  if (q.operation) where.operation = q.operation;
  if (q.success === 'true') where.success = true;
  else if (q.success === 'false') where.success = false;
  if (q.businessId) where.businessId = q.businessId;
  if (q.connectionId) where.connectionId = q.connectionId;
  if (q.search) {
    where.OR = [
      { externalReference: { contains: q.search } },
      { providerId: { contains: q.search.toUpperCase() } },
      { operation: { contains: q.search } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.integrationEvent.findMany({
      where,
      orderBy: { createdAt: q.order },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      include: businessInclude,
    }),
    prisma.integrationEvent.count({ where }),
  ]);
  res.json({ success: true, data: items.map(platformEvent), meta: meta(total, q.page, q.limit) });
}));

// GET /api/integrations — connected integrations for this tenant.
router.get('/', validate(paginationSchema.extend({
  providerId: z.string().optional(),
  status: z.string().optional(),
  category: z.string().optional(),
}), 'query'), asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const where = { businessId: tenantOf(req) };
  if (q.providerId) where.providerId = q.providerId.toUpperCase();
  if (q.status) where.status = q.status.toUpperCase();
  if (q.category) where.providerCategory = q.category.toUpperCase();
  if (q.search) where.OR = [{ name: { contains: q.search } }, { providerId: { contains: q.search.toUpperCase() } }];

  const [items, total] = await Promise.all([
    prisma.integrationConnection.findMany({
      where, orderBy: { createdAt: q.order }, skip: (q.page - 1) * q.limit, take: q.limit,
    }),
    prisma.integrationConnection.count({ where }),
  ]);
  res.json({
    success: true,
    data: items.map((i) => {
      const Provider = registry.get(i.providerId);
      return {
        ...gateway.safeConnection(i),
        provider: Provider ? { id: i.providerId, label: Provider.label, category: Provider.category } : null,
      };
    }),
    meta: meta(total, q.page, q.limit),
  });
}));

// POST /api/integrations — connect a provider for this tenant.
router.post('/', writeLimiter, validate(connectionBody), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const body = req.body;

  const Provider = validateProviderSelection(body.providerId, body.authType, body.connectionMethod || null);

  const duplicate = await prisma.integrationConnection.findFirst({
    where: { businessId: tenantId, name: body.name },
  });
  if (duplicate) throw conflict(`An integration named "${body.name}" already exists`);

  const plain = {};
  for (const [key, value] of Object.entries(body.credentials || {})) {
    if (value !== null && value !== undefined && value !== '') plain[key] = String(value);
  }
  const hasMaterial = Object.keys(plain).length > 0 || (body.config && Object.keys(body.config).length > 0);

  const created = await prisma.integrationConnection.create({
    data: {
      businessId: tenantId,
      providerId: body.providerId,
      providerCategory: Provider.category,
      name: body.name,
      authType: body.authType,
      connectionMethod: body.connectionMethod || Provider.connectionMethods[0] || null,
      config: body.config ? JSON.stringify(body.config) : null,
      credentialsCipher: integrationCredentials.encryptSecrets(plain),
      credentialFields: JSON.stringify(integrationCredentials.describeFields(plain)),
      capabilities: JSON.stringify([]),
      // Nothing is ever reported as connected before a real test succeeds.
      status: hasMaterial ? 'CONFIGURED' : 'NOT_CONNECTED',
    },
  });
  const capabilities = snapshotCapabilities(created);
  const connection = await prisma.integrationConnection.update({
    where: { id: created.id },
    data: { capabilities: JSON.stringify(capabilities) },
  });

  await logEvent({
    tenantId, connectionId: connection.id, providerId: connection.providerId,
    operation: 'connectionCreated', success: true,
    metadata: { name: connection.name, authType: connection.authType },
  });
  cache.invalidate('integrations');
  await audit(req, 'CREATE', 'IntegrationConnection', connection.id, {
    providerId: connection.providerId, name: connection.name,
    credentialFields: Object.keys(plain), // names only — never values
  });
  await activity(req.user.id, 'integration', `${req.user.name} connected ${Provider.label} (${connection.name})`, null, req);
  res.status(201).json({ success: true, data: gateway.safeConnection(connection) });
}));

// GET /api/integrations/:id — detail with capability matrix + recent events.
router.get('/:id', asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const connection = await gateway.getConnectionForTenant(tenantId, req.params.id);
  if (!connection) throw notFound('Integration connection not found');
  const Provider = registry.get(connection.providerId);
  const events = await prisma.integrationEvent.findMany({
    where: { businessId: tenantId, connectionId: connection.id },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  res.json({
    success: true,
    data: {
      ...gateway.safeConnection(connection),
      provider: Provider ? Provider.describe() : null,
      capabilityMatrix: gateway.capabilityMatrix(connection),
      recentEvents: events.map(presentEvent),
      dedicatedCredentialKey: integrationCredentials.dedicatedKeyConfigured(),
    },
  });
}));

// PUT /api/integrations/:id — update connection / rotate secrets.
router.put('/:id', writeLimiter, validate(updateBody), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const connection = await gateway.getConnectionForTenant(tenantId, req.params.id);
  if (!connection) throw notFound('Integration connection not found');
  const body = req.body;

  const nextProviderId = body.providerId !== undefined ? body.providerId : connection.providerId;
  const nextAuthType = body.authType !== undefined ? body.authType : connection.authType;
  const nextMethod = body.connectionMethod !== undefined ? body.connectionMethod : connection.connectionMethod;
  const Provider = validateProviderSelection(nextProviderId, nextAuthType, nextMethod || null);

  const data = {
    providerId: nextProviderId,
    providerCategory: Provider.category,
    authType: nextAuthType,
  };
  if (body.name !== undefined) {
    const clash = await prisma.integrationConnection.findFirst({
      where: { businessId: tenantId, name: body.name, id: { not: connection.id } },
    });
    if (clash) throw conflict(`An integration named "${body.name}" already exists`);
    data.name = body.name;
  }
  if (body.connectionMethod !== undefined) data.connectionMethod = body.connectionMethod || null;
  if (body.config !== undefined) data.config = body.config ? JSON.stringify(body.config) : null;
  const providerChanged = nextProviderId !== connection.providerId;
  if (providerChanged) {
    // Changing provider invalidates any established session and the old secret set.
    data.status = 'NOT_CONNECTED';
    data.capabilities = JSON.stringify([]);
    data.credentialsCipher = null;
    data.credentialFields = JSON.stringify([]);
    data.lastConnectedAt = null;
    data.lastError = null;
  }

  let secretNames = [];
  if (body.credentials !== undefined && body.credentials !== null) {
    // On a provider change the old secret set is discarded entirely — new
    // credentials start from empty rather than merging with stale ones.
    let existingPlain = {};
    if (!providerChanged) {
      try { existingPlain = integrationCredentials.decryptSecrets(connection.credentialsCipher); } catch (_) { existingPlain = {}; }
    }
    const { next, submitted, cleared } = mergeSecrets(existingPlain, body.credentials);
    data.credentialsCipher = integrationCredentials.encryptSecrets(next);
    // Explicitly cleared secrets must drop their descriptors too — otherwise
    // the UI would keep claiming a secret is set after it was destroyed.
    const clearedNames = new Set(cleared);
    data.credentialFields = JSON.stringify(integrationCredentials.describeFields(
      next, providerChanged ? [] : gateway.parseJson(connection.credentialFields, [])
    ).filter((f) => !clearedNames.has(f.name)));
    secretNames = Object.keys(submitted);
    // A credential change invalidates the previous "connected" claim.
    if (secretNames.length && data.status === undefined) data.status = 'CONFIGURED';
    if (secretNames.length) data.lastError = null;
  }

  let updated = await prisma.integrationConnection.update({ where: { id: connection.id }, data });
  const capabilities = snapshotCapabilities(updated);
  updated = await prisma.integrationConnection.update({
    where: { id: connection.id }, data: { capabilities: JSON.stringify(capabilities) },
  });

  await logEvent({
    tenantId, connectionId: updated.id, providerId: updated.providerId,
    operation: 'connectionUpdated', success: true,
    metadata: {
      fields: Object.keys(data).filter((k) => k !== 'credentialsCipher' && k !== 'credentialFields'),
      credentialFieldsChanged: secretNames, // names only
    },
  });
  cache.invalidate('integrations');
  await audit(req, 'UPDATE', 'IntegrationConnection', connection.id, {
    providerId: updated.providerId,
    fields: Object.keys(data).filter((k) => !k.startsWith('credential')),
    credentialFieldsChanged: secretNames, // names only
  });
  res.json({ success: true, data: gateway.safeConnection(updated) });
}));

// POST /api/integrations/:id/test — real connection test.
router.post('/:id/test', writeLimiter, gatewayHandler(async (req, res) => {
  const result = await gateway.testConnection({ tenantId: tenantOf(req), connectionId: req.params.id });
  cache.invalidate('integrations');
  await audit(req, 'TEST', 'IntegrationConnection', req.params.id);
  res.json({ success: true, data: result });
}));

// POST /api/integrations/:id/connect — establish the session.
router.post('/:id/connect', writeLimiter, gatewayHandler(async (req, res) => {
  const result = await gateway.connect({ tenantId: tenantOf(req), connectionId: req.params.id });
  cache.invalidate('integrations');
  await audit(req, 'CONNECT', 'IntegrationConnection', req.params.id);
  res.json({ success: true, data: result });
}));

// POST /api/integrations/:id/disconnect — close the session (secrets kept for reconnect).
router.post('/:id/disconnect', writeLimiter, gatewayHandler(async (req, res) => {
  const { connection, result } = await gateway.disconnect({ tenantId: tenantOf(req), connectionId: req.params.id });
  cache.invalidate('integrations');
  await audit(req, 'DISCONNECT', 'IntegrationConnection', req.params.id);
  res.json({ success: true, data: connection, message: result?.message || 'Disconnected' });
}));

// POST /api/integrations/:id/payments — initiate a payment via the provider.
router.post('/:id/payments', writeLimiter, validate(paymentBody), gatewayHandler(async (req, res) => {
  const result = await gateway.createPayment({
    tenantId: tenantOf(req), connectionId: req.params.id, payment: req.body,
  });
  res.status(201).json({ success: true, data: result });
}));

// GET /api/integrations/:id/payments/:reference — poll a payment's status.
router.get('/:id/payments/:reference', gatewayHandler(async (req, res) => {
  const result = await gateway.getPaymentStatus({
    tenantId: tenantOf(req), connectionId: req.params.id, reference: req.params.reference,
  });
  res.json({ success: true, data: result });
}));

// POST /api/integrations/:id/refunds — refund a payment via the provider.
router.post('/:id/refunds', writeLimiter, validate(refundBody), gatewayHandler(async (req, res) => {
  const result = await gateway.refundPayment({
    tenantId: tenantOf(req), connectionId: req.params.id,
    reference: req.body.reference, amount: req.body.amount ?? undefined,
  });
  res.json({ success: true, data: result });
}));

// GET /api/integrations/:id/events — secret-scrubbed event log.
router.get('/:id/events', validate(paginationSchema, 'query'), asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const tenantId = tenantOf(req);
  const connection = await gateway.getConnectionForTenant(tenantId, req.params.id);
  if (!connection) throw notFound('Integration connection not found');
  const where = { businessId: tenantId, connectionId: connection.id };
  const [items, total] = await Promise.all([
    prisma.integrationEvent.findMany({
      where, orderBy: { createdAt: q.order }, skip: (q.page - 1) * q.limit, take: q.limit,
    }),
    prisma.integrationEvent.count({ where }),
  ]);
  res.json({ success: true, data: items.map(presentEvent), meta: meta(total, q.page, q.limit) });
}));

// PATCH /api/integrations/:id/enabled — enable / disable without deleting secrets.
router.patch('/:id/enabled', writeLimiter, validate(z.object({ enabled: z.coerce.boolean() })), asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const connection = await gateway.getConnectionForTenant(tenantId, req.params.id);
  if (!connection) throw notFound('Integration connection not found');
  const updated = await prisma.integrationConnection.update({
    where: { id: connection.id },
    data: req.body.enabled
      ? { status: 'CONFIGURED', lastError: null }
      : { status: 'DISABLED' },
  });
  await logEvent({
    tenantId, connectionId: updated.id, providerId: updated.providerId,
    operation: 'connectionUpdated', success: true,
    metadata: { enabled: req.body.enabled },
  });
  cache.invalidate('integrations');
  await audit(req, req.body.enabled ? 'ENABLE' : 'DISABLE', 'IntegrationConnection', updated.id);
  res.json({ success: true, data: gateway.safeConnection(updated) });
}));

// DELETE /api/integrations/:id — remove and destroy stored secrets.
router.delete('/:id', writeLimiter, asyncHandler(async (req, res) => {
  const tenantId = tenantOf(req);
  const connection = await gateway.getConnectionForTenant(tenantId, req.params.id);
  if (!connection) throw notFound('Integration connection not found');
  await logEvent({
    tenantId, connectionId: connection.id, providerId: connection.providerId,
    operation: 'connectionDeleted', success: true, metadata: { name: connection.name },
  });
  // Keep the audit trail but detach it explicitly (deterministic on every provider).
  await prisma.integrationEvent.updateMany({
    where: { connectionId: connection.id }, data: { connectionId: null },
  });
  await prisma.integrationConnection.delete({ where: { id: connection.id } });
  cache.invalidate('integrations');
  await audit(req, 'DELETE', 'IntegrationConnection', connection.id, {
    providerId: connection.providerId, name: connection.name,
  });
  await activity(req.user.id, 'integration', `${req.user.name} removed the integration ${connection.name}`, null, req);
  res.json({ success: true, message: 'Integration removed. Stored credentials were destroyed with it.' });
}));

/* =====================================================================
 * Webhooks (mounted with a raw-body parser before CSRF in app.js — provider
 * servers do not participate in the double-submit cookie scheme).
 * ===================================================================== */
webhookRouter.post('/:providerId/:webhookToken', asyncHandler(async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  try {
    const result = await gateway.handleWebhook({
      providerId: req.params.providerId,
      webhookToken: req.params.webhookToken,
      rawBody,
      headers: req.headers,
    });
    if (result.unknown) return res.status(404).json({ received: false, error: 'Unknown integration webhook' });
    return res.json({ received: result.received, handled: result.handled, ...(result.error ? { error: result.error } : {}) });
  } catch (err) {
    const http = gateway.toHttpError(err);
    return res.status(http.status).json({ received: false, error: http.message, code: http.code });
  }
}));

module.exports = router;
module.exports.webhookRouter = webhookRouter;
