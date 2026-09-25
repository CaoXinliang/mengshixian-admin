const assert = require('node:assert/strict');
const { createApplication } = require('../app');
const { createMemoryStore } = require('../../../../../test/support/receipt-flow-fixture.cjs');

async function main() {
  const base = createMemoryStore();
  let rejectAudit = false;
  const store = {
    ...base,
    create: (collection, item) => rejectAudit && collection === 'audit_logs' ? Promise.reject(new Error('本地模拟日志故障')) : base.create(collection, item),
    runTransaction: (work) => base.runTransaction((tx) => work({ ...tx,
      set: (collection, id, item) => rejectAudit && collection === 'audit_logs' ? Promise.reject(new Error('本地模拟日志故障')) : tx.set(collection, id, item)
    }))
  };
  const app = createApplication({ store, bootstrapToken: 'refund-local-bootstrap', piiEncryptionKey: 'refund-local-encryption-key' });
  const dispatch = (action, payload = {}) => app.dispatch({ action, payload, requestId: `refund-atomic-${action}` });
  const bootstrap = await dispatch('admin.bootstrap', { bootstrapToken: 'refund-local-bootstrap', username: 'refund-super', displayName: '本地退款审核员', password: 'refund-password-local' });
  assert.equal(bootstrap.ok, true, JSON.stringify(bootstrap.error));
  const login = await dispatch('admin.login', { username: 'refund-super', password: 'refund-password-local' });
  const call = (action, payload = {}) => dispatch(action, { adminToken: login.data.token, ...payload });
  await base.set('orders', 'order-refund-a', { _id: 'order-refund-a', orderNo: 'O-REFUND-A', status: 'delivered', paymentStatus: 'paid', totalAmountCent: 10000, activeRefundId: 'refund-a', itemsSnapshot: [{ productNameSnapshot: '本地鱼丸', specSnapshot: '500克/袋', quantity: 2, subtotalCent: 8000 }] });
  await base.set('refunds', 'refund-a', { _id: 'refund-a', refundNo: 'R-REFUND-A', orderId: 'order-refund-a', amountCent: 3000, reason: '破损', status: 'requested' });
  assert.equal((await dispatch('admin.refunds.reviewDetail', { id: 'refund-a' })).ok, false, '未登录不能读取退款与订单明细');
  const detail = await call('admin.refunds.reviewDetail', { id: 'refund-a' });
  assert.equal(detail.ok, true, JSON.stringify(detail.error));
  assert.equal(detail.data.refund.amountCent, 3000);
  assert.equal(detail.data.order.orderNo, 'O-REFUND-A');
  assert.equal(detail.data.order.items[0].productNameSnapshot, '本地鱼丸');
  assert.ok(detail.data.reviewToken, '核对页必须提供当前退款和订单的凭据');
  assert.equal((await call('admin.refunds.review', { id: 'refund-a', decision: 'approved' })).ok, false, '缺少核对凭据不能直接审核');
  const staff = await call('admin.staff.create', { username: 'refund-operator', displayName: '本地运营', phone: '13800138008', role: 'operator', password: 'local-operator-password' });
  assert.equal(staff.ok, true, JSON.stringify(staff.error));
  const operator = await dispatch('admin.login', { username: 'refund-operator', password: 'local-operator-password' });
  assert.equal((await dispatch('admin.refunds.reviewDetail', { id: 'refund-a', adminToken: operator.data.token })).ok, true, '运营可查看退款资料');
  assert.equal((await dispatch('admin.refunds.review', { id: 'refund-a', decision: 'approved', reviewToken: detail.data.reviewToken, adminToken: operator.data.token })).error?.code, 'ADMIN_FORBIDDEN', '运营不能批准退款');

  await base.update('orders', 'order-refund-a', { status: 'completed' });
  assert.equal((await call('admin.refunds.review', { id: 'refund-a', decision: 'approved', reviewToken: detail.data.reviewToken })).error?.code, 'REFUND_REVIEW_CHANGED', '原订单变动后旧核对不能生效');
  const currentDetail = await call('admin.refunds.reviewDetail', { id: 'refund-a' });
  assert.notEqual(currentDetail.data.reviewToken, detail.data.reviewToken);

  rejectAudit = true;
  const failed = await call('admin.refunds.review', { id: 'refund-a', decision: 'approved', reviewToken: currentDetail.data.reviewToken });
  assert.equal(failed.ok, false, '操作记录失败不得提示审核成功');
  const afterFailure = await call('admin.refunds.list');
  assert.equal(afterFailure.data.rows.find((row) => row._id === 'refund-a').status, 'requested', '操作记录失败时退款仍须待审核');

  rejectAudit = false;
  const approved = await call('admin.refunds.review', { id: 'refund-a', decision: 'approved', reviewToken: currentDetail.data.reviewToken });
  assert.equal(approved.ok, true, JSON.stringify(approved.error));
  assert.equal(approved.data.refund.status, 'processing', '审核通过仅进入处理中，不代表退款成功');
  assert.equal((await call('admin.refunds.list')).data.rows.find((row) => row._id === 'refund-a').status, 'processing');
  const logs = await call('admin.audit.list');
  assert.equal(logs.data.rows.filter((row) => row.action === 'refunds.review' && row.targetId === 'refund-a').length, 1, '成功审核只记录一次');
  assert.equal((await call('admin.refunds.review', { id: 'refund-a', decision: 'approved', reviewToken: detail.data.reviewToken })).ok, false, '重复审核不能再次生效');

  await base.set('orders', 'order-refund-b', { _id: 'order-refund-b', orderNo: 'O-REFUND-B', status: 'delivered', paymentStatus: 'paid', totalAmountCent: 10000, refundedAmountCent: 8000, activeRefundId: 'refund-b', itemsSnapshot: [{ productNameSnapshot: '本地鱼丸', quantity: 1, subtotalCent: 10000 }] });
  await base.set('refunds', 'refund-b', { _id: 'refund-b', refundNo: 'R-REFUND-B', orderId: 'order-refund-b', amountCent: 3000, reason: '数量不符', status: 'requested' });
  const overLimit = await call('admin.refunds.reviewDetail', { id: 'refund-b' });
  assert.equal(overLimit.data.order.availableRefundCent, 2000, '核对页应显示剩余可退金额');
  assert.equal((await call('admin.refunds.review', { id: 'refund-b', decision: 'approved', reviewToken: overLimit.data.reviewToken })).error?.code, 'REFUND_AMOUNT_INVALID', '不能批准超过当前剩余可退金额的申请');

  await base.set('orders', 'order-refund-c', { _id: 'order-refund-c', orderNo: 'O-REFUND-C', status: 'delivered', paymentStatus: 'paid', totalAmountCent: 6000, activeRefundId: 'refund-c', itemsSnapshot: [{ productNameSnapshot: '本地虾仁', quantity: 1, subtotalCent: 6000 }] });
  await base.set('refunds', 'refund-c', { _id: 'refund-c', refundNo: 'R-REFUND-C', orderId: 'order-refund-c', amountCent: 1500, reason: '破损', status: 'requested' });
  const rejectDetail = await call('admin.refunds.reviewDetail', { id: 'refund-c' });
  rejectAudit = true;
  assert.equal((await call('admin.refunds.review', { id: 'refund-c', decision: 'rejected', reviewToken: rejectDetail.data.reviewToken })).ok, false);
  assert.equal((await call('admin.refunds.list')).data.rows.find((row) => row._id === 'refund-c').status, 'requested', '驳回的操作记录失败也须回滚');
  rejectAudit = false;
  assert.equal((await call('admin.refunds.review', { id: 'refund-c', decision: 'rejected', reviewToken: rejectDetail.data.reviewToken })).data.refund.status, 'rejected', '回滚后原申请可安全重试驳回');
  console.log('Refund review and audit rollback, retry, processing status and duplicate guard: passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
