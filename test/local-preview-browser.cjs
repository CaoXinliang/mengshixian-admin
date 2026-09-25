// Real Edge UI + delivered XLSX + isolated loopback practice API. Never CloudBase.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.FRIEND_ADMIN_PLAYWRIGHT || 'playwright');
const { startLocalPreview } = require('../local-preview/server.cjs');

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'friend-admin-ui-'));
  let server, browser;
  try {
    server = await startLocalPreview({ port: 0, dataDir });
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage();
    const external = [];
    page.on('request', request => {
      if (!request.url().startsWith(server.url)) external.push(request.url());
    });

    await page.goto(`${server.url}/login.html`);
    await page.waitForFunction(() => document.querySelector('#loginMessage')?.textContent.includes('本机练习服务连接正常'));
    assert.match(await page.locator('.local-practice-entry').innerText(), /原来的云端账号和密码不能用于本机练习/);
    await page.getByRole('button', { name: '一键进入本机练习后台' }).click();
    await page.waitForURL(`${server.url}/index.html`);

    await page.goto(`${server.url}/imports.html`);
    await page.waitForSelector('#stagingFile');
    await page.waitForFunction(() => Boolean(window.MengshixianImportParser));
    const draftCount = () => page.evaluate(async () => (await MengshixianAdminApi.call('admin.imports.list', { pageSize: 20 })).rows.length);
    assert.equal(await draftCount(), 0, '初始队列应为空');
    const workbook = path.join(__dirname, '..', 'outputs', '01a0cd53-41af-7eb2-824f-c1e8b42fa25d', '商品导入测试演示_仅本地.xlsx');
    await page.locator('#stagingFile').setInputFiles(workbook);
    await page.waitForFunction(() => document.querySelector('#importPreviewSummary')?.textContent.includes('可保存 6 行'));
    assert.equal(await page.locator('#importPreviewRows tr').count(), 6);
    assert.equal(await draftCount(), 0, '选文件和预览不得直接保存');
    assert.equal(await page.locator('#saveImportDrafts').isEnabled(), true);

    page.once('dialog', dialog => dialog.accept());
    await page.locator('#saveImportDrafts').click();
    await page.waitForFunction(() => document.querySelector('#globalMessage')?.textContent.includes('导入完成：新建 6 条'));
    await page.waitForFunction(() => document.querySelectorAll('#importsTable tr').length === 6);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#importsTable tr').length === 6);
    const result = await page.evaluate(async () => ({
      drafts: (await MengshixianAdminApi.call('admin.imports.list', { pageSize: 20 })).rows.length,
      products: (await MengshixianAdminApi.call('admin.products.list', { pageSize: 20 })).rows.length
    }));
    assert.deepEqual(result, { drafts: 6, products: 0 }, '刷新后只有六条待审核草稿，未自动建商品');

    const first = await page.evaluate(async () => (await MengshixianAdminApi.call('admin.imports.list', { pageSize: 20 })).rows.find(row => row.parsedPayload?.skuCode === 'TEST-S-0001'));
    assert.ok(first, '从交付演示表首行继续生成商品草稿');
    page.once('dialog', dialog => dialog.dismiss());
    await page.locator(`[data-approve-import="${first._id}"]`).click();
    assert.equal(await page.evaluate(async () => (await MengshixianAdminApi.call('admin.products.list')).rows.length), 0, '取消生成不得建立商品');
    page.once('dialog', dialog => dialog.accept());
    await page.locator(`[data-approve-import="${first._id}"]`).click();
    await page.waitForFunction(() => document.querySelector('#globalMessage')?.textContent.includes('已生成商品草稿'));
    const product = await page.evaluate(async code => (await MengshixianAdminApi.call('admin.products.list')).rows.find(row => row.spuCode === code), first.parsedPayload.productCode);
    assert.equal(product.status, 'draft');
    await page.goto(`${server.url}/product-review.html?code=${encodeURIComponent(first.parsedPayload.productCode)}`);
    await page.waitForSelector('#publishReviewed');
    assert.equal(await page.locator('#publishReviewed').isDisabled(), true, '缺价格、图片、库存等条件时不得上架');
    const review = await page.locator('#reviewDetail').innerText();
    assert.match(review, /待补/);
    assert.match(review, /价格/);
    assert.match(review, /主图/);
    assert.match(review, /库存/);

    await page.goto(`${server.url}/media.html`);
    await page.getByRole('button', { name: '+ 上传素材' }).click();
    await page.locator('#mediaForm input[name="name"]').fill('本机练习图片');
    await page.locator('#mediaForm select[name="source"]').selectOption('demo');
    await page.locator('#mediaForm input[name="temporary"]').check();
    await page.locator('#mediaForm input[name="uploadFile"]').setInputFiles(path.join(__dirname, '..', 'assets', 'logo.png'));
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#mediaForm button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('#globalMessage')?.textContent.includes('文件已上传并登记到素材库'));
    await page.waitForFunction(() => document.querySelectorAll('#mediaTable button[data-preview-media]').length === 1);
    if (process.env.FRIEND_ADMIN_VISUAL_OUTPUT_DIR) {
      await fs.mkdir(process.env.FRIEND_ADMIN_VISUAL_OUTPUT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.FRIEND_ADMIN_VISUAL_OUTPUT_DIR, 'media-uploaded.png'), fullPage: true });
    }
    await page.locator('#mediaTable button[data-preview-media]').click();
    await page.waitForFunction(() => document.querySelector('#mediaPreviewDialog img')?.naturalWidth > 0);
    assert.match(await page.locator('#mediaPreviewDialog').innerText(), /来源.*演示素材/);
    assert.match(await page.locator('#mediaPreviewDialog').innerText(), /版本.*1/);
    if (process.env.FRIEND_ADMIN_VISUAL_OUTPUT_DIR) {
      await page.locator('#mediaPreviewDialog').screenshot({ path: path.join(process.env.FRIEND_ADMIN_VISUAL_OUTPUT_DIR, 'media-preview-metadata.png') });
    }
    await page.locator('[data-preview-close]').click();
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#mediaTable button[data-preview-media]').length === 1);

    await page.goto(`${server.url}/product-review.html?code=${encodeURIComponent(first.parsedPayload.productCode)}`);
    await page.waitForSelector('#linkMediaAsset');
    const mediaChoice = await page.locator('#linkMediaAsset option').evaluateAll(options => options.find(option => option.textContent.includes('本机练习图片'))?.value || '');
    assert.ok(mediaChoice, '核对页可以按素材名称找到刚上传的图片');
    await page.locator('#linkMediaAsset').selectOption(mediaChoice);
    await page.locator('#linkMediaRole').selectOption('cover');
    await page.locator('#linkMedia').click();
    await page.waitForFunction(() => document.querySelector('#reviewDetail img[alt="商品主图"]')?.naturalWidth > 0);
    assert.equal(await page.locator('#publishReviewed').isDisabled(), true, '有主图但仍缺价格/库存时不得上架');

    const videoBase64 = await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
      const context = canvas.getContext('2d');
      const stream = canvas.captureStream(10);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
      const chunks = [];
      recorder.ondataavailable = event => chunks.push(event.data);
      const stopped = new Promise(resolve => { recorder.onstop = resolve; });
      recorder.start();
      for (let frame = 0; frame < 8; frame += 1) {
        context.fillStyle = frame % 2 ? '#1565c0' : '#ffffff';
        context.fillRect(0, 0, 64, 64);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      recorder.stop(); await stopped; stream.getTracks().forEach(track => track.stop());
      const reader = new FileReader();
      const encoded = new Promise(resolve => { reader.onload = () => resolve(String(reader.result).split(',')[1]); });
      reader.readAsDataURL(new Blob(chunks, { type: 'video/webm' }));
      return encoded;
    });
    assert.ok(videoBase64.length > 100, '本机测试短片应有实际视频内容');
    await page.goto(`${server.url}/media.html`);
    await page.getByRole('button', { name: '+ 上传素材' }).click();
    await page.locator('#mediaForm input[name="name"]').fill('本机练习短片');
    await page.locator('#mediaForm select[name="type"]').selectOption('video');
    await page.locator('#mediaForm select[name="source"]').selectOption('demo');
    await page.locator('#mediaForm input[name="temporary"]').check();
    await page.locator('#mediaForm input[name="uploadFile"]').setInputFiles({ name: '本机练习短片.webm', mimeType: 'video/webm', buffer: Buffer.from(videoBase64, 'base64') });
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#mediaForm button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('#globalMessage')?.textContent.includes('文件已上传并登记到素材库'));
    await page.locator('#mediaSearch').fill('短片');
    await page.waitForFunction(() => document.querySelectorAll('#mediaTable button[data-preview-media]').length === 1 && document.querySelector('#mediaTable')?.textContent.includes('本机练习短片'));
    assert.equal(await page.locator('#mediaTable').innerText().then(text => text.includes('本机练习图片')), false, '名称搜索不得混入不匹配的图片');
    await page.locator('#mediaSearch').fill('');
    await page.waitForFunction(() => document.querySelectorAll('#mediaTable button[data-preview-media]').length === 2);
    await page.goto(`${server.url}/product-review.html?code=${encodeURIComponent(first.parsedPayload.productCode)}`);
    await page.waitForSelector('#linkMediaType');
    await page.locator('#linkMediaType').selectOption('video');
    const videoChoice = await page.locator('#linkMediaAsset option').evaluateAll(options => options.find(option => option.textContent.includes('本机练习短片'))?.value || '');
    assert.ok(videoChoice, '核对页可以按素材名称找到刚上传的视频');
    await page.locator('#linkMediaAsset').selectOption(videoChoice);
    await page.locator('#linkMedia').click();
    await page.waitForFunction(() => document.querySelector('#reviewDetail video')?.readyState >= 1);
    await page.locator('#reviewDetail video').evaluate(async video => { video.muted = true; await video.play(); });
    await page.waitForFunction(() => document.querySelector('#reviewDetail video')?.currentTime > 0.1);
    await page.locator('#reviewDetail video').evaluate(video => video.pause());
    assert.equal(await page.locator('#publishReviewed').isDisabled(), true, '视频可播仍不得绕过缺价格/库存保护');

    const sku = await page.evaluate(async productId => (await MengshixianAdminApi.call('admin.skus.list')).rows.find(row => row.productId === productId), product._id);
    assert.equal(sku.skuCode, 'TEST-S-0001');
    await page.goto(`${server.url}/pricing.html`);
    await page.locator('[data-add-form="#priceForm"]').click();
    await page.waitForFunction(() => document.querySelector('#priceForm')?.elements.skuId?.tagName === 'SELECT');
    const selectedSku = await page.locator('#priceForm select[name="skuId"] option').evaluateAll((options, labels) => options.find(option => labels.every(label => option.textContent.includes(label)))?.value || '', [product.name, sku.specName]);
    assert.equal(selectedSku, sku._id, '通过页面中的商品与规格名称选择销售规格');
    await page.locator('#priceForm select[name="skuId"]').selectOption(selectedSku);
    await page.locator('#priceForm select[name="scopeType"]').selectOption('customer_type');
    await page.waitForFunction(() => Array.from(document.querySelector('#priceForm')?.elements.scopeId?.options || []).some(option => option.textContent.includes('个人顾客')));
    const personalChoice = await page.locator('#priceForm select[name="scopeId"] option').evaluateAll(options => options.find(option => option.textContent.includes('个人顾客'))?.value || '');
    await page.locator('#priceForm select[name="scopeId"]').selectOption(personalChoice);
    await page.locator('#priceForm select[name="channel"]').selectOption('miniapp');
    await page.locator('#priceForm input[name="amountCent"]').fill('12.50');
    await page.locator('#priceForm select[name="status"]').selectOption('active');
    page.once('dialog', dialog => { assert.match(dialog.message(), /¥12\.50/); void dialog.dismiss(); });
    await page.locator('#priceForm button.primary').click();
    assert.equal(await page.evaluate(async () => (await MengshixianAdminApi.call('admin.prices.list')).rows.length), 0, '取消价格确认不得写入');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#priceForm button.primary').click();
    await page.waitForFunction(() => document.querySelector('#globalMessage')?.textContent.includes('价格规则已保存'));
    const prices = await page.evaluate(async () => (await MengshixianAdminApi.call('admin.prices.list')).rows);
    assert.equal(prices.length, 1);
    assert.equal(prices[0].amountCent, 1250, '输入 12.50 元按服务端规则保存为 1250 分');
    assert.equal(prices[0].scopeType, 'customer_type');
    assert.equal(prices[0].scopeId, 'c', '不得擅自生成企业价');
    await page.goto(`${server.url}/product-review.html?code=${encodeURIComponent(first.parsedPayload.productCode)}`);
    await page.waitForFunction(() => document.querySelector('#reviewDetail')?.textContent.includes('¥12.50'));
    assert.equal(await page.locator('#publishReviewed').isDisabled(), true, '补价格后库存和配送未完成仍不能上架');

    await page.goto(`${server.url}/warehouses.html`);
    await page.locator('[data-add-form="#warehouseForm"]').click();
    await page.locator('#warehouseForm input[name="code"]').fill('LOCAL-PRACTICE-WAREHOUSE-01');
    await page.locator('#warehouseForm input[name="name"]').fill('仅本机测试仓');
    await page.locator('#warehouseForm input[name="address"]').fill('隔离测试地址，非甲方仓库');
    await page.locator('#warehouseForm select[name="status"]').selectOption('active');
    await page.locator('#warehouseForm button.primary').click();
    await page.waitForFunction(() => document.querySelector('#globalMessage')?.textContent.includes('仓库已保存'));
    const warehouse = await page.evaluate(async () => (await MengshixianAdminApi.call('admin.warehouses.list')).rows.find(row => row.name === '仅本机测试仓'));
    assert.ok(warehouse?._id);

    await page.goto(`${server.url}/inventory.html`);
    await page.waitForFunction(() => Array.from(document.querySelector('#inventoryWarehouseChoice')?.options || []).some(option => option.textContent.includes('仅本机测试仓')));
    await page.locator('[data-add-form="#inventoryForm"]').click();
    const warehouseChoice = await page.locator('#inventoryWarehouseChoice option').evaluateAll(options => options.find(option => option.textContent.includes('仅本机测试仓'))?.value || '');
    const inventorySkuChoice = await page.locator('#inventorySkuChoice option').evaluateAll((options, labels) => options.find(option => labels.every(label => option.textContent.includes(label)))?.value || '', [product.name, sku.specName]);
    assert.equal(warehouseChoice, warehouse._id);
    assert.equal(inventorySkuChoice, sku._id);
    await page.locator('#inventoryWarehouseChoice').selectOption(warehouseChoice);
    await page.locator('#inventorySkuChoice').selectOption(inventorySkuChoice);
    await page.locator('#inventoryForm input[name="change"]').fill('10');
    await page.locator('#inventoryForm textarea[name="reason"], #inventoryForm input[name="reason"]').fill('仅本机测试补货十件，非真实库存');
    page.once('dialog', dialog => { assert.match(dialog.message(), /增加 10/); void dialog.dismiss(); });
    await page.locator('#inventoryForm button.primary').click();
    assert.equal(await page.evaluate(async () => (await MengshixianAdminApi.call('admin.inventory.list')).rows.length), 0, '取消库存登记不得写入');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#inventoryForm button.primary').click();
    await page.waitForFunction(() => document.querySelector('#globalMessage')?.textContent.includes('库存已调整并写入流水'));
    const stock = await page.evaluate(async keys => (await MengshixianAdminApi.call('admin.inventory.list')).rows.find(row => row.warehouseId === keys.warehouseId && row.skuId === keys.skuId), { warehouseId: warehouse._id, skuId: sku._id });
    assert.equal(stock.available, 10, '测试库存只在已选仓库和销售规格下可售十件');
    await page.goto(`${server.url}/product-review.html?code=${encodeURIComponent(first.parsedPayload.productCode)}`);
    await page.waitForFunction(() => document.querySelector('#reviewDetail')?.textContent.includes('可售 10'));
    assert.equal(await page.locator('#publishReviewed').isDisabled(), true, '补库存后配送仍未完成，不得上架');

    await page.goto(`${server.url}/areas.html`);
    await page.locator('[data-add-form="#deliveryAreaForm"]').click();
    await page.locator('#deliveryAreaForm [data-role="open-picker"]').click();
    await page.locator('[data-col="province"] .region-picker-item').first().click();
    await page.locator('[data-col="city"] .region-picker-item').first().click();
    await page.locator('[data-col="district"] .region-picker-item').first().click();
    await page.locator('[data-role="confirm"]').click();
    await page.locator('#deliveryAreaForm input[name="name"]').fill('仅本机测试配送区');
    await page.locator('#deliveryAreaForm .warehouse-name-choices label').filter({ hasText: '仅本机测试仓' }).locator('input').check();
    await page.locator('#deliveryAreaForm select[name="status"]').selectOption('active');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#deliveryAreaForm').getByRole('button', { name: '保存配送区域' }).click();
    await page.waitForFunction(() => document.querySelector('#globalMessage')?.textContent.includes('配送区域已保存'));
    const area = await page.evaluate(async () => (await MengshixianAdminApi.call('admin.deliveryAreas.list')).rows.find(row => row.name === '仅本机测试配送区'));
    assert.deepEqual(area.warehouseIds, [warehouse._id]);

    await page.goto(`${server.url}/freight.html`);
    await page.locator('[data-add-form="#freightForm"]').click();
    await page.locator('#freightForm input[name="name"]').fill('仅本机测试运费');
    const freightArea = await page.locator('#freightForm select[name="deliveryAreaId"] option').evaluateAll(options => options.find(option => option.textContent.includes('仅本机测试配送区'))?.value || '');
    const freightWarehouse = await page.locator('#freightForm select[name="warehouseId"] option').evaluateAll(options => options.find(option => option.textContent.includes('仅本机测试仓'))?.value || '');
    await page.locator('#freightForm select[name="deliveryAreaId"]').selectOption(freightArea);
    await page.locator('#freightForm select[name="warehouseId"]').selectOption(freightWarehouse);
    await page.locator('#freightForm input[name="baseFeeCent"]').fill('5.00');
    await page.locator('#freightForm input[name="additionalFeeCent"]').fill('0.00');
    await page.locator('#freightForm input[name="freeThresholdCent"]').fill('100.00');
    await page.locator('#freightForm select[name="status"]').selectOption('active');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#freightForm button.primary').click();
    await page.waitForFunction(() => document.querySelector('#globalMessage')?.textContent.includes('运费规则已保存'));
    const freight = await page.evaluate(async () => (await MengshixianAdminApi.call('admin.freightRules.list')).rows.find(row => row.name === '仅本机测试运费'));
    assert.equal(freight.baseFeeCent, 500, '页面输入五元，服务端保存五百分');

    await page.goto(`${server.url}/slots.html`);
    await page.locator('[data-add-form="#deliverySlotForm"]').click();
    await page.locator('#deliverySlotForm input[name="name"]').fill('仅本机测试上午');
    const slotArea = await page.locator('#deliverySlotForm select[name="deliveryAreaId"] option').evaluateAll(options => options.find(option => option.textContent.includes('仅本机测试配送区'))?.value || '');
    const slotWarehouse = await page.locator('#deliverySlotForm select[name="warehouseId"] option').evaluateAll(options => options.find(option => option.textContent.includes('仅本机测试仓'))?.value || '');
    await page.locator('#deliverySlotForm select[name="deliveryAreaId"]').selectOption(slotArea);
    await page.locator('#deliverySlotForm select[name="warehouseId"]').selectOption(slotWarehouse);
    await page.locator('#deliverySlotForm input[name="startTime"]').fill('09:00');
    await page.locator('#deliverySlotForm input[name="endTime"]').fill('12:00');
    await page.locator('#deliverySlotForm select[name="status"]').selectOption('active');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#deliverySlotForm button.primary').click();
    await page.waitForFunction(() => document.querySelector('#globalMessage')?.textContent.includes('配送时段已保存'));

    await page.goto(`${server.url}/categories.html`);
    await page.waitForSelector('[data-edit-category]');
    await page.locator('[data-edit-category]').first().click();
    await page.locator('#categoryForm select[name="status"]').selectOption('enabled');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#categoryForm button.primary').click();
    await page.waitForFunction(() => document.querySelector('#globalMessage')?.textContent.includes('分类已保存'));
    await page.goto(`${server.url}/product-review.html?code=${encodeURIComponent(first.parsedPayload.productCode)}`);
    await page.waitForFunction(() => document.querySelector('#publishReviewed')?.disabled === false);
    assert.equal((await page.evaluate(async id => (await MengshixianAdminApi.call('admin.products.list')).rows.find(row => row._id === id)?.status, product._id)), 'draft', '资料满足条件后仍须明确确认，不能自动上架');
    page.once('dialog', dialog => { assert.match(dialog.message(), /确认发布后顾客可能立即看到/); void dialog.dismiss(); });
    await page.locator('#publishReviewed').click();
    assert.equal((await page.evaluate(async id => (await MengshixianAdminApi.call('admin.products.list')).rows.find(row => row._id === id)?.status, product._id)), 'draft', '取消发布必须仍是草稿');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#publishReviewed').click();
    await page.waitForFunction(() => document.querySelector('#globalMessage')?.textContent.includes('已明确确认并发布'));
    if (process.env.FRIEND_ADMIN_VISUAL_OUTPUT_DIR) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(process.env.FRIEND_ADMIN_VISUAL_OUTPUT_DIR, 'product-review-published.png') });
      await page.locator('#reviewDetail').screenshot({ path: path.join(process.env.FRIEND_ADMIN_VISUAL_OUTPUT_DIR, 'product-review-detail.png') });
    }
    assert.equal((await page.evaluate(async id => (await MengshixianAdminApi.call('admin.products.list')).rows.find(row => row._id === id)?.status, product._id)), 'on_sale');
    const visible = await page.evaluate(async name => (await MengshixianAdminApi.call('catalog.products', { keyword: name })).rows, product.name);
    assert.ok(visible.some(row => row._id === product._id), '本机顾客目录接口可见已明确发布的商品');
    const customerPrice = await page.evaluate(async id => (await MengshixianAdminApi.call('catalog.prices', { skuIds: [id], channel: 'miniapp' })).rows, sku._id);
    assert.equal(customerPrice.find(row => row.skuId === sku._id)?.amountCent, 1250);
    const audits = await page.evaluate(async () => (await MengshixianAdminApi.call('admin.audit.list', { pageSize: 100 })).rows);
    assert.equal(audits.filter(row => row.action === 'catalog.product.publish_reviewed' && row.targetId === product._id).length, 1, '明确发布留下单次操作记录');

    await page.goto(`${server.url}/products.html`);
    await page.locator('[data-tab="prod-media"]').click();
    await page.locator('[data-add-form="#productMediaForm"]').click();
    assert.equal(await page.locator('#productMediaForm select[name="productId"]').count(), 1, '商品媒体表单用名称选择商品，不手填内部 ID');
    assert.equal(await page.locator('#productMediaForm select[name="skuId"]').count(), 1);
    assert.equal(await page.locator('#productMediaForm select[name="mediaAssetId"]').count(), 1);
    assert.match(await page.locator('#productMediaForm').innerText(), /关联商品[\s\S]*销售规格[\s\S]*素材名称/);

    await page.goto(`${server.url}/banners.html`);
    await page.locator('[data-add-form="#bannerForm"]').click();
    assert.equal(await page.locator('#bannerForm select[name="mediaAssetId"]').count(), 1, '首页轮播按素材名称选择');
    await page.locator('#bannerForm select[name="jumpType"]').selectOption('product');
    assert.equal(await page.locator('#bannerForm select[name="jumpTarget"]').count(), 1, '首页跳转从已上架商品中选择');
    assert.ok((await page.locator('#bannerForm select[name="jumpTarget"]').innerText()).includes(product.name));
    await page.goto(`${server.url}/sections.html`);
    await page.locator('[data-add-form="#sectionForm"]').click();
    assert.equal(await page.locator('#sectionForm select[name="mediaAssetId"]').count(), 1, '首页模块按素材名称选择');
    await page.locator('#sectionForm select[name="jumpType"]').selectOption('product');
    assert.ok((await page.locator('#sectionForm select[name="jumpTarget"]').innerText()).includes(product.name));

    await page.goto(`${server.url}/access.html`);
    await page.locator('#staffPage [data-staff-action="create"]').click();
    await page.locator('[data-staff-form="create"] input[name="username"]').fill('local-practice-operator');
    await page.locator('[data-staff-form="create"] input[name="displayName"]').fill('本机测试运营');
    await page.locator('[data-staff-form="create"] input[name="phone"]').fill('13900139001');
    await page.locator('[data-staff-form="create"] input[name="password"]').fill('local-practice-password-2026');
    await page.locator('[data-staff-form="create"] select[name="role"]').selectOption('operator');
    await page.locator('[data-staff-form="create"] button[type="submit"]').click();
    await page.waitForSelector('#staffPage [role="alertdialog"]');
    assert.match(await page.locator('#staffPage [role="alertdialog"]').innerText(), /本机测试运营.*运营/);
    await page.locator('#staffPage [data-staff-action="confirm"]').click();
    await page.waitForFunction(() => document.querySelector('#staffPage')?.textContent.includes('local-practice-operator'));
    const operator = await page.evaluate(async () => (await MengshixianAdminApi.call('admin.adminUsers.list')).rows.find(row => row.username === 'local-practice-operator'));
    assert.equal(operator.role, 'operator');
    assert.equal(operator.phoneVerificationStatus, 'unverified', '登记手机号不得冒充短信已验证');

    const oldToken = await page.evaluate(() => MengshixianAdminApi.getToken());
    await page.locator('#adminAccountLogout').click();
    await page.waitForURL(`${server.url}/login.html`);
    await page.goto(`${server.url}/imports.html`);
    await page.waitForURL(`${server.url}/login.html`);
    assert.equal(await page.evaluate(() => MengshixianAdminApi.getToken()), '', '退出后旧浏览器会话应被清除');
    const expired = await (await fetch(`${server.url}/__local/api`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'admin.me', payload: { adminToken: oldToken } })
    })).json();
    assert.equal(expired.ok, false, '退出后旧会话不能继续调用接口');

    await page.locator('#loginForm input[name="username"]').fill('local-practice-operator');
    await page.locator('#loginForm input[name="password"]').fill('local-practice-password-2026');
    await page.locator('#loginForm button[type="submit"]').click();
    await page.waitForURL(`${server.url}/index.html`);
    await page.goto(`${server.url}/access.html`);
    await page.waitForSelector('#staffPage .staff-detail');
    assert.match(await page.locator('#staffPage').innerText(), /本机测试运营[\s\S]*角色[\s\S]*运营/);
    assert.equal(await page.locator('#staffPage [data-staff-action="create"]').count(), 0, '运营不能看见创建工作人员入口');
    const denied = await page.evaluate(async () => {
      try { await MengshixianAdminApi.call('admin.staff.create', { username: 'forbidden-account' }); return 'ALLOWED'; }
      catch (error) { return error.code; }
    });
    assert.equal(denied, 'ADMIN_FORBIDDEN', '服务端拒绝运营创建账号');
    await page.goto(`${server.url}/categories.html`);
    await page.locator('[data-add-form="#categoryForm"]').click();
    await page.locator('#categoryForm input[name="name"]').fill('本机运营新增草稿分类');
    await page.locator('#categoryForm select[name="status"]').selectOption('disabled');
    await page.locator('#categoryForm button.primary').click();
    await page.waitForFunction(() => document.querySelector('#globalMessage')?.textContent.includes('分类已保存'));
    const operatorCategory = await page.evaluate(async () => (await MengshixianAdminApi.call('admin.categories.list')).rows.find(row => row.name === '本机运营新增草稿分类'));
    assert.equal(operatorCategory.status, 'disabled', '运营获准保存未启用分类，不会影响顾客端');
    const operatorToken = await page.evaluate(() => MengshixianAdminApi.getToken());
    await page.locator('#adminAccountLogout').click();
    await page.waitForURL(`${server.url}/login.html`);
    const operatorExpired = await (await fetch(`${server.url}/__local/api`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'admin.me', payload: { adminToken: operatorToken } })
    })).json();
    assert.equal(operatorExpired.ok, false, '运营退出后旧会话也必须失效');
    assert.deepEqual(external, [], '本机验收不得请求外部服务');
    console.log('本机 Edge：XLSX→草稿→PNG/WebM→个人价/库存/配送→核对发布→本机顾客接口；超管建运营→运营获准写入/越权拒绝→退出失效：通过');
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep), '拒绝清理非测试临时目录');
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
