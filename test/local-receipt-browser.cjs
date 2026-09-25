// Real Edge page + actual application dispatch, with isolated in-memory enterprise-order data.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.FRIEND_ADMIN_PLAYWRIGHT || 'playwright');
const { startLocalPreview } = require('../local-preview/server.cjs');
const { createReceiptFixture } = require('./support/receipt-flow-fixture.cjs');

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'friend-admin-receipt-'));
  const outputDir = process.env.FRIEND_ADMIN_VISUAL_OUTPUT_DIR || path.join(os.tmpdir(), 'friend-admin-receipt-review');
  let server, browser;
  try {
    const fixture = await createReceiptFixture();
    server = await startLocalPreview({ port: 0, dataDir });
    browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--disable-gpu'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const external = [], errors = [], writes = [];
    page.on('request', request => { if (!request.url().startsWith(server.url)) external.push(request.url()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${server.url}/login.html`);
    await page.getByRole('button', { name: '一键进入本机练习后台' }).click();
    await page.waitForURL(`${server.url}/index.html`);

    await page.route('**/__local/api', async route => {
      const event = route.request().postDataJSON();
      const payload = { ...event.payload };
      delete payload.adminToken; // Browser transport token belongs to the disposable practice page.
      if (event.action === 'admin.orders.receipts.record') writes.push(payload);
      try {
        const data = await fixture.call(event.action, payload);
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data }) });
      } catch (error) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: error.code || 'LOCAL_TEST_ERROR', message: error.message } }) });
      }
    });
    await page.goto(`${server.url}/orders.html`);
    await page.locator('[data-open-receipts]').waitFor();
    assert.match(await page.locator('#ordersTable').innerText(), /未收款/);
    await page.locator('[data-open-receipts]').click();
    await page.waitForFunction(() => document.querySelector('[data-receipt-summary]')?.textContent.includes('100.00'));
    assert.match(await page.locator('[data-receipt-summary]').innerText(), /待收 ¥100\.00/);

    async function record(amount, expectedOutstanding) {
      const form = page.locator('[data-receipt-form]');
      await form.locator('[name="amountYuan"]').fill(amount);
      await form.locator('[name="receivedLocal"]').fill('2026-09-23T19:00');
      await form.locator('[name="method"]').selectOption('bank_transfer');
      await form.locator('[name="note"]').fill('本机模拟到账，仅用于验收');
      page.once('dialog', dialog => { assert.match(dialog.message(), /确认|登记/); void dialog.accept(); });
      await form.locator('[data-receipt-action="record"]').click();
      await page.waitForFunction(value => document.querySelector('[data-receipt-summary]')?.textContent.includes(`待收 ¥${value}`), expectedOutstanding);
    }
    await record('30.00', '70.00');
    let history = await fixture.call('admin.orders.receipts.list', { orderId: fixture.order._id });
    assert.equal(history.collectionStatus, 'partial');
    assert.equal(history.receivedAmountCent, 3000);
    assert.equal(history.rows.length, 1);

    await record('70.00', '0.00');
    history = await fixture.call('admin.orders.receipts.list', { orderId: fixture.order._id });
    assert.equal(history.collectionStatus, 'paid');
    assert.equal(history.receivedAmountCent, 10000);
    assert.equal(history.rows.length, 2);
    assert.equal(history.orderStatus, 'pending_confirmation', '收齐不改变履约状态');
    assert.equal(writes.length, 2, '页面只发出两次收款登记');
    const replay = await fixture.call('admin.orders.receipts.record', writes[0]);
    assert.equal(replay.idempotent, true);
    assert.equal(replay.receivedAmountCent, 10000);
    await fs.mkdir(outputDir, { recursive: true });
    await page.screenshot({ path: path.join(outputDir, 'receipt-partial-then-paid.png'), fullPage: true });
    assert.deepEqual(external, [], '所有页面请求仅在本机');
    assert.deepEqual(errors, [], '页面没有脚本异常');
    console.log(`Local Edge receipt: 100 due -> 30 received -> 100 received, duplicate ignored, fulfillment unchanged; screenshot: ${outputDir}`);
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
