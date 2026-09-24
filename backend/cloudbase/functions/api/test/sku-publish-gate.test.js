const assert = require('assert/strict');
const { createApplication } = require('../app');

function createMemoryStore() {
  const data = new Map();
  let sequence = 0;
  const rows = (collection) => data.get(collection) || [];
  const matches = (item, where = {}) => Object.entries(where).every(([key, value]) => item[key] === value);
  return {
    async list(collection, options = {}) {
      const page = options.page || 1;
      const pageSize = options.pageSize || 20;
      let output = rows(collection).filter((item) => matches(item, options.where));
      (options.orderBy || []).slice().reverse().forEach(({ field, direction }) => {
        output = output.slice().sort((a, b) => {
          const left = a[field] || '';
          const right = b[field] || '';
          if (left === right) return 0;
          const sort = left > right ? 1 : -1;
          return direction === 'desc' ? -sort : sort;
        });
      });
      return { rows: output.slice((page - 1) * pageSize, page * pageSize), total: output.length, page, pageSize };
    },
    async findOne(collection, where) { return rows(collection).find((item) => matches(item, where)) || null; },
    async getById(collection, id) { return rows(collection).find((item) => item._id === id) || null; },
    async create(collection, item) {
      const record = { ...item, _id: item._id || `${collection}-${++sequence}` };
      data.set(collection, [...rows(collection), record]);
      return record;
    },
    async set(collection, id, item) {
      const existing = rows(collection).find((row) => row._id === id);
      const record = { ...item, _id: id };
      data.set(collection, existing ? rows(collection).map((row) => row._id === id ? record : row) : [...rows(collection), record]);
      return record;
    },
    async update(collection, id, patch) {
      data.set(collection, rows(collection).map((item) => item._id === id ? { ...item, ...patch } : item));
      return { _id: id, ...patch };
    },
    async remove(collection, id) { data.set(collection, rows(collection).filter((item) => item._id !== id)); },
    async runTransaction(work) {
      return work({
        getById: this.getById.bind(this),
        set: this.set.bind(this),
        update: this.update.bind(this),
        remove: this.remove.bind(this)
      });
    }
  };
}

async function call(app, action, payload = {}) {
  return app.dispatch({ action, payload, requestId: `gate-${action}` });
}

async function run() {
  const store = createMemoryStore();
  const fixedClock = () => new Date('2026-09-24T04:00:00.000Z');
  const app = createApplication({
    store,
    getIdentity: () => ({ OPENID: 'openid-gate' }),
    bootstrapToken: 'gate-bootstrap-token',
    piiEncryptionKey: 'gate-pii-encryption-key',
    paymentVerifier: async (payload) => payload,
    paymentPreparer: async () => ({ timeStamp: '1', nonceStr: 'n', package: 'p', paySign: 's' }),
    refundVerifier: async (payload) => payload,
    mediaUrlResolver: async (fileIds) => Object.fromEntries(fileIds.map((id) => [id, `https://cdn.example.test/${encodeURIComponent(id)}`])),
    storageUploader: async () => 'cloud://gate/uploads/file.png',
    demoMode: true,
    clock: fixedClock
  });
  await call(app, 'admin.bootstrap', { bootstrapToken: 'gate-bootstrap-token', username: 'gate-owner', displayName: '核查员', password: 'gate-password-123' });
  const login = await call(app, 'admin.login', { username: 'gate-owner', password: 'gate-password-123' });
  const adminToken = login.data.token;
  const A = (action, payload) => call(app, action, { adminToken, ...payload });

  // 正规链路：先建立并核对发布一个在售商品
  const category = await A('admin.categories.upsert', { name: '核查分类', status: 'enabled' });
  assert.ok(category.ok, '建分类: ' + JSON.stringify(category.error || {}));
  await store.create('media_assets', { _id: 'gate-cover', name: '主图', type: 'image', fileId: 'cloud://gate/cover.jpg', enabled: true });
  const product = await A('admin.products.upsert', { spuCode: 'GATE-001', name: '核查商品', categoryId: category.data._id, coverMediaId: 'gate-cover' });
  assert.ok(product.ok, '建商品: ' + JSON.stringify(product.error || {}));
  const skuA = await A('admin.skus.upsert', { productId: product.data._id, skuCode: 'GATE-SKU-A', specName: '规格A', packageUnit: '1件', status: 'draft' });
  assert.ok(skuA.ok, '建规格A: ' + JSON.stringify(skuA.error || {}));
  const priceA = await A('admin.prices.upsert', { skuId: skuA.data._id, scopeType: 'public', amountCent: 1250, status: 'active' });
  assert.ok(priceA.ok, '建价格A: ' + JSON.stringify(priceA.error || {}));
  await store.create('warehouses', { _id: 'gate-wh', name: '核查仓', status: 'active' });
  await store.create('inventory', { skuId: skuA.data._id, warehouseId: 'gate-wh', available: 10 });
  await store.create('delivery_areas', { _id: 'gate-area', name: '核查区', warehouseIds: ['gate-wh'], regionCodes: ['GATE-REG'], status: 'active' });
  await store.create('freight_rules', { _id: 'gate-freight', name: '核查运费', deliveryAreaId: 'gate-area', warehouseId: 'gate-wh', baseFeeCent: 500, status: 'active' });
  await store.create('delivery_slots', { _id: 'gate-slot', name: '核查时段', deliveryAreaId: 'gate-area', warehouseId: 'gate-wh', startTime: '09:00', endTime: '12:00', status: 'active' });
  const review = await A('admin.products.review', { id: product.data._id });
  assert.ok(review.data.ready, '首次完整核对应通过: ' + review.data.issues.join('；'));
  const published = await A('admin.products.publishReviewed', { id: product.data._id, reviewToken: review.data.reviewToken });
  assert.equal(published.data.status, 'on_sale', '正规核对发布应成功');

  // 缺项规格：仅 Web 渠道价格，缺库存、配送、包装单位与个人端价格覆盖
  const skuB = await A('admin.skus.upsert', { productId: product.data._id, skuCode: 'GATE-SKU-B', specName: '规格B', packageUnit: '', status: 'draft' });
  assert.ok(skuB.ok, '建缺项规格B: ' + JSON.stringify(skuB.error || {}));
  const priceB = await A('admin.prices.upsert', { skuId: skuB.data._id, scopeType: 'public', channel: 'web', amountCent: 999, status: 'active' });
  assert.ok(priceB.ok, '建 Web 渠道价格B: ' + JSON.stringify(priceB.error || {}));

  const directStatus = await A('admin.skus.setStatus', { id: skuB.data._id, status: 'on_sale' });
  assert.equal(directStatus.error && directStatus.error.code, 'PRODUCT_NOT_READY', '缺项规格不得经 setStatus 直接上架');
  assert.match(directStatus.error.message, /库存/, '拒绝原因应包含库存缺项');
  assert.match(directStatus.error.message, /配送/, '拒绝原因应包含配送缺项');
  assert.match(directStatus.error.message, /包装单位/, '拒绝原因应包含包装单位缺项');
  assert.match(directStatus.error.message, /个人顾客/, '拒绝原因应包含个人端价格覆盖缺项');
  assert.equal((await store.getById('product_skus', skuB.data._id)).status, 'draft', '拒绝后不得产生部分写入');

  const upsertBypass = await A('admin.skus.upsert', { id: skuB.data._id, productId: product.data._id, skuCode: 'GATE-SKU-B', specName: '规格B', packageUnit: '', status: 'on_sale' });
  assert.equal(upsertBypass.error && upsertBypass.error.code, 'PRODUCT_NOT_READY', 'upsert 改状态同样不得绕过完整核对');
  assert.equal((await store.getById('product_skus', skuB.data._id)).status, 'draft', 'upsert 拒绝后不得产生部分写入');

  const catalog = await call(app, 'catalog.products', {});
  const row = catalog.data.rows.find((item) => item._id === product.data._id);
  assert.equal((row.skus || []).some((sku) => sku._id === skuB.data._id), false, '顾客端不得看到未核对规格');

  // 缺主图场景：其余条件齐备但商品无主图
  const product2 = await A('admin.products.upsert', { spuCode: 'GATE-002', name: '无主图商品', categoryId: category.data._id });
  assert.ok(product2.ok, '建无主图商品: ' + JSON.stringify(product2.error || {}));
  const skuC = await A('admin.skus.upsert', { productId: product2.data._id, skuCode: 'GATE-SKU-C', specName: '规格C', packageUnit: '1件', status: 'draft' });
  assert.ok(skuC.ok, '建规格C: ' + JSON.stringify(skuC.error || {}));
  const priceC = await A('admin.prices.upsert', { skuId: skuC.data._id, scopeType: 'public', amountCent: 500, status: 'active' });
  assert.ok(priceC.ok, '建价格C: ' + JSON.stringify(priceC.error || {}));
  await store.create('inventory', { skuId: skuC.data._id, warehouseId: 'gate-wh', available: 5 });
  const noCover = await A('admin.skus.setStatus', { id: skuC.data._id, status: 'on_sale' });
  assert.equal(noCover.error && noCover.error.code, 'PRODUCT_NOT_READY', '缺主图商品下规格不得上架');
  assert.match(noCover.error.message, /主图/, '拒绝原因应包含主图缺项');

  // 补齐包装单位、个人端价格覆盖与库存后，允许上架且顾客可见
  const fixUnit = await A('admin.skus.upsert', { id: skuB.data._id, productId: product.data._id, skuCode: 'GATE-SKU-B', specName: '规格B', packageUnit: '1件', status: 'draft' });
  assert.ok(fixUnit.ok, '补包装单位: ' + JSON.stringify(fixUnit.error || {}));
  await store.update('prices', priceB.data._id, { channel: 'all' });
  await store.create('inventory', { skuId: skuB.data._id, warehouseId: 'gate-wh', available: 8 });
  const enableB = await A('admin.skus.setStatus', { id: skuB.data._id, status: 'on_sale' });
  assert.ok(enableB.ok, '补齐后应允许上架: ' + JSON.stringify(enableB.error || {}));
  assert.equal(enableB.data.status, 'on_sale');
  const catalogAfter = await call(app, 'catalog.products', {});
  const rowAfter = catalogAfter.data.rows.find((item) => item._id === product.data._id);
  assert.equal((rowAfter.skus || []).some((sku) => sku._id === skuB.data._id), true, '补齐后顾客端应可见');

  // off_sale 重新启用（合法通道回归）
  const offAgain = await A('admin.skus.setStatus', { id: skuB.data._id, status: 'off_sale' });
  assert.ok(offAgain.ok, '允许下架: ' + JSON.stringify(offAgain.error || {}));
  const reEnable = await A('admin.skus.setStatus', { id: skuB.data._id, status: 'on_sale' });
  assert.ok(reEnable.ok, '条件满足的重启用不得被拒绝: ' + JSON.stringify(reEnable.error || {}));

  console.log('sku-publish-gate: 全部断言通过');
}

run().then(null, (error) => { console.error(error && (error.stack || error.message)); process.exit(1); });
