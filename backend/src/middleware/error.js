const { AppError } = require('../lib/errors');

function notFoundHandler(req, res) {
  res.status(404).json({ success: false, error: `Route not found: ${req.method} ${req.originalUrl}` });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let status = err.status || 500;
  let message = err.message || 'Internal server error';
  let details = err.details;

  if (err.code === 'P2002') { status = 409; message = `Duplicate value for ${(err.meta?.target || ['field'])}`; }
  else if (err.code === 'P2025') { status = 404; message = 'Record not found'; }
  else if (err.code === 'P2003') { status = 409; message = 'Related record constraint failed'; }
  else if (err.type === 'entity.parse.failed') { status = 400; message = 'Malformed JSON body'; }
  else if (err.code === 'LIMIT_FILE_SIZE') { status = 413; message = 'File too large (max 5MB)'; }

  if (status >= 500) {
    console.error('[error]', req.method, req.originalUrl, err);
    if (process.env.NODE_ENV === 'production' && !(err instanceof AppError)) message = 'Internal server error';
  }
  res.status(status).json({ success: false, error: message, ...(details ? { details } : {}) });
}

module.exports = { notFoundHandler, errorHandler };
