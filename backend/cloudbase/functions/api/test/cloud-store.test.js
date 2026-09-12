const assert = require('assert/strict');
const { createCloudStore } = require('../lib/cloud-store');

async function run() {
  const calls = [];
  const transaction = {
    collection(name) {
      return {
        doc(id) {
          return {
            async get() {
              calls.push({ type: 'get', collection: name, id });
              return { data: { _id: id, status: 'pending' } };
            },
            async set(options) {
              calls.push({ type: 'set', collection: name, id, data: options.data });
              return {};
            },
            async update(options) {
              calls.push({ type: 'update', collection: name, id, data: options.data });
              return {};
            },
            async remove() {
              calls.push({ type: 'remove', collection: name, id });
              return {};
            }
          };
        }
      };
    }
  };
  const store = createCloudStore({ runTransaction: async (work) => work(transaction) });

  const found = await store.runTransaction(async (tx) => {
    assert.equal(typeof tx.getById, 'function', '事务适配器必须提供 getById');
    assert.equal(typeof tx.set, 'function', '事务适配器必须提供 set');
    assert.equal(typeof tx.update, 'function', '事务适配器必须提供 update');
    assert.equal(typeof tx.remove, 'function', '事务适配器必须提供 remove');
    assert.equal(tx.list, undefined, '事务适配器不得暴露 list');
    assert.equal(tx.findOne, undefined, '事务适配器不得暴露 findOne');
    assert.equal(tx.create, undefined, '事务适配器不得暴露 create');

    const existing = await tx.getById('orders', 'order-id');
    const saved = await tx.set('orders', 'order-id', { _id: 'wrong-id', status: 'pending_payment' });
    await tx.update('orders', 'order-id', { _id: 'wrong-id', status: 'cancelled' });
    await tx.remove('orders', 'order-id');
    return { existing, saved };
  });

  assert.equal(found.existing.status, 'pending');
  assert.equal(found.saved._id, 'order-id');
  assert.equal(found.saved.status, 'pending_payment');
  assert.equal(Object.hasOwn(found.saved, '_id'), true, '返回对象保留确定性文档 ID');

  const setCall = calls.find((item) => item.type === 'set');
  assert.equal(setCall.id, 'order-id');
  assert.equal(setCall.data.status, 'pending_payment');
  assert.equal(Object.hasOwn(setCall.data, '_id'), false, 'set 写入数据不得携带 _id');

  const missingStore = createCloudStore({
    collection() { return { doc() { return { async get() { const error = new Error('document with _id missing does not exist'); error.errMsg = error.message; throw error; } }; } }; }
  });
  assert.equal(await missingStore.getById('inventory', 'missing'), null, 'CloudBase 缺失文档必须标准化为 null');

  const missingCollectionError = new Error('collection.get:fail -502005 database collection not exists. [ResourceNotFound] Db or Table not exist: bundles.');
  missingCollectionError.errCode = -502005;
  missingCollectionError.errMsg = missingCollectionError.message;
  const missingQuery = {
    where() { return this; },
    orderBy() { return this; },
    skip() { return this; },
    limit() { return this; },
    async get() { throw missingCollectionError; },
    async count() { throw missingCollectionError; }
  };
  const missingCollectionStore = createCloudStore({
    collection() { return Object.create(missingQuery); }
  });
  assert.deepEqual(
    await missingCollectionStore.list('bundles', { page: 2, pageSize: 15, allowMissingCollection: true }),
    { rows: [], total: 0, page: 2, pageSize: 15 },
    '显式允许缺失的可选集合必须返回分页空态'
  );
  await assert.rejects(
    () => missingCollectionStore.list('products', { page: 1, pageSize: 20 }),
    /collection not exists/,
    '核心集合缺失不得伪装为空数据'
  );

  const networkStore = createCloudStore({
    collection() {
      const query = Object.create(missingQuery);
      query.get = async () => { throw new Error('network disconnected'); };
      query.count = query.get;
      return query;
    }
  });
  await assert.rejects(
    () => networkStore.list('bundles', { allowMissingCollection: true }),
    /network disconnected/,
    '可选集合也不能吞掉真实网络故障'
  );

  const updateCall = calls.find((item) => item.type === 'update');
  assert.equal(updateCall.data.status, 'cancelled');
  assert.equal(Object.hasOwn(updateCall.data, '_id'), false, 'update 写入数据不得携带 _id');

  const removeCall = calls.find((item) => item.type === 'remove');
  assert.equal(removeCall.id, 'order-id');

  console.log('cloud store document adapter test: passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
