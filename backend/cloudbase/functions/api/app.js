const { fail, success, failure } = require('./lib/response');
const { randomId, sha256, verifyPassword, encryptText } = require('./lib/security');
const { hasPermission, collectPermissions } = require('./lib/permissions');
const { audienceVisible, buildQuote, createOrder, expireReservations, expireGroups, resolveUnitPrices } = require('./lib/commerce');
const { active: activeGroupCampaign, createGroup } = require('./lib/groups');
const { collectPageMatches } = require('./lib/collection-read');
const { createAdminMediaChunks } = require('./lib/admin-media-chunks');
const { createCatalogImport } = require('./lib/catalog-import');
const { createCatalogReview } = require('./lib/catalog-review');
const { createOfflineReceipts } = require('./lib/offline-receipts');
const { createStaffAccounts } = require('./lib/staff-accounts');
const { createStaffWriteGuard } = require('./lib/staff-write-guard');
const { createPricingTargets } = require('./lib/pricing-targets');
const { SESSION_TTL_MS, LOGIN_WINDOW_MS, LOGIN_MAX_FAILURES, nowIso, string, integer, pageParams, pick, publicProduct, publicSku, publicProductsWithSkus, maskedPhone, safeOrder, safeGroup, isScheduledEnabled, cleanAdmin } = require('./lib/api-values');
const { createAdminCatalogActions } = require('./lib/admin-catalog-actions');
const { createCustomerOrderActions } = require('./lib/customer-order-actions');
const { createAdminOperationsActions } = require('./lib/admin-operations-actions');

function createApplication({ store, getIdentity = () => ({}), bootstrapToken = '', piiEncryptionKey = '', paymentPreparer = null, paymentVerifier = null, refundVerifier = null, mediaUrlResolver = null, storageUploader = null, storageDownloader = null, storageDeleter = null, demoMode = false, clock = () => new Date(), getPhoneByCode = null }) {
  async function audit(admin, action, targetType, targetId, details = {}) {
    return store.create('audit_logs', {
      actorType: admin ? 'admin' : 'system',
      actorId: admin ? admin._id : '',
      action,
      targetType,
      targetId: targetId || '',
      details,
      createdAt: nowIso(clock)
    });
  }

  async function getAdmin(payload, permission) {
    const token = string(payload.adminToken, '管理员会话', { required: true, max: 256 });
    const session = await store.findOne('admin_sessions', { tokenHash: sha256(token), status: 'active' });
    if (!session || new Date(session.expiresAt).getTime() <= clock().getTime()) fail('ADMIN_SESSION_EXPIRED', '管理员登录已过期，请重新登录。');
    const admin = await store.findOne('admin_users', { _id: session.adminId, status: 'active' });
    if (!admin) fail('ADMIN_UNAUTHORIZED', '管理员账号不可用。');
    if ((session.authVersion||0)!==(admin.authVersion||0)) fail('ADMIN_SESSION_EXPIRED','密码或账号已变更，请重新登录。');
    const roles = (await store.list('admin_roles', { page: 1, pageSize: 100 })).rows;
    const permissions = collectPermissions(admin, roles);
    if (permission && !hasPermission(permissions, permission)) fail('ADMIN_FORBIDDEN', '当前账号没有此操作权限。');
    return { admin, permissions };
  }

  const mediaChunks = createAdminMediaChunks({ store, getAdmin, audit, clock, storageUploader, storageDownloader, storageDeleter });
  const catalogImport = createCatalogImport({ store, clock, audit });
  const catalogReview = createCatalogReview({ store, clock, audit });
  const offlineReceipts = createOfflineReceipts({ store, getAdmin, clock });
  const staffAccounts = createStaffAccounts({store, getAdmin, clock, piiEncryptionKey,bootstrapToken});
  const staffWrites = createStaffWriteGuard({store,clock,getAdmin});
  const pricingTargets = createPricingTargets(store);

  async function ensureWechatUser(phoneCode = '') {
    const identity = getIdentity() || {};
    const openid = identity.OPENID || identity.openid || '';
    if (!openid) fail('UNAUTHENTICATED', '未取得微信用户身份。');
    let user = await store.findOne('users', { openid });
    const timestamp = nowIso(clock);
    let phone = '';
    if (phoneCode && typeof getPhoneByCode === 'function') {
      try { phone = String(await getPhoneByCode(phoneCode) || '').replace(/\s/g, ''); } catch (_) { phone = ''; }
      if (phone && !/^1\d{10}$/.test(phone)) phone = '';
    }
    if (!user) {
      const patch = { openid, userType: 'c', status: 'active', createdAt: timestamp, updatedAt: timestamp, lastLoginAt: timestamp };
      if (phone && piiEncryptionKey && String(piiEncryptionKey).length >= 16) {
        const masked = maskedPhone(phone);
        const existingByPhone = await store.findOne('users', { phoneMasked: masked });
        if (existingByPhone && existingByPhone.openid !== openid) fail('PHONE_ALREADY_REGISTERED', '该手机号已被其他账号使用。');
        patch.phoneCiphertext = encryptText(phone, piiEncryptionKey);
        patch.phoneMasked = masked;
      }
      user = await store.create('users', patch);
    } else {
      const patch = { lastLoginAt: timestamp, updatedAt: timestamp };
      if (phone && piiEncryptionKey && String(piiEncryptionKey).length >= 16) {
        const newMasked = maskedPhone(phone);
        if (!user.phoneMasked || user.phoneMasked !== newMasked) {
          const existingByPhone = await store.findOne('users', { phoneMasked: newMasked });
          if (existingByPhone && existingByPhone._id !== user._id) fail('PHONE_ALREADY_REGISTERED', '该手机号已被其他账号使用。');
          patch.phoneCiphertext = encryptText(phone, piiEncryptionKey);
          patch.phoneMasked = newMasked;
        }
      }
      await store.update('users', user._id, patch);
      Object.assign(user, patch);
    }
    return user;
  }

  async function userUploadBusinessMedia(payload) {
    const user = await ensureWechatUser();
    if (typeof storageUploader !== 'function') fail('MEDIA_UPLOAD_UNAVAILABLE', '素材上传服务尚未配置。');
    const kind = string(payload.kind, '素材类型', { max: 40 });
    if (!['storefront', 'license', 'attachment'].includes(kind)) fail('VALIDATION_ERROR', '素材类型不合法。');
    const type = string(payload.type, '素材种类', { max: 30 }) || 'image';
    if (type !== 'image') fail('VALIDATION_ERROR', '仅支持图片素材。');
    const mimeType = string(payload.mimeType, 'MIME', { max: 40 }) || 'image/jpeg';
    const fileName = string(payload.fileName, '文件名', { required: true, max: 120 });
    const sizeBytes = integer(payload.sizeBytes, 0);
    const contentBase64 = string(payload.contentBase64, '素材内容', { required: true, max: 20 * 1024 * 1024 });
    if (sizeBytes > 4 * 1024 * 1024) fail('MEDIA_SIZE_INVALID', '素材不能超过 4MB。');
    const extension = (fileName.match(/\.([^.?#]+)$/) || [])[1] || 'jpg';
    const safeBaseName = fileName.replace(/[^\w\-\.]/g, '_').slice(0, 60) || 'media';
    const safeExt = ['jpg', 'jpeg', 'png', 'webp'].includes(extension.toLowerCase()) ? extension.toLowerCase() : 'jpg';
    const cloudPath = `mengshixian/business-applications/${user._id}/${kind}-${randomId()}-${safeBaseName}.${safeExt}`;
    const fileId = await storageUploader({ cloudPath, contentBase64 });
    if (!fileId) fail('MEDIA_UPLOAD_FAILED', '素材上传未返回文件 ID。');
    return { mediaId: fileId };
  }

  async function applyBusiness(payload) {
    const user = await ensureWechatUser();
    if (user.businessStatus === 'approved') fail('BUSINESS_APPLICATION_NOT_NEEDED', '当前商家账号已审核通过，无需重复申请。');
    if (!piiEncryptionKey || String(piiEncryptionKey).length < 16) fail('PII_ENCRYPTION_NOT_CONFIGURED', '企业申请信息加密尚未配置。');
    const companyName = string(payload.companyName, '企业名称', { required: true, max: 120 });
    const storeName = string(payload.storeName, '门店名称', { required: true, max: 80 });
    const storeAddress = string(payload.storeAddress, '门店地址', { required: true, max: 200 });
    const mainBusinessType = string(payload.mainBusinessType, '主营类型', { required: true, max: 20 });
    if (!['restaurant', 'retail'].includes(mainBusinessType)) fail('VALIDATION_ERROR', '主营类型不合法。');
    const unifiedCode = string(payload.unifiedCode, '统一社会信用代码', { required: true, max: 18 }).toUpperCase();
    if (!/^[0-9A-Z]{18}$/.test(unifiedCode)) fail('VALIDATION_ERROR', '请输入有效的 18 位统一社会信用代码。');
    const storefrontMediaId = string(payload.storefrontMediaId, '门头照片', { required: true, max: 120 });
    const businessLicenseMediaId = string(payload.businessLicenseMediaId, '营业执照', { required: true, max: 120 });
    const contactName = string(payload.contactName, '联系人', { required: true, max: 40 });
    const contactPhone = string(payload.contactPhone, '联系人手机号', { required: true, max: 30 }).replace(/\s/g, '');
    if (!/^1\d{10}$/.test(contactPhone)) fail('VALIDATION_ERROR', '请输入有效的 11 位联系人手机号。');
    const timestamp = nowIso(clock);
    const existing = await store.findOne('business_applications', { userId: user._id, status: 'pending' });
    const patch = { userId: user._id, companyName, storeName, storeAddress, mainBusinessType, unifiedCode, storefrontMediaId, businessLicenseMediaId, contactName, salesCode: string(payload.salesCode, '业务员编码', { max: 40 }), chainEnabled: payload.chainEnabled === true, contactPhoneCiphertext: encryptText(contactPhone, piiEncryptionKey), contactPhoneMasked: maskedPhone(contactPhone), status: 'pending', submittedAt: timestamp, updatedAt: timestamp };
    let application;
    if (existing) {
      await store.update('business_applications', existing._id, patch);
      application = { ...existing, ...patch, _id: existing._id };
    } else application = await store.create('business_applications', { ...patch, createdAt: timestamp });
    await store.update('users', user._id, { businessStatus: 'pending', updatedAt: timestamp });
    return { application: pick(application, ['_id', 'storeName', 'storefrontMediaId', 'businessLicenseMediaId', 'contactName', 'contactPhoneMasked', 'status', 'submittedAt', 'updatedAt']) };
  }

  async function publicCategories(payload) {
    const listed = await store.list('categories', { where: { status: 'enabled' }, orderBy: [{ field: 'sort', direction: 'asc' }], ...pageParams(payload) });
    return { ...listed, rows: listed.rows.map((item) => pick(item, ['_id', 'name', 'parentId', 'imageMediaId', 'sort'])) };
  }

  async function resolveViewerType() {
    try {
      const identity = getIdentity() || {};
      const openid = identity.OPENID || identity.openid || '';
      if (!openid) return 'c';
      const user = await store.findOne('users', { openid });
      return user && user.userType === 'b' ? 'b' : 'c';
    } catch (_) {
      return 'c';
    }
  }
  async function publicProducts(payload) {
    const viewerType = await resolveViewerType();
    const where = { status: 'on_sale' };
    if (payload.categoryId) where.categoryId = string(payload.categoryId, '分类 ID', { max: 80 });
    const keyword = string(payload.keyword, '搜索关键词', { max: 40 });
    const params = pageParams(payload);
    const options = { where, orderBy: [{ field: 'sort', direction: 'asc' }, { field: 'createdAt', direction: 'desc' }] };
    const matched = await collectPageMatches(store, 'products', options, (item) => {
      if (!audienceVisible(item.audienceType, viewerType)) return false;
      return !keyword || `${item.name || ''}${item.categoryName || ''}${item.brand || ''}`.includes(keyword);
    });
    const start = (params.page - 1) * params.pageSize;
    const rows = matched.slice(start, start + params.pageSize);
    return { rows: await publicProductsWithSkus(store, rows), total: matched.length, page: params.page, pageSize: params.pageSize };
  }

  async function publicProductDetail(payload) {
    const viewerType = await resolveViewerType();
    const productId = string(payload.productId, '商品 ID', { required: true, max: 80 });
    const product = await store.findOne('products', { _id: productId, status: 'on_sale' });
    if (!product || !audienceVisible(product.audienceType, viewerType)) fail('PRODUCT_NOT_FOUND', '商品不存在或暂未上架。');
    const [skus, media] = await Promise.all([
      collectPageMatches(store, 'product_skus', { where: { productId, status: 'on_sale' }, orderBy: [{ field: 'sort', direction: 'asc' }] }, () => true),
      collectPageMatches(store, 'product_media', { where: { productId, enabled: true }, orderBy: [{ field: 'sort', direction: 'asc' }] }, () => true)
    ]);
    return { product: publicProduct(product), skus: skus.map(publicSku), media: media.map((item) => pick(item, ['_id', 'mediaAssetId', 'skuId', 'mediaType', 'role', 'sort'])) };
  }

  async function userCatalogPrices(payload) {
    const user = await ensureWechatUser();
    const skuIds = Array.isArray(payload.skuIds) ? [...new Set(payload.skuIds.map((item) => string(item, 'SKU ID', { required: true, max: 80 })))].slice(0, 100) : [];
    if (!skuIds.length) return { rows: [] };
    // 与结算报价使用同一渠道口径（web/miniapp），避免列表价与结算价不一致
    const channel = payload.channel === 'web' ? 'web' : 'miniapp';
    const requestedSkuIds = new Set(skuIds);
    const skus = await collectPageMatches(store, 'product_skus', { where: { status: 'on_sale' } }, (sku) => requestedSkuIds.has(sku._id));
    const skuMap = new Map(skus.map((sku) => [sku._id, sku]));
    const productIds = new Set(skus.map((sku) => sku.productId));
    const products = productIds.size
      ? await collectPageMatches(store, 'products', { where: { status: 'on_sale' } }, (product) => productIds.has(product._id))
      : [];
    const productMap = new Map(products.map((product) => [product._id, product]));
    const visibleSkuIds = skuIds.filter((skuId) => {
      const sku = skuMap.get(skuId);
      const product = sku && productMap.get(sku.productId);
      return Boolean(product && audienceVisible(product.audienceType, user));
    });
    // 只为当前身份可见的 SKU 解析价格，避免通过已知 SKU ID 探测另一端商品价格
    const priced = await resolveUnitPrices(store, visibleSkuIds, user, channel, clock());
    const rows = [];
    for (const item of priced) {
      rows.push({ skuId: item.skuId, amountCent: item.amountCent, currency: item.currency, temporary: item.temporary, source: item.source });
    }
    return { rows };
  }

  async function publicContent(collection, payload) {
    const { contentTargetAvailable } = require('./lib/content-targets');
    const viewerType = await resolveViewerType();
    const platform = payload.platform === 'web' ? 'web' : 'miniapp';
    const params = pageParams(payload);
    const scheduled = await collectPageMatches(store, collection, { where: { enabled: true }, orderBy: [{ field: 'sort', direction: 'asc' }] }, (item) => {
      const platforms = Array.isArray(item.targetPlatforms) && item.targetPlatforms.length ? item.targetPlatforms : ['miniapp', 'web'];
      return isScheduledEnabled(item, clock()) && platforms.includes(platform);
    });
    const matched = [];
    const targets = new Map();
    for (const item of scheduled) {
      const key = `${item.jumpType}:${item.jumpTarget}`;
      if (!targets.has(key)) targets.set(key, await contentTargetAvailable(store, item, viewerType));
      if (targets.get(key)) matched.push(item);
    }
    const start = (params.page - 1) * params.pageSize;
    return { rows: matched.slice(start, start + params.pageSize).map((item) => pick(item, ['_id', 'contentKey', 'title', 'subtitle', 'linkText', 'moduleType', 'mediaAssetId', 'jumpType', 'jumpTarget', 'sort', 'startAt', 'endAt', 'targetPlatforms'])), total: matched.length, page: params.page, pageSize: params.pageSize };
  }

  async function publicMediaResolve(payload) {
    const ids = Array.isArray(payload.ids) ? [...new Set(payload.ids.map((item) => string(item, '素材 ID', { required: true, max: 80 })))].slice(0, 50) : [];
    if (!ids.length) return { rows: [] };
    const platform = payload.platform === 'web' ? 'web' : 'miniapp';
    const requested = new Set(ids);
    const resolved = new Map();
    await collectPageMatches(store, 'media_assets', { where: { enabled: true } }, (item) => {
      const platforms = Array.isArray(item.targetPlatforms) && item.targetPlatforms.length ? item.targetPlatforms : ['miniapp', 'web'];
      if (requested.has(item._id) && platforms.includes(platform) && isScheduledEnabled(item, clock()) && !resolved.has(item._id)) {
        resolved.set(item._id, pick(item, ['_id', 'type', 'fileId', 'thumbnailFileId', 'coverFileId', 'mimeType', 'version']));
      }
      return false;
    }, { isComplete: () => resolved.size >= requested.size });
    const rows = [...resolved.values()];
    if (platform !== 'web' || typeof mediaUrlResolver !== 'function') return { rows };
    const fileIds = [...new Set(rows.map((item) => item.fileId).filter(Boolean))];
    const urlMap = await mediaUrlResolver(fileIds);
    return { rows: rows.map((item) => urlMap && urlMap[item.fileId] ? { ...item, url: urlMap[item.fileId] } : item) };
  }

  async function publicDeliveryOptions() {
    const [warehouses, areas, slots] = await Promise.all([
      collectPageMatches(store, 'warehouses', { where: { status: 'active' }, orderBy: [{ field: 'sort', direction: 'asc' }] }, () => true),
      collectPageMatches(store, 'delivery_areas', { where: { status: 'active' }, orderBy: [{ field: 'sort', direction: 'asc' }] }, () => true),
      collectPageMatches(store, 'delivery_slots', { where: { status: 'active' }, orderBy: [{ field: 'sort', direction: 'asc' }] }, () => true)
    ]);
    return {
      warehouses: warehouses.map((item) => pick(item, ['_id', 'code', 'name', 'address', 'sort'])),
      areas: areas.map((item) => pick(item, ['_id', 'name', 'regionCodes', 'warehouseIds', 'sort'])),
      slots: slots.map((item) => pick(item, ['_id', 'name', 'deliveryAreaId', 'warehouseId', 'startTime', 'endTime', 'sort']))
    };
  }

  function campaignIsActive(campaign) {
    return campaign && campaign.status === 'active' && isScheduledEnabled(campaign, clock());
  }

  async function publicGroupCampaigns(payload) {
    const params = pageParams(payload);
    const viewerType = await resolveViewerType();
    const candidates = await collectPageMatches(store, 'group_campaigns', { where: { status: 'active' }, orderBy: [{ field: 'sort', direction: 'asc' }] }, campaignIsActive);
    const rows = [];
    for (const item of candidates) {
      if (item.targetUserType && item.targetUserType !== 'all' && item.targetUserType !== viewerType) continue;
      const sku = await store.findOne('product_skus', { _id: item.skuId, status: 'on_sale' });
      if (!sku) continue;
      const product = await store.findOne('products', { _id: sku.productId, status: 'on_sale' });
      if (!product || !audienceVisible(product.audienceType, viewerType)) continue;
      rows.push({ ...pick(item, ['_id', 'title', 'skuId', 'groupSize', 'durationMinutes', 'coverMediaId', 'targetUserType', 'startAt', 'endAt', 'sort']), productId: sku.productId });
    }
    const start = (params.page - 1) * params.pageSize;
    return { rows: rows.slice(start, start + params.pageSize), total: rows.length, page: params.page, pageSize: params.pageSize };
  }

  async function groupQuote(payload) {
    const user = await ensureWechatUser();
    const campaignId = string(payload.campaignId, '拼团活动 ID', { required: true, max: 80 });
    const campaign = await store.findOne('group_campaigns', { _id: campaignId });
    if (!campaignIsActive(campaign)) fail('GROUP_CAMPAIGN_NOT_AVAILABLE', '拼团活动不存在或暂未开放。');
    if (campaign.targetUserType && campaign.targetUserType !== 'all' && campaign.targetUserType !== user.userType) fail('GROUP_CAMPAIGN_FORBIDDEN', '当前账号不符合拼团活动参与条件。');
    const addressId = string(payload.addressId, '收货地址 ID', { required: true, max: 80 });
    const warehouseId = string(payload.warehouseId, '仓库 ID', { required: true, max: 80 });
    const address = await store.findOne('addresses', { _id: addressId, userId: user._id, status: 'active' });
    if (!address || !address.regionCode) fail('ADDRESS_NOT_AVAILABLE', '请选择有效收货地址。');
    const items = Array.isArray(payload.items) ? payload.items : [];
    if (items.length !== 1 || String(items[0].skuId || '') !== campaign.skuId) fail('GROUP_ITEM_INVALID', '一次拼团结算只能包含当前活动商品。');
    const quote = await buildQuote({ store, user, warehouseId, regionCode: address.regionCode, items, channel: payload.channel, now: clock(), deliverySlotId: payload.deliverySlotId, priceOverrides: { [campaign.skuId]: { amountCent: campaign.groupPriceCent, ruleId: `group:${campaign._id}` } } });
    return { campaign: pick(campaign, ['_id', 'title', 'skuId', 'groupSize', 'durationMinutes']), quote };
  }

  async function groupCreate(payload) {
    const user = await ensureWechatUser();
    const campaignId = string(payload.campaignId, '拼团活动 ID', { required: true, max: 80 });
    const campaign = await store.findOne('group_campaigns', { _id: campaignId });
    if (!activeGroupCampaign(campaign, clock())) fail('GROUP_CAMPAIGN_NOT_AVAILABLE', '拼团活动不存在或暂未开放。');
    if (campaign.targetUserType && campaign.targetUserType !== 'all' && campaign.targetUserType !== user.userType) fail('GROUP_CAMPAIGN_FORBIDDEN', '当前账号不符合拼团活动参与条件。');
    const campaignSku = await store.findOne('product_skus', { _id: campaign.skuId, status: 'on_sale' });
    const campaignProduct = campaignSku ? await store.findOne('products', { _id: campaignSku.productId, status: 'on_sale' }) : null;
    if (!campaignProduct || !audienceVisible(campaignProduct.audienceType, user)) fail('GROUP_CAMPAIGN_FORBIDDEN', '当前账号不可参与该商品的拼团。');
    // 单用户同时最多 3 个进行中拼团，防止无成本刷团占位
    const openGroups = await store.list('groups', { where: { status: 'open' }, page: 1, pageSize: 100 });
    const myOpenGroups = openGroups.rows.filter((group) => (group.reservedUserIds || []).includes(user._id)).length;
    if (myOpenGroups >= 3) fail('GROUP_LIMIT_REACHED', '您已有 3 个进行中的拼团，请等待成团或过期后再开新团。');
    const group = await createGroup({ store, user, campaign, now: clock() });
    return { group: safeGroup(group) };
  }

  async function groupJoin(payload) {
    const user = await ensureWechatUser();
    const groupId = string(payload.groupId, '拼团 ID', { required: true, max: 80 });
    const group = await store.findOne('groups', { _id: groupId, status: 'open' });
    if (!group) fail('GROUP_NOT_AVAILABLE', '拼团不存在或已结束。');
    const campaign = await store.findOne('group_campaigns', { _id: group.campaignId });
    if (!activeGroupCampaign(campaign, clock())) fail('GROUP_CAMPAIGN_NOT_AVAILABLE', '拼团活动不存在或已结束。');
    if (campaign.targetUserType && campaign.targetUserType !== 'all' && campaign.targetUserType !== user.userType) fail('GROUP_CAMPAIGN_FORBIDDEN', '当前账号不符合拼团活动参与条件。');
    if (String(payload.paymentMethod || 'wechat') !== 'wechat') fail('GROUP_PAYMENT_REQUIRED', '拼团订单必须使用微信支付。');
    if (typeof paymentPreparer !== 'function') fail('PAYMENT_NOT_CONFIGURED', '微信支付预下单尚未配置，暂不能创建拼团订单。');
    const result = await createOrder({ store, user, payload: { ...payload, groupId, groupCampaignId: campaign._id, paymentMethod: 'wechat' }, now: clock() });
    return { order: safeOrder(result.order), group: safeGroup(group), idempotent: result.idempotent };
  }

  async function groupGet(payload) {
    const groupId = string(payload.groupId, '拼团 ID', { required: true, max: 80 });
    const group = await store.findOne('groups', { _id: groupId });
    if (!group) fail('GROUP_NOT_FOUND', '拼团不存在。');
    const members = await store.list('group_members', { where: { groupId, status: 'active' }, page: 1, pageSize: 100 });
    return { group: safeGroup(group), members: members.rows.map((item) => pick(item, ['_id', 'paidAt', 'createdAt'])) };
  }

  async function adminLogin(payload) {
    const username = string(payload.username, '管理员账号', { required: true, max: 40 });
    const password = string(payload.password, '管理员密码', { required: true, max: 128 });
    const timestamp = nowIso(clock);
    const usernameHash = sha256(username.toLowerCase());
    const limiter = await store.findOne('admin_login_limits', { usernameHash });
    if (limiter && limiter.lockedUntil && new Date(limiter.lockedUntil).getTime() > clock().getTime()) {
      fail('ADMIN_LOGIN_THROTTLED', '登录尝试过多，请稍后再试。');
    }
    const admin = await store.findOne('admin_users', { username, status: 'active' });
    if (!admin || !verifyPassword(password, admin)) {
      // 失败计数必须以确定性文档 ID 在事务内原子递增，防止并发请求绕过锁定阈值
      const limiterDocumentId = `lim_${usernameHash}`;
      if (typeof store.runTransaction === 'function') {
        await store.runTransaction(async (tx) => {
          const current = await tx.getById('admin_login_limits', limiterDocumentId);
          const inWindow = current && current.windowStartedAt && clock().getTime() - new Date(current.windowStartedAt).getTime() < LOGIN_WINDOW_MS;
          const failures = (inWindow ? Number(current.failureCount || 0) : 0) + 1;
          const failureTimestamp = nowIso(clock);
          await tx.set('admin_login_limits', limiterDocumentId, { usernameHash, failureCount: failures, windowStartedAt: inWindow ? current.windowStartedAt : failureTimestamp, lockedUntil: failures >= LOGIN_MAX_FAILURES ? new Date(clock().getTime() + LOGIN_WINDOW_MS).toISOString() : '', updatedAt: failureTimestamp });
        });
      } else {
        const inWindow = limiter && limiter.windowStartedAt && clock().getTime() - new Date(limiter.windowStartedAt).getTime() < LOGIN_WINDOW_MS;
        const failures = (inWindow ? Number(limiter.failureCount || 0) : 0) + 1;
        const patch = { usernameHash, failureCount: failures, windowStartedAt: inWindow ? limiter.windowStartedAt : timestamp, lockedUntil: failures >= LOGIN_MAX_FAILURES ? new Date(clock().getTime() + LOGIN_WINDOW_MS).toISOString() : '', updatedAt: timestamp };
        if (limiter) await store.update('admin_login_limits', limiter._id, patch);
        else await store.create('admin_login_limits', { ...patch, createdAt: timestamp });
      }
      fail('ADMIN_LOGIN_FAILED', '账号或密码错误。');
    }
    if (limiter) await store.update('admin_login_limits', limiter._id, { failureCount: 0, windowStartedAt: timestamp, lockedUntil: '', updatedAt: timestamp });
    const roles = (await store.list('admin_roles', { page: 1, pageSize: 100 })).rows;
    const permissions = collectPermissions(admin, roles);
    const token = randomId('adm');
    await store.create('admin_sessions', { adminId: admin._id, authVersion:admin.authVersion||0, tokenHash: sha256(token), status: 'active', expiresAt: new Date(clock().getTime() + SESSION_TTL_MS).toISOString(), createdAt: timestamp, lastSeenAt: timestamp });
    await store.update('admin_users', admin._id, { lastLoginAt: timestamp, updatedAt: timestamp });
    await audit(admin, 'admin.login', 'admin_session', '', {});
    return { token, expiresAt: new Date(clock().getTime() + SESSION_TTL_MS).toISOString(), admin: cleanAdmin(admin, permissions) };
  }

  async function adminLogout(payload) {
    const context = await getAdmin(payload);
    const session = await store.findOne('admin_sessions', { tokenHash: sha256(payload.adminToken), status: 'active' });
    if (session) await store.update('admin_sessions', session._id, { status: 'revoked', revokedAt: nowIso(clock) });
    await audit(context.admin, 'admin.logout', 'admin_session', session ? session._id : '', {});
    return { loggedOut: true };
  }

  async function adminRoles(payload) {
    await getAdmin(payload, 'admin.read');
    return store.list('admin_roles', { orderBy: [{ field: 'createdAt', direction: 'asc' }], ...pageParams(payload) });
  }

  async function retiredStaffWrite(payload) {
    await getAdmin(payload, '*');
    fail('STAFF_USE_ACCOUNT_MANAGER', '请使用工作人员账号管理；仅支持超级管理员和运营，不再创建自定义角色。');
  }

  async function adminAdminUsers(payload) {
    await getAdmin(payload, 'admin.read');
    const roles = (await store.list('admin_roles', { page: 1, pageSize: 100 })).rows;
    const listed = await store.list('admin_users', { orderBy: [{ field: 'createdAt', direction: 'asc' }], ...pageParams(payload) });
    return { ...listed, rows: listed.rows.map((item) => cleanAdmin(item, collectPermissions(item, roles))) };
  }

  async function adminList(collection, payload, permission, options = {}) {
    await getAdmin(payload, permission);
    return store.list(collection, { orderBy: options.orderBy || [{ field: 'updatedAt', direction: 'desc' }], ...pageParams(payload) });
  }

  async function adminReadiness(payload) {
    await getAdmin(payload, 'admin.read');
    const count = async (collection, where = {}) => (await store.list(collection, { where, page: 1, pageSize: 1 })).total;
    const [productsOnSale, skusOnSale, activePriceRules, activeWarehouses, inventoryRecords, activeDeliveryAreas, activeFreightRules, activeDeliverySlots, activeGroupCampaigns, enabledMediaAssets] = await Promise.all([
      count('products', { status: 'on_sale' }), count('product_skus', { status: 'on_sale' }), count('prices', { status: 'active' }), count('warehouses', { status: 'active' }), count('inventory'), count('delivery_areas', { status: 'active' }), count('freight_rules', { status: 'active' }), count('delivery_slots', { status: 'active' }), count('group_campaigns', { status: 'active' }), count('media_assets', { enabled: true })
    ]);
    const blockers = [];
    if (!activePriceRules) blockers.push('No active server-side price rules.');
    if (!activeWarehouses) blockers.push('No active warehouse.');
    if (!inventoryRecords) blockers.push('No inventory records.');
    if (!activeDeliveryAreas) blockers.push('No active delivery area.');
    if (!activeFreightRules) blockers.push('No active freight rule.');
    return { counts: { productsOnSale, skusOnSale, activePriceRules, activeWarehouses, inventoryRecords, activeDeliveryAreas, activeFreightRules, activeDeliverySlots, activeGroupCampaigns, enabledMediaAssets }, catalogReady: productsOnSale > 0 && skusOnSale > 0, quoteAndOrderDataReady: false, groupDataReady: activeGroupCampaigns > 0, blockers, manualLinkVerificationRequired: true };
  }

  const { validateMediaReference, adminUpsertCategory, adminUpsertProduct, adminUpsertSku, adminSetProductStatus, adminSetSkuStatus, adminUpsertContent, adminUpsertMedia, adminCreateMediaVersion, adminListProductMedia, adminUpsertProductMedia, adminUploadMedia, stageImport, approveImport, activateImportBatch, previewImport, linkMediaByCode } = createAdminCatalogActions({ store, storageUploader, clock, audit, getAdmin, catalogImport, catalogReview });

  const { userAddresses, userUpsertAddress, userDeleteAddress, userCart, userUpsertCartItem, userRemoveCartItem, checkoutQuote, userCreateOrder, userOrders, userOrder, userCancelOrder, userCompleteOrder, wechatPaymentNotify, userPreparePayment, userRequestRefund, adminReviewRefund, refundNotify } = createCustomerOrderActions({ store, piiEncryptionKey, paymentPreparer, paymentVerifier, refundVerifier, demoMode, clock, audit, getAdmin, ensureWechatUser });

  const { adminUpsertPrice, adminSeedDemoCommerce, adminUpsertGroupCampaign, adminUsers, adminSetUserPricingProfile, adminReviewBusinessApplication, adminBusinessApplications, adminUpsertWarehouse, adminAdjustInventory, adminUpsertDeliveryArea, adminUpsertFreightRule, adminUpsertDeliverySlot, adminTransitionOrder, adminOrderFulfillmentContact, adminExpireReservations, adminExpireGroups } = createAdminOperationsActions({ store, piiEncryptionKey, demoMode, clock, audit, getAdmin, validateMediaReference, pricingTargets });

  async function runMaintenance(payload = {}) {
    const limit = integer(payload.limit, 50);
    const reservations = await expireReservations({ store, now: clock(), limit });
    const groups = await expireGroups({ store, now: clock(), limit });
    await audit(null, 'system.maintenance.tick', 'maintenance', '', { reservations, groups });
    return { reservations, groups };
  }

  const handlers = {
    health: async () => ({
      service: 'mengshixian-api',
      status: 'ok',
      version: 'stage-1',
      serverTime: nowIso(clock),
      capabilities: {
        piiEncryption: Boolean(piiEncryptionKey && String(piiEncryptionKey).length >= 16),
        paymentPrepare: typeof paymentPreparer === 'function',
        paymentNotify: typeof paymentVerifier === 'function',
        refundNotify: typeof refundVerifier === 'function'
        ,demoOrder: demoMode === true
      }
    }),
    'auth.wechatLogin': async (payload) => ({ user: pick(await ensureWechatUser(payload && payload.phoneCode ? String(payload.phoneCode) : ''), ['_id', 'userType', 'status', 'organizationId', 'businessStatus', 'lastLoginAt']) }),
    'auth.me': async (payload) => ({ user: pick(await ensureWechatUser(payload && payload.phoneCode ? String(payload.phoneCode) : ''), ['_id', 'userType', 'status', 'organizationId', 'businessStatus', 'lastLoginAt']) }),
    'auth.applyBusiness': applyBusiness,
    'address.list': userAddresses,
    'address.upsert': userUpsertAddress,
    'address.delete': userDeleteAddress,
    'cart.list': userCart,
    'cart.upsert': userUpsertCartItem,
    'cart.remove': userRemoveCartItem,
    'checkout.quote': checkoutQuote,
    'orders.create': userCreateOrder,
    'orders.list': userOrders,
    'orders.get': userOrder,
    'orders.cancel': userCancelOrder,
    'orders.complete': userCompleteOrder,
    'payments.wechat.notify': wechatPaymentNotify,
    'payments.wechat.prepare': userPreparePayment,
    'refunds.request': userRequestRefund,
    'refunds.notify': refundNotify,
    'catalog.categories': publicCategories,
    'catalog.products': publicProducts,
    'catalog.product': publicProductDetail,
    'catalog.prices': userCatalogPrices,
    'content.banners': (payload) => publicContent('banners', payload),
    'content.homeSections': (payload) => publicContent('home_sections', payload),
    'content.home': async (payload) => ({ banners: await publicContent('banners', { ...payload, page: 1, pageSize: 10 }), sections: await publicContent('home_sections', { ...payload, page: 1, pageSize: 30 }) }),
    'content.media.resolve': publicMediaResolve,
    'delivery.options': publicDeliveryOptions,
    'groups.campaigns': publicGroupCampaigns,
    'groups.quote': groupQuote,
    'groups.create': groupCreate,
    'groups.join': groupJoin,
    'groups.get': groupGet,
    'admin.bootstrap': payload => staffWrites.run(payload,(scoped,log)=>staffAccounts.bootstrap(payload,scoped,log),{bootstrap:true}),
    'admin.login': adminLogin,
    'admin.logout': adminLogout,
    'admin.password.change': payload => staffWrites.run(payload,(scoped,log)=>staffAccounts.changeOwnPassword(payload,scoped,log),{permission:null}),
    'admin.me': async (payload) => { const { admin, permissions } = await getAdmin(payload); return { admin: cleanAdmin(admin, permissions) }; },
    'admin.staff.create': payload => staffWrites.run(payload,scoped=>staffAccounts.create(payload,scoped)),
    'admin.staff.update': payload => staffWrites.run(payload,scoped=>staffAccounts.update(payload,scoped)),
    'admin.staff.resetPassword': payload => staffWrites.run(payload,scoped=>staffAccounts.resetPassword(payload,scoped)),
    'user.media.upload': userUploadBusinessMedia,
'admin.readiness': adminReadiness,
    'admin.roles.list': adminRoles,
    'admin.roles.upsert': retiredStaffWrite,
    'admin.adminUsers.list': adminAdminUsers,
    'admin.adminUsers.upsert': retiredStaffWrite,
    'admin.categories.list': (payload) => adminList('categories', payload, 'catalog.read', { orderBy: [{ field: 'sort', direction: 'asc' }] }),
    'admin.categories.upsert': adminUpsertCategory,
    'admin.products.list': (payload) => adminList('products', payload, 'catalog.read'),
    'admin.products.upsert': adminUpsertProduct,
    'admin.products.setStatus': adminSetProductStatus,
    'admin.products.review': async (payload) => { await getAdmin(payload, 'catalog.read'); return catalogReview.read(string(payload.id, '商品 ID', { required: true, max: 80 })); },
    'admin.orders.receipts.list': offlineReceipts.list,
    'admin.orders.receipts.record': offlineReceipts.record,
    'admin.products.publishReviewed': async (payload) => { const { admin } = await getAdmin(payload, 'catalog.write'); return catalogReview.publish(admin, string(payload.id, '商品 ID', { required: true, max: 80 }), string(payload.reviewToken, '核对凭据', { required: true, max: 128 })); },
    'admin.skus.list': (payload) => adminList('product_skus', payload, 'catalog.read'),
    'admin.skus.upsert': adminUpsertSku,
    'admin.skus.setStatus': adminSetSkuStatus,
    'admin.prices.list': (payload) => adminList('prices', payload, 'pricing.read'),
    'admin.prices.upsert': adminUpsertPrice,
    'admin.pricingTargets.list': async (payload) => { await getAdmin(payload, 'pricing.read'); return pricingTargets.list(payload); },
    'admin.demo.seedCommerce': adminSeedDemoCommerce,
    'admin.groupCampaigns.list': (payload) => adminList('group_campaigns', payload, 'marketing.read', { orderBy: [{ field: 'sort', direction: 'asc' }] }),
    'admin.groupCampaigns.upsert': adminUpsertGroupCampaign,
    'admin.users.list': adminUsers,
    'admin.users.organizations': async (payload) => { await getAdmin(payload, 'users.read'); return pricingTargets.list({ ...payload, scopeType: 'organization' }); },
    'admin.users.setPricingProfile': adminSetUserPricingProfile,
    'admin.businessApplications.list': adminBusinessApplications,
    'admin.businessApplications.review': adminReviewBusinessApplication,
    'admin.warehouses.list': (payload) => adminList('warehouses', payload, 'inventory.read', { orderBy: [{ field: 'sort', direction: 'asc' }] }),
    'admin.warehouses.upsert': adminUpsertWarehouse,
    'admin.inventory.list': (payload) => adminList('inventory', payload, 'inventory.read'),
    'admin.inventory.adjust': adminAdjustInventory,
    'admin.deliveryAreas.list': (payload) => adminList('delivery_areas', payload, 'delivery.read', { orderBy: [{ field: 'sort', direction: 'asc' }] }),
    'admin.deliveryAreas.upsert': adminUpsertDeliveryArea,
    'admin.freightRules.list': (payload) => adminList('freight_rules', payload, 'delivery.read'),
    'admin.freightRules.upsert': adminUpsertFreightRule,
    'admin.deliverySlots.list': (payload) => adminList('delivery_slots', payload, 'delivery.read', { orderBy: [{ field: 'sort', direction: 'asc' }] }),
    'admin.deliverySlots.upsert': adminUpsertDeliverySlot,
    'admin.orders.list': async (payload) => {
      const listed = await adminList('orders', payload, 'orders.read');
      // 后台列表走脱敏投影：履约联系方式密文、幂等键等内部字段不随列表下发
      return { ...listed, rows: listed.rows.map(safeOrder) };
    },
    'admin.orders.fulfillmentContact': adminOrderFulfillmentContact,
    'admin.orders.transition': adminTransitionOrder,
    'admin.refunds.list': (payload) => adminList('refunds', payload, 'refunds.read'),
    'admin.refunds.review': adminReviewRefund,
    'admin.jobs.expireReservations': adminExpireReservations,
    'admin.jobs.expireGroups': adminExpireGroups,
    'admin.imports.list': (payload) => adminList('import_jobs', payload, 'imports.read'),
    'admin.imports.stage': stageImport,
    'admin.imports.preview': previewImport,
    'admin.imports.approve': approveImport,
    'admin.imports.activateBatch': activateImportBatch,
    'admin.media.list': (payload) => adminList('media_assets', payload, 'media.read'),
    'admin.media.upload': adminUploadMedia,
    'admin.media.beginUpload': mediaChunks.begin,
    'admin.media.uploadPart': mediaChunks.uploadPart,
    'admin.media.finishUpload': mediaChunks.finish,
    'admin.media.upsert': adminUpsertMedia,
    'admin.media.createVersion': adminCreateMediaVersion,
    'admin.productMedia.list': adminListProductMedia,
    'admin.productMedia.upsert': adminUpsertProductMedia,
    'admin.productMedia.linkByCode': linkMediaByCode,
    'admin.banners.list': (payload) => adminList('banners', payload, 'content.read', { orderBy: [{ field: 'sort', direction: 'asc' }] }),
    'admin.banners.upsert': (payload) => adminUpsertContent(payload, 'banners', 'content.write', '轮播图'),
    'admin.homeSections.list': (payload) => adminList('home_sections', payload, 'content.read', { orderBy: [{ field: 'sort', direction: 'asc' }] }),
    'admin.homeSections.upsert': (payload) => adminUpsertContent(payload, 'home_sections', 'content.write', '首页模块'),
    'admin.audit.list': (payload) => adminList('audit_logs', payload, 'audit.read')
  };

  async function dispatch(event = {}) {
    try {
      const action = string(event.action, 'action', { required: true, max: 80 });
      const handler = handlers[action];
      if (!handler) return { ok: false, data: null, error: { code: 'NOT_IMPLEMENTED', message: `路由 ${action} 尚未实现。` }, requestId: event.requestId || '' };
      return success(await handler(event.payload || {}), event.requestId);
    }
    catch (error) { return failure(error, event.requestId); }
  }

  return { dispatch, runMaintenance };
}

module.exports = { createApplication };
