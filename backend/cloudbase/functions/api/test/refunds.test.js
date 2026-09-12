const assert = require('assert/strict');
const { createApplication } = require('../app');

function memoryStore() {
  const data = new Map(); let sequence = 0;
  let transactionTail = Promise.resolve();
  const rows = (collection) => data.get(collection) || [];
  const matches = (item, where = {}) => Object.entries(where).every(([key, value]) => item[key] === value);
  const store = {
    async list(collection, options = {}) { const page = options.page || 1; const pageSize = options.pageSize || 20; let output = rows(collection).filter((item) => matches(item, options.where)); (options.orderBy || []).slice().reverse().forEach(({ field, direction }) => { output = output.slice().sort((a, b) => direction === 'desc' ? String(b[field] || '').localeCompare(String(a[field] || '')) : String(a[field] || '').localeCompare(String(b[field] || ''))); }); return { rows: output.slice((page - 1) * pageSize, page * pageSize), total: output.length, page, pageSize }; },
    async findOne(collection, where) { return rows(collection).find((item) => matches(item, where)) || null; },
    async getById(collection, id) { return rows(collection).find((item) => item._id === id) || null; },
    async create(collection, item) { const record = { ...item, _id: item._id || `${collection}-${++sequence}` }; data.set(collection, [...rows(collection), record]); return record; },
    async set(collection, id, item) { const record = { ...item, _id: id }; data.set(collection, rows(collection).some((row) => row._id === id) ? rows(collection).map((row) => row._id === id ? record : row) : [...rows(collection), record]); return record; },
    async update(collection, id, patch) { data.set(collection, rows(collection).map((item) => item._id === id ? { ...item, ...patch } : item)); return { _id: id, ...patch }; },
    async remove(collection, id) { data.set(collection, rows(collection).filter((item) => item._id !== id)); },
    async runTransaction(work) { let release; const previous = transactionTail; transactionTail = new Promise((resolve) => { release = resolve; }); await previous; try { return await work({ getById: store.getById, set: store.set, update: store.update, remove: store.remove }); } finally { release(); } }
  };
  return store;
}

async function call(app, action, payload = {}) { return app.dispatch({ action, payload }); }

async function seedPaidOrder(store, userId, id, status = 'completed', completedAt = '2026-09-10T00:00:00.000Z') {
  const itemId = `${id}-item`;
  const item = { _id: itemId, orderItemId: itemId, orderId: id, skuId: 'sku-1', productId: 'product-1', productNameSnapshot: '测试商品', specSnapshot: '标准装', packageUnitSnapshot: '件', quantity: 2, unitPriceCent: 1000, subtotalCent: 2000, priceRuleId: 'price-1', purchaseRuleSnapshot: { minOrderQuantity: 1, orderMultiple: 1 }, currency: 'CNY' };
  await store.create('order_items', item);
  await store.create('orders', { _id: id, orderNo: `NO-${id}`, userId, status, paymentStatus: 'paid', totalAmountCent: 2500, refundedAmountCent: 0, freightSnapshot: { amountCent: 500 }, pricingSnapshot: { goodsAmountCent: 2000, freightCent: 500 }, itemIds: [itemId], itemsSnapshot: [item], fulfillmentContactCiphertext: 'must-not-leak', idempotencyKey: 'must-not-leak', completedAt, createdAt: '2026-09-09T00:00:00.000Z', updatedAt: completedAt });
  return { id, itemId };
}

async function run() {
  const store = memoryStore();
  const now = () => new Date('2026-09-12T00:00:00.000Z');
  const options = { store, getIdentity: () => ({ OPENID: 'refund-user' }), bootstrapToken: 'bootstrap-token', piiEncryptionKey: 'refund-test-pii-key', storageUploader: async () => 'cloud://refund/evidence.png', mediaUrlResolver: async (ids) => Object.fromEntries(ids.map((id) => [id, `https://example.test/${encodeURIComponent(id)}`])), refundVerifier: async (payload) => payload, clock: now };
  const app = createApplication(options);
  const me = await call(app, 'auth.me'); const userId = me.data.user._id;
  await call(app, 'admin.bootstrap', { bootstrapToken: 'bootstrap-token', username: 'owner', password: '1234567890ab' });
  const login = await call(app, 'admin.login', { username: 'owner', password: '1234567890ab' }); const adminToken = login.data.token;
  await call(app, 'admin.roles.upsert', { adminToken, code: 'catalog_only', name: '仅商品', permissions: ['catalog.read'], status: 'active' });
  const catalogRole = await store.findOne('admin_roles', { code: 'catalog_only' });
  await call(app, 'admin.adminUsers.upsert', { adminToken, username: 'catalog-only', displayName: '仅商品', password: '1234567890ab', roleIds: [catalogRole._id], status: 'active' });
  const restrictedLogin = await call(app, 'admin.login', { username: 'catalog-only', password: '1234567890ab' }); const restrictedToken = restrictedLogin.data.token;

  const uploaded = await call(app, 'refunds.media.upload', { type: 'image', fileName: '破损.png', mimeType: 'image/png', contentBase64: Buffer.from('evidence').toString('base64'), sizeBytes: 8 });
  assert.equal(uploaded.ok, true); assert.ok(uploaded.data.mediaId); assert.match(uploaded.data.url, /^https:/);
  const ownedMedia = await store.getById('media_assets', uploaded.data.mediaId);
  assert.equal(ownedMedia.purpose, 'aftersale_evidence'); assert.equal(ownedMedia.userId, userId); assert.equal(ownedMedia.temporary, false);
  assert.equal((await call(app, 'content.media.resolve', { ids: [uploaded.data.mediaId], platform: 'web' })).data.rows.length, 0, '售后私有凭证不得通过公共素材接口解析');
  await store.create('media_assets', { _id: 'foreign-evidence', type: 'image', enabled: true, purpose: 'aftersale_evidence', userId: 'other-user' });

  const pending = await seedPaidOrder(store, userId, 'order-pending', 'pending_confirmation', '');
  const foreignMedia = await call(app, 'refunds.request', { orderId: pending.id, items: [{ orderItemId: pending.itemId, quantity: 2 }], reasonCode: 'damaged', mediaIds: ['foreign-evidence'], idempotencyKey: 'foreign-media' });
  assert.equal(foreignMedia.error.code, 'REFUND_MEDIA_INVALID', '不能引用其他用户的售后凭证');
  const pendingFull = await call(app, 'refunds.request', { orderId: pending.id, items: [{ orderItemId: pending.itemId, quantity: 2 }], reasonCode: 'damaged', mediaIds: [uploaded.data.mediaId], idempotencyKey: 'pending-full' });
  assert.equal(pendingFull.data.refund.goodsAmountCent, 2000);
  assert.equal(pendingFull.data.refund.amountCent, 2500, '全量选择全部剩余商品时应由服务端计入 500 分运费');
  assert.equal(pendingFull.data.refund.includedOrderAdjustmentCent, 500);

  const partial = await seedPaidOrder(store, userId, 'order-partial');
  const detail = await call(app, 'orders.get', { id: partial.id });
  assert.equal(detail.data.items[0].unitPriceCent, 1000); assert.equal(detail.data.items[0].subtotalCent, 2000);
  assert.equal(Object.hasOwn(detail.data.order, 'fulfillmentContactCiphertext'), false); assert.equal(Object.hasOwn(detail.data.order, 'idempotencyKey'), false);
  assert.equal((await call(app, 'admin.orders.get', { adminToken, id: partial.id })).data.items[0].purchaseRuleSnapshot.orderMultiple, 1);
  assert.equal((await call(app, 'admin.orders.get', { adminToken: restrictedToken, id: partial.id })).error.code, 'ADMIN_FORBIDDEN');
  await seedPaidOrder(store, 'other-user', 'foreign-order');
  assert.equal((await call(app, 'orders.get', { id: 'foreign-order' })).error.code, 'ORDER_NOT_FOUND');

  const first = await call(app, 'refunds.request', { orderId: partial.id, items: [{ skuId: 'sku-1', quantity: 1 }], reasonCode: 'quality_issue', description: '部分破损', mediaIds: [uploaded.data.mediaId], amountCent: 1, idempotencyKey: 'partial-first' });
  assert.equal(first.data.refund.amountCent, 1000, '部分退款金额只能按服务端订单项快照计算');
  assert.equal((await call(app, 'refunds.request', { orderId: partial.id, items: [{ skuId: 'sku-1', quantity: 1 }], reasonCode: 'damaged', idempotencyKey: 'partial-concurrent' })).error.code, 'REFUND_ALREADY_PENDING');
  assert.equal((await call(app, 'refunds.request', { orderId: partial.id, items: [{ skuId: 'sku-1', quantity: 1 }], reasonCode: 'quality_issue', idempotencyKey: 'partial-first' })).data.idempotent, true);
  assert.equal((await call(app, 'refunds.list')).data.rows.length >= 2, true);
  const userGet = await call(app, 'refunds.get', { id: first.data.refund._id }); assert.equal(userGet.data.refund.description, '部分破损'); assert.equal(Object.hasOwn(userGet.data.refund, 'idempotencyKey'), false); assert.equal(userGet.data.media[0]._id, uploaded.data.mediaId);
  assert.equal((await call(app, 'admin.refunds.get', { adminToken, id: first.data.refund._id })).data.refund.userId, userId);
  assert.equal((await call(app, 'admin.refunds.get', { adminToken: restrictedToken, id: first.data.refund._id })).error.code, 'ADMIN_FORBIDDEN');
  assert.equal(Object.hasOwn((await call(app, 'admin.refunds.list', { adminToken })).data.rows[0], 'idempotencyKey'), false);
  const reviewed = await call(app, 'admin.refunds.review', { adminToken, id: first.data.refund._id, decision: 'approved', idempotencyKey: 'review-first' });
  assert.equal(reviewed.data.refund.status, 'awaiting_manual_refund'); assert.equal(reviewed.data.refund.manualRefundRequired, true);
  assert.equal((await call(app, 'admin.refunds.process', { adminToken, id: first.data.refund._id, action: 'succeeded', idempotencyKey: 'illegal-success' })).error.code, 'VALIDATION_ERROR');
  const processed = await call(app, 'admin.refunds.process', { adminToken, id: first.data.refund._id, action: 'channel_pending', idempotencyKey: 'process-first', note: '已提交渠道' });
  assert.equal(processed.data.refund.status, 'channel_pending'); assert.equal(processed.data.refund.manualRefundRequired, true);
  assert.equal((await call(app, 'admin.refunds.process', { adminToken, id: first.data.refund._id, action: 'channel_pending', idempotencyKey: 'process-first' })).data.idempotent, true);
  const noVerifierApp = createApplication({ ...options, refundVerifier: null });
  assert.equal((await call(noVerifierApp, 'refunds.notify', { refundNo: first.data.refund.refundNo, refundTransactionId: 'fake', amountCent: 1000 })).error.code, 'REFUND_NOT_CONFIGURED');
  assert.equal((await store.getById('refunds', first.data.refund._id)).status, 'channel_pending', '无真实渠道验签时不得写成退款成功');
  assert.equal((await call(app, 'refunds.notify', { refundNo: first.data.refund.refundNo, refundTransactionId: 'wx-partial-1', amountCent: 1000 })).ok, true);

  const remaining = await call(app, 'refunds.request', { orderId: partial.id, items: [{ orderItemId: partial.itemId, quantity: 1 }], reasonCode: 'missing_item', idempotencyKey: 'partial-remaining' });
  assert.equal(remaining.data.refund.amountCent, 1500, '成功部分退款后选择全部剩余数量应取得剩余商品加未退运费');

  const rejectOrder = await seedPaidOrder(store, userId, 'order-reject');
  const rejectedRequest = await call(app, 'refunds.request', { orderId: rejectOrder.id, items: [{ orderItemId: rejectOrder.itemId, quantity: 1 }], reasonCode: 'wrong_item', idempotencyKey: 'reject-first' });
  await call(app, 'admin.refunds.review', { adminToken, id: rejectedRequest.data.refund._id, decision: 'rejected', idempotencyKey: 'reject-review' });
  assert.equal((await call(app, 'refunds.request', { orderId: rejectOrder.id, items: [{ orderItemId: rejectOrder.itemId, quantity: 1 }], reasonCode: 'wrong_item', idempotencyKey: 'reject-second' })).ok, true, '拒绝后必须释放数量并允许重新申请');

  const concurrentOrder = await seedPaidOrder(store, userId, 'order-concurrent');
  const concurrentResults = await Promise.all([
    call(app, 'refunds.request', { orderId: concurrentOrder.id, items: [{ orderItemId: concurrentOrder.itemId, quantity: 1 }], reasonCode: 'damaged', idempotencyKey: 'concurrent-a' }),
    call(app, 'refunds.request', { orderId: concurrentOrder.id, items: [{ orderItemId: concurrentOrder.itemId, quantity: 1 }], reasonCode: 'damaged', idempotencyKey: 'concurrent-b' })
  ]);
  assert.equal(concurrentResults.filter((result) => result.ok).length, 1, '并发申请只能有一笔取得活动售后锁');
  assert.equal(concurrentResults.filter((result) => result.error && result.error.code === 'REFUND_ALREADY_PENDING').length, 1);

  const expired = await seedPaidOrder(store, userId, 'order-expired', 'completed', '2026-09-01T00:00:00.000Z');
  assert.equal((await call(app, 'refunds.request', { orderId: expired.id, items: [{ orderItemId: expired.itemId, quantity: 1 }], reasonCode: 'other', idempotencyKey: 'expired' })).error.code, 'REFUND_WINDOW_EXPIRED');
  console.log('refund contract tests: passed');
}

run().catch((error) => { console.error(error); process.exit(1); });
