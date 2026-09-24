const assert = require('node:assert/strict');
module.exports = async function deliveryFlow({fixture, send, evaluate, waitFor, pause, productCode}) {
  const warehouse = (await fixture.call('admin.warehouses.list')).rows[0];
  assert.ok(warehouse, '使用同链路库存步骤创建的本地仓库');
  const areaName = '仅本地验收配送区';
  async function open(page, form) {
    await send('Page.navigate', {url:`http://127.0.0.1:8765/${page}.html`});
    await waitFor(`Boolean(document.querySelector('[data-add-form="#${form}"]') && document.querySelector('#adminUser')?.textContent.includes('超级管理员') && document.querySelector('#adminConnectionState')?.textContent.includes('已连接'))`);
    await evaluate(`document.querySelector('[data-add-form="#${form}"]').click()`);
  }
  async function submit(form, message) {
    await evaluate(`window.confirm = () => true; document.querySelector('#${form}').requestSubmit()`);
    await waitFor(`document.querySelector('#globalMessage').textContent.includes(${JSON.stringify(message)})`);
  }
  const choose = (form, name, label) => evaluate(`(() => {
    const field = document.querySelector('#${form}').elements[${JSON.stringify(name)}];
    if (field.tagName !== 'SELECT') throw new Error('必须使用名称选择器');
    const option = Array.from(field.options).find(row => row.textContent === ${JSON.stringify(label)});
    if (!option) throw new Error('缺少名称选项：' + ${JSON.stringify(label)});
    field.selectedIndex = option.index; field.dispatchEvent(new Event('change', {bubbles:true}));
  })()`);
  await open('areas', 'deliveryAreaForm');
  assert.equal(await evaluate("document.querySelector('#deliveryAreaForm').elements.status.value"), 'disabled');
  await evaluate(`document.querySelector('#deliveryAreaForm [data-role=open-picker]').click();
    document.querySelector('[data-col=province] .region-picker-item').click();
    document.querySelector('[data-col=city] .region-picker-item').click();
    document.querySelector('[data-col=district] .region-picker-item').click();
    document.querySelector('[data-role=confirm]').click();`);
  await evaluate(`(() => {
    const form = document.querySelector('#deliveryAreaForm'); form.elements.name.value = ${JSON.stringify(areaName)};
    const label = Array.from(form.querySelectorAll('.warehouse-name-choices label')).find(node => node.textContent === ${JSON.stringify(warehouse.name)});
    if (!label) throw new Error('找不到本地仓库名称'); label.querySelector('input').click();
    form.elements.status.value = 'active'; window.confirm = () => false; form.requestSubmit();
  })()`);
  await pause(50);
  assert.equal((await fixture.call('admin.deliveryAreas.list')).rows.length, 0);
  await submit('deliveryAreaForm', '配送区域已保存');
  const area = (await fixture.call('admin.deliveryAreas.list')).rows[0];
  assert.equal(area.name, areaName);
  assert.equal(area.status, 'active');
  assert.deepEqual(area.warehouseIds, [warehouse._id]);

  await open('freight', 'freightForm');
  await choose('freightForm', 'deliveryAreaId', areaName);
  await choose('freightForm', 'warehouseId', warehouse.name);
  await evaluate(`(() => {const form = document.querySelector('#freightForm');
    form.elements.name.value = '仅本地验收运费'; form.elements.baseFeeCent.value = '5.00';
    form.elements.additionalFeeCent.value = '0.00'; form.elements.freeThresholdCent.value = '100.00';
    form.elements.status.value = 'active';})()`);
  await submit('freightForm', '运费规则已保存');
  const freight = (await fixture.call('admin.freightRules.list')).rows[0];
  assert.equal(freight.baseFeeCent, 500);
  assert.equal(freight.freeThresholdCent, 10000);

  await open('slots', 'deliverySlotForm');
  await choose('deliverySlotForm', 'deliveryAreaId', areaName);
  await choose('deliverySlotForm', 'warehouseId', warehouse.name);
  await evaluate(`(() => {const form = document.querySelector('#deliverySlotForm');
    form.elements.name.value = '仅本地上午'; form.elements.startTime.value = '09:00';
    form.elements.endTime.value = '12:00'; form.elements.status.value = 'active';})()`);
  await submit('deliverySlotForm', '配送时段已保存');
  const slots = (await fixture.call('admin.deliverySlots.list')).rows;
  assert.equal(slots.length, 1);
  assert.equal(slots[0].name, '仅本地上午');
  assert.equal(slots[0].deliveryAreaId, area._id);
  assert.equal(slots[0].warehouseId, warehouse._id);
  assert.equal(slots[0].startTime, '09:00');
  assert.equal(slots[0].endTime, '12:00');
  assert.equal(slots[0].status, 'active');

  // Enable the imported category through its page, not by seeding the database.
  await send('Page.navigate', {url:'http://127.0.0.1:8765/categories.html'});
  await waitFor("Boolean(document.querySelector('[data-edit-category]'))");
  await evaluate("document.querySelector('[data-edit-category]').click(); document.querySelector('#categoryForm').elements.status.value = 'enabled'");
  await submit('categoryForm', '分类已保存');
  const product = (await fixture.call('admin.products.list')).rows.find(row => row.spuCode === productCode);
  const review = await fixture.call('admin.products.review', {id:product._id});
  assert.equal(review.ready, true, JSON.stringify(review.issues));
  await send('Page.navigate', {url:`http://127.0.0.1:8765/product-review.html?code=${encodeURIComponent(productCode)}`});
  await waitFor("document.querySelector('#publishReviewed')?.disabled === false");
  assert.equal((await fixture.call('admin.products.list')).rows[0].status, 'draft', '资料齐全也不自动发布');
  console.log('Same product: named delivery area/warehouse, yuan freight and slot forms -> review ready, still draft');
  return {warehouse, area, freight};
};
