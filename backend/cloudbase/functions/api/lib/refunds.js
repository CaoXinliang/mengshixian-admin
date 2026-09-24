const { fail } = require('./response');
const { randomId } = require('./security');
const { refundId, inventoryId, inventoryLedgerId } = require('./transaction-ids');
const { removePaidMember } = require('./groups');

const REFUNDABLE_ORDER_STATUSES = ['pending_confirmation', 'picking', 'shipping', 'delivered', 'completed'];

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
    if (!order || order.userId !== user._id || !REFUNDABLE_ORDER_STATUSES.includes(order.status) || order.paymentStatus !== 'paid') fail('REFUND_NOT_AVAILABLE', '当前订单不可申请退款。');
    if (order.activeRefundId) fail('REFUND_ALREADY_PENDING', '该订单已有处理中的退款申请。');
    const paid = Number(order.totalAmountCent || 0);
    const refunded = Number(order.refundedAmountCent || 0);
    const amountCent = Number(payload.amountCent);
    if (!Number.isInteger(amountCent) || amountCent < 1 || amountCent > paid - refunded) fail('REFUND_AMOUNT_INVALID', '退款金额超过可退余额。');
    if (order.status === 'pending_confirmation' && amountCent !== paid - refunded) fail('REFUND_AMOUNT_INVALID', '未出库订单必须一次性申请剩余全额退款。');
    const timestamp = now.toISOString();
    const refund = { _id: deterministicRefundId, refundNo: `R${randomId('').slice(-14).toUpperCase()}`, orderId, userId: user._id, paymentId: String(order.paymentId || ''), amountCent, currency: 'CNY', reason: String(payload.reason || '').slice(0, 300), status: 'requested', idempotencyKey, createdAt: timestamp, updatedAt: timestamp };
    await tx.set('refunds', deterministicRefundId, refund);
    await tx.update('orders', orderId, { activeRefundId: deterministicRefundId, refundIds: [...new Set([...(order.refundIds || []), deterministicRefundId])], updatedAt: timestamp });
    return { refund, idempotent: false };
  });
}

async function reviewRefund({ store, admin, payload, now }) {
  if (typeof store.runTransaction !== 'function') fail('TRANSACTION_NOT_AVAILABLE', '当前环境不支持退款事务。');
  const id = String(payload.id || '').trim();
  const decision = String(payload.decision || '').trim();
  if (!id || !['approved', 'rejected'].includes(decision)) fail('VALIDATION_ERROR', '退款审核参数不合法。');
  // 审核必须在事务内二次校验状态：并发审批同一退款单时以后提交者的事务结果为准，不得互相覆盖
  return store.runTransaction(async (tx) => {
    const refund = await tx.getById('refunds', id);
    if (!refund || refund.status !== 'requested') fail('REFUND_NOT_FOUND', '退款申请不存在或已处理。');
    const timestamp = now.toISOString();
    const patch = { status: decision === 'approved' ? 'processing' : 'rejected', reviewedBy: admin._id, reviewedAt: timestamp, reviewNote: String(payload.reviewNote || '').slice(0, 300), updatedAt: timestamp };
    await tx.update('refunds', id, patch);
    if (decision === 'rejected') {
      const order = await tx.getById('orders', refund.orderId);
      if (order && order.activeRefundId === id) await tx.update('orders', order._id, { activeRefundId: '', updatedAt: timestamp });
    }
    return { refund: { ...refund, ...patch } };
  });
}

async function confirmRefund({ store, refund, refundTransactionId, refundedAmountCent, now }) {
  if (typeof store.runTransaction !== 'function') fail('TRANSACTION_NOT_AVAILABLE', '当前环境不支持退款事务。');
  return store.runTransaction(async (tx) => {
    const current = await tx.getById('refunds', refund._id);
    if (!current) fail('REFUND_NOT_FOUND', '退款记录不存在。');
    if (current.status === 'succeeded') return { refundId: current._id, orderId: current.orderId, idempotent: true };
    if (current.status !== 'processing') fail('REFUND_STATUS_INVALID', '退款当前不能确认。');
    if (Number(current.amountCent) !== Number(refundedAmountCent)) fail('REFUND_AMOUNT_MISMATCH', '退款金额与申请金额不一致。');
    const order = await tx.getById('orders', current.orderId);
    if (!order || order.paymentStatus !== 'paid') fail('ORDER_REFUND_NOT_AVAILABLE', '订单当前不能退款。');
    const timestamp = now.toISOString();
    const totalRefunded = Number(order.refundedAmountCent || 0) + Number(current.amountCent || 0);
    const orderPatch = { refundedAmountCent: totalRefunded, activeRefundId: '', refundStatus: totalRefunded >= Number(order.totalAmountCent || 0) ? 'refunded' : 'partially_refunded', updatedAt: timestamp };
    if (order.status === 'pending_confirmation') orderPatch.status = 'cancelled';
    await tx.update('refunds', current._id, { status: 'succeeded', refundTransactionId: String(refundTransactionId), refundedAt: timestamp, updatedAt: timestamp });
    await tx.update('orders', order._id, orderPatch);
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

module.exports = { requestRefund, reviewRefund, confirmRefund };
