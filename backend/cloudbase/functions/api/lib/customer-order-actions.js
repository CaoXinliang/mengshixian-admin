const { fail } = require('./response');
const { encryptText } = require('./security');
const { audienceVisible, buildQuote, createOrder, cancelOrder, confirmWechatPayment, orderReservations, consumeReservation } = require('./commerce');
const { assertTransition } = require('./order-state');
const { requestRefund, reviewRefund, confirmRefund } = require('./refunds');
const { nowIso, string, integer, pageParams, pick, publicProduct, publicSku, maskedPhone, safeAddress, safeOrder, safeOrderItem } = require('./api-values');

function createCustomerOrderActions({ store, piiEncryptionKey, paymentPreparer, paymentVerifier, refundVerifier, demoMode, clock, audit, getAdmin, ensureWechatUser }) {
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
      isDefault: payload.isDefault === true,
      status: 'active',
      updatedAt: timestamp
    };
    let existingAddress = null;
    if (payload.id) {
      const id = string(payload.id, '收货地址 ID', { max: 80 });
      existingAddress = await store.findOne('addresses', { _id: id, userId: user._id, status: 'active' });
      if (!existingAddress) fail('ADDRESS_NOT_FOUND', '收货地址不存在。');
    }
    if (patch.isDefault) {
      const existing = await store.list('addresses', { where: { userId: user._id, status: 'active', isDefault: true }, page: 1, pageSize: 100 });
      await Promise.all(existing.rows.map((item) => store.update('addresses', item._id, { isDefault: false, updatedAt: timestamp })));
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
    return { address: safeAddress(address) };
  }

  async function userDeleteAddress(payload) {
    const user = await ensureWechatUser();
    const id = string(payload.id, '收货地址 ID', { required: true, max: 80 });
    const existing = await store.findOne('addresses', { _id: id, userId: user._id, status: 'active' });
    if (!existing) fail('ADDRESS_NOT_FOUND', '收货地址不存在。');
    await store.update('addresses', id, { status: 'deleted', deletedAt: nowIso(clock), updatedAt: nowIso(clock) });
    return { id, deleted: true };
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
    const existing = await store.findOne('cart_items', { userId: user._id, skuId });
    const patch = { quantity, selected: payload.selected !== false, updatedAt: timestamp };
    let item;
    if (existing) {
      await store.update('cart_items', existing._id, patch);
      item = { ...existing, ...patch };
    } else {
      item = await store.create('cart_items', { userId: user._id, skuId, ...patch, createdAt: timestamp });
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
    const addressId = string(payload.addressId, '收货地址 ID', { required: true, max: 80 });
    const warehouseId = string(payload.warehouseId, '仓库 ID', { required: true, max: 80 });
    const address = await store.findOne('addresses', { _id: addressId, userId: user._id, status: 'active' });
    if (!address || !address.regionCode) fail('ADDRESS_NOT_AVAILABLE', '请选择有效且包含配送区域的收货地址。');
    const quote = await buildQuote({ store, user, warehouseId, regionCode: address.regionCode, items: payload.items, channel: payload.channel, now: clock(), deliverySlotId: payload.deliverySlotId });
    return { quote };
  }

  async function userCreateOrder(payload) {
    const user = await ensureWechatUser();
    const paymentMethod = ['offline', 'demo'].includes(payload.paymentMethod) ? payload.paymentMethod : 'wechat';
    if (paymentMethod === 'offline') {
      if (user.userType !== 'b' || user.businessStatus !== 'approved') fail('OFFLINE_PAYMENT_FORBIDDEN', '线下结算仅限已审核的商家采购账号。');
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
    const items = await store.list('order_items', { where: { orderId: id }, page: 1, pageSize: 100 });
    return { order: safeOrder(order), items: items.rows.map(safeOrderItem) };
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
    return { refund: pick(result.refund, ['_id', 'refundNo', 'orderId', 'amountCent', 'currency', 'reason', 'status', 'createdAt', 'updatedAt']), idempotent: result.idempotent };
  }

  async function adminReviewRefund(payload) {
    const { admin } = await getAdmin(payload, 'refunds.write');
    const result = await reviewRefund({ store, admin, payload, now: clock() });
    await audit(admin, 'refunds.review', 'refund', result.refund._id, { status: result.refund.status, decision: payload.decision });
    return { refund: pick(result.refund, ['_id', 'refundNo', 'orderId', 'amountCent', 'currency', 'reason', 'status', 'reviewNote', 'reviewedAt']) };
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

  return { userAddresses, userUpsertAddress, userDeleteAddress, userCart, userUpsertCartItem, userRemoveCartItem, checkoutQuote, userCreateOrder, userOrders, userOrder, userCancelOrder, userCompleteOrder, wechatPaymentNotify, userPreparePayment, userRequestRefund, adminReviewRefund, refundNotify };
}
module.exports = { createCustomerOrderActions };
