// SKU gate browser flow: on the published-product fixture, exercise the SKU table's
// standalone publish button against the server-side full review gate.
const assert = require('node:assert/strict');

module.exports = async function skuGateFlow({ fixture, send, evaluate, pause, waitFor, productCode }) {
  const products = (await fixture.call('admin.products.list', { pageSize: 100 })).rows;
  const product = products.find((item) => item.spuCode === productCode);
  assert.ok(product, '发布链商品存在');
  const skusOf = async () => (await fixture.call('admin.skus.list', { pageSize: 100 })).rows.filter((item) => item.productId === product._id);
  const onSaleSku = (await skusOf()).find((item) => item.status === 'on_sale');
  assert.ok(onSaleSku, '发布链应留有在售规格');
  const invRow = (await fixture.call('admin.inventory.list', { pageSize: 100 })).rows.find((row) => row.skuId === onSaleSku._id);
  assert.ok(invRow, '在售规格应有库存行');

  // 经 API 准备：下架原规格；新建缺库存、缺配送、缺包装单位的草稿规格（仅 Web 渠道价格）
  await fixture.call('admin.skus.setStatus', { id: onSaleSku._id, status: 'off_sale' });
  const draftSku = await fixture.call('admin.skus.upsert', { productId: product._id, skuCode: `${productCode}-B`, specName: '缺项规格', packageUnit: '', status: 'draft' });
  await fixture.call('admin.prices.upsert', { skuId: draftSku._id, scopeType: 'public', channel: 'web', amountCent: 999, status: 'active' });

  await send('Page.navigate', { url: 'http://127.0.0.1:8765/products.html' });
  await waitFor("Boolean(document.querySelector('[data-tab=prod-skus]'))");
  await evaluate("document.querySelector('[data-tab=prod-skus]').click(); true");
  await waitFor(`Boolean(document.querySelector('[data-publish-sku=${draftSku._id}]'))`);
  await evaluate('window.confirm = () => true; true');

  // 缺项点击：服务端拒绝并在页面提示缺项与核对页引导
  await evaluate(`document.querySelector('[data-publish-sku=${draftSku._id}]').click(); true`);
  await waitFor("document.querySelector('#globalMessage')?.textContent.includes('请先补齐')");
  const gateMessage = await evaluate("document.querySelector('#globalMessage').textContent");
  assert.match(gateMessage, /库存/, '缺项提示应包含库存');
  assert.match(gateMessage, /配送/, '缺项提示应包含配送');
  assert.match(gateMessage, /商品核对发布页/, '缺项提示应引导到商品核对发布页');
  assert.equal((await skusOf()).find((item) => item._id === draftSku._id).status, 'draft', '被拒后规格状态不得变化');

  // 经 API 补齐包装单位、个人端价格覆盖与库存后，再点同一按钮应成功
  await fixture.call('admin.skus.upsert', { id: draftSku._id, productId: product._id, skuCode: `${productCode}-B`, specName: '缺项规格', packageUnit: '1件', status: 'draft' });
  await fixture.call('admin.prices.upsert', { skuId: draftSku._id, scopeType: 'public', amountCent: 999, status: 'active' });
  await fixture.call('admin.inventory.adjust', { warehouseId: invRow.warehouseId, skuId: draftSku._id, change: 8, idempotencyKey: `sku-gate-${draftSku._id}` });
  await evaluate(`document.querySelector('[data-publish-sku=${draftSku._id}]').click(); true`);
  await waitFor("document.querySelector('#globalMessage')?.textContent.includes('SKU 已上架')");
  assert.equal((await skusOf()).find((item) => item._id === draftSku._id).status, 'on_sale', '补齐后页面上架应成功');

  const catalog = await fixture.customerCall('sku-gate-customer', 'catalog.products', {});
  const row = catalog.rows.find((item) => item._id === product._id);
  assert.equal((row.skus || []).some((sku) => sku._id === draftSku._id), true, '补齐后顾客端可见新规格');

  // 合法通道回归：页面上下架后再上架
  await waitFor(`Boolean(document.querySelector('[data-offsale-sku=${draftSku._id}]'))`);
  await evaluate(`document.querySelector('[data-offsale-sku=${draftSku._id}]').click(); true`);
  await waitFor("document.querySelector('#globalMessage')?.textContent.includes('SKU 已下架')");
  await waitFor(`Boolean(document.querySelector('[data-publish-sku=${draftSku._id}]'))`);
  await evaluate(`document.querySelector('[data-publish-sku=${draftSku._id}]').click(); true`);
  await waitFor("document.querySelector('#globalMessage')?.textContent.includes('SKU 已上架')");
  console.log('SKU gate browser: 缺项拒绝、补齐上架、顾客可见、重启用均通过');
};
