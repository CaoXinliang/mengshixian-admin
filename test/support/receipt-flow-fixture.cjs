const { createApplication } = require('../../backend/cloudbase/functions/api/app');

// This adapter owns all fixture data; no CloudBase SDK or network client is loaded.
function createMemoryStore() {
  let tables = new Map();
  let sequence = 0;
  let transactionTail = Promise.resolve();
  const copy = (value) => structuredClone(value);

  function adapter(data, nextId) {
    const rows = (collection) => data.get(collection) || [];
    const matches = (row, where = {}) => Object.entries(where).every(([key, value]) => row[key] === value);
    return {
      async list(collection, options = {}) {
        const page = Math.max(1, Number(options.page) || 1);
        const pageSize = Math.max(1, Number(options.pageSize) || 20);
        let selected = rows(collection).filter((row) => matches(row, options.where));
        for (const { field, direction } of (options.orderBy || []).slice().reverse()) {
          selected = selected.slice().sort((left, right) => {
            const a = left[field] ?? '';
            const b = right[field] ?? '';
            return (a > b ? 1 : a < b ? -1 : 0) * (direction === 'desc' ? -1 : 1);
          });
        }
        return { rows: copy(selected.slice((page - 1) * pageSize, page * pageSize)), total: selected.length, page, pageSize };
      },
      async getById(collection, id) { return copy(rows(collection).find((row) => row._id === id) || null); },
      async findOne(collection, where = {}) { return copy(rows(collection).find((row) => matches(row, where)) || null); },
      async create(collection, item) {
        const record = copy({ ...item, _id: item._id || nextId(collection) });
        data.set(collection, [...rows(collection), record]);
        return copy(record);
      },
      async set(collection, id, item) {
        const record = copy({ ...item, _id: id });
        const current = rows(collection);
        data.set(collection, current.some((row) => row._id === id)
          ? current.map((row) => row._id === id ? record : row)
          : [...current, record]);
        return copy(record);
      },
      async update(collection, id, patch) {
        data.set(collection, rows(collection).map((row) => row._id === id ? { ...row, ...copy(patch) } : row));
        return copy({ _id: id, ...patch });
      },
      async remove(collection, id) {
        data.set(collection, rows(collection).filter((row) => row._id !== id));
      }
    };
  }

  const store = {};
  for (const method of ['list', 'getById', 'findOne', 'create', 'set', 'update', 'remove']) {
    store[method] = (...args) => adapter(tables, (collection) => `${collection}-${++sequence}`)[method](...args);
  }
  store.runTransaction = (work) => {
    const run = async () => {
      const draft = copy(tables);
      let draftSequence = sequence;
      const tx = adapter(draft, (collection) => `${collection}-${++draftSequence}`);
      const result = await work(tx);
      tables = draft;
      sequence = draftSequence;
      return result;
    };
    const pending = transactionTail.then(run);
    transactionTail = pending.then(() => undefined, () => undefined);
    return pending;
  };
  return store;
}

async function createReceiptFixture() {
  const store = createMemoryStore();
  const bootstrapToken = 'receipt-fixture-bootstrap-local-only';
  const password = 'receipt-fixture-password-local-only';
  const app = createApplication({
    store,
    getIdentity: () => ({ OPENID: 'receipt-flow-local-enterprise-openid' }),
    bootstrapToken,
    piiEncryptionKey: 'receipt-fixture-local-encryption-key',
    demoMode: true,
    clock: () => new Date('2026-09-23T12:00:00.000Z')
  });
  let adminToken = '';
  async function call(action, payload = {}) {
    const adminPayload = action.startsWith('admin.') && !['admin.bootstrap', 'admin.login'].includes(action)
      ? { adminToken, ...payload }
      : { ...payload };
    const result = await app.dispatch({ action, payload: adminPayload, requestId: `receipt-fixture-${action}` });
    if (!result.ok) {
      const error = new Error(result.error?.message || `Action ${action} failed`);
      error.code = result.error?.code || 'UNKNOWN_ERROR';
      throw error;
    }
    return result.data;
  }

  // Only product fixtures are seeded. All operational state below goes through real dispatch actions.
  await store.create('categories', { _id: 'receipt-category', name: '本地测试品类', status: 'enabled', sort: 1, source: 'demo', temporary: true });
  await store.create('products', { _id: 'receipt-product', name: '本地测试商品', categoryId: 'receipt-category', categoryName: '本地测试品类', status: 'on_sale', sort: 1, source: 'demo', temporary: true });
  await store.create('product_skus', { _id: 'receipt-sku', productId: 'receipt-product', specName: '测试规格', packageUnit: '件', status: 'on_sale', source: 'demo', temporary: true });

  await call('admin.bootstrap', { bootstrapToken, username: 'receipt-owner', displayName: '本地收款测试管理员', password });
  adminToken = (await call('admin.login', { username: 'receipt-owner', password })).token;
  const application = await call('auth.applyBusiness', {
    companyName: '本地收款测试企业', storeName: '本地测试门店', storeAddress: '仅本地测试地址',
    mainBusinessType: 'restaurant', unifiedCode: '123456789012345678',
    storefrontMediaId: 'local://receipt-flow/storefront', businessLicenseMediaId: 'local://receipt-flow/license',
    contactName: '本地测试联系人', contactPhone: '13900139000'
  });
  await call('admin.businessApplications.review', { id: application.application._id, decision: 'approved', priceLevel: 'b_standard' });

  const warehouse = await call('admin.warehouses.upsert', { code: 'RECEIPT-WH', name: '本地测试仓', status: 'active' });
  const area = await call('admin.deliveryAreas.upsert', { name: '本地测试配送区', regionCodes: ['440300'], warehouseIds: [warehouse._id], status: 'active' });
  await call('admin.freightRules.upsert', { name: '本地测试运费规则', deliveryAreaId: area._id, warehouseId: warehouse._id, baseFeeCent: 800, freeThresholdCent: 10000, status: 'active' });
  const slot = await call('admin.deliverySlots.upsert', { name: '本地上午配送', deliveryAreaId: area._id, warehouseId: warehouse._id, startTime: '09:00', endTime: '12:00', status: 'active' });
  await call('admin.prices.upsert', { skuId: 'receipt-sku', scopeType: 'public', amountCent: 5000, status: 'active', source: 'demo', temporary: true, demoNote: '仅本地合成测试价格' });
  await call('admin.inventory.adjust', { warehouseId: warehouse._id, skuId: 'receipt-sku', change: 20, reason: 'local_fixture_stock', idempotencyKey: 'receipt-fixture-stock' });
  const address = await call('address.upsert', { name: '本地测试收货人', phone: '13800138000', regionCode: '440300', detail: '仅本地测试路 1 号', isDefault: true });
  const created = await call('orders.create', {
    idempotencyKey: 'receipt-fixture-order', addressId: address.address._id, warehouseId: warehouse._id,
    deliverySlotId: slot._id, items: [{ skuId: 'receipt-sku', quantity: 2 }], paymentMethod: 'offline'
  });
  if (created.order.totalAmountCent !== 10000) throw new Error(`Fixture total mismatch: ${created.order.totalAmountCent}`);
  return { app, call, adminToken, order: created.order };
}

module.exports = { createReceiptFixture, createMemoryStore };
