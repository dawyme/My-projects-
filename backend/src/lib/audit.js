const prisma = require('./prisma');

async function audit(req, action, entity, entityId, data) {
  try {
    await prisma.auditLog.create({
      data: {
        businessId: req?.tenantId || req?.user?.businessId || 'default',
        userId: req.user?.id || null,
        action, entity,
        entityId: entityId || null,
        ip: req.ip || null,
        userAgent: (req.get('user-agent') || '').slice(0, 250),
        data: data ? JSON.stringify(data).slice(0, 4000) : null,
      },
    });
  } catch (_) { /* auditing must never break the request */ }
}

async function activity(userId, type, message, meta, req) {
  try {
    // Tenant context: explicit request scope wins; otherwise resolve from the
    // acting user. Public (no-user) activity belongs to the default tenant.
    let businessId = req?.tenantId || req?.user?.businessId || null;
    if (!businessId && userId) {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { businessId: true } });
      businessId = user?.businessId || 'default';
    }
    await prisma.activity.create({
      data: {
        businessId: businessId || 'default',
        userId: userId || null, type, message, meta: meta ? JSON.stringify(meta) : null,
      },
    });
  } catch (_) {}
}

module.exports = { audit, activity };
