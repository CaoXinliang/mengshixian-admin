const { fail } = require('./response');
const { sha256 } = require('./security');
const { string } = require('./api-values');
const { collectPageMatches } = require('./collection-read');

function collectionSummary(order) {
  if (order.receivedAmountCent == null || !['offline_pending', 'offline_partial', 'offline_paid'].includes(order.paymentStatus)) {
    return { receivedAmountCent: null, outstandingAmountCent: null, collectionStatus: 'unknown' };
  }
  const received = order.receivedAmountCent;
  if (!Number.isSafeInteger(received) || received < 0 || !Number.isSafeInteger(order.totalAmountCent) || order.totalAmountCent <= 0 || received > order.totalAmountCent) fail('RECEIPT_BALANCE_INVALID', '订单收款金额异常，请先核实，不能继续登记。');
  return { receivedAmountCent: received, outstandingAmountCent: order.totalAmountCent - received,
    collectionStatus: received === 0 ? 'unpaid' : received === order.totalAmountCent ? 'paid' : 'partial' };
}

function receiptDate(value, now) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  const invalid = () => fail('RECEIPT_TIME_INVALID', '请填写真实存在且不晚于当前时间的实际收款时间。');
  if (!parts) invalid();
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) invalid();
  if (parts[7] !== 'Z' && (Number(parts[8]) > 14 || Number(parts[9]) > 59 || Number(parts[8]) === 14 && Number(parts[9]) !== 0)) invalid();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date > now) invalid();
  return date;
}

function createOfflineReceipts({ store, getAdmin, clock }) {
  function unavailableReason(order) {
    return ['cancelled', 'closed'].includes(order.status) || order.activeRefundId || order.refundStatus && !['none', 'rejected'].includes(order.refundStatus)
      ? '订单已取消或涉及退款，请先核实后处理，不能直接登记收款。' : '';
  }
  async function list(payload) {
    await getAdmin(payload, 'receipts.read');
    const orderId = string(payload.orderId, '订单', { required: true, max: 100 });
    const order = await store.getById('orders', orderId);
    if (!order || order.paymentMethod !== 'offline') fail('OFFLINE_ORDER_REQUIRED', '请选择线下付款订单。');
    const summary = collectionSummary(order);
    const registrationBlockedReason = unavailableReason(order) || (summary.collectionStatus === 'unknown' ? '历史收款待核实，不能直接补记。' : summary.collectionStatus === 'paid' ? '本单已收齐，无需继续登记。' : '');
    return { orderId, orderNo: order.orderNo, totalAmountCent: order.totalAmountCent, orderStatus: order.status, ...summary, registrationBlockedReason, rows: await collectPageMatches(store, 'order_receipts', { where: { orderId }, orderBy: [{ field: 'createdAt', direction: 'desc' }] }, () => true) };
  }
  async function record(payload) {
    const { admin } = await getAdmin(payload, 'receipts.write');
    const orderId = string(payload.orderId, '订单', { required: true, max: 100 });
    const key = string(payload.idempotencyKey, '本次登记凭据', { required: true, max: 120 });
    const amountCent = payload.amountCent;
    if (!Number.isSafeInteger(amountCent) || amountCent <= 0) fail('RECEIPT_AMOUNT_INVALID', '实收金额必须大于零，最多两位小数。');
    const method = string(payload.method, '收款方式', { required: true, max: 30 });
    if (!['bank_transfer', 'wechat_transfer', 'alipay_transfer', 'cash', 'other'].includes(method)) fail('RECEIPT_METHOD_INVALID', '请选择有效收款方式。');
    const receivedAt = string(payload.receivedAt, '实际收款时间', { required: true, max: 40 });
    const date = receiptDate(receivedAt, clock());
    const note = string(payload.note, '备注', { max: 500 });
    if (method === 'other' && !note) fail('RECEIPT_NOTE_REQUIRED', '其他收款方式请在备注中说明。');
    const fingerprint = sha256(JSON.stringify([orderId, amountCent, date.toISOString(), method, note]));
    const id = `receipt_${sha256(`${orderId}:${key}`)}`;
    return store.runTransaction(async (tx) => {
      const order = await tx.getById('orders', orderId);
      if (!order || order.paymentMethod !== 'offline') fail('OFFLINE_ORDER_REQUIRED', '仅能登记线下付款订单的实际收款。');
      const existing = await tx.getById('order_receipts', id);
      if (existing) {
        if (existing.fingerprint !== fingerprint) fail('RECEIPT_RETRY_CONFLICT', '这次登记凭据已使用，请勿更改原登记内容重试。');
        return { receipt: existing, ...collectionSummary(order), idempotent: true };
      }
      if (unavailableReason(order)) fail('RECEIPT_ORDER_UNAVAILABLE', unavailableReason(order));
      const before = collectionSummary(order);
      if (before.collectionStatus === 'unknown') fail('RECEIPT_HISTORY_UNVERIFIED', '历史订单收款情况待核实，不能按未收款直接补记；请先核对原始收款记录。');
      if (amountCent > before.outstandingAmountCent) fail('RECEIPT_EXCEEDS_BALANCE', '登记金额超过订单待收金额，请核对实际到账，不要重复登记。');
      const summary = collectionSummary({ ...order, receivedAmountCent: before.receivedAmountCent + amountCent });
      const createdAt = clock().toISOString();
      const receipt = { _id: id, orderId, orderNo: order.orderNo, amountCent, receivedAt: date.toISOString(), method, note,
        operatorId: admin._id, operatorName: admin.displayName || admin.username || '管理员', fingerprint, createdAt };
      await tx.set('order_receipts', id, receipt);
      await tx.update('orders', orderId, { ...summary, paymentStatus: summary.collectionStatus === 'paid' ? 'offline_paid' : 'offline_partial', updatedAt: createdAt });
      await tx.set('audit_logs', `audit_${id}`, { actorType: 'admin', actorId: admin._id, action: 'orders.receipt.record', targetType: 'order', targetId: orderId,
        details: { receiptId: id, amountCent, receivedAt: receipt.receivedAt, method, beforeAmountCent: before.receivedAmountCent, afterAmountCent: summary.receivedAmountCent }, createdAt });
      return { receipt, ...summary, idempotent: false };
    });
  }
  return { list, record };
}

module.exports = { createOfflineReceipts, collectionSummary };
