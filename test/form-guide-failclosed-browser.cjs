// Isolated Edge: missing name-selection scripts must not expose internal-ID fallback forms.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.FRIEND_ADMIN_PLAYWRIGHT || 'playwright');
const { startLocalPreview } = require('../local-preview/server.cjs');

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'friend-admin-form-guide-'));
  let server;
  let browser;
  try {
    server = await startLocalPreview({ port: 0, dataDir });
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage();
    await page.goto(`${server.url}/login.html`);
    await page.getByRole('button', { name: '一键进入本机练习后台' }).click();
    await page.waitForURL(`${server.url}/index.html`);

    const cases = [
      { script: 'admin-product-form-guide.js', page: 'products.html', tab: '[data-tab="prod-media"]', button: '[data-add-form="#productMediaForm"]', form: '#productMediaForm', nameField: 'productId' },
      { script: 'admin-operation-forms.js', page: 'pricing.html', button: '[data-add-form="#priceForm"]', form: '#priceForm', nameField: 'skuId' },
      { script: 'admin-content-guide.js', page: 'banners.html', button: '[data-add-form="#bannerForm"]', form: '#bannerForm', nameField: 'mediaAssetId' }
    ];
    for (const item of cases) {
      const pattern = `**/${item.script}`;
      let blocked = 0;
      await page.route(pattern, route => { blocked += 1; return route.abort(); });
      await page.goto(`${server.url}/${item.page}`);
      assert.ok(blocked > 0, `${item.script} request should be blocked`);
      assert.equal(await page.evaluate(name => typeof window[name], item.script === 'admin-product-form-guide.js' ? 'MengshixianProductFormGuide' : item.script === 'admin-operation-forms.js' ? 'MengshixianOperationForms' : 'MengshixianContentGuide'), 'undefined');
      if (item.tab) await page.locator(item.tab).click();
      await page.locator(item.button).click();
      assert.equal(await page.locator('#modalOverlay').getAttribute('aria-hidden'), 'true', `${item.page} must not fall back to raw IDs`);
      assert.match(await page.locator('#globalMessage').innerText(), /表单暂不可用/);
      await page.unroute(pattern);
      await page.reload();
      if (item.tab) await page.locator(item.tab).click();
      await page.locator(item.button).click();
      assert.equal(await page.locator(`${item.form} select[name="${item.nameField}"]`).count(), 1, `${item.page} should recover name selection after reload`);
    }

    await page.route('**/admin-inventory-guide.js', route => route.abort());
    await page.goto(`${server.url}/inventory.html`);
    await page.locator('[data-add-form="#inventoryForm"]').click();
    assert.equal(await page.locator('#modalOverlay').getAttribute('aria-hidden'), 'true', '库存引导缺失时不得退回仓库和规格编号输入');
    assert.match(await page.locator('#globalMessage').innerText(), /表单暂不可用/);
    await page.unroute('**/admin-inventory-guide.js');
    await page.reload();
    await page.locator('[data-add-form="#inventoryForm"]').click();
    assert.equal(await page.locator('#inventoryWarehouseChoice').count(), 1, '库存引导恢复后按仓库名称选择');
    console.log('名称选择脚本缺失时表单安全停用、恢复后按名称选择：通过');
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
