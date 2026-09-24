// Same-process actual business API; only persistence is an isolated in-memory adapter.
const assert = require('node:assert/strict');
module.exports = async function actualReceiptFlow({ send, evaluate, pause, socket }) {
  const { createReceiptFixture: createFixture } = require('./support/receipt-flow-fixture.cjs');
  const fixture = await createFixture();
  assert.equal(fixture.order.paymentStatus, 'offline_pending');
  assert.equal(fixture.order.totalAmountCent, 10000);
  const requests = [];
  const binding = 'localReceiptApi';
  const handler = async ({ data }) => {
    const event = JSON.parse(data);
    if (event.method !== 'Runtime.bindingCalled' || event.params.name !== binding) return;
    const input = JSON.parse(event.params.payload);
    let response;
    try {
      requests.push({ action: input.action, payload: input.payload });
      response = { id: input.id, data: await fixture.call(input.action, input.payload) };
    } catch (error) { response = { id: input.id, error: { code: error.code, message: error.message } }; }
    await send('Runtime.evaluate', { expression: `window.__resolveLocalReceipt(${JSON.stringify(response)})`, contextId: event.params.executionContextId });
  };
  socket.addEventListener('message', handler);
  await send('Runtime.enable');
  await send('Runtime.addBinding', { name: binding });
  const script = await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    (() => {
      const pending = new Map(); let sequence = 0;
      window.__resolveLocalReceipt = response => {
        const task = pending.get(response.id); if (!task) return;
        pending.delete(response.id);
        response.error ? task.reject(Object.assign(new Error(response.error.message), {code:response.error.code})) : task.resolve(response.data);
      };
      window.MengshixianAdminApi = {
        getToken: () => 'isolated-local-only', setToken: () => {}, config: {envId:'local-memory-only'},
        call: (action, payload = {}) => new Promise((resolve, reject) => {
          const id = ++sequence; pending.set(id, {resolve,reject});
          window.localReceiptApi(JSON.stringify({id,action,payload}));
        })
      };
    })();
  ` });
  const waitFor = async expression => {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await pause(40); }
    assert.fail(`Browser condition not met: ${expression}; requests=${requests.map(row => row.action).join(',')}; page=${await evaluate('document.body.innerText.slice(-1800)')}`);
  };
  try {
    await send('Page.navigate', { url: 'http://127.0.0.1:8765/orders.html' });
    await waitFor("Boolean(document.querySelector('[data-open-receipts]'))");
    assert.match(await evaluate("document.querySelector('#ordersTable').textContent"), /未收款/);
    await evaluate("document.querySelector('[data-open-receipts]').click()");
    await waitFor("Boolean(document.querySelector('[data-receipt-form]') && !document.querySelector('[data-receipt-form]').hidden && document.querySelector('[data-receipt-summary]').textContent.includes('100.00'))");
    const enter = async amount => {
      await evaluate(`(() => {
        const form = document.querySelector('[data-receipt-form]');
        form.elements.amountYuan.value = ${JSON.stringify(amount)};
        form.elements.receivedLocal.value = '2026-09-07T19:00';
        form.elements.method.value = 'bank_transfer'; form.elements.note.value = '仅本地实际API演示';
        window.confirm = message => {window.__receiptConfirmation = message; return true;};
        form.requestSubmit(); form.requestSubmit();
      })()`);
    };
    await enter('30.00');
    await waitFor("document.querySelector('[data-receipt-summary]').textContent.includes('70.00')");
    let history = await fixture.call('admin.orders.receipts.list', { orderId: fixture.order._id });
    assert.equal(history.receivedAmountCent, 3000);
    assert.equal(history.rows.length, 1);
    await enter('70.00');
    await waitFor("document.querySelector('[data-receipt-summary]').textContent.includes('已收齐')");
    history = await fixture.call('admin.orders.receipts.list', { orderId: fixture.order._id });
    assert.equal(history.receivedAmountCent, 10000);
    assert.equal(history.outstandingAmountCent, 0);
    assert.equal(history.rows.length, 2);
    assert.equal(history.orderStatus, 'pending_confirmation');
    const writes = requests.filter(row => row.action === 'admin.orders.receipts.record');
    assert.equal(writes.length, 2);
    const replay = await fixture.call(writes[0].action, writes[0].payload);
    assert.equal(replay.idempotent, true);
    assert.equal(replay.receivedAmountCent, 10000);
    const fs = require('node:fs'); const path = require('node:path');
    const folder = path.join(__dirname, '../outputs/receipt-browser'); fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'actual-api-paid.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    console.log('Same actual API order + browser: 100 due -> 30 received -> 70 received -> fully received; two receipts, replay safe, fulfillment unchanged');
  } finally {
    socket.removeEventListener('message', handler);
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: script.identifier });
    await send('Runtime.removeBinding', { name: binding });
  }
};
