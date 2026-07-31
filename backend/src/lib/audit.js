const prisma = require('./prisma');

async function audit(req, action, entity, entityId, data) {
  try {
    await prisma.auditLog.create({
      data: {
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

async function activity(userId, type, message, meta) {
  try {
    await prisma.activity.create({
      data: { userId: userId || null, type, message, meta: meta ? JSON.stringify(meta) : null },
    });
  } catch (_) {}
}

module.exports = { audit, activity };
