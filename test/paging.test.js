const assert = require('node:assert/strict');
const { listAll, MAX_PAGES } = require('../paging');

async function run() {
  const requests = [];
  const normal = await listAll(async (_action, payload) => {
    requests.push(payload.page);
    const rows = Array.from({ length: payload.page === 3 ? 5 : 100 }, (_, index) => ({ id: (payload.page - 1) * 100 + index }));
    return { rows, total: 205 };
  }, 'admin.products.list');
  assert.deepEqual(requests, [1, 2, 3]);
  assert.equal(normal.rows.length, 205);

  const filteredRequests = [];
  await listAll(async (_action, payload) => {
    filteredRequests.push(payload);
    return { rows: [], total: 0 };
  }, 'admin.inventory.ledger', { params: { warehouseId: 'wh-1', reason: 'purchase_in' } });
  assert.deepEqual(filteredRequests, [{ warehouseId: 'wh-1', reason: 'purchase_in', page: 1, pageSize: 100 }], '筛选参数必须随分页请求提交到服务端');

  let invalidCalls = 0;
  await assert.rejects(
    () => listAll(async () => { invalidCalls += 1; return { rows: [], total: 'Infinity' }; }, 'admin.imports.list'),
    (error) => error.code === 'ADMIN_LIST_TOTAL_INVALID'
  );
  assert.equal(invalidCalls, 1, '无效 total 只能发起首个请求');

  let excessiveCalls = 0;
  await assert.rejects(
    () => listAll(async () => { excessiveCalls += 1; return { rows: [], total: (MAX_PAGES + 1) * 100 }; }, 'admin.products.list'),
    (error) => error.code === 'ADMIN_LIST_PAGE_LIMIT_EXCEEDED'
  );
  assert.equal(excessiveCalls, 1, '超过页数上限时不得继续分页');

  const sparseRequests = [];
  const sparse = await listAll(async (_action, payload) => {
    sparseRequests.push(payload.page);
    return { rows: payload.page === 1 ? Array.from({ length: 100 }, (_, index) => ({ id: index })) : [], total: 300 };
  }, 'admin.categories.list');
  assert.deepEqual(sparseRequests, [1, 2]);
  assert.equal(sparse.rows.length, 100, '空页必须停止，不能按错误 total 继续循环');

  console.log('admin paging guard test: passed');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
