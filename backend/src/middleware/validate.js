const { badRequest } = require('../lib/errors');

/** Strips angle brackets / control chars from every string in the payload (XSS hardening). */
function sanitizeValue(v) {
  if (typeof v === 'string') {
    return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
            .replace(/<\s*script/gi, '&lt;script')
            .replace(/javascript:/gi, '')
            .replace(/on(\w+)\s*=/gi, 'data-$1=');
  }
  if (Array.isArray(v)) return v.map(sanitizeValue);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = sanitizeValue(val);
    return out;
  }
  return v;
}

function sanitizeBody(req, res, next) {
  // Raw (Buffer) bodies — e.g. payment webhooks — are handled separately and
  // must be preserved byte-for-byte for signature verification.
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    req.body = sanitizeValue(req.body);
  }
  next();
}

/** Validates req[source] against a zod schema and replaces it with the parsed result. */
const validate = (schema, source = 'body') => (req, res, next) => {
  const result = schema.safeParse(req[source]);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    return next(badRequest('Validation failed', details));
  }
  if (source === 'query') req.validatedQuery = result.data;
  else req[source] = result.data;
  next();
};

module.exports = { validate, sanitizeBody, sanitizeValue };
