class ApplicationError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new ApplicationError(code, message, details);
}

function success(data, requestId) {
  return { ok: true, data: data === undefined ? null : data, error: null, requestId: requestId || '' };
}

function failure(error, requestId) {
  const known = error instanceof ApplicationError;
  if (!known) console.error('[mengshixian-api]', requestId || '', error);
  return {
    ok: false,
    data: null,
    error: { code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : '服务暂时不可用。' },
    requestId: requestId || ''
  };
}

module.exports = { ApplicationError, fail, success, failure };
