const assert = require('node:assert/strict');
const { createOfflineReceipts } = require('../lib/offline-receipts');
let data = { orders: { o: { _id: 'o', orderNo: 'LOCAL-ONLY', paymentMethod: 'offline', paymentStatus: 'offline_pending', receivedAmountCent: 0, status: 'delivered', totalAmountCent: 10000 } }, order_receipts: {}, audit_logs: {} };
let queue = Promise.resolve();
let failWrite = '';
const store = {
  getById: async (table, id) => data[table][id],
  list: async (table, options) => ({ rows: Object.values(data[table]).filter(row => Object.entries(options.where || {}).every(([k, v]) => row[k] === v)) }),
  runTransaction(work) {
    const execute = async () => {
      const draft = structuredClone(data);
      const result = await work({ getById: async (t, id) => draft[t][id], set: async (t, id, row) => { draft[t][id] = row; if (failWrite === t) throw new Error('injected-write-failure'); }, update: async (t, id, patch) => { Object.assign(draft[t][id], patch); if (failWrite === t) throw new Error('injected-write-failure'); } });
      data = draft; return result;
    };
    const result = queue.then(execute); queue = result.catch(() => {}); return result;
  }
};
const api = createOfflineReceipts({ store, clock: () => new Date('2026-09-23T12:00:00Z'), getAdmin: async (payload, permission) => {
  if (!payload.authorized) throw Object.assign(new Error('denied'), { code: 'ADMIN_FORBIDDEN' });
  assert.ok(['receipts.read', 'receipts.write'].includes(permission)); return { admin: { _id: 'operator', displayName: '测试运营' } };
} });
const base = { authorized: true, orderId: 'o', idempotencyKey: 'first', amountCent: 3000, receivedAt: '2026-09-23T11:00:00Z', method: 'bank_transfer', note: '仅本地测试' };
(async () => {
  data.orders.legacy = { _id: 'legacy', paymentMethod: 'offline', paymentStatus: 'paid', status: 'delivered', totalAmountCent: 10000 };
  assert.equal((await api.list({ ...base, orderId: 'legacy' })).collectionStatus, 'unknown');
  await assert.rejects(() => api.record({ ...base, orderId: 'legacy' }), { code: 'RECEIPT_HISTORY_UNVERIFIED' });
  for (const paymentStatus of ['paid', 'not_required']) {
    data.orders.legacy.receivedAmountCent = 0;
    data.orders.legacy.paymentStatus = paymentStatus;
    assert.equal((await api.list({ ...base, orderId: 'legacy' })).collectionStatus, 'unknown', '旧付款状态不能因实收字段为零就推定未收款');
    await assert.rejects(() => api.record({ ...base, orderId: 'legacy' }), { code: 'RECEIPT_HISTORY_UNVERIFIED' });
  }
  for (const receivedAt of ['2026-02-30T10:00:00Z', '2026-04-31T10:00:00+08:00', '2026-09-23T24:00:00Z']) {
    await assert.rejects(() => api.record({ ...base, receivedAt }), { code: 'RECEIPT_TIME_INVALID' });
  }
  assert.equal((await api.list(base)).collectionStatus, 'unpaid');
  await assert.rejects(() => api.record({ ...base, authorized: false }), { code: 'ADMIN_FORBIDDEN' });
  const results = await Promise.all([api.record(base), api.record(base)]);
  assert.equal(results.filter(row => row.idempotent).length, 1);
  assert.equal(data.orders.o.receivedAmountCent, 3000);
  assert.equal(data.orders.o.collectionStatus, 'partial');
  assert.equal(data.orders.o.status, 'delivered', 'Receipt must not change delivery status');
  await assert.rejects(() => api.record({ ...base, amountCent: 4000 }), { code: 'RECEIPT_RETRY_CONFLICT' });
  await assert.rejects(() => api.record({ ...base, idempotencyKey: 'over', amountCent: 7001 }), { code: 'RECEIPT_EXCEEDS_BALANCE' });
  await assert.rejects(() => api.record({ ...base, idempotencyKey: 'bad', amountCent: 0 }), { code: 'RECEIPT_AMOUNT_INVALID' });
  const paid = await api.record({ ...base, idempotencyKey: 'second', amountCent: 7000 });
  assert.equal(paid.collectionStatus, 'paid');
  assert.equal(paid.outstandingAmountCent, 0);
  assert.equal(data.orders.o.paymentStatus, 'offline_paid');
  assert.equal(Object.keys(data.order_receipts).length, 2);
  assert.equal(Object.keys(data.audit_logs).length, 2);
  const newOrder = id => ({ _id: id, orderNo: id, paymentMethod: 'offline', paymentStatus: 'offline_pending', status: 'pending_confirmation', totalAmountCent: 10000, receivedAmountCent: 0 });
  data.orders.race = newOrder('race');
  const race = await Promise.allSettled([
    api.record({ ...base, orderId: 'race', idempotencyKey: 'operator-one', amountCent: 6000 }),
    api.record({ ...base, orderId: 'race', idempotencyKey: 'operator-two', amountCent: 6000 })
  ]);
  assert.equal(race.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(race.find(item => item.status === 'rejected').reason.code, 'RECEIPT_EXCEEDS_BALANCE');
  assert.equal(data.orders.race.receivedAmountCent, 6000);
  data.orders.rollback = newOrder('rollback');
  for (const table of ['order_receipts', 'orders', 'audit_logs']) {
    const before = structuredClone(data); failWrite = table;
    await assert.rejects(() => api.record({ ...base, orderId: 'rollback', idempotencyKey: `fail-${table}` }), /injected-write-failure/);
    failWrite = '';
    assert.deepEqual(data, before, `${table} failure must roll back balance, receipt and audit`);
    const retry = await api.record({ ...base, orderId: 'rollback', idempotencyKey: `fail-${table}`, amountCent: 1000 });
    assert.equal(retry.idempotent, false);
  }
  for (const [field, value, code] of [
    ['status', 'cancelled', 'RECEIPT_ORDER_UNAVAILABLE'], ['status', 'closed', 'RECEIPT_ORDER_UNAVAILABLE'],
    ['refundStatus', 'processing', 'RECEIPT_ORDER_UNAVAILABLE'], ['activeRefundId', 'refund-pending', 'RECEIPT_ORDER_UNAVAILABLE'],
    ['paymentMethod', 'wechat', 'OFFLINE_ORDER_REQUIRED']
  ]) {
    data.orders.invalid = { ...newOrder('invalid'), [field]: value };
    if (field === 'activeRefundId') assert.match((await api.list({ ...base, orderId: 'invalid' })).registrationBlockedReason, /退款/, '登记界面应收到不能继续收款的具体原因');
    const before = structuredClone(data);
    await assert.rejects(() => api.record({ ...base, orderId: 'invalid' }), { code });
    assert.deepEqual(data, before);
  }
  for (const amountCent of [-1, 0.1, '100', Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(() => api.record({ ...base, amountCent }), { code: 'RECEIPT_AMOUNT_INVALID' });
  for (const receivedAt of ['2026-09-24T10:00:00Z', '2026-09-23T10:00:00', '2026-09-23T10:00:00+15:00']) await assert.rejects(() => api.record({ ...base, receivedAt }), { code: 'RECEIPT_TIME_INVALID' });
  await assert.rejects(() => api.record({ ...base, method: 'unknown' }), { code: 'RECEIPT_METHOD_INVALID' });
  await assert.rejects(() => api.record({ ...base, method: 'other', note: '' }), { code: 'RECEIPT_NOTE_REQUIRED' });
  console.log('Receipt boundary tests: serialized concurrent requests, all write rollback points, cancellation/refund guards and malformed input passed');
  console.log('Local receipt demonstration: 100.00 due -> 30.00 received/70.00 due -> 100.00 received/0.00 due; duplicate ignored');
})().catch(error => { console.error(error); process.exitCode = 1; });
