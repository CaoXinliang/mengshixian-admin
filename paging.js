(function attachAdminPaging(global) {
  const DEFAULT_PAGE_SIZE = 100;
  const MAX_PAGE_SIZE = 100;
  const MAX_PAGES = 20;

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  function positiveInteger(value, fallback) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : fallback;
  }

  function assertRows(result) {
    if (!result || !Array.isArray(result.rows)) fail('ADMIN_LIST_RESPONSE_INVALID', '后台列表接口返回格式不正确。');
    return result.rows;
  }

  async function listAll(call, action, options = {}) {
    if (typeof call !== 'function') fail('ADMIN_LIST_CALL_INVALID', '后台列表请求器不可用。');
    const pageSize = Math.min(MAX_PAGE_SIZE, positiveInteger(options.pageSize, DEFAULT_PAGE_SIZE));
    const maxPages = Math.min(MAX_PAGES, positiveInteger(options.maxPages, MAX_PAGES));
    const first = await call(action, { page: 1, pageSize });
    const rows = [...assertRows(first)];
    const total = Number(first.total);

    if (!Number.isSafeInteger(total) || total < 0) {
      fail('ADMIN_LIST_TOTAL_INVALID', `后台列表 ${action} 返回了无效总数，已停止继续分页请求。`);
    }

    const pages = Math.max(1, Math.ceil(total / pageSize));
    if (pages > maxPages) {
      fail('ADMIN_LIST_PAGE_LIMIT_EXCEEDED', `后台列表 ${action} 共 ${pages} 页，超过安全上限 ${maxPages} 页，已停止继续请求。`);
    }

    for (let page = 2; page <= pages; page += 1) {
      const next = await call(action, { page, pageSize });
      const nextRows = assertRows(next);
      rows.push(...nextRows);
      if (nextRows.length < pageSize) break;
    }

    return { ...first, rows, total, page: 1, pageSize };
  }

  const api = { listAll, MAX_PAGES, MAX_PAGE_SIZE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.MengshixianAdminPaging = api;
}(typeof window !== 'undefined' ? window : globalThis));
