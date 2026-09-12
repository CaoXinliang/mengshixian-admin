const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const simpleHtml = fs.readFileSync(path.join(root, 'simple.html'), 'utf8');
const simpleSource = fs.readFileSync(path.join(root, 'simple.js'), 'utf8');
const advancedHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const advancedSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

const dailyModules = [...simpleHtml.matchAll(/<button data-view="(dashboard|orders|products|inventory|refunds|customers|delivery|marketing|settings)"[^>]*>/g)];
assert.equal(dailyModules.length, 9, '自提点必须留在配送设置内，不能成为第十个一级入口');
assert.match(simpleHtml, /data-view="delivery"[\s\S]*?<strong>配送设置<\/strong>/, '普通后台必须保留配送设置一级入口');
assert.match(simpleHtml, /id="newPickupSiteBtn"/, '普通后台配送设置必须能新增自提点');
assert.match(simpleHtml, /id="pickupSiteList"/, '普通后台配送设置必须展示自提点列表');
assert.match(simpleSource, /optionalList\('admin\.pickupSites\.list'\)/, '普通后台必须按契约读取自提点');
assert.match(simpleSource, /api\.call\('admin\.pickupSites\.upsert', payload\)/, '普通后台新增编辑必须按契约保存自提点');
assert.match(simpleSource, /data-pickup-toggle=/, '普通后台必须提供自提点启停操作');
assert.match(simpleSource, /name: site\.name, address: site\.address, regionCode: site\.regionCode, warehouseId: site\.warehouseId, openingHours: site\.openingHours, status: toggle\.dataset\.pickupToggle, sort:/, '启停必须完整保留自提点契约字段');

assert.match(advancedHtml, /id="pickupSiteForm"/, '高级后台必须提供完整自提点表单');
for (const field of ['name', 'address', 'regionCode', 'warehouseId', 'openingHours', 'status', 'sort']) {
  assert.match(advancedHtml, new RegExp(`name="${field}"`), `高级自提点表单缺少 ${field}`);
}
assert.match(advancedHtml, /id="pickupSitesTable"/, '高级后台必须提供自提点列表');
assert.match(advancedSource, /listAll\('admin\.pickupSites\.list'\)/, '高级后台必须完整分页读取自提点');
assert.match(advancedSource, /call\('admin\.pickupSites\.upsert', \{ id: form\.get\('id'\), name: form\.get\('name'\), address: form\.get\('address'\), regionCode: form\.get\('regionCode'\), warehouseId: form\.get\('warehouseId'\), openingHours: form\.get\('openingHours'\), status: form\.get\('status'\), sort:/, '高级后台必须完整提交自提点契约字段');
assert.match(advancedSource, /data-toggle-pickup-site=/, '高级后台必须提供自提点启停操作');
assert.match(advancedHtml, /name="regionCode" required maxlength="80"/, '高级后台区域编码长度必须与后端 80 字符契约一致');
assert.match(advancedHtml, /name="openingHours" maxlength="200"/, '高级后台营业时间长度必须与后端 200 字符契约一致');
assert.doesNotMatch(advancedHtml, /name="openingHours" required/, '高级后台营业时间必须允许留空');
assert.match(simpleSource, /id="pickupRegionCode" maxlength="80"/, '普通后台区域编码长度必须与后端一致');
assert.match(simpleSource, /id="pickupOpeningHours" maxlength="200"/, '普通后台营业时间长度必须与后端一致');
assert.doesNotMatch(simpleSource, /!payload\.openingHours/, '普通后台不得把后端可空的营业时间设为必填');

console.log('pickup sites admin contract: passed (nine-entry navigation, simple and advanced CRUD/status coverage)');
