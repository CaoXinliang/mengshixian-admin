const { sha256 } = require('./security');

function stableDocumentId(prefix, parts) {
  const encoded = JSON.stringify(Array.isArray(parts) ? parts : [parts]);
  return `${prefix}_${sha256(encoded).slice(0, 48)}`;
}

function inventoryId(warehouseId, skuId) {
  return stableDocumentId('inv', [String(warehouseId), String(skuId)]);
}

function orderId(userId, idempotencyKey) {
  return stableDocumentId('ord', [String(userId), String(idempotencyKey)]);
}

function paymentId(orderIdValue) {
  return stableDocumentId('pay', [String(orderIdValue)]);
}

function reservationId(orderIdValue, skuId) {
  return stableDocumentId('res', [String(orderIdValue), String(skuId)]);
}

function orderItemId(orderIdValue, skuId) {
  return stableDocumentId('item', [String(orderIdValue), String(skuId)]);
}

function inventoryLedgerId(reason, referenceId, skuId) {
  return stableDocumentId('ledger', [String(reason), String(referenceId), String(skuId)]);
}

function refundId(userId, idempotencyKey) {
  return stableDocumentId('refund', [String(userId), String(idempotencyKey)]);
}

function groupMemberId(groupId, orderIdValue) {
  return stableDocumentId('gmem', [String(groupId), String(orderIdValue)]);
}

module.exports = {
  stableDocumentId,
  inventoryId,
  orderId,
  paymentId,
  reservationId,
  orderItemId,
  inventoryLedgerId,
  refundId,
  groupMemberId
};
