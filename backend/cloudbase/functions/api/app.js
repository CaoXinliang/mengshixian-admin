const { fail, success, failure } = require('./lib/response');
const { randomId, sha256, hashPassword, safeEqual, verifyPassword, encryptText, decryptText } = require('./lib/security');
const { inventoryId, inventoryLedgerId } = require('./lib/transaction-ids');
const { ROLE_PERMISSIONS, KNOWN_PERMISSIONS, hasPermission, collectPermissions } = require('./lib/permissions');
const { cents, audienceVisible, buildQuote, acceptedQuoteOverrides, createOrder, findExistingOrder, cancelOrder, expireReservations, expireGroups, confirmWechatPayment, resolveUnitPrice, resolveUnitPrices, normalizeQuantityTiers, orderReservations, consumeReservation, releaseReservation } = require('./lib/commerce');
const { assertTransition } = require('./lib/order-state');
const { active: activeGroupCampaign, createGroup, releaseSlot } = require('./lib/groups');
const { requestRefund, reviewRefund, processRefund, confirmRefund } = require('./lib/refunds');
const { collectPageMatches } = require('./lib/collection-read');
const b2b = require('./lib/b2b');
const { convertCredit, releaseCredit } = require('./lib/b2b-credit');
const marketing = require('./lib/marketing');
const { awardOrderPoints } = require('./lib/points');
const webAuth = require('./lib/web-auth');
const { createAdminOperations } = require('./lib/admin-operations');
const { AsyncLocalStorage } = require('async_hooks');

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const PUBLIC_PRODUCT_FIELDS = ['_id', 'spuCode', 'name', 'subtitle', 'categoryId', 'categoryName', 'brand', 'origin', 'storageType', 'frozenTemperature', 'shelfLifeDays', 'coverMediaId', 'audienceType', 'sort'];
const PUBLIC_SKU_FIELDS = ['_id', 'skuCode', 'productId', 'specName', 'netWeight', 'weightUnit', 'piecesPerCase', 'packageUnit', 'barcode', 'mediaIds', 'minOrderQuantity', 'orderMultiple'];

function nowIso(clock) { return clock().toISOString(); }
function string(value, label, options = {}) {
  const output = String(value === undefined || value === null ? '' : value).trim();
  if (options.required && !output) fail('VALIDATION_ERROR', `${label}不能为空。`);
  if (options.max && output.length > options.max) fail('VALIDATION_ERROR', `${label}长度不能超过 ${options.max} 个字符。`);
  return output;
}
function integer(value, fallback = 0) {
  const output = Number(value);
  return Number.isInteger(output) ? output : fallback;
}
function demoMetadata(payload = {}) {
  const source = ['client', 'ai_generated', 'demo', 'admin_upload'].includes(payload.source) ? payload.source : '';
  return {
    source,
    temporary: payload.temporary === true,
    demoNote: string(payload.demoNote, '演示说明', { max: 300 })
  };
}
function pageParams(payload) {
  const page = Math.max(1, integer(payload.page, 1));
  const pageSize = Math.min(100, Math.max(1, integer(payload.pageSize, 20)));
  return { page, pageSize };
}
function pick(source, fields) {
  return fields.reduce((result, field) => {
    if (source[field] !== undefined) result[field] = source[field];
    return result;
  }, {});
}
function publicProduct(product) { return pick(product, PUBLIC_PRODUCT_FIELDS); }
function publicSku(sku) { return pick(sku, PUBLIC_SKU_FIELDS); }
async function publicProductsWithSkus(store, products) {
  const productIds = new Set(products.map((item) => item._id));
  if (!productIds.size) return [];
  const skus = await collectPageMatches(store, 'product_skus', { where: { status: 'on_sale' }, orderBy: [{ field: 'sort', direction: 'asc' }] }, (item) => productIds.has(item.productId));
  const grouped = new Map();
  skus.forEach((sku) => {
    if (!grouped.has(sku.productId)) grouped.set(sku.productId, []);
    grouped.get(sku.productId).push(publicSku(sku));
  });
  return products.map((product) => ({ ...publicProduct(product), skus: grouped.get(product._id) || [] }));
}
function maskedPhone(phone) {
  const value = String(phone || '').replace(/\s/g, '');
  return value.length >= 7 ? `${value.slice(0, 3)}****${value.slice(-4)}` : '';
}
function safeAddress(address) {
  return pick(address, ['_id', 'name', 'phoneMasked', 'provinceCode', 'cityCode', 'districtCode', 'regionCode', 'detail', 'isDefault', 'tag']);
}
function safeOrder(order) {
  return { fulfillmentType: order.fulfillmentType || 'delivery', ...pick(order, ['_id', 'orderNo', 'warehouseId', 'fulfillmentType', 'pickupSiteSnapshot', 'deliveryAreaId', 'addressSnapshot', 'deliverySlotSnapshot', 'acceptedQuoteSnapshot', 'bundleSnapshot', 'couponSnapshot', 'discountAmountCent', 'pricingSnapshot', 'freightSnapshot', 'totalAmountCent', 'refundedAmountCent', 'paymentMethod', 'paymentStatus', 'refundStatus', 'creditStatus', 'groupId', 'groupCampaignId', 'groupStatus', 'status', 'shipInfo', 'createdAt', 'updatedAt', 'cancelledAt', 'deliveredAt', 'completedAt']) };
}
function safeOrderItem(item) {
  return pick(item, ['_id', 'skuId', 'productId', 'productNameSnapshot', 'specSnapshot', 'packageUnitSnapshot', 'quantity', 'mediaSnapshot']);
}
function safeOrderItemDetail(item) {
  return pick(item, ['_id', 'orderItemId', 'orderId', 'skuId', 'productId', 'productNameSnapshot', 'specSnapshot', 'packageUnitSnapshot', 'quantity', 'unitPriceCent', 'subtotalCent', 'paidSubtotalCent', 'refundableAmountCent', 'priceRuleId', 'quantityTierSnapshot', 'purchaseRuleSnapshot', 'currency', 'mediaSnapshot', 'createdAt']);
}
function safeRefund(refund, admin = false) {
  const output = pick(refund, ['_id', 'refundNo', 'orderId', 'organizationId', 'items', 'amountCent', 'goodsAmountCent', 'includedOrderAdjustmentCent', 'creditAdjustmentCent', 'cashRefundRequiredCent', 'currency', 'reasonCode', 'description', 'reason', 'mediaIds', 'deadlineAt', 'status', 'channelStatus', 'manualRefundRequired', 'statusTimeline', 'reviewNote', 'reviewedAt', 'refundedAt', 'createdAt', 'updatedAt']);
  if (admin) Object.assign(output, pick(refund, ['userId', 'reviewedBy']));
  return output;
}
function safeUser(user) {
  return pick(user, ['_id', 'userType', 'organizationId', 'priceLevel', 'businessStatus', 'status', 'createdAt', 'updatedAt', 'lastLoginAt']);
}
function safeGroup(group) {
  return pick(group, ['_id', 'groupNo', 'campaignId', 'groupSize', 'memberCount', 'reservedMemberCount', 'refundRequired', 'status', 'expiresAt', 'successAt', 'failedAt', 'failureReason', 'createdAt', 'updatedAt']);
}
function webSessionToken(payload = {}) { const primary = String(payload.sessionToken || '').trim(); const legacy = String(payload.webSessionToken || '').trim(); if (primary && legacy && primary !== legacy) fail('AUTH_TOKEN_CONFLICT', '网页会话字段冲突。'); return primary || legacy; }
function isScheduledEnabled(item, now) {
  if (!item || item.enabled === false || item.status === 'disabled' || item.status === 'archived') return false;
  const time = now.getTime();
  if (item.startAt && new Date(item.startAt).getTime() > time) return false;
  return !(item.endAt && new Date(item.endAt).getTime() < time);
}
function cleanAdmin(admin, permissions) {
  return {
    id: admin._id,
    username: admin.username,
    displayName: admin.displayName,
    roleIds: admin.roleIds || [],
    permissions,
    status: admin.status,
    lastLoginAt: admin.lastLoginAt || null
  };
}

function createApplication({ store, getIdentity = () => ({}), bootstrapToken = '', piiEncryptionKey = '', paymentPreparer = null, paymentVerifier = null, refundVerifier = null, mediaUrlResolver = null, storageUploader = null, demoMode = false, clock = () => new Date() }) {
  const requestScope = new AsyncLocalStorage();
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
    const roles = (await store.list('admin_roles', { page: 1, pageSize: 100 })).rows;
    const permissions = collectPermissions(admin, roles);
    if (permission && !hasPermission(permissions, permission)) fail('ADMIN_FORBIDDEN', '当前账号没有此操作权限。');
    return { admin, permissions };
  }

  async function ensureMiniUser() {
    const identity = getIdentity() || {};
    const openid = identity.OPENID || identity.openid || '';
    if (!openid) fail('UNAUTHENTICATED', '未取得微信用户身份。');
    let user = await store.findOne('users', { openid });
    if (!user) {
      if (typeof store.runTransaction !== 'function') fail('TRANSACTION_NOT_AVAILABLE', '当前环境不支持用户建档事务。');
      const timestamp = nowIso(clock);
      const deterministicId = require('./lib/transaction-ids').stableDocumentId('wechat_user', [openid]);
      user = await store.runTransaction(async (tx) => {
        const current = await tx.getById('users', deterministicId);
        if (current) {
          if (current.openid !== openid) fail('USER_ID_CONFLICT', '微信用户稳定 ID 冲突。');
          if (current.status === 'disabled') fail('AUTH_ACCOUNT_DISABLED', '用户已停用。');
          await tx.update('users', deterministicId, { lastLoginAt: timestamp, updatedAt: timestamp });
          return { ...current, lastLoginAt: timestamp, updatedAt: timestamp };
        }
        const created = { _id: deterministicId, openid, userType: 'c', status: 'active', createdAt: timestamp, updatedAt: timestamp, lastLoginAt: timestamp };
        await tx.set('users', deterministicId, created);
        return created;
      });
    } else {
      if (user.status === 'disabled') fail('AUTH_ACCOUNT_DISABLED', '用户已停用。');
      await store.update('users', user._id, { lastLoginAt: nowIso(clock), updatedAt: nowIso(clock) });
      user.lastLoginAt = nowIso(clock);
    }
    return user;
  }

  async function ensureWechatUser() {
    const scoped = requestScope.getStore() || {};
    const sessionToken = webSessionToken(scoped.payload || {});
    if (sessionToken) return (await webAuth.resolveSession({ store, sessionToken, now: clock() })).user;
    return ensureMiniUser();
  }

  async function applyBusiness(payload) {
    const user = await ensureWechatUser();
    if (user.userType === 'b') fail('BUSINESS_APPLICATION_NOT_NEEDED', '当前账号已是商家采购账号，无需重复申请。');
    if (!piiEncryptionKey || String(piiEncryptionKey).length < 16) fail('PII_ENCRYPTION_NOT_CONFIGURED', '企业申请信息加密尚未配置。');
    const companyName = string(payload.companyName, '企业名称', { required: true, max: 120 });
    const unifiedCode = string(payload.unifiedCode, '统一社会信用代码', { required: true, max: 30 }).toUpperCase();
    const contactName = string(payload.contactName, '联系人', { required: true, max: 40 });
    const contactPhone = string(payload.contactPhone, '联系人手机号', { required: true, max: 30 }).replace(/\s/g, '');
    if (!/^1\d{10}$/.test(contactPhone)) fail('VALIDATION_ERROR', '请输入有效的 11 位联系人手机号。');
    const timestamp = nowIso(clock);
    const existing = await store.findOne('business_applications', { userId: user._id, status: 'pending' });
    const patch = { userId: user._id, companyName, unifiedCode, contactName, contactPhoneCiphertext: encryptText(contactPhone, piiEncryptionKey), contactPhoneMasked: maskedPhone(contactPhone), status: 'pending', submittedAt: timestamp, updatedAt: timestamp };
    let application;
    if (existing) {
      await store.update('business_applications', existing._id, patch);
      application = { ...existing, ...patch, _id: existing._id };
    } else application = await store.create('business_applications', { ...patch, createdAt: timestamp });
    await store.update('users', user._id, { businessStatus: 'pending', updatedAt: timestamp });
    return { application: pick(application, ['_id', 'companyName', 'unifiedCode', 'contactName', 'contactPhoneMasked', 'status', 'submittedAt', 'updatedAt']) };
  }

  async function publicCategories(payload) {
    const listed = await store.list('categories', { where: { status: 'enabled' }, orderBy: [{ field: 'sort', direction: 'asc' }], ...pageParams(payload) });
    return { ...listed, rows: listed.rows.map((item) => pick(item, ['_id', 'name', 'parentId', 'imageMediaId', 'sort'])) };
  }

  async function resolveViewerType() {
    const scoped = requestScope.getStore() || {};
    const token = webSessionToken(scoped.payload || {});
    if (token) return (await webAuth.resolveSession({ store, sessionToken: token, now: clock() })).user.userType === 'b' ? 'b' : 'c';
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
      const row = { skuId: item.skuId, amountCent: item.amountCent, currency: item.currency, temporary: item.temporary, source: item.source };
      if (item.quantityTiers && item.quantityTiers.length) row.quantityTiers = item.quantityTiers;
      if (item.minOrderQuantity) row.minOrderQuantity = item.minOrderQuantity;
      if (item.orderMultiple) row.orderMultiple = item.orderMultiple;
      rows.push(row);
    }
    return { rows };
  }

  async function publicContent(collection, payload) {
    const platform = payload.platform === 'web' ? 'web' : 'miniapp';
    const params = pageParams(payload);
    const matched = await collectPageMatches(store, collection, { where: { enabled: true }, orderBy: [{ field: 'sort', direction: 'asc' }] }, (item) => {
      const platforms = Array.isArray(item.targetPlatforms) && item.targetPlatforms.length ? item.targetPlatforms : ['miniapp', 'web'];
      return isScheduledEnabled(item, clock()) && platforms.includes(platform);
    });
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
      const publicReviewEvidence = item.purpose === 'review_evidence' && item.publicApproved === true;
      if ((!item.userId || publicReviewEvidence) && item.purpose !== 'aftersale_evidence' && requested.has(item._id) && platforms.includes(platform) && isScheduledEnabled(item, clock()) && !resolved.has(item._id)) {
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
    const [warehouses, areas, slots, pickupSites] = await Promise.all([
      collectPageMatches(store, 'warehouses', { where: { status: 'active' }, orderBy: [{ field: 'sort', direction: 'asc' }] }, () => true),
      collectPageMatches(store, 'delivery_areas', { where: { status: 'active' }, orderBy: [{ field: 'sort', direction: 'asc' }] }, () => true),
      collectPageMatches(store, 'delivery_slots', { where: { status: 'active' }, orderBy: [{ field: 'sort', direction: 'asc' }] }, () => true),
      collectPageMatches(store, 'pickup_sites', { where: { status: 'active' }, orderBy: [{ field: 'sort', direction: 'asc' }] }, () => true)
    ]);
    const activeWarehouseIds = new Set(warehouses.map((item) => item._id));
    return {
      warehouses: warehouses.map((item) => pick(item, ['_id', 'code', 'name', 'address', 'sort'])),
      areas: areas.map((item) => pick(item, ['_id', 'name', 'regionCodes', 'warehouseIds', 'sort'])),
      slots: slots.map((item) => pick(item, ['_id', 'name', 'deliveryAreaId', 'warehouseId', 'startTime', 'endTime', 'sort'])),
      pickupSites: pickupSites.filter((item) => activeWarehouseIds.has(item.warehouseId)).map((item) => pick(item, ['_id', 'name', 'address', 'regionCode', 'warehouseId', 'openingHours', 'sort']))
    };
  }

  async function webLogin(payload) { const result = await webAuth.login({ store, payload, now: clock() }); await audit(null, 'auth.web.login', 'web_login_account', result.account._id, { userId: result.user._id }); return { sessionToken: result.sessionToken, expiresAt: result.expiresAt, user: safeUser(result.user) }; }
  async function webMe(payload) { const result = await webAuth.resolveSession({ store, sessionToken: webSessionToken(payload), now: clock() }); return { user: safeUser(result.user), account: webAuth.safeAccount(result.account), expiresAt: result.session.expiresAt }; }
  async function webLogout(payload) { const result = await webAuth.logout({ store, sessionToken: webSessionToken(payload), now: clock() }); await audit(null, 'auth.web.logout', 'web_user_session', '', {}); return result; }
  async function webPasswordChange(payload) { const result = await webAuth.changePassword({ store, sessionToken: webSessionToken(payload), payload, now: clock() }); await audit(null, 'auth.web.password_change', 'web_login_account', '', {}); return result; }

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

  async function adminBootstrap(payload) {
    if (!bootstrapToken || !safeEqual(payload.bootstrapToken, bootstrapToken)) fail('BOOTSTRAP_FORBIDDEN', '初始化令牌无效。');
    const existing = await store.list('admin_users', { page: 1, pageSize: 1 });
    if (existing.total) fail('BOOTSTRAP_ALREADY_COMPLETED', '已有管理员账号，禁止重复初始化。');
    const username = string(payload.username, '管理员账号', { required: true, max: 40 });
    const password = string(payload.password, '管理员密码', { required: true, max: 128 });
    if (password.length < 12) fail('VALIDATION_ERROR', '管理员密码至少需要 12 位。');
    const timestamp = nowIso(clock);
    const role = await store.create('admin_roles', { code: 'super_admin', name: '超级管理员', permissions: ROLE_PERMISSIONS.super_admin, status: 'active', createdAt: timestamp, updatedAt: timestamp });
    const secret = hashPassword(password);
    const admin = await store.create('admin_users', { username, displayName: string(payload.displayName || username, '管理员显示名', { max: 40 }), roleIds: [role._id], status: 'active', ...secret, createdAt: timestamp, updatedAt: timestamp });
    await audit(admin, 'admin.bootstrap', 'admin_user', admin._id, { username });
    return { admin: cleanAdmin(admin, ROLE_PERMISSIONS.super_admin) };
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
    await store.create('admin_sessions', { adminId: admin._id, tokenHash: sha256(token), status: 'active', expiresAt: new Date(clock().getTime() + SESSION_TTL_MS).toISOString(), createdAt: timestamp, lastSeenAt: timestamp });
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

  async function adminChangeOwnPassword(payload) {
    const { admin } = await getAdmin(payload);
    const currentPassword = string(payload.currentPassword, '当前密码', { required: true, max: 128 });
    const newPassword = string(payload.newPassword, '新密码', { required: true, max: 128 });
    if (newPassword.length < 12) fail('VALIDATION_ERROR', '新密码至少需要 12 位。');
    if (!verifyPassword(currentPassword, admin)) fail('ADMIN_PASSWORD_INVALID', '当前密码不正确。');
    if (verifyPassword(newPassword, admin)) fail('VALIDATION_ERROR', '新密码不能与当前密码相同。');
    // CloudBase 文档事务只允许 doc() 操作，管理员会话须按 adminId 查询；因此这里采用
    // “先更新密码、再撤销所有会话”的安全顺序。若后续步骤失败，旧密码已失效，不会扩大访问权限。
    const timestamp = nowIso(clock);
    await store.update('admin_users', admin._id, { ...hashPassword(newPassword), passwordChangedAt: timestamp, updatedAt: timestamp });
    const sessions = await store.list('admin_sessions', { where: { adminId: admin._id, status: 'active' }, page: 1, pageSize: 100 });
    await Promise.all(sessions.rows.map((session) => store.update('admin_sessions', session._id, { status: 'revoked', revokedAt: timestamp, revokeReason: 'password_changed' })));
    await audit(admin, 'admin.password.change', 'admin_user', admin._id, {});
    return { passwordChanged: true, reLoginRequired: true };
  }

  async function adminRoles(payload) {
    await getAdmin(payload, 'admin.read');
    return store.list('admin_roles', { orderBy: [{ field: 'createdAt', direction: 'asc' }], ...pageParams(payload) });
  }

  async function adminUpsertRole(payload) {
    const { admin } = await getAdmin(payload, 'admin.write');
    const code = string(payload.code, '角色编码', { required: true, max: 40 });
    if (code === 'super_admin') fail('ADMIN_ROLE_PROTECTED', '超级管理员角色不能在后台创建或修改。');
    const permissions = Array.isArray(payload.permissions) ? [...new Set(payload.permissions.map((item) => string(item, '权限', { required: true, max: 80 })))].slice(0, 100) : [];
    if (!permissions.length) fail('VALIDATION_ERROR', '角色至少需要一个权限。');
    const unknownPermissions = permissions.filter((item) => !KNOWN_PERMISSIONS.includes(item));
    if (unknownPermissions.length) fail('VALIDATION_ERROR', `包含未定义的权限点：${unknownPermissions.join('、')}。`);
    const timestamp = nowIso(clock); const patch = { code, name: string(payload.name, '角色名称', { required: true, max: 60 }), permissions, status: ['active', 'disabled'].includes(payload.status) ? payload.status : 'active', updatedAt: timestamp };
    let role;
    // 保护判断必须基于库中角色现有的 code，防止通过传入新 code 绕过 super_admin 限制后改写其权限。
    if (payload.id) { const id = string(payload.id, '角色 ID', { max: 80 }); const existing = await store.findOne('admin_roles', { _id: id }); if (!existing) fail('ADMIN_ROLE_NOT_FOUND', '角色不存在。'); if (existing.code === 'super_admin') fail('ADMIN_ROLE_PROTECTED', '超级管理员角色不能在后台修改。'); await store.update('admin_roles', id, patch); role = { ...existing, ...patch, _id: id }; }
    else role = await store.create('admin_roles', { ...patch, createdAt: timestamp });
    await audit(admin, 'admin.role.upsert', 'admin_role', role._id, { code: role.code, status: role.status });
    return role;
  }

  async function adminAdminUsers(payload) {
    await getAdmin(payload, 'admin.read');
    const roles = (await store.list('admin_roles', { page: 1, pageSize: 100 })).rows;
    const listed = await store.list('admin_users', { orderBy: [{ field: 'createdAt', direction: 'asc' }], ...pageParams(payload) });
    return { ...listed, rows: listed.rows.map((item) => cleanAdmin(item, collectPermissions(item, roles))) };
  }

  async function adminUpsertAdminUser(payload) {
    const { admin, permissions } = await getAdmin(payload, 'admin.write');
    const roles = (await store.list('admin_roles', { where: { status: 'active' }, page: 1, pageSize: 100 })).rows;
    const roleIds = Array.isArray(payload.roleIds) ? [...new Set(payload.roleIds.map((item) => string(item, '角色 ID', { required: true, max: 80 })))].slice(0, 20) : [];
    if (!roleIds.length || roleIds.some((id) => !roles.some((role) => role._id === id))) fail('VALIDATION_ERROR', '请指定有效的启用角色。');
    const superRole = roles.find((role) => role.code === 'super_admin');
    const assignsSuperAdmin = Boolean(superRole && roleIds.includes(superRole._id));
    if (assignsSuperAdmin && !hasPermission(permissions, '*')) fail('ADMIN_ROLE_PROTECTED', '只有超级管理员可以授予超级管理员角色。');
    // 非超级管理员只能授予自身权限范围内的角色，防止用自建角色绕过通配权限校验完成提权。
    if (!hasPermission(permissions, '*')) {
      const exceeded = roles.filter((role) => roleIds.includes(role._id))
        .flatMap((role) => Array.isArray(role.permissions) ? role.permissions : ROLE_PERMISSIONS[role.code] || [])
        .filter((item) => !hasPermission(permissions, item));
      if (exceeded.length) fail('ADMIN_ROLE_PROTECTED', '不能授予超出自身权限范围的角色。');
    }
    const timestamp = nowIso(clock); const patch = { username: string(payload.username, '管理员账号', { required: true, max: 40 }), displayName: string(payload.displayName, '管理员显示名', { required: true, max: 40 }), roleIds, status: ['active', 'disabled'].includes(payload.status) ? payload.status : 'active', updatedAt: timestamp };
    let target;
    if (payload.id) {
      const id = string(payload.id, '管理员 ID', { max: 80 }); const existing = await store.findOne('admin_users', { _id: id }); if (!existing) fail('ADMIN_USER_NOT_FOUND', '管理员不存在。');
      const usernameOwner = await store.findOne('admin_users', { username: patch.username });
      if (usernameOwner && usernameOwner._id !== id) fail('VALIDATION_ERROR', '管理员账号已存在。');
      if (id === admin._id && patch.status !== 'active') fail('ADMIN_SELF_PROTECT', '不能停用当前登录管理员。');
      if (superRole && existing.roleIds.includes(superRole._id) && !roleIds.includes(superRole._id)) {
        if (!hasPermission(permissions, '*')) fail('ADMIN_ROLE_PROTECTED', '只有超级管理员可以调整超级管理员角色。');
        const activeAdmins = await store.list('admin_users', { where: { status: 'active' }, page: 1, pageSize: 100 });
        if (activeAdmins.rows.filter((item) => item.roleIds.includes(superRole._id)).length <= 1) fail('ADMIN_SELF_PROTECT', '不能移除系统最后一个超级管理员。');
      }
      if (payload.password) { const password = string(payload.password, '管理员密码', { max: 128 }); if (password.length < 12) fail('VALIDATION_ERROR', '管理员密码至少需要 12 位。'); Object.assign(patch, hashPassword(password)); }
      await store.update('admin_users', id, patch); target = { ...existing, ...patch, _id: id };
    } else {
      const password = string(payload.password, '管理员密码', { required: true, max: 128 }); if (password.length < 12) fail('VALIDATION_ERROR', '管理员密码至少需要 12 位。');
      if (await store.findOne('admin_users', { username: patch.username })) fail('VALIDATION_ERROR', '管理员账号已存在。');
      target = await store.create('admin_users', { ...patch, ...hashPassword(password), createdAt: timestamp });
    }
    await audit(admin, 'admin.user.upsert', 'admin_user', target._id, { username: target.username, status: target.status, roleIds });
    return cleanAdmin(target, collectPermissions(target, roles));
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

  async function validateMediaReference(value, label, expectedType = '') {
    const mediaId = string(value, label, { max: 80 });
    if (!mediaId) return '';
    const media = await store.findOne('media_assets', { _id: mediaId });
    if (!media) fail('MEDIA_NOT_FOUND', `${label}不存在。`);
    if (media.enabled === false) fail('MEDIA_NOT_AVAILABLE', `${label}已停用，不能继续引用。`);
    if (expectedType && media.type !== expectedType) fail('MEDIA_TYPE_INVALID', `${label}必须是${expectedType === 'image' ? '图片' : expectedType}素材。`);
    return mediaId;
  }

  async function adminUpsertCategory(payload) {
    const { admin } = await getAdmin(payload, 'catalog.write');
    const timestamp = nowIso(clock);
    const patch = {
      name: string(payload.name, '分类名称', { required: true, max: 30 }),
      parentId: string(payload.parentId, '父分类 ID', { max: 80 }),
      imageMediaId: await validateMediaReference(payload.imageMediaId, '分类图片 ID', 'image'),
      sort: integer(payload.sort, 0),
      status: ['draft', 'enabled', 'disabled'].includes(payload.status) ? payload.status : 'draft',
      updatedAt: timestamp
    };
    let category;
    if (payload.id) {
      const id = string(payload.id, '分类 ID', { max: 80 });
      const existing = await store.findOne('categories', { _id: id });
      if (!existing) fail('CATEGORY_NOT_FOUND', '分类不存在。');
      await store.update('categories', id, patch);
      category = { ...existing, ...patch, _id: id };
    } else {
      category = await store.create('categories', { ...patch, createdAt: timestamp });
    }
    await audit(admin, 'catalog.category.upsert', 'category', category._id, { name: category.name, status: category.status });
    return category;
  }

  async function adminUpsertProduct(payload) {
    const { admin } = await getAdmin(payload, 'catalog.write');
    const timestamp = nowIso(clock);
    const categoryId = string(payload.categoryId, '分类 ID', { required: true, max: 80 });
    const category = await store.findOne('categories', { _id: categoryId });
    if (!category) fail('CATEGORY_NOT_FOUND', '商品分类不存在。');
    const requestedStatus = payload.status === undefined ? '' : string(payload.status, '商品状态', { max: 30 });
    if (requestedStatus && !['draft', 'pending_review', 'on_sale', 'off_sale', 'archived'].includes(requestedStatus)) fail('VALIDATION_ERROR', '商品状态不合法。');
    // 分层可见性：all 双端 / c 仅个人顾客 / b 仅企业采购；更新时未传则保持原值
    const requestedAudience = ['all', 'c', 'b'].includes(payload.audienceType) ? payload.audienceType : '';
    const suppliedProductMetadata = demoMetadata(payload);
    const productMetadata = payload.id ? {} : suppliedProductMetadata;
    if (payload.source !== undefined) productMetadata.source = suppliedProductMetadata.source;
    if (payload.temporary !== undefined) productMetadata.temporary = suppliedProductMetadata.temporary;
    if (payload.demoNote !== undefined) productMetadata.demoNote = suppliedProductMetadata.demoNote;
    const patch = {
      spuCode: string(payload.spuCode, 'SPU 编码', { max: 60 }),
      name: string(payload.name, '商品名称', { required: true, max: 100 }),
      subtitle: string(payload.subtitle, '商品副标题', { max: 160 }),
      categoryId,
      categoryName: category.name,
      brand: string(payload.brand, '品牌', { max: 60 }),
      origin: string(payload.origin, '产地', { max: 80 }),
      storageType: string(payload.storageType || 'frozen', '储存类型', { max: 30 }),
      frozenTemperature: string(payload.frozenTemperature || '-18℃', '储存温度', { max: 30 }),
      shelfLifeDays: integer(payload.shelfLifeDays, 0),
      description: string(payload.description, '商品介绍', { max: 5000 }),
      coverMediaId: await validateMediaReference(payload.coverMediaId, '商品主图 ID', 'image'),
      sort: integer(payload.sort, 0),
      ...productMetadata,
      updatedAt: timestamp
    };
    if (requestedAudience) patch.audienceType = requestedAudience;
    if (requestedStatus) patch.status = requestedStatus;
    let product;
    if (payload.id) {
      const id = string(payload.id, '商品 ID', { max: 80 });
      const existing = await store.findOne('products', { _id: id });
      if (!existing) fail('PRODUCT_NOT_FOUND', '商品不存在。');
      if (requestedStatus === 'on_sale') {
        const effectiveMetadata = { source: productMetadata.source === undefined ? existing.source : productMetadata.source, temporary: productMetadata.temporary === undefined ? existing.temporary : productMetadata.temporary };
        if (effectiveMetadata.temporary || ['ai_generated', 'demo'].includes(effectiveMetadata.source)) fail('TEMPORARY_CANNOT_ACTIVATE', 'AI 或临时商品只能保存为草稿，不能上架。');
        if (category.status !== 'enabled') fail('PRODUCT_NOT_READY', '商品所属分类必须先启用。');
        const skus = await store.list('product_skus', { where: { productId: id, status: 'on_sale' }, page: 1, pageSize: 1 });
        if (!skus.total) fail('PRODUCT_NOT_READY', '至少需要一个已上架 SKU 才能上架商品。');
      }
      await store.update('products', id, patch);
      product = { ...existing, ...patch, _id: id };
    } else {
      if (requestedStatus === 'on_sale') fail('PRODUCT_NOT_READY', '新建商品需要先创建并上架至少一个 SKU。');
      product = await store.create('products', { ...patch, status: requestedStatus || 'draft', createdAt: timestamp });
    }
    await audit(admin, 'catalog.product.upsert', 'product', product._id, { name: product.name, status: product.status });
    return product;
  }

  async function adminUpsertSku(payload) {
    const { admin } = await getAdmin(payload, 'catalog.write');
    const productId = string(payload.productId, '商品 ID', { required: true, max: 80 });
    const product = await store.findOne('products', { _id: productId });
    if (!product) fail('PRODUCT_NOT_FOUND', '商品不存在。');
    const timestamp = nowIso(clock);
    const purchaseRulePatch = {};
    if (payload.minOrderQuantity !== undefined) {
      purchaseRulePatch.minOrderQuantity = Number(payload.minOrderQuantity);
      if (!Number.isInteger(purchaseRulePatch.minOrderQuantity) || purchaseRulePatch.minOrderQuantity < 1 || purchaseRulePatch.minOrderQuantity > 999) fail('VALIDATION_ERROR', 'SKU 起订量必须是 1 到 999 的整数。');
    }
    if (payload.orderMultiple !== undefined) {
      purchaseRulePatch.orderMultiple = Number(payload.orderMultiple);
      if (!Number.isInteger(purchaseRulePatch.orderMultiple) || purchaseRulePatch.orderMultiple < 1 || purchaseRulePatch.orderMultiple > 999) fail('VALIDATION_ERROR', 'SKU 购买倍数必须是 1 到 999 的整数。');
    }
    const suppliedSkuMetadata = demoMetadata(payload);
    const metadata = payload.id ? {} : suppliedSkuMetadata;
    if (payload.source !== undefined) metadata.source = suppliedSkuMetadata.source;
    if (payload.temporary !== undefined) metadata.temporary = suppliedSkuMetadata.temporary;
    if (payload.demoNote !== undefined) metadata.demoNote = suppliedSkuMetadata.demoNote;
    const patch = {
      productId,
      skuCode: string(payload.skuCode, 'SKU 编码', { max: 60 }),
      specName: string(payload.specName, '规格名称', { required: true, max: 100 }),
      netWeight: string(payload.netWeight, '净含量', { max: 40 }),
      weightUnit: string(payload.weightUnit, '重量单位', { max: 20 }),
      piecesPerCase: integer(payload.piecesPerCase, 0),
      packageUnit: string(payload.packageUnit, '包装单位', { max: 100 }),
      barcode: string(payload.barcode, '条码', { max: 60 }),
      mediaIds: Array.isArray(payload.mediaIds) ? payload.mediaIds.slice(0, 12) : [],
      sort: integer(payload.sort, 0),
      status: ['draft', 'on_sale', 'off_sale'].includes(payload.status) ? payload.status : 'draft',
      ...purchaseRulePatch,
      ...metadata,
      updatedAt: timestamp
    };
    let sku;
    if (payload.id) {
      const id = string(payload.id, 'SKU ID', { max: 80 });
      const existing = await store.findOne('product_skus', { _id: id });
      if (!existing) fail('SKU_NOT_FOUND', 'SKU 不存在。');
      if (payload.status === undefined) patch.status = existing.status;
      await store.update('product_skus', id, patch);
      sku = { ...existing, ...patch, _id: id };
    } else {
      sku = await store.create('product_skus', { minOrderQuantity: 1, orderMultiple: 1, ...patch, createdAt: timestamp });
    }
    await audit(admin, 'catalog.sku.upsert', 'product_sku', sku._id, { productId, specName: sku.specName, status: sku.status });
    return sku;
  }

  async function adminSetProductStatus(payload) {
    const { admin } = await getAdmin(payload, 'catalog.write');
    const id = string(payload.id, '商品 ID', { required: true, max: 80 });
    const status = string(payload.status, '商品状态', { required: true, max: 30 });
    if (!['draft', 'pending_review', 'on_sale', 'off_sale', 'archived'].includes(status)) fail('VALIDATION_ERROR', '商品状态不合法。');
    const product = await store.findOne('products', { _id: id });
    if (!product) fail('PRODUCT_NOT_FOUND', '商品不存在。');
    if (status === 'on_sale') {
      if (product.temporary === true || ['ai_generated', 'demo'].includes(product.source)) fail('TEMPORARY_CANNOT_ACTIVATE', 'AI 或临时商品不能上架。');
      const category = await store.findOne('categories', { _id: product.categoryId, status: 'enabled' });
      if (!category) fail('PRODUCT_NOT_READY', '商品所属分类必须先启用。');
      const skus = await store.list('product_skus', { where: { productId: id, status: 'on_sale' }, page: 1, pageSize: 1 });
      if (!skus.total) fail('PRODUCT_NOT_READY', '至少需要一个已上架 SKU 才能上架商品。');
    }
    await store.update('products', id, { status, updatedAt: nowIso(clock) });
    await audit(admin, 'catalog.product.status', 'product', id, { from: product.status, to: status });
    return { id, status };
  }

  async function adminSetSkuStatus(payload) {
    const { admin } = await getAdmin(payload, 'catalog.write');
    const id = string(payload.id, 'SKU ID', { required: true, max: 80 });
    const status = string(payload.status, 'SKU 状态', { required: true, max: 30 });
    if (!['draft', 'on_sale', 'off_sale'].includes(status)) fail('VALIDATION_ERROR', 'SKU 状态不合法。');
    const sku = await store.findOne('product_skus', { _id: id });
    if (!sku) fail('SKU_NOT_FOUND', 'SKU 不存在。');
    if (status === 'on_sale' && (sku.temporary === true || ['ai_generated', 'demo'].includes(sku.source))) fail('TEMPORARY_CANNOT_ACTIVATE', 'AI 或临时 SKU 不能上架。');
    await store.update('product_skus', id, { status, updatedAt: nowIso(clock) });
    await audit(admin, 'catalog.sku.status', 'product_sku', id, { from: sku.status, to: status, productId: sku.productId });
    return { id, status, productId: sku.productId };
  }

  async function adminUpsertContent(payload, collection, permission, label) {
    const { admin } = await getAdmin(payload, permission);
    const timestamp = nowIso(clock);
    const contentKey = string(payload.contentKey, `${label}业务键`, { max: 100 });
    const jumpType = string(payload.jumpType || 'none', '跳转类型', { max: 30 });
    if (!['none', 'product', 'category', 'url'].includes(jumpType)) fail('JUMP_TYPE_INVALID', '跳转类型只支持 none、product、category、url。');
    const jumpTarget = string(payload.jumpTarget, '跳转目标', { max: 200 });
    if (jumpType !== 'none' && !jumpTarget) fail('JUMP_TARGET_REQUIRED', `${label}跳转目标不能为空。`);
    const targetPlatforms = Array.isArray(payload.targetPlatforms) ? [...new Set(payload.targetPlatforms.map((item) => string(item, '适用端', { required: true, max: 20 })))].slice(0, 8) : ['miniapp', 'web'];
    if (!targetPlatforms.length || targetPlatforms.some((item) => !['miniapp', 'web'].includes(item))) fail('VALIDATION_ERROR', '内容适用端只支持 miniapp、web，且至少选择一个。');
    const startAt = string(payload.startAt, '开始时间', { max: 40 });
    const endAt = string(payload.endAt, '结束时间', { max: 40 });
    if (startAt && Number.isNaN(new Date(startAt).getTime())) fail('VALIDATION_ERROR', '内容开始时间不合法。');
    if (endAt && Number.isNaN(new Date(endAt).getTime())) fail('VALIDATION_ERROR', '内容结束时间不合法。');
    if (startAt && endAt && new Date(startAt).getTime() > new Date(endAt).getTime()) fail('VALIDATION_ERROR', '内容结束时间不能早于开始时间。');
    const suppliedContentMetadata = demoMetadata(payload);
    const contentMetadata = payload.id ? {} : suppliedContentMetadata;
    if (payload.source !== undefined) contentMetadata.source = suppliedContentMetadata.source;
    if (payload.temporary !== undefined) contentMetadata.temporary = suppliedContentMetadata.temporary;
    if (payload.demoNote !== undefined) contentMetadata.demoNote = suppliedContentMetadata.demoNote;
    const patch = {
      contentKey,
      title: string(payload.title, `${label}标题`, { required: true, max: 100 }),
      subtitle: string(payload.subtitle, `${label}副标题`, { max: 100 }),
      linkText: string(payload.linkText, `${label}链接文字`, { max: 30 }),
      moduleType: collection === 'home_sections' ? string(payload.moduleType || 'news', `${label}模块类型`, { max: 20 }) : '',
      mediaAssetId: await validateMediaReference(payload.mediaAssetId, `${label}素材 ID`),
      jumpType,
      jumpTarget,
      sort: integer(payload.sort, 0),
      enabled: payload.enabled !== false,
      startAt,
      endAt,
      targetPlatforms,
      ...contentMetadata,
      updatedAt: timestamp
    };
    if (!payload.id && (contentMetadata.temporary || ['ai_generated', 'demo'].includes(contentMetadata.source))) {
      if (payload.enabled === true) fail('TEMPORARY_CANNOT_ACTIVATE', 'AI 或临时内容只能保存为停用草稿。');
      patch.enabled = false;
    }
    let item;
    if (payload.id) {
      const id = string(payload.id, `${label} ID`, { max: 80 });
      const existing = await store.findOne(collection, { _id: id });
      if (!existing) fail('CONTENT_NOT_FOUND', `${label}不存在。`);
      if (payload.enabled === undefined) patch.enabled = existing.enabled !== false;
      if (payload.source === undefined) patch.source = existing.source || '';
      if (payload.temporary === undefined) patch.temporary = existing.temporary === true;
      if (payload.demoNote === undefined) patch.demoNote = existing.demoNote || '';
      if (patch.enabled && (patch.temporary || ['ai_generated', 'demo'].includes(patch.source))) fail('TEMPORARY_CANNOT_ACTIVATE', 'AI 或临时内容只能保存为停用草稿。');
      if (!contentKey) patch.contentKey = existing.contentKey || '';
      if (contentKey && contentKey !== existing.contentKey) {
        const duplicated = await store.findOne(collection, { contentKey });
        if (duplicated && duplicated._id !== id) fail('CONTENT_KEY_CONFLICT', `${label}业务键已存在，请编辑原记录。`);
      }
      await store.update(collection, id, patch);
      item = { ...existing, ...patch, _id: id };
    } else {
      if (contentKey && await store.findOne(collection, { contentKey })) fail('CONTENT_KEY_CONFLICT', `${label}业务键已存在，请编辑原记录。`);
      item = await store.create(collection, { ...patch, createdAt: timestamp, version: 1 });
    }
    await audit(admin, `${collection}.upsert`, collection, item._id, { title: item.title, enabled: item.enabled });
    return item;
  }

  function mediaPatch(payload, timestamp) {
    const targetPlatforms = Array.isArray(payload.targetPlatforms) ? [...new Set(payload.targetPlatforms.map((item) => string(item, '适用端', { required: true, max: 20 })))].slice(0, 8) : ['miniapp', 'web'];
    if (!targetPlatforms.length || targetPlatforms.some((item) => !['miniapp', 'web'].includes(item))) fail('VALIDATION_ERROR', '素材适用端只支持 miniapp、web，且至少选择一个。');
    const startAt = string(payload.startAt, '素材开始时间', { max: 40 });
    const endAt = string(payload.endAt, '素材结束时间', { max: 40 });
    if (startAt && Number.isNaN(new Date(startAt).getTime())) fail('VALIDATION_ERROR', '素材开始时间不合法。');
    if (endAt && Number.isNaN(new Date(endAt).getTime())) fail('VALIDATION_ERROR', '素材结束时间不合法。');
    if (startAt && endAt && new Date(startAt).getTime() > new Date(endAt).getTime()) fail('VALIDATION_ERROR', '素材结束时间不能早于开始时间。');
    return {
      name: string(payload.name, '素材名称', { required: true, max: 100 }),
      assetKey: string(payload.assetKey, '素材业务键', { max: 100 }),
      type: ['image', 'video'].includes(payload.type) ? payload.type : 'image',
      fileId: string(payload.fileId, '云存储文件 ID', { required: true, max: 300 }),
      thumbnailFileId: string(payload.thumbnailFileId, '缩略图文件 ID', { max: 300 }),
      coverFileId: string(payload.coverFileId, '视频封面文件 ID', { max: 300 }),
      source: ['client', 'ai_generated', 'demo', 'admin_upload'].includes(payload.source) ? payload.source : 'admin_upload',
      temporary: payload.temporary === true,
      checksum: string(payload.checksum, '素材校验值', { max: 128 }),
      mimeType: string(payload.mimeType, '素材类型', { max: 80 }),
      sizeBytes: integer(payload.sizeBytes, 0),
      enabled: payload.enabled !== false,
      startAt,
      endAt,
      targetPlatforms,
      updatedAt: timestamp
    };
  }

  async function adminUpsertMedia(payload) {
    const { admin } = await getAdmin(payload, 'media.write');
    const timestamp = nowIso(clock);
    const patch = mediaPatch(payload, timestamp);
    if (!payload.id && (patch.temporary || ['ai_generated', 'demo'].includes(patch.source))) {
      if (payload.enabled === true) fail('TEMPORARY_CANNOT_ACTIVATE', 'AI 或临时素材不能直接启用。');
      patch.enabled = false;
    }
    let asset;
    if (payload.id) {
      const id = string(payload.id, '素材 ID', { max: 80 });
      const existing = await store.findOne('media_assets', { _id: id });
      if (!existing) fail('MEDIA_NOT_FOUND', '素材不存在。');
      if (payload.enabled === undefined) patch.enabled = existing.enabled !== false;
      if (payload.source === undefined) patch.source = existing.source || 'admin_upload';
      if (payload.temporary === undefined) patch.temporary = existing.temporary === true;
      if (existing.fileId !== patch.fileId) fail('MEDIA_VERSION_REQUIRED', '素材文件不可覆盖，请使用“新建版本”保留历史素材。');
      if (patch.enabled && (patch.temporary || ['ai_generated', 'demo'].includes(patch.source))) fail('TEMPORARY_CANNOT_ACTIVATE', 'AI 或临时素材不能直接启用。');
      await store.update('media_assets', id, patch);
      asset = { ...existing, ...patch, _id: id, version: integer(existing.version, 1) };
    } else {
      asset = await store.create('media_assets', { ...patch, version: 1, createdBy: admin._id, createdAt: timestamp });
    }
    await audit(admin, 'media.upsert', 'media_asset', asset._id, { name: asset.name, temporary: asset.temporary, source: asset.source });
    return asset;
  }

  async function adminCreateMediaVersion(payload) {
    const { admin } = await getAdmin(payload, 'media.write');
    const replacesMediaAssetId = string(payload.replacesMediaAssetId, '被替换素材 ID', { required: true, max: 80 });
    const existing = await store.findOne('media_assets', { _id: replacesMediaAssetId });
    if (!existing) fail('MEDIA_NOT_FOUND', '被替换素材不存在。');
    const timestamp = nowIso(clock);
    const patch = mediaPatch(payload, timestamp);
    if (patch.temporary || ['ai_generated', 'demo'].includes(patch.source)) {
      if (payload.enabled === true) fail('TEMPORARY_CANNOT_ACTIVATE', 'AI 或临时素材不能直接启用。');
      patch.enabled = false;
    }
    if (existing.fileId === patch.fileId) fail('MEDIA_VERSION_SAME_FILE', '新版本必须使用不同的云存储文件。');
    const asset = await store.create('media_assets', {
      ...patch,
      version: integer(existing.version, 1) + 1,
      previousMediaAssetId: existing._id,
      createdBy: admin._id,
      createdAt: timestamp
    });
    await audit(admin, 'media.create_version', 'media_asset', asset._id, { previousMediaAssetId: existing._id, name: asset.name, temporary: asset.temporary, source: asset.source });
    return asset;
  }

  async function adminListProductMedia(payload) {
    await getAdmin(payload, 'catalog.read');
    const productId = string(payload.productId, '商品 ID', { max: 80 });
    const where = productId ? { productId } : {};
    return store.list('product_media', {
      where,
      orderBy: [{ field: 'sort', direction: 'asc' }, { field: 'updatedAt', direction: 'desc' }],
      ...pageParams(payload)
    });
  }

  async function adminUpsertProductMedia(payload) {
    const { admin } = await getAdmin(payload, 'catalog.write');
    const productId = string(payload.productId, '商品 ID', { required: true, max: 80 });
    const product = await store.findOne('products', { _id: productId });
    if (!product) fail('PRODUCT_NOT_FOUND', '关联商品不存在。');
    const skuId = string(payload.skuId, 'SKU ID', { max: 80 });
    if (skuId) {
      const sku = await store.findOne('product_skus', { _id: skuId });
      if (!sku) fail('SKU_NOT_FOUND', '关联 SKU 不存在。');
      if (sku.productId !== productId) fail('SKU_PRODUCT_MISMATCH', 'SKU 不属于当前商品。');
    }
    const mediaType = ['image', 'video'].includes(payload.mediaType) ? payload.mediaType : '';
    if (!mediaType) fail('VALIDATION_ERROR', '商品媒体类型必须是 image 或 video。');
    const mediaAssetId = await validateMediaReference(payload.mediaAssetId, '商品媒体素材 ID', mediaType);
    const role = ['cover', 'detail', 'video_cover', 'instruction'].includes(payload.role) ? payload.role : 'detail';
    const timestamp = nowIso(clock);
    const patch = {
      productId,
      skuId,
      mediaAssetId,
      mediaType,
      role,
      sort: integer(payload.sort, 0),
      enabled: payload.enabled !== false,
      updatedAt: timestamp
    };
    let association;
    if (payload.id) {
      const id = string(payload.id, '商品媒体关联 ID', { max: 80 });
      const existing = await store.findOne('product_media', { _id: id });
      if (!existing) fail('PRODUCT_MEDIA_NOT_FOUND', '商品媒体关联不存在。');
      await store.update('product_media', id, patch);
      association = { ...existing, ...patch, _id: id };
    } else {
      const existing = await store.findOne('product_media', { productId, skuId, mediaAssetId, mediaType, role });
      if (existing) {
        await store.update('product_media', existing._id, patch);
        association = { ...existing, ...patch, _id: existing._id };
      } else {
        association = await store.create('product_media', { ...patch, createdBy: admin._id, createdAt: timestamp });
      }
    }
    await audit(admin, 'catalog.product_media.upsert', 'product_media', association._id, { productId, skuId, mediaAssetId, mediaType, role, enabled: association.enabled });
    return association;
  }

  async function adminUploadMedia(payload) {
    const { admin } = await getAdmin(payload, 'media.write');
    if (typeof storageUploader !== 'function') fail('MEDIA_UPLOAD_UNAVAILABLE', '后台上传服务尚未配置。');
    const type = ['image', 'video'].includes(payload.type) ? payload.type : 'image';
    const mimeType = string(payload.mimeType, '素材类型', { required: true, max: 80 }).toLowerCase();
    const allowedMimeTypes = type === 'image'
      ? ['image/jpeg', 'image/png', 'image/webp']
      : ['video/mp4', 'video/webm', 'video/quicktime'];
    if (!allowedMimeTypes.includes(mimeType)) fail('MEDIA_MIME_INVALID', '素材格式不受支持。');
    const fileName = string(payload.fileName, '文件名', { required: true, max: 160 });
    const contentBase64 = string(payload.contentBase64, '文件内容', { required: true, max: 7000000 }).replace(/^data:[^;]+;base64,/, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(contentBase64)) fail('MEDIA_CONTENT_INVALID', '文件内容不是有效的 Base64。');
    // 大小以解码后的真实字节数为准，不信任客户端声明的 sizeBytes
    const sizeBytes = Buffer.byteLength(contentBase64, 'base64');
    const declaredSizeBytes = integer(payload.sizeBytes, 0);
    if (declaredSizeBytes && Math.abs(declaredSizeBytes - sizeBytes) > 1024) fail('MEDIA_SIZE_INVALID', '声明的文件大小与实际内容不一致。');
    if (!sizeBytes || sizeBytes > 4 * 1024 * 1024) fail('MEDIA_SIZE_INVALID', '后台直传素材不能超过 4 MB；较大视频请先在 CloudBase 控制台上传后登记文件 ID。');
    const extension = ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov' })[mimeType];
    const safeBaseName = fileName.replace(/[^0-9A-Za-z_\-.\u4e00-\u9fff]/g, '_').replace(/\.[^.]+$/, '') || 'media';
    const cloudPath = `mengshixian/media/uploads/${new Date(nowIso(clock)).toISOString().slice(0, 10)}/${randomId()}-${safeBaseName}${extension}`;
    const fileId = await storageUploader({ cloudPath, contentBase64, mimeType, sizeBytes });
    if (!fileId) fail('MEDIA_UPLOAD_FAILED', '素材上传未返回文件 ID。');
    await audit(admin, 'media.upload', 'media_asset_file', fileId, { type, mimeType, sizeBytes, cloudPath });
    return { fileId, cloudPath, mimeType, sizeBytes };
  }

  async function stageImport(payload) {
    const { admin } = await getAdmin(payload, 'imports.write');
    if (!Array.isArray(payload.rows) || !payload.rows.length || payload.rows.length > 50) fail('VALIDATION_ERROR', '每次导入草稿必须包含 1 到 50 条记录。');
    const timestamp = nowIso(clock);
    const staged = [];
    for (const row of payload.rows) {
      const sourceId = string(row && row.source && row.source.id, '来源商品 ID', { required: true, max: 80 });
      const sourceKey = `${string(payload.sourceFile || 'manual-stage', '来源文件', { max: 120 })}:${sourceId}`;
      const existing = await store.findOne('import_jobs', { sourceKey });
      if (existing) { staged.push({ id: existing._id, sourceKey, status: 'already_staged' }); continue; }
      const parsed = row.parsed || {};
      const job = await store.create('import_jobs', {
        sourceKey,
        sourceFile: string(payload.sourceFile || 'manual-stage', '来源文件', { max: 120 }),
        sourceRowNo: integer(row.sourceRowNo, 0),
        rawPayload: row.source || {},
        parsedPayload: {
          name: string(parsed.name || row.source.name, '商品名称', { required: true, max: 100 }),
          categoryName: string(parsed.categoryName || row.source.category, '商品分类', { required: true, max: 30 }),
          specName: string(parsed.specName, '商品规格', { max: 100 }),
          packageUnit: string(parsed.packageUnit || row.source.unit, '包装单位', { max: 100 }),
          price: null,
          mediaIds: [],
          ...demoMetadata(parsed)
        },
        mappingWarnings: Array.isArray(row.mappingWarnings) ? row.mappingWarnings.slice(0, 20) : [],
        status: 'staged',
        createdBy: admin._id,
        createdAt: timestamp,
        updatedAt: timestamp
      });
      staged.push({ id: job._id, sourceKey, status: job.status });
    }
    await audit(admin, 'imports.stage', 'import_job', '', { count: staged.length, sourceFile: payload.sourceFile || 'manual-stage' });
    return { staged };
  }

  async function approveImportRecord(admin, id) {
    const job = await store.findOne('import_jobs', { _id: id });
    if (!job) fail('IMPORT_NOT_FOUND', '导入草稿不存在。');
    if (job.status === 'imported') return { importId: id, productId: job.productId, skuId: job.skuId, alreadyImported: true };
    if (!['staged', 'reviewing', 'approved'].includes(job.status)) fail('IMPORT_NOT_APPROVABLE', '当前导入草稿不能审核入库。');
    const timestamp = nowIso(clock);
    const source = job.parsedPayload || {};
    let category = await store.findOne('categories', { name: source.categoryName });
    if (!category) category = await store.create('categories', { name: source.categoryName, parentId: '', sort: 0, status: 'draft', createdAt: timestamp, updatedAt: timestamp });
    const product = await store.create('products', {
      spuCode: '', name: source.name, subtitle: '', categoryId: category._id, categoryName: category.name,
      brand: '', origin: '', storageType: 'frozen', frozenTemperature: '-18℃', shelfLifeDays: 0,
      description: '', coverMediaId: '', sort: 0, status: 'draft', sourceImportId: id,
      ...demoMetadata(source), createdAt: timestamp, updatedAt: timestamp
    });
    const sku = await store.create('product_skus', {
      productId: product._id, skuCode: '', specName: source.specName || source.packageUnit, netWeight: '', weightUnit: '', piecesPerCase: 0,
      packageUnit: source.packageUnit, barcode: '', mediaIds: [], minOrderQuantity: 1, orderMultiple: 1, sort: 0, status: 'draft', sourceImportId: id,
      ...demoMetadata(source), createdAt: timestamp, updatedAt: timestamp
    });
    await store.update('import_jobs', id, { status: 'imported', productId: product._id, skuId: sku._id, reviewedBy: admin._id, reviewedAt: timestamp, updatedAt: timestamp });
    await audit(admin, 'imports.approve', 'import_job', id, { productId: product._id, skuId: sku._id, categoryId: category._id });
    return { importId: id, productId: product._id, skuId: sku._id, alreadyImported: false };
  }

  async function approveImport(payload) {
    const { admin } = await getAdmin(payload, 'imports.write');
    const id = string(payload.id, '导入草稿 ID', { required: true, max: 80 });
    return approveImportRecord(admin, id);
  }

  async function activateImportBatch(payload) {
    const { admin, permissions } = await getAdmin(payload, 'imports.write');
    if (!hasPermission(permissions, 'catalog.write')) fail('ADMIN_FORBIDDEN', '当前账号没有商品上架权限。');
    if (!Array.isArray(payload.ids) || !payload.ids.length || payload.ids.length > 10) fail('VALIDATION_ERROR', '每批必须包含 1 到 10 条导入草稿。');
    const ids = [...new Set(payload.ids.map((id) => string(id, '导入草稿 ID', { required: true, max: 80 })))];
    const activated = [];
    const failed = [];
    for (const id of ids) {
      try {
        const approved = await approveImportRecord(admin, id);
        const product = await store.findOne('products', { _id: approved.productId });
        const sku = await store.findOne('product_skus', { _id: approved.skuId });
        if (!product || !sku) fail('IMPORT_PRODUCT_INCOMPLETE', '导入草稿关联的商品或 SKU 不完整。');
        const category = await store.findOne('categories', { _id: product.categoryId });
        if (!category) fail('CATEGORY_NOT_FOUND', '导入商品所属分类不存在。');
        const timestamp = nowIso(clock);
        if (category.status !== 'enabled') await store.update('categories', category._id, { status: 'enabled', updatedAt: timestamp });
        if (sku.status !== 'on_sale') await store.update('product_skus', sku._id, { status: 'on_sale', updatedAt: timestamp });
        if (product.status !== 'on_sale') await store.update('products', product._id, { status: 'on_sale', updatedAt: timestamp });
        activated.push({ importId: id, categoryId: category._id, productId: product._id, skuId: sku._id });
      } catch (error) {
        failed.push({ importId: id, code: error.code || 'ACTIVATION_FAILED', message: error.message || '启用失败。' });
      }
    }
    await audit(admin, 'imports.activate_batch', 'import_job', '', { requested: ids.length, activated: activated.length, failed: failed.length });
    return { activated, failed };
  }

  async function userAddresses(payload) {
    const user = await ensureWechatUser();
    const listed = await store.list('addresses', { where: { userId: user._id, status: 'active' }, orderBy: [{ field: 'isDefault', direction: 'desc' }, { field: 'updatedAt', direction: 'desc' }], ...pageParams(payload) });
    return { ...listed, rows: listed.rows.map(safeAddress) };
  }

  async function userUpsertAddress(payload) {
    const user = await ensureWechatUser();
    if (!piiEncryptionKey || String(piiEncryptionKey).length < 16) fail('PII_ENCRYPTION_NOT_CONFIGURED', '收货信息加密尚未配置，暂不能保存地址。');
    const timestamp = nowIso(clock);
    const phone = string(payload.phone, '收货手机号', { required: true, max: 30 }).replace(/\s/g, '');
    if (!/^1\d{10}$/.test(phone)) fail('VALIDATION_ERROR', '请输入有效的 11 位收货手机号。');
    const patch = {
      userId: user._id,
      name: string(payload.name, '收货人', { required: true, max: 40 }),
      phoneCiphertext: encryptText(phone, piiEncryptionKey),
      phoneMasked: maskedPhone(phone),
      provinceCode: string(payload.provinceCode, '省份编码', { max: 30 }),
      cityCode: string(payload.cityCode, '城市编码', { max: 30 }),
      districtCode: string(payload.districtCode, '区县编码', { max: 30 }),
      regionCode: string(payload.regionCode, '配送区域编码', { required: true, max: 80 }),
      detail: string(payload.detail, '详细地址', { required: true, max: 200 }),
      tag: string(payload.tag, '地址标签', { max: 20 }),
      isDefault: false,
      status: 'active',
      updatedAt: timestamp
    };
    let existingAddress = null;
    if (payload.id) {
      const id = string(payload.id, '收货地址 ID', { max: 80 });
      existingAddress = await store.findOne('addresses', { _id: id, userId: user._id, status: 'active' });
      if (!existingAddress) fail('ADDRESS_NOT_FOUND', '收货地址不存在。');
    }
    let address;
    if (payload.id) {
      const id = string(payload.id, '收货地址 ID', { max: 80 });
      await store.update('addresses', id, patch);
      address = { ...existingAddress, ...patch, _id: id };
    } else {
      // 新增地址数量上限，防止无成本刷写垃圾数据
      const activeAddresses = await store.list('addresses', { where: { userId: user._id, status: 'active' }, page: 1, pageSize: 100 });
      if (activeAddresses.total >= 20) fail('VALIDATION_ERROR', '收货地址最多保存 20 条，请先删除不需要的地址。');
      address = await store.create('addresses', { ...patch, createdAt: timestamp });
    }
    if (payload.isDefault === true) address = await setDefaultAddressForUser(user, address._id);
    return { address: safeAddress(address) };
  }

  async function setDefaultAddressForUser(user, addressId) {
    if (typeof store.runTransaction !== 'function') fail('TRANSACTION_NOT_AVAILABLE', '当前环境不支持默认地址事务。');
    const id = string(addressId, '收货地址 ID', { required: true, max: 80 });
    const target = await store.findOne('addresses', { _id: id, userId: user._id, status: 'active' });
    if (!target) fail('ADDRESS_NOT_FOUND', '收货地址不存在。');
    const defaults = await collectPageMatches(store, 'addresses', { where: { userId: user._id, status: 'active', isDefault: true } }, () => true);
    const pointerId = `address_default_${sha256(user._id).slice(0, 40)}`;
    const timestamp = nowIso(clock);
    return store.runTransaction(async (tx) => {
      const currentTarget = await tx.getById('addresses', id);
      if (!currentTarget || currentTarget.userId !== user._id || currentTarget.status !== 'active') fail('ADDRESS_NOT_FOUND', '收货地址不存在。');
      const pointer = await tx.getById('address_default_pointers', pointerId);
      const idsToUnset = [...new Set([...defaults.map((item) => item._id), pointer && pointer.addressId].filter((item) => item && item !== id))];
      for (const otherId of idsToUnset) {
        const other = await tx.getById('addresses', otherId);
        if (other && other.userId === user._id && other.status === 'active' && other.isDefault === true) await tx.update('addresses', otherId, { isDefault: false, updatedAt: timestamp });
      }
      await tx.update('addresses', id, { isDefault: true, updatedAt: timestamp });
      await tx.set('address_default_pointers', pointerId, { userId: user._id, addressId: id, updatedAt: timestamp, createdAt: pointer && pointer.createdAt || timestamp });
      return { ...currentTarget, isDefault: true, updatedAt: timestamp };
    });
  }

  async function userSetDefaultAddress(payload) {
    const user = await ensureWechatUser();
    const address = await setDefaultAddressForUser(user, payload.id);
    return { address: safeAddress(address) };
  }

  async function userDeleteAddress(payload) {
    const user = await ensureWechatUser();
    const id = string(payload.id, '收货地址 ID', { required: true, max: 80 });
    const existing = await store.findOne('addresses', { _id: id, userId: user._id, status: 'active' });
    if (!existing) fail('ADDRESS_NOT_FOUND', '收货地址不存在。');
    if (typeof store.runTransaction !== 'function') fail('TRANSACTION_NOT_AVAILABLE', '当前环境不支持地址事务。');
    const candidates = (await collectPageMatches(store, 'addresses', { where: { userId: user._id, status: 'active' }, orderBy: [{ field: 'createdAt', direction: 'asc' }] }, (item) => item._id !== id))
      .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')) || String(left._id).localeCompare(String(right._id)));
    const pointerId = `address_default_${sha256(user._id).slice(0, 40)}`;
    return store.runTransaction(async (tx) => {
      const current = await tx.getById('addresses', id);
      if (!current || current.userId !== user._id || current.status !== 'active') fail('ADDRESS_NOT_FOUND', '收货地址不存在。');
      const pointer = await tx.getById('address_default_pointers', pointerId);
      const timestamp = nowIso(clock);
      await tx.update('addresses', id, { status: 'deleted', isDefault: false, deletedAt: timestamp, updatedAt: timestamp });
      const candidateIds = [...new Set([pointer && pointer.addressId, ...candidates.map((candidate) => candidate._id)].filter((candidateId) => candidateId && candidateId !== id))];
      const freshCandidates = [];
      for (const candidateId of candidateIds) {
        const fresh = await tx.getById('addresses', candidateId);
        if (fresh && fresh.userId === user._id && fresh.status === 'active') freshCandidates.push(fresh);
      }
      freshCandidates.sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')) || String(left._id).localeCompare(String(right._id)));
      const nextDefault = freshCandidates[0] || null;
      for (const fresh of freshCandidates) {
        if (fresh.isDefault !== (nextDefault && fresh._id === nextDefault._id)) await tx.update('addresses', fresh._id, { isDefault: Boolean(nextDefault && fresh._id === nextDefault._id), updatedAt: timestamp });
      }
      if (nextDefault) await tx.set('address_default_pointers', pointerId, { userId: user._id, addressId: nextDefault._id, updatedAt: timestamp, createdAt: pointer && pointer.createdAt || timestamp });
      else if (pointer) await tx.remove('address_default_pointers', pointerId);
      return { id, deleted: true, defaultAddress: nextDefault ? safeAddress({ ...nextDefault, isDefault: true, updatedAt: timestamp }) : null };
    });
  }

  async function userCart(payload) {
    const user = await ensureWechatUser();
    const listed = await store.list('cart_items', { where: { userId: user._id }, orderBy: [{ field: 'updatedAt', direction: 'desc' }], ...pageParams(payload) });
    const rows = [];
    for (const item of listed.rows) {
      const sku = await store.findOne('product_skus', { _id: item.skuId, status: 'on_sale' });
      const product = sku ? await store.findOne('products', { _id: sku.productId, status: 'on_sale' }) : null;
      const visibleProduct = product && audienceVisible(product.audienceType, user) ? product : null;
      rows.push({ _id: item._id, skuId: item.skuId, quantity: item.quantity, selected: item.selected !== false, sku: visibleProduct ? publicSku(sku) : null, product: visibleProduct ? publicProduct(visibleProduct) : null, unavailable: !sku || !visibleProduct });
    }
    return { ...listed, rows };
  }

  async function userUpsertCartItem(payload) {
    const user = await ensureWechatUser();
    const skuId = string(payload.skuId, 'SKU ID', { required: true, max: 80 });
    const quantity = integer(payload.quantity, 0);
    if (quantity < 1 || quantity > 999) fail('VALIDATION_ERROR', '购物车数量必须在 1 到 999 之间。');
    const sku = await store.findOne('product_skus', { _id: skuId, status: 'on_sale' });
    if (!sku) fail('SKU_NOT_AVAILABLE', '商品规格不存在或已下架。');
    const product = await store.findOne('products', { _id: sku.productId, status: 'on_sale' });
    if (!product || !audienceVisible(product.audienceType, user)) fail('PRODUCT_NOT_AVAILABLE', '当前账号不可购买该商品。');
    const timestamp = nowIso(clock);
    const patch = { quantity, selected: payload.selected !== false, updatedAt: timestamp };
    const existing = await store.findOne('cart_items', { userId: user._id, skuId });
    let item;
    if (existing) {
      await store.update('cart_items', existing._id, patch);
      item = { ...existing, ...patch };
    } else {
      if (typeof store.runTransaction !== 'function') fail('TRANSACTION_NOT_AVAILABLE', '当前环境不支持购物车事务。');
      const id = require('./lib/transaction-ids').stableDocumentId('cart', [user._id, skuId]);
      item = await store.runTransaction(async (tx) => {
        const current = await tx.getById('cart_items', id);
        if (current) {
          if (current.userId !== user._id || current.skuId !== skuId) fail('CART_ITEM_ID_CONFLICT', '购物车稳定 ID 冲突。');
          await tx.update('cart_items', id, patch);
          return { ...current, ...patch };
        }
        const created = { _id: id, userId: user._id, skuId, ...patch, createdAt: timestamp };
        await tx.set('cart_items', id, created);
        return created;
      });
    }
    return { item: pick(item, ['_id', 'skuId', 'quantity', 'selected']) };
  }

  async function userRemoveCartItem(payload) {
    const user = await ensureWechatUser();
    const id = string(payload.id, '购物车条目 ID', { required: true, max: 80 });
    const existing = await store.findOne('cart_items', { _id: id, userId: user._id });
    if (!existing) fail('CART_ITEM_NOT_FOUND', '购物车条目不存在。');
    await store.remove('cart_items', id);
    return { id, removed: true };
  }

  async function checkoutQuote(payload) {
    const user = await ensureWechatUser();
    const fulfillmentType = string(payload.fulfillmentType || 'delivery', '履约方式', { required: true, max: 20 });
    const warehouseId = string(payload.warehouseId, '仓库 ID', { required: true, max: 80 });
    let address = null;
    if (fulfillmentType === 'delivery') {
      const addressId = string(payload.addressId, '收货地址 ID', { required: true, max: 80 });
      address = await store.findOne('addresses', { _id: addressId, userId: user._id, status: 'active' });
      if (!address || !address.regionCode) fail('ADDRESS_NOT_AVAILABLE', '请选择有效且包含配送区域的收货地址。');
    }
    if (payload.bundleId && (payload.groupCampaignId || payload.acceptedQuoteToken)) fail('PROMOTION_CONFLICT', '套餐不能与拼团或询价报价同时使用。');
    const acceptedQuote = payload.bundleId ? { overrides: {} } : await acceptedQuoteOverrides(store, user, payload.acceptedQuoteToken, payload.items, clock());
    const quote = await buildQuote({ store, user, warehouseId, regionCode: address && address.regionCode, items: payload.items, channel: payload.channel, now: clock(), deliverySlotId: payload.deliverySlotId, fulfillmentType, pickupSiteId: payload.pickupSiteId, bundleId: payload.bundleId, bundleQuantity: payload.bundleQuantity, couponId: payload.couponId, priceOverrides: acceptedQuote.overrides });
    return { quote };
  }

  async function userCreateOrder(payload) {
    const user = await ensureWechatUser();
    const existing = await findExistingOrder(store, user, payload.idempotencyKey);
    if (existing) return { order: safeOrder(existing), idempotent: true };
    const paymentMethod = ['offline', 'demo', 'credit'].includes(payload.paymentMethod) ? payload.paymentMethod : 'wechat';
    if (paymentMethod === 'offline' || paymentMethod === 'credit') {
      if (user.userType !== 'b' || user.businessStatus !== 'approved') fail(paymentMethod === 'credit' ? 'CREDIT_PAYMENT_FORBIDDEN' : 'OFFLINE_PAYMENT_FORBIDDEN', paymentMethod === 'credit' ? '账期结算仅限已审核的商家采购账号。' : '线下结算仅限已审核的商家采购账号。');
    } else if (paymentMethod === 'demo') {
      if (!demoMode || payload.groupCampaignId || payload.groupId) fail('DEMO_ORDER_FORBIDDEN', '演示订单仅在测试环境的非拼团订单中可用。');
    } else if (typeof paymentPreparer !== 'function') {
      fail('PAYMENT_NOT_CONFIGURED', '微信支付预下单尚未配置，暂不能创建订单。');
    }
    const result = await createOrder({ store, user, payload, now: clock() });
    return { order: safeOrder(result.order), idempotent: result.idempotent };
  }

  async function userOrders(payload) {
    const user = await ensureWechatUser();
    const listed = await store.list('orders', { where: { userId: user._id }, orderBy: [{ field: 'createdAt', direction: 'desc' }], ...pageParams(payload) });
    const rows = await Promise.all(listed.rows.map(async (order) => {
      const snapshot = Array.isArray(order.itemsSnapshot) ? order.itemsSnapshot : [];
      const items = snapshot.length ? snapshot : (await store.list('order_items', { where: { orderId: order._id }, page: 1, pageSize: 100 })).rows;
      return { ...safeOrder(order), items: items.map(safeOrderItem) };
    }));
    return { ...listed, rows };
  }

  async function userOrder(payload) {
    const user = await ensureWechatUser();
    const id = string(payload.id, '订单 ID', { required: true, max: 80 });
    const order = await store.findOne('orders', { _id: id, userId: user._id });
    if (!order) fail('ORDER_NOT_FOUND', '订单不存在。');
    const snapshots = Array.isArray(order.itemsSnapshot) ? order.itemsSnapshot : [];
    const itemRows = snapshots.length
      ? snapshots.map((item, index) => ({ ...item, _id: item._id || (order.itemIds || [])[index] || '', orderItemId: item.orderItemId || item._id || (order.itemIds || [])[index] || '', orderId: id }))
      : (await store.list('order_items', { where: { orderId: id }, page: 1, pageSize: 100 })).rows;
    return { order: safeOrder(order), items: itemRows.map(safeOrderItemDetail) };
  }

  async function userCancelOrder(payload) {
    const user = await ensureWechatUser();
    const id = string(payload.id, '订单 ID', { required: true, max: 80 });
    const result = await cancelOrder({ store, user, orderId: id, now: clock() });
    return { order: safeOrder(result.order), idempotent: result.idempotent };
  }

  async function userCompleteOrder(payload) {
    const user = await ensureWechatUser();
    if (typeof store.runTransaction !== 'function') fail('TRANSACTION_NOT_AVAILABLE', '当前环境不支持订单事务。');
    const id = string(payload.id, '订单 ID', { required: true, max: 80 });
    return store.runTransaction(async (tx) => {
      const order = await tx.getById('orders', id);
      if (!order || order.userId !== user._id) fail('ORDER_NOT_FOUND', '订单不存在。');
      if (order.status === 'completed') return { order: safeOrder(order), idempotent: true };
      assertTransition(order.status, 'completed', 'customer');
      const timestamp = nowIso(clock);
      for (const reservation of await orderReservations(tx, order)) {
        if (reservation && reservation.status === 'reserved') await consumeReservation(tx, reservation, order, clock(), 'order_complete_consume', user._id, `order-complete:${order._id}`);
        else if (!reservation || reservation.status !== 'consumed') fail('ORDER_RESERVATION_INVALID', '订单库存预占记录异常。');
      }
      if (order.paymentMethod === 'credit') await convertCredit(tx, order, clock());
      await awardOrderPoints(tx, order, clock());
      await tx.update('orders', id, { status: 'completed', completedAt: timestamp, updatedAt: timestamp });
      return { order: safeOrder({ ...order, status: 'completed', completedAt: timestamp, updatedAt: timestamp }), idempotent: false };
    });
  }

  async function wechatPaymentNotify(payload) {
    if (typeof paymentVerifier !== 'function') fail('PAYMENT_NOT_CONFIGURED', '微信支付验签尚未配置。');
    const verified = await paymentVerifier(payload);
    if (!verified || !verified.outTradeNo || !verified.transactionId || !Number.isInteger(Number(verified.amountCent))) fail('PAYMENT_NOTIFICATION_INVALID', '支付通知验签结果不完整。');
    const payment = await store.findOne('payments', { provider: 'wechat', outTradeNo: String(verified.outTradeNo) });
    if (!payment) fail('PAYMENT_NOT_FOUND', '未找到对应支付单。');
    const result = await confirmWechatPayment({ store, payment, transactionId: String(verified.transactionId), paidAmountCent: Number(verified.amountCent), now: clock() });
    await audit(null, 'payments.wechat.confirm', 'payment', payment._id, { orderId: result.orderId, idempotent: result.idempotent });
    return result;
  }

  async function userPreparePayment(payload) {
    const user = await ensureWechatUser();
    if (typeof paymentPreparer !== 'function') fail('PAYMENT_NOT_CONFIGURED', '微信支付预下单尚未配置。');
    const orderId = string(payload.orderId, '订单 ID', { required: true, max: 80 });
    const order = await store.findOne('orders', { _id: orderId, userId: user._id, paymentMethod: 'wechat' });
    if (!order) fail('ORDER_NOT_FOUND', '微信支付订单不存在。');
    if (order.status !== 'pending_payment' || order.paymentStatus !== 'pending') fail('ORDER_PAYMENT_NOT_AVAILABLE', '订单当前不能发起微信支付。');
    const payment = await store.findOne('payments', { orderId, provider: 'wechat', status: 'pending' });
    if (!payment) fail('PAYMENT_NOT_FOUND', '支付单不存在或已失效。');
    const prepared = await paymentPreparer({ order, payment, user, request: payload });
    if (!prepared || !prepared.timeStamp || !prepared.nonceStr || !prepared.package || !prepared.paySign) fail('PAYMENT_PREPARE_INVALID', '支付预下单返回参数不完整。');
    return { payment: { orderId, outTradeNo: payment.outTradeNo, amountCent: payment.amountCent }, params: prepared };
  }

  async function userRequestRefund(payload) {
    const user = await ensureWechatUser();
    const result = await requestRefund({ store, user, payload, now: clock() });
    if (!result.idempotent) await audit(null, 'refunds.request', 'refund', result.refund._id, { userId: user._id, orderId: result.refund.orderId, itemCount: (result.refund.items || []).length });
    return { refund: safeRefund(result.refund), idempotent: result.idempotent };
  }

  async function userRefunds(payload) {
    const user = await ensureWechatUser();
    const listed = await store.list('refunds', { where: { userId: user._id }, orderBy: [{ field: 'createdAt', direction: 'desc' }], ...pageParams(payload) });
    return { ...listed, rows: listed.rows.map((refund) => safeRefund(refund)) };
  }

  async function userRefund(payload) {
    const user = await ensureWechatUser();
    const id = string(payload.id, '售后单 ID', { required: true, max: 80 });
    const refund = await store.findOne('refunds', { _id: id, userId: user._id });
    if (!refund) fail('REFUND_NOT_FOUND', '售后申请不存在。');
    return { refund: safeRefund(refund), media: await resolveRefundEvidence(refund, user._id) };
  }

  async function resolveRefundEvidence(refund, ownerUserId = '') {
    const rows = [];
    for (const id of refund.mediaIds || []) {
      const media = await store.getById('media_assets', id);
      if (!media || media.enabled === false || media.purpose !== 'aftersale_evidence' || (ownerUserId && media.userId !== ownerUserId)) continue;
      rows.push(pick(media, ['_id', 'type', 'fileId', 'mimeType', 'sizeBytes']));
    }
    if (typeof mediaUrlResolver !== 'function' || !rows.length) return rows;
    const urlMap = await mediaUrlResolver(rows.map((item) => item.fileId).filter(Boolean));
    return rows.map((item) => urlMap && urlMap[item.fileId] ? { ...item, url: urlMap[item.fileId] } : item);
  }

  async function userUploadRefundMedia(payload, options = {}) {
    const user = await ensureWechatUser();
    const purpose = options.purpose === 'review_evidence' ? 'review_evidence' : 'aftersale_evidence';
    const label = purpose === 'review_evidence' ? '评价晒单' : '售后凭证';
    if (typeof storageUploader !== 'function') fail('MEDIA_UPLOAD_UNAVAILABLE', '售后凭证上传服务尚未配置。');
    const type = ['image', 'video'].includes(payload.type) ? payload.type : '';
    if (!type) fail('MEDIA_TYPE_INVALID', '售后凭证只支持图片或视频。');
    const mimeType = string(payload.mimeType, '凭证类型', { required: true, max: 80 }).toLowerCase();
    const allowedMimeTypes = type === 'image' ? ['image/jpeg', 'image/png', 'image/webp'] : ['video/mp4', 'video/webm', 'video/quicktime'];
    if (!allowedMimeTypes.includes(mimeType)) fail('MEDIA_MIME_INVALID', '售后凭证格式不受支持。');
    const fileName = string(payload.fileName, '文件名', { required: true, max: 160 });
    const contentBase64 = string(payload.contentBase64, '文件内容', { required: true, max: 14000000 }).replace(/^data:[^;]+;base64,/, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(contentBase64)) fail('MEDIA_CONTENT_INVALID', '文件内容不是有效的 Base64。');
    const sizeBytes = Buffer.byteLength(contentBase64, 'base64');
    const declaredSizeBytes = integer(payload.sizeBytes, 0);
    if (declaredSizeBytes && Math.abs(declaredSizeBytes - sizeBytes) > 1024) fail('MEDIA_SIZE_INVALID', '声明的文件大小与实际内容不一致。');
    const maxSizeBytes = type === 'image' ? 4 * 1024 * 1024 : 10 * 1024 * 1024;
    if (!sizeBytes || sizeBytes > maxSizeBytes) fail('MEDIA_SIZE_INVALID', `售后${type === 'image' ? '图片' : '视频'}不能超过 ${type === 'image' ? 4 : 10} MB。`);
    const extension = ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov' })[mimeType];
    const safeBaseName = fileName.replace(/[^0-9A-Za-z_\-.\u4e00-\u9fff]/g, '_').replace(/\.[^.]+$/, '') || 'evidence';
    const timestamp = nowIso(clock);
    const cloudPath = `mengshixian/${purpose === 'review_evidence' ? 'reviews' : 'aftersale'}/${user._id}/${timestamp.slice(0, 10)}/${randomId()}-${safeBaseName}${extension}`;
    const fileId = await storageUploader({ cloudPath, contentBase64, mimeType, sizeBytes, purpose, userId: user._id });
    if (!fileId) fail('MEDIA_UPLOAD_FAILED', '售后凭证上传未返回文件 ID。');
    const media = await store.create('media_assets', { name: fileName, type, fileId, mimeType, sizeBytes, purpose, businessEvidence: purpose === 'aftersale_evidence', publicApproved: false, userId: user._id, source: 'client', temporary: false, enabled: true, targetPlatforms: ['miniapp', 'web'], version: 1, createdAt: timestamp, updatedAt: timestamp });
    const resolved = typeof mediaUrlResolver === 'function' ? await mediaUrlResolver([fileId]) : {};
    await audit(null, purpose === 'review_evidence' ? 'reviews.media.upload' : 'refunds.media.upload', 'media_asset', media._id, { userId: user._id, type, mimeType, sizeBytes, label });
    return { mediaId: media._id, type, mimeType, sizeBytes, url: resolved && resolved[fileId] || '' };
  }

  async function adminReviewRefund(payload) {
    const { admin } = await getAdmin(payload, 'refunds.write');
    const result = await reviewRefund({ store, admin, payload, now: clock() });
    if (!result.idempotent) await audit(admin, 'refunds.review', 'refund', result.refund._id, { status: result.refund.status, decision: payload.decision });
    return { refund: safeRefund(result.refund, true), idempotent: result.idempotent };
  }

  async function adminProcessRefund(payload) {
    const { admin } = await getAdmin(payload, 'refunds.write');
    const result = await processRefund({ store, admin, payload, now: clock() });
    if (!result.idempotent) await audit(admin, 'refunds.process', 'refund', result.refund._id, { action: payload.action, status: result.refund.status });
    return { refund: safeRefund(result.refund, true), idempotent: result.idempotent };
  }

  async function refundNotify(payload) {
    if (typeof refundVerifier !== 'function') fail('REFUND_NOT_CONFIGURED', '退款验签尚未配置。');
    const verified = await refundVerifier(payload);
    if (!verified || !verified.refundNo || !verified.refundTransactionId || !Number.isInteger(Number(verified.amountCent))) fail('REFUND_NOTIFICATION_INVALID', '退款通知验签结果不完整。');
    const refund = await store.findOne('refunds', { refundNo: String(verified.refundNo) });
    if (!refund) fail('REFUND_NOT_FOUND', '未找到对应退款记录。');
    const result = await confirmRefund({ store, refund, refundTransactionId: String(verified.refundTransactionId), refundedAmountCent: Number(verified.amountCent), now: clock() });
    await audit(null, 'refunds.confirm', 'refund', refund._id, { orderId: refund.orderId, idempotent: result.idempotent });
    return result;
  }

  async function adminUpsertPrice(payload) {
    const { admin } = await getAdmin(payload, 'pricing.write');
    const skuId = string(payload.skuId, 'SKU ID', { required: true, max: 80 });
    const sku = await store.findOne('product_skus', { _id: skuId });
    if (!sku) fail('SKU_NOT_FOUND', 'SKU 不存在。');
    const scopeType = string(payload.scopeType || 'public', '价格适用范围', { max: 30 });
    if (!['public', 'customer_type', 'level', 'organization', 'user'].includes(scopeType)) fail('VALIDATION_ERROR', '价格适用范围不合法。');
    const scopeId = string(payload.scopeId, '价格适用对象 ID', { max: 100 });
    if (scopeType !== 'public' && !scopeId) fail('VALIDATION_ERROR', '定向价格必须指定适用对象。');
    const timestamp = nowIso(clock);
    const quantityRulePatch = {};
    if (payload.quantityTiers !== undefined) quantityRulePatch.quantityTiers = normalizeQuantityTiers(payload.quantityTiers);
    if (payload.minOrderQuantity !== undefined) {
      quantityRulePatch.minOrderQuantity = Number(payload.minOrderQuantity);
      if (!Number.isInteger(quantityRulePatch.minOrderQuantity) || quantityRulePatch.minOrderQuantity < 0 || quantityRulePatch.minOrderQuantity > 999) fail('VALIDATION_ERROR', '价格规则起订量必须是 0 到 999 的整数，0 表示继承 SKU。');
    }
    if (payload.orderMultiple !== undefined) {
      quantityRulePatch.orderMultiple = Number(payload.orderMultiple);
      if (!Number.isInteger(quantityRulePatch.orderMultiple) || quantityRulePatch.orderMultiple < 0 || quantityRulePatch.orderMultiple > 999) fail('VALIDATION_ERROR', '价格规则购买倍数必须是 0 到 999 的整数，0 表示继承 SKU。');
    }
    const metadataPatch = {};
    if (payload.source !== undefined) metadataPatch.source = ['client', 'ai_generated', 'demo', 'admin_upload'].includes(payload.source) ? payload.source : '';
    if (payload.temporary !== undefined) metadataPatch.temporary = payload.temporary === true;
    if (payload.demoNote !== undefined) metadataPatch.demoNote = string(payload.demoNote, '演示说明', { max: 300 });
    const patch = {
      skuId, scopeType, scopeId, channel: ['all', 'miniapp', 'web'].includes(payload.channel) ? payload.channel : 'all',
      amountCent: cents(payload.amountCent === undefined ? payload.price : payload.amountCent, '商品价格'), currency: 'CNY',
      priority: integer(payload.priority, 0), validFrom: string(payload.validFrom, '生效开始时间', { max: 40 }), validTo: string(payload.validTo, '生效结束时间', { max: 40 }),
      status: ['draft', 'active', 'disabled'].includes(payload.status) ? payload.status : 'draft', ...quantityRulePatch, ...metadataPatch, updatedAt: timestamp
    };
    if (patch.status === 'active' && (patch.temporary || ['ai_generated', 'demo'].includes(patch.source))) fail('TEMPORARY_CANNOT_ACTIVATE', 'AI 或临时价格只能保存为草稿，不能启用。');
    if (patch.validFrom && Number.isNaN(new Date(patch.validFrom).getTime())) fail('VALIDATION_ERROR', '生效开始时间不合法。');
    if (patch.validTo && Number.isNaN(new Date(patch.validTo).getTime())) fail('VALIDATION_ERROR', '生效结束时间不合法。');
    let rule;
    if (payload.id) {
      const id = string(payload.id, '价格规则 ID', { max: 80 });
      const existing = await store.findOne('prices', { _id: id });
      if (!existing) fail('PRICE_RULE_NOT_FOUND', '价格规则不存在。');
      await store.update('prices', id, patch);
      rule = { ...existing, ...patch, _id: id };
    } else {
      rule = await store.create('prices', { quantityTiers: [], minOrderQuantity: 0, orderMultiple: 0, ...demoMetadata(payload), ...patch, createdBy: admin._id, createdAt: timestamp });
    }
    await audit(admin, 'pricing.upsert', 'price', rule._id, { skuId, scopeType, scopeId, amountCent: rule.amountCent, quantityTierCount: (rule.quantityTiers || []).length, minOrderQuantity: rule.minOrderQuantity || 0, orderMultiple: rule.orderMultiple || 0, status: rule.status });
    return rule;
  }

  async function adminSeedDemoCommerce(payload) {
    const { admin, permissions } = await getAdmin(payload, 'catalog.write');
    if (!demoMode || !hasPermission(permissions, '*')) fail('DEMO_SEED_FORBIDDEN', '演示批量初始化仅允许测试环境的超级管理员执行。');
    const warehouseId = string(payload.warehouseId, '仓库 ID', { required: true, max: 80 });
    const sourceFile = string(payload.sourceFile, '演示来源文件', { required: true, max: 120 });
    const entries = Array.isArray(payload.entries) ? payload.entries.slice(0, 50) : [];
    if (!entries.length) fail('VALIDATION_ERROR', '演示初始化至少需要一条商品数据。');
    const warehouse = await store.findOne('warehouses', { _id: warehouseId, status: 'active' });
    if (!warehouse) fail('WAREHOUSE_NOT_AVAILABLE', '演示仓库不可用。');
    const jobs = await collectPageMatches(store, 'import_jobs', { where: { sourceFile, status: 'imported' } }, () => true);
    const jobBySourceId = new Map(jobs.map((job) => [String(job.sourceKey || '').split(':').pop(), job]));
    const metadata = demoMetadata(payload);
    const output = [];
    for (const entry of entries) {
      const sourceId = string(entry.sourceId, '演示商品来源 ID', { required: true, max: 80 });
      const job = jobBySourceId.get(sourceId);
      if (!job || !job.skuId) fail('DEMO_PRODUCT_NOT_IMPORTED', `演示商品 ${sourceId} 尚未导入。`);
      const timestamp = nowIso(clock);
      const variants = Array.isArray(entry.skus) && entry.skus.length ? entry.skus.slice(0, 6) : [{ key: 'retail', specName: '标准装', packageUnit: '1份', amountCent: entry.amountCent, initialStock: entry.initialStock, sort: 0 }];
      for (let variantIndex = 0; variantIndex < variants.length; variantIndex += 1) {
        const variant = variants[variantIndex] || {};
        const variantKey = string(variant.key || `option-${variantIndex + 1}`, '规格键', { required: true, max: 30 }).replace(/[^a-zA-Z0-9_-]/g, '-');
        const skuId = variantIndex === 0 ? job.skuId : `demo-sku-${sourceId}-${variantKey}`;
        const amountCent = cents(variant.amountCent === undefined ? entry.amountCent : variant.amountCent, '商品价格');
        const stock = integer(variant.initialStock === undefined ? entry.initialStock : variant.initialStock, 0);
        if (stock <= 0) fail('VALIDATION_ERROR', '初始库存必须大于 0。');
        const minOrderQuantity = variant.minOrderQuantity === undefined ? 1 : Number(variant.minOrderQuantity);
        const orderMultiple = variant.orderMultiple === undefined ? 1 : Number(variant.orderMultiple);
        if (!Number.isInteger(minOrderQuantity) || minOrderQuantity < 1 || minOrderQuantity > 999) fail('VALIDATION_ERROR', '演示 SKU 起订量必须是 1 到 999 的整数。');
        if (!Number.isInteger(orderMultiple) || orderMultiple < 1 || orderMultiple > 999) fail('VALIDATION_ERROR', '演示 SKU 购买倍数必须是 1 到 999 的整数。');
        const existingSku = await store.getById('product_skus', skuId);
        const skuPatch = {
          productId: job.productId,
          skuCode: `MSX-${sourceId}-${variantKey}`.toUpperCase(),
          specName: string(variant.specName, '规格名称', { required: true, max: 100 }),
          netWeight: string(variant.netWeight, '净含量', { max: 40 }),
          weightUnit: string(variant.weightUnit, '重量单位', { max: 20 }),
          piecesPerCase: integer(variant.piecesPerCase, 0),
          packageUnit: string(variant.packageUnit, '包装单位', { required: true, max: 100 }),
          barcode: '', mediaIds: [], minOrderQuantity, orderMultiple, sort: integer(variant.sort, variantIndex * 10), status: 'on_sale', sourceImportId: job._id,
          ...metadata, updatedAt: timestamp, createdAt: existingSku && existingSku.createdAt || timestamp
        };
        if (existingSku) await store.update('product_skus', skuId, skuPatch);
        else await store.set('product_skus', skuId, skuPatch);

        const existingPrice = await store.findOne('prices', { skuId, scopeType: 'public', scopeId: '', channel: 'miniapp' });
        const pricePatch = { skuId, scopeType: 'public', scopeId: '', channel: 'miniapp', amountCent, currency: 'CNY', priority: 0, validFrom: '', validTo: '', status: 'active', ...metadata, updatedAt: timestamp };
        if (existingPrice) await store.update('prices', existingPrice._id, pricePatch);
        else await store.create('prices', { ...pricePatch, createdBy: admin._id, createdAt: timestamp });

        // Deterministic IDs keep repeated test-data provisioning idempotent.
        // Customer reservations and later stock changes still use transactions.
        const inventoryDocumentId = inventoryId(warehouseId, skuId);
        const seedKey = variantIndex === 0 ? `demo-stock-${sourceId}` : `demo-stock-${sourceId}-${variantKey}`;
        const ledgerDocumentId = inventoryLedgerId('demo_initial_stock', seedKey, skuId);
        const existingLedger = await store.getById('inventory_ledger', ledgerDocumentId);
        let inventory;
        if (existingLedger) inventory = await store.getById('inventory', inventoryDocumentId);
        else {
          const previous = await store.getById('inventory', inventoryDocumentId);
          const onHand = Number(previous && previous.onHand || 0);
          const reserved = Number(previous && previous.reserved || 0);
          const saved = { warehouseId, skuId, onHand: onHand + stock, reserved, available: onHand + stock - reserved, version: Number(previous && previous.version || 0) + 1, ...metadata, updatedAt: timestamp, createdAt: previous && previous.createdAt || timestamp };
          inventory = await store.set('inventory', inventoryDocumentId, saved);
          await store.set('inventory_ledger', ledgerDocumentId, { warehouseId, skuId, change: stock, reservedChange: 0, before: onHand - reserved, after: saved.available, reason: 'demo_initial_stock', referenceType: 'demo_seed', referenceId: sourceFile, operatorId: admin._id, idempotencyKey: seedKey, ...metadata, createdAt: timestamp });
        }
        let stockNormalized = false;
        if (payload.normalizeStock === true && inventory && Number(inventory.reserved || 0) === 0 && Number(inventory.onHand || 0) !== stock) {
          const before = Number(inventory.onHand || 0) - Number(inventory.reserved || 0);
          inventory = await store.set('inventory', inventoryDocumentId, { ...inventory, onHand: stock, available: stock, version: Number(inventory.version || 0) + 1, ...metadata, updatedAt: timestamp });
          const normalizeKey = `demo-stock-normalize-${sourceId}-${variantKey}`;
          await store.set('inventory_ledger', inventoryLedgerId('demo_stock_normalize', normalizeKey, skuId), { warehouseId, skuId, change: stock - before, reservedChange: 0, before, after: stock, reason: 'demo_stock_normalize', referenceType: 'demo_seed', referenceId: sourceFile, operatorId: admin._id, idempotencyKey: normalizeKey, ...metadata, createdAt: timestamp });
          stockNormalized = true;
        }
        output.push({ sourceId, skuId, specName: skuPatch.specName, priceUpdated: true, inventoryId: inventory && inventory._id || inventoryDocumentId, stockNormalized });
      }
    }
    await audit(admin, 'demo.commerce.seed', 'import_job', '', { sourceFile, productCount: entries.length, skuCount: output.length, warehouseId });
    return { seededProducts: entries.length, seededSkus: output.length, rows: output };
  }

  async function adminUpsertGroupCampaign(payload) {
    const { admin } = await getAdmin(payload, 'marketing.write');
    const skuId = string(payload.skuId, '活动 SKU ID', { required: true, max: 80 });
    const sku = await store.findOne('product_skus', { _id: skuId });
    if (!sku) fail('SKU_NOT_FOUND', '活动 SKU 不存在。');
    const timestamp = nowIso(clock);
    const patch = { title: string(payload.title, '活动标题', { required: true, max: 100 }), skuId, groupSize: integer(payload.groupSize, 0), durationMinutes: integer(payload.durationMinutes, 0), groupPriceCent: cents(payload.groupPriceCent === undefined ? payload.groupPrice : payload.groupPriceCent, '拼团价格'), coverMediaId: await validateMediaReference(payload.coverMediaId, '活动封面素材 ID', 'image'), targetUserType: ['all', 'b', 'c'].includes(payload.targetUserType) ? payload.targetUserType : 'all', startAt: string(payload.startAt, '开始时间', { max: 40 }), endAt: string(payload.endAt, '结束时间', { max: 40 }), sort: integer(payload.sort, 0), status: ['draft', 'active', 'disabled'].includes(payload.status) ? payload.status : 'draft', ...demoMetadata(payload), updatedAt: timestamp };
    if (patch.status === 'active' && (patch.temporary || ['ai_generated', 'demo'].includes(patch.source))) fail('TEMPORARY_CANNOT_ACTIVATE', 'AI 或临时拼团活动不能启用。');
    if (patch.groupSize < 2 || patch.groupSize > 12) fail('VALIDATION_ERROR', '拼团人数必须在 2 到 12 人之间。');
    if (patch.durationMinutes < 5 || patch.durationMinutes > 10080) fail('VALIDATION_ERROR', '拼团有效期必须在 5 分钟到 7 天之间。');
    if (patch.startAt && Number.isNaN(new Date(patch.startAt).getTime())) fail('VALIDATION_ERROR', '活动开始时间不合法。');
    if (patch.endAt && Number.isNaN(new Date(patch.endAt).getTime())) fail('VALIDATION_ERROR', '活动结束时间不合法。');
    let campaign;
    if (payload.id) {
      const id = string(payload.id, '拼团活动 ID', { max: 80 });
      const existing = await store.findOne('group_campaigns', { _id: id });
      if (!existing) fail('GROUP_CAMPAIGN_NOT_FOUND', '拼团活动不存在。');
      await store.update('group_campaigns', id, patch);
      campaign = { ...existing, ...patch, _id: id };
    } else campaign = await store.create('group_campaigns', { ...patch, createdBy: admin._id, createdAt: timestamp });
    await audit(admin, 'marketing.group_campaign.upsert', 'group_campaign', campaign._id, { skuId, groupSize: campaign.groupSize, status: campaign.status });
    return campaign;
  }

  async function adminUsers(payload) {
    await getAdmin(payload, 'users.read');
    const listed = await store.list('users', { orderBy: [{ field: 'updatedAt', direction: 'desc' }], ...pageParams(payload) });
    return { ...listed, rows: listed.rows.map(safeUser) };
  }

  async function adminSetUserPricingProfile(payload) {
    const { admin } = await getAdmin(payload, 'users.write');
    const id = string(payload.id, '用户 ID', { required: true, max: 80 });
    const user = await store.findOne('users', { _id: id });
    if (!user) fail('USER_NOT_FOUND', '用户不存在。');
    const userType = string(payload.userType || user.userType || 'c', '用户类型', { max: 10 });
    if (!['b', 'c'].includes(userType)) fail('VALIDATION_ERROR', '用户类型仅支持 B 或 C。');
    const organizationId = string(payload.organizationId === undefined ? user.organizationId : payload.organizationId, '企业 ID', { max: 80 });
    if (userType === 'b' && !organizationId) fail('VALIDATION_ERROR', 'B 端用户必须归属企业。');
    if (organizationId && !await store.findOne('customer_organizations', { _id: organizationId, status: 'active' })) fail('ORGANIZATION_NOT_FOUND', '企业不存在或未启用。');
    const patch = { userType, organizationId, priceLevel: string(payload.priceLevel, '价格等级', { max: 40 }), businessStatus: userType === 'b' ? 'approved' : 'none', updatedAt: nowIso(clock) };
    await store.update('users', id, patch);
    await audit(admin, 'users.pricing_profile.set', 'user', id, { userType, organizationId, priceLevel: patch.priceLevel });
    return { user: safeUser({ ...user, ...patch }) };
  }

  async function adminReviewBusinessApplication(payload) {
    const { admin } = await getAdmin(payload, 'organizations.write');
    const id = string(payload.id, '企业申请 ID', { required: true, max: 80 });
    const decision = string(payload.decision, '审核结论', { required: true, max: 20 });
    if (!['approved', 'rejected'].includes(decision)) fail('VALIDATION_ERROR', '审核结论不合法。');
    const application = await store.findOne('business_applications', { _id: id });
    if (!application) fail('BUSINESS_APPLICATION_NOT_FOUND', '企业申请不存在。');
    if (application.status !== 'pending') fail('BUSINESS_APPLICATION_REVIEWED', '该企业申请已处理，不能重复审核。');
    const timestamp = nowIso(clock);
    const reviewNote = string(payload.reviewNote, '审核备注', { max: 300 });
    if (decision === 'rejected') {
      await store.update('business_applications', id, { status: 'rejected', reviewedBy: admin._id, reviewedAt: timestamp, reviewNote, updatedAt: timestamp });
      await store.update('users', application.userId, { businessStatus: 'rejected', updatedAt: timestamp });
      await audit(admin, 'organizations.application.reject', 'business_application', id, { userId: application.userId, reviewNote });
      return { id, status: 'rejected' };
    }
    let organization = await store.findOne('customer_organizations', { unifiedCode: application.unifiedCode });
    if (!organization) organization = await store.create('customer_organizations', { name: application.companyName, unifiedCode: application.unifiedCode, status: 'active', createdAt: timestamp, updatedAt: timestamp, approvedBy: admin._id });
    else if (organization.status !== 'active') {
      await store.update('customer_organizations', organization._id, { status: 'active', updatedAt: timestamp });
      organization = { ...organization, status: 'active' };
    }
    const priceLevel = string(payload.priceLevel, '价格等级', { max: 40 });
    await store.update('users', application.userId, { userType: 'b', organizationId: organization._id, priceLevel, businessStatus: 'approved', updatedAt: timestamp });
    await store.update('business_applications', id, { status: 'approved', organizationId: organization._id, reviewedBy: admin._id, reviewedAt: timestamp, reviewNote, updatedAt: timestamp });
    await audit(admin, 'organizations.application.approve', 'business_application', id, { userId: application.userId, organizationId: organization._id, priceLevel });
    return { id, status: 'approved', organization: pick(organization, ['_id', 'name', 'unifiedCode', 'status']) };
  }

  async function adminBusinessApplications(payload) {
    await getAdmin(payload, 'organizations.read');
    const listed = await store.list('business_applications', { orderBy: [{ field: 'submittedAt', direction: 'desc' }], ...pageParams(payload) });
    return { ...listed, rows: listed.rows.map((item) => pick(item, ['_id', 'userId', 'companyName', 'unifiedCode', 'contactName', 'contactPhoneMasked', 'status', 'submittedAt', 'reviewedBy', 'reviewedAt', 'reviewNote', 'organizationId'])) };
  }

  async function adminUpsertWarehouse(payload) {
    const { admin } = await getAdmin(payload, 'inventory.write');
    const timestamp = nowIso(clock);
    const patch = { code: string(payload.code, '仓库编码', { required: true, max: 40 }), name: string(payload.name, '仓库名称', { required: true, max: 80 }), address: string(payload.address, '仓库地址', { max: 200 }), status: ['active', 'disabled'].includes(payload.status) ? payload.status : 'active', sort: integer(payload.sort, 0), ...demoMetadata(payload), updatedAt: timestamp };
    let warehouse;
    if (payload.id) {
      const id = string(payload.id, '仓库 ID', { max: 80 });
      const existing = await store.findOne('warehouses', { _id: id });
      if (!existing) fail('WAREHOUSE_NOT_FOUND', '仓库不存在。');
      await store.update('warehouses', id, patch);
      warehouse = { ...existing, ...patch, _id: id };
    } else warehouse = await store.create('warehouses', { ...patch, createdAt: timestamp });
    await audit(admin, 'inventory.warehouse.upsert', 'warehouse', warehouse._id, { code: warehouse.code, status: warehouse.status });
    return warehouse;
  }

  async function adminAdjustInventory(payload) {
    const { admin } = await getAdmin(payload, 'inventory.write');
    const warehouseId = string(payload.warehouseId, '仓库 ID', { required: true, max: 80 });
    const skuId = string(payload.skuId, 'SKU ID', { required: true, max: 80 });
    const change = integer(payload.change, 0);
    const idempotencyKey = string(payload.idempotencyKey, '库存调整幂等键', { required: true, max: 120 });
    if (!change || Math.abs(change) > 1000000) fail('VALIDATION_ERROR', '库存调整数量不合法。');
    if (typeof store.runTransaction !== 'function') fail('TRANSACTION_NOT_AVAILABLE', '当前环境不支持库存事务。');
    const inventoryDocumentId = inventoryId(warehouseId, skuId);
    const ledgerDocumentId = inventoryLedgerId('manual_adjust', idempotencyKey, skuId);
    const adjustmentReason = string(payload.reason || 'manual_adjust', '调整原因', { max: 80 });
    const result = await store.runTransaction(async (tx) => {
      const existingLedger = await tx.getById('inventory_ledger', ledgerDocumentId);
      if (existingLedger) {
        const existingInventory = await tx.getById('inventory', inventoryDocumentId);
        return { inventory: existingInventory, idempotent: true };
      }
      const [warehouse, sku] = await Promise.all([tx.getById('warehouses', warehouseId), tx.getById('product_skus', skuId)]);
      if (!warehouse || warehouse.status !== 'active') fail('WAREHOUSE_NOT_AVAILABLE', '仓库不存在或不可用。');
      if (!sku) fail('SKU_NOT_FOUND', 'SKU 不存在。');
      const timestamp = nowIso(clock);
      const inventory = await tx.getById('inventory', inventoryDocumentId);
      const onHand = Number(inventory && inventory.onHand || 0);
      const reserved = Number(inventory && inventory.reserved || 0);
      if (onHand + change < reserved) fail('INVENTORY_BELOW_RESERVED', '调整后库存不能低于已预占库存。');
      const patch = { warehouseId, skuId, onHand: onHand + change, reserved, available: onHand + change - reserved, version: Number(inventory && inventory.version || 0) + 1, ...demoMetadata(payload), updatedAt: timestamp };
      const saved = await tx.set('inventory', inventoryDocumentId, { ...patch, createdAt: inventory && inventory.createdAt || timestamp });
      await tx.set('inventory_ledger', ledgerDocumentId, { warehouseId, skuId, change, reservedChange: 0, before: onHand - reserved, after: patch.available, reason: adjustmentReason, referenceType: 'manual', referenceId: idempotencyKey, operatorId: admin._id, idempotencyKey, createdAt: timestamp });
      return { inventory: saved, idempotent: false };
    });
    if (!result.idempotent) await audit(admin, 'inventory.adjust', 'inventory', result.inventory._id, { warehouseId, skuId, change, available: result.inventory.available });
    return result;
  }

  async function adminUpsertDeliveryArea(payload) {
    const { admin } = await getAdmin(payload, 'delivery.write');
    const regionCodes = Array.isArray(payload.regionCodes) ? [...new Set(payload.regionCodes.map((item) => string(item, '配送区域编码', { required: true, max: 80 })))].slice(0, 500) : [];
    if (!regionCodes.length) fail('VALIDATION_ERROR', '配送区域至少需要一个区域编码。');
    const timestamp = nowIso(clock);
    const patch = { name: string(payload.name, '配送区域名称', { required: true, max: 80 }), regionCodes, warehouseIds: Array.isArray(payload.warehouseIds) ? [...new Set(payload.warehouseIds.map((item) => string(item, '仓库 ID', { required: true, max: 80 })))].slice(0, 50) : [], status: ['active', 'disabled'].includes(payload.status) ? payload.status : 'active', sort: integer(payload.sort, 0), ...demoMetadata(payload), updatedAt: timestamp };
    let area;
    if (payload.id) {
      const id = string(payload.id, '配送区域 ID', { max: 80 });
      const existing = await store.findOne('delivery_areas', { _id: id });
      if (!existing) fail('DELIVERY_AREA_NOT_FOUND', '配送区域不存在。');
      await store.update('delivery_areas', id, patch);
      area = { ...existing, ...patch, _id: id };
    } else area = await store.create('delivery_areas', { ...patch, createdAt: timestamp });
    await audit(admin, 'delivery.area.upsert', 'delivery_area', area._id, { name: area.name, regionCodeCount: area.regionCodes.length, status: area.status });
    return area;
  }

  async function adminUpsertFreightRule(payload) {
    const { admin } = await getAdmin(payload, 'delivery.write');
    const timestamp = nowIso(clock);
    const deliveryAreaId = string(payload.deliveryAreaId, '配送区域 ID', { required: true, max: 80 });
    const area = await store.findOne('delivery_areas', { _id: deliveryAreaId });
    if (!area) fail('DELIVERY_AREA_NOT_FOUND', '配送区域不存在。');
    const patch = { name: string(payload.name, '运费规则名称', { required: true, max: 80 }), deliveryAreaId, warehouseId: string(payload.warehouseId, '仓库 ID', { max: 80 }), customerType: string(payload.customerType, '客户类型', { max: 30 }), baseFeeCent: cents(payload.baseFeeCent === undefined ? (payload.baseFee === undefined ? 0 : payload.baseFee) : payload.baseFeeCent, '基础配送费'), additionalFeeCent: cents(payload.additionalFeeCent === undefined ? (payload.additionalFee === undefined ? 0 : payload.additionalFee) : payload.additionalFeeCent, '附加配送费'), freeThresholdCent: cents(payload.freeThresholdCent === undefined ? (payload.freeThreshold === undefined ? 0 : payload.freeThreshold) : payload.freeThresholdCent, '免运门槛'), priority: integer(payload.priority, 0), validFrom: string(payload.validFrom, '生效开始时间', { max: 40 }), validTo: string(payload.validTo, '生效结束时间', { max: 40 }), status: ['draft', 'active', 'disabled'].includes(payload.status) ? payload.status : 'draft', ...demoMetadata(payload), updatedAt: timestamp };
    let rule;
    if (payload.id) {
      const id = string(payload.id, '运费规则 ID', { max: 80 });
      const existing = await store.findOne('freight_rules', { _id: id });
      if (!existing) fail('FREIGHT_RULE_NOT_FOUND', '运费规则不存在。');
      await store.update('freight_rules', id, patch);
      rule = { ...existing, ...patch, _id: id };
    } else rule = await store.create('freight_rules', { ...patch, createdBy: admin._id, createdAt: timestamp });
    await audit(admin, 'delivery.freight.upsert', 'freight_rule', rule._id, { deliveryAreaId, warehouseId: rule.warehouseId, status: rule.status });
    return rule;
  }

  async function adminUpsertDeliverySlot(payload) {
    const { admin } = await getAdmin(payload, 'delivery.write');
    const deliveryAreaId = string(payload.deliveryAreaId, '配送区域 ID', { required: true, max: 80 });
    const area = await store.findOne('delivery_areas', { _id: deliveryAreaId });
    if (!area) fail('DELIVERY_AREA_NOT_FOUND', '配送区域不存在。');
    const startTime = string(payload.startTime, '开始时间', { required: true, max: 10 });
    const endTime = string(payload.endTime, '结束时间', { required: true, max: 10 });
    if (!/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime) || startTime >= endTime) fail('VALIDATION_ERROR', '配送时段格式或起止时间不合法。');
    const timestamp = nowIso(clock);
    const patch = { name: string(payload.name, '配送时段名称', { required: true, max: 80 }), deliveryAreaId, warehouseId: string(payload.warehouseId, '仓库 ID', { max: 80 }), startTime, endTime, capacity: integer(payload.capacity, 0), validFrom: string(payload.validFrom, '生效开始时间', { max: 40 }), validTo: string(payload.validTo, '生效结束时间', { max: 40 }), status: ['draft', 'active', 'disabled'].includes(payload.status) ? payload.status : 'draft', sort: integer(payload.sort, 0), ...demoMetadata(payload), updatedAt: timestamp };
    let slot;
    if (payload.id) {
      const id = string(payload.id, '配送时段 ID', { max: 80 }); const existing = await store.findOne('delivery_slots', { _id: id });
      if (!existing) fail('DELIVERY_SLOT_NOT_FOUND', '配送时段不存在。');
      await store.update('delivery_slots', id, patch); slot = { ...existing, ...patch, _id: id };
    } else slot = await store.create('delivery_slots', { ...patch, createdAt: timestamp });
    await audit(admin, 'delivery.slot.upsert', 'delivery_slot', slot._id, { deliveryAreaId, warehouseId: slot.warehouseId, status: slot.status });
    return slot;
  }

  async function adminUpsertPickupSite(payload) {
    const { admin } = await getAdmin(payload, 'delivery.write');
    const warehouseId = string(payload.warehouseId, '仓库 ID', { required: true, max: 80 });
    const warehouse = await store.findOne('warehouses', { _id: warehouseId });
    const status = ['active', 'disabled'].includes(payload.status) ? payload.status : 'active';
    if (status === 'active' && (!warehouse || warehouse.status !== 'active')) fail('WAREHOUSE_NOT_AVAILABLE', '启用自提点必须关联启用仓库。');
    const timestamp = nowIso(clock);
    const patch = {
      name: string(payload.name, '自提点名称', { required: true, max: 80 }),
      address: string(payload.address, '自提点地址', { required: true, max: 200 }),
      regionCode: string(payload.regionCode, '自提点区域编码', { required: true, max: 80 }),
      warehouseId,
      openingHours: string(payload.openingHours, '营业时间', { max: 200 }),
      status,
      sort: integer(payload.sort, 0),
      updatedAt: timestamp
    };
    let site;
    if (payload.id) {
      const id = string(payload.id, '自提点 ID', { required: true, max: 80 });
      const existing = await store.findOne('pickup_sites', { _id: id });
      if (!existing) fail('PICKUP_SITE_NOT_FOUND', '自提点不存在。');
      await store.update('pickup_sites', id, patch);
      site = { ...existing, ...patch, _id: id };
    } else site = await store.create('pickup_sites', { ...patch, createdAt: timestamp });
    await audit(admin, 'delivery.pickup_site.upsert', 'pickup_site', site._id, { name: site.name, warehouseId, status: site.status });
    return site;
  }

  async function adminTransitionOrder(payload) {
    const { admin } = await getAdmin(payload, 'orders.write');
    const id = string(payload.id, '订单 ID', { required: true, max: 80 });
    const nextStatus = string(payload.status, '目标订单状态', { required: true, max: 30 });
    if (nextStatus === 'pending_confirmation') fail('PAYMENT_CALLBACK_REQUIRED', '待确认状态只能由验签后的支付回调写入。');
    if (typeof store.runTransaction !== 'function') fail('TRANSACTION_NOT_AVAILABLE', '当前环境不支持订单事务。');
    const result = await store.runTransaction(async (tx) => {
      const order = await tx.getById('orders', id);
      if (!order) fail('ORDER_NOT_FOUND', '订单不存在。');
      // 已支付订单的预占已消耗，直接取消会不退款、不回补且关闭退款入口，必须走退款售后流程。
      if (nextStatus === 'cancelled' && order.paymentStatus === 'paid') fail('ORDER_PAID_CANCEL_FORBIDDEN', '已支付订单不能直接取消，请通过退款售后流程处理。');
      assertTransition(order.status, nextStatus, 'admin');
      const timestamp = nowIso(clock);
      const patch = { status: nextStatus, updatedAt: timestamp };
      if (nextStatus === 'shipping') patch.shipInfo = { carrier: string(payload.carrier, '配送承运方', { max: 80 }), trackingNo: string(payload.trackingNo, '运单号', { max: 100 }), shippedAt: timestamp };
      if (nextStatus === 'delivered') patch.deliveredAt = timestamp;
      if (nextStatus === 'completed') {
        for (const reservation of await orderReservations(tx, order)) {
          if (reservation && reservation.status === 'reserved') await consumeReservation(tx, reservation, order, clock(), 'admin_order_complete_consume', admin._id, `admin-complete:${order._id}`);
          else if (!reservation || reservation.status !== 'consumed') fail('ORDER_RESERVATION_INVALID', '订单库存预占记录异常。');
        }
        if (order.paymentMethod === 'credit') await convertCredit(tx, order, clock());
        await awardOrderPoints(tx, order, clock());
        patch.completedAt = timestamp;
      }
      if (nextStatus === 'cancelled') {
        patch.cancelledAt = timestamp;
        patch.cancelReason = 'admin_cancelled';
        // 与用户侧取消保持一致：后台取消未支付订单必须在同一事务内释放库存预占与拼团名额。
        for (const reservation of await orderReservations(tx, order)) await releaseReservation(tx, reservation, order, clock(), 'admin_cancel_release');
        if (order.paymentMethod === 'credit') await releaseCredit(tx, order, clock(), 'admin_cancelled');
        await releaseSlot(tx, { groupId: order.groupId, orderId: order._id, now: clock() });
        if (order.couponSnapshot && order.couponSnapshot.userCouponId) {
          const coupon = await tx.getById('user_coupons', order.couponSnapshot.userCouponId);
          if (coupon && coupon.userId === order.userId && coupon.status === 'used' && coupon.usedOrderId === order._id) await tx.update('user_coupons', coupon._id, { status: 'available', usedOrderId: '', usedAt: '', releasedAt: timestamp, updatedAt: timestamp });
        }
      }
      await tx.update('orders', id, patch);
      return { order: safeOrder({ ...order, ...patch }), from: order.status };
    });
    await audit(admin, 'orders.transition', 'order', id, { from: result.from, to: nextStatus });
    return { order: result.order };
  }

  async function adminOrder(payload) {
    await getAdmin(payload, 'orders.read');
    const id = string(payload.id, '订单 ID', { required: true, max: 80 });
    const order = await store.findOne('orders', { _id: id });
    if (!order) fail('ORDER_NOT_FOUND', '订单不存在。');
    const snapshots = Array.isArray(order.itemsSnapshot) ? order.itemsSnapshot : [];
    const itemRows = snapshots.length
      ? snapshots.map((item, index) => ({ ...item, _id: item._id || (order.itemIds || [])[index] || '', orderItemId: item.orderItemId || item._id || (order.itemIds || [])[index] || '', orderId: id }))
      : (await store.list('order_items', { where: { orderId: id }, page: 1, pageSize: 100 })).rows;
    return { order: safeOrder(order), items: itemRows.map(safeOrderItemDetail) };
  }

  async function adminRefunds(payload) {
    await getAdmin(payload, 'refunds.read');
    const listed = await store.list('refunds', { orderBy: [{ field: 'createdAt', direction: 'desc' }], ...pageParams(payload) });
    return { ...listed, rows: listed.rows.map((refund) => safeRefund(refund, true)) };
  }

  async function adminRefund(payload) {
    await getAdmin(payload, 'refunds.read');
    const id = string(payload.id, '售后单 ID', { required: true, max: 80 });
    const refund = await store.findOne('refunds', { _id: id });
    if (!refund) fail('REFUND_NOT_FOUND', '售后申请不存在。');
    return { refund: safeRefund(refund, true), media: await resolveRefundEvidence(refund) };
  }

  async function adminOrderFulfillmentContact(payload) {
    const { admin } = await getAdmin(payload, 'orders.read');
    const id = string(payload.id, '订单 ID', { required: true, max: 80 });
    const order = await store.findOne('orders', { _id: id });
    if (!order) fail('ORDER_NOT_FOUND', '订单不存在。');
    if (order.fulfillmentType === 'pickup') {
      await audit(admin, 'orders.fulfillment_contact.read', 'order', id, { purpose: string(payload.purpose || 'pickup', '读取用途', { max: 80 }) });
      return { orderId: id, fulfillmentType: 'pickup', pickupSite: order.pickupSiteSnapshot || null };
    }
    if (!piiEncryptionKey || String(piiEncryptionKey).length < 16) fail('PII_ENCRYPTION_NOT_CONFIGURED', '个人信息加密尚未配置，不能读取履约联系方式。');
    // 优先匹配手机号密文与订单一致的地址，避免多地址用户解出与订单无关的联系方式
    const address = order.fulfillmentContactCiphertext
      ? await store.findOne('addresses', { userId: order.userId, status: 'active', phoneCiphertext: order.fulfillmentContactCiphertext }) || await store.findOne('addresses', { userId: order.userId, status: 'active' })
      : await store.findOne('addresses', { userId: order.userId, status: 'active' });
    const phoneCiphertext = order.fulfillmentContactCiphertext || (address && address.phoneCiphertext) || '';
    if (!phoneCiphertext) fail('FULFILLMENT_CONTACT_NOT_AVAILABLE', '订单关联的收货联系方式不可用。');
    const phone = decryptText(phoneCiphertext, piiEncryptionKey);
    await audit(admin, 'orders.fulfillment_contact.read', 'order', id, { purpose: string(payload.purpose || 'delivery', '读取用途', { max: 80 }) });
    return { orderId: id, fulfillmentType: 'delivery', recipient: { name: order.addressSnapshot && order.addressSnapshot.name || address.name, phone, detail: order.addressSnapshot && order.addressSnapshot.detail || address.detail, regionCode: order.addressSnapshot && order.addressSnapshot.regionCode || address.regionCode } };
  }

  async function adminExpireReservations(payload) {
    const { admin } = await getAdmin(payload, 'orders.write');
    const result = await expireReservations({ store, now: clock(), limit: integer(payload.limit, 50) });
    await audit(admin, 'orders.reservations.expire', 'inventory_reservation', '', result);
    return result;
  }

  async function adminExpireGroups(payload) {
    const { admin } = await getAdmin(payload, 'orders.write');
    const result = await expireGroups({ store, now: clock(), limit: integer(payload.limit, 50) });
    await audit(admin, 'groups.expire', 'group', '', result);
    return result;
  }

  async function userSaved(payload, kind, operation) { const user = await ensureWechatUser(); if (kind === 'favorites' && operation === 'savedList') { const result = await store.list('favorites', { where: { userId: user._id }, orderBy: [{ field: 'updatedAt', direction: 'desc' }], allowMissingCollection: true, ...pageParams(payload) }); return result; } if (kind === 'favorites' && operation === 'savedUpsert') { const skuId = string(payload.skuId, 'SKU ID', { required: true, max: 80 }); const sku = await store.findOne('product_skus', { _id: skuId, status: 'on_sale' }); const product = sku && await store.findOne('products', { _id: sku.productId, status: 'on_sale' }); if (!product || !audienceVisible(product.audienceType, user)) fail('SKU_NOT_AVAILABLE', '商品不可收藏。'); const id = require('./lib/transaction-ids').stableDocumentId('fav', [user._id, skuId]); const old = await store.getById('favorites', id); const timestamp = nowIso(clock); const item = { _id: id, userId: user._id, skuId, quantity: Math.max(1, integer(payload.quantity, 1)), createdAt: old && old.createdAt || timestamp, updatedAt: timestamp }; await store.set('favorites', id, item); return { item, idempotent: Boolean(old) }; } if (kind === 'favorites' && operation === 'savedRemove') { const id = string(payload.id, '收藏 ID', { required: true, max: 80 }); const old = await store.findOne('favorites', { _id: id, userId: user._id }); if (!old) fail('SAVED_ITEM_NOT_FOUND', '收藏不存在。'); await store.remove('favorites', id); return { id, removed: true }; } return b2b[operation]({ store, user, kind, payload, now: clock() }); }
  async function userRepurchase(payload, commit) { const user = await ensureWechatUser(); return b2b.repurchase({ store, user, payload, now: clock(), commit }); }
  async function userCreditAccount() { const user = await ensureWechatUser(); return b2b.accountGet({ store, user }); }
  async function userOrganizationList(payload, collection) { const user = await ensureWechatUser(); return b2b.organizationList({ store, user, collection, payload }); }
  async function userInquiry(payload, operation) { const user = await ensureWechatUser(); return b2b[operation]({ store, user, payload, now: clock() }); }
  async function adminCreditAccounts(payload) { await getAdmin(payload, 'credit.read'); return store.list('credit_accounts', { orderBy: [{ field: 'updatedAt', direction: 'desc' }], ...pageParams(payload) }); }
  async function adminCreditAccountUpsert(payload) { const { admin } = await getAdmin(payload, 'credit.write'); const account = await b2b.adminCreditUpsert({ store, admin, payload, now: clock() }); await audit(admin, 'credit.account.upsert', 'credit_account', account._id, { organizationId: account.organizationId, creditLimitCent: account.creditLimitCent, status: account.status, source: account.source, temporary: account.temporary }); return account; }
  async function adminFinancialList(payload, collection, permission) { await getAdmin(payload, permission); return store.list(collection, { orderBy: [{ field: 'createdAt', direction: 'desc' }], ...pageParams(payload) }); }
  async function adminSettleReceivable(payload) {
    const { admin } = await getAdmin(payload, 'receivables.write'); const id = string(payload.statementId, '对账单 ID', { required: true, max: 80 }); const amountCent = integer(payload.amountCent, 0); const idempotencyKey = string(payload.idempotencyKey, '幂等键', { required: true, max: 120 }); if (amountCent < 1) fail('VALIDATION_ERROR', '核销金额必须大于 0。');
    const note = string(payload.note, '核销备注', { max: 300 });
    const result = await store.runTransaction(async (tx) => { const operationId = require('./lib/transaction-ids').stableDocumentId('settle', [admin._id, idempotencyKey]); const oldOperation = await tx.getById('receivable_operations', operationId); if (oldOperation) { if (oldOperation.statementId !== id || oldOperation.amountCent !== amountCent) fail('IDEMPOTENCY_CONFLICT', '幂等键已用于其他核销。'); return { statement: await tx.getById('statements', id), idempotent: true }; } const statement = await tx.getById('statements', id); if (!statement || statement.status === 'paid' || amountCent > Number(statement.outstandingCent || 0)) fail('RECEIVABLE_SETTLEMENT_INVALID', '对账单不存在或核销金额不合法。'); const account = await tx.getById('credit_accounts', statement.accountId); if (!account) fail('CREDIT_ACCOUNT_NOT_FOUND', '账期账户不存在。'); const timestamp = nowIso(clock); const outstandingCent = Number(statement.outstandingCent) - amountCent; const patch = { paidCent: Number(statement.paidCent || 0) + amountCent, outstandingCent, status: outstandingCent === 0 ? 'paid' : 'partial', updatedAt: timestamp }; await tx.update('statements', id, patch); await tx.update('credit_accounts', account._id, { receivableCent: Math.max(0, Number(account.receivableCent || 0) - amountCent), updatedAt: timestamp }); await tx.set('receivable_operations', operationId, { _id: operationId, statementId: id, amountCent, note, idempotencyKey, adminId: admin._id, createdAt: timestamp }); await tx.set('receivable_ledger', operationId, { _id: operationId, organizationId: statement.organizationId, accountId: account._id, orderId: statement.orderId, statementId: id, action: 'receivable_settled', amountCent, note, occupiedChangeCent: 0, receivableChangeCent: -amountCent, idempotencyKey, createdAt: timestamp }); return { statement: { ...statement, ...patch }, idempotent: false }; }); if (!result.idempotent) await audit(admin, 'receivable.settle', 'statement', id, { amountCent, note }); return result;
  }
  async function adminInquiries(payload) { await getAdmin(payload, 'inquiries.read'); return store.list('inquiries', { orderBy: [{ field: 'createdAt', direction: 'desc' }], ...pageParams(payload) }); }
  async function adminInquiryGet(payload) { await getAdmin(payload, 'inquiries.read'); const inquiry = await store.getById('inquiries', string(payload.id, '询价单 ID', { required: true, max: 80 })); if (!inquiry) fail('INQUIRY_NOT_FOUND', '询价单不存在。'); const items = await Promise.all((inquiry.itemIds || []).map((id) => store.getById('inquiry_items', id))); const quotes = await store.list('inquiry_quotes', { where: { inquiryId: inquiry._id }, orderBy: [{ field: 'version', direction: 'desc' }], page: 1, pageSize: 100 }); return { inquiry: b2b.inquirySafe(inquiry), items: items.filter(Boolean), quotes: quotes.rows.map(b2b.quoteSafe) }; }
  async function adminInquiryQuote(payload) { const { admin } = await getAdmin(payload, 'inquiries.write'); const result = await b2b.adminInquiryQuote({ store, admin, payload, now: clock() }); await audit(admin, 'inquiry.quote', 'inquiry', payload.id, { quoteId: result.quote._id, version: result.quote.version, totalAmountCent: result.quote.totalAmountCent, source: result.quote.source, temporary: result.quote.temporary }); return result; }
  async function adminInquiryTransition(payload) { const { admin } = await getAdmin(payload, 'inquiries.write'); const result = await b2b.adminInquiryTransition({ store, payload, now: clock() }); await audit(admin, 'inquiry.transition', 'inquiry', result.inquiry._id, { status: result.inquiry.status }); return result; }
  async function marketingUser(payload, operation) { const user = await ensureWechatUser(); return marketing[operation]({ store, user, payload, now: clock() }); }
  async function reviewMediaUpload(payload) { return userUploadRefundMedia(payload, { purpose: 'review_evidence' }); }
  async function reviewEligible(payload) { const user = await ensureWechatUser(); const orders = await store.list('orders', { where: { userId: user._id, status: 'completed' }, orderBy: [{ field: 'completedAt', direction: 'desc' }], page: 1, pageSize: 100 }); const reviewed = await store.list('reviews', { where: { userId: user._id }, page: 1, pageSize: 100, allowMissingCollection: true }); const keys = new Set(reviewed.rows.map((x) => `${x.orderId}:${x.orderItemId}`)); const rows = []; for (const order of orders.rows) for (let index = 0; index < (order.itemsSnapshot || []).length; index += 1) { const item = order.itemsSnapshot[index]; const orderItemId = String(item.orderItemId || (order.itemIds || [])[index] || ''); if (orderItemId && !keys.has(`${order._id}:${orderItemId}`)) rows.push({ orderId: order._id, orderNo: order.orderNo, completedAt: order.completedAt, orderItemId, ...safeOrderItem(item) }); } const paging = pageParams(payload); const start = (paging.page - 1) * paging.pageSize; return { rows: rows.slice(start, start + paging.pageSize), total: rows.length, ...paging }; }
  async function invoiceTitleDelete(payload) { const user = await ensureWechatUser(); const id = string(payload.id, '发票抬头 ID', { required: true, max: 80 }); const title = await store.findOne('invoice_titles', { _id: id, userId: user._id }); if (!title) fail('INVOICE_TITLE_NOT_FOUND', '发票抬头不存在。'); await store.remove('invoice_titles', id); return { id, removed: true }; }
  function invoiceTitleForOwner(title) { return { ...pick(title, ['_id', 'type', 'name', 'address', 'bankName', 'createdAt', 'updatedAt']), taxNo: title.taxNoCiphertext ? decryptText(title.taxNoCiphertext, piiEncryptionKey) : String(title.taxNo || ''), bankAccount: title.bankAccountCiphertext ? decryptText(title.bankAccountCiphertext, piiEncryptionKey) : String(title.bankAccount || '') }; }
  async function invoiceTitleList(payload) { const user = await ensureWechatUser(); if (!piiEncryptionKey || String(piiEncryptionKey).length < 16) fail('PII_ENCRYPTION_NOT_CONFIGURED', '个人信息加密尚未配置，不能读取发票抬头。'); const listed = await store.list('invoice_titles', { where: { userId: user._id }, orderBy: [{ field: 'createdAt', direction: 'desc' }], allowMissingCollection: true, ...pageParams(payload) }); return { ...listed, rows: listed.rows.map(invoiceTitleForOwner) }; }
  async function invoiceTitleUpsert(payload) { const user = await ensureWechatUser(); if (!piiEncryptionKey || String(piiEncryptionKey).length < 16) fail('PII_ENCRYPTION_NOT_CONFIGURED', '个人信息加密尚未配置，不能保存发票抬头。'); const type = payload.type === 'company' ? 'company' : 'personal'; const id = string(payload.id || require('./lib/transaction-ids').stableDocumentId('invtitle', [user._id, nowIso(clock)]), '发票抬头 ID', { required: true, max: 80 }); const old = await store.getById('invoice_titles', id); if (old && old.userId !== user._id) fail('INVOICE_TITLE_NOT_FOUND', '发票抬头不存在。'); const name = string(payload.name, '抬头名称', { required: true, max: 100 }); const taxNo = type === 'company' ? string(payload.taxNo, '税号', { required: true, max: 30 }) : ''; const bankAccount = string(payload.bankAccount, '银行账号', { max: 80 }); const timestamp = nowIso(clock); const row = { _id: id, userId: user._id, type, name, taxNoCiphertext: taxNo ? encryptText(taxNo, piiEncryptionKey) : '', taxNoMasked: maskSensitive(taxNo), address: string(payload.address, '注册地址', { max: 200 }), bankName: string(payload.bankName, '开户行', { max: 100 }), bankAccountCiphertext: bankAccount ? encryptText(bankAccount, piiEncryptionKey) : '', bankAccountMasked: maskSensitive(bankAccount), createdAt: old && old.createdAt || timestamp, updatedAt: timestamp }; await store.set('invoice_titles', id, row); return { title: invoiceTitleForOwner(row) }; }
  async function adminMarketingList(payload, collection, permission) { await getAdmin(payload, permission); return store.list(collection, { orderBy: [{ field: 'createdAt', direction: 'desc' }], ...pageParams(payload) }); }
  async function adminBundleUpsert(payload) { const { admin } = await getAdmin(payload, 'marketing.write'); const row = await marketing.adminBundleUpsert({ store, admin, payload, now: clock() }); await audit(admin, 'bundle.upsert', 'bundle', row._id, { status: row.status, source: row.source, temporary: row.temporary }); return row; }
  async function adminBundleSetStatus(payload) { const { admin } = await getAdmin(payload, 'marketing.write'); const id = string(payload.id, '套餐 ID', { required: true, max: 80 }); const status = string(payload.status, '套餐状态', { required: true, max: 20 }); if (!['active', 'disabled'].includes(status)) fail('VALIDATION_ERROR', '套餐状态不合法。'); const row = await store.getById('bundles', id); if (!row) fail('BUNDLE_NOT_FOUND', '套餐不存在。'); if (status === 'active' && (row.temporary === true || row.source === 'ai_generated')) fail('DRAFT_CANNOT_ACTIVATE', 'AI 或临时套餐草案不能启用。'); const patch = { status, version: Number(row.version || 0) + 1, updatedBy: admin._id, updatedAt: nowIso(clock) }; await store.update('bundles', id, patch); await audit(admin, 'bundle.set_status', 'bundle', id, { status }); return { ...row, ...patch }; }
  async function adminCouponUpsert(payload) { const { admin } = await getAdmin(payload, 'marketing.write'); const row = await marketing.adminCouponUpsert({ store, admin, payload, now: clock() }); await audit(admin, 'coupon_template.upsert', 'coupon_template', row._id, { status: row.status, source: row.source, temporary: row.temporary }); return row; }
  async function adminReviewDecision(payload) { const { admin } = await getAdmin(payload, 'reviews.write'); const id = string(payload.id, '评价 ID', { required: true, max: 80 }); const decision = string(payload.decision, '审核结果', { required: true, max: 20 }); if (!['approved', 'rejected'].includes(decision)) fail('VALIDATION_ERROR', '审核结果不合法。'); const review = await store.getById('reviews', id); if (!review || review.status !== 'pending') fail('REVIEW_NOT_FOUND', '评价不存在或已审核。'); const timestamp = nowIso(clock); const patch = { status: decision, reviewNote: string(payload.note, '审核备注', { max: 300 }), reviewedBy: admin._id, reviewedAt: timestamp, updatedAt: timestamp }; if (typeof store.runTransaction !== 'function') fail('TRANSACTION_NOT_AVAILABLE', '当前环境不支持评价审核事务。'); await store.runTransaction(async (tx) => { const current = await tx.getById('reviews', id); if (!current || current.status !== 'pending') fail('REVIEW_NOT_FOUND', '评价不存在或已审核。'); await tx.update('reviews', id, patch); for (const mediaId of current.mediaIds || []) { const media = await tx.getById('media_assets', mediaId); if (media && media.userId === current.userId && media.purpose === 'review_evidence') await tx.update('media_assets', mediaId, { publicApproved: decision === 'approved', reviewId: id, updatedAt: timestamp }); } }); await audit(admin, 'review.review', 'review', id, { decision }); return { review: { ...review, ...patch } }; }
  async function adminInvoiceProcess(payload) { const { admin } = await getAdmin(payload, 'invoices.write'); const id = string(payload.id, '发票申请 ID', { required: true, max: 80 }); const action = string(payload.action, '处理动作', { required: true, max: 30 }); if (!['pending_manual', 'rejected'].includes(action)) fail(action === 'issued' ? 'INVOICE_PROVIDER_UNCONFIGURED' : 'VALIDATION_ERROR', action === 'issued' ? '开票服务商未配置，不能标记已开票。' : '发票处理动作不合法。'); const invoice = await store.getById('invoices', id); if (!invoice) fail('INVOICE_NOT_FOUND', '发票申请不存在。'); const patch = { status: action, note: string(payload.note, '处理备注', { max: 300 }), processedBy: admin._id, updatedAt: nowIso(clock) }; await store.update('invoices', id, patch); await audit(admin, 'invoice.process', 'invoice', id, { action }); return { invoice: { ...invoice, ...patch } }; }
  function maskSensitive(value) { const text = String(value || ''); return text.length <= 4 ? (text ? '****' : '') : `${'*'.repeat(Math.min(8, text.length - 4))}${text.slice(-4)}`; }
  function safeAdminInvoice(invoice) { const title = invoice.titleSnapshot || {}; return { ...pick(invoice, ['_id', 'userId', 'organizationId', 'orderId', 'amountCent', 'email', 'status', 'providerStatus', 'note', 'createdAt', 'updatedAt']), titleSnapshot: { _id: title._id, type: title.type, name: title.name, taxNoMasked: title.taxNoMasked || maskSensitive(title.taxNo), address: title.address || '', bankName: title.bankName || '', bankAccountMasked: title.bankAccountMasked || maskSensitive(title.bankAccount) } }; }
  async function adminInvoices(payload) { await getAdmin(payload, 'invoices.read'); const listed = await store.list('invoices', { orderBy: [{ field: 'createdAt', direction: 'desc' }], ...pageParams(payload) }); return { ...listed, rows: listed.rows.map(safeAdminInvoice) }; }
  async function adminInvoiceGet(payload) { const { admin } = await getAdmin(payload, 'invoices.read'); const id = string(payload.id, '发票申请 ID', { required: true, max: 80 }); const invoice = await store.getById('invoices', id); if (!invoice) fail('INVOICE_NOT_FOUND', '发票申请不存在。'); await audit(admin, 'invoice.read', 'invoice', id, {}); return { invoice: safeAdminInvoice(invoice) }; }
  async function adminMembershipLevelUpsert(payload) { const { admin } = await getAdmin(payload, 'points.write'); const source = payload.source === 'client' ? 'client' : 'ai_generated'; const temporary = payload.temporary !== false; const status = ['draft', 'active', 'disabled'].includes(payload.status) ? payload.status : 'draft'; if (status === 'active' && (temporary || source !== 'client')) fail('DRAFT_CANNOT_ACTIVATE', 'AI 或临时会员等级草案不能启用。'); const id = string(payload.id || require('./lib/transaction-ids').stableDocumentId('membership', [String(payload.code || payload.name || ''), nowIso(clock)]), '会员等级 ID', { required: true, max: 80 }); const old = await store.getById('membership_levels', id); const row = { _id: id, code: string(payload.code, '等级编码', { required: true, max: 40 }), name: string(payload.name, '等级名称', { required: true, max: 80 }), minPoints: Math.max(0, integer(payload.minPoints, 0)), rewardRateBps: Math.max(0, integer(payload.rewardRateBps, 0)), benefits: Array.isArray(payload.benefits) ? payload.benefits.slice(0, 20).map(String) : [], status, source, temporary, version: Number(old && old.version || 0) + 1, createdAt: old && old.createdAt || nowIso(clock), updatedAt: nowIso(clock), updatedBy: admin._id }; await store.set('membership_levels', id, row); await audit(admin, 'membership_level.upsert', 'membership_level', id, { status, source, temporary }); return row; }
  async function adminPointsAdjust(payload) { const { admin } = await getAdmin(payload, 'points.write'); const userId = string(payload.userId, '用户 ID', { required: true, max: 80 }); const change = integer(payload.change, 0); const key = string(payload.idempotencyKey, '幂等键', { required: true, max: 120 }); const reason = string(payload.reason, '调整原因', { required: true, max: 300 }); if (!change) fail('VALIDATION_ERROR', '积分调整值不能为 0。'); const ids = require('./lib/transaction-ids'); const ledgerId = ids.stableDocumentId('points_admin', [admin._id, key]); const accountId = ids.stableDocumentId('points', [userId]); const result = await store.runTransaction(async (tx) => { const oldLedger = await tx.getById('points_ledger', ledgerId); if (oldLedger) { if (oldLedger.userId !== userId || oldLedger.change !== change) fail('IDEMPOTENCY_CONFLICT', '幂等键已用于其他积分调整。'); return { ledger: oldLedger, account: await tx.getById('points_accounts', accountId), idempotent: true }; } const account = await tx.getById('points_accounts', accountId) || { _id: accountId, userId, balance: 0, lifetimeEarned: 0 }; const balance = Number(account.balance || 0) + change; if (balance < 0) fail('POINTS_BALANCE_INSUFFICIENT', '积分余额不足。'); const timestamp = nowIso(clock); const ledger = { _id: ledgerId, userId, action: 'admin_adjust', change, balanceAfter: balance, reason, adminId: admin._id, idempotencyKey: key, createdAt: timestamp }; const nextAccount = { ...account, balance, lifetimeEarned: Number(account.lifetimeEarned || 0) + Math.max(0, change), updatedAt: timestamp }; await tx.set('points_ledger', ledgerId, ledger); await tx.set('points_accounts', accountId, nextAccount); return { ledger, account: nextAccount, idempotent: false }; }); if (!result.idempotent) await audit(admin, 'points.adjust', 'user', userId, { change, reason }); return result; }
  async function adminPointsRuleUpsert(payload) { const { admin } = await getAdmin(payload, 'points.write'); const source = payload.source === 'client' ? 'client' : 'ai_generated'; const temporary = payload.temporary !== false; const status = ['draft', 'active', 'disabled'].includes(payload.status) ? payload.status : 'draft'; if (status === 'active' && (temporary || source !== 'client')) fail('DRAFT_CANNOT_ACTIVATE', 'AI 或临时积分规则草案不能启用。'); const id = require('./lib/transaction-ids').stableDocumentId('points_rule', ['order_reward']); const old = await store.getById('points_rules', id); const row = { _id: id, code: 'order_reward', pointsPerYuan: Math.max(0, integer(payload.pointsPerYuan, 0)), status, source, temporary, version: Number(old && old.version || 0) + 1, updatedBy: admin._id, createdAt: old && old.createdAt || nowIso(clock), updatedAt: nowIso(clock) }; if (status === 'active' && row.pointsPerYuan < 1) fail('VALIDATION_ERROR', '正式订单积分规则必须配置正数奖励值。'); await store.set('points_rules', id, row); await audit(admin, 'points.rule.upsert', 'points_rule', id, { status, source, temporary }); return row; }
  async function adminWebAccounts(payload) { await getAdmin(payload, 'users.read'); const listed = await store.list('web_login_accounts', { orderBy: [{ field: 'createdAt', direction: 'desc' }], ...pageParams(payload) }); return { ...listed, rows: listed.rows.map(webAuth.safeAccount) }; }
  async function adminWebAccountUpsert(payload) { const { admin } = await getAdmin(payload, 'users.write'); const account = await webAuth.upsertAccount({ store, admin, payload, now: clock() }); await audit(admin, 'web_account.upsert', 'web_login_account', account._id, { userId: account.userId, status: account.status }); return { account }; }
  async function adminWebAccountStatus(payload) { const { admin } = await getAdmin(payload, 'users.write'); const account = await webAuth.setStatus({ store, admin, payload, now: clock() }); await audit(admin, 'web_account.set_status', 'web_login_account', account._id, { status: account.status }); return { account }; }
  async function adminWebAccountResetPassword(payload) { const { admin } = await getAdmin(payload, 'users.write'); const account = await webAuth.resetPassword({ store, admin, payload, now: clock() }); await audit(admin, 'web_account.reset_password', 'web_login_account', account._id, {}); return { account, sessionsRevoked: true }; }
  async function groupsMine(payload) { const user = await ensureWechatUser(); const memberships = await store.list('group_members', { where: { userId: user._id }, orderBy: [{ field: 'createdAt', direction: 'desc' }], ...pageParams(payload) }); const rows = []; for (const member of memberships.rows) { const group = await store.getById('groups', member.groupId); if (group) rows.push({ group: safeGroup(group), member: pick(member, ['_id', 'status', 'paidAt', 'createdAt']) }); } return { ...memberships, rows }; }
  async function groupRefundTasks(payload) { await getAdmin(payload, 'refunds.read'); const groups = await store.list('groups', { where: { status: 'failed' }, page: 1, pageSize: 100 }); const rows = groups.rows.filter((x) => Number(x.refundRequired || 0) > 0).map(safeGroup); return { rows, total: rows.length, page: 1, pageSize: 100 }; }

  async function runMaintenance(payload = {}) {
    const limit = integer(payload.limit, 50);
    const reservations = await expireReservations({ store, now: clock(), limit });
    const groups = await expireGroups({ store, now: clock(), limit });
    await audit(null, 'system.maintenance.tick', 'maintenance', '', { reservations, groups });
    return { reservations, groups };
  }

  const adminOps = createAdminOperations({
    store, clock, getAdmin, audit, safeOrder, safeOrderItemDetail, safeAdminInvoice,
    upsertProduct: adminUpsertProduct,
    upsertPrice: adminUpsertPrice,
    transitionOrder: adminTransitionOrder
  });

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
    'auth.wechatLogin': async () => ({ user: pick(await ensureMiniUser(), ['_id', 'userType', 'status', 'organizationId', 'businessStatus', 'lastLoginAt']) }),
    'auth.web.login': webLogin,
    'auth.webLogin': webLogin,
    'auth.web.me': webMe,
    'auth.web.logout': webLogout,
    'auth.web.password.change': webPasswordChange,
    'auth.me': async () => ({ user: pick(await ensureWechatUser(), ['_id', 'userType', 'status', 'organizationId', 'businessStatus', 'lastLoginAt']) }),
    'auth.applyBusiness': applyBusiness,
    'address.list': userAddresses,
    'address.upsert': userUpsertAddress,
    'address.setDefault': userSetDefaultAddress,
    'address.delete': userDeleteAddress,
    'cart.list': userCart,
    'cart.upsert': userUpsertCartItem,
    'cart.remove': userRemoveCartItem,
    'favorites.list': (payload) => userSaved(payload, 'favorites', 'savedList'),
    'favorites.upsert': (payload) => userSaved(payload, 'favorites', 'savedUpsert'),
    'favorites.remove': (payload) => userSaved(payload, 'favorites', 'savedRemove'),
    'favorites.batchAddToCart': (payload) => userSaved(payload, 'favorites', 'savedBatchAdd'),
    'frequent.list': (payload) => userSaved(payload, 'frequent_items', 'savedList'),
    'frequent.upsert': (payload) => userSaved(payload, 'frequent_items', 'savedUpsert'),
    'frequent.remove': (payload) => userSaved(payload, 'frequent_items', 'savedRemove'),
    'frequent.batchAddToCart': (payload) => userSaved(payload, 'frequent_items', 'savedBatchAdd'),
    'orders.repurchase.preview': (payload) => userRepurchase(payload, false),
    'orders.repurchase.commit': (payload) => userRepurchase(payload, true),
    'procurement.account.get': userCreditAccount,
    'procurement.receivables.list': (payload) => userOrganizationList(payload, 'receivable_ledger'),
    'procurement.statements.list': (payload) => userOrganizationList(payload, 'statements'),
    'inquiries.create': (payload) => userInquiry(payload, 'inquiryCreate'),
    'inquiries.list': (payload) => userInquiry(payload, 'inquiryList'),
    'inquiries.get': (payload) => userInquiry(payload, 'inquiryGet'),
    'inquiries.accept': (payload) => userInquiry(payload, 'inquiryAccept'),
    'checkout.quote': checkoutQuote,
    'orders.create': userCreateOrder,
    'orders.list': userOrders,
    'orders.get': userOrder,
    'orders.cancel': userCancelOrder,
    'orders.complete': userCompleteOrder,
    'payments.wechat.notify': wechatPaymentNotify,
    'payments.wechat.prepare': userPreparePayment,
    'refunds.request': userRequestRefund,
    'refunds.list': userRefunds,
    'refunds.get': userRefund,
    'refunds.media.upload': userUploadRefundMedia,
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
    'groups.mine': groupsMine,
    'groups.my.list': groupsMine,
    'bundles.list': (payload) => marketing.bundleList({ store, payload, now: clock() }),
    'bundles.get': (payload) => marketing.bundleGet({ store, payload, now: clock() }),
    'bundles.quote': (payload) => marketingUser(payload, 'bundleQuote'),
    'coupons.templates': (payload) => marketing.couponTemplates({ store, payload, now: clock() }),
    'coupons.claim': (payload) => marketingUser(payload, 'couponClaim'),
    'coupons.list': (payload) => marketingUser(payload, 'couponList'),
    'points.account': (payload) => marketingUser(payload, 'pointsAccount'),
    'points.account.get': (payload) => marketingUser(payload, 'pointsAccount'),
    'points.signIn': (payload) => marketingUser(payload, 'pointsSignIn'),
    'points.checkin': (payload) => marketingUser(payload, 'pointsSignIn'),
    'points.ledger': (payload) => marketingUser({ ...payload, collection: 'points_ledger' }, 'userRows'),
    'membership.profile': (payload) => marketingUser(payload, 'membership'),
    'reviews.media.upload': reviewMediaUpload,
    'reviews.eligible': reviewEligible,
    'reviews.create': (payload) => marketingUser(payload, 'reviewCreate'),
    'reviews.mine': (payload) => marketingUser({ ...payload, collection: 'reviews' }, 'userRows'),
    'reviews.list': (payload) => marketing.publicReviews({ store, payload }),
    'invoiceTitles.list': invoiceTitleList,
    'invoiceTitles.upsert': invoiceTitleUpsert,
    'invoiceTitles.delete': invoiceTitleDelete,
    'invoice.headers.list': invoiceTitleList,
    'invoice.headers.upsert': invoiceTitleUpsert,
    'invoice.headers.delete': invoiceTitleDelete,
    'invoices.request': (payload) => marketingUser(payload, 'invoiceRequest'),
    'invoices.list': (payload) => marketingUser({ ...payload, collection: 'invoices' }, 'userRows'),
    'invoices.get': async (payload) => { const user = await ensureWechatUser(); const invoice = await store.findOne('invoices', { _id: string(payload.id, '发票 ID', { required: true, max: 80 }), userId: user._id }); if (!invoice) fail('INVOICE_NOT_FOUND', '发票申请不存在。'); return { invoice }; },
    'storedValue.account': (payload) => marketingUser(payload, 'storedAccount'),
    'wallet.account.get': (payload) => marketingUser(payload, 'storedAccount'),
    'storedValue.ledger': (payload) => marketingUser({ ...payload, collection: 'stored_value_ledger' }, 'userRows'),
    'storedValue.topupIntent': (payload) => marketingUser(payload, 'topupIntent'),
    'wallet.recharge.prepare': (payload) => marketingUser(payload, 'topupIntent'),
    'admin.bootstrap': adminBootstrap,
    'admin.login': adminLogin,
    'admin.logout': adminLogout,
    'admin.password.change': adminChangeOwnPassword,
    'admin.me': async (payload) => { const { admin, permissions } = await getAdmin(payload); return { admin: cleanAdmin(admin, permissions) }; },
    'admin.readiness': adminReadiness,
    'admin.roles.list': adminRoles,
    'admin.roles.upsert': adminUpsertRole,
    'admin.roles.setStatus': adminOps.roleSetStatus,
    'admin.permissions.catalog': adminOps.permissionsCatalog,
    'admin.adminUsers.list': adminAdminUsers,
    'admin.adminUsers.upsert': adminUpsertAdminUser,
    'admin.categories.list': (payload) => adminList('categories', payload, 'catalog.read', { orderBy: [{ field: 'sort', direction: 'asc' }] }),
    'admin.categories.upsert': adminUpsertCategory,
    'admin.products.list': (payload) => adminList('products', payload, 'catalog.read'),
    'admin.products.upsert': (payload) => adminOps.versionedUpsert('product', adminUpsertProduct, payload),
    'admin.products.batchUpsert': adminOps.productsBatch,
    'admin.products.setStatus': adminSetProductStatus,
    'admin.skus.list': (payload) => adminList('product_skus', payload, 'catalog.read'),
    'admin.skus.upsert': adminUpsertSku,
    'admin.skus.setStatus': adminSetSkuStatus,
    'admin.prices.list': (payload) => adminList('prices', payload, 'pricing.read'),
    'admin.prices.upsert': (payload) => adminOps.versionedUpsert('price', adminUpsertPrice, payload),
    'admin.prices.batchUpsert': adminOps.pricesBatch,
    'admin.demo.seedCommerce': adminSeedDemoCommerce,
    'admin.groupCampaigns.list': (payload) => adminList('group_campaigns', payload, 'marketing.read', { orderBy: [{ field: 'sort', direction: 'asc' }] }),
    'admin.groupCampaigns.upsert': (payload) => adminOps.versionedUpsert('groupCampaign', adminUpsertGroupCampaign, payload),
    'admin.users.list': adminUsers,
    'admin.users.setPricingProfile': adminSetUserPricingProfile,
    'admin.webAccounts.list': adminWebAccounts,
    'admin.webAccounts.upsert': adminWebAccountUpsert,
    'admin.webAccounts.setStatus': adminWebAccountStatus,
    'admin.webAccounts.resetPassword': adminWebAccountResetPassword,
    'admin.businessApplications.list': adminBusinessApplications,
    'admin.businessApplications.review': adminReviewBusinessApplication,
    'admin.warehouses.list': (payload) => adminList('warehouses', payload, 'inventory.read', { orderBy: [{ field: 'sort', direction: 'asc' }] }),
    'admin.warehouses.upsert': adminUpsertWarehouse,
    'admin.inventory.list': (payload) => adminList('inventory', payload, 'inventory.read'),
    'admin.inventory.adjust': adminAdjustInventory,
    'admin.inventory.ledger': adminOps.inventoryLedger,
    'admin.deliveryAreas.list': (payload) => adminList('delivery_areas', payload, 'delivery.read', { orderBy: [{ field: 'sort', direction: 'asc' }] }),
    'admin.deliveryAreas.upsert': adminUpsertDeliveryArea,
    'admin.freightRules.list': (payload) => adminList('freight_rules', payload, 'delivery.read'),
    'admin.freightRules.upsert': adminUpsertFreightRule,
    'admin.deliverySlots.list': (payload) => adminList('delivery_slots', payload, 'delivery.read', { orderBy: [{ field: 'sort', direction: 'asc' }] }),
    'admin.deliverySlots.upsert': adminUpsertDeliverySlot,
    'admin.pickupSites.list': (payload) => adminList('pickup_sites', payload, 'delivery.read', { orderBy: [{ field: 'sort', direction: 'asc' }] }),
    'admin.pickupSites.upsert': adminUpsertPickupSite,
    'admin.orders.list': adminOps.ordersSearch,
    'admin.orders.get': adminOrder,
    'admin.orders.notes.list': adminOps.orderNotes,
    'admin.orders.notes.add': adminOps.orderNote,
    'admin.orders.batchTransition': adminOps.ordersBatchTransition,
    'admin.orders.export': adminOps.ordersExport,
    'admin.orders.pickingList': adminOps.pickingList,
    'admin.orders.fulfillmentContact': adminOrderFulfillmentContact,
    'admin.orders.transition': adminTransitionOrder,
    'admin.refunds.list': adminRefunds,
    'admin.refunds.get': adminRefund,
    'admin.refunds.review': adminReviewRefund,
    'admin.refunds.process': adminProcessRefund,
    'admin.creditAccounts.list': adminCreditAccounts,
    'admin.creditAccounts.upsert': adminCreditAccountUpsert,
    'admin.receivables.list': adminOps.receivables,
    'admin.receivables.settle': adminSettleReceivable,
    'admin.statements.list': adminOps.statements,
    'admin.inquiries.list': adminInquiries,
    'admin.inquiries.get': adminInquiryGet,
    'admin.inquiries.quote': adminInquiryQuote,
    'admin.inquiries.transition': adminInquiryTransition,
    'admin.bundles.list': (payload) => adminMarketingList(payload, 'bundles', 'marketing.read'),
    'admin.bundles.upsert': (payload) => adminOps.versionedUpsert('bundle', adminBundleUpsert, payload),
    'admin.bundles.setStatus': (payload) => adminOps.versionedUpsert('bundle', adminBundleSetStatus, payload),
    'admin.groups.list': (payload) => adminMarketingList(payload, 'groups', 'marketing.read'),
    'admin.groups.members': adminOps.groupMembers,
    'admin.groups.refundTasks': groupRefundTasks,
    'admin.couponTemplates.list': (payload) => adminMarketingList(payload, 'coupon_templates', 'marketing.read'),
    'admin.couponTemplates.upsert': (payload) => adminOps.versionedUpsert('couponTemplate', adminCouponUpsert, payload),
    'admin.couponGrants.list': adminOps.couponGrants,
    'admin.membershipLevels.list': (payload) => adminMarketingList(payload, 'membership_levels', 'marketing.read'),
    'admin.membershipLevels.upsert': (payload) => adminOps.versionedUpsert('membershipLevel', adminMembershipLevelUpsert, payload),
    'admin.points.adjust': adminPointsAdjust,
    'admin.points.accounts.list': adminOps.pointsAccounts,
    'admin.points.ledger': adminOps.pointsLedger,
    'admin.points.rules.list': (payload) => adminMarketingList(payload, 'points_rules', 'points.read'),
    'admin.points.rules.upsert': (payload) => adminOps.versionedUpsert('pointsRule', adminPointsRuleUpsert, payload),
    'admin.reviews.list': adminOps.reviews,
    'admin.reviews.review': adminReviewDecision,
    'admin.invoices.list': adminOps.invoices,
    'admin.invoices.get': adminInvoiceGet,
    'admin.invoices.process': adminInvoiceProcess,
    'admin.storedValue.list': (payload) => adminMarketingList(payload, 'stored_value_accounts', 'storedValue.read'),
    'admin.storedValue.ledger': adminOps.storedValueLedger,
    'admin.jobs.expireReservations': adminExpireReservations,
    'admin.jobs.expireGroups': adminExpireGroups,
    'admin.imports.list': (payload) => adminList('import_jobs', payload, 'imports.read'),
    'admin.imports.stage': stageImport,
    'admin.imports.approve': approveImport,
    'admin.imports.activateBatch': activateImportBatch,
    'admin.media.list': (payload) => adminList('media_assets', payload, 'media.read'),
    'admin.media.upload': adminUploadMedia,
    'admin.media.upsert': (payload) => adminOps.versionedUpsert('media', adminUpsertMedia, payload),
    'admin.media.createVersion': adminCreateMediaVersion,
    'admin.productMedia.list': adminListProductMedia,
    'admin.productMedia.upsert': adminUpsertProductMedia,
    'admin.banners.list': (payload) => adminList('banners', payload, 'content.read', { orderBy: [{ field: 'sort', direction: 'asc' }] }),
    'admin.banners.upsert': (payload) => adminOps.versionedUpsert('banner', (input) => adminUpsertContent(input, 'banners', 'content.write', '轮播图'), payload),
    'admin.homeSections.list': (payload) => adminList('home_sections', payload, 'content.read', { orderBy: [{ field: 'sort', direction: 'asc' }] }),
    'admin.homeSections.upsert': (payload) => adminOps.versionedUpsert('homeSection', (input) => adminUpsertContent(input, 'home_sections', 'content.write', '首页模块'), payload),
    'admin.versions.list': adminOps.versionsList,
    'admin.versions.rollback': adminOps.versionsRollback,
    'admin.audit.list': (payload) => adminList('audit_logs', payload, 'audit.read')
  };

  async function dispatch(event = {}) {
    return requestScope.run({ payload: event.payload || {}, requestId: event.requestId || '' }, async () => { try {
      const action = string(event.action, 'action', { required: true, max: 80 });
      const handler = handlers[action];
      if (!handler) return { ok: false, data: null, error: { code: 'NOT_IMPLEMENTED', message: `路由 ${action} 尚未实现。` }, requestId: event.requestId || '' };
      return success(await handler(event.payload || {}), event.requestId);
    }
    catch (error) { return failure(error, event.requestId); } });
  }

  return { dispatch, runMaintenance };
}

module.exports = { createApplication };
