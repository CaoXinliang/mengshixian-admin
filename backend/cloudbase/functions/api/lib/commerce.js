const { fail } = require('./response');
const { randomId } = require('./security');
const {
  inventoryId,
  orderId,
  paymentId,
  reservationId,
  orderItemId,
  inventoryLedgerId
} = require('./transaction-ids');
const { active: activeGroupCampaign, reserveSlot, releaseSlot, recordPaidMember } = require('./groups');
const { collectPageMatches } = require('./collection-read');
const { reserveCredit, releaseCredit } = require('./b2b-credit');

function cents(value, label) {
  if (Number.isInteger(value) && value >= 0) return value;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) fail('VALIDATION_ERROR', `${label}必须是非负金额。`);
  return Math.round(parsed * 100);
}
function iso(now) { return now.toISOString(); }
function audienceVisible(audienceType, userOrType) {
  const audience = ['all', 'c', 'b'].includes(audienceType) ? audienceType : 'all';
  const viewerType = typeof userOrType === 'string'
    ? (userOrType === 'b' ? 'b' : 'c')
    : (userOrType && userOrType.userType === 'b' ? 'b' : 'c');
  return audience === 'all' || audience === viewerType;
}
function active(item, now) {
  if (!item || item.status === 'disabled' || item.status === 'archived' || item.enabled === false) return false;
  const point = now.getTime();
  return !(item.validFrom && new Date(item.validFrom).getTime() > point) && !(item.validTo && new Date(item.validTo).getTime() < point);
}
function pageItems(items) {
  // 与建单上限（ORDER_ITEM_LIMIT=20）保持一致，避免报价成功但建单必败
  if (!Array.isArray(items) || !items.length || items.length > 20) fail('VALIDATION_ERROR', '结算商品必须为 1 到 20 条。');
  const merged = new Map();
  items.forEach((item) => {
    const skuId = String(item && item.skuId || '').trim();
    const quantity = Number(item && item.quantity);
    if (!skuId || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) fail('VALIDATION_ERROR', 'SKU 或购买数量不合法。');
    merged.set(skuId, (merged.get(skuId) || 0) + quantity);
  });
  if ([...merged.values()].some((quantity) => quantity > 999)) fail('VALIDATION_ERROR', '同一 SKU 合并后的购买数量不能超过 999。');
  return [...merged.entries()].map(([skuId, quantity]) => ({ skuId, quantity }));
}
function allocatePaidSubtotals(items, paidGoodsAmountCent) {
  const original = items.reduce((sum, item) => sum + Number(item.subtotalCent || 0), 0);
  if (!original) return items.map((item) => ({ ...item, paidSubtotalCent: 0, refundableAmountCent: 0 }));
  const allocated = items.map((item) => {
    const numerator = Number(item.subtotalCent || 0) * paidGoodsAmountCent;
    return { item, amount: Math.floor(numerator / original), remainder: numerator % original };
  });
  let remaining = paidGoodsAmountCent - allocated.reduce((sum, row) => sum + row.amount, 0);
  allocated.sort((a, b) => b.remainder - a.remainder || String(a.item.skuId).localeCompare(String(b.item.skuId)));
  for (let index = 0; index < allocated.length && remaining > 0; index += 1, remaining -= 1) allocated[index].amount += 1;
  const bySku = new Map(allocated.map((row) => [row.item.skuId, row.amount]));
  return items.map((item) => ({ ...item, paidSubtotalCent: bySku.get(item.skuId) || 0, refundableAmountCent: bySku.get(item.skuId) || 0 }));
}
function normalizeQuantityTiers(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail('VALIDATION_ERROR', '数量阶梯价必须是数组。');
  if (value.length > 20) fail('VALIDATION_ERROR', '单条价格规则最多配置 20 个数量阶梯。');
  const tiers = value.map((item) => {
    const minQuantity = Number(item && item.minQuantity);
    const rawMax = item && item.maxQuantity;
    const maxQuantity = rawMax === undefined || rawMax === null || rawMax === '' ? null : Number(rawMax);
    if (!Number.isInteger(minQuantity) || minQuantity < 1 || minQuantity > 999) fail('VALIDATION_ERROR', '阶梯起始数量必须是 1 到 999 的整数。');
    if (maxQuantity !== null && (!Number.isInteger(maxQuantity) || maxQuantity < minQuantity || maxQuantity > 999)) fail('VALIDATION_ERROR', '阶梯结束数量必须不小于起始数量且不超过 999。');
    return { minQuantity, maxQuantity, amountCent: cents(item && item.amountCent, '阶梯价格') };
  }).sort((left, right) => left.minQuantity - right.minQuantity);
  for (let index = 1; index < tiers.length; index += 1) {
    const previous = tiers[index - 1];
    if (previous.maxQuantity === null || tiers[index].minQuantity <= previous.maxQuantity) fail('VALIDATION_ERROR', '数量阶梯区间不能重叠。');
  }
  return tiers;
}
function positiveIntegerOr(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}
function priceRank(rule, user, channel) {
  if (rule.channel && rule.channel !== 'all' && rule.channel !== channel) return -1;
  if (rule.scopeType === 'user' && rule.scopeId === user._id) return 500;
  if (rule.scopeType === 'organization' && user.organizationId && rule.scopeId === user.organizationId) return 400;
  if (rule.scopeType === 'level' && user.priceLevel && rule.scopeId === user.priceLevel) return 300;
  if (rule.scopeType === 'customer_type' && rule.scopeId === user.userType) return 200;
  if (rule.scopeType === 'public') return 100;
  return -1;
}
function pickUnitPrice(rules, user, channel, quantity = 1) {
  const candidates = rules.map((rule) => ({ rule, rank: priceRank(rule, user, channel) })).filter((item) => item.rank >= 0);
  candidates.sort((left, right) => right.rank - left.rank || Number(right.rule.priority || 0) - Number(left.rule.priority || 0) || String(right.rule.validFrom || '').localeCompare(String(left.rule.validFrom || '')));
  if (!candidates.length) return null;
  const selected = candidates[0].rule;
  const quantityTiers = normalizeQuantityTiers(selected.quantityTiers);
  const tier = quantityTiers.find((item) => quantity >= item.minQuantity && (item.maxQuantity === null || quantity <= item.maxQuantity)) || null;
  return {
    ruleId: selected._id,
    amountCent: tier ? tier.amountCent : (selected.amountCent === undefined ? cents(selected.price, '商品价格') : cents(selected.amountCent, '商品价格')),
    currency: selected.currency || 'CNY',
    source: selected.source || '',
    temporary: selected.temporary === true,
    quantityTiers,
    appliedTier: tier,
    minOrderQuantity: positiveIntegerOr(selected.minOrderQuantity, 0),
    orderMultiple: positiveIntegerOr(selected.orderMultiple, 0)
  };
}
async function resolveUnitPrice(store, skuId, user, channel, now, quantity = 1) {
  const rules = await collectPageMatches(store, 'prices', { where: { skuId, status: 'active' } }, (rule) => active(rule, now));
  const price = pickUnitPrice(rules, user, channel, quantity);
  if (!price) fail('PRICE_NOT_AVAILABLE', '当前账号暂未配置该商品价格。');
  return price;
}
// 批量解析：一次取回全部活跃规则后按 SKU 分组解析，供目录价格列表使用
async function resolveUnitPrices(store, skuIds, user, channel, now, quantities = {}) {
  const uniqueIds = [...new Set(skuIds)];
  const rules = await collectPageMatches(store, 'prices', { where: { status: 'active' } }, (rule) => active(rule, now));
  const rulesBySku = new Map();
  for (const rule of rules) {
    const list = rulesBySku.get(rule.skuId) || [];
    list.push(rule);
    rulesBySku.set(rule.skuId, list);
  }
  const output = [];
  for (const skuId of uniqueIds) {
    const price = pickUnitPrice(rulesBySku.get(skuId) || [], user, channel, positiveIntegerOr(quantities[skuId], 1));
    if (price) output.push({ skuId, ...price });
  }
  return output;
}
function freightRank(rule, user, warehouseId, regionCode, areaId) {
  if (rule.customerType && rule.customerType !== user.userType) return -1;
  if (rule.warehouseId && rule.warehouseId !== warehouseId) return -1;
  if (rule.deliveryAreaId && rule.deliveryAreaId !== areaId) return -1;
  if (rule.regionCode && rule.regionCode !== regionCode) return -1;
  return (rule.warehouseId ? 10 : 0) + (rule.deliveryAreaId ? 8 : 0) + (rule.regionCode ? 5 : 0) + Number(rule.priority || 0);
}
async function resolveFreight(store, user, warehouseId, regionCode, goodsAmountCent, now) {
  const areas = await collectPageMatches(store, 'delivery_areas', { where: { status: 'active' } }, () => true);
  const area = areas.find((item) => (item.regionCodes || []).includes(regionCode) && (!(item.warehouseIds || []).length || item.warehouseIds.includes(warehouseId)));
  if (!area) fail('OUT_OF_DELIVERY_RANGE', '当前收货地址不在配送范围内。');
  const rules = await collectPageMatches(store, 'freight_rules', { where: { status: 'active' } }, (rule) => active(rule, now));
  const candidates = rules.map((rule) => ({ rule, rank: freightRank(rule, user, warehouseId, regionCode, area._id) })).filter((item) => item.rank >= 0);
  candidates.sort((left, right) => right.rank - left.rank);
  if (!candidates.length) fail('FREIGHT_RULE_NOT_AVAILABLE', '当前地址暂未配置配送运费规则。');
  const selected = candidates[0].rule;
  const freeThresholdCent = selected.freeThresholdCent === undefined ? cents(selected.freeThreshold || 0, '免运门槛') : cents(selected.freeThresholdCent, '免运门槛');
  const baseFeeCent = selected.baseFeeCent === undefined ? cents(selected.baseFee || 0, '基础配送费') : cents(selected.baseFeeCent, '基础配送费');
  const additionalFeeCent = selected.additionalFeeCent === undefined ? cents(selected.additionalFee || 0, '附加配送费') : cents(selected.additionalFeeCent, '附加配送费');
  return { ruleId: selected._id, areaId: area._id, amountCent: freeThresholdCent > 0 && goodsAmountCent >= freeThresholdCent ? 0 : baseFeeCent + additionalFeeCent, baseFeeCent, additionalFeeCent, freeThresholdCent, regionCode, warehouseId };
}
async function resolveDeliverySlot(store, deliverySlotId, freight, now) {
  if (!deliverySlotId) return null;
  const slot = await store.findOne('delivery_slots', { _id: String(deliverySlotId), status: 'active' });
  if (!slot || !active(slot, now)) fail('DELIVERY_SLOT_NOT_AVAILABLE', '配送时段不存在或暂不可用。');
  if (slot.deliveryAreaId && slot.deliveryAreaId !== freight.areaId) fail('DELIVERY_SLOT_NOT_AVAILABLE', '配送时段不适用于当前配送区域。');
  if (slot.warehouseId && slot.warehouseId !== freight.warehouseId) fail('DELIVERY_SLOT_NOT_AVAILABLE', '配送时段不适用于当前仓库。');
  return { id: slot._id, name: slot.name, startTime: slot.startTime || '', endTime: slot.endTime || '', deliveryAreaId: slot.deliveryAreaId || '', warehouseId: slot.warehouseId || '' };
}
function fulfillmentTypeOf(value) {
  const type = String(value || 'delivery').trim();
  if (!['delivery', 'pickup'].includes(type)) fail('VALIDATION_ERROR', '履约方式必须是配送或到店自提。');
  return type;
}
function pickupSiteSnapshot(site) {
  return { id: site._id, name: site.name, address: site.address, regionCode: site.regionCode || '', warehouseId: site.warehouseId, openingHours: site.openingHours || '' };
}
async function resolvePickupSite(store, pickupSiteId, warehouseId) {
  const id = String(pickupSiteId || '').trim();
  if (!id) fail('PICKUP_SITE_REQUIRED', '请选择有效自提点。');
  const site = await store.findOne('pickup_sites', { _id: id, status: 'active' });
  if (!site) fail('PICKUP_SITE_NOT_AVAILABLE', '自提点不存在或暂不可用。');
  if (site.warehouseId !== warehouseId) fail('PICKUP_SITE_WAREHOUSE_MISMATCH', '自提点与所选仓库不匹配。');
  return pickupSiteSnapshot(site);
}
async function acceptedQuoteOverrides(store, user, tokenId, requestedItems, now, reader = store) {
  if (!tokenId) return { overrides: {}, token: null };
  const token = await reader.getById('accepted_quote_tokens', String(tokenId));
  if (!token || token.status !== 'active' || token.userId !== user._id || token.organizationId !== user.organizationId) fail('INQUIRY_QUOTE_FORBIDDEN', '询价报价凭证不存在或不属于当前账号。');
  if (new Date(token.validUntil).getTime() <= now.getTime()) fail('INQUIRY_QUOTE_EXPIRED', '询价报价已过期。');
  const normalized = pageItems(requestedItems); const expected = token.items || [];
  if (normalized.length !== expected.length || normalized.some((item) => !expected.some((quoted) => quoted.skuId === item.skuId && Number(quoted.quantity) === item.quantity))) fail('INQUIRY_QUOTE_ITEMS_CHANGED', '报价订单商品或数量与已确认询价不一致。');
  return { token, overrides: Object.fromEntries(expected.map((item) => [item.skuId, { ruleId: `inquiry:${token.quoteId}:${token.version}`, amountCent: item.unitPriceCent, currency: 'CNY' }])) };
}
async function buildQuote({ store, user, warehouseId, regionCode, items, channel, now, priceOverrides = {}, deliverySlotId = '', fulfillmentType: requestedFulfillmentType = 'delivery', pickupSiteId = '', bundleId = '', bundleQuantity = 1, couponId = '' }) {
  const fulfillmentType = fulfillmentTypeOf(requestedFulfillmentType);
  let bundle = null; let effectiveItems = items;
  if (bundleId) { bundle = await store.findOne('bundles', { _id: String(bundleId), status: 'active' }); if (!bundle || bundle.temporary === true || bundle.source === 'ai_generated' || bundle.validFrom && new Date(bundle.validFrom) > now || bundle.validTo && new Date(bundle.validTo) <= now) fail('BUNDLE_NOT_AVAILABLE', '套餐不存在或不可用。'); const quantity = Number(bundleQuantity); if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) fail('VALIDATION_ERROR', '套餐数量不合法。'); effectiveItems = (bundle.items || []).map((item) => ({ skuId: item.skuId, quantity: Number(item.quantity) * quantity })); }
  const normalizedItems = pageItems(effectiveItems);
  const warehouse = await store.findOne('warehouses', { _id: warehouseId, status: 'active' });
  if (!warehouse) fail('WAREHOUSE_NOT_AVAILABLE', '仓库不存在或暂不可配送。');
  const pickupSite = fulfillmentType === 'pickup' ? await resolvePickupSite(store, pickupSiteId, warehouseId) : null;
  if (fulfillmentType === 'pickup' && deliverySlotId) fail('DELIVERY_SLOT_NOT_AVAILABLE', '到店自提不能选择配送时段。');
  if (fulfillmentType === 'delivery' && !String(regionCode || '').trim()) fail('ADDRESS_NOT_AVAILABLE', '配送订单必须提供有效收货区域。');
  const output = [];
  for (const input of normalizedItems) {
    const sku = await store.findOne('product_skus', { _id: input.skuId, status: 'on_sale' });
    if (!sku) fail('SKU_NOT_AVAILABLE', '商品规格不存在或已下架。');
    const product = await store.findOne('products', { _id: sku.productId, status: 'on_sale' });
    if (!product) fail('PRODUCT_NOT_AVAILABLE', '商品不存在或已下架。');
    if (!audienceVisible(product.audienceType, user)) fail('PRODUCT_NOT_AVAILABLE', '当前账号不可购买该商品。');
    const override = priceOverrides[sku._id];
    const price = override ? { ruleId: override.ruleId || '', amountCent: cents(override.amountCent, '活动价格'), currency: override.currency || 'CNY', appliedTier: null, minOrderQuantity: 0, orderMultiple: 0 } : await resolveUnitPrice(store, sku._id, user, channel === 'web' ? 'web' : 'miniapp', now, input.quantity);
    const minOrderQuantity = positiveIntegerOr(price.minOrderQuantity, positiveIntegerOr(sku.minOrderQuantity, 1));
    const orderMultiple = positiveIntegerOr(price.orderMultiple, positiveIntegerOr(sku.orderMultiple, 1));
    if (input.quantity < minOrderQuantity) fail('MIN_ORDER_QUANTITY_NOT_MET', `该规格 ${minOrderQuantity} 件起购。`);
    if (input.quantity % orderMultiple !== 0) fail('ORDER_MULTIPLE_NOT_MET', `该规格购买数量必须是 ${orderMultiple} 的整数倍。`);
    const inventory = await store.findOne('inventory', { warehouseId, skuId: sku._id });
    if (!inventory || Number(inventory.available) < input.quantity) fail('INVENTORY_NOT_AVAILABLE', '商品库存不足。');
    output.push({ skuId: sku._id, productId: product._id, productNameSnapshot: product.name, specSnapshot: sku.specName, packageUnitSnapshot: sku.packageUnit, quantity: input.quantity, unitPriceCent: price.amountCent, subtotalCent: price.amountCent * input.quantity, priceRuleId: price.ruleId, quantityTierSnapshot: price.appliedTier, purchaseRuleSnapshot: { minOrderQuantity, orderMultiple }, currency: price.currency, mediaSnapshot: product.coverMediaId || '' });
  }
  const originalGoodsAmountCent = output.reduce((total, item) => total + item.subtotalCent, 0);
  const goodsAmountCent = bundle ? Number(bundle.bundlePriceCent || 0) * Number(bundleQuantity) : originalGoodsAmountCent;
  if (goodsAmountCent < 1 || goodsAmountCent > originalGoodsAmountCent) fail('BUNDLE_PRICE_INVALID', '套餐价格配置不合法。');
  const freight = fulfillmentType === 'pickup'
    ? { ruleId: '', areaId: '', amountCent: 0, baseFeeCent: 0, additionalFeeCent: 0, freeThresholdCent: 0, regionCode: pickupSite.regionCode, warehouseId, pickupSiteId: pickupSite.id }
    : await resolveFreight(store, user, warehouseId, regionCode, goodsAmountCent, now);
  const deliverySlot = fulfillmentType === 'delivery' ? await resolveDeliverySlot(store, deliverySlotId, freight, now) : null;
  let couponSnapshot = null; let discountAmountCent = 0;
  if (couponId) {
    const coupon = await store.findOne('user_coupons', { _id: String(couponId), userId: user._id, status: 'available' });
    const template = coupon && await store.findOne('coupon_templates', { _id: coupon.templateId, status: 'active' });
    if (!coupon || !template || template.temporary === true || template.source === 'ai_generated' || template.validFrom && new Date(template.validFrom) > now || template.validTo && new Date(template.validTo) <= now) fail('COUPON_NOT_AVAILABLE', '优惠券不可用于当前订单。');
    const scopeIds = template.scopeIds || [];
    let eligibleOriginalCent = originalGoodsAmountCent;
    if (template.scopeType === 'product') eligibleOriginalCent = output.filter((item) => scopeIds.includes(item.productId)).reduce((sum, item) => sum + item.subtotalCent, 0);
    if (template.scopeType === 'category') { eligibleOriginalCent = 0; for (const item of output) { const product = await store.getById('products', item.productId); if (product && scopeIds.includes(product.categoryId)) eligibleOriginalCent += item.subtotalCent; } }
    const eligibleAmountCent = originalGoodsAmountCent ? Math.floor(goodsAmountCent * eligibleOriginalCent / originalGoodsAmountCent) : 0;
    if (eligibleAmountCent < Number(template.minSpendCent || 0) || eligibleAmountCent < 1) fail('COUPON_SCOPE_INVALID', '优惠券适用商品金额未达门槛。');
    discountAmountCent = template.type === 'percent' ? Math.floor(eligibleAmountCent * Number(template.discountRateBps || 0) / 10000) : Number(template.discountCent || 0);
    if (Number(template.maxDiscountCent || 0) > 0) discountAmountCent = Math.min(discountAmountCent, Number(template.maxDiscountCent));
    discountAmountCent = Math.max(0, Math.min(eligibleAmountCent, discountAmountCent));
    if (!discountAmountCent) fail('COUPON_DISCOUNT_INVALID', '优惠券优惠金额无效。');
    couponSnapshot = { userCouponId: coupon._id, templateId: template._id, name: template.name, version: Number(template.version || 1), scopeType: template.scopeType, eligibleAmountCent, discountAmountCent };
  }
  const paidItems = allocatePaidSubtotals(output, Math.max(0, goodsAmountCent - discountAmountCent));
  return { fulfillmentType, pickupSiteSnapshot: pickupSite, items: paidItems, originalGoodsAmountCent, goodsAmountCent, bundleDiscountCent: originalGoodsAmountCent - goodsAmountCent, bundleSnapshot: bundle ? { id: bundle._id, name: bundle.name, version: Number(bundle.version || 1), quantity: Number(bundleQuantity), bundlePriceCent: bundle.bundlePriceCent, items: bundle.items } : null, couponSnapshot, discountAmountCent, freightAmountCent: freight.amountCent, payableAmountCent: Math.max(0, goodsAmountCent + freight.amountCent - discountAmountCent), freight, deliverySlot };
}
function createOrderNo(now) { return `MSX${now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}${randomId('').slice(-8).toUpperCase()}`; }
async function txDocument(tx, collection, id) { return tx.getById(collection, id); }
async function findExistingOrder(store, user, idempotencyKey) {
  const key = String(idempotencyKey || '').trim();
  if (!key || key.length > 120) return null;
  const existing = await store.getById('orders', orderId(user._id, key));
  if (!existing) return null;
  if (existing.userId !== user._id || existing.idempotencyKey !== key) fail('IDEMPOTENCY_CONFLICT', '幂等键与既有订单不匹配。');
  return existing;
}
async function orderReservations(tx, order) { return Promise.all((order.reservationIds || []).map((id) => txDocument(tx, 'inventory_reservations', id))); }
async function writeLedger(tx, data) { return tx.set('inventory_ledger', inventoryLedgerId(data.reason, data.referenceId, data.skuId), data); }
async function releaseCoupon(tx, order, now) {
  if (!order.couponSnapshot || !order.couponSnapshot.userCouponId) return false;
  const coupon = await txDocument(tx, 'user_coupons', order.couponSnapshot.userCouponId);
  if (!coupon || coupon.userId !== order.userId || coupon.status !== 'used' || coupon.usedOrderId !== order._id) return false;
  const timestamp = iso(now);
  await tx.update('user_coupons', coupon._id, { status: 'available', usedOrderId: '', usedAt: '', releasedAt: timestamp, updatedAt: timestamp });
  return true;
}
async function releaseReservation(tx, reservation, order, now, reason, status = 'released') {
  if (!reservation || reservation.status !== 'reserved') return false;
  const inventory = await txDocument(tx, 'inventory', inventoryId(reservation.warehouseId, reservation.skuId));
  if (!inventory) fail('INVENTORY_NOT_FOUND', '订单库存记录缺失。');
  const timestamp = iso(now); const onHand = Number(inventory.onHand || 0); const reserved = Math.max(0, Number(inventory.reserved || 0) - Number(reservation.quantity || 0));
  await tx.update('inventory', inventory._id, { reserved, available: onHand - reserved, version: Number(inventory.version || 0) + 1, updatedAt: timestamp });
  await tx.update('inventory_reservations', reservation._id, { status, releasedAt: timestamp });
  await writeLedger(tx, { warehouseId: reservation.warehouseId, skuId: reservation.skuId, change: 0, reservedChange: -Number(reservation.quantity || 0), before: onHand - Number(inventory.reserved || 0), after: onHand - reserved, reason, referenceType: 'order', referenceId: order._id, operatorId: 'system', idempotencyKey: `${reason}:${reservation._id}`, createdAt: timestamp });
  return true;
}
async function consumeReservation(tx, reservation, order, now, reason, operatorId = 'system', idempotencyKey = '') {
  if (!reservation || reservation.status !== 'reserved') fail('ORDER_RESERVATION_INVALID', '订单库存预占记录异常。');
  const inventory = await txDocument(tx, 'inventory', inventoryId(reservation.warehouseId, reservation.skuId));
  if (!inventory) fail('INVENTORY_NOT_FOUND', '订单库存记录缺失。');
  const timestamp = iso(now); const quantity = Number(reservation.quantity || 0); const onHand = Number(inventory.onHand || 0); const reserved = Math.max(0, Number(inventory.reserved || 0) - quantity);
  if (onHand < quantity) fail('INVENTORY_NOT_AVAILABLE', '库存账面数量异常。');
  await tx.update('inventory', inventory._id, { onHand: onHand - quantity, reserved, available: onHand - quantity - reserved, version: Number(inventory.version || 0) + 1, updatedAt: timestamp });
  await tx.update('inventory_reservations', reservation._id, { status: 'consumed', consumedAt: timestamp });
  await writeLedger(tx, { warehouseId: reservation.warehouseId, skuId: reservation.skuId, change: -quantity, reservedChange: -quantity, before: onHand - Number(inventory.reserved || 0), after: onHand - quantity - reserved, reason, referenceType: 'order', referenceId: order._id, operatorId, idempotencyKey: idempotencyKey || `${reason}:${reservation._id}`, createdAt: timestamp });
  return true;
}
async function createOrder({ store, user, payload, now }) {
  const idempotencyKey = String(payload.idempotencyKey || '').trim();
  if (!idempotencyKey || idempotencyKey.length > 120) fail('IDEMPOTENCY_KEY_REQUIRED', '请提供合法的幂等键。');
  const earlyExisting = await findExistingOrder(store, user, idempotencyKey);
  if (earlyExisting) return { order: earlyExisting, idempotent: true };
  const fulfillmentType = fulfillmentTypeOf(payload.fulfillmentType);
  const addressId = String(payload.addressId || '').trim(); const warehouseId = String(payload.warehouseId || '').trim();
  if (!warehouseId) fail('VALIDATION_ERROR', '仓库不能为空。');
  let address = null;
  if (fulfillmentType === 'delivery') {
    if (!addressId) fail('VALIDATION_ERROR', '配送订单的收货地址不能为空。');
    address = await store.getById('addresses', addressId);
    if (!address || address.userId !== user._id || address.status !== 'active' || !address.regionCode) fail('ADDRESS_NOT_AVAILABLE', '请选择有效且包含配送区域的收货地址。');
  }
  let groupCampaign = null;
  if (payload.groupCampaignId) {
    groupCampaign = await store.getById('group_campaigns', String(payload.groupCampaignId));
    if (!activeGroupCampaign(groupCampaign, now)) fail('GROUP_CAMPAIGN_NOT_AVAILABLE', '拼团活动不存在或已结束。');
    if (groupCampaign.targetUserType && groupCampaign.targetUserType !== 'all' && groupCampaign.targetUserType !== user.userType) fail('GROUP_CAMPAIGN_FORBIDDEN', '当前账号不符合拼团活动参与条件。');
    if (!Array.isArray(payload.items) || payload.items.length !== 1 || String(payload.items[0].skuId || '') !== groupCampaign.skuId) fail('GROUP_ITEM_INVALID', '拼团订单只能包含当前活动商品。');
  }
  if (payload.bundleId && (payload.groupCampaignId || payload.acceptedQuoteToken)) fail('PROMOTION_CONFLICT', '套餐不能与拼团或询价报价同时使用。');
  const acceptedQuote = groupCampaign || payload.bundleId ? { overrides: {}, token: null } : await acceptedQuoteOverrides(store, user, payload.acceptedQuoteToken, payload.items, now);
  const quote = await buildQuote({ store, user, warehouseId, regionCode: address && address.regionCode, items: payload.items, channel: payload.channel, now, deliverySlotId: payload.deliverySlotId, fulfillmentType, pickupSiteId: payload.pickupSiteId, bundleId: payload.bundleId, bundleQuantity: payload.bundleQuantity, couponId: payload.couponId, priceOverrides: groupCampaign ? { [groupCampaign.skuId]: { amountCent: groupCampaign.groupPriceCent, ruleId: `group:${groupCampaign._id}` } } : acceptedQuote.overrides });
  if (quote.items.length > 20) fail('ORDER_ITEM_LIMIT', '单笔订单最多包含 20 种商品。');
  if (groupCampaign && !payload.groupId) fail('GROUP_REQUIRED', '创建拼团订单需要先创建拼团。');
  if (typeof store.runTransaction !== 'function') fail('TRANSACTION_NOT_AVAILABLE', '当前环境不支持订单事务。');
  const deterministicOrderId = orderId(user._id, idempotencyKey);
  return store.runTransaction(async (tx) => {
    const existing = await txDocument(tx, 'orders', deterministicOrderId);
    if (existing) {
      if (existing.userId !== user._id || existing.idempotencyKey !== idempotencyKey) fail('IDEMPOTENCY_CONFLICT', '幂等键与既有订单不匹配。');
      return { order: existing, idempotent: true };
    }
    let currentAddress = null;
    let currentPickupSite = null;
    let currentDeliverySlot = null;
    if (fulfillmentType === 'delivery') {
      currentAddress = await txDocument(tx, 'addresses', addressId);
      if (!currentAddress || currentAddress.userId !== user._id || currentAddress.status !== 'active' || !currentAddress.regionCode) fail('ADDRESS_NOT_AVAILABLE', '收货地址已失效，请重新结算。');
    } else {
      currentPickupSite = await txDocument(tx, 'pickup_sites', quote.pickupSiteSnapshot.id);
      if (!currentPickupSite || currentPickupSite.status !== 'active') fail('PICKUP_SITE_NOT_AVAILABLE', '自提点已失效，请重新结算。');
      if (currentPickupSite.warehouseId !== warehouseId) fail('PICKUP_SITE_WAREHOUSE_MISMATCH', '自提点与所选仓库不匹配。');
    }
    if (fulfillmentType === 'delivery' && quote.deliverySlot) {
      currentDeliverySlot = await txDocument(tx, 'delivery_slots', quote.deliverySlot.id);
      if (!currentDeliverySlot || currentDeliverySlot.status !== 'active' || !active(currentDeliverySlot, now)) fail('DELIVERY_SLOT_NOT_AVAILABLE', '配送时段已失效，请重新结算。');
      if (currentDeliverySlot.deliveryAreaId && currentDeliverySlot.deliveryAreaId !== quote.freight.areaId) fail('DELIVERY_SLOT_NOT_AVAILABLE', '配送时段不再适用于当前配送区域。');
      if (currentDeliverySlot.warehouseId && currentDeliverySlot.warehouseId !== warehouseId) fail('DELIVERY_SLOT_NOT_AVAILABLE', '配送时段不再适用于当前仓库。');
    }
    if (quote.bundleSnapshot) {
      const currentBundle = await txDocument(tx, 'bundles', quote.bundleSnapshot.id);
      const sameItems = currentBundle && JSON.stringify(currentBundle.items || []) === JSON.stringify(quote.bundleSnapshot.items || []);
      if (!currentBundle || currentBundle.status !== 'active' || currentBundle.temporary === true || currentBundle.source === 'ai_generated' || !active(currentBundle, now) || Number(currentBundle.version || 1) !== quote.bundleSnapshot.version || Number(currentBundle.bundlePriceCent) !== Number(quote.bundleSnapshot.bundlePriceCent) || !sameItems) fail('BUNDLE_CHANGED', '套餐配置已变化，请重新结算。');
      for (const item of quote.items) {
        const currentSku = await txDocument(tx, 'product_skus', item.skuId);
        const currentRule = await txDocument(tx, 'prices', item.priceRuleId);
        if (!currentSku || currentSku.status !== 'on_sale' || !currentRule || currentRule.status !== 'active' || currentRule.skuId !== item.skuId || !active(currentRule, now)) fail('BUNDLE_CHANGED', '套餐商品已变化，请重新结算。');
        const currentPrice = pickUnitPrice([currentRule], user, payload.channel === 'web' ? 'web' : 'miniapp', item.quantity);
        const minOrderQuantity = currentPrice ? positiveIntegerOr(currentPrice.minOrderQuantity, positiveIntegerOr(currentSku.minOrderQuantity, 1)) : 0;
        const orderMultiple = currentPrice ? positiveIntegerOr(currentPrice.orderMultiple, positiveIntegerOr(currentSku.orderMultiple, 1)) : 0;
        if (!currentPrice || minOrderQuantity !== item.purchaseRuleSnapshot.minOrderQuantity || orderMultiple !== item.purchaseRuleSnapshot.orderMultiple || item.quantity < minOrderQuantity || item.quantity % orderMultiple !== 0) fail('BUNDLE_CHANGED', '套餐起订或购买倍数已变化，请重新结算。');
      }
    } else if (acceptedQuote.token) {
      const currentAccepted = await acceptedQuoteOverrides(store, user, payload.acceptedQuoteToken, payload.items, now, tx);
      if (!currentAccepted.token || currentAccepted.token.quoteId !== acceptedQuote.token.quoteId || currentAccepted.token.version !== acceptedQuote.token.version) fail('INQUIRY_QUOTE_CHANGED', '询价报价版本已变化。');
    } else if (!groupCampaign) {
      for (const item of quote.items) {
        const currentRule = await txDocument(tx, 'prices', item.priceRuleId);
        const currentSku = await txDocument(tx, 'product_skus', item.skuId);
        if (!currentRule || currentRule.status !== 'active' || currentRule.skuId !== item.skuId || !active(currentRule, now) || !currentSku || currentSku.status !== 'on_sale') fail('QUOTE_CHANGED', '商品价格或购买规则已变化，请重新结算。');
        const currentPrice = pickUnitPrice([currentRule], user, payload.channel === 'web' ? 'web' : 'miniapp', item.quantity);
        const minOrderQuantity = currentPrice ? positiveIntegerOr(currentPrice.minOrderQuantity, positiveIntegerOr(currentSku.minOrderQuantity, 1)) : 0;
        const orderMultiple = currentPrice ? positiveIntegerOr(currentPrice.orderMultiple, positiveIntegerOr(currentSku.orderMultiple, 1)) : 0;
        if (!currentPrice || currentPrice.amountCent !== item.unitPriceCent || minOrderQuantity !== item.purchaseRuleSnapshot.minOrderQuantity || orderMultiple !== item.purchaseRuleSnapshot.orderMultiple || item.quantity < minOrderQuantity || item.quantity % orderMultiple !== 0) fail('QUOTE_CHANGED', '商品价格或购买规则已变化，请重新结算。');
      }
    }
    if (quote.couponSnapshot) {
      const currentCoupon = await txDocument(tx, 'user_coupons', quote.couponSnapshot.userCouponId);
      const currentTemplate = currentCoupon && await txDocument(tx, 'coupon_templates', quote.couponSnapshot.templateId);
      if (!currentCoupon || currentCoupon.userId !== user._id || currentCoupon.status !== 'available' || !currentTemplate || currentTemplate.status !== 'active' || currentTemplate.temporary === true || currentTemplate.source === 'ai_generated' || !active(currentTemplate, now) || Number(currentTemplate.version || 1) !== quote.couponSnapshot.version) fail('COUPON_CHANGED', '优惠券已变化，请重新结算。');
      const scopeIds = currentTemplate.scopeIds || [];
      let eligibleOriginalCent = quote.originalGoodsAmountCent;
      if (currentTemplate.scopeType === 'product') eligibleOriginalCent = quote.items.filter((item) => scopeIds.includes(item.productId)).reduce((sum, item) => sum + item.subtotalCent, 0);
      if (currentTemplate.scopeType === 'category') { eligibleOriginalCent = 0; for (const item of quote.items) { const product = await txDocument(tx, 'products', item.productId); if (product && scopeIds.includes(product.categoryId)) eligibleOriginalCent += item.subtotalCent; } }
      const eligibleAmountCent = quote.originalGoodsAmountCent ? Math.floor(quote.goodsAmountCent * eligibleOriginalCent / quote.originalGoodsAmountCent) : 0;
      if (eligibleAmountCent < Number(currentTemplate.minSpendCent || 0) || eligibleAmountCent < 1 || eligibleAmountCent !== quote.couponSnapshot.eligibleAmountCent) fail('COUPON_CHANGED', '优惠券不再适用当前订单。');
      let currentDiscount = currentTemplate.type === 'percent' ? Math.floor(eligibleAmountCent * Number(currentTemplate.discountRateBps || 0) / 10000) : Number(currentTemplate.discountCent || 0);
      if (Number(currentTemplate.maxDiscountCent || 0) > 0) currentDiscount = Math.min(currentDiscount, Number(currentTemplate.maxDiscountCent));
      currentDiscount = Math.max(0, Math.min(eligibleAmountCent, currentDiscount));
      if (currentDiscount !== quote.discountAmountCent) fail('COUPON_CHANGED', '优惠券金额已变化，请重新结算。');
    }
    if (groupCampaign) await reserveSlot(tx, { groupId: String(payload.groupId), campaignId: groupCampaign._id, userId: user._id, orderId: deterministicOrderId, now });
    const timestamp = iso(now); const paymentMethod = ['offline', 'demo', 'credit'].includes(payload.paymentMethod) ? payload.paymentMethod : 'wechat';
    const reservationIds = quote.items.map((item) => reservationId(deterministicOrderId, item.skuId));
    const itemIds = quote.items.map((item) => orderItemId(deterministicOrderId, item.skuId));
    const paymentDocumentId = paymentMethod === 'wechat' ? paymentId(deterministicOrderId) : '';
    const order = { _id: deterministicOrderId, orderNo: createOrderNo(now), userId: user._id, organizationId: user.organizationId || '', customerType: user.userType || 'c', warehouseId, fulfillmentType, pickupSiteSnapshot: currentPickupSite ? pickupSiteSnapshot(currentPickupSite) : null, deliveryAreaId: fulfillmentType === 'delivery' ? quote.freight.areaId : '', addressSnapshot: currentAddress ? { name: currentAddress.name, phoneMasked: currentAddress.phoneMasked, detail: currentAddress.detail, regionCode: currentAddress.regionCode } : null, fulfillmentContactCiphertext: currentAddress && currentAddress.phoneCiphertext || '', groupId: payload.groupId ? String(payload.groupId) : '', groupCampaignId: groupCampaign ? groupCampaign._id : '', groupStatus: groupCampaign ? 'reserved' : '', bundleSnapshot: quote.bundleSnapshot, couponSnapshot: quote.couponSnapshot, discountAmountCent: quote.discountAmountCent, acceptedQuoteSnapshot: acceptedQuote.token ? { tokenId: acceptedQuote.token._id, quoteId: acceptedQuote.token.quoteId, version: acceptedQuote.token.version, validUntil: acceptedQuote.token.validUntil } : null, deliverySlotSnapshot: currentDeliverySlot ? { id: currentDeliverySlot._id, name: currentDeliverySlot.name, startTime: currentDeliverySlot.startTime || '', endTime: currentDeliverySlot.endTime || '', deliveryAreaId: currentDeliverySlot.deliveryAreaId || '', warehouseId: currentDeliverySlot.warehouseId || '' } : null, itemsSnapshot: quote.items, pricingSnapshot: { originalGoodsAmountCent: quote.originalGoodsAmountCent, goodsAmountCent: quote.goodsAmountCent, bundleDiscountCent: quote.bundleDiscountCent, couponDiscountCent: quote.discountAmountCent, currency: 'CNY', priceRuleIds: quote.items.map((item) => item.priceRuleId) }, freightSnapshot: quote.freight, totalAmountCent: quote.payableAmountCent, paymentMethod, paymentStatus: paymentMethod === 'wechat' ? 'pending' : (paymentMethod === 'demo' ? 'demo_not_required' : (paymentMethod === 'credit' ? 'credit_reserved' : 'not_required')), status: paymentMethod === 'wechat' ? 'pending_payment' : 'pending_confirmation', idempotencyKey, reservationIds, itemIds, paymentId: paymentDocumentId, refundIds: [], refundedAmountCent: 0, activeRefundId: '', creditStatus: paymentMethod === 'credit' ? 'reserved' : '', createdAt: timestamp, updatedAt: timestamp };
    if (acceptedQuote.token) await tx.update('accepted_quote_tokens', acceptedQuote.token._id, { status: 'consumed', orderId: deterministicOrderId, consumedAt: timestamp });
    if (quote.couponSnapshot) await tx.update('user_coupons', quote.couponSnapshot.userCouponId, { status: 'used', usedOrderId: deterministicOrderId, usedAt: timestamp, updatedAt: timestamp });
    if (paymentMethod === 'credit') order.creditAccountId = await reserveCredit(tx, { user, orderId: deterministicOrderId, amountCent: order.totalAmountCent, now });
    for (const item of quote.items) {
      const inventoryDocumentId = inventoryId(warehouseId, item.skuId);
      const inventory = await txDocument(tx, 'inventory', inventoryDocumentId);
      if (!inventory || Number(inventory.available) < item.quantity) fail('INVENTORY_NOT_AVAILABLE', '库存已变化，请重新结算。');
      const onHand = Number(inventory.onHand || 0); const reserved = Number(inventory.reserved || 0) + item.quantity;
      await tx.update('inventory', inventoryDocumentId, { reserved, available: onHand - reserved, version: Number(inventory.version || 0) + 1, updatedAt: timestamp });
      const reservation = { _id: reservationId(deterministicOrderId, item.skuId), orderId: deterministicOrderId, skuId: item.skuId, warehouseId, quantity: item.quantity, status: 'reserved', expiresAt: paymentMethod === 'wechat' ? new Date(now.getTime() + 30 * 60 * 1000).toISOString() : '', createdAt: timestamp };
      await tx.set('inventory_reservations', reservation._id, reservation);
      await writeLedger(tx, { warehouseId, skuId: item.skuId, change: 0, reservedChange: item.quantity, before: onHand - Number(inventory.reserved || 0), after: onHand - reserved, reason: 'order_reserve', referenceType: 'order', referenceId: deterministicOrderId, operatorId: user._id, idempotencyKey, createdAt: timestamp });
      await tx.set('order_items', orderItemId(deterministicOrderId, item.skuId), { _id: orderItemId(deterministicOrderId, item.skuId), orderId: deterministicOrderId, ...item, createdAt: timestamp });
    }
    await tx.set('orders', deterministicOrderId, order);
    if (paymentDocumentId) await tx.set('payments', paymentDocumentId, { _id: paymentDocumentId, orderId: deterministicOrderId, provider: 'wechat', outTradeNo: order.orderNo, amountCent: order.totalAmountCent, currency: 'CNY', status: 'pending', createdAt: timestamp, updatedAt: timestamp });
    return { order, idempotent: false };
  });
}
async function confirmWechatPayment({ store, payment, transactionId, paidAmountCent, now }) {
  if (typeof store.runTransaction !== 'function') fail('TRANSACTION_NOT_AVAILABLE', '当前环境不支持支付事务。');
  return store.runTransaction(async (tx) => {
    const current = await txDocument(tx, 'payments', payment._id);
    if (!current) fail('PAYMENT_NOT_FOUND', '支付记录不存在。');
    if (current.status === 'paid') return { orderId: current.orderId, idempotent: true };
    if (current.status !== 'pending') fail('PAYMENT_STATUS_INVALID', '支付记录当前不能确认。');
    if (Number(current.amountCent) !== Number(paidAmountCent)) fail('PAYMENT_AMOUNT_MISMATCH', '支付金额与订单金额不一致。');
    const order = await txDocument(tx, 'orders', current.orderId);
    if (!order || order.status !== 'pending_payment') fail('ORDER_PAYMENT_NOT_AVAILABLE', '订单当前不能确认支付。');
    const timestamp = iso(now); const reservations = await orderReservations(tx, order);
    for (const reservation of reservations) {
      await consumeReservation(tx, reservation, order, now, 'payment_consume', 'system', `payment:${current._id}`);
    }
    await tx.update('payments', current._id, { status: 'paid', transactionId, paidAt: timestamp, updatedAt: timestamp });
    await tx.update('orders', order._id, { paymentStatus: 'paid', status: 'pending_confirmation', paidAt: timestamp, updatedAt: timestamp });
    let group = null;
    if (order.groupId) group = await recordPaidMember(tx, { groupId: order.groupId, orderId: order._id, userId: order.userId, now });
    if (group) await tx.update('orders', order._id, { groupStatus: group.group.status, updatedAt: timestamp });
    return { orderId: order._id, idempotent: false, groupStatus: group ? group.group.status : '' };
  });
}
async function cancelOrder({ store, user, orderId: id, now }) {
  if (typeof store.runTransaction !== 'function') fail('TRANSACTION_NOT_AVAILABLE', '当前环境不支持订单事务。');
  return store.runTransaction(async (tx) => {
    const order = await txDocument(tx, 'orders', id);
    if (!order || order.userId !== user._id) fail('ORDER_NOT_FOUND', '订单不存在。');
    if (order.status === 'cancelled') return { order, idempotent: true };
    if (!['pending_payment', 'pending_confirmation'].includes(order.status)) fail('ORDER_CANNOT_CANCEL', '当前订单状态不能取消。');
    // 已支付订单的库存预占已消耗，直接取消会造成不退款、不回补且退款入口关闭，必须走退款售后流程。
    if (order.paymentStatus === 'paid') fail('ORDER_PAID_CANCEL_FORBIDDEN', '已支付订单不能直接取消，请通过退款售后流程处理。');
    if (order.paymentMethod === 'credit') await releaseCredit(tx, order, now);
    for (const reservation of await orderReservations(tx, order)) await releaseReservation(tx, reservation, order, now, 'order_cancel_release');
    await releaseSlot(tx, { groupId: order.groupId, orderId: order._id, now });
    await releaseCoupon(tx, order, now);
    const timestamp = iso(now); await tx.update('orders', order._id, { status: 'cancelled', cancelledAt: timestamp, updatedAt: timestamp });
    return { order: { ...order, status: 'cancelled' }, idempotent: false };
  });
}
async function expireReservations({ store, now, limit = 50 }) {
  if (typeof store.runTransaction !== 'function') fail('TRANSACTION_NOT_AVAILABLE', '当前环境不支持库存事务。');
  const maxProcess = Math.max(1, Math.min(100, limit));
  const candidates = [];
  let scanned = 0;
  // 分页扫描全部 reserved 预占：永不过期的预占（如演示/线下订单）不得阻塞真实过期记录的释放
  for (let page = 1; candidates.length < maxProcess; page += 1) {
    const listed = await store.list('inventory_reservations', { where: { status: 'reserved' }, page, pageSize: 100 });
    scanned += listed.rows.length;
    for (const item of listed.rows) {
      if (item.expiresAt && new Date(item.expiresAt).getTime() <= now.getTime()) {
        candidates.push(item);
        if (candidates.length >= maxProcess) break;
      }
    }
    if (page * 100 >= listed.total) break;
  }
  let released = 0;
  for (const candidate of candidates) {
    const result = await store.runTransaction(async (tx) => {
      const reservation = await txDocument(tx, 'inventory_reservations', candidate._id);
      if (!reservation || reservation.status !== 'reserved' || !reservation.expiresAt || new Date(reservation.expiresAt).getTime() > now.getTime()) return false;
      const order = await txDocument(tx, 'orders', reservation.orderId);
      if (!order || order.status !== 'pending_payment') return false;
      await releaseReservation(tx, reservation, order, now, 'payment_timeout_release', 'expired');
      const remaining = await orderReservations(tx, order);
      if (!remaining.some((item) => item && item.status === 'reserved')) {
        const timestamp = iso(now); await tx.update('orders', order._id, { status: 'cancelled', paymentStatus: 'closed', cancelledAt: timestamp, cancelReason: 'payment_timeout', updatedAt: timestamp });
        await releaseSlot(tx, { groupId: order.groupId, orderId: order._id, now });
        await releaseCoupon(tx, order, now);
      }
      return true;
    });
    if (result) released += 1;
  }
  return { scanned, released, hasMore: candidates.length >= maxProcess };
}
async function expireGroups({ store, now, limit = 50 }) {
  if (typeof store.runTransaction !== 'function') fail('TRANSACTION_NOT_AVAILABLE', '当前环境不支持拼团事务。');
  const maxProcess = Math.max(1, Math.min(100, limit));
  const candidates = [];
  let scanned = 0;
  // 同 expireReservations：分页扫描全部 open 拼团，避免固定首页窗口遗漏
  for (let page = 1; candidates.length < maxProcess; page += 1) {
    const listed = await store.list('groups', { where: { status: 'open' }, page, pageSize: 100 });
    scanned += listed.rows.length;
    for (const item of listed.rows) {
      if (item.expiresAt && new Date(item.expiresAt).getTime() <= now.getTime()) {
        candidates.push(item);
        if (candidates.length >= maxProcess) break;
      }
    }
    if (page * 100 >= listed.total) break;
  }
  let closed = 0; let released = 0; let refundRequired = 0;
  for (const candidate of candidates) {
    const result = await store.runTransaction(async (tx) => {
      const group = await txDocument(tx, 'groups', candidate._id);
      if (!group || group.status !== 'open' || !group.expiresAt || new Date(group.expiresAt).getTime() > now.getTime()) return null;
      const orders = await Promise.all((group.orderIds || []).map((id) => txDocument(tx, 'orders', id)));
      const timestamp = iso(now); let transactionReleased = 0; const paidOrders = [];
      for (const order of orders.filter(Boolean)) {
        if (order.status === 'pending_payment') {
          for (const reservation of await orderReservations(tx, order)) if (await releaseReservation(tx, reservation, order, now, 'group_expire_release', 'expired')) transactionReleased += 1;
          await releaseSlot(tx, { groupId: group._id, orderId: order._id, now });
          await releaseCoupon(tx, order, now);
          await tx.update('orders', order._id, { status: 'cancelled', paymentStatus: 'closed', cancelledAt: timestamp, cancelReason: 'group_expired', groupStatus: 'failed', updatedAt: timestamp });
        } else if (['pending_confirmation', 'picking', 'shipping', 'delivered', 'completed'].includes(order.status)) paidOrders.push(order);
      }
      await Promise.all(paidOrders.map((order) => tx.update('orders', order._id, { groupStatus: 'failed', updatedAt: timestamp })));
      await tx.update('groups', group._id, { status: 'failed', reservedMemberCount: Number(group.memberCount || 0), refundRequired: paidOrders.length, failedAt: timestamp, failureReason: paidOrders.length ? 'paid_members_require_refund' : 'expired', updatedAt: timestamp });
      return { released: transactionReleased, paid: paidOrders.length };
    });
    if (result) { closed += 1; released += result.released; refundRequired += result.paid; }
  }
  return { scanned, closed, released, refundRequired, hasMore: candidates.length >= maxProcess };
}

module.exports = { cents, audienceVisible, buildQuote, acceptedQuoteOverrides, createOrder, findExistingOrder, cancelOrder, expireReservations, expireGroups, confirmWechatPayment, resolveUnitPrice, resolveUnitPrices, normalizeQuantityTiers, orderReservations, consumeReservation, releaseReservation };
