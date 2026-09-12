const { fail } = require('./response');
const { randomId } = require('./security');
const { refundId, inventoryId, inventoryLedgerId, stableDocumentId } = require('./transaction-ids');
const { removePaidMember } = require('./groups');
const { applyCreditRefund } = require('./b2b-credit');
const { releaseCredit } = require('./b2b-credit');
const { orderReservations, releaseReservation } = require('./commerce');
const { reverseRefundPoints } = require('./points');

const REFUNDABLE_ORDER_STATUSES = ['pending_confirmation', 'picking', 'shipping', 'delivered', 'completed'];
const REFUND_REASON_CODES = ['quality_issue', 'damaged', 'wrong_item', 'missing_item', 'not_received', 'other'];
const AFTER_SALE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function timelineEvent(status, now, actorType, note = '') {
  return { status, at: now.toISOString(), actorType, note: String(note || '').slice(0, 300) };
}

function orderItemRows(order) {
  const snapshots = Array.isArray(order.itemsSnapshot) ? order.itemsSnapshot : [];
  return snapshots.map((item, index) => ({ ...item, _id: item._id || (order.itemIds || [])[index] || '', orderItemId: item.orderItemId || item._id || (order.itemIds || [])[index] || '' }));
}

async function loadOrderItemsInTransaction(tx, order) {
  const snapshots = orderItemRows(order);
  if (snapshots.length) return snapshots;
  const rows = [];
  for (const id of order.itemIds || []) {
    const item = await tx.getById('order_items', id);
    if (item) rows.push({ ...item, orderItemId: item._id });
  }
  return rows;
}

function afterSaleDeadline(order) {
  if (!['delivered', 'completed'].includes(order.status)) return '';
  const anchor = order.completedAt || order.deliveredAt || order.updatedAt || order.createdAt;
  const time = new Date(anchor || '').getTime();
  return Number.isFinite(time) ? new Date(time + AFTER_SALE_WINDOW_MS).toISOString() : '';
}

function validateWindow(order, now) {
  const deadline = afterSaleDeadline(order);
  if (deadline && now.getTime() > new Date(deadline).getTime()) fail('REFUND_WINDOW_EXPIRED', '该订单已超过 7 天售后申请期限。');
  return deadline;
}

function structuredRefundLines(payloadItems, orderItems, reservedByItem) {
  if (!Array.isArray(payloadItems) || !payloadItems.length || payloadItems.length > 20) fail('REFUND_ITEMS_INVALID', '售后商品必须为 1 到 20 条。');
  const seen = new Set();
  return payloadItems.map((input) => {
    const requestedOrderItemId = String(input && input.orderItemId || '').trim();
    const requestedSkuId = String(input && input.skuId || '').trim();
    const matches = orderItems.filter((candidate) => requestedOrderItemId
      ? (candidate.orderItemId === requestedOrderItemId || candidate._id === requestedOrderItemId)
      : requestedSkuId && candidate.skuId === requestedSkuId);
    if (!requestedOrderItemId && matches.length > 1) fail('REFUND_ITEM_AMBIGUOUS', '该 SKU 在订单中对应多个订单项，请改用 orderItemId。');
    const item = matches[0];
    if (!item) fail('REFUND_ITEM_NOT_FOUND', '售后商品不属于该订单。');
    const key = item.orderItemId || item._id || item.skuId;
    if (seen.has(key)) fail('REFUND_ITEMS_INVALID', '同一订单项不能重复提交。');
    seen.add(key);
    const quantity = Number(input && input.quantity);
    const orderedQuantity = Number(item.quantity || 0);
    const reservedQuantity = Number(reservedByItem[key] || 0);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > orderedQuantity - reservedQuantity) fail('REFUND_QUANTITY_INVALID', '申请数量超过该订单项可售后数量。');
    const refundableAmountCent = Number(item.refundableAmountCent === undefined ? (item.paidSubtotalCent === undefined ? Number(item.unitPriceCent || 0) * orderedQuantity : item.paidSubtotalCent) : item.refundableAmountCent);
    const beforeAmount = Math.floor(refundableAmountCent * reservedQuantity / orderedQuantity);
    const afterAmount = Math.floor(refundableAmountCent * (reservedQuantity + quantity) / orderedQuantity);
    return { orderItemId: item.orderItemId || item._id || '', skuId: item.skuId, productId: item.productId || '', productNameSnapshot: item.productNameSnapshot || '', specSnapshot: item.specSnapshot || '', packageUnitSnapshot: item.packageUnitSnapshot || '', quantity, unitPriceCent: Number(item.unitPriceCent || 0), paidSubtotalCent: Number(item.paidSubtotalCent === undefined ? refundableAmountCent : item.paidSubtotalCent), refundableAmountCent, amountCent: afterAmount - beforeAmount, mediaSnapshot: item.mediaSnapshot || '' };
  });
}

async function requestRefund({ store, user, payload, now }) {
  const orderId = String(payload.orderId || '').trim();
  const idempotencyKey = String(payload.idempotencyKey || '').trim();
  if (!orderId || !idempotencyKey || idempotencyKey.length > 120) fail('VALIDATION_ERROR', '订单和退款幂等键不能为空。');
  if (typeof store.runTransaction !== 'function') fail('TRANSACTION_NOT_AVAILABLE', '当前环境不支持退款事务。');
  const deterministicRefundId = refundId(user._id, idempotencyKey);
  return store.runTransaction(async (tx) => {
    const existing = await tx.getById('refunds', deterministicRefundId);
    if (existing) {
      if (existing.userId !== user._id || existing.idempotencyKey !== idempotencyKey) fail('IDEMPOTENCY_CONFLICT', '幂等键与既有退款不匹配。');
      return { refund: existing, idempotent: true };
    }
    const order = await tx.getById('orders', orderId);
    if (!order || order.userId !== user._id || !REFUNDABLE_ORDER_STATUSES.includes(order.status) || !(order.paymentStatus === 'paid' || (order.paymentMethod === 'credit' && ['credit_reserved', 'credit_invoiced'].includes(order.paymentStatus)))) fail('REFUND_NOT_AVAILABLE', '当前订单不可申请退款。');
    if (order.activeRefundId) fail('REFUND_ALREADY_PENDING', '该订单已有处理中的退款申请。');
    const deadlineAt = validateWindow(order, now);
    const paid = Number(order.totalAmountCent || 0);
    const refunded = Number(order.refundedAmountCent || 0);
    const orderItems = await loadOrderItemsInTransaction(tx, order);
    const reservedByItem = { ...(order.afterSaleQuantityByItem || {}) };
    const structured = Array.isArray(payload.items) && payload.items.length > 0;
    const items = structured ? structuredRefundLines(payload.items, orderItems, reservedByItem) : [];
    const selectsAllRemainingItems = structured && orderItems.length > 0 && orderItems.every((orderItem) => {
      const key = orderItem.orderItemId || orderItem._id || orderItem.skuId;
      const remaining = Number(orderItem.quantity || 0) - Number(reservedByItem[key] || 0);
      const selected = items.find((item) => (item.orderItemId || item.skuId) === key);
      return remaining === 0 || Boolean(selected && selected.quantity === remaining);
    });
    const goodsAmountCent = structured ? items.reduce((total, item) => total + item.amountCent, 0) : 0;
    // 仅当服务端确认选择了全部剩余商品时，才把剩余运费等订单金额计入整单退款；部分商品永不接受客户端指定运费。
    const amountCent = structured ? (selectsAllRemainingItems ? paid - refunded : goodsAmountCent) : Number(payload.amountCent);
    if (!Number.isInteger(amountCent) || amountCent < 1 || amountCent > paid - refunded) fail('REFUND_AMOUNT_INVALID', '退款金额超过可退余额。');
    if (!structured && amountCent !== paid - refunded) fail('REFUND_AMOUNT_INVALID', '旧版非结构化申请仅兼容剩余全额退款。');
    if (order.status === 'pending_confirmation' && amountCent !== paid - refunded) fail('REFUND_AMOUNT_INVALID', '未出库订单必须一次性申请剩余全额退款。');
    const reasonCode = structured ? String(payload.reasonCode || '').trim() : 'other';
    if (!REFUND_REASON_CODES.includes(reasonCode)) fail('REFUND_REASON_INVALID', '售后原因不在允许范围内。');
    const description = String(payload.description === undefined ? payload.reason || '' : payload.description).trim().slice(0, 500);
    const mediaIds = Array.isArray(payload.mediaIds) ? [...new Set(payload.mediaIds.map((id) => String(id || '').trim()).filter(Boolean))] : [];
    if (mediaIds.length > 6) fail('REFUND_MEDIA_INVALID', '售后凭证最多上传 6 个。');
    for (const mediaId of mediaIds) {
      const media = await tx.getById('media_assets', mediaId);
      if (!media || media.enabled === false || !['image', 'video'].includes(media.type) || media.userId !== user._id || media.purpose !== 'aftersale_evidence') fail('REFUND_MEDIA_INVALID', '售后凭证素材不存在、用途不符或不属于当前用户。');
    }
    for (const item of items) {
      const key = item.orderItemId || item.skuId;
      reservedByItem[key] = Number(reservedByItem[key] || 0) + item.quantity;
    }
    const timestamp = now.toISOString();
    const refund = { _id: deterministicRefundId, refundNo: `R${randomId('').slice(-14).toUpperCase()}`, orderId, userId: user._id, organizationId: order.organizationId || '', paymentId: String(order.paymentId || ''), items, amountCent, goodsAmountCent: structured ? goodsAmountCent : amountCent, includedOrderAdjustmentCent: structured ? amountCent - goodsAmountCent : 0, currency: 'CNY', reasonCode, description, reason: description, mediaIds, deadlineAt, status: 'requested', channelStatus: 'not_started', manualRefundRequired: false, statusTimeline: [timelineEvent('requested', now, 'user', description)], idempotencyKey, createdAt: timestamp, updatedAt: timestamp };
    await tx.set('refunds', deterministicRefundId, refund);
    await tx.update('orders', orderId, { activeRefundId: deterministicRefundId, refundIds: [...new Set([...(order.refundIds || []), deterministicRefundId])], afterSaleQuantityByItem: reservedByItem, updatedAt: timestamp });
    return { refund, idempotent: false };
  });
}

async function reviewRefund({ store, admin, payload, now }) {
  if (typeof store.runTransaction !== 'function') fail('TRANSACTION_NOT_AVAILABLE', '当前环境不支持退款事务。');
  const id = String(payload.id || '').trim();
  const decision = String(payload.decision || '').trim();
  if (!id || !['approved', 'rejected'].includes(decision)) fail('VALIDATION_ERROR', '退款审核参数不合法。');
  const idempotencyKey = String(payload.idempotencyKey || `legacy-review:${id}:${decision}`).trim();
  if (!idempotencyKey || idempotencyKey.length > 120) fail('VALIDATION_ERROR', '审核幂等键不合法。');
  const operationId = stableDocumentId('refund_op', [admin._id, idempotencyKey]);
  return store.runTransaction(async (tx) => {
    const existingOperation = await tx.getById('refund_operations', operationId);
    if (existingOperation) {
      if (existingOperation.refundId !== id || existingOperation.action !== `review:${decision}` || existingOperation.idempotencyKey !== idempotencyKey) fail('IDEMPOTENCY_CONFLICT', '审核幂等键已用于其他操作。');
      return { refund: await tx.getById('refunds', existingOperation.refundId), idempotent: true };
    }
    const refund = await tx.getById('refunds', id);
    if (!refund || refund.status !== 'requested') fail('REFUND_NOT_FOUND', '退款申请不存在或已处理。');
    const timestamp = now.toISOString();
    const order = await tx.getById('orders', refund.orderId);
    const creditApproved = decision === 'approved' && order && order.paymentMethod === 'credit';
    let creditAdjustmentCent = 0; let cashRefundRequiredCent = 0;
    if (creditApproved && order.creditStatus === 'invoiced') {
      const statement = await tx.getById('statements', stableDocumentId('statement', [order.organizationId, order._id]));
      creditAdjustmentCent = Math.min(Number(refund.amountCent || 0), Number(statement && statement.outstandingCent || 0));
      cashRefundRequiredCent = Number(refund.amountCent || 0) - creditAdjustmentCent;
      if (creditAdjustmentCent > 0) await applyCreditRefund(tx, order, refund, admin._id, now, creditAdjustmentCent);
    }
    if (creditApproved && order.creditStatus === 'reserved') {
      if (Number(refund.amountCent) !== Number(order.totalAmountCent)) fail('CREDIT_RESERVED_REFUND_FULL_REQUIRED', '未完成账期订单只能整单释放授信。');
      await releaseCredit(tx, order, now, 'credit_aftersale_cancelled');
      for (const reservation of await orderReservations(tx, order)) await releaseReservation(tx, reservation, order, now, 'credit_refund_release');
    }
    const creditFinished = creditApproved && (order.creditStatus === 'reserved' || cashRefundRequiredCent === 0);
    const nextStatus = decision === 'approved' ? (creditFinished ? 'succeeded' : 'awaiting_manual_refund') : 'rejected';
    const patch = { status: nextStatus, channelStatus: creditFinished ? (order.creditStatus === 'reserved' ? 'internal_credit_release' : 'internal_credit_adjustment') : (decision === 'approved' ? 'awaiting_manual_refund' : 'not_started'), manualRefundRequired: decision === 'approved' && !creditFinished, creditAdjustmentCent, cashRefundRequiredCent, reviewedBy: admin._id, reviewedAt: timestamp, refundedAt: creditFinished ? timestamp : refund.refundedAt, reviewNote: String(payload.reviewNote || '').slice(0, 300), statusTimeline: [...(refund.statusTimeline || [timelineEvent(refund.status || 'requested', now, 'user')]), timelineEvent(nextStatus, now, 'admin', payload.reviewNote)], updatedAt: timestamp };
    await tx.update('refunds', id, patch);
    if (decision === 'rejected') {
      if (order) {
        const reservedByItem = { ...(order.afterSaleQuantityByItem || {}) };
        for (const item of refund.items || []) {
          const key = item.orderItemId || item.skuId;
          reservedByItem[key] = Math.max(0, Number(reservedByItem[key] || 0) - Number(item.quantity || 0));
        }
        await tx.update('orders', order._id, { activeRefundId: order.activeRefundId === id ? '' : order.activeRefundId, afterSaleQuantityByItem: reservedByItem, updatedAt: timestamp });
      }
    } else if (creditApproved) {
      const immediatelyAppliedCent = order.creditStatus === 'reserved' ? Number(refund.amountCent || 0) : creditAdjustmentCent;
      const totalRefunded = Number(order.refundedAmountCent || 0) + immediatelyAppliedCent;
      await tx.update('orders', order._id, { activeRefundId: creditFinished ? '' : id, refundedAmountCent: totalRefunded, refundStatus: totalRefunded >= Number(order.totalAmountCent || 0) ? 'refunded' : 'partially_refunded', status: order.creditStatus === 'reserved' ? 'cancelled' : order.status, cancelledAt: order.creditStatus === 'reserved' ? timestamp : order.cancelledAt, updatedAt: timestamp });
      if (creditFinished) await reverseRefundPoints(tx, order, refund, refund.amountCent, now);
    }
    await tx.set('refund_operations', operationId, { refundId: id, adminId: admin._id, action: `review:${decision}`, idempotencyKey, createdAt: timestamp });
    return { refund: { ...refund, ...patch }, idempotent: false };
  });
}

async function processRefund({ store, admin, payload, now }) {
  if (typeof store.runTransaction !== 'function') fail('TRANSACTION_NOT_AVAILABLE', '当前环境不支持退款事务。');
  const id = String(payload.id || '').trim();
  const action = String(payload.action || '').trim();
  const idempotencyKey = String(payload.idempotencyKey || '').trim();
  if (!id || action !== 'channel_pending' || !idempotencyKey || idempotencyKey.length > 120) fail('VALIDATION_ERROR', '退款状态推进参数或幂等键不合法。');
  const operationId = stableDocumentId('refund_op', [admin._id, idempotencyKey]);
  return store.runTransaction(async (tx) => {
    const existingOperation = await tx.getById('refund_operations', operationId);
    if (existingOperation) {
      if (existingOperation.refundId !== id || existingOperation.action !== action || existingOperation.idempotencyKey !== idempotencyKey) fail('IDEMPOTENCY_CONFLICT', '退款处理幂等键已用于其他操作。');
      return { refund: await tx.getById('refunds', existingOperation.refundId), idempotent: true };
    }
    const refund = await tx.getById('refunds', id);
    if (!refund || !['awaiting_manual_refund', 'processing'].includes(refund.status)) fail('REFUND_STATUS_INVALID', '退款当前不能推进到渠道处理中。');
    const timestamp = now.toISOString();
    const note = String(payload.note || '').slice(0, 300);
    const patch = { status: 'channel_pending', channelStatus: 'channel_pending', manualRefundRequired: true, statusTimeline: [...(refund.statusTimeline || []), timelineEvent('channel_pending', now, 'admin', note)], updatedAt: timestamp };
    await tx.update('refunds', id, patch);
    await tx.set('refund_operations', operationId, { refundId: id, adminId: admin._id, action, idempotencyKey, createdAt: timestamp });
    return { refund: { ...refund, ...patch }, idempotent: false };
  });
}

async function confirmRefund({ store, refund, refundTransactionId, refundedAmountCent, now }) {
  if (typeof store.runTransaction !== 'function') fail('TRANSACTION_NOT_AVAILABLE', '当前环境不支持退款事务。');
  return store.runTransaction(async (tx) => {
    const current = await tx.getById('refunds', refund._id);
    if (!current) fail('REFUND_NOT_FOUND', '退款记录不存在。');
    if (current.status === 'succeeded') return { refundId: current._id, orderId: current.orderId, idempotent: true };
    if (!['processing', 'awaiting_manual_refund', 'channel_pending'].includes(current.status)) fail('REFUND_STATUS_INVALID', '退款当前不能确认。');
    const channelAmountCent = Number(current.cashRefundRequiredCent || current.amountCent);
    if (channelAmountCent !== Number(refundedAmountCent)) fail('REFUND_AMOUNT_MISMATCH', '退款金额与申请金额不一致。');
    const order = await tx.getById('orders', current.orderId);
    if (!order || !(order.paymentStatus === 'paid' || (order.paymentMethod === 'credit' && order.paymentStatus === 'credit_invoiced'))) fail('ORDER_REFUND_NOT_AVAILABLE', '订单当前不能退款。');
    const timestamp = now.toISOString();
    const totalRefunded = Number(order.refundedAmountCent || 0) + channelAmountCent;
    const orderPatch = { refundedAmountCent: totalRefunded, activeRefundId: '', refundStatus: totalRefunded >= Number(order.totalAmountCent || 0) ? 'refunded' : 'partially_refunded', updatedAt: timestamp };
    if (order.status === 'pending_confirmation') orderPatch.status = 'cancelled';
    await tx.update('refunds', current._id, { status: 'succeeded', channelStatus: 'succeeded', manualRefundRequired: false, refundTransactionId: String(refundTransactionId), refundedAt: timestamp, statusTimeline: [...(current.statusTimeline || []), timelineEvent('succeeded', now, 'channel')], updatedAt: timestamp });
    await tx.update('orders', order._id, orderPatch);
    await reverseRefundPoints(tx, order, current, current.amountCent, now);
    if (order.groupId) await removePaidMember(tx, { groupId: order.groupId, orderId: order._id, now });
    if (order.status === 'pending_confirmation') {
      for (const reservationIdValue of order.reservationIds || []) {
        const reservation = await tx.getById('inventory_reservations', reservationIdValue);
        if (!reservation || reservation.status !== 'consumed') continue;
        const inventory = await tx.getById('inventory', inventoryId(reservation.warehouseId, reservation.skuId));
        if (!inventory) fail('INVENTORY_NOT_FOUND', '退款回补库存记录缺失。');
        const quantity = Number(reservation.quantity || 0); const onHand = Number(inventory.onHand || 0); const reserved = Number(inventory.reserved || 0);
        await tx.update('inventory', inventory._id, { onHand: onHand + quantity, available: onHand + quantity - reserved, version: Number(inventory.version || 0) + 1, updatedAt: timestamp });
        await tx.update('inventory_reservations', reservation._id, { status: 'released', refundedAt: timestamp });
        await tx.set('inventory_ledger', inventoryLedgerId('refund_restock', current._id, reservation.skuId), { warehouseId: reservation.warehouseId, skuId: reservation.skuId, change: quantity, reservedChange: 0, before: onHand - reserved, after: onHand + quantity - reserved, reason: 'refund_restock', referenceType: 'refund', referenceId: current._id, operatorId: 'system', idempotencyKey: `refund-restock:${current._id}:${reservation._id}`, createdAt: timestamp });
      }
    }
    return { refundId: current._id, orderId: order._id, idempotent: false };
  });
}

module.exports = { REFUND_REASON_CODES, requestRefund, reviewRefund, processRefund, confirmRefund };
