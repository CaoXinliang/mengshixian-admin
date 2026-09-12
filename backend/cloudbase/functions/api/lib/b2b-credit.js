const { fail } = require('./response');
const { stableDocumentId } = require('./transaction-ids');

function accountId(organizationId) { return stableDocumentId('credit', [String(organizationId)]); }
function ledgerId(action, orderId) { return stableDocumentId('creditledger', [String(action), String(orderId)]); }
async function reserveCredit(tx, { user, orderId, amountCent, now }) {
  if (!user || user.userType !== 'b' || user.businessStatus !== 'approved' || !user.organizationId) fail('CREDIT_PAYMENT_FORBIDDEN', '账期结算仅限已审核企业采购账号。');
  const id = accountId(user.organizationId); const account = await tx.getById('credit_accounts', id);
  if (!account || account.status !== 'active' || account.temporary === true || account.source === 'ai_generated') fail('CREDIT_ACCOUNT_NOT_ACTIVE', '企业尚无已确认并启用的真实授信账户。');
  const available = Number(account.creditLimitCent || 0) - Number(account.occupiedCent || 0) - Number(account.receivableCent || 0);
  if (available < amountCent) fail('CREDIT_LIMIT_EXCEEDED', '可用账期额度不足。');
  const timestamp = now.toISOString(); const occupiedCent = Number(account.occupiedCent || 0) + amountCent;
  await tx.update('credit_accounts', id, { occupiedCent, updatedAt: timestamp });
  await tx.set('receivable_ledger', ledgerId('reserve', orderId), { _id: ledgerId('reserve', orderId), organizationId: user.organizationId, accountId: id, orderId, action: 'credit_reserved', amountCent, occupiedChangeCent: amountCent, receivableChangeCent: 0, idempotencyKey: `reserve:${orderId}`, createdAt: timestamp });
  return id;
}
async function releaseCredit(tx, order, now, reason = 'order_cancelled') {
  if (!order || order.paymentMethod !== 'credit' || order.creditStatus !== 'reserved') return false;
  const id = order.creditAccountId || accountId(order.organizationId); const account = await tx.getById('credit_accounts', id); if (!account) fail('CREDIT_ACCOUNT_NOT_FOUND', '账期账户不存在。');
  const amount = Number(order.totalAmountCent || 0); const timestamp = now.toISOString();
  await tx.update('credit_accounts', id, { occupiedCent: Math.max(0, Number(account.occupiedCent || 0) - amount), updatedAt: timestamp });
  await tx.set('receivable_ledger', ledgerId('release', order._id), { _id: ledgerId('release', order._id), organizationId: order.organizationId, accountId: id, orderId: order._id, action: 'credit_released', reason, amountCent: amount, occupiedChangeCent: -amount, receivableChangeCent: 0, idempotencyKey: `release:${order._id}`, createdAt: timestamp });
  await tx.update('orders', order._id, { creditStatus: 'released', paymentStatus: 'credit_released', updatedAt: timestamp }); return true;
}
async function convertCredit(tx, order, now) {
  if (!order || order.paymentMethod !== 'credit') return false;
  if (order.creditStatus === 'invoiced') return true;
  if (order.creditStatus !== 'reserved') fail('CREDIT_STATUS_INVALID', '订单账期占用状态异常。');
  const id = order.creditAccountId || accountId(order.organizationId); const account = await tx.getById('credit_accounts', id); if (!account) fail('CREDIT_ACCOUNT_NOT_FOUND', '账期账户不存在。');
  const amount = Number(order.totalAmountCent || 0); const timestamp = now.toISOString();
  await tx.update('credit_accounts', id, { occupiedCent: Math.max(0, Number(account.occupiedCent || 0) - amount), receivableCent: Number(account.receivableCent || 0) + amount, updatedAt: timestamp });
  await tx.set('receivable_ledger', ledgerId('invoice', order._id), { _id: ledgerId('invoice', order._id), organizationId: order.organizationId, accountId: id, orderId: order._id, action: 'receivable_created', amountCent: amount, occupiedChangeCent: -amount, receivableChangeCent: amount, idempotencyKey: `invoice:${order._id}`, createdAt: timestamp });
  await tx.set('statements', stableDocumentId('statement', [order.organizationId, order._id]), { _id: stableDocumentId('statement', [order.organizationId, order._id]), organizationId: order.organizationId, accountId: id, orderId: order._id, statementNo: `ST${String(order.orderNo || order._id)}`, amountCent: amount, paidCent: 0, outstandingCent: amount, status: 'open', source: 'system', temporary: false, createdAt: timestamp, updatedAt: timestamp });
  await tx.update('orders', order._id, { creditStatus: 'invoiced', paymentStatus: 'credit_invoiced', updatedAt: timestamp }); return true;
}
async function applyCreditRefund(tx, order, refund, adminId, now, adjustmentCent = Number(refund.amountCent || 0)) {
  if (!order || order.paymentMethod !== 'credit' || order.creditStatus !== 'invoiced') fail('CREDIT_REFUND_INVALID', '账期订单当前不可冲减应收。');
  const id = order.creditAccountId || accountId(order.organizationId); const account = await tx.getById('credit_accounts', id); if (!account) fail('CREDIT_ACCOUNT_NOT_FOUND', '账期账户不存在。'); const amount = Number(adjustmentCent || 0); const statementId = stableDocumentId('statement', [order.organizationId, order._id]); const statement = await tx.getById('statements', statementId); if (amount < 1 || !statement || Number(statement.outstandingCent || 0) < amount || Number(account.receivableCent || 0) < amount) fail('CREDIT_RECEIVABLE_INVALID', '该订单未结应收余额不足，不能执行冲减。'); const timestamp = now.toISOString();
  await tx.update('credit_accounts', id, { receivableCent: Number(account.receivableCent || 0) - amount, updatedAt: timestamp });
  const outstanding = Number(statement.outstandingCent || 0) - amount; await tx.update('statements', statementId, { outstandingCent: outstanding, status: outstanding === 0 ? 'credited' : 'partial_credit', updatedAt: timestamp });
  const idempotencyKey = `credit-refund:${refund._id}`; await tx.set('receivable_ledger', stableDocumentId('creditledger', ['refund', refund._id]), { _id: stableDocumentId('creditledger', ['refund', refund._id]), organizationId: order.organizationId, accountId: id, orderId: order._id, statementId, refundId: refund._id, action: 'receivable_refund_credit', amountCent: amount, occupiedChangeCent: 0, receivableChangeCent: -amount, idempotencyKey, operatorId: adminId, createdAt: timestamp });
  return { timestamp };
}
module.exports = { accountId, reserveCredit, releaseCredit, convertCredit, applyCreditRefund };
