// Local practice data only. Captures real Edge renderings; never calls CloudBase.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.FRIEND_ADMIN_PLAYWRIGHT || 'playwright');
const { startLocalPreview } = require('../local-preview/server.cjs');

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'friend-admin-visual-'));
  const outputDir = process.env.FRIEND_ADMIN_VISUAL_OUTPUT_DIR || path.join(os.tmpdir(), 'friend-admin-visual-review-2026-09-24');
  const pages = ['index', 'imports', 'products', 'product-workflow', 'product-review', 'categories', 'pricing', 'orders', 'refunds', 'media', 'inventory', 'warehouses', 'opening-check', 'areas', 'slots', 'freight', 'banners', 'sections', 'businesses', 'users', 'access', 'audit'];
  let server;
  let browser;
  try {
    server = await startLocalPreview({ port: 0, dataDir });
    browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--disable-gpu'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
    const external = [];
    const errors = [];
    page.on('request', request => { if (!request.url().startsWith(server.url)) external.push(request.url()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${server.url}/login.html`);
    assert.match(await page.locator('.local-practice-entry').innerText(), /原来的云端账号和密码不能用于本机练习/);
    assert.match(await page.locator('#loginForm').innerText(), /本机工作人员账号/);
    await fs.mkdir(outputDir, { recursive: true });
    await page.screenshot({ path: path.join(outputDir, 'login.png'), fullPage: true });
    await page.getByRole('button', { name: '一键进入本机练习后台' }).click();
    await page.waitForURL(`${server.url}/index.html`);
    for (const name of pages) {
      await page.goto(`${server.url}/${name}.html`);
      await page.locator('#adminHeader').waitFor();
      await page.waitForFunction(() => !document.querySelector('.loading-overlay'), null, { timeout: 15000 });
      assert.equal(await page.locator('.panel.is-active').count(), 1, `${name} should have one active content panel`);
      if (name === 'index') {
        const dailyNav = (await page.locator('#mainNav > .nav-group').allInnerTexts()).join(' ');
        assert.doesNotMatch(dailyNav, /分类管理|价格规则|仓库管理|轮播图|首页模块/);
        assert.match(await page.locator('.sidebar-advanced').textContent(), /分类管理|价格规则|仓库管理|轮播图|首页模块/);
      }
      if (['categories', 'pricing', 'warehouses', 'banners', 'sections'].includes(name)) {
        assert.equal(await page.locator('.sidebar-advanced').getAttribute('open'), '', `${name} must appear in the opened advanced section`);
        assert.equal(await page.locator('#mainNav [aria-current="page"]').count(), 1);
      }
      if (name === 'orders') assert.match(await page.locator('.empty-state').innerText(), /当前没有订单/);
      if (name === 'media') assert.match(await page.locator('.empty-state').innerText(), /素材库还没有文件/);
      if (name === 'media') {
        assert.equal(await page.locator('table:has(#mediaTable) th').filter({ hasText: '来源' }).isVisible(), false);
        assert.equal(await page.locator('table:has(#mediaTable) th').filter({ hasText: '版本' }).isVisible(), false);
      }
      if (['categories', 'pricing', 'refunds'].includes(name)) {
        assert.equal(await page.locator('.operation-task').isVisible(), true, `${name} needs a clear primary task`);
        assert.equal(await page.locator('#pageSummary').count(), 0, `${name} should not repeat generic metric cards`);
      }
      if (name === 'pricing') assert.equal(await page.locator('table:has(#pricesTable) th').filter({ hasText: '销售规格' }).count(), 1);
      if (name === 'inventory') {
        assert.equal(await page.locator('#inventoryGuideEmpty').isVisible(), true, 'inventory must show a useful empty state');
        assert.equal(await page.locator('#inventoryMatches table').isVisible(), false, 'inventory must not show a header-only table');
      }
      if (name === 'audit') {
        await page.locator('.audit-event').first().waitFor();
        assert.equal(await page.locator('#pageSummary').count(), 0);
        assert.match(await page.locator('#auditTimeline').innerText(), /操作人：本机练习管理员 · 当前角色：超级管理员/);
        assert.match(await page.locator('#auditTimeline').innerText(), /登录后台|初始化后台管理员/);
        assert.doesNotMatch(await page.locator('#auditTimeline').innerText(), /admin\.login|admin_users_/);
        assert.match(await page.locator('#auditCount').innerText(), /共 \d+ 条真实记录/);
      }
      if (['orders', 'media', 'areas', 'slots', 'freight'].includes(name)) {
        assert.equal(await page.locator('.panel.is-active .empty-state').isVisible(), true, `${name} must show its empty state`);
      }
      await page.screenshot({ path: path.join(outputDir, `${name}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1024, height: 768 });
    for (const name of ['index', 'products', 'orders', 'media', 'inventory', 'areas']) {
      await page.goto(`${server.url}/${name}.html`);
      await page.waitForFunction(() => !document.querySelector('.loading-overlay'), null, { timeout: 15000 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 2, `${name} must fit a 1024px desktop without whole-page horizontal scrolling: ${overflow}px`);
      const headerLines = await page.evaluate(() => {
        const title = document.querySelector('#panelTitle');
        return title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight);
      });
      assert.ok(headerLines <= 1.2, `${name} header title must not wrap at 1024px`);
      if (['index', 'orders'].includes(name)) await page.screenshot({ path: path.join(outputDir, `${name}-1024.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.route('**/__local/api', route => {
      const body = route.request().postDataJSON();
      if (body.action === 'admin.orders.list') return route.abort('failed');
      return route.continue();
    });
    await page.goto(`${server.url}/orders.html`);
    await page.waitForFunction(() => document.querySelector('#globalMessage')?.textContent.includes('后台数据加载失败'));
    assert.match(await page.locator('#ordersTable .empty-state').innerText(), /资料暂不可用/);
    assert.doesNotMatch(await page.locator('#ordersTable .empty-state').innerText(), /当前没有订单/);
    assert.equal(await page.locator('#ordersTable .empty-state').isVisible(), true);
    await page.screenshot({ path: path.join(outputDir, 'orders-unavailable.png'), fullPage: true });
    await page.unroute('**/__local/api');
    await page.route('**/__local/api', route => {
      const body = route.request().postDataJSON();
      if (body.action === 'admin.audit.list') return route.abort('failed');
      return route.continue();
    });
    await page.goto(`${server.url}/audit.html`);
    await page.waitForFunction(() => document.querySelector('#auditFeedback')?.textContent.includes('记录读取失败'));
    assert.match(await page.locator('#auditCount').innerText(), /暂不可用/);
    assert.equal(await page.locator('#auditTimeline .audit-event').count(), 0);
    await page.screenshot({ path: path.join(outputDir, 'audit-unavailable.png'), fullPage: true });
    assert.deepEqual(external, [], 'visual checks must remain on the local practice server');
    assert.deepEqual(errors, [], 'visual pages must not raise browser JavaScript errors');
    console.log(`Local Edge visual pages: ${pages.length} captured in ${outputDir}`);
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
