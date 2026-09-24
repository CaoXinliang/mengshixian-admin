const assert = require('node:assert/strict');
const { createReceiptFixture } = require('./support/receipt-flow-fixture.cjs');

async function run() {
  const { app, call, adminToken, order } = await createReceiptFixture();
  assert.equal(typeof app.dispatch, 'function');
  assert.ok(adminToken);
  assert.equal(order.totalAmountCent, 10000);
  assert.equal(order.paymentStatus, 'offline_pending');

  const firstInput = {
    orderId: order._id,
    amountCent: 3000,
    receivedAt: '2026-09-23T11:00:00+08:00',
    method: 'bank_transfer',
    note: '仅本地同单测试，非真实收款',
    idempotencyKey: 'local-receipt-30'
  };
  const first = await call('admin.orders.receipts.record', firstInput);
  assert.equal(first.collectionStatus, 'partial');
  assert.equal(first.receivedAmountCent, 3000);
  assert.equal(first.outstandingAmountCent, 7000);
  assert.equal(first.receipt.amountCent, 3000);

  const second = await call('admin.orders.receipts.record', {
    ...firstInput,
    amountCent: 7000,
    receivedAt: '2026-09-23T11:05:00+08:00',
    idempotencyKey: 'local-receipt-70'
  });
  assert.equal(second.collectionStatus, 'paid');
  assert.equal(second.receivedAmountCent, 10000);
  assert.equal(second.outstandingAmountCent, 0);

  const retry = await call('admin.orders.receipts.record', firstInput);
  assert.equal(retry.idempotent, true);
  const history = await call('admin.orders.receipts.list', { orderId: order._id });
  assert.equal(history.rows.length, 2);
  assert.deepEqual(history.rows.map((row) => row.amountCent).sort((a, b) => a - b), [3000, 7000]);
  assert.equal(history.collectionStatus, 'paid');
  assert.equal(history.receivedAmountCent, 10000);
  assert.equal(history.outstandingAmountCent, 0);
  assert.equal(history.orderStatus, 'pending_confirmation');

  await assert.rejects(
    call('admin.orders.receipts.list', { orderId: order._id, adminToken: 'invalid' }),
    (error) => typeof error.code === 'string' && error.code.length > 0
  );
  console.log('receipt flow fixture: passed');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
