(function attachAdminSessionPolicy(global) {
  'use strict';

  function shouldClearSession(error) {
    const code = error && error.code;
    return code === 'ADMIN_SESSION_EXPIRED' || code === 'ADMIN_UNAUTHORIZED';
  }

  const api = { shouldClearSession };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.MengshixianAdminSessionPolicy = api;
}(typeof window !== 'undefined' ? window : globalThis));
