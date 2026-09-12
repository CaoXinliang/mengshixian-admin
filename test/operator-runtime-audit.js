const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const username = process.env.MENGSHIXIAN_TEST_ADMIN_USERNAME;
const password = process.env.MENGSHIXIAN_TEST_ADMIN_PASSWORD;
assert.ok(username && password, '测试管理员凭据未注入进程环境');

const baseUrl = 'https://cloud1-d8gp843lt5454ada7-1483924869.tcloudbaseapp.com/admin-test/';
const evidenceDir = path.resolve(__dirname, '..', '..', 'docs', 'evidence', 'admin-operator-audit-2026-09-11');
fs.mkdirSync(evidenceDir, { recursive: true });

const result = {
  checkedAt: new Date().toISOString(),
  target: `${baseUrl}simple.html`,
  authenticated: false,
  dailyViews: [],
  dialogChecks: [],
  productEditor: { opened: false, checks: [] },
  forbiddenVisibleTerms: [],
  consoleErrors: [],
  applicationConsoleErrors: [],
  failedResponses: [],
  applicationFailedResponses: [],
  screenshots: [],
  interstitialHandled: false
};

async function screenshot(page, name) {
  const file = path.join(evidenceDir, name);
  await page.screenshot({ path: file, fullPage: true });
  result.screenshots.push(name);
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  const page = await context.newPage();

  page.on('console', (message) => {
    if (message.type() === 'error') result.consoleErrors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400) result.failedResponses.push({ status: response.status(), url: response.url() });
  });

  try {
    const navigationUrl = `${baseUrl}simple.html?v=20260911v&audit=${Date.now()}`;
    const navigation = await page.goto(navigationUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    result.navigationStatus = navigation && navigation.status();
    result.currentUrl = page.url();
    if (result.navigationStatus === 404 && await page.locator('#submitBtn').count()) {
      result.interstitialHandled = true;
      await page.locator('#submitBtn').click();
      await page.waitForLoadState('domcontentloaded');
    } else {
      assert.equal(result.navigationStatus, 200, `运营后台入口返回 HTTP ${result.navigationStatus}`);
    }
    if (page.url().includes('index.html')) {
      await page.locator('#loginForm input[name="username"]').fill(username);
      await page.locator('#loginForm input[name="password"]').fill(password);
      await Promise.all([
        page.waitForURL(/simple\.html/, { timeout: 30000 }),
        page.locator('#loginForm button[type="submit"]').click()
      ]);
    }

    await page.locator('#appView').waitFor({ state: 'visible', timeout: 30000 });
    await page.locator('#statGrid .stat-card').first().waitFor({ state: 'visible', timeout: 30000 });
    result.authenticated = true;

    const bodyText = await page.locator('body').innerText();
    for (const term of ['简单后台', '完整版', '仅B端', '仅C端']) {
      if (bodyText.includes(term)) result.forbiddenVisibleTerms.push(term);
    }
    assert.deepEqual(result.forbiddenVisibleTerms, [], '运营页面仍显示技术模式或 B/C 缩写');
    await page.getByText('梦食鲜商家后台', { exact: true }).waitFor({ state: 'visible' });
    const menuLabels = await page.locator('#tabs button strong').allTextContents();
    assert.deepEqual(menuLabels, ['今日待办', '订单处理', '商品管理', '库存管理', '退款售后', '客户管理', '配送设置', '营销活动', '系统设置']);
    await screenshot(page, '01-today-dashboard.png');

    const views = [
      ['orders', '#orderList', '02-orders.png'],
      ['products', '#productList', '03-product-list.png'],
      ['inventory', '#inventoryList', '04-inventory.png'],
      ['refunds', '#refundList', '05-refunds.png'],
      ['customers', '#customerList', '06-customer-review.png'],
      ['delivery', '#deliverySummary', '07-delivery.png'],
      ['marketing', '#campaignList', '08-marketing.png'],
      ['settings', '#simplePasswordForm', '09-settings.png']
    ];
    for (const [view, selector, imageName] of views) {
      await page.locator(`#tabs button[data-view="${view}"]`).click();
      await page.locator(`section.view[data-view="${view}"].is-active`).waitFor({ state: 'visible' });
      await page.locator(selector).waitFor({ state: 'visible' });
      result.dailyViews.push(view);
      await screenshot(page, imageName);
    }

    await page.locator('#tabs button[data-view="delivery"]').click();
    await page.locator('#newDeliverySlotBtn').click();
    await page.locator('#slotSave').waitFor({ state: 'visible' });
    result.dialogChecks.push('新增配送时段');
    await page.locator('#overlay [data-close]').click();
    await page.locator('#tabs button[data-view="marketing"]').click();
    await page.locator('#newCampaignBtn').click();
    await page.locator('[data-campaign-save="active"]').waitFor({ state: 'visible' });
    result.dialogChecks.push('新建拼团');
    await page.locator('#overlay [data-close]').click();
    await page.locator('#tabs button[data-view="settings"]').click();
    await page.locator('#simplePasswordForm input[name="showPassword"]').check();
    assert.equal(await page.locator('#simplePasswordForm input[name="newPassword"]').getAttribute('type'), 'text');
    result.dialogChecks.push('显示密码');

    await page.locator('#tabs button[data-view="products"]').click();
    await page.locator('#productPager').getByText(/共 \d+ 个商品/).waitFor({ state: 'visible' });
    await page.locator('#productPager').getByText(/第 1 \/ \d+ 页/).waitFor({ state: 'visible' });
    const editButton = page.locator('#productList [data-open-editor]').first();
    if (await editButton.count()) {
      await editButton.click();
      await page.locator('section.view[data-view="editor"].is-active').waitFor({ state: 'visible' });
      const editorChecks = [
        ['商品名称', '#edName'],
        ['分类', '#edCat'],
        ['面向客户', '#edAudience'],
        ['商品图片', '#edUpload'],
        ['规格与价格', '[data-spec-block], #addSkuBtn'],
        ['顾客视角', '#editorPane'],
        ['上架状态', '#statusBtn']
      ];
      for (const [label, selector] of editorChecks) {
        await page.locator(selector).first().waitFor({ state: 'visible' });
        result.productEditor.checks.push(label);
      }
      result.productEditor.opened = true;
      await screenshot(page, '10-product-editor.png');
    }

    assert.deepEqual(result.dailyViews, ['orders', 'products', 'inventory', 'refunds', 'customers', 'delivery', 'marketing', 'settings']);
    assert.deepEqual(result.dialogChecks, ['新增配送时段', '新建拼团', '显示密码']);
    assert.equal(result.productEditor.opened, true, '未能从商品列表打开集中编辑页');
    assert.equal(result.productEditor.checks.length, 7, '商品编辑页关键操作未完整显示');
    const interstitial404 = (item) => result.interstitialHandled && item.status === 404 && item.url.includes('/admin-test/simple.html');
    result.applicationFailedResponses = result.failedResponses.filter((item) => !interstitial404(item));
    result.applicationConsoleErrors = result.consoleErrors.filter((message) => !(result.interstitialHandled && message === 'Failed to load resource: the server responded with a status of 404 (Not Found)'));
    assert.deepEqual(result.applicationFailedResponses, [], '运营后台加载后存在失败请求');
    assert.deepEqual(result.applicationConsoleErrors, [], '运营后台加载后存在前端错误');
  } finally {
    await context.close();
    await browser.close();
    fs.writeFileSync(path.join(evidenceDir, 'runtime-audit.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }

  console.log(JSON.stringify({
    authenticated: result.authenticated,
    dailyViews: result.dailyViews,
    dialogChecks: result.dialogChecks,
    productEditorChecks: result.productEditor.checks,
    forbiddenVisibleTerms: result.forbiddenVisibleTerms,
    applicationConsoleErrorCount: result.applicationConsoleErrors.length,
    applicationFailedResponseCount: result.applicationFailedResponses.length,
    evidenceDir
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
