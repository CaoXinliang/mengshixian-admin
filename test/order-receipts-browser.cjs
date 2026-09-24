// Browser interaction coverage only: all requests here use explicit local mock responses.
const assert = require('node:assert/strict');
module.exports = async function receiptBrowserChecks({ send, evaluate, pause }) {
  await send('Page.navigate', { url: 'http://127.0.0.1:8765/orders.html' });
  for (let i = 0; i < 80; i++) {
    if (await evaluate("Boolean(window.MengshixianAdminOrderReceipts && document.querySelector('.admin-receipt-dialog'))")) break;
    await pause(50);
  }
  assert.equal(await evaluate("Boolean(document.querySelector('.admin-receipt-dialog'))"), true, '订单页须实际挂载收款面板');
  await evaluate(`(() => {
    window.__receiptWrites = [];
    const original = window.MengshixianAdminApi.call;
    let received = 0;
    const rows = [];
    window.MengshixianAdminApi.call = async (action, payload) => {
      if (action === 'admin.orders.receipts.list') return { orderId: 'browser-order', orderNo: '本地收款测试', totalAmountCent: 10000, receivedAmountCent: received, outstandingAmountCent: 10000 - received, collectionStatus: received ? 'partial' : 'unpaid', orderStatus: 'pending_confirmation', rows, registrationBlockedReason: '' };
      if (action === 'admin.orders.receipts.record') {
        window.__receiptWrites.push(payload);
        if (window.__receiptFailOnce) { window.__receiptFailOnce = false; throw new Error('本地模拟响应中断'); }
        received += payload.amountCent;
        const receipt = { ...payload, _id: 'local-receipt', operatorName: '本地测试人员' };
        rows.push(receipt);
        return { receipt, receivedAmountCent: received, outstandingAmountCent: 10000 - received, collectionStatus: 'partial', idempotent: false };
      }
      return original(action, payload);
    };
    const button = document.createElement('button');
    button.dataset.openReceipts = 'browser-order';
    document.body.appendChild(button); button.click();
  })()`);
  for (let i = 0; i < 80; i++) {
    if (await evaluate("document.querySelector('[data-receipt-summary]').textContent.includes('100.00')")) break;
    await pause(25);
  }
  await evaluate(`(() => {
    const form = document.querySelector('[data-receipt-form]');
    form.elements.amountYuan.value = '30.00';
    form.elements.receivedLocal.value = '2026-09-07T19:00';
    form.elements.note.value = '仅本地浏览器测试';
    window.confirm = () => false;
    form.requestSubmit();
  })()`);
  await pause(50);
  assert.equal(await evaluate('window.__receiptWrites.length'), 0, '取消核对不能提交');
  await evaluate("window.confirm = () => true; document.querySelector('[data-receipt-form]').requestSubmit(); document.querySelector('[data-receipt-form]').requestSubmit()");
  for (let i = 0; i < 80; i++) {
    if (await evaluate("document.querySelector('[data-receipt-summary]').textContent.includes('70.00')")) break;
    await pause(25);
  }
  assert.equal(await evaluate('window.__receiptWrites.length'), 1, '重复点击不能发出两笔登记');
  assert.equal(await evaluate('window.__receiptWrites[0].amountCent'), 3000);
  assert.match(await evaluate("document.querySelector('[data-receipt-summary]').textContent"), /70\.00/);
  await evaluate(`(() => {
    const form = document.querySelector('[data-receipt-form]');
    form.elements.amountYuan.value = '20.00';
    form.elements.receivedLocal.value = '2026-09-07T19:00';
    window.__receiptFailOnce = true;
    form.requestSubmit();
  })()`);
  for (let i = 0; i < 80; i++) {
    if (await evaluate("!document.querySelector('[data-receipt-pending]').hidden")) break;
    await pause(25);
  }
  assert.equal(await evaluate("document.querySelector('[data-receipt-form]').hidden"), true, '请求结果不明不能改金额另记');
  await evaluate("document.querySelector('[data-receipt-action=retry]').click()");
  for (let i = 0; i < 80; i++) {
    if (await evaluate('window.__receiptWrites.length === 3')) break;
    await pause(25);
  }
  assert.deepEqual(await evaluate('window.__receiptWrites[1]'), await evaluate('window.__receiptWrites[2]'), '重试必须保持原金额、时间和同一凭据');
  for (let i = 0; i < 80; i++) {
    if (await evaluate("document.querySelector('[data-receipt-summary]').textContent.includes('50.00')")) break;
    await pause(25);
  }
  assert.match(await evaluate("document.querySelector('[data-receipt-summary]').textContent"), /50\.00/);
  const fs = require('node:fs');
  const path = require('node:path');
  const evidence = path.join(__dirname, '../outputs/receipt-browser');
  fs.mkdirSync(evidence, { recursive: true });
  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(evidence, 'partial-receipts.png'), Buffer.from(screenshot.data, 'base64'));
  await evaluate(`(() => {
    const form = document.querySelector('[data-receipt-form]');
    form.elements.amountYuan.value = '10.00';
    form.elements.receivedLocal.value = '2026-09-07T19:00';
    window.__receiptFailOnce = true; form.requestSubmit();
  })()`);
  for (let i = 0; i < 80; i++) {
    if (await evaluate("!document.querySelector('[data-receipt-pending]').hidden")) break;
    await pause(25);
  }
  const beforeReload = await evaluate('window.__receiptWrites.at(-1)');
  assert.equal(beforeReload.amountCent, 1000);
  const reloadMarker = `receipt-page-before-reload-${Date.now()}`;
  await evaluate(`window.__receiptReloadMarker = ${JSON.stringify(reloadMarker)}`);
  const pendingKey = 'friend-receipt-pending:mock-local-admin';
  assert.deepEqual(
    JSON.parse(await evaluate(`sessionStorage.getItem(${JSON.stringify(pendingKey)})`)),
    beforeReload,
    '刷新前必须已保存同一待核对登记凭据'
  );
  await send('Page.reload');
  let newPageReady = false;
  let reloadError = '';
  for (let i = 0; i < 120; i++) {
    try {
      newPageReady = await evaluate(`document.readyState === 'complete'
        && location.pathname.endsWith('/orders.html')
        && window.__receiptReloadMarker !== ${JSON.stringify(reloadMarker)}
        && Boolean(window.MengshixianAdminOrderReceipts && document.querySelector('.admin-receipt-dialog'))
        && Boolean(document.querySelector('#adminUser')?.textContent.includes('本地测试'))`);
      if (newPageReady) break;
    } catch (error) { reloadError = error.message; } // Reload may destroy the old execution context.
    await pause(50);
  }
  assert.equal(newPageReady, true, `刷新后新文档和管理员身份未就绪：${reloadError || '等待超时'}`);
  assert.deepEqual(
    JSON.parse(await evaluate(`sessionStorage.getItem(${JSON.stringify(pendingKey)})`)),
    beforeReload,
    '新文档必须保留原始金额、时间和幂等凭据'
  );
  await evaluate(`(() => {
    const original = window.MengshixianAdminApi.call;
    window.MengshixianAdminApi.call = async (action, payload) => {
      if (action === 'admin.orders.receipts.list') return { orderNo: '刷新恢复测试', totalAmountCent: 10000, receivedAmountCent: 5000, outstandingAmountCent: 5000, collectionStatus: 'partial', orderStatus: 'pending_confirmation', rows: [] };
      if (action === 'admin.orders.receipts.record') { window.__restoredReceipt = payload; return { receipt: { _id: 'restored-local' } }; }
      return original(action, payload);
    };
    const button = document.createElement('button'); button.dataset.openReceipts = 'browser-order';
    document.body.appendChild(button); button.click();
  })()`);
  let restoredPending = false;
  for (let i = 0; i < 80; i++) {
    restoredPending = await evaluate("Boolean(document.querySelector('.admin-receipt-dialog')?.open && !document.querySelector('[data-receipt-pending]')?.hidden)");
    if (restoredPending) break;
    await pause(25);
  }
  assert.equal(restoredPending, true, `刷新后未恢复待核对面板：${await evaluate("document.querySelector('[data-receipt-state]')?.textContent || document.querySelector('[data-receipt-error]')?.textContent || '无状态信息'")}`);
  assert.equal(await evaluate("document.querySelector('[data-receipt-form]').hidden"), true, '真实刷新后不得另起一笔');
  await evaluate("document.querySelector('[data-receipt-action=retry]').click()");
  for (let i = 0; i < 80; i++) {
    if (await evaluate('Boolean(window.__restoredReceipt)')) break;
    await pause(25);
  }
  assert.deepEqual(await evaluate('window.__restoredReceipt'), beforeReload, '真实浏览器刷新后仍提交同一原始凭据');
};
