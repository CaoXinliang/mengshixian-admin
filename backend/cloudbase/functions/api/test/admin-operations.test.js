const assert = require('assert/strict');
const { createApplication } = require('../app');
const { sha256 } = require('../lib/security');

function memoryStore() {
  const data = new Map(); let sequence = 0; let transactionQueue = Promise.resolve(); const rows = (name) => data.get(name) || [];
  const matches = (row, where = {}) => Object.entries(where || {}).every(([key, value]) => row[key] === value);
  const api = {
    async list(name, options = {}) { let out = rows(name).filter((row) => matches(row, options.where)); for (const rule of (options.orderBy || []).slice().reverse()) out = out.slice().sort((a, b) => (a[rule.field] === b[rule.field] ? 0 : (a[rule.field] || '') > (b[rule.field] || '') ? 1 : -1) * (rule.direction === 'desc' ? -1 : 1)); const page = options.page || 1; const pageSize = options.pageSize || 20; return { rows: out.slice((page - 1) * pageSize, page * pageSize), total: out.length, page, pageSize }; },
    async findOne(name, where) { return rows(name).find((row) => matches(row, where)) || null; },
    async getById(name, id) { return rows(name).find((row) => row._id === id) || null; },
    async create(name, value) { const row = { ...value, _id: value._id || `${name}-${++sequence}` }; data.set(name, [...rows(name), row]); return row; },
    async set(name, id, value) { const row = { ...value, _id: id }; data.set(name, rows(name).some((x) => x._id === id) ? rows(name).map((x) => x._id === id ? row : x) : [...rows(name), row]); return row; },
    async update(name, id, patch) { data.set(name, rows(name).map((row) => row._id === id ? { ...row, ...patch } : row)); return { _id: id, ...patch }; },
    async remove(name, id) { data.set(name, rows(name).filter((row) => row._id !== id)); },
    async runTransaction(work) { const run = transactionQueue.then(() => work({ getById: api.getById, set: api.set, update: api.update, remove: api.remove })); transactionQueue = run.catch(() => {}); return run; }
  }; return api;
}
const call = (app, action, payload = {}) => app.dispatch({ action, payload, requestId: action });

async function run() {
  const store = memoryStore(); const clock = () => new Date('2026-09-12T08:00:00.000Z');
  const app = createApplication({ store, getIdentity: () => ({ OPENID: 'admin-ops-user' }), bootstrapToken: 'bootstrap-secret', piiEncryptionKey: 'test-pii-encryption-key', clock });
  await call(app, 'admin.bootstrap', { bootstrapToken: 'bootstrap-secret', username: 'owner', displayName: 'Owner', password: '0123456789ab' });
  const login = await call(app, 'admin.login', { username: 'owner', password: '0123456789ab' }); const adminToken = login.data.token;
  await store.create('admin_sessions', { _id: 'expired-session', adminId: login.data.admin.id, tokenHash: sha256('expired-token'), status: 'active', expiresAt: '2026-09-01T00:00:00.000Z' });
  const protectedRoutes = [
    ['admin.inventory.ledger', {}], ['admin.versions.list', { entityType: 'product', entityId: 'none' }], ['admin.versions.rollback', { entityType: 'product', entityId: 'none', version: 1, idempotencyKey: 'x' }],
    ['admin.orders.notes.list', { id: 'none' }], ['admin.orders.notes.add', { id: 'none', note: 'x', idempotencyKey: 'x' }], ['admin.orders.batchTransition', { idempotencyKey: 'x', items: [{ id: 'none', status: 'picking' }] }],
    ['admin.products.batchUpsert', { idempotencyKey: 'x', items: [{ name: 'x', categoryId: 'none' }] }], ['admin.prices.batchUpsert', { idempotencyKey: 'x', items: [{ skuId: 'none', amountCent: 1 }] }]
  ];
  for (const [action, payload] of protectedRoutes) {
    assert.equal((await call(app, action, payload)).error.code, 'VALIDATION_ERROR', `${action} 匿名请求必须拒绝`);
    assert.equal((await call(app, action, { ...payload, adminToken: 'expired-token' })).error.code, 'ADMIN_SESSION_EXPIRED', `${action} 过期会话必须拒绝`);
  }
  const readRole = await call(app, 'admin.roles.upsert', { adminToken, code: 'catalog_reader_batch7', name: '商品只读', permissions: ['catalog.read'], status: 'active' });
  await call(app, 'admin.adminUsers.upsert', { adminToken, username: 'batch7-reader', displayName: 'Batch7 Reader', password: '0123456789cd', roleIds: [readRole.data._id], status: 'active' });
  const readLogin = await call(app, 'admin.login', { username: 'batch7-reader', password: '0123456789cd' }); const readToken = readLogin.data.token;
  for (const [action, payload] of protectedRoutes.filter(([action]) => action !== 'admin.versions.list')) assert.equal((await call(app, action, { ...payload, adminToken: readToken })).error.code, 'ADMIN_FORBIDDEN', `${action} 必须校验关键读写权限`);
  await store.create('categories', { _id: 'cat-1', name: '冷冻品', status: 'enabled' });
  await store.create('product_skus', { _id: 'sku-1', productId: 'seed-product', specName: '一箱', status: 'on_sale' });
  const opsRole = await call(app, 'admin.roles.upsert', { adminToken, code: 'batch7_operator', name: '批次7操作员', permissions: ['catalog.read', 'catalog.write', 'pricing.write', 'inventory.read', 'orders.read', 'orders.write'], status: 'active' });
  await call(app, 'admin.adminUsers.upsert', { adminToken, username: 'batch7-operator', displayName: 'Batch7 Operator', password: '0123456789ef', roleIds: [opsRole.data._id], status: 'active' });
  const opsLogin = await call(app, 'admin.login', { username: 'batch7-operator', password: '0123456789ef' }); const opsToken = opsLogin.data.token;

  const batchPayload = { adminToken: opsToken, idempotencyKey: 'batch-product-1', items: [{ name: '商品甲', categoryId: 'cat-1', status: 'draft', source: 'client', temporary: false }, { name: '坏商品', categoryId: 'missing', status: 'draft' }] };
  const batch = await call(app, 'admin.products.batchUpsert', batchPayload);
  assert.equal(batch.ok, true); assert.equal(batch.data.succeeded, 1); assert.equal(batch.data.failed, 1); assert.equal(batch.data.rows[1].error.code, 'CATEGORY_NOT_FOUND');
  const replay = await call(app, 'admin.products.batchUpsert', batchPayload); assert.equal(replay.data.idempotent, true); assert.deepEqual(replay.data.rows, batch.data.rows);
  const conflict = await call(app, 'admin.products.batchUpsert', { ...batchPayload, items: [{ name: '不同请求', categoryId: 'cat-1' }] }); assert.equal(conflict.error.code, 'IDEMPOTENCY_CONFLICT');
  const concurrentPayload = { adminToken, idempotencyKey: 'batch-product-concurrent', items: [{ name: '并发唯一商品', categoryId: 'cat-1', status: 'draft', source: 'client', temporary: false }, { name: '并发坏商品', categoryId: 'missing' }] };
  const concurrent = await Promise.all([call(app, 'admin.products.batchUpsert', concurrentPayload), call(app, 'admin.products.batchUpsert', concurrentPayload)]);
  assert.equal(concurrent.filter((result) => result.ok).length >= 1, true);
  assert.equal((await store.list('products', { where: { name: '并发唯一商品' }, page: 1, pageSize: 10 })).total, 1, '同键并发不得重复创建成功项');
  const concurrentReplay = await call(app, 'admin.products.batchUpsert', concurrentPayload); assert.equal(concurrentReplay.data.idempotent, true); assert.equal(concurrentReplay.data.failed, 1);

  const productId = batch.data.rows[0].id;
  const changed = await call(app, 'admin.products.upsert', { adminToken, id: productId, name: '商品甲改名', categoryId: 'cat-1', status: 'draft' }); assert.equal(changed.ok, true);
  const history = await call(app, 'admin.versions.list', { adminToken: opsToken, entityType: 'product', entityId: productId }); assert.equal(history.data.total, 2);
  const rollback = await call(app, 'admin.versions.rollback', { adminToken: opsToken, entityType: 'product', entityId: productId, version: 1, idempotencyKey: 'rollback-product-1' }); assert.equal(rollback.data.entity.name, '商品甲'); assert.equal(rollback.data.entity.revision, 3);
  const rollbackReplay = await call(app, 'admin.versions.rollback', { adminToken: opsToken, entityType: 'product', entityId: productId, version: 1, idempotencyKey: 'rollback-product-1' }); assert.equal(rollbackReplay.data.idempotent, true);
  const concurrentUpdates = await Promise.all([
    call(app, 'admin.products.upsert', { adminToken: opsToken, id: productId, name: '并发改名甲', categoryId: 'cat-1', status: 'draft' }),
    call(app, 'admin.products.upsert', { adminToken: opsToken, id: productId, name: '并发改名乙', categoryId: 'cat-1', status: 'draft' })
  ]);
  assert.equal(concurrentUpdates.filter((result) => result.ok).length, 1); assert.equal(concurrentUpdates.find((result) => !result.ok).error.code, 'VERSION_WRITE_IN_PROGRESS');
  const aiActive = await call(app, 'admin.products.upsert', { adminToken, id: productId, name: 'AI商品', categoryId: 'cat-1', status: 'on_sale', source: 'ai_generated', temporary: true }); assert.equal(aiActive.error.code, 'TEMPORARY_CANNOT_ACTIVATE');
  await store.create('products', { _id: 'ai-product', name: 'AI 草案商品', categoryId: 'cat-1', status: 'draft', source: 'ai_generated', temporary: true, demoNote: '草案' });
  await store.create('product_skus', { _id: 'ai-product-sku', productId: 'ai-product', specName: '一箱', status: 'on_sale' });
  const preservedProduct = await call(app, 'admin.products.upsert', { adminToken, id: 'ai-product', name: 'AI 草案商品改名', categoryId: 'cat-1', status: 'draft' });
  assert.equal(preservedProduct.data.source, 'ai_generated'); assert.equal(preservedProduct.data.temporary, true); assert.equal(preservedProduct.data.demoNote, '草案');
  assert.equal((await call(app, 'admin.products.setStatus', { adminToken, id: 'ai-product', status: 'on_sale' })).error.code, 'TEMPORARY_CANNOT_ACTIVATE');

  const aiBanner = await call(app, 'admin.banners.upsert', { adminToken, title: 'AI Banner', source: 'ai_generated', temporary: true }); assert.equal(aiBanner.data.enabled, false);
  const preservedBanner = await call(app, 'admin.banners.upsert', { adminToken, id: aiBanner.data._id, title: 'AI Banner 改名' }); assert.equal(preservedBanner.data.source, 'ai_generated'); assert.equal(preservedBanner.data.temporary, true); assert.equal(preservedBanner.data.enabled, false);
  assert.equal((await call(app, 'admin.banners.upsert', { adminToken, id: aiBanner.data._id, title: 'AI Banner', enabled: true })).error.code, 'TEMPORARY_CANNOT_ACTIVATE');
  const formalBanner = await call(app, 'admin.banners.upsert', { adminToken, title: '正式 Banner', source: 'client', temporary: false, enabled: true });
  await call(app, 'admin.banners.upsert', { adminToken, id: formalBanner.data._id, title: '正式 Banner 停用', enabled: false });
  const bannerHistory = await call(app, 'admin.versions.list', { adminToken, entityType: 'banner', entityId: formalBanner.data._id }); assert.equal(bannerHistory.data.total, 2);
  const bannerRollback = await call(app, 'admin.versions.rollback', { adminToken, entityType: 'banner', entityId: formalBanner.data._id, version: 1, idempotencyKey: 'banner-rollback-1' }); assert.equal(bannerRollback.data.entity.enabled, false, '回滚正式启用版本也必须先落停用草稿'); assert.equal(bannerRollback.data.entity.revision, 3);
  const homeSection = await call(app, 'admin.homeSections.upsert', { adminToken, title: '首页区块', moduleType: 'news', source: 'client', temporary: false, enabled: true });
  await call(app, 'admin.homeSections.upsert', { adminToken, id: homeSection.data._id, title: '首页区块停用', moduleType: 'news', enabled: false });
  assert.equal((await call(app, 'admin.versions.list', { adminToken, entityType: 'homeSection', entityId: homeSection.data._id })).data.total, 2);
  assert.equal((await call(app, 'admin.versions.rollback', { adminToken, entityType: 'homeSection', entityId: homeSection.data._id, version: 1, idempotencyKey: 'home-rollback-1' })).data.entity.enabled, false);
  const aiMedia = await call(app, 'admin.media.upsert', { adminToken, name: 'AI Media', type: 'image', source: 'ai_generated', temporary: true, fileId: 'cloud://ai.jpg', mimeType: 'image/jpeg', sizeBytes: 10 }); assert.equal(aiMedia.data.enabled, false);
  const preservedMedia = await call(app, 'admin.media.upsert', { adminToken, id: aiMedia.data._id, name: 'AI Media 改名', type: 'image', fileId: 'cloud://ai.jpg', mimeType: 'image/jpeg', sizeBytes: 10 }); assert.equal(preservedMedia.data.source, 'ai_generated'); assert.equal(preservedMedia.data.temporary, true); assert.equal(preservedMedia.data.enabled, false);
  assert.equal((await call(app, 'admin.media.upsert', { adminToken, id: aiMedia.data._id, name: 'AI Media', type: 'image', enabled: true, fileId: 'cloud://ai.jpg', mimeType: 'image/jpeg', sizeBytes: 10 })).error.code, 'TEMPORARY_CANNOT_ACTIVATE');

  const prices = await call(app, 'admin.prices.batchUpsert', { adminToken: opsToken, idempotencyKey: 'prices-1', items: [{ skuId: 'sku-1', scopeType: 'public', amountCent: 1999, status: 'active', source: 'client', temporary: false }, { skuId: 'missing', amountCent: 1 }] });
  assert.equal(prices.data.succeeded, 1); assert.equal(prices.data.failed, 1);
  const aiPrice = await call(app, 'admin.prices.upsert', { adminToken, skuId: 'sku-1', amountCent: 10, status: 'active', source: 'ai_generated', temporary: true }); assert.equal(aiPrice.error.code, 'TEMPORARY_CANNOT_ACTIVATE');

  await store.create('inventory_ledger', { _id: 'ledger-1', warehouseId: 'wh-1', skuId: 'sku-1', reason: 'manual_adjust', referenceId: 'r1', change: 3, createdAt: clock().toISOString() });
  const ledger = await call(app, 'admin.inventory.ledger', { adminToken: opsToken, warehouseId: 'wh-1', skuId: 'sku-1' }); assert.equal(ledger.data.total, 1);

  await store.create('orders', { _id: 'order-1', orderNo: 'MSX001', userId: 'user-1', organizationId: 'org-1', status: 'picking', paymentStatus: 'paid', paymentMethod: 'wechat', fulfillmentType: 'delivery', warehouseId: 'wh-1', totalAmountCent: 2000, addressSnapshot: { name: '张三', phoneMasked: '138****0000', regionCode: '4403', detail: '测试路1号' }, itemsSnapshot: [{ skuId: 'sku-1', productNameSnapshot: '商品甲', quantity: 2, unitPriceCent: 1000, subtotalCent: 2000 }], createdAt: clock().toISOString(), updatedAt: clock().toISOString() });
  const orders = await call(app, 'admin.orders.list', { adminToken: opsToken, status: 'picking', warehouseId: 'wh-1' }); assert.equal(orders.data.total, 1); assert.equal(Object.hasOwn(orders.data.rows[0], 'userId'), false);
  const note = await call(app, 'admin.orders.notes.add', { adminToken: opsToken, id: 'order-1', note: '优先出库', idempotencyKey: 'note-1' }); assert.equal(note.data.idempotent, false);
  assert.equal((await call(app, 'admin.orders.notes.add', { adminToken: opsToken, id: 'order-1', note: '优先出库', idempotencyKey: 'note-1' })).data.idempotent, true);
  assert.equal((await call(app, 'admin.orders.notes.add', { adminToken: opsToken, id: 'order-1', note: '不同备注', idempotencyKey: 'note-1' })).error.code, 'IDEMPOTENCY_CONFLICT');
  const exported = await call(app, 'admin.orders.export', { adminToken, status: 'picking' }); assert.equal(exported.data.rows.length, 1); assert.equal(Object.values(exported.data.rows[0]).includes(adminToken), false);
  const exportAudit = await store.findOne('audit_logs', { action: 'orders.export' }); assert.equal(JSON.stringify(exportAudit).includes(adminToken), false, '审计记录不得写入管理员 token');
  const picking = await call(app, 'admin.orders.pickingList', { adminToken, ids: ['order-1'] }); assert.equal(picking.data.rows[0].recipient.phoneMasked, '138****0000'); assert.equal(Object.hasOwn(picking.data.rows[0].recipient, 'phone'), false);
  await store.create('orders', { _id: 'order-2', orderNo: 'MSX002', userId: 'user-1', status: 'pending_confirmation', paymentStatus: 'paid', paymentMethod: 'wechat', itemsSnapshot: [], createdAt: clock().toISOString(), updatedAt: clock().toISOString() });
  const transitions = await call(app, 'admin.orders.batchTransition', { adminToken: opsToken, idempotencyKey: 'order-transition-1', items: [{ id: 'order-2', status: 'picking' }, { id: 'missing-order', status: 'picking' }] });
  assert.equal(transitions.data.succeeded, 1); assert.equal(transitions.data.failed, 1); assert.equal(transitions.data.rows[1].error.code, 'ORDER_NOT_FOUND');
  assert.equal((await call(app, 'admin.orders.batchTransition', { adminToken: opsToken, idempotencyKey: 'order-transition-1', items: [{ id: 'order-2', status: 'picking' }, { id: 'missing-order', status: 'picking' }] })).data.idempotent, true);
  assert.equal((await call(app, 'admin.orders.batchTransition', { adminToken: opsToken, idempotencyKey: 'order-transition-1', items: [{ id: 'order-2', status: 'shipping' }] })).error.code, 'IDEMPOTENCY_CONFLICT');

  const permissions = await call(app, 'admin.permissions.catalog', { adminToken }); assert.ok(permissions.data.permissions.some((item) => item.code === 'orders.read'));
  await store.create('group_members', { _id: 'gm-1', groupId: 'group-1', userId: 'user-1', status: 'paid', createdAt: clock().toISOString() });
  assert.equal((await call(app, 'admin.groups.members', { adminToken, groupId: 'group-1', status: 'paid' })).data.total, 1);
  await store.create('user_coupons', { _id: 'uc-1', templateId: 'ct-1', userId: 'user-1', status: 'used', idempotencyKey: 'secret', createdAt: clock().toISOString() });
  const grants = await call(app, 'admin.couponGrants.list', { adminToken, templateId: 'ct-1', status: 'used' }); assert.equal(grants.data.total, 1); assert.equal(Object.hasOwn(grants.data.rows[0], 'idempotencyKey'), false);
  await store.create('points_ledger', { _id: 'pl-1', userId: 'user-1', action: 'order_reward', change: 10, createdAt: clock().toISOString() }); assert.equal((await call(app, 'admin.points.ledger', { adminToken, userId: 'user-1' })).data.total, 1);
  await store.create('invoices', { _id: 'invoice-1', userId: 'user-1', orderId: 'order-1', status: 'pending_manual', titleType: 'company', titleSnapshot: { type: 'company', name: '测试公司', taxNo: '91440300123456789X', taxNoCiphertext: 'secret-tax-cipher', bankAccount: '6222000012345678', bankAccountCiphertext: 'secret-bank-cipher' }, createdAt: clock().toISOString() });
  const invoices = await call(app, 'admin.invoices.list', { adminToken, status: 'pending_manual', userId: 'user-1' }); const invoiceJson = JSON.stringify(invoices.data.rows[0]); assert.equal(invoiceJson.includes('91440300123456789X'), false); assert.equal(invoiceJson.includes('6222000012345678'), false); assert.equal(invoiceJson.includes('secret-tax-cipher'), false);

  console.log('admin operations tests: passed');
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
