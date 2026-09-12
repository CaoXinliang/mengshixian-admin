const { stableDocumentId } = require('./transaction-ids');

async function formalRewardRule(reader) {
  const rule = await reader.getById('points_rules', stableDocumentId('points_rule', ['order_reward']));
  return rule && rule.status === 'active' && rule.temporary !== true && rule.source !== 'ai_generated' ? rule : null;
}

async function awardOrderPoints(tx, order, now) {
  const ledgerId = stableDocumentId('points_order', [order._id]);
  const old = await tx.getById('points_ledger', ledgerId);
  if (old) return old;
  const rule = await formalRewardRule(tx);
  if (!rule) return null;
  const pointsPerYuan = Math.max(0, Number(rule.pointsPerYuan || 0));
  const change = Math.floor(Number(order.totalAmountCent || 0) / 100) * pointsPerYuan;
  if (!Number.isInteger(change) || change < 1) return null;
  const accountId = stableDocumentId('points', [order.userId]);
  const account = await tx.getById('points_accounts', accountId) || { _id: accountId, userId: order.userId, balance: 0, lifetimeEarned: 0 };
  const balanceAfter = Number(account.balance || 0) + change;
  const timestamp = now.toISOString();
  const ledger = { _id: ledgerId, userId: order.userId, orderId: order._id, action: 'order_reward', change, balanceAfter, ruleId: rule._id, idempotencyKey: `order:${order._id}`, createdAt: timestamp };
  await tx.set('points_ledger', ledgerId, ledger);
  await tx.set('points_accounts', accountId, { ...account, balance: balanceAfter, lifetimeEarned: Number(account.lifetimeEarned || 0) + change, updatedAt: timestamp });
  return ledger;
}

async function reverseRefundPoints(tx, order, refund, amountCent, now) {
  const ledgerId = stableDocumentId('points_refund', [refund._id]);
  const old = await tx.getById('points_ledger', ledgerId);
  if (old) return old;
  const reward = await tx.getById('points_ledger', stableDocumentId('points_order', [order._id]));
  if (!reward || Number(reward.change || 0) <= 0) return null;
  const total = Math.max(1, Number(order.totalAmountCent || 0));
  const requested = Math.min(Number(reward.change), Math.ceil(Number(reward.change) * Math.max(0, Number(amountCent || 0)) / total));
  const accountId = stableDocumentId('points', [order.userId]);
  const account = await tx.getById('points_accounts', accountId) || { _id: accountId, userId: order.userId, balance: 0, lifetimeEarned: Number(reward.change) };
  const debit = Math.min(Math.max(0, Number(account.balance || 0)), requested);
  const timestamp = now.toISOString();
  const ledger = { _id: ledgerId, userId: order.userId, orderId: order._id, refundId: refund._id, action: 'refund_reversal', change: -debit, requestedDebit: requested, balanceAfter: Number(account.balance || 0) - debit, idempotencyKey: `refund:${refund._id}`, createdAt: timestamp };
  await tx.set('points_ledger', ledgerId, ledger);
  await tx.set('points_accounts', accountId, { ...account, balance: ledger.balanceAfter, updatedAt: timestamp });
  return ledger;
}

module.exports = { awardOrderPoints, reverseRefundPoints };
