const { fail } = require('./response');
const { collectPageMatches } = require('./collection-read');

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const PUBLIC_PRODUCT_FIELDS = ['_id', 'spuCode', 'name', 'subtitle', 'categoryId', 'categoryName', 'brand', 'origin', 'storageType', 'frozenTemperature', 'shelfLifeDays', 'coverMediaId', 'audienceType', 'sort'];
const PUBLIC_SKU_FIELDS = ['_id', 'skuCode', 'productId', 'specName', 'netWeight', 'weightUnit', 'piecesPerCase', 'packageUnit', 'barcode', 'mediaIds'];

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
  return pick(order, ['_id', 'orderNo', 'warehouseId', 'deliveryAreaId', 'addressSnapshot', 'deliverySlotSnapshot', 'pricingSnapshot', 'freightSnapshot', 'totalAmountCent', 'paymentMethod', 'paymentStatus', 'receivedAmountCent', 'outstandingAmountCent', 'collectionStatus', 'refundStatus', 'groupId', 'groupCampaignId', 'groupStatus', 'status', 'shipInfo', 'createdAt', 'updatedAt', 'cancelledAt', 'completedAt']);
}
function safeOrderItem(item) {
  return pick(item, ['_id', 'skuId', 'productId', 'productNameSnapshot', 'specSnapshot', 'packageUnitSnapshot', 'quantity', 'mediaSnapshot']);
}
function safeUser(user) {
  return pick(user, ['_id', 'userType', 'organizationId', 'priceLevel', 'businessStatus', 'status', 'createdAt', 'updatedAt', 'lastLoginAt']);
}
function safeGroup(group) {
  return pick(group, ['_id', 'groupNo', 'campaignId', 'groupSize', 'memberCount', 'reservedMemberCount', 'status', 'expiresAt', 'successAt', 'createdAt', 'updatedAt']);
}
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
    role: admin.staffRole || (permissions.includes('*') ? 'super_admin' : 'legacy'),
    phoneMasked: admin.phoneMasked || '',
    phoneVerificationStatus: admin.phoneVerificationStatus === 'verified' && admin.phoneVerifiedAt ? 'verified' : 'unverified',
    phoneVerifiedAt: admin.phoneVerificationStatus === 'verified' ? admin.phoneVerifiedAt || null : null,
    roleIds: admin.roleIds || [],
    permissions,
    status: admin.status,
    lastLoginAt: admin.lastLoginAt || null
  };
}

module.exports = { SESSION_TTL_MS, LOGIN_WINDOW_MS, LOGIN_MAX_FAILURES, PUBLIC_PRODUCT_FIELDS, PUBLIC_SKU_FIELDS, nowIso, string, integer, demoMetadata, pageParams, pick, publicProduct, publicSku, publicProductsWithSkus, maskedPhone, safeAddress, safeOrder, safeOrderItem, safeUser, safeGroup, isScheduledEnabled, cleanAdmin };
