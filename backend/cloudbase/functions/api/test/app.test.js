const assert = require('assert/strict');
const { createApplication } = require('../app');
const { expireReservations, expireGroups } = require('../lib/commerce');
const { inventoryId } = require('../lib/transaction-ids');

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
  const initialReadiness = await call(app, 'admin.readiness', { adminToken });
  assert.equal(initialReadiness.data.counts.productsOnSale, 1, '运营就绪报告应返回已上架商品数量');
  assert.equal(initialReadiness.data.quoteAndOrderDataReady, false, '未配置价格和履约数据时不得宣称可报价下单');
  const customRole = await call(app, 'admin.roles.upsert', { adminToken, code: 'catalog_auditor', name: '商品只读', permissions: ['catalog.read'], status: 'active' });
  assert.equal(customRole.ok, true);
  const secondAdmin = await call(app, 'admin.adminUsers.upsert', { adminToken, username: 'catalog-reader', displayName: '商品查看员', password: '1234567890ab', roleIds: [customRole.data._id], status: 'active' });
  assert.equal(secondAdmin.ok, true);
  const adminWriterRole = await call(app, 'admin.roles.upsert', { adminToken, code: 'admin_writer', name: '管理员维护员', permissions: ['admin.read', 'admin.write'], status: 'active' });
  assert.equal(adminWriterRole.ok, true);
  const adminWriter = await call(app, 'admin.adminUsers.upsert', { adminToken, username: 'admin-writer', displayName: '管理员维护员', password: '1234567890ab', roleIds: [adminWriterRole.data._id], status: 'active' });
  assert.equal(adminWriter.ok, true);
  const adminWriterLogin = await call(app, 'admin.login', { username: 'admin-writer', password: '1234567890ab' });
  assert.equal(adminWriterLogin.ok, true);
  const superAdminEscalation = await call(app, 'admin.adminUsers.upsert', { adminToken: adminWriterLogin.data.token, username: 'forbidden-super', displayName: '非法提权', password: '1234567890ab', roleIds: [bootstrap.data.admin.roleIds[0]], status: 'active' });
  assert.equal(superAdminEscalation.error.code, 'ADMIN_ROLE_PROTECTED', '管理员维护权限不得授予超级管理员角色');
  const superAdminDemotion = await call(app, 'admin.adminUsers.upsert', { adminToken: adminWriterLogin.data.token, id: bootstrap.data.admin.id, username: 'owner', displayName: '项目管理员', roleIds: [adminWriterRole.data._id], status: 'active' });
  assert.equal(superAdminDemotion.error.code, 'ADMIN_ROLE_PROTECTED', '管理员维护权限不得移除超级管理员角色');
  const wildcardRole = await call(app, 'admin.roles.upsert', { adminToken: adminWriterLogin.data.token, code: 'wildcard_role', name: '全权角色', permissions: ['*'], status: 'active' });
  assert.equal(wildcardRole.error.code, 'VALIDATION_ERROR', '自定义角色不得包含通配或未定义权限点');
  const superRoleRewrite = await call(app, 'admin.roles.upsert', { adminToken: adminWriterLogin.data.token, id: bootstrap.data.admin.roleIds[0], code: 'hacked_super', name: '越权改写', permissions: ['audit.read'], status: 'active' });
  assert.equal(superRoleRewrite.error.code, 'ADMIN_ROLE_PROTECTED', '超级管理员角色不得按 id 传入新编码绕过保护被改写');
  const sneakyRole = await call(app, 'admin.roles.upsert', { adminToken: adminWriterLogin.data.token, code: 'sneaky_role', name: '越权角色', permissions: ['refunds.write'], status: 'active' });
  assert.equal(sneakyRole.ok, true);
  const sneakyAssign = await call(app, 'admin.adminUsers.upsert', { adminToken: adminWriterLogin.data.token, username: 'sneaky-user', displayName: '越权分配', password: '1234567890ab', roleIds: [sneakyRole.data._id], status: 'active' });
  assert.equal(sneakyAssign.error.code, 'ADMIN_ROLE_PROTECTED', '不得授予超出自身权限范围的角色');
  const subsetRole = await call(app, 'admin.roles.upsert', { adminToken: adminWriterLogin.data.token, code: 'session_reader', name: '会话只读', permissions: ['admin.read'], status: 'active' });
  assert.equal(subsetRole.ok, true);
  const subsetAssign = await call(app, 'admin.adminUsers.upsert', { adminToken: adminWriterLogin.data.token, username: 'session-reader', displayName: '会话查看员', password: '1234567890ab', roleIds: [subsetRole.data._id], status: 'active' });
  assert.equal(subsetAssign.ok, true, '自身权限范围内的角色必须仍可正常分配');
  const secondLogin = await call(app, 'admin.login', { username: 'catalog-reader', password: '1234567890ab' });
  assert.equal(secondLogin.ok, true);
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
  const jumpUrlSection = await call(app, 'admin.homeSections.upsert', { adminToken, moduleType: 'group', title: '外链跳转', jumpType: 'url', jumpTarget: 'https://example.com/activity', sort: 3 });
  assert.equal(jumpUrlSection.ok, true);
  const publicJumpSections = await call(app, 'content.homeSections', { platform: 'miniapp' });
  assert.equal(publicJumpSections.data.rows.find((item) => item._id === jumpUrlSection.data._id).jumpType, 'url', '公共接口必须保留首页模块跳转类型');

  const missingCategoryMedia = await call(app, 'admin.categories.upsert', { adminToken, name: '不存在图片的分类', imageMediaId: 'missing-media', status: 'enabled', sort: 3 });
  assert.equal(missingCategoryMedia.error.code, 'MEDIA_NOT_FOUND', '分类不得引用不存在的素材');
  const aiMediaRejected = await call(app, 'admin.media.upsert', { adminToken, name: 'AI 草案', type: 'image', source: 'ai_generated', temporary: true, enabled: true, fileId: 'cloud://test/ai-draft.jpg', mimeType: 'image/jpeg', sizeBytes: 1024 });
  assert.equal(aiMediaRejected.error.code, 'TEMPORARY_CANNOT_ACTIVATE', 'AI 或临时素材不得直接启用');
  const managedMedia = await call(app, 'admin.media.upsert', { adminToken, name: '分类正式图片', assetKey: 'category-test', type: 'image', source: 'client', temporary: false, enabled: true, checksum: 'checksum-v1', fileId: 'cloud://test/category-v1.jpg', mimeType: 'image/jpeg', sizeBytes: 1024 });
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
  const webOnlyMedia = await call(app, 'admin.media.upsert', { adminToken, name: '网页专用素材', type: 'image', source: 'client', temporary: false, enabled: true, targetPlatforms: ['web'], fileId: 'cloud://test/web-only.jpg', mimeType: 'image/jpeg', sizeBytes: 1024 });
  assert.equal(webOnlyMedia.ok, true);
  const miniappMediaResolve = await call(app, 'content.media.resolve', { ids: [webOnlyMedia.data._id], platform: 'miniapp' });
  assert.equal(miniappMediaResolve.data.rows.length, 0, '小程序不得解析网页专用素材');
  const webMediaResolve = await call(app, 'content.media.resolve', { ids: [webOnlyMedia.data._id], platform: 'web' });
  assert.equal(webMediaResolve.data.rows[0]._id, webOnlyMedia.data._id, '网页应解析网页专用素材');
  const futureMedia = await call(app, 'admin.media.upsert', { adminToken, name: '未到期素材', type: 'image', source: 'client', temporary: false, enabled: true, startAt: '2026-09-08T13:00:00.000Z', fileId: 'cloud://test/future.jpg', mimeType: 'image/jpeg', sizeBytes: 1024 });
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
  const managedProduct = await call(app, 'admin.products.upsert', { adminToken, name: '测试商品', categoryId: managedCategory.data._id, frozenTemperature: '-18℃' });
  const managedVideo = await call(app, 'admin.media.upsert', { adminToken, name: '商品详情正式视频', assetKey: 'product-video-test', type: 'video', source: 'client', temporary: false, enabled: true, fileId: 'cloud://test/product-video.mp4', mimeType: 'video/mp4', sizeBytes: 2048 });
  assert.equal(managedVideo.ok, true);
  const productMediaAssociation = await call(app, 'admin.productMedia.upsert', { adminToken, productId: managedProduct.data._id, mediaAssetId: managedVideo.data._id, mediaType: 'video', role: 'detail', sort: 0, enabled: true });
  assert.equal(productMediaAssociation.ok, true, '管理员应能把已登记视频关联到商品详情');
  assert.equal(productMediaAssociation.data.productId, managedProduct.data._id);
  assert.equal(productMediaAssociation.data.mediaType, 'video');
  const listedProductMedia = await call(app, 'admin.productMedia.list', { adminToken, productId: managedProduct.data._id });
  assert.equal(listedProductMedia.data.rows.length, 1, '后台商品媒体列表必须返回已关联视频');
  const wrongProductMediaType = await call(app, 'admin.productMedia.upsert', { adminToken, productId: managedProduct.data._id, mediaAssetId: managedVideo.data._id, mediaType: 'image', role: 'cover' });
  assert.equal(wrongProductMediaType.error.code, 'MEDIA_TYPE_INVALID', '商品媒体关联不得把视频素材登记为图片');
  const managedSku = await call(app, 'admin.skus.upsert', { adminToken, productId: managedProduct.data._id, specName: '测试规格', packageUnit: '1件/10包', status: 'draft' });
  const prematurePublish = await call(app, 'admin.products.setStatus', { adminToken, id: managedProduct.data._id, status: 'on_sale' });
  assert.equal(prematurePublish.error.code, 'PRODUCT_NOT_READY');
  const publishSku = await call(app, 'admin.skus.setStatus', { adminToken, id: managedSku.data._id, status: 'on_sale' });
  assert.equal(publishSku.ok, true);
  const publishProduct = await call(app, 'admin.products.setStatus', { adminToken, id: managedProduct.data._id, status: 'on_sale' });
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
  const pickupSite = await call(app, 'admin.pickupSites.upsert', { adminToken, name: '测试自提点', address: '测试路 8 号冷库门店', regionCode: '440300', warehouseId: warehouse.data._id, openingHours: '09:00-18:00', status: 'active', sort: 2, phone: '不得保存或公开' });
  assert.equal(pickupSite.ok, true);
  assert.deepEqual(Object.keys(pickupSite.data).sort(), ['_id', 'address', 'createdAt', 'name', 'openingHours', 'regionCode', 'sort', 'status', 'updatedAt', 'warehouseId'].sort(), '自提点数据模型只能保存统一契约字段');
  const disabledPickupSite = await call(app, 'admin.pickupSites.upsert', { adminToken, name: '停用自提点', address: '测试路 9 号', regionCode: '440300', warehouseId: warehouse.data._id, openingHours: '', status: 'disabled', sort: 3 });
  assert.equal(disabledPickupSite.ok, true);
  const pickupSiteList = await call(app, 'admin.pickupSites.list', { adminToken });
  assert.equal(pickupSiteList.data.rows.length, 2, '具备 delivery.read 权限的管理员应能列出全部自提点');
  assert.equal((await call(app, 'admin.pickupSites.list', { adminToken: newPasswordLogin.data.token })).error.code, 'ADMIN_FORBIDDEN', '缺少 delivery.read 的管理员不得读取自提点');
  assert.equal((await call(app, 'admin.pickupSites.upsert', { adminToken: newPasswordLogin.data.token, name: '越权自提点', address: '无', regionCode: '440300', warehouseId: warehouse.data._id })).error.code, 'ADMIN_FORBIDDEN', '缺少 delivery.write 的管理员不得修改自提点');
  const inactiveWarehouse = await call(app, 'admin.warehouses.upsert', { adminToken, code: 'WH-OFF', name: '停用仓', status: 'disabled' });
  assert.equal((await call(app, 'admin.pickupSites.upsert', { adminToken, name: '不可启用自提点', address: '测试路 10 号', regionCode: '440300', warehouseId: inactiveWarehouse.data._id, status: 'active' })).error.code, 'WAREHOUSE_NOT_AVAILABLE', '启用自提点必须关联启用仓库');
  const retainedDisabledSite = await call(app, 'admin.pickupSites.upsert', { adminToken, name: '历史停用自提点', address: '测试路 11 号', regionCode: '440300', warehouseId: 'removed-warehouse', status: 'disabled' });
  assert.equal(retainedDisabledSite.ok, true, '停用记录可以保留已经失效的历史仓库引用');
  await store.create('pickup_sites', { _id: 'orphan-active-pickup', name: '脏数据自提点', address: '不应公开', regionCode: '440300', warehouseId: inactiveWarehouse.data._id, status: 'active', sort: 1 });
  const deliveryOptions = await call(app, 'delivery.options');
  assert.equal(deliveryOptions.ok, true);
  assert.equal(deliveryOptions.data.warehouses[0]._id, warehouse.data._id, '公开配送选项必须返回启用仓库事实');
  assert.deepEqual(deliveryOptions.data.pickupSites.map((item) => item._id), [pickupSite.data._id], '公开配送选项只返回启用自提点');
  assert.equal(Object.hasOwn(deliveryOptions.data.pickupSites[0], 'phone'), false, '公开自提点不得返回敏感电话字段');
  const freight = await call(app, 'admin.freightRules.upsert', { adminToken, name: '测试运费', deliveryAreaId: area.data._id, warehouseId: warehouse.data._id, baseFeeCent: 800, freeThresholdCent: 10000, status: 'active' });
  assert.equal(freight.ok, true, JSON.stringify(freight));
  const deliverySlot = await call(app, 'admin.deliverySlots.upsert', { adminToken, name: '上午配送', deliveryAreaId: area.data._id, warehouseId: warehouse.data._id, startTime: '09:00', endTime: '12:00', status: 'active' });
  assert.equal(deliverySlot.ok, true);
  const price = await call(app, 'admin.prices.upsert', { adminToken, skuId: 'sku-1', scopeType: 'public', amountCent: 2500, status: 'active', source: 'client', temporary: false });
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
  const secondAddress = await call(app, 'address.upsert', { name: '测试用户二号地址', phone: '13800138001', regionCode: '440300', detail: '测试路 2 号', isDefault: false });
  const changedDefault = await call(app, 'address.setDefault', { id: secondAddress.data.address._id });
  assert.equal(changedDefault.ok, true);
  assert.equal(changedDefault.data.address.isDefault, true);
  assert.equal(Object.hasOwn(changedDefault.data.address, 'phone'), false, '设置默认地址不得要求或返回明文手机号');
  const defaultAddresses = await store.list('addresses', { where: { userId: storedAddress.userId, status: 'active', isDefault: true }, page: 1, pageSize: 100 });
  assert.deepEqual(defaultAddresses.rows.map((item) => item._id), [secondAddress.data.address._id], '事务设置后同一用户只能保留一个默认地址');
  await store.create('addresses', { _id: 'foreign-address', userId: 'another-user', name: '他人地址', status: 'active', isDefault: false });
  assert.equal((await call(app, 'address.setDefault', { id: 'foreign-address' })).error.code, 'ADDRESS_NOT_FOUND', '用户不得把他人的地址设为默认');
  const deletedDefault = await call(app, 'address.delete', { id: secondAddress.data.address._id });
  assert.equal(deletedDefault.ok, true);
  assert.equal(deletedDefault.data.defaultAddress._id, address.data.address._id, '删除默认地址后必须按创建时间和 ID 的稳定顺序选择剩余默认地址');
  const defaultsAfterDelete = await store.list('addresses', { where: { userId: storedAddress.userId, status: 'active', isDefault: true }, page: 1, pageSize: 100 });
  assert.deepEqual(defaultsAfterDelete.rows.map((item) => item._id), [address.data.address._id], '删除地址事务结束后仍只能有一个默认地址');
  const quote = await call(app, 'checkout.quote', { addressId: address.data.address._id, warehouseId: warehouse.data._id, deliverySlotId: deliverySlot.data._id, items: [{ skuId: 'sku-1', quantity: 2 }] });
  assert.equal(quote.ok, true);
  assert.equal(quote.data.quote.fulfillmentType, 'delivery', '旧请求未传履约方式时必须继续默认为配送');
  assert.equal(quote.data.quote.goodsAmountCent, 5000);
  assert.equal(quote.data.quote.freightAmountCent, 800);
  assert.equal(quote.data.quote.deliverySlot.name, '上午配送');
  const pickupQuote = await call(app, 'checkout.quote', { fulfillmentType: 'pickup', pickupSiteId: pickupSite.data._id, warehouseId: warehouse.data._id, items: [{ skuId: 'sku-1', quantity: 2 }] });
  assert.equal(pickupQuote.ok, true, JSON.stringify(pickupQuote));
  assert.equal(pickupQuote.data.quote.fulfillmentType, 'pickup');
  assert.equal(pickupQuote.data.quote.freightAmountCent, 0, '自提报价运费必须由服务端固定为 0');
  assert.equal(pickupQuote.data.quote.payableAmountCent, pickupQuote.data.quote.goodsAmountCent, '自提应付金额不得附加配送费');
  assert.equal(pickupQuote.data.quote.pickupSiteSnapshot.name, '测试自提点');
  assert.equal(pickupQuote.data.quote.deliverySlot, null, '自提报价不得伪造配送时段');
  assert.equal((await call(app, 'checkout.quote', { fulfillmentType: 'pickup', warehouseId: warehouse.data._id, items: [{ skuId: 'sku-1', quantity: 1 }] })).error.code, 'PICKUP_SITE_REQUIRED', '自提必须选择有效自提点');
  assert.equal((await call(app, 'checkout.quote', { fulfillmentType: 'pickup', pickupSiteId: disabledPickupSite.data._id, warehouseId: warehouse.data._id, items: [{ skuId: 'sku-1', quantity: 1 }] })).error.code, 'PICKUP_SITE_NOT_AVAILABLE', '停用自提点不得用于报价');
  const secondWarehouse = await call(app, 'admin.warehouses.upsert', { adminToken, code: 'WH-2', name: '第二测试仓', status: 'active' });
  assert.equal((await call(app, 'checkout.quote', { fulfillmentType: 'pickup', pickupSiteId: pickupSite.data._id, warehouseId: secondWarehouse.data._id, items: [{ skuId: 'sku-1', quantity: 1 }] })).error.code, 'PICKUP_SITE_WAREHOUSE_MISMATCH', '自提点必须与所选仓库一致');
  assert.equal((await call(app, 'checkout.quote', { fulfillmentType: 'pickup', pickupSiteId: pickupSite.data._id, warehouseId: warehouse.data._id, deliverySlotId: deliverySlot.data._id, items: [{ skuId: 'sku-1', quantity: 1 }] })).error.code, 'DELIVERY_SLOT_NOT_AVAILABLE', '自提不得混入配送时段');
  assert.equal((await call(app, 'checkout.quote', { fulfillmentType: 'courier', warehouseId: warehouse.data._id, items: [{ skuId: 'sku-1', quantity: 1 }] })).error.code, 'VALIDATION_ERROR', '未知履约方式必须被服务端拒绝');
  const originalRunTransaction = store.runTransaction.bind(store);
  store.runTransaction = async (work) => {
    await store.update('delivery_slots', deliverySlot.data._id, { status: 'disabled' });
    return originalRunTransaction(work);
  };
  const staleSlotOrder = await call(app, 'orders.create', { idempotencyKey: 'stale-slot-order', addressId: address.data.address._id, warehouseId: warehouse.data._id, deliverySlotId: deliverySlot.data._id, items: [{ skuId: 'sku-1', quantity: 1 }], paymentMethod: 'demo' });
  store.runTransaction = originalRunTransaction;
  assert.equal(staleSlotOrder.error.code, 'DELIVERY_SLOT_NOT_AVAILABLE', '建单事务必须阻止报价后被停用的配送时段');
  await store.update('delivery_slots', deliverySlot.data._id, { status: 'active' });
  store.runTransaction = async (work) => {
    await store.update('prices', price.data._id, { amountCent: 2600, orderMultiple: 3 });
    return originalRunTransaction(work);
  };
  const stalePriceOrder = await call(app, 'orders.create', { idempotencyKey: 'stale-price-order', addressId: address.data.address._id, warehouseId: warehouse.data._id, items: [{ skuId: 'sku-1', quantity: 2 }], paymentMethod: 'demo' });
  store.runTransaction = originalRunTransaction;
  assert.equal(stalePriceOrder.error.code, 'QUOTE_CHANGED', '建单事务必须阻止报价后变化的成交价或购买规则');
  await store.update('prices', price.data._id, { amountCent: 2500, orderMultiple: 0 });
  const pickupOrder = await call(app, 'orders.create', { idempotencyKey: 'pickup-order-1', fulfillmentType: 'pickup', pickupSiteId: pickupSite.data._id, warehouseId: warehouse.data._id, items: [{ skuId: 'sku-1', quantity: 1 }], paymentMethod: 'demo' });
  assert.equal(pickupOrder.ok, true, JSON.stringify(pickupOrder));
  assert.equal(pickupOrder.data.order.fulfillmentType, 'pickup');
  assert.equal(pickupOrder.data.order.addressSnapshot, null, '自提订单不得伪造顾客收货地址');
  assert.equal(pickupOrder.data.order.pickupSiteSnapshot.address, '测试路 8 号冷库门店', '自提订单必须保存自提点快照');
  assert.equal(pickupOrder.data.order.freightSnapshot.amountCent, 0);
  const storedPickupOrder = await store.findOne('orders', { _id: pickupOrder.data.order._id });
  assert.equal(storedPickupOrder.fulfillmentContactCiphertext, '', '自提订单不得借用顾客地址联系方式');
  const pickupContact = await call(app, 'admin.orders.fulfillmentContact', { adminToken, id: pickupOrder.data.order._id, purpose: 'pickup_test' });
  assert.equal(Object.hasOwn(pickupContact.data, 'recipient'), false, '自提履约信息不得伪装成顾客收货联系人');
  assert.equal(pickupContact.data.pickupSite.id, pickupSite.data._id);
  const duplicatePickupOrder = await call(app, 'orders.create', { idempotencyKey: 'pickup-order-1', fulfillmentType: 'pickup', pickupSiteId: pickupSite.data._id, warehouseId: warehouse.data._id, items: [{ skuId: 'sku-1', quantity: 1 }], paymentMethod: 'demo' });
  assert.equal(duplicatePickupOrder.data.idempotent, true, '自提订单必须兼容既有幂等建单机制');
  const retryWithoutPaymentAdapter = createApplication({ store, getIdentity: () => ({ OPENID: 'openid-test' }), piiEncryptionKey: 'unit-test-pii-encryption-key', clock: fixedClock });
  const adapterIndependentRetry = await call(retryWithoutPaymentAdapter, 'orders.create', { idempotencyKey: 'pickup-order-1', paymentMethod: 'wechat' });
  assert.equal(adapterIndependentRetry.data.idempotent, true, '已成功订单的幂等重试必须在支付适配器和当前履约配置检查前返回');
  await call(app, 'orders.cancel', { id: pickupOrder.data.order._id });
  const authenticatedPrices = await call(app, 'catalog.prices', { skuIds: ['sku-1'] });
  assert.deepEqual(authenticatedPrices.data.rows, [{ skuId: 'sku-1', amountCent: 2500, currency: 'CNY', temporary: false, source: 'client' }], '已登录用户应只通过受控接口获得当前账号可见的服务端价格');

  // 数量阶梯价和起订规则必须由服务端在报价/建单时最终判定，旧的单价规则继续兼容。
  const tieredSku = await call(app, 'admin.skus.upsert', {
    adminToken, productId: 'product-1', skuCode: 'MSX-TIER-1', specName: '商用整箱', packageUnit: '1箱',
    minOrderQuantity: 10, orderMultiple: 5, status: 'on_sale'
  });
  assert.equal(tieredSku.ok, true);
  const tieredSkuId = tieredSku.data._id;
  await call(app, 'admin.inventory.adjust', { adminToken, warehouseId: warehouse.data._id, skuId: tieredSkuId, change: 100, reason: 'tier_test_stock', idempotencyKey: 'tier-test-stock-1' });
  const tieredPrice = await call(app, 'admin.prices.upsert', {
    adminToken, skuId: tieredSkuId, scopeType: 'public', channel: 'miniapp', amountCent: 2500,
    quantityTiers: [{ minQuantity: 10, maxQuantity: 19, amountCent: 2200 }, { minQuantity: 20, amountCent: 2000 }],
    status: 'active', source: 'client', temporary: false
  });
  assert.equal(tieredPrice.ok, true);
  const tieredCatalog = await call(app, 'catalog.product', { productId: 'product-1' });
  const publicTieredSku = tieredCatalog.data.skus.find((item) => item._id === tieredSkuId);
  assert.deepEqual({ minOrderQuantity: publicTieredSku.minOrderQuantity, orderMultiple: publicTieredSku.orderMultiple }, { minOrderQuantity: 10, orderMultiple: 5 }, '商品规格可公开返回不含价格的起订和倍数约束');
  assert.equal(Object.hasOwn(publicTieredSku, 'amountCent'), false, '未登录商品详情仍不得透出阶梯价金额');
  const tieredCatalogPrice = await call(app, 'catalog.prices', { skuIds: [tieredSkuId] });
  assert.deepEqual(tieredCatalogPrice.data.rows[0].quantityTiers, [{ minQuantity: 10, maxQuantity: 19, amountCent: 2200 }, { minQuantity: 20, maxQuantity: null, amountCent: 2000 }]);
  assert.equal((await call(app, 'checkout.quote', { addressId: address.data.address._id, warehouseId: warehouse.data._id, items: [{ skuId: tieredSkuId, quantity: 5 }] })).error.code, 'MIN_ORDER_QUANTITY_NOT_MET', '低于起订量必须被服务端拒绝');
  assert.equal((await call(app, 'checkout.quote', { addressId: address.data.address._id, warehouseId: warehouse.data._id, items: [{ skuId: tieredSkuId, quantity: 11 }] })).error.code, 'ORDER_MULTIPLE_NOT_MET', '不符合购买倍数必须被服务端拒绝');
  const tierQuote = await call(app, 'checkout.quote', { addressId: address.data.address._id, warehouseId: warehouse.data._id, items: [{ skuId: tieredSkuId, quantity: 20 }] });
  assert.equal(tierQuote.data.quote.items[0].unitPriceCent, 2000, '报价应按合并后数量命中对应阶梯');
  assert.deepEqual(tierQuote.data.quote.items[0].purchaseRuleSnapshot, { minOrderQuantity: 10, orderMultiple: 5 });
  const mergedTierQuote = await call(app, 'checkout.quote', { addressId: address.data.address._id, warehouseId: warehouse.data._id, items: [{ skuId: tieredSkuId, quantity: 5 }, { skuId: tieredSkuId, quantity: 5 }] });
  assert.equal(mergedTierQuote.data.quote.items[0].unitPriceCent, 2200, '重复 SKU 必须先合并数量再校验起订量并选择阶梯');
  assert.equal((await call(app, 'checkout.quote', { addressId: address.data.address._id, warehouseId: warehouse.data._id, items: [{ skuId: tieredSkuId, quantity: 600 }, { skuId: tieredSkuId, quantity: 600 }] })).error.code, 'VALIDATION_ERROR', '合并数量不得绕过单 SKU 999 上限');
  const tierOrder = await call(app, 'orders.create', { idempotencyKey: 'tier-order-1', addressId: address.data.address._id, warehouseId: warehouse.data._id, items: [{ skuId: tieredSkuId, quantity: 20 }], paymentMethod: 'demo' });
  assert.equal(tierOrder.ok, true);
  assert.equal(tierOrder.data.order.pricingSnapshot.goodsAmountCent, 40000, '建单必须重新执行服务端阶梯价报价');
  const storedTierOrder = await store.findOne('orders', { _id: tierOrder.data.order._id });
  assert.deepEqual(storedTierOrder.itemsSnapshot[0].quantityTierSnapshot, { minQuantity: 20, maxQuantity: null, amountCent: 2000 }, '订单必须保存命中的阶梯快照');
  await call(app, 'orders.cancel', { id: tierOrder.data.order._id });
  const overlappingTiers = await call(app, 'admin.prices.upsert', {
    adminToken, skuId: tieredSkuId, scopeType: 'public', amountCent: 2500,
    quantityTiers: [{ minQuantity: 10, maxQuantity: 20, amountCent: 2200 }, { minQuantity: 20, amountCent: 2000 }], status: 'draft'
  });
  assert.equal(overlappingTiers.error.code, 'VALIDATION_ERROR', '后台写入重叠阶梯时必须拒绝');
  const preservedTiers = await call(app, 'admin.prices.upsert', { adminToken, id: tieredPrice.data._id, skuId: tieredSkuId, scopeType: 'public', channel: 'miniapp', amountCent: 2450, status: 'active' });
  assert.equal(preservedTiers.data.quantityTiers.length, 2, '旧后台未提交新字段时不得清空已有阶梯');
  assert.equal(preservedTiers.data.temporary, false, '旧后台未提交来源字段时不得改写已有来源元数据');

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
  const listedOrders = await call(app, 'orders.list', { page: 1, pageSize: 10 });
  const listedDemoOrder = listedOrders.data.rows.find((item) => item._id === demoOrder.data.order._id);
  assert.deepEqual(listedDemoOrder.items.map((item) => ({ productNameSnapshot: item.productNameSnapshot, specSnapshot: item.specSnapshot, quantity: item.quantity })), [{ productNameSnapshot: '测试虾仁', specSnapshot: '500克', quantity: 1 }], '订单列表必须返回商品和规格快照，供客户端展示订单摘要');
  for (const status of ['picking', 'shipping', 'delivered']) {
    const transitioned = await call(app, 'admin.orders.transition', { adminToken, id: demoOrder.data.order._id, status });
    assert.equal(transitioned.ok, true, `演示订单应能进入${status}状态`);
  }
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
  const repeatedAdjustment = await call(app, 'admin.inventory.adjust', { adminToken, warehouseId: warehouse.data._id, skuId: 'sku-1', change: 20, reason: 'initial_stock', idempotencyKey: 'inventory-initial-1' });
  assert.equal(repeatedAdjustment.data.idempotent, true, '相同库存幂等键不能重复调整');

  const businessApplication = await call(app, 'auth.applyBusiness', { companyName: '测试餐饮有限公司', unifiedCode: '91340100TEST000001', contactName: '采购员', contactPhone: '13900139000' });
  assert.equal(businessApplication.ok, true);
  assert.equal(Object.hasOwn(businessApplication.data.application, 'contactPhoneCiphertext'), false, '企业申请响应不得返回手机号密文');
  const pendingBusinessUser = await call(app, 'auth.me');
  assert.equal(pendingBusinessUser.data.user.businessStatus, 'pending', '企业申请后登录用户必须能看到待审核状态');
  const storedApplication = await store.findOne('business_applications', { _id: businessApplication.data.application._id });
  assert.equal(Object.hasOwn(storedApplication, 'contactPhone'), false, '企业申请不得保存明文联系人手机号');
  const approvedBusiness = await call(app, 'admin.businessApplications.review', { adminToken, id: businessApplication.data.application._id, decision: 'approved', priceLevel: 'b_standard' });
  assert.equal(approvedBusiness.ok, true);
  const businessUser = await call(app, 'auth.me');
  assert.equal(businessUser.data.user.userType, 'b', '企业审核通过后用户必须切换为 B 端');
  assert.equal(businessUser.data.user.businessStatus, 'approved', '企业审核通过后登录用户必须看到已通过状态');
  assert.equal((await call(app, 'catalog.product', { productId: 'product-b-only' })).ok, true, 'B 端应能读取 B 端专享商品详情');
  assert.equal((await call(app, 'catalog.product', { productId: 'product-c-only' })).error.code, 'PRODUCT_NOT_FOUND', 'B 端不得读取 C 端专享商品详情');
  assert.deepEqual((await call(app, 'catalog.prices', { skuIds: ['sku-b-only', 'sku-c-only'] })).data.rows.map((row) => row.skuId), ['sku-b-only'], 'B 端只应获得其可见商品的价格');
  const businessTierPrice = await call(app, 'admin.prices.upsert', {
    adminToken, skuId: tieredSkuId, scopeType: 'customer_type', scopeId: 'b', channel: 'miniapp', amountCent: 2300,
    quantityTiers: [{ minQuantity: 20, amountCent: 1900 }], minOrderQuantity: 20, orderMultiple: 10,
    status: 'active', source: 'client', temporary: false
  });
  assert.equal(businessTierPrice.ok, true);
  assert.equal((await call(app, 'checkout.quote', { addressId: address.data.address._id, warehouseId: warehouse.data._id, items: [{ skuId: tieredSkuId, quantity: 10 }] })).error.code, 'MIN_ORDER_QUANTITY_NOT_MET', '客户类型价格规则应可覆盖 SKU 默认起订量');
  const businessTierQuote = await call(app, 'checkout.quote', { addressId: address.data.address._id, warehouseId: warehouse.data._id, items: [{ skuId: tieredSkuId, quantity: 20 }] });
  assert.equal(businessTierQuote.data.quote.items[0].unitPriceCent, 1900, '应先选中 B 端客户类型价格规则，再按数量选阶梯');
  assert.deepEqual(businessTierQuote.data.quote.items[0].purchaseRuleSnapshot, { minOrderQuantity: 20, orderMultiple: 10 });
  assert.equal((await call(app, 'cart.upsert', { skuId: 'sku-b-only', quantity: 1 })).ok, true, 'B 端应能把 B 端专享商品加入购物车');
  assert.equal((await call(app, 'checkout.quote', { addressId: address.data.address._id, warehouseId: warehouse.data._id, items: [{ skuId: 'sku-b-only', quantity: 1 }] })).ok, true, 'B 端应能为 B 端专享商品取得报价');
  assert.equal((await call(app, 'checkout.quote', { addressId: address.data.address._id, warehouseId: warehouse.data._id, items: [{ skuId: 'sku-c-only', quantity: 1 }] })).error.code, 'PRODUCT_NOT_AVAILABLE', 'B 端不得为 C 端专享商品取得报价');
  const repeatedBusinessApplication = await call(app, 'auth.applyBusiness', { companyName: '重复申请公司', unifiedCode: '91340100TEST000002', contactName: '采购员', contactPhone: '13800138000' });
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
  assert.equal(refundReview.data.refund.status, 'awaiting_manual_refund');
  assert.equal(refundReview.data.refund.manualRefundRequired, true, '审核通过只能进入待人工退款，不能伪造渠道成功');
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
    rows: [{ sourceRowNo: 2, source: { id: 1001, name: '测试鱼丸', category: '丸滑类', unit: '1件/10包/500克' }, parsed: { name: '测试鱼丸', categoryName: '丸滑类', specName: '500克', packageUnit: '1件/10包/500克' }, mappingWarnings: ['价格未确认'] }]
  });
  assert.equal(stage.ok, true);
  const approved = await call(app, 'admin.imports.approve', { adminToken, id: stage.data.staged[0].id });
  assert.equal(approved.ok, true);
  const activated = await call(app, 'admin.imports.activateBatch', { adminToken, ids: [stage.data.staged[0].id] });
  assert.equal(activated.ok, true);
  assert.equal(activated.data.activated.length, 1);
  assert.equal((await store.findOne('categories', { _id: activated.data.activated[0].categoryId })).status, 'enabled');
  assert.equal((await store.findOne('products', { _id: activated.data.activated[0].productId })).status, 'on_sale');
  assert.equal((await store.findOne('product_skus', { _id: activated.data.activated[0].skuId })).status, 'on_sale');
  const importedCatalog = await call(app, 'catalog.products', { keyword: '测试鱼丸' });
  assert.equal(importedCatalog.data.rows.length, 1);
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
  console.log('api application tests: passed');
}

run().catch((error) => { console.error(error); process.exit(1); });
