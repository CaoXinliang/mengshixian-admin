const assert = require('node:assert/strict');

module.exports = async function catalogInventoryBrowser({ fixture, send, evaluate, pause, waitFor, productCode }) {
  const warehouseName = '仅本地演示补货仓';
  const warehouseCode = 'LOCAL-CATALOG-INVENTORY-10';
  const products = (await fixture.call('admin.products.list', { pageSize: 100 })).rows;
  const product = products.find((row) => row.spuCode === productCode);
  assert.ok(product, '库存必须关联交付表生成的同一商品');
  const skus = (await fixture.call('admin.skus.list', { pageSize: 100 })).rows.filter((row) => row.productId === product._id);
  assert.equal(skus.length, 1, '本段演示只调整同一商品的唯一测试规格');
  const sku = skus[0];

  await send('Page.navigate', { url: 'http://127.0.0.1:8765/warehouses.html' });
  await waitFor("Boolean(document.querySelector('[data-add-form=\"#warehouseForm\"]') && document.querySelector('#warehouseForm'))");
  await evaluate(`(() => {
    document.querySelector('[data-add-form="#warehouseForm"]').click();
    const form = document.querySelector('#warehouseForm');
    form.elements.code.value = ${JSON.stringify(warehouseCode)};
    form.elements.name.value = ${JSON.stringify(warehouseName)};
    form.elements.address.value = '仅本地内存测试地址';
    form.elements.status.value = 'active';
    form.requestSubmit();
  })()`);
  await waitFor("document.querySelector('#globalMessage')?.textContent.includes('仓库已保存')");
  const warehouses = (await fixture.call('admin.warehouses.list', { pageSize: 100 })).rows;
  const matches = warehouses.filter((row) => row.code === warehouseCode && row.name === warehouseName && row.status === 'active');
  assert.equal(matches.length, 1, '页面须经实际本地 API 创建一座明确命名的演示仓');
  const warehouse = matches[0];

  await send('Page.navigate', { url: 'http://127.0.0.1:8765/inventory.html' });
  await waitFor(`Array.from(document.querySelector('#inventoryWarehouseChoice')?.options || []).some(option => option.textContent.includes(${JSON.stringify(warehouseName)})) && Array.from(document.querySelector('#inventorySkuChoice')?.options || []).some(option => option.textContent.includes(${JSON.stringify(product.name)}) && option.textContent.includes(${JSON.stringify(sku.specName)}))`);
  await evaluate('document.querySelector(\'[data-add-form="#inventoryForm"]\').click()');
  await evaluate(`(() => {
    const form = document.querySelector('#inventoryForm');
    const choose = (selector, label) => {
      const select = document.querySelector(selector);
      const matches = [...select.options].filter(option => option.textContent.includes(label));
      if (matches.length !== 1) throw new Error('名称不是唯一可选项：' + label);
      select.selectedIndex = matches[0].index;
      select.dispatchEvent(new Event('input', { bubbles: true }));
    };
    choose('#inventoryWarehouseChoice', ${JSON.stringify(warehouseName)});
    choose('#inventorySkuChoice', ${JSON.stringify(product.name + ' · ' + sku.specName)});
    form.elements.change.value = '10';
    form.elements.change.dispatchEvent(new Event('input', { bubbles: true }));
    form.elements.reason.value = '仅本地测试补货10件，非甲方真实库存';
    window.confirm = message => { window.__inventoryConfirmation = message; return false; };
    form.requestSubmit();
  })()`);
  const confirmation = await evaluate('window.__inventoryConfirmation');
  assert.match(confirmation, /增加 10/);
  assert.ok(confirmation.includes(warehouseName) && confirmation.includes(product.name) && confirmation.includes(sku.specName), '确认内容须是可读仓库和商品规格');
  const inventoryRows = async () => (await fixture.call('admin.inventory.list', { pageSize: 100 })).rows
    .filter((row) => row.warehouseId === warehouse._id && row.skuId === sku._id);
  assert.equal((await inventoryRows()).length, 0, '取消确认不能写入演示库存');

  await evaluate("window.confirm = () => true; document.querySelector('#inventoryForm').requestSubmit()");
  await waitFor("document.querySelector('#globalMessage')?.textContent.includes('库存已调整并写入流水')");
  let rows = await inventoryRows();
  for (let attempt = 0; attempt < 20 && rows.length === 0; attempt++) {
    await pause(40);
    rows = await inventoryRows();
  }
  assert.equal(rows.length, 1, '确认后同仓同规格应有一条实际库存记录');
  assert.equal(rows[0].onHand, 10);
  assert.equal(rows[0].reserved, 0);
  assert.equal(rows[0].available, 10, '本地演示补货后可售库存为10');
  console.log('Same delivered product: named local warehouse -> name-selected SKU -> cancel zero writes -> confirmed local inventory available 10');
};
