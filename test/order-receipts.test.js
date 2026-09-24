const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'admin-order-receipts.js'), 'utf8');
const money = require('../admin-money.js');
const { cleanAdmin } = require('../backend/cloudbase/functions/api/lib/api-values');

function setup({ permissions = ['orders.read', 'receipts.read', 'receipts.write'], responses = [], saveError = null, storage = new Map(), adminId = 'local-admin' } = {}) {
  const listeners = new Map();
  const calls = [];
  const fields = new Map();
  const field = (name) => {
    if (!fields.has(name)) fields.set(name, { value: '', textContent: '', hidden: false, disabled: false, children: [], replaceChildren(...children) { this.children = children; }, reset() { for (const [selector, item] of fields) if (selector.startsWith('[name=')) item.value = ''; } });
    return fields.get(name);
  };
  const dialog = {
    open: false, innerHTML: '', className: '',
    showModal() { this.open = true; }, close() { this.open = false; },
    querySelector(selector) { return field(selector); }
  };
  const document = {
    body: { appendChild() {} },
    createElement(tag) { return tag === 'dialog' ? dialog : { tagName: tag, textContent: '', className: '', children: [], appendChild(child) { this.children.push(child); } }; },
    addEventListener(type, listener) { const group = listeners.get(type) || []; group.push(listener); listeners.set(type, group); },
    async fire(type, target, extra = {}) {
      const event = { target, preventDefault() { this.defaultPrevented = true; }, ...extra };
      await Promise.all((listeners.get(type) || []).map((listener) => listener(event)));
      return event;
    }
  };
  const windowListeners = new Map();
  const window = { PAGE_NAME: 'orders', MengshixianAdminMoney: money, confirm: () => true,
    sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    addEventListener(type, listener) { windowListeners.set(type, listener); },
    fire(type) { const event = { prevented: false, preventDefault() { this.prevented = true; }, returnValue: undefined }; windowListeners.get(type)?.(event); return event; }
  };
  vm.runInNewContext(source, { window, document, Date, Intl, crypto: require('node:crypto').webcrypto });
  const call = async (action, payload) => {
    calls.push({ action, payload });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  };
  let saved = 0;
  window.MengshixianAdminOrderReceipts.mount({ call, getAdmin: () => cleanAdmin({ _id: adminId }, permissions), onSaved: () => { saved += 1; if (saveError) throw saveError; } });
  const target = (selector, dataset = {}) => ({ dataset, closest(query) { return query === selector ? this : null; } });
  return { window, document, dialog, field, calls, target, enqueue: (...items) => responses.push(...items), saved: () => saved };
}

async function main() {
  const reloadStorage = new Map();
  const reloadSummary = { orderNo: 'RELOAD', totalAmountCent: 5000, receivedAmountCent: 0, outstandingAmountCent: 5000, collectionStatus: 'unpaid', orderStatus: 'picking', rows: [] };
  const interrupted = setup({ storage: reloadStorage, responses: [reloadSummary, new Error('response interrupted')] });
  await interrupted.document.fire('click', interrupted.target('[data-open-receipts]', { openReceipts: 'reload-order' }));
  interrupted.field('[name="amountYuan"]').value = '10.00';
  interrupted.field('[name="receivedLocal"]').value = '2026-09-07T19:00';
  interrupted.field('[name="method"]').value = 'cash';
  await interrupted.document.fire('submit', interrupted.target('[data-receipt-form]'));
  assert.equal(interrupted.calls[1]?.action, 'admin.orders.receipts.record', '采用实际管理员返回格式仍须可以登记');
  const afterReload = setup({ storage: reloadStorage, responses: [reloadSummary, { receipt: { _id: 'restored-receipt' } }, reloadSummary] });
  await afterReload.document.fire('click', afterReload.target('[data-open-receipts]', { openReceipts: 'another-order' }));
  assert.match(afterReload.field('[data-receipt-state]').textContent, /先处理.*原订单/, '刷新后点击其他订单须明确告知正在恢复原登记');
  assert.equal(afterReload.field('[data-receipt-form]').hidden, true, '刷新后不能另建一笔');
  await afterReload.document.fire('click', afterReload.target('[data-receipt-action="retry"]'));
  assert.deepEqual(JSON.parse(JSON.stringify(afterReload.calls[1].payload)), JSON.parse(JSON.stringify(interrupted.calls[1].payload)), '刷新后重试保持原凭据');
  assert.equal(reloadStorage.size, 0, '确认成功后清除待核对登记');
  const ui = setup({ responses: [{ orderNo: 'O-001', totalAmountCent: 10000, receivedAmountCent: 3000, outstandingAmountCent: 7000, collectionStatus: 'partial', orderStatus: 'delivered', rows: [] }] });
  await ui.document.fire('click', ui.target('[data-open-receipts]', { openReceipts: 'order-1' }));
  assert.equal(ui.dialog.open, true, '点击线下订单应打开收款面板');
  assert.deepEqual(ui.calls.map((item) => item.action), ['admin.orders.receipts.list']);
  assert.equal(ui.calls[0].payload.orderId, 'order-1');
  assert.match(ui.dialog.innerHTML, /实际到账/);
  assert.match(ui.field('[data-receipt-summary]').textContent, /70\.00/);

  const denied = setup({ permissions: ['orders.read'] });
  await denied.document.fire('click', denied.target('[data-open-receipts]', { openReceipts: 'order-2' }));
  assert.equal(denied.calls.length, 0, '无收款读取权限不得请求流水');
  assert.match(denied.field('[data-receipt-state]').textContent, /无权|权限/);

  const history = setup({ responses: [{ orderNo: '旧单', totalAmountCent: 10000, receivedAmountCent: null, outstandingAmountCent: null, collectionStatus: 'unknown', orderStatus: 'delivered', registrationBlockedReason: '历史收款待核实', rows: [] }] });
  await history.document.fire('click', history.target('[data-open-receipts]', { openReceipts: 'legacy' }));
  assert.match(history.field('[data-receipt-summary]').textContent, /历史收款待核实/);
  assert.doesNotMatch(history.field('[data-receipt-summary]').textContent, /已收 ¥0\.00/);
  assert.equal(history.field('[data-receipt-form]').hidden, true);

  ui.field('[name="amountYuan"]').value = '30.00';
  ui.field('[name="receivedLocal"]').value = '2026-09-22T19:30';
  ui.field('[name="method"]').value = 'bank_transfer';
  ui.field('[name="note"]').value = '已核对银行到账';
  let prompts = 0;
  ui.window.confirm = () => { prompts += 1; return false; };
  const cancelled = await ui.document.fire('submit', ui.target('[data-receipt-form]'));
  assert.equal(prompts, 1, '登记前必须明确核对');
  assert.equal(cancelled.defaultPrevented, true);
  assert.deepEqual(ui.calls.map((item) => item.action), ['admin.orders.receipts.list'], '取消核对不得登记');

  ui.enqueue(
    { receipt: { _id: 'receipt-1' }, collectionStatus: 'partial', receivedAmountCent: 6000, outstandingAmountCent: 4000, idempotent: false },
    { orderNo: 'O-001', totalAmountCent: 10000, receivedAmountCent: 6000, outstandingAmountCent: 4000, collectionStatus: 'partial', orderStatus: 'delivered', rows: [{ _id: 'receipt-1', amountCent: 3000, receivedAt: '2026-09-22T11:30:00Z', method: 'bank_transfer', note: '已核对银行到账', operatorName: '运营甲' }] }
  );
  ui.window.confirm = () => true;
  await ui.document.fire('submit', ui.target('[data-receipt-form]'));
  assert.deepEqual(ui.calls.map((item) => item.action), ['admin.orders.receipts.list', 'admin.orders.receipts.record', 'admin.orders.receipts.list']);
  assert.equal(ui.calls[1].payload.amountCent, 3000);
  assert.equal(ui.calls[1].payload.receivedAt, '2026-09-22T19:30:00+08:00');
  assert.equal(ui.calls[1].payload.orderId, 'order-1');
  assert.ok(ui.calls[1].payload.idempotencyKey);
  assert.equal(ui.saved(), 1);
  assert.match(ui.field('[data-receipt-summary]').textContent, /待收 ¥40\.00/);
  assert.match(ui.field('[data-receipt-summary]').textContent, /部分收款/);
  assert.match(ui.field('[data-receipt-summary]').textContent, /已送达/);
  assert.match(ui.field('[data-receipt-history]').children[1].children[0].textContent, /运营甲/);
  assert.equal(ui.field('[name="amountYuan"]').value, '', '登记成功后不能保留旧金额');
  assert.equal(ui.field('[name="receivedLocal"]').value, '', '登记成功后不能保留旧到账时间');

  const uncertain = setup({ responses: [
    { orderNo: 'O-002', totalAmountCent: 5000, receivedAmountCent: 0, outstandingAmountCent: 5000, collectionStatus: 'unpaid', orderStatus: 'pending_confirmation', rows: [] },
    new Error('网络超时'),
    { orderNo: 'O-002', totalAmountCent: 5000, receivedAmountCent: 0, outstandingAmountCent: 5000, collectionStatus: 'unpaid', orderStatus: 'pending_confirmation', rows: [] },
    { receipt: { _id: 'receipt-2' }, collectionStatus: 'partial', receivedAmountCent: 2000, outstandingAmountCent: 3000, idempotent: true },
    { orderNo: 'O-002', totalAmountCent: 5000, receivedAmountCent: 2000, outstandingAmountCent: 3000, collectionStatus: 'partial', orderStatus: 'pending_confirmation', rows: [{ _id: 'receipt-2', amountCent: 2000, receivedAt: '2026-09-22T11:30:00Z', method: 'cash', note: '', operatorName: '运营甲' }] }
  ] });
  await uncertain.document.fire('click', uncertain.target('[data-open-receipts]', { openReceipts: 'order-2' }));
  uncertain.field('[name="amountYuan"]').value = '20.00';
  uncertain.field('[name="receivedLocal"]').value = '2026-09-22T19:30';
  uncertain.field('[name="method"]').value = 'cash';
  await uncertain.document.fire('submit', uncertain.target('[data-receipt-form]'));
  assert.equal(uncertain.field('[data-receipt-pending]').hidden, false);
  assert.equal(uncertain.field('[data-receipt-form]').hidden, true);
  assert.equal(uncertain.window.fire('beforeunload').prevented, true, '未决登记离页前须提醒');
  const firstPayload = uncertain.calls[1].payload;
  uncertain.field('[name="amountYuan"]').value = '30.00';
  await uncertain.document.fire('submit', uncertain.target('[data-receipt-form]'));
  assert.equal(uncertain.calls.length, 2, '结果不明时不能更改金额再发新登记');
  await uncertain.document.fire('click', uncertain.target('[data-receipt-action="reload"]'));
  assert.equal(uncertain.field('[data-receipt-pending]').hidden, false, '读取仍不能消除不明确结果');
  await uncertain.document.fire('click', uncertain.target('[data-receipt-action="retry"]'));
  assert.equal(uncertain.calls[3].action, 'admin.orders.receipts.record');
  assert.equal(uncertain.calls[3].payload, firstPayload, '重试必须使用原对象和原凭据');
  assert.equal(uncertain.saved(), 1);
  assert.equal(uncertain.field('[data-receipt-pending]').hidden, true);
  assert.equal(uncertain.window.fire('beforeunload').prevented, false, '确认成功后不再拦截离页');

  const readOnly = setup({ permissions: ['orders.read', 'receipts.read'], responses: [{ orderNo: '只读单', totalAmountCent: 2000, receivedAmountCent: 0, outstandingAmountCent: 2000, collectionStatus: 'unpaid', orderStatus: 'delivered', rows: [] }] });
  await readOnly.document.fire('click', readOnly.target('[data-open-receipts]', { openReceipts: 'read-only' }));
  assert.equal(readOnly.calls.length, 1);
  assert.equal(readOnly.field('[data-receipt-form]').hidden, true, '只读权限可看记录但不能登记');

  const blocked = setup({ responses: [{ orderNo: '退款单', totalAmountCent: 2000, receivedAmountCent: 0, outstandingAmountCent: 2000, collectionStatus: 'unpaid', orderStatus: 'delivered', registrationBlockedReason: '订单涉及退款，请先核实', rows: [] }] });
  await blocked.document.fire('click', blocked.target('[data-open-receipts]', { openReceipts: 'refund-order' }));
  assert.equal(blocked.field('[data-receipt-form]').hidden, true);
  assert.match(blocked.field('[data-receipt-state]').textContent, /涉及退款/);

  const failed = setup({ responses: [new Error('服务不可用')] });
  await failed.document.fire('click', failed.target('[data-open-receipts]', { openReceipts: 'failed-order' }));
  assert.equal(failed.field('[data-receipt-form]').hidden, true);
  assert.equal(failed.field('[data-receipt-summary]').textContent, '');
  assert.match(failed.field('[data-receipt-state]').textContent, /读取失败/);

  const invalidTime = setup({ responses: [{ orderNo: 'O-003', totalAmountCent: 3000, receivedAmountCent: 0, outstandingAmountCent: 3000, collectionStatus: 'unpaid', orderStatus: 'picking', rows: [] }] });
  await invalidTime.document.fire('click', invalidTime.target('[data-open-receipts]', { openReceipts: 'order-3' }));
  invalidTime.field('[name="amountYuan"]').value = '10.00';
  invalidTime.field('[name="receivedLocal"]').value = '2026-02-30T10:00';
  invalidTime.field('[name="method"]').value = 'cash';
  await invalidTime.document.fire('submit', invalidTime.target('[data-receipt-form]'));
  assert.equal(invalidTime.calls.length, 1, '非法日期不能调用登记接口');
  assert.match(invalidTime.field('[data-receipt-error]').textContent, /有效的北京时间/);

  const refreshFails = setup({ responses: [
    { orderNo: 'O-004', totalAmountCent: 1000, receivedAmountCent: 0, outstandingAmountCent: 1000, collectionStatus: 'unpaid', orderStatus: 'delivered', rows: [] },
    { receipt: { _id: 'receipt-4' }, collectionStatus: 'paid', receivedAmountCent: 1000, outstandingAmountCent: 0, idempotent: false },
    new Error('读取超时')
  ] });
  await refreshFails.document.fire('click', refreshFails.target('[data-open-receipts]', { openReceipts: 'order-4' }));
  refreshFails.field('[name="amountYuan"]').value = '10.00';
  refreshFails.field('[name="receivedLocal"]').value = '2026-09-22T19:30';
  refreshFails.field('[name="method"]').value = 'cash';
  await refreshFails.document.fire('submit', refreshFails.target('[data-receipt-form]'));
  assert.equal(refreshFails.field('[data-receipt-pending]').hidden, true, '登记成功后不得因刷新失败保留未决凭据');
  assert.equal(refreshFails.saved(), 1, '登记成功应刷新订单列表');
  assert.match(refreshFails.field('[data-receipt-state]').textContent, /登记已成功/);
  assert.match(refreshFails.field('[data-receipt-state]').textContent, /刷新失败|读取失败/);

  const orderRefreshFails = setup({ saveError: new Error('订单读取失败'), responses: [
    { orderNo: 'O-006', totalAmountCent: 1000, receivedAmountCent: 0, outstandingAmountCent: 1000, collectionStatus: 'unpaid', orderStatus: 'delivered', rows: [] },
    { receipt: { _id: 'receipt-6' }, collectionStatus: 'paid', receivedAmountCent: 1000, outstandingAmountCent: 0 },
    { orderNo: 'O-006', totalAmountCent: 1000, receivedAmountCent: 1000, outstandingAmountCent: 0, collectionStatus: 'paid', orderStatus: 'delivered', rows: [] }
  ] });
  await orderRefreshFails.document.fire('click', orderRefreshFails.target('[data-open-receipts]', { openReceipts: 'order-6' }));
  orderRefreshFails.field('[name="amountYuan"]').value = '10.00';
  orderRefreshFails.field('[name="receivedLocal"]').value = '2026-09-22T19:30';
  orderRefreshFails.field('[name="method"]').value = 'cash';
  await orderRefreshFails.document.fire('submit', orderRefreshFails.target('[data-receipt-form]'));
  assert.match(orderRefreshFails.field('[data-receipt-state]').textContent, /登记已成功/);
  assert.match(orderRefreshFails.field('[data-receipt-state]').textContent, /订单列表刷新失败/);
  assert.equal(orderRefreshFails.field('[data-receipt-pending]').hidden, true);

  const malformedAck = setup({ responses: [
    { orderNo: 'O-007', totalAmountCent: 1000, receivedAmountCent: 0, outstandingAmountCent: 1000, collectionStatus: 'unpaid', orderStatus: 'picking', rows: [] },
    undefined
  ] });
  await malformedAck.document.fire('click', malformedAck.target('[data-open-receipts]', { openReceipts: 'order-7' }));
  malformedAck.field('[name="amountYuan"]').value = '10.00';
  malformedAck.field('[name="receivedLocal"]').value = '2026-09-22T19:30';
  malformedAck.field('[name="method"]').value = 'cash';
  await malformedAck.document.fire('submit', malformedAck.target('[data-receipt-form]'));
  assert.equal(malformedAck.field('[data-receipt-pending]').hidden, false, '响应缺收款凭据不能宣布成功');

  let resolveA;
  let resolveB;
  const race = setup({ responses: [new Promise((resolve) => { resolveA = resolve; }), new Promise((resolve) => { resolveB = resolve; })] });
  const openA = race.document.fire('click', race.target('[data-open-receipts]', { openReceipts: 'A' }));
  const openB = race.document.fire('click', race.target('[data-open-receipts]', { openReceipts: 'B' }));
  resolveB({ orderNo: 'B单', totalAmountCent: 5000, receivedAmountCent: 0, outstandingAmountCent: 5000, collectionStatus: 'unpaid', orderStatus: 'picking', rows: [] });
  await openB;
  resolveA({ orderNo: 'A单', totalAmountCent: 1000, receivedAmountCent: 0, outstandingAmountCent: 1000, collectionStatus: 'unpaid', orderStatus: 'picking', rows: [] });
  await openA;
  assert.match(race.field('[data-receipt-summary]').textContent, /B单/);
  assert.doesNotMatch(race.field('[data-receipt-summary]').textContent, /A单/);
  race.enqueue(
    { receipt: { _id: 'receipt-B' }, collectionStatus: 'partial', receivedAmountCent: 3000, outstandingAmountCent: 2000 },
    { orderNo: 'B单', totalAmountCent: 5000, receivedAmountCent: 3000, outstandingAmountCent: 2000, collectionStatus: 'partial', orderStatus: 'picking', rows: [] }
  );
  race.field('[name="amountYuan"]').value = '30.00';
  race.field('[name="receivedLocal"]').value = '2026-09-22T19:30';
  race.field('[name="method"]').value = 'cash';
  await race.document.fire('submit', race.target('[data-receipt-form]'));
  assert.equal(race.calls[2].payload.orderId, 'B', '迟到的A余额不能用于B的登记');

  let resolveWrite;
  const twoClicks = setup({ responses: [
    { orderNo: 'O-005', totalAmountCent: 2000, receivedAmountCent: 0, outstandingAmountCent: 2000, collectionStatus: 'unpaid', orderStatus: 'picking', rows: [] },
    new Promise((resolve) => { resolveWrite = resolve; }),
    { orderNo: 'O-005', totalAmountCent: 2000, receivedAmountCent: 1000, outstandingAmountCent: 1000, collectionStatus: 'partial', orderStatus: 'picking', rows: [] }
  ] });
  await twoClicks.document.fire('click', twoClicks.target('[data-open-receipts]', { openReceipts: 'order-5' }));
  twoClicks.field('[name="amountYuan"]').value = '10.00';
  twoClicks.field('[name="receivedLocal"]').value = '2026-09-22T19:30';
  twoClicks.field('[name="method"]').value = 'cash';
  const firstClick = twoClicks.document.fire('submit', twoClicks.target('[data-receipt-form]'));
  await twoClicks.document.fire('submit', twoClicks.target('[data-receipt-form]'));
  assert.equal(twoClicks.calls.filter((item) => item.action === 'admin.orders.receipts.record').length, 1, '连续提交只能发送一笔');
  resolveWrite({ receipt: { _id: 'receipt-5' }, collectionStatus: 'partial', receivedAmountCent: 1000, outstandingAmountCent: 1000 });
  await firstClick;
  console.log('receipt UI permissions, confirmation, retry, races and refresh outcomes: passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
