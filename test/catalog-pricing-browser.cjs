const assert = require('node:assert/strict');

// ¥12.50 is a synthetic, local-memory-only test price, never a client-approved price.
module.exports = async function catalogPricingBrowser({ fixture, send, evaluate, pause, waitFor, productCode }) {
  const product = (await fixture.call('admin.products.list', { pageSize: 100 })).rows.find((row) => row.spuCode === productCode);
  assert.ok(product, '定价须沿已导入的同一商品草稿');
  assert.equal(product.status, 'draft');
  const skus = (await fixture.call('admin.skus.list', { pageSize: 100 })).rows.filter((row) => row.productId === product._id);
  assert.equal(skus.length, 1, '当前只给交付表首条销售规格定价');
  const sku = skus[0];
  assert.equal(sku.skuCode, 'TEST-S-0001');
  assert.deepEqual((await fixture.call('admin.prices.list', { pageSize: 100 })).rows, [], '本地测试价从空价格规则开始');

  await send('Page.navigate', { url: 'http://127.0.0.1:8765/pricing.html' });
  await waitFor("Boolean(document.querySelector('[data-add-form=\"#priceForm\"]') && document.querySelector('#priceForm'))");
  assert.equal(await evaluate("window.MengshixianAdminApi?.config?.envId"), 'local-memory-only', '合成测试价只允许写入隔离内存 API');
  await evaluate("document.querySelector('[data-add-form=\"#priceForm\"]').click()");
  await waitFor("document.querySelector('#priceForm')?.elements.skuId?.tagName === 'SELECT' && document.querySelector('#priceForm')?.elements.scopeId?.tagName === 'SELECT'");

  await evaluate(`(() => {
    const form = document.querySelector('#priceForm');
    const choices = [...form.elements.skuId.options].filter(option => option.textContent.includes(${JSON.stringify(product.name)}) && option.textContent.includes(${JSON.stringify(sku.specName)}));
    if (choices.length !== 1) throw new Error('同一商品规格名称不是唯一可选项');
    form.elements.skuId.selectedIndex = choices[0].index;
    form.elements.scopeType.value = 'customer_type';
    form.elements.scopeType.dispatchEvent(new Event('change', { bubbles: true }));
    form.elements.channel.value = 'miniapp';
    form.elements.amountCent.value = '12.50';
    form.elements.status.value = 'active';
  })()`);
  await waitFor("[...document.querySelector('#priceForm').elements.scopeId.options].some(option => option.textContent.includes('个人顾客（C 端）'))");
  await evaluate(`(() => {
    const select = document.querySelector('#priceForm').elements.scopeId;
    const choices = [...select.options].filter(option => option.textContent.includes('个人顾客（C 端）'));
    if (choices.length !== 1) throw new Error('个人顾客价格对象不可唯一选择');
    select.selectedIndex = choices[0].index;
    window.confirm = message => { window.__catalogPriceConfirmation = message; return false; };
    document.querySelector('#priceForm').requestSubmit();
  })()`);
  const cancelledText = await evaluate('window.__catalogPriceConfirmation');
  assert.match(cancelledText, /¥12\.50/);
  assert.match(cancelledText, /个人顾客/);
  assert.match(cancelledText, /保存后立即生效/);
  assert.deepEqual((await fixture.call('admin.prices.list', { pageSize: 100 })).rows, [], '取消确认不得创建价格规则');

  await evaluate("window.confirm = message => { window.__catalogPriceConfirmation = message; return true; }; document.querySelector('#priceForm').requestSubmit()");
  await waitFor("document.querySelector('#globalMessage')?.textContent.includes('价格规则已保存')");
  const prices = (await fixture.call('admin.prices.list', { pageSize: 100 })).rows;
  assert.equal(prices.length, 1, '确认后只创建一条个人小程序价格');
  assert.equal(prices[0].skuId, sku._id);
  assert.equal(prices[0].amountCent, 1250, '页面输入 12.50 元必须由真实 API 保存为 1250 分');
  assert.equal(prices[0].scopeType, 'customer_type');
  assert.equal(prices[0].scopeId, 'c');
  assert.equal(prices[0].channel, 'miniapp');
  assert.equal(prices[0].status, 'active');
  assert.ok(!prices.some((row) => row.scopeType === 'public' || row.scopeId === 'b'), '个人测试价不得合并成公开价或企业价');

  const reviewUrl = `http://127.0.0.1:8765/product-review.html?code=${encodeURIComponent(productCode)}`;
  await send('Page.navigate', { url: reviewUrl });
  await waitFor(`Boolean(document.querySelector('#reviewDetail')?.textContent.includes(${JSON.stringify(productCode)}) && document.querySelector('#reviewDetail')?.textContent.includes('¥12.50（个人顾客价格 · 仅小程序）'))`);
  const review = await fixture.call('admin.products.review', { id: product._id });
  const reviewedSku = review.skus.find((row) => row.id === sku._id);
  assert.equal(reviewedSku?.personalPriceReady, true, '实际 API 须确认个人小程序价格已覆盖');
  assert.ok(reviewedSku.prices.some((row) => row.amountCent === 1250 && row.scopeType === 'customer_type' && row.scopeId === 'c' && row.channel === 'miniapp'));
  assert.equal(review.ready, false, '价格补齐后仍不得跳过库存配送');
  assert.ok(review.issues.some((issue) => issue.includes('库存')), '缺库存仍须明确显示');
  assert.ok(review.issues.some((issue) => issue.includes('配送')), '缺配送仍须明确显示');
  assert.equal(await evaluate("document.querySelector('#publishReviewed')?.disabled"), true, '核对页不得允许发布');
  await assert.rejects(
    fixture.call('admin.products.publishReviewed', { id: product._id, reviewToken: review.reviewToken }),
    (error) => error.code === 'PRODUCT_NOT_READY',
    '实际 API 也必须拒绝缺库存配送的发布'
  );
  assert.equal((await fixture.call('admin.products.list')).rows.find((row) => row._id === product._id).status, 'draft');
  console.log('Same delivered product: local synthetic C-miniapp ¥12.50 -> 1250 cents; cancel zero writes; no public/B price; stock/delivery still block publish');
};
