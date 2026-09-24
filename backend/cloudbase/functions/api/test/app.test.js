const assert = require('assert/strict');
const { createApplication } = require('../app');
const { expireReservations, expireGroups } = require('../lib/commerce');
const { inventoryId } = require('../lib/transaction-ids');
const { ROLE_PERMISSIONS } = require('../lib/permissions');
const {hashPassword}=require('../lib/security');

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
  return app.dispatch({ action, payload, requestId: `test-${action}` });
}

async function run() {
  const store = createMemoryStore();
  // Historical accounts are storage-boundary fixtures, not newly supported management roles.
  const legacyRole=async data=>({ok:true,data:await store.create('admin_roles',data)});
  const legacyUser=async ({password,...data})=>({ok:true,data:await store.create('admin_users',{...data,...hashPassword(password)})});
  const fixedClock = () => new Date('2026-09-07T12:00:00.000Z');
  let uploadedMedia;
  const app = createApplication({ store, getIdentity: () => ({ OPENID: 'openid-test' }), bootstrapToken: 'bootstrap-only-token', piiEncryptionKey: 'unit-test-pii-encryption-key', paymentVerifier: async (payload) => payload, paymentPreparer: async () => ({ timeStamp: '123', nonceStr: 'nonce', package: 'prepay_id=test', paySign: 'test-sign' }), refundVerifier: async (payload) => payload, mediaUrlResolver: async (fileIds) => Object.fromEntries(fileIds.map((fileId) => [fileId, `https://cdn.example.test/${encodeURIComponent(fileId)}`])), storageUploader: async (payload) => { uploadedMedia = payload; return 'cloud://test/uploads/manual.png'; }, demoMode: true, clock: fixedClock });
  const unconfiguredApp = createApplication({ store: createMemoryStore(), getIdentity: () => ({ OPENID: 'openid-unconfigured' }), piiEncryptionKey: 'unit-test-pii-encryption-key', clock: fixedClock });
  assert.equal((await call(unconfiguredApp, 'payments.wechat.notify', {})).error.code, 'PAYMENT_NOT_CONFIGURED', '未配置支付验签器时必须拒绝通知');
  assert.equal((await call(unconfiguredApp, 'payments.wechat.prepare', { orderId: 'missing' })).error.code, 'PAYMENT_NOT_CONFIGURED', '未配置支付预下单时必须拒绝请求');
  assert.equal((await call(unconfiguredApp, 'refunds.notify', {})).error.code, 'REFUND_NOT_CONFIGURED', '未配置退款验签器时必须拒绝通知');
  assert.equal((await call(unconfiguredApp, 'orders.create', { paymentMethod: 'wechat' })).error.code, 'PAYMENT_NOT_CONFIGURED', '未配置支付预下单时必须拒绝创建微信订单');

  await store.create('categories', { _id: 'cat-seafood', name: '海鲜水产', status: 'enabled', sort: 1 });
  await store.create('products', { _id: 'product-1', name: '测试虾仁', categoryId: 'cat-seafood', categoryName: '海鲜水产', status: 'on_sale', sort: 1, price: 99, internalCost: 60, frozenTemperature: '-18℃' });
  await store.create('product_skus', { _id: 'sku-1', productId: 'product-1', specName: '500克', packageUnit: '1件/10包', status: 'on_sale', price: 99 });
  await store.create('media_assets', { _id: 'media-public', name: '公开素材', type: 'image', fileId: 'cloud://public/media.jpg', enabled: true });
  await store.create('media_assets', { _id: 'media-disabled', name: '停用素材', type: 'image', fileId: 'cloud://private/media.jpg', enabled: false });

  const health = await call(app, 'health');
  assert.equal(health.ok, true);
  assert.deepEqual(health.data.capabilities, { piiEncryption: true, paymentPrepare: true, paymentNotify: true, refundNotify: true, demoOrder: true });
  const unconfiguredHealth = await call(unconfiguredApp, 'health');
  assert.deepEqual(unconfiguredHealth.data.capabilities, { piiEncryption: true, paymentPrepare: false, paymentNotify: false, refundNotify: false, demoOrder: false });
  const catalog = await call(app, 'catalog.products');
  assert.equal(catalog.ok, true);
  assert.equal(catalog.data.rows.length, 1);
  assert.equal(Object.hasOwn(catalog.data.rows[0], 'price'), false, '未登录商品列表不得返回价格');
  assert.equal(Object.hasOwn(catalog.data.rows[0], 'internalCost'), false, '未登录商品列表不得返回成本');
  assert.equal(catalog.data.rows[0].skus[0].specName, '500克', '商品列表应返回不含价格的 SKU 规格摘要');
  assert.equal(Object.hasOwn(catalog.data.rows[0].skus[0], 'price'), false, '商品列表 SKU 摘要不得返回价格');
  const detail = await call(app, 'catalog.product', { productId: 'product-1' });
  assert.equal(detail.ok, true);
  assert.equal(Object.hasOwn(detail.data.skus[0], 'price'), false, '未登录 SKU 不得返回价格');
  const media = await call(app, 'content.media.resolve', { ids: ['media-public', 'media-disabled'] });
  assert.equal(media.ok, true);
  assert.deepEqual(media.data.rows.map((item) => item._id), ['media-public'], '公共素材解析不得返回停用素材');
  assert.equal(Object.hasOwn(media.data.rows[0], 'url'), false, '小程序素材解析不应返回网页临时 URL');
  const webMedia = await call(app, 'content.media.resolve', { ids: ['media-public'], platform: 'web' });
  assert.equal(webMedia.data.rows[0].url, 'https://cdn.example.test/cloud%3A%2F%2Fpublic%2Fmedia.jpg', '网页素材解析应返回受控临时 URL');

  const bootstrapRejected = await call(app, 'admin.bootstrap', { bootstrapToken: 'wrong', username: 'owner', password: '0123456789ab' });
  assert.equal(bootstrapRejected.error.code, 'BOOTSTRAP_FORBIDDEN');
  const bootstrap = await call(app, 'admin.bootstrap', { bootstrapToken: 'bootstrap-only-token', username: 'owner', displayName: '项目管理员', password: '0123456789ab' });
  assert.equal(bootstrap.ok, true);
  const login = await call(app, 'admin.login', { username: 'owner', password: '0123456789ab' });
  assert.equal(login.ok, true);
  const adminToken = login.data.token;
  const unchangedFinanceRole=await legacyRole({code:'finance_manager',name:'未显式授权的旧财务',status:'active'});
  await legacyUser({username:'unchanged-finance',displayName:'旧财务',password:'legacy-finance-password',roleIds:[unchangedFinanceRole.data._id],status:'active'});
  const unchangedFinance=await call(app,'admin.login',{username:'unchanged-finance',password:'legacy-finance-password'});
  assert.equal((await call(app,'admin.orders.receipts.list',{adminToken:unchangedFinance.data.token,orderId:'private-order'})).error.code,'ADMIN_FORBIDDEN','旧财务默认权限不得自动扩展到收款');
  const financeRole = await legacyRole({ code: 'finance_manager', name: '历史显式授权财务', permissions: [...ROLE_PERMISSIONS.finance_manager,'orders.read','receipts.read','receipts.write'], status: 'active' });
  assert.equal(financeRole.ok, true);
  await legacyUser({username:'receipt-finance',displayName:'历史收款员',password:'local-finance-test-only',roleIds:[financeRole.data._id],status:'active'});
  const financeLogin = await call(app, 'admin.login', { username: 'receipt-finance', password: 'local-finance-test-only' });
  const financeToken = financeLogin.data.token;
  assert.equal((await call(app, 'admin.orders.list', { adminToken: financeToken })).ok, true, '财务人员须能从订单列表进入收款');
  assert.equal((await call(app, 'admin.orders.transition', { adminToken: financeToken, id: 'missing', status: 'shipping' })).error.code, 'ADMIN_FORBIDDEN', '收款权限不应授权发货或改变订单状态');
  assert.equal((await call(app, 'admin.pricingTargets.list', {})).ok, false, '价格对象列表必须登录后读取');
  assert.equal((await call(app, 'admin.users.organizations', {})).ok, false, '客户企业选择列表必须登录');
  assert.deepEqual((await call(app, 'admin.pricingTargets.list', { adminToken, scopeType: 'customer_type' })).data.rows.map((row) => row._id), ['c', 'b']);
  const forbiddenLargeUpload = await call(app, 'admin.media.beginUpload', { adminToken: 'wrong', type: 'video', mimeType: 'video/mp4', fileName: 'x.mp4', sizeBytes: 5 * 1024 * 1024, sha256: '0'.repeat(64) });
  assert.equal(forbiddenLargeUpload.error.code, 'ADMIN_SESSION_EXPIRED', '分段上传必须先检查管理员会话');
  const unavailableLargeUpload = await call(app, 'admin.media.beginUpload', { adminToken, type: 'video', mimeType: 'video/mp4', fileName: 'x.mp4', sizeBytes: 5 * 1024 * 1024, sha256: '0'.repeat(64) });
  assert.equal(unavailableLargeUpload.error.code, 'MEDIA_UPLOAD_UNAVAILABLE', '缺少服务端文件读取能力时不得开放分段上传');
  const initialReadiness = await call(app, 'admin.readiness', { adminToken });
  assert.equal(initialReadiness.data.counts.productsOnSale, 1, '运营就绪报告应返回已上架商品数量');
  assert.equal(initialReadiness.data.quoteAndOrderDataReady, false, '未配置价格和履约数据时不得宣称可报价下单');
  const customRole = await legacyRole({code:'catalog_auditor',name:'历史商品只读',permissions:['catalog.read'],status:'active'});
  assert.equal(customRole.ok, true);
  const secondAdmin = await legacyUser({username:'catalog-reader',displayName:'历史商品查看员',password:'1234567890ab',roleIds:[customRole.data._id],status:'active'});
  assert.equal(secondAdmin.ok, true);
  const adminWriterRole = await legacyRole({code:'admin_writer',name:'历史管理员维护员',permissions:['admin.read','admin.write'],status:'active'});
  assert.equal(adminWriterRole.ok, true);
  const adminWriter = await legacyUser({username:'admin-writer',displayName:'历史管理员维护员',password:'1234567890ab',roleIds:[adminWriterRole.data._id],status:'active'});
  assert.equal(adminWriter.ok, true);
  const adminWriterLogin = await call(app, 'admin.login', { username: 'admin-writer', password: '1234567890ab' });
  assert.equal(adminWriterLogin.ok, true);
  const superAdminEscalation = await call(app, 'admin.adminUsers.upsert', { adminToken: adminWriterLogin.data.token, username: 'forbidden-super', displayName: '非法提权', password: '1234567890ab', roleIds: [bootstrap.data.admin.roleIds[0]], status: 'active' });
  assert.equal(superAdminEscalation.error.code, 'ADMIN_FORBIDDEN', '只有超级管理员可以管理账号');
  const superAdminDemotion = await call(app, 'admin.adminUsers.upsert', { adminToken: adminWriterLogin.data.token, id: bootstrap.data.admin.id, username: 'owner', displayName: '项目管理员', roleIds: [adminWriterRole.data._id], status: 'active' });
  assert.equal(superAdminDemotion.error.code, 'ADMIN_FORBIDDEN', '管理员维护权限不得移除超级管理员角色');
  const wildcardRole = await call(app, 'admin.roles.upsert', { adminToken: adminWriterLogin.data.token, code: 'wildcard_role', name: '全权角色', permissions: ['*'], status: 'active' });
  assert.equal(wildcardRole.error.code, 'ADMIN_FORBIDDEN', '非超级管理员不得管理角色');
  const superRoleRewrite = await call(app, 'admin.roles.upsert', { adminToken: adminWriterLogin.data.token, id: bootstrap.data.admin.roleIds[0], code: 'hacked_super', name: '越权改写', permissions: ['audit.read'], status: 'active' });
  assert.equal(superRoleRewrite.error.code, 'ADMIN_FORBIDDEN', '非超级管理员不得通过旧入口改写角色');
  const sneakyRole = await call(app, 'admin.roles.upsert', { adminToken: adminWriterLogin.data.token, code: 'sneaky_role', name: '越权角色', permissions: ['refunds.write'], status: 'active' });
  assert.equal(sneakyRole.error.code, 'ADMIN_FORBIDDEN');
  const sneakyAssign = await call(app, 'admin.adminUsers.upsert', { adminToken: adminWriterLogin.data.token, username: 'sneaky-user', displayName: '越权分配', password: '1234567890ab', roleIds: [customRole.data._id], status: 'active' });
  assert.equal(sneakyAssign.error.code, 'ADMIN_FORBIDDEN', '不得通过旧入口分配角色');
  const subsetRole = await call(app, 'admin.roles.upsert', { adminToken: adminWriterLogin.data.token, code: 'session_reader', name: '会话只读', permissions: ['admin.read'], status: 'active' });
  assert.equal(subsetRole.error.code, 'ADMIN_FORBIDDEN');
  const subsetAssign = await call(app, 'admin.adminUsers.upsert', { adminToken: adminWriterLogin.data.token, username: 'session-reader', displayName: '会话查看员', password: '1234567890ab', roleIds: [adminWriterRole.data._id], status: 'active' });
  assert.equal(subsetAssign.error.code, 'ADMIN_FORBIDDEN', '即使角色未超出自身权限，非超管也不能管理工作人员');
  const secondLogin = await call(app, 'admin.login', { username: 'catalog-reader', password: '1234567890ab' });
  assert.equal((await call(app, 'admin.pricingTargets.list', { adminToken: secondLogin.data.token, scopeType: 'user' })).error.code, 'ADMIN_FORBIDDEN', '只有商品读取权限不能查询价格客户对象');
  assert.equal((await call(app, 'admin.users.organizations', { adminToken: secondLogin.data.token })).error.code, 'ADMIN_FORBIDDEN', '客户企业选择列表需要客户读取权限');
  assert.equal(secondLogin.ok, true);
  for (const action of ['admin.orders.receipts.list', 'admin.orders.receipts.record']) {
    assert.equal((await call(app, action, { orderId: 'private-order' })).error.code, 'VALIDATION_ERROR', '收款接口未登录不能访问');
    assert.equal((await call(app, action, { adminToken: 'invalid-session', orderId: 'private-order' })).error.code, 'ADMIN_SESSION_EXPIRED', '失效会话不能查看或登记收款');
    assert.equal((await call(app, action, { adminToken: secondLogin.data.token, orderId: 'private-order' })).error.code, 'ADMIN_FORBIDDEN', '商品读取权限不能查看或登记收款，且不得泄露订单是否存在');
  }
  const secondAdminCategories = await call(app, 'admin.categories.list', { adminToken: secondLogin.data.token });
  assert.equal(secondAdminCategories.ok, true, '受限管理员应按角色获得只读商品权限');
  const rejectedPasswordChange = await call(app, 'admin.password.change', { adminToken: secondLogin.data.token, currentPassword: 'wrong-password', newPassword: 'next-password-2026' });
  assert.equal(rejectedPasswordChange.error.code, 'ADMIN_PASSWORD_INVALID', '自助改密必须验证当前密码');
  const passwordChanged = await call(app, 'admin.password.change', { adminToken: secondLogin.data.token, currentPassword: '1234567890ab', newPassword: 'next-password-2026' });
  assert.equal(passwordChanged.data.reLoginRequired, true, '改密后必须要求重新登录');
  const revokedSession = await call(app, 'admin.me', { adminToken: secondLogin.data.token });
  assert.equal(revokedSession.ok, false, '改密后旧会话不得继续有效');
  const oldPasswordLogin = await call(app, 'admin.login', { username: 'catalog-reader', password: '1234567890ab' });
  assert.equal(oldPasswordLogin.error.code, 'ADMIN_LOGIN_FAILED', '旧密码在改密后必须失效');
  const newPasswordLogin = await call(app, 'admin.login', { username: 'catalog-reader', password: 'next-password-2026' });
  assert.equal(newPasswordLogin.ok, true, '新密码必须可重新登录');
  const homeSection = await call(app, 'admin.homeSections.upsert', { adminToken, contentKey: 'test-special', moduleType: 'special', title: '后台特价专区', subtitle: '后台副标题', linkText: '去选购', sort: 2 });
  assert.equal(homeSection.ok, true);
  assert.equal(homeSection.data.moduleType, 'special');
  const publicHomeSections = await call(app, 'content.homeSections', { platform: 'miniapp' });
  assert.equal(publicHomeSections.ok, true);
  assert.equal(publicHomeSections.data.rows[0].moduleType, 'special', '公共首页模块必须返回模块类型');
  assert.equal(publicHomeSections.data.rows[0].contentKey, 'test-special', '公共首页模块必须返回稳定业务键');
  assert.equal(publicHomeSections.data.rows[0].subtitle, '后台副标题');
  const duplicatedHomeSection = await call(app, 'admin.homeSections.upsert', { adminToken, contentKey: 'test-special', moduleType: 'special', title: '重复模块' });
  assert.equal(duplicatedHomeSection.error.code, 'CONTENT_KEY_CONFLICT', '同一首页模块业务键不得重复创建');
  const editedHomeSection = await call(app, 'admin.homeSections.upsert', { adminToken, id: homeSection.data._id, moduleType: 'special', title: '后台特价专区已修改' });
  assert.equal(editedHomeSection.data.contentKey, 'test-special', '后台普通编辑不能清空受控内容业务键');
  const invalidJumpType = await call(app, 'admin.homeSections.upsert', { adminToken, moduleType: 'news', title: '错误跳转', jumpType: 'activity', jumpTarget: 'x' });
  assert.equal(invalidJumpType.error.code, 'JUMP_TYPE_INVALID', '后台内容跳转类型必须受控');
  const invalidContentPlatform = await call(app, 'admin.banners.upsert', { adminToken, title: '错误投放端', targetPlatforms: ['desktop'] });
  assert.equal(invalidContentPlatform.error.code, 'VALIDATION_ERROR', '后台内容投放端必须限制为已支持的客户端');
  const invalidContentSchedule = await call(app, 'admin.banners.upsert', { adminToken, title: '错误排期', startAt: '2026-09-08T13:00:00.000Z', endAt: '2026-09-08T12:00:00.000Z' });
  assert.equal(invalidContentSchedule.error.code, 'VALIDATION_ERROR', '后台内容结束时间不得早于开始时间');
  const missingJumpTarget = await call(app, 'admin.homeSections.upsert', { adminToken, moduleType: 'news', title: '缺少目标', jumpType: 'product' });
  assert.equal(missingJumpTarget.error.code, 'JUMP_TARGET_REQUIRED', '非 none 跳转必须填写目标');
  await store.create('products', { _id: 'content-target-test', name: '首页目标测试', status: 'draft', audienceType: 'all' });
  const targetBanner = { adminToken, title: '目标状态测试', jumpType: 'product', jumpTarget: 'content-target-test' };
  assert.equal((await call(app, 'admin.banners.upsert', targetBanner)).error.code, 'CONTENT_TARGET_UNAVAILABLE');
  assert.equal((await call(app, 'admin.banners.upsert', { ...targetBanner, jumpTarget: 'missing-target' })).error.code, 'CONTENT_TARGET_NOT_FOUND');
  const draftBanner = await call(app, 'admin.banners.upsert', { ...targetBanner, enabled: false });
  assert.equal(draftBanner.ok, true, 'Unavailable existing target can remain a disabled draft');
  await store.update('products', 'content-target-test', { status: 'on_sale' });
  assert.equal((await call(app, 'admin.banners.upsert', { ...targetBanner, id: draftBanner.data._id, enabled: true })).ok, true);
  assert.ok((await call(app, 'content.banners', {})).data.rows.some((row) => row._id === draftBanner.data._id));
  await store.update('products', 'content-target-test', { status: 'off_sale' });
  assert.ok(!(await call(app, 'content.banners', {})).data.rows.some((row) => row._id === draftBanner.data._id), 'Off-sale product must disappear from public homepage targets');
  const jumpUrlSection = await call(app, 'admin.homeSections.upsert', { adminToken, moduleType: 'group', title: '外链跳转', jumpType: 'url', jumpTarget: 'https://example.com/activity', sort: 3 });
  assert.equal(jumpUrlSection.ok, true);
  const publicJumpSections = await call(app, 'content.homeSections', { platform: 'miniapp' });
  assert.equal(publicJumpSections.data.rows.find((item) => item._id === jumpUrlSection.data._id).jumpType, 'url', '公共接口必须保留首页模块跳转类型');

  const missingCategoryMedia = await call(app, 'admin.categories.upsert', { adminToken, name: '不存在图片的分类', imageMediaId: 'missing-media', status: 'enabled', sort: 3 });
  assert.equal(missingCategoryMedia.error.code, 'MEDIA_NOT_FOUND', '分类不得引用不存在的素材');
  const managedMedia = await call(app, 'admin.media.upsert', { adminToken, name: '分类临时图片', assetKey: 'category-test', type: 'image', source: 'ai_generated', temporary: true, checksum: 'checksum-v1', fileId: 'cloud://test/category-v1.jpg', mimeType: 'image/jpeg', sizeBytes: 1024 });
  assert.equal(managedMedia.ok, true);
  assert.equal(managedMedia.data.assetKey, 'category-test');
  assert.equal(managedMedia.data.checksum, 'checksum-v1');
  const uploaded = await call(app, 'admin.media.upload', { adminToken, type: 'image', fileName: '统一文字图.png', mimeType: 'image/png', sizeBytes: 8, contentBase64: Buffer.from('text-img').toString('base64') });
  assert.equal(uploaded.ok, true, '管理员应能通过受控后台接口上传素材');
  assert.equal(uploaded.data.fileId, 'cloud://test/uploads/manual.png');
  assert.equal(uploadedMedia.mimeType, 'image/png');
  assert.equal(uploadedMedia.sizeBytes, 8);
  assert.equal(uploadedMedia.contentBase64, Buffer.from('text-img').toString('base64'));
  const oversizeUpload = await call(app, 'admin.media.upload', { adminToken, type: 'image', fileName: 'too-large.png', mimeType: 'image/png', sizeBytes: 4 * 1024 * 1024 + 1, contentBase64: Buffer.from('x').toString('base64') });
  assert.equal(oversizeUpload.error.code, 'MEDIA_SIZE_INVALID', '后台上传必须阻止超过 4 MB 的直传文件');
  const webOnlyMedia = await call(app, 'admin.media.upsert', { adminToken, name: '网页专用素材', type: 'image', source: 'demo', temporary: true, targetPlatforms: ['web'], fileId: 'cloud://test/web-only.jpg', mimeType: 'image/jpeg', sizeBytes: 1024 });
  assert.equal(webOnlyMedia.ok, true);
  const miniappMediaResolve = await call(app, 'content.media.resolve', { ids: [webOnlyMedia.data._id], platform: 'miniapp' });
  assert.equal(miniappMediaResolve.data.rows.length, 0, '小程序不得解析网页专用素材');
  const webMediaResolve = await call(app, 'content.media.resolve', { ids: [webOnlyMedia.data._id], platform: 'web' });
  assert.equal(webMediaResolve.data.rows[0]._id, webOnlyMedia.data._id, '网页应解析网页专用素材');
  const futureMedia = await call(app, 'admin.media.upsert', { adminToken, name: '未到期素材', type: 'image', source: 'demo', temporary: true, startAt: '2026-09-08T13:00:00.000Z', fileId: 'cloud://test/future.jpg', mimeType: 'image/jpeg', sizeBytes: 1024 });
  assert.equal(futureMedia.ok, true);
  const futureMediaResolve = await call(app, 'content.media.resolve', { ids: [futureMedia.data._id], platform: 'miniapp' });
  assert.equal(futureMediaResolve.data.rows.length, 0, '未到开始时间的素材不得公开解析');
  const invalidProductMedia = await call(app, 'admin.products.upsert', { adminToken, name: '不存在图片的商品', categoryId: 'cat-seafood', coverMediaId: 'missing-media', frozenTemperature: '-18℃' });
  assert.equal(invalidProductMedia.error.code, 'MEDIA_NOT_FOUND', '商品不得引用不存在的主图');
  const managedCategory = await call(app, 'admin.categories.upsert', { adminToken, name: '测试分类', imageMediaId: managedMedia.data._id, status: 'enabled', sort: 3 });
  assert.equal(managedCategory.ok, true);
  const publicCategoriesWithMedia = await call(app, 'catalog.categories', { page: 1, pageSize: 100 });
  assert.equal(publicCategoriesWithMedia.data.rows.find((item) => item._id === managedCategory.data._id).imageMediaId, managedMedia.data._id, '公共分类接口必须返回已关联的分类图片 ID，供小程序解析媒体');
  const managedMediaVersion = await call(app, 'admin.media.createVersion', { adminToken, replacesMediaAssetId: managedMedia.data._id, name: '分类临时图片 v2', assetKey: 'category-test', type: 'image', source: 'client', temporary: false, checksum: 'checksum-v2', fileId: 'cloud://test/category-v2.jpg', mimeType: 'image/jpeg', sizeBytes: 2048 });
  assert.equal(managedMediaVersion.ok, true);
  assert.equal(managedMediaVersion.data.version, 2, '素材替换必须生成新版本');
  assert.equal(managedMediaVersion.data.previousMediaAssetId, managedMedia.data._id, '新版本必须保留上一版本引用');
  const overwriteMedia = await call(app, 'admin.media.upsert', { adminToken, id: managedMedia.data._id, name: '错误覆盖', type: 'image', source: 'ai_generated', temporary: true, fileId: 'cloud://test/category-overwrite.jpg', mimeType: 'image/jpeg', sizeBytes: 1024 });
  assert.equal(overwriteMedia.error.code, 'MEDIA_VERSION_REQUIRED', '已有素材不得直接覆盖云端文件');
  const managedProduct = await call(app, 'admin.products.upsert', { adminToken, spuCode: 'MANAGED-001', name: '测试商品', categoryId: managedCategory.data._id, frozenTemperature: '-18℃' });
  const managedVideo = await call(app, 'admin.media.upsert', { adminToken, name: '商品详情临时视频', assetKey: 'product-video-test', type: 'video', source: 'ai_generated', temporary: true, fileId: 'cloud://test/product-video.mp4', mimeType: 'video/mp4', sizeBytes: 2048 });
  assert.equal(managedVideo.ok, true);
  const productMediaAssociation = await call(app, 'admin.productMedia.upsert', { adminToken, productId: managedProduct.data._id, mediaAssetId: managedVideo.data._id, mediaType: 'video', role: 'detail', sort: 0, enabled: true });
  assert.equal(productMediaAssociation.ok, true, '管理员应能把已登记视频关联到商品详情');
  assert.equal(productMediaAssociation.data.productId, managedProduct.data._id);
  assert.equal(productMediaAssociation.data.mediaType, 'video');
  const listedProductMedia = await call(app, 'admin.productMedia.list', { adminToken, productId: managedProduct.data._id });
  assert.equal(listedProductMedia.data.rows.length, 1, '后台商品媒体列表必须返回已关联视频');
  const wrongProductMediaType = await call(app, 'admin.productMedia.upsert', { adminToken, productId: managedProduct.data._id, mediaAssetId: managedVideo.data._id, mediaType: 'image', role: 'cover' });
  assert.equal(wrongProductMediaType.error.code, 'MEDIA_TYPE_INVALID', '商品媒体关联不得把视频素材登记为图片');
  const managedSku = await call(app, 'admin.skus.upsert', { adminToken, productId: managedProduct.data._id, skuCode: 'MANAGED-SKU-001', specName: '测试规格', packageUnit: '1件/10包', status: 'draft' });
  const prematurePublish = await call(app, 'admin.products.setStatus', { adminToken, id: managedProduct.data._id, status: 'on_sale' });
  assert.equal(prematurePublish.error.code, 'CATALOG_REVIEW_REQUIRED');
  const earlyReview = await call(app, 'admin.products.review', { adminToken, id: managedProduct.data._id });
  assert.equal(earlyReview.data.ready, false);
  assert.ok(earlyReview.data.issues.some((issue) => issue.includes('主图')));
  const skuWithoutPrice = await call(app, 'admin.skus.setStatus', { adminToken, id: managedSku.data._id, status: 'on_sale' });
  assert.equal(skuWithoutPrice.error.code, 'PRODUCT_NOT_READY', '无真实价格的规格不得启用销售');
  const managedPrice = await call(app, 'admin.prices.upsert', { adminToken, skuId: managedSku.data._id, scopeType: 'public', amountCent: 4600, status: 'active' });
  assert.equal(managedPrice.ok, true);
  const publishSku = await call(app, 'admin.skus.setStatus', { adminToken, id: managedSku.data._id, status: 'on_sale' });
  assert.equal(publishSku.error.code, 'PRODUCT_NOT_READY', '商品未通过完整核对前，规格不得绕过核对直接上架');
  assert.equal((await store.getById('product_skus', managedSku.data._id)).status, 'draft', '被拒后不得部分写入');
  const noCoverPublish = await call(app, 'admin.products.setStatus', { adminToken, id: managedProduct.data._id, status: 'on_sale' });
  assert.equal(noCoverPublish.error.code, 'CATALOG_REVIEW_REQUIRED', '必须经过独立核对页发布');
  const addManagedCover = await call(app, 'admin.products.upsert', { adminToken, id: managedProduct.data._id, name: '测试商品', categoryId: managedCategory.data._id, coverMediaId: managedMedia.data._id });
  assert.equal(addManagedCover.ok, true);
  const missingStockReview = await call(app, 'admin.products.review', { adminToken, id: managedProduct.data._id });
  assert.equal(missingStockReview.data.ready, false);
  assert.match(missingStockReview.data.issues.join('；'), /可售库存/);
  await store.create('warehouses', { _id: 'review-test-warehouse', name: '本地验收仓', status: 'active' });
  await store.create('inventory', { skuId: managedSku.data._id, warehouseId: 'review-test-warehouse', available: 2 });
  const missingDeliveryReview = await call(app, 'admin.products.review', { adminToken, id: managedProduct.data._id });
  assert.equal(missingDeliveryReview.data.ready, false);
  assert.match(missingDeliveryReview.data.issues.join('；'), /配送/);
  await store.create('delivery_areas', { _id: 'review-area', name: '本地验收区', warehouseIds: ['review-test-warehouse'], regionCodes: ['TEST-REVIEW'], status: 'active' });
  await store.create('freight_rules', { _id: 'review-freight', name: '本地测试运费', deliveryAreaId: 'review-area', warehouseId: 'review-test-warehouse', baseFeeCent: 500, status: 'active' });
  await store.create('delivery_slots', { _id: 'review-slot', name: '本地测试时段', deliveryAreaId: 'review-area', warehouseId: 'review-test-warehouse', startTime: '09:00', endTime: '12:00', status: 'active' });
  const reviewManaged = await call(app, 'admin.products.review', { adminToken, id: managedProduct.data._id });
  assert.equal(reviewManaged.data.ready, true, reviewManaged.data.issues.join('；'));
  await store.update('prices', managedPrice.data._id, { channel: 'web' });
  const webOnlyReview = await call(app, 'admin.products.review', { adminToken, id: managedProduct.data._id });
  assert.equal(webOnlyReview.data.ready, false, 'Web-only price cannot support personal miniapp publication');
  assert.match(webOnlyReview.data.issues.join('；'), /个人顾客/);
  const oldPricePublish = await call(app, 'admin.products.publishReviewed', { adminToken, id: managedProduct.data._id, reviewToken: reviewManaged.data.reviewToken });
  assert.equal(oldPricePublish.error.code, 'CATALOG_REVIEW_STALE', 'Price channel changes invalidate review even without timestamp changes');
  await store.update('prices', managedPrice.data._id, { channel: 'all' });
  const originalTransaction = store.runTransaction;
  const originalSku = await store.getById('product_skus', managedSku.data._id);
  const originalProductStatus = (await store.getById('products', managedProduct.data._id)).status;
  store.runTransaction = async function (work) {
    await store.update('product_skus', managedSku.data._id, { status: 'off_sale' });
    return originalTransaction.call(store, work);
  };
  const changedSkuPublish = await call(app, 'admin.products.publishReviewed', { adminToken, id: managedProduct.data._id, reviewToken: reviewManaged.data.reviewToken });
  store.runTransaction = originalTransaction;
  assert.equal(changedSkuPublish.error.code, 'CATALOG_REVIEW_STALE', 'Concurrent SKU change must abort publication');
  assert.equal((await store.getById('products', managedProduct.data._id)).status, originalProductStatus);
  await store.update('product_skus', managedSku.data._id, { status: originalSku.status, packageUnit: '修改包装' });
  const packagingChanged = await call(app, 'admin.products.publishReviewed', { adminToken, id: managedProduct.data._id, reviewToken: reviewManaged.data.reviewToken });
  assert.equal(packagingChanged.error.code, 'CATALOG_REVIEW_STALE', 'Packaging changes must invalidate review without relying on timestamp');
  await store.update('product_skus', managedSku.data._id, { packageUnit: originalSku.packageUnit });
  const reviewInventory = await store.findOne('inventory', { skuId: managedSku.data._id });
  for (const [collection, id, patch] of [
    ['prices', managedPrice.data._id, { amountCent: 4700 }],
    ['inventory', reviewInventory._id, { available: 0 }],
    ['freight_rules', 'review-freight', { status: 'disabled' }],
    ['delivery_slots', 'review-slot', { status: 'disabled' }]
  ]) {
    const before = await store.getById(collection, id);
    store.runTransaction = async function (work) {
      await store.update(collection, id, patch);
      return originalTransaction.call(store, work);
    };
    const raced = await call(app, 'admin.products.publishReviewed', { adminToken, id: managedProduct.data._id, reviewToken: reviewManaged.data.reviewToken });
    store.runTransaction = originalTransaction;
    assert.equal(raced.error.code, 'CATALOG_REVIEW_STALE', `Concurrent ${collection} changes must abort publication`);
    assert.equal((await store.getById('products', managedProduct.data._id)).status, originalProductStatus);
    await store.update(collection, id, before);
  }
  const stalePublish = await call(app, 'admin.products.publishReviewed', { adminToken, id: managedProduct.data._id, reviewToken: earlyReview.data.reviewToken });
  assert.equal(stalePublish.error.code, 'CATALOG_REVIEW_STALE');
  const publishProduct = await call(app, 'admin.products.publishReviewed', { adminToken, id: managedProduct.data._id, reviewToken: reviewManaged.data.reviewToken });
  assert.equal(publishProduct.ok, true);
  const editedProduct = await call(app, 'admin.products.upsert', { adminToken, id: managedProduct.data._id, name: '测试商品（更新）', categoryId: managedCategory.data._id, frozenTemperature: '-18℃' });
  assert.equal(editedProduct.data.status, 'on_sale', '未提交状态字段的商品编辑不得把已上架商品降回草稿');

  const warehouse = await call(app, 'admin.warehouses.upsert', { adminToken, code: 'WH-1', name: '测试仓', status: 'active' });
  assert.equal(warehouse.ok, true);
  await store.create('products', { _id: 'fixture-product', name: '多规格测试商品', categoryId: 'cat-seafood', categoryName: '海鲜水产', status: 'on_sale' });
  await store.create('product_skus', { _id: 'fixture-primary-sku', productId: 'fixture-product', specName: '旧规格', packageUnit: '旧包装', status: 'on_sale' });
  await store.create('import_jobs', { _id: 'fixture-import', sourceKey: 'product-demo-50.json:501', sourceFile: 'product-demo-50.json', status: 'imported', productId: 'fixture-product', skuId: 'fixture-primary-sku' });
  const multiSkuSeed = await call(app, 'admin.demo.seedCommerce', {
    adminToken, warehouseId: warehouse.data._id, sourceFile: 'product-demo-50.json', source: 'ai_generated', temporary: true,
    entries: [{ sourceId: '501', skus: [
      { key: 'retail', specName: '500g/包', packageUnit: '1包', amountCent: 2880, initialStock: 40, sort: 0 },
      { key: 'case', specName: '10包/件', packageUnit: '1件', amountCent: 27360, initialStock: 12, sort: 10 }
    ] }]
  });
  assert.equal(multiSkuSeed.ok, true);
  assert.equal(multiSkuSeed.data.seededProducts, 1);
  assert.equal(multiSkuSeed.data.seededSkus, 2);
  const seededDetail = await call(app, 'catalog.product', { productId: 'fixture-product' });
  assert.deepEqual(seededDetail.data.skus.map((sku) => sku.specName), ['500g/包', '10包/件'], '测试商品必须返回两个独立可选 SKU');
  const seededPrices = await call(app, 'catalog.prices', { skuIds: seededDetail.data.skus.map((sku) => sku._id) });
  assert.deepEqual(seededPrices.data.rows.map((row) => row.amountCent), [2880, 27360], '每个 SKU 必须独立参与服务端报价');
  const inventory = await call(app, 'admin.inventory.adjust', { adminToken, warehouseId: warehouse.data._id, skuId: 'sku-1', change: 20, reason: 'initial_stock', idempotencyKey: 'inventory-initial-1' });
  assert.equal(inventory.ok, true);
  const area = await call(app, 'admin.deliveryAreas.upsert', { adminToken, name: '测试配送区', regionCodes: ['440300'], warehouseIds: [warehouse.data._id], status: 'active' });
  assert.equal(area.ok, true);
  const deliveryOptions = await call(app, 'delivery.options');
  assert.equal(deliveryOptions.ok, true);
  assert.ok(deliveryOptions.data.warehouses.some((item) => item._id === warehouse.data._id), '公开配送选项必须包含启用仓库事实');
  const freight = await call(app, 'admin.freightRules.upsert', { adminToken, name: '测试运费', deliveryAreaId: area.data._id, warehouseId: warehouse.data._id, baseFeeCent: 800, freeThresholdCent: 10000, status: 'active' });
  assert.equal(freight.ok, true, JSON.stringify(freight));
  const deliverySlot = await call(app, 'admin.deliverySlots.upsert', { adminToken, name: '上午配送', deliveryAreaId: area.data._id, warehouseId: warehouse.data._id, startTime: '09:00', endTime: '12:00', status: 'active' });
  assert.equal(deliverySlot.ok, true);
  const price = await call(app, 'admin.prices.upsert', { adminToken, skuId: 'sku-1', scopeType: 'public', amountCent: 2500, status: 'active', source: 'ai_generated', temporary: true, demoNote: '演示价格，待甲方确认后替换' });
  assert.equal(price.ok, true);

  // 分层上架必须是服务端交易边界，而不只是列表隐藏：C/B 商品各自只能被对应身份查看、询价、加购和结算。
  await store.create('products', { _id: 'product-b-only', name: 'B端专享冻品', categoryId: 'cat-seafood', categoryName: '海鲜水产', audienceType: 'b', status: 'on_sale', sort: -100 });
  await store.create('product_skus', { _id: 'sku-b-only', productId: 'product-b-only', specName: '企业箱装', packageUnit: '1件', status: 'on_sale' });
  await store.create('prices', { _id: 'price-b-only', skuId: 'sku-b-only', scopeType: 'public', amountCent: 8800, currency: 'CNY', status: 'active' });
  await store.create('inventory', { _id: inventoryId(warehouse.data._id, 'sku-b-only'), warehouseId: warehouse.data._id, skuId: 'sku-b-only', onHand: 10, reserved: 0, available: 10, version: 1 });
  await store.create('products', { _id: 'product-c-only', name: 'C端专享冻品', categoryId: 'cat-seafood', categoryName: '海鲜水产', audienceType: 'c', status: 'on_sale', sort: -90 });
  await store.create('product_skus', { _id: 'sku-c-only', productId: 'product-c-only', specName: '家庭装', packageUnit: '1包', status: 'on_sale' });
  await store.create('prices', { _id: 'price-c-only', skuId: 'sku-c-only', scopeType: 'public', amountCent: 3600, currency: 'CNY', status: 'active' });
  await store.create('inventory', { _id: inventoryId(warehouse.data._id, 'sku-c-only'), warehouseId: warehouse.data._id, skuId: 'sku-c-only', onHand: 10, reserved: 0, available: 10, version: 1 });

  const address = await call(app, 'address.upsert', { name: '测试用户', phone: '13800138000', regionCode: '440300', detail: '测试路 1 号', isDefault: true });
  assert.equal(address.ok, true);
  assert.equal(Object.hasOwn(address.data.address, 'phone'), false, '用户地址响应不得返回完整手机号');
  const storedAddress = await store.findOne('addresses', { _id: address.data.address._id });
  assert.equal(Object.hasOwn(storedAddress, 'phone'), false, '地址集合不得保存明文手机号');
  assert.ok(storedAddress.phoneCiphertext.startsWith('v1.'), '手机号必须以加密密文保存');
  const quote = await call(app, 'checkout.quote', { addressId: address.data.address._id, warehouseId: warehouse.data._id, deliverySlotId: deliverySlot.data._id, items: [{ skuId: 'sku-1', quantity: 2 }] });
  assert.equal(quote.ok, true);
  assert.equal(quote.data.quote.goodsAmountCent, 5000);
  assert.equal(quote.data.quote.freightAmountCent, 800);
  assert.equal(quote.data.quote.deliverySlot.name, '上午配送');
  const authenticatedPrices = await call(app, 'catalog.prices', { skuIds: ['sku-1'] });
  assert.deepEqual(authenticatedPrices.data.rows, [{ skuId: 'sku-1', amountCent: 2500, currency: 'CNY', temporary: true, source: 'ai_generated' }], '已登录用户应只通过受控接口获得当前账号可见的临时演示价');
  const cFirstPage = await call(app, 'catalog.products', { page: 1, pageSize: 1 });
  assert.equal(cFirstPage.data.rows.length, 1, '分层过滤必须先于分页，首条为 B 端商品时 C 端分页也不能出现空洞');
  assert.notEqual(cFirstPage.data.rows[0]._id, 'product-b-only', 'C 端目录不得返回 B 端专享商品');
  assert.equal((await call(app, 'catalog.products', { keyword: 'B端专享冻品' })).data.rows.length, 0, 'C 端搜索不得命中 B 端专享商品');
  assert.equal((await call(app, 'catalog.product', { productId: 'product-b-only' })).error.code, 'PRODUCT_NOT_FOUND', 'C 端不得读取 B 端商品详情');
  assert.deepEqual((await call(app, 'catalog.prices', { skuIds: ['sku-b-only'] })).data.rows, [], 'C 端不得通过已知 SKU ID 探测 B 端商品价格');
  assert.equal((await call(app, 'cart.upsert', { skuId: 'sku-b-only', quantity: 1 })).error.code, 'PRODUCT_NOT_AVAILABLE', 'C 端不得把 B 端商品写入购物车');
  assert.equal((await call(app, 'checkout.quote', { addressId: address.data.address._id, warehouseId: warehouse.data._id, items: [{ skuId: 'sku-b-only', quantity: 1 }] })).error.code, 'PRODUCT_NOT_AVAILABLE', 'C 端不得为 B 端商品取得结算报价');
  assert.equal((await call(app, 'orders.create', { idempotencyKey: 'c-b-only-forbidden', addressId: address.data.address._id, warehouseId: warehouse.data._id, items: [{ skuId: 'sku-b-only', quantity: 1 }], paymentMethod: 'demo' })).error.code, 'PRODUCT_NOT_AVAILABLE', 'C 端不得绕过界面创建 B 端商品订单');
  const multiSkuOrder = await call(app, 'orders.create', { idempotencyKey: 'multi-sku-snapshot', addressId: address.data.address._id, warehouseId: warehouse.data._id, items: [{ skuId: 'fixture-primary-sku', quantity: 1 }, { skuId: 'demo-sku-501-case', quantity: 1 }], paymentMethod: 'demo' });
  assert.equal(multiSkuOrder.ok, true);
  const storedMultiSkuOrder = await store.findOne('orders', { _id: multiSkuOrder.data.order._id });
  assert.deepEqual(storedMultiSkuOrder.itemsSnapshot.map((item) => item.specSnapshot), ['500g/包', '10包/件'], '同一商品不同 SKU 必须分别写入订单规格快照');
  assert.deepEqual(storedMultiSkuOrder.itemsSnapshot.map((item) => item.unitPriceCent), [2880, 27360], '订单快照必须保留各 SKU 的独立成交价');
  const cancelledMultiSkuOrder = await call(app, 'orders.cancel', { id: multiSkuOrder.data.order._id });
  assert.equal(cancelledMultiSkuOrder.ok, true, '多 SKU 快照测试订单必须可取消并释放库存预占');
  const forbiddenOfflineOrder = await call(app, 'orders.create', { idempotencyKey: 'c-offline-forbidden', addressId: address.data.address._id, warehouseId: warehouse.data._id, items: [{ skuId: 'sku-1', quantity: 1 }], paymentMethod: 'offline' });
  assert.equal(forbiddenOfflineOrder.error.code, 'OFFLINE_PAYMENT_FORBIDDEN', '普通 C 端不能创建线下结算订单');
  const demoOrder = await call(app, 'orders.create', { idempotencyKey: 'c-demo-order', addressId: address.data.address._id, warehouseId: warehouse.data._id, items: [{ skuId: 'sku-1', quantity: 1 }], paymentMethod: 'demo' });
  assert.equal(demoOrder.data.order.paymentStatus, 'demo_not_required', '演示订单不得伪造已支付状态');
  assert.equal(demoOrder.data.order.status, 'pending_confirmation', '演示订单仍应走库存预占与待确认状态');
  const demoOrderBeforeDelivery = await store.findOne('orders', { _id: demoOrder.data.order._id });
  assert.equal(demoOrderBeforeDelivery.createdAt, fixedClock().toISOString(), '订单时间必须保存为带时区的 ISO 时间');
  const listedOrders = await call(app, 'orders.list', { page: 1, pageSize: 10 });
  const listedDemoOrder = listedOrders.data.rows.find((item) => item._id === demoOrder.data.order._id);
  assert.deepEqual(listedDemoOrder.items.map((item) => ({ productNameSnapshot: item.productNameSnapshot, specSnapshot: item.specSnapshot, quantity: item.quantity })), [{ productNameSnapshot: '测试虾仁', specSnapshot: '500克', quantity: 1 }], '订单列表必须返回商品和规格快照，供客户端展示订单摘要');
  for (const status of ['picking', 'shipping']) {
    const transitioned = await call(app, 'admin.orders.transition', { adminToken, id: demoOrder.data.order._id, status });
    assert.equal(transitioned.ok, true, `演示订单应能进入${status}状态`);
  }
  assert.equal((await call(app, 'admin.orders.transition', { adminToken, id: demoOrder.data.order._id, status: 'completed' })).error.code, 'ORDER_STATUS_TRANSITION_INVALID', '后台不能跳过送达与顾客确认，直接完成订单');
  assert.equal((await store.findOne('inventory_reservations', { orderId: demoOrder.data.order._id })).status, 'reserved', '后台拒绝直接完成时不得改动库存预占');
  assert.equal((await call(app, 'admin.orders.transition', { adminToken, id: demoOrder.data.order._id, status: 'delivered' })).ok, true, '后台应标记订单送达');
  const completedDemoOrder = await call(app, 'orders.complete', { id: demoOrder.data.order._id });
  assert.equal(completedDemoOrder.data.order.status, 'completed', '顾客确认收货后演示订单必须完成');
  assert.equal(completedDemoOrder.data.idempotent, false, '首次确认收货必须执行库存收口');
  const repeatedComplete = await call(app, 'orders.complete', { id: demoOrder.data.order._id });
  assert.equal(repeatedComplete.data.idempotent, true, '重复确认收货不得重复扣减库存');
  const demoReservation = await store.findOne('inventory_reservations', { orderId: demoOrder.data.order._id });
  assert.equal(demoReservation.status, 'consumed', '演示订单确认收货必须消耗库存预占');
  const inventoryAfterDemoComplete = await store.findOne('inventory', { warehouseId: warehouse.data._id, skuId: 'sku-1' });
  assert.deepEqual({ onHand: inventoryAfterDemoComplete.onHand, reserved: inventoryAfterDemoComplete.reserved, available: inventoryAfterDemoComplete.available }, { onHand: 19, reserved: 0, available: 19 }, '演示订单确认收货必须在事务中更新可售库存');
  const demoConsumptionLedger = await store.findOne('inventory_ledger', { referenceId: demoOrder.data.order._id, reason: 'order_complete_consume' });
  assert.equal(demoConsumptionLedger.change, -1, '演示订单确认收货必须留下库存扣减流水');
  assert.equal((await call(app, 'admin.orders.transition', { adminToken, id: demoOrder.data.order._id, status: 'shipping' })).error.code, 'ORDER_STATUS_TRANSITION_INVALID', '已完成订单不能回退到配送中');
  const repeatedAdjustment = await call(app, 'admin.inventory.adjust', { adminToken, warehouseId: warehouse.data._id, skuId: 'sku-1', change: 20, reason: 'initial_stock', idempotencyKey: 'inventory-initial-1' });
  assert.equal(repeatedAdjustment.data.idempotent, true, '相同库存幂等键不能重复调整');

  const businessApplication = await call(app, 'auth.applyBusiness', { companyName: '测试餐饮企业', storeName: '测试餐饮门店', storeAddress: '测试路1号', mainBusinessType: 'restaurant', unifiedCode: '123456789012345678', storefrontMediaId: 'cloud://test/storefront.jpg', businessLicenseMediaId: 'cloud://test/license.jpg', contactName: '采购员', contactPhone: '13900139000' });
  assert.equal(businessApplication.ok, true);
  assert.equal(Object.hasOwn(businessApplication.data.application, 'contactPhoneCiphertext'), false, '企业申请响应不得返回手机号密文');
  const pendingBusinessUser = await call(app, 'auth.me');
  assert.equal(pendingBusinessUser.data.user.businessStatus, 'pending', '企业申请后登录用户必须能看到待审核状态');
  const storedApplication = await store.findOne('business_applications', { _id: businessApplication.data.application._id });
  assert.equal(Object.hasOwn(storedApplication, 'contactPhone'), false, '企业申请不得保存明文联系人手机号');
  assert.equal(storedApplication.companyName, '测试餐饮企业', '企业申请必须保存前端提交的企业名称');
  assert.equal(storedApplication.unifiedCode, '123456789012345678', '企业申请必须保存统一社会信用代码供审核建档');
  const approvedBusiness = await call(app, 'admin.businessApplications.review', { adminToken, id: businessApplication.data.application._id, decision: 'approved', priceLevel: 'b_standard' });
  assert.equal(approvedBusiness.ok, true);
  assert.equal(approvedBusiness.data.organization.name, '测试餐饮企业', '审核建档必须使用申请中的企业名称');
  const businessUser = await call(app, 'auth.me');
  assert.equal(businessUser.data.user.userType, 'b', '企业审核通过后用户必须切换为 B 端');
  assert.equal(businessUser.data.user.businessStatus, 'approved', '企业审核通过后登录用户必须看到已通过状态');
  assert.equal((await call(app, 'catalog.product', { productId: 'product-b-only' })).ok, true, 'B 端应能读取 B 端专享商品详情');
  assert.equal((await call(app, 'catalog.product', { productId: 'product-c-only' })).error.code, 'PRODUCT_NOT_FOUND', 'B 端不得读取 C 端专享商品详情');
  assert.deepEqual((await call(app, 'catalog.prices', { skuIds: ['sku-b-only', 'sku-c-only'] })).data.rows.map((row) => row.skuId), ['sku-b-only'], 'B 端只应获得其可见商品的价格');
  assert.equal((await call(app, 'cart.upsert', { skuId: 'sku-b-only', quantity: 1 })).ok, true, 'B 端应能把 B 端专享商品加入购物车');
  assert.equal((await call(app, 'checkout.quote', { addressId: address.data.address._id, warehouseId: warehouse.data._id, items: [{ skuId: 'sku-b-only', quantity: 1 }] })).ok, true, 'B 端应能为 B 端专享商品取得报价');
  assert.equal((await call(app, 'checkout.quote', { addressId: address.data.address._id, warehouseId: warehouse.data._id, items: [{ skuId: 'sku-c-only', quantity: 1 }] })).error.code, 'PRODUCT_NOT_AVAILABLE', 'B 端不得为 C 端专享商品取得报价');
  const repeatedBusinessApplication = await call(app, 'auth.applyBusiness', { companyName: '重复申请企业', storeName: '重复申请门店', storeAddress: '测试路2号', mainBusinessType: 'retail', unifiedCode: '123456789012345679', storefrontMediaId: 'cloud://test/storefront-2.jpg', businessLicenseMediaId: 'cloud://test/license-2.jpg', contactName: '采购员', contactPhone: '13800138000' });
  assert.equal(repeatedBusinessApplication.error.code, 'BUSINESS_APPLICATION_NOT_NEEDED', '已审核 B 端账号不能重复提交企业申请');
  const createdOrder = await call(app, 'orders.create', { idempotencyKey: 'order-1', addressId: address.data.address._id, warehouseId: warehouse.data._id, deliverySlotId: deliverySlot.data._id, items: [{ skuId: 'sku-1', quantity: 2 }], paymentMethod: 'offline' });
  assert.equal(createdOrder.ok, true);
  assert.equal(createdOrder.data.order.status, 'pending_confirmation');
  assert.equal(createdOrder.data.order.deliverySlotSnapshot.name, '上午配送');
  assert.equal(Object.hasOwn(createdOrder.data.order, 'fulfillmentContactCiphertext'), false, '订单响应不得返回履约手机号密文');
  const fulfillmentContact = await call(app, 'admin.orders.fulfillmentContact', { adminToken, id: createdOrder.data.order._id, purpose: 'delivery_test' });
  assert.equal(fulfillmentContact.data.recipient.phone, '13800138000', '履约联系人只能通过受审计的后台接口按需读取');
  const duplicateOrder = await call(app, 'orders.create', { idempotencyKey: 'order-1', addressId: address.data.address._id, warehouseId: warehouse.data._id, items: [{ skuId: 'sku-1', quantity: 2 }], paymentMethod: 'offline' });
  assert.equal(duplicateOrder.data.idempotent, true, '相同幂等键不能创建重复订单');
  const cancelled = await call(app, 'orders.cancel', { id: createdOrder.data.order._id });
  assert.equal(cancelled.data.order.status, 'cancelled');
  const inventoryAfterCancel = await call(app, 'admin.inventory.list', { adminToken });
  assert.equal(inventoryAfterCancel.data.rows.find((row) => row.skuId === 'sku-1').available, 19, '取消订单必须释放自身预占，且不得回滚已完成演示订单的库存扣减');
  const adminCancelTarget = await call(app, 'orders.create', { idempotencyKey: 'admin-cancel-1', addressId: address.data.address._id, warehouseId: warehouse.data._id, items: [{ skuId: 'sku-1', quantity: 1 }], paymentMethod: 'demo' });
  assert.equal(adminCancelTarget.ok, true);
  const adminCancelled = await call(app, 'admin.orders.transition', { adminToken, id: adminCancelTarget.data.order._id, status: 'cancelled' });
  assert.equal(adminCancelled.ok, true, '后台应能取消未支付订单');
  const adminCancelReservation = await store.findOne('inventory_reservations', { orderId: adminCancelTarget.data.order._id });
  assert.equal(adminCancelReservation.status, 'released', '后台取消订单必须在事务内释放库存预占');
  const inventoryAfterAdminCancel = await store.findOne('inventory', { warehouseId: warehouse.data._id, skuId: 'sku-1' });
  assert.equal(inventoryAfterAdminCancel.available, 19, '后台取消释放预占后可售库存必须恢复');
  const organizationPrice = await call(app, 'admin.prices.upsert', { adminToken, skuId: 'sku-1', scopeType: 'organization', scopeId: approvedBusiness.data.organization._id, amountCent: 2100, status: 'active' });
  assert.equal(organizationPrice.ok, true);
  const businessQuote = await call(app, 'checkout.quote', { addressId: address.data.address._id, warehouseId: warehouse.data._id, items: [{ skuId: 'sku-1', quantity: 2 }] });
  assert.equal(businessQuote.data.quote.goodsAmountCent, 4200, '企业定向价格必须优先于公开价');
  const missingGroupCover = await call(app, 'admin.groupCampaigns.upsert', { adminToken, title: '错误封面拼团', skuId: 'sku-1', groupSize: 3, durationMinutes: 120, groupPriceCent: 1800, coverMediaId: 'missing-media', targetUserType: 'all', status: 'draft' });
  assert.equal(missingGroupCover.error.code, 'MEDIA_NOT_FOUND', '拼团活动不得引用不存在的封面素材');
  const groupCampaign = await call(app, 'admin.groupCampaigns.upsert', { adminToken, title: '测试拼团', skuId: 'sku-1', groupSize: 3, durationMinutes: 120, groupPriceCent: 1800, coverMediaId: 'media-public', targetUserType: 'all', status: 'active' });
  assert.equal(groupCampaign.ok, true);
  const cOnlyCampaign = await call(app, 'admin.groupCampaigns.upsert', { adminToken, title: 'C端专享商品拼团', skuId: 'sku-c-only', groupSize: 3, durationMinutes: 120, groupPriceCent: 3000, coverMediaId: 'media-public', targetUserType: 'all', status: 'active' });
  assert.equal(cOnlyCampaign.ok, true);
  const publicCampaigns = await call(app, 'groups.campaigns');
  assert.equal(Object.hasOwn(publicCampaigns.data.rows[0], 'groupPriceCent'), false, '未登录拼团列表不得返回活动价格');
  assert.equal(publicCampaigns.data.rows.some((item) => item._id === cOnlyCampaign.data._id), false, 'B 端拼团列表不得泄露 C 端专享商品活动');
  assert.equal((await call(app, 'groups.create', { campaignId: cOnlyCampaign.data._id })).error.code, 'GROUP_CAMPAIGN_FORBIDDEN', 'B 端不得通过已知活动 ID 创建 C 端专享商品拼团');
  const groupQuote = await call(app, 'groups.quote', { campaignId: groupCampaign.data._id, addressId: address.data.address._id, warehouseId: warehouse.data._id, items: [{ skuId: 'sku-1', quantity: 2 }] });
  assert.equal(groupQuote.data.quote.goodsAmountCent, 3600, '拼团报价必须使用服务端活动价格');
  const pendingPaymentOrder = await call(app, 'orders.create', { idempotencyKey: 'wechat-timeout-1', addressId: address.data.address._id, warehouseId: warehouse.data._id, items: [{ skuId: 'sku-1', quantity: 1 }], paymentMethod: 'wechat' });
  assert.equal(pendingPaymentOrder.data.order.status, 'pending_payment');
  const expired = await expireReservations({ store, now: new Date('2026-09-07T12:31:00.000Z') });
  assert.equal(expired.released, 1, '支付超时必须释放库存预占');
  const timedOutOrder = await store.findOne('orders', { _id: pendingPaymentOrder.data.order._id });
  assert.equal(timedOutOrder.paymentStatus, 'closed');
  assert.equal(timedOutOrder.status, 'cancelled');
  const paidOrder = await call(app, 'orders.create', { idempotencyKey: 'wechat-paid-1', addressId: address.data.address._id, warehouseId: warehouse.data._id, items: [{ skuId: 'sku-1', quantity: 1 }], paymentMethod: 'wechat' });
  assert.equal(paidOrder.data.order.status, 'pending_payment');
  const paymentResult = await call(app, 'payments.wechat.notify', { outTradeNo: paidOrder.data.order.orderNo, transactionId: 'wx-txn-001', amountCent: paidOrder.data.order.totalAmountCent });
  assert.equal(paymentResult.ok, true);
  const paidOrderStored = await store.findOne('orders', { _id: paidOrder.data.order._id });
  assert.equal(paidOrderStored.paymentStatus, 'paid');
  assert.equal(paidOrderStored.status, 'pending_confirmation');
  const duplicatePayment = await call(app, 'payments.wechat.notify', { outTradeNo: paidOrder.data.order.orderNo, transactionId: 'wx-txn-001', amountCent: paidOrder.data.order.totalAmountCent });
  assert.equal(duplicatePayment.data.idempotent, true, '重复支付通知不能重复扣减库存');
  const paidOrderUserCancel = await call(app, 'orders.cancel', { id: paidOrder.data.order._id });
  assert.equal(paidOrderUserCancel.error.code, 'ORDER_PAID_CANCEL_FORBIDDEN', '已支付订单不得被用户直接取消，必须走退款售后流程');
  const paidOrderAdminCancel = await call(app, 'admin.orders.transition', { adminToken, id: paidOrder.data.order._id, status: 'cancelled' });
  assert.equal(paidOrderAdminCancel.error.code, 'ORDER_PAID_CANCEL_FORBIDDEN', '已支付订单不得被后台直接取消，必须走退款售后流程');
  const deliveryCompleteOrder = await call(app, 'orders.create', { idempotencyKey: 'delivery-complete-1', addressId: address.data.address._id, warehouseId: warehouse.data._id, items: [{ skuId: 'sku-1', quantity: 1 }], paymentMethod: 'wechat' });
  const deliveryPayment = await call(app, 'payments.wechat.notify', { outTradeNo: deliveryCompleteOrder.data.order.orderNo, transactionId: 'wx-delivery-txn-001', amountCent: deliveryCompleteOrder.data.order.totalAmountCent });
  assert.equal(deliveryPayment.data.groupStatus, '');
  for (const status of ['picking', 'shipping', 'delivered']) {
    const transitioned = await call(app, 'admin.orders.transition', { adminToken, id: deliveryCompleteOrder.data.order._id, status });
    assert.equal(transitioned.ok, true, `后台应能把订单流转到 ${status}`);
  }
  const userCompleted = await call(app, 'orders.complete', { id: deliveryCompleteOrder.data.order._id });
  assert.equal(userCompleted.data.order.status, 'completed', '已送达订单必须由用户确认收货后完成');
  const refundRequest = await call(app, 'refunds.request', { orderId: paidOrder.data.order._id, idempotencyKey: 'refund-1', amountCent: paidOrder.data.order.totalAmountCent, reason: '测试退款' });
  assert.equal(refundRequest.ok, true);
  const duplicateRefundRequest = await call(app, 'refunds.request', { orderId: paidOrder.data.order._id, idempotencyKey: 'refund-2', amountCent: paidOrder.data.order.totalAmountCent, reason: '重复申请' });
  assert.equal(duplicateRefundRequest.error.code, 'REFUND_ALREADY_PENDING', '同一订单不能存在多笔处理中的退款申请');
  const refundReview = await call(app, 'admin.refunds.review', { adminToken, id: refundRequest.data.refund._id, decision: 'approved', reviewNote: '测试通过' });
  assert.equal(refundReview.data.refund.status, 'processing');
  const refundNotify = await call(app, 'refunds.notify', { refundNo: refundRequest.data.refund.refundNo, refundTransactionId: 'wx-refund-001', amountCent: refundRequest.data.refund.amountCent });
  assert.equal(refundNotify.ok, true);
  const refundedOrder = await store.findOne('orders', { _id: paidOrder.data.order._id });
  assert.equal(refundedOrder.refundStatus, 'refunded');
  assert.equal(refundedOrder.status, 'cancelled');
  const group = await call(app, 'groups.create', { campaignId: groupCampaign.data._id });
  assert.equal(group.ok, true);
  const groupOrder = await call(app, 'groups.join', { groupId: group.data.group._id, idempotencyKey: 'group-order-1', addressId: address.data.address._id, warehouseId: warehouse.data._id, items: [{ skuId: 'sku-1', quantity: 1 }] });
  assert.equal(groupOrder.ok, true);
  const duplicateGroupOrder = await call(app, 'groups.join', { groupId: group.data.group._id, idempotencyKey: 'group-order-2', addressId: address.data.address._id, warehouseId: warehouse.data._id, items: [{ skuId: 'sku-1', quantity: 1 }] });
  assert.equal(duplicateGroupOrder.error.code, 'GROUP_ALREADY_JOINED', '同一用户不能为同一拼团重复占位');
  const groupPayment = await call(app, 'payments.wechat.notify', { outTradeNo: groupOrder.data.order.orderNo, transactionId: 'wx-group-txn-001', amountCent: groupOrder.data.order.totalAmountCent });
  assert.equal(groupPayment.data.groupStatus, 'open');
  const groupDetail = await call(app, 'groups.get', { groupId: group.data.group._id });
  assert.equal(groupDetail.data.group.memberCount, 1);
  assert.equal(Object.hasOwn(groupDetail.data.group, 'ownerUserId'), false, '拼团详情不得暴露团长内部用户 ID');
  assert.equal(Object.hasOwn(groupDetail.data.members[0], 'userId'), false, '拼团成员不得暴露内部用户 ID');

  await store.update('groups', group.data.group._id, { expiresAt: '2026-09-07T12:00:00.000Z', status: 'open' });
  const expiredGroup = await expireGroups({ store, now: new Date('2026-09-07T12:31:00.000Z') });
  assert.equal(expiredGroup.closed, 1, '拼团到期必须关闭');
  assert.equal(expiredGroup.refundRequired, 1, '已有付费成员的失败拼团必须标记待退款');

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const wrongLogin = await call(app, 'admin.login', { username: 'locked-owner', password: '0123456789ab' });
    assert.equal(wrongLogin.error.code, 'ADMIN_LOGIN_FAILED');
  }
  const throttledLogin = await call(app, 'admin.login', { username: 'locked-owner', password: '0123456789ab' });
  assert.equal(throttledLogin.error.code, 'ADMIN_LOGIN_THROTTLED', '连续失败登录必须进入短期限流');

  const stage = await call(app, 'admin.imports.stage', {
    adminToken,
    sourceFile: 'sales-sheet-20260907',
    rows: [{ sourceRowNo: 2, source: { id: 1001, name: '测试鱼丸', category: '丸滑类', unit: '1件/10包/500克' }, parsed: { productCode: 'FISHBALL-001', skuCode: 'FISHBALL-500G', name: '测试鱼丸', categoryName: '丸滑类', specName: '500克', packageUnit: '1件/10包/500克' }, mappingWarnings: ['价格未确认'] }]
  });
  assert.equal(stage.ok, true);
  assert.equal(stage.data.staged[0].status, 'staged');
  const sameCodeOtherFile = await call(app, 'admin.imports.stage', { adminToken, sourceFile: 'another-file.csv', rows: [{ sourceRowNo: 9, parsed: { productCode: 'FISHBALL-001', skuCode: 'FISHBALL-500G', name: '测试鱼丸', categoryName: '丸滑类', specName: '500克' } }] });
  assert.equal(sameCodeOtherFile.data.staged[0].status, 'already_staged', '跨文件重试由规格编码识别，不能依赖文件名');
  const crossProductPreview = await call(app, 'admin.imports.preview', { adminToken, rows: [{ sourceRowNo: 5, parsed: { productCode: 'OTHER-001', skuCode: 'FISHBALL-500G', name: '另一商品', categoryName: '丸滑类', specName: '500克' } }] });
  assert.equal(crossProductPreview.data.rows[0].status, 'invalid', '同一规格编码不得关联另一商品编码');
  const secondSkuStage = await call(app, 'admin.imports.stage', { adminToken, sourceFile: 'another-file.csv', rows: [{ sourceRowNo: 10, parsed: { productCode: 'FISHBALL-001', skuCode: 'FISHBALL-1KG', name: '测试鱼丸', categoryName: '丸滑类', specName: '1千克', packageUnit: '1袋' } }] });
  assert.equal(secondSkuStage.data.staged[0].status, 'staged');
  const approved = await call(app, 'admin.imports.approve', { adminToken, id: stage.data.staged[0].id });
  assert.equal(approved.ok, true);
  const secondApproved = await call(app, 'admin.imports.approve', { adminToken, id: secondSkuStage.data.staged[0].id });
  assert.equal(secondApproved.data.productId, approved.data.productId, '同一商品编码的不同规格必须共用商品');
  assert.notEqual(secondApproved.data.skuId, approved.data.skuId);
  const duplicateSkuOwner = await call(app, 'admin.skus.upsert', { adminToken, productId: approved.data.productId, skuCode: 'FISHBALL-500G', specName: '重复规格' });
  assert.equal(duplicateSkuOwner.error.code, 'CATALOG_CODE_DUPLICATE');
  const premature = await call(app, 'admin.imports.activateBatch', { adminToken, ids: [stage.data.staged[0].id] });
  assert.equal(premature.error.code, 'IMPORT_REVIEW_REQUIRED', '批量上架入口必须停用');
  const importedDraft = await store.findOne('products', { _id: approved.data.productId });
  const importedSkuDraft = await store.findOne('product_skus', { _id: approved.data.skuId });
  const importedCategoryDraft = await store.findOne('categories', { _id: importedDraft.categoryId });
  assert.equal(importedDraft.status, 'draft');
  assert.equal(importedSkuDraft.status, 'draft');
  assert.equal(importedCategoryDraft.status, 'draft');
  const unfinishedReview = await call(app, 'admin.products.review', { adminToken, id: importedDraft._id });
  assert.equal(unfinishedReview.data.ready, false, '缺价格/图片必须保留待补齐草稿');
  const wrongSkuMedia = await call(app, 'admin.productMedia.linkByCode', { adminToken, productCode: 'FISHBALL-001', skuCode: 'MANAGED-SKU-001', mediaAssetId: managedMedia.data._id, role: 'detail' });
  assert.equal(wrongSkuMedia.error.code, 'SKU_PRODUCT_MISMATCH', '规格编码跨商品关联素材必须拒绝');
  const pngBytes = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../../../../../assets/logo.png'));
  const importUpload = await call(app, 'admin.media.upload', { adminToken, type: 'image', fileName: '本地流程测试.png', mimeType: 'image/png', sizeBytes: pngBytes.length, contentBase64: pngBytes.toString('base64') });
  assert.equal(importUpload.ok, true);
  const importAsset = await call(app, 'admin.media.upsert', { adminToken, name: '流程测试主图', type: 'image', source: 'demo', temporary: true, fileId: importUpload.data.fileId, mimeType: 'image/png', sizeBytes: pngBytes.length });
  assert.equal(importAsset.ok, true);
  const linkedCover = await call(app, 'admin.productMedia.linkByCode', { adminToken, productCode: 'FISHBALL-001', mediaAssetId: importAsset.data._id, role: 'cover' });
  assert.equal(linkedCover.ok, true, '素材库图片应按商品编码成为主图');
  assert.equal((await call(app, 'admin.categories.upsert', { adminToken, id: importedCategoryDraft._id, name: importedCategoryDraft.name, status: 'enabled' })).ok, true);
  assert.equal((await call(app, 'admin.prices.upsert', { adminToken, skuId: importedSkuDraft._id, scopeType: 'public', scopeId: '', channel: 'all', amountCent: 1990, status: 'active' })).ok, true);
  const secondSkuDraft = await store.findOne('product_skus', { _id: secondApproved.data.skuId });
  const secondSkuMissingPrice = await call(app, 'admin.products.review', { adminToken, id: importedDraft._id });
  assert.equal(secondSkuMissingPrice.data.ready, false, '任一销售规格缺价格都不能发布');
  assert.equal((await call(app, 'admin.prices.upsert', { adminToken, skuId: secondSkuDraft._id, scopeType: 'public', scopeId: '', channel: 'all', amountCent: 2990, status: 'active' })).ok, true);
  for (const sku of [importedSkuDraft, secondSkuDraft]) assert.equal((await call(app, 'admin.inventory.adjust', { adminToken, skuId: sku._id, warehouseId: 'review-test-warehouse', change: 2, reason: '仅本地测试补货', idempotencyKey: `import-stock-${sku._id}` })).ok, true);
  const importReview = await call(app, 'admin.products.review', { adminToken, id: importedDraft._id });
  assert.equal(importReview.data.ready, true);
  const activated = await call(app, 'admin.products.publishReviewed', { adminToken, id: importedDraft._id, reviewToken: importReview.data.reviewToken });
  assert.equal(activated.ok, true);
  assert.equal((await store.findOne('categories', { _id: importedCategoryDraft._id })).status, 'enabled');
  assert.equal((await store.findOne('products', { _id: importedDraft._id })).status, 'on_sale');
  assert.equal((await store.findOne('product_skus', { _id: importedSkuDraft._id })).status, 'on_sale');
  const importedCatalog = await call(app, 'catalog.products', { keyword: '测试鱼丸' });
  assert.equal(importedCatalog.data.rows.length, 1);
  const personalApp = createApplication({ store, getIdentity: () => ({ OPENID: 'local-flow-personal' }), piiEncryptionKey: 'unit-test-pii-encryption-key', clock: fixedClock });
  const personalPrices = await call(personalApp, 'catalog.prices', { skuIds: [importedSkuDraft._id, secondSkuDraft._id], channel: 'miniapp' });
  assert.deepEqual(personalPrices.data.rows.map((row) => row.amountCent), [1990, 2990]);
  const personalAddress = await call(personalApp, 'address.upsert', { name: '本地测试收货人', phone: '13800000000', regionCode: 'TEST-REVIEW', detail: '仅本地内存测试' });
  assert.equal(personalAddress.ok, true, JSON.stringify(personalAddress.error));
  const quotePayload = { addressId: personalAddress.data.address._id, warehouseId: 'review-test-warehouse', deliverySlotId: 'review-slot', channel: 'miniapp', items: [{ skuId: importedSkuDraft._id, quantity: 1 }, { skuId: secondSkuDraft._id, quantity: 1 }] };
  const importedQuote = await call(personalApp, 'checkout.quote', quotePayload);
  assert.equal(importedQuote.ok, true, JSON.stringify(importedQuote.error));
  assert.equal(importedQuote.data.quote.goodsAmountCent, 4980);
  assert.equal(importedQuote.data.quote.freightAmountCent, 500);
  assert.equal(importedQuote.data.quote.payableAmountCent, 5480);
  const overstockQuote = await call(personalApp, 'checkout.quote', { ...quotePayload, items: [{ skuId: importedSkuDraft._id, quantity: 3 }] });
  assert.equal(overstockQuote.error.code, 'INVENTORY_NOT_AVAILABLE');
  assert.equal(Object.hasOwn(importedCatalog.data.rows[0], 'price'), false, '公开商品接口不得返回未配置价格');
  const imports = await call(app, 'admin.imports.list', { adminToken });
  assert.equal(imports.data.rows[0].status, 'imported');
  for (let index = 0; index <= 120; index += 1) {
    await store.create('products', { _id: `search-product-${index}`, name: index === 120 ? '晚页关键词商品' : `普通商品${index}`, categoryName: '搜索测试类', status: 'on_sale', sort: 0 });
  }
  const lateKeywordMatch = await call(app, 'catalog.products', { keyword: '晚页关键词', page: 1, pageSize: 100 });
  assert.deepEqual(lateKeywordMatch.data.rows.map((item) => item.name), ['晚页关键词商品'], '商品关键词应跨页命中');

  for (let index = 0; index <= 120; index += 1) {
    await store.create('home_sections', { _id: `late-content-${index}`, title: index === 120 ? '晚页小程序活动' : `网页内容${index}`, targetPlatforms: index === 120 ? ['miniapp'] : ['web'], enabled: true, sort: index, jumpType: 'none' });
  }
  const lateContentMatch = await call(app, 'content.homeSections', { platform: 'miniapp', page: 1, pageSize: 100 });
  assert.equal(lateContentMatch.data.rows.some((item) => item._id === 'late-content-120'), true, '内容应跨页命中平台目标');

  for (let index = 0; index <= 120; index += 1) {
    await store.create('media_assets', { _id: `media-bulk-${index}`, name: `批量素材${index}`, type: 'image', fileId: `cloud://media/${index}.jpg`, enabled: true });
  }
  const deepMedia = await call(app, 'content.media.resolve', { ids: ['media-bulk-120', 'media-public'] });
  assert.deepEqual(deepMedia.data.rows.map((item) => item._id).sort(), ['media-bulk-120', 'media-public'], '媒体解析应跨页命中');

  for (let index = 0; index < 200; index += 1) {
    await store.create('group_campaigns', { _id: `expired-campaign-${index}`, title: `已结束活动${index}`, skuId: 'sku-1', groupSize: 3, durationMinutes: 120, groupPriceCent: 1000, targetUserType: 'all', status: 'active', endAt: '2026-09-01T00:00:00.000Z', sort: index + 1 });
  }
  await store.create('group_campaigns', { _id: 'late-campaign-200', title: '晚页有效拼团', skuId: 'sku-1', groupSize: 3, durationMinutes: 120, groupPriceCent: 1800, targetUserType: 'all', status: 'active', endAt: '2026-12-31T23:59:59.000Z', sort: 300 });
  const lateCampaignMatch = await call(app, 'groups.campaigns', { page: 1, pageSize: 100 });
  assert.equal(lateCampaignMatch.data.rows.some((item) => item._id === 'late-campaign-200'), true, '拼团活动应跨页命中');
  for (let index = 0; index <= 120; index += 1) {
    await store.create('product_skus', { _id: `detail-sku-${index}`, productId: 'product-1', specName: `规格${index}`, packageUnit: '1件/10包', status: 'on_sale', sort: index });
  }
  const deepProductDetail = await call(app, 'catalog.product', { productId: 'product-1' });
  assert.equal(deepProductDetail.data.skus.some((item) => item._id === 'detail-sku-120'), true, '商品详情 SKU 应跨页返回');
  // 预占过期扫描分页回归：大量永不过期的演示预占（expiresAt 为空）不得阻塞真实过期预占的释放
  const bulkWarehouseId = 'warehouse-bulk';
  const bulkSkuId = 'sku-bulk';
  await store.create('inventory', { _id: inventoryId(bulkWarehouseId, bulkSkuId), warehouseId: bulkWarehouseId, skuId: bulkSkuId, onHand: 1, reserved: 1, available: 0, version: 1 });
  await store.create('orders', { _id: 'bulk-order', userId: 'user-1', status: 'pending_payment', paymentStatus: 'pending', paymentMethod: 'wechat', reservationIds: ['bulk-res'] });
  for (let index = 0; index < 120; index += 1) {
    await store.create('inventory_reservations', { _id: `perm-res-${index}`, orderId: 'bulk-order', warehouseId: bulkWarehouseId, skuId: bulkSkuId, quantity: 0, status: 'reserved', expiresAt: '' });
  }
  await store.create('inventory_reservations', { _id: 'bulk-res', orderId: 'bulk-order', warehouseId: bulkWarehouseId, skuId: bulkSkuId, quantity: 1, status: 'reserved', expiresAt: '2026-09-07T12:00:00.000Z' });
  const bulkExpiry = await expireReservations({ store, now: new Date('2026-09-07T13:00:00.000Z'), limit: 10 });
  assert.equal(bulkExpiry.released, 1, '分页扫描必须能越过 120 条永久预占释放真实过期预占');
  assert.equal(bulkExpiry.scanned, 121, '分页扫描应覆盖全部 reserved 预占');
  assert.equal((await store.getById('inventory_reservations', 'bulk-res')).status, 'expired');
  assert.equal((await store.findOne('orders', { _id: 'bulk-order' })).status, 'cancelled');
  const forbidden = await call(app, 'admin.categories.list', {});
  assert.equal(forbidden.error.code, 'VALIDATION_ERROR');
  const receiptOrder = await call(app, 'orders.create', { idempotencyKey: 'receipt-flow-local', addressId: address.data.address._id, warehouseId: warehouse.data._id, deliverySlotId: deliverySlot.data._id, items: [{ skuId: 'sku-1', quantity: 2 }], paymentMethod: 'offline' });
  assert.equal(receiptOrder.ok, true, JSON.stringify(receiptOrder.error));
  const receiptOrderId = receiptOrder.data.order._id;
  const due = receiptOrder.data.order.totalAmountCent;
  assert.equal(receiptOrder.data.order.paymentStatus, 'offline_pending');
  assert.equal(receiptOrder.data.order.collectionStatus, 'unpaid');
  assert.equal(receiptOrder.data.order.receivedAmountCent, 0);
  assert.equal(due, 5000, '沿用现有测试价格与运费，本单总额应为50元');
  const receiptInput = { adminToken: financeToken, orderId: receiptOrderId, amountCent: 3000, receivedAt: '2026-09-07T11:00:00Z', method: 'bank_transfer', note: '本地同单演示，非真实收款', idempotencyKey: 'receipt-flow-first' };
  const partialReceipt = await call(app, 'admin.orders.receipts.record', receiptInput);
  assert.equal(partialReceipt.ok, true, JSON.stringify(partialReceipt.error));
  assert.equal(partialReceipt.data.collectionStatus, 'partial');
  assert.equal(partialReceipt.data.receivedAmountCent, 3000);
  assert.equal((await call(app, 'admin.orders.receipts.list', { adminToken: financeToken, orderId: receiptOrderId })).data.orderStatus, 'pending_confirmation', '登记部分收款不能自动发货');
  const duplicateReceipt = await call(app, 'admin.orders.receipts.record', receiptInput);
  assert.equal(duplicateReceipt.data.idempotent, true);
  assert.equal(duplicateReceipt.data.receivedAmountCent, 3000);
  assert.equal((await call(app, 'orders.cancel', { id: receiptOrderId })).ok, false, '已部分收款不能直接取消');
  assert.equal((await call(app, 'admin.orders.transition', { adminToken, id: receiptOrderId, status: 'cancelled' })).ok, false, '管理员也不能直接取消已部分收款订单');
  for (const status of ['picking', 'shipping', 'delivered']) {
    const moved = await call(app, 'admin.orders.transition', { adminToken, id: receiptOrderId, status });
    assert.equal(moved.ok, true, JSON.stringify(moved.error));
    const unchangedReceipt = await call(app, 'admin.orders.receipts.list', { adminToken: financeToken, orderId: receiptOrderId });
    assert.equal(unchangedReceipt.data.collectionStatus, 'partial', `${status}不能自动标记收齐`);
    assert.equal(unchangedReceipt.data.receivedAmountCent, 3000);
    assert.equal(unchangedReceipt.data.outstandingAmountCent, due - 3000);
  }
  assert.equal(due - 3000, 2000, '收30元后只应欠20元');
  const fullReceipt = await call(app, 'admin.orders.receipts.record', { ...receiptInput, amountCent: 2000, idempotencyKey: 'receipt-flow-second' });
  assert.equal(fullReceipt.ok, true, JSON.stringify(fullReceipt.error));
  assert.equal(fullReceipt.data.collectionStatus, 'paid');
  assert.equal(fullReceipt.data.outstandingAmountCent, 0);
  const receiptHistory = await call(app, 'admin.orders.receipts.list', { adminToken: financeToken, orderId: receiptOrderId });
  assert.equal(receiptHistory.data.receivedAmountCent, due);
  assert.equal(receiptHistory.data.orderStatus, 'delivered', '收齐不得改变此前已送达的履约状态');
  assert.equal(receiptHistory.data.rows.length, 2, '重复登记不能产生第三条收款流水');
  console.log(`Local actual-dispatch receipt order: ${(due / 100).toFixed(2)} due -> 30.00 received -> ${(due / 100).toFixed(2)} fully received; fulfillment unchanged`);
  console.log('api application tests: passed');
}

run().catch((error) => { console.error(error); process.exit(1); });
