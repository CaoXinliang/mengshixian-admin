const assert = require('node:assert/strict');
module.exports = async function publishFlow({fixture, evaluate, waitFor, pause, productCode}) {
  const product = (await fixture.call('admin.products.list')).rows.find(row => row.spuCode === productCode);
  const sku = (await fixture.call('admin.skus.list')).rows.find(row => row.productId === product._id);
  const personal = (action, payload) => fixture.customerCall('local-catalog-personal', action, payload);
  const business = (action, payload) => fixture.customerCall('local-catalog-business', action, payload);
  assert.equal((await personal('catalog.products', {keyword:product.name})).rows.length, 0, '草稿不能被顾客看见');
  await evaluate("window.confirm = () => false; document.querySelector('#publishReviewed').click()");
  await pause(50);
  assert.equal((await fixture.call('admin.products.list')).rows[0].status, 'draft');
  assert.equal((await personal('catalog.products', {keyword:product.name})).rows.length, 0);
  await evaluate("window.confirm = text => {window.__finalPublishConfirmation = text; return true;}; document.querySelector('#publishReviewed').click(); document.querySelector('#publishReviewed').click()");
  await waitFor("document.querySelector('#globalMessage').textContent.includes('已明确确认并发布')");
  assert.ok((await evaluate('window.__finalPublishConfirmation')).includes(product.name));
  assert.equal((await fixture.call('admin.products.list')).rows[0].status, 'on_sale');
  const logs = (await fixture.call('admin.audit.list', {pageSize:100})).rows;
  const publications = logs.filter(row => row.action === 'catalog.product.publish_reviewed' && row.targetId === product._id);
  assert.equal(publications.length, 1, '连续点击只能留下一次该商品发布记录');
  assert.ok(publications[0].actorId && publications[0].createdAt);
  assert.equal(publications[0].details.productCode, productCode);
  const visible = (await personal('catalog.products', {keyword:product.name})).rows;
  assert.equal(visible.length, 1);
  assert.equal(visible[0]._id, product._id);
  const detail = await personal('catalog.product', {productId:product._id});
  assert.equal(detail.skus.length, 1);
  assert.equal(detail.skus[0]._id, sku._id);
  assert.ok(detail.media.some(row => row.mediaType === 'video'));
  assert.ok(detail.media.some(row => row.mediaType === 'image' && row.role === 'cover'));
  const prices = await personal('catalog.prices', {skuIds:[sku._id], channel:'miniapp'});
  assert.equal(prices.rows[0].amountCent, 1250);
  await assert.rejects(fixture.customerCall('', 'catalog.prices', {skuIds:[sku._id]}), error => error.code === 'UNAUTHENTICATED');

  const area = (await fixture.call('admin.deliveryAreas.list')).rows[0];
  const warehouse = (await fixture.call('admin.warehouses.list')).rows[0];
  const slot = (await fixture.call('admin.deliverySlots.list')).rows[0];
  const address = (await personal('address.upsert', {name:'仅本地个人测试',phone:'13800000000',regionCode:area.regionCodes[0],detail:'仅内存测试地址'})).address;
  const request = {addressId:address._id,warehouseId:warehouse._id,deliverySlotId:slot._id,channel:'miniapp',items:[{skuId:sku._id,quantity:2}]};
  const quote = (await personal('checkout.quote', request)).quote;
  assert.equal(quote.goodsAmountCent, 2500);
  assert.equal(quote.freightAmountCent, 500);
  assert.equal(quote.payableAmountCent, 3000);
  await assert.rejects(personal('checkout.quote', {...request,items:[{skuId:sku._id,quantity:11}]}), error => error.code === 'INVENTORY_NOT_AVAILABLE');

  const application = await business('auth.applyBusiness', {
    companyName:'仅本地企业验证',storeName:'仅本地门店',storeAddress:'仅内存地址',mainBusinessType:'restaurant',
    unifiedCode:'123456789012345678',storefrontMediaId:'local://fixture/store',businessLicenseMediaId:'local://fixture/license',
    contactName:'本地测试',contactPhone:'13900139000'
  });
  const reviewToken = (await fixture.call('admin.businessApplications.list')).rows.find((row) => row._id === application.application._id).reviewToken;
  await fixture.call('admin.businessApplications.review', {id:application.application._id,decision:'approved',priceLevel:'b_standard',reviewToken});
  assert.equal((await business('auth.me')).user.userType, 'b');
  assert.equal((await business('catalog.products', {keyword:product.name})).rows.length, 1, '默认面向两类顾客的商品对企业可见');
  assert.deepEqual((await business('catalog.prices', {skuIds:[sku._id],channel:'miniapp'})).rows, [], '未配置企业价时不得偷用个人价');
  const bAddress = (await business('address.upsert', {name:'仅本地企业测试',phone:'13900139000',regionCode:area.regionCodes[0],detail:'仅内存企业地址'})).address;
  await assert.rejects(business('checkout.quote', {...request,addressId:bAddress._id}), error => error.code === 'PRICE_NOT_AVAILABLE');
  console.log('Same product explicit publish: C sees media/spec/12.50, quote 2 units+5 shipping=30; guest price denied; B has no invented price and cannot quote');
};
