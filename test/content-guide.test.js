const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, populateSchedule, readSchedule } = require('../admin-content-guide.js');

const form = { elements: {
  title: { value: '秋季鲜品' }, mediaAssetId: { value: 'm1' }, jumpType: { value: 'product' },
  jumpTarget: { value: 'p1' }, enabled: { checked: false }, startAt: { value: '' }, endAt: { value: '' }
}, querySelectorAll(selector) { return this.platforms.filter((item) => selector.includes(':checked') ? item.checked : true); },
platforms: [{ value: 'miniapp', checked: true }, { value: 'web', checked: true }] };
const state = { media: [{ _id: 'm1', name: '秋季主图' }], products: [{ _id: 'p1', name: '精选虾仁' }], categories: [] };
assert.match(describe(form, state), /秋季鲜品[\s\S]*秋季主图[\s\S]*精选虾仁[\s\S]*仅保存草稿/);
form.elements.enabled.checked = true;
assert.match(describe(form, state), /保存后立即启用/);
populateSchedule(form, { startAt: '2026-09-26T02:00:00.000Z', endAt: '2026-09-27T02:00:00.000Z', targetPlatforms: ['miniapp'] });
assert.equal(form.elements.startAt.value, '2026-09-26T10:00');
assert.deepEqual(readSchedule(form), { startAt: '2026-09-26T02:00:00.000Z', endAt: '2026-09-27T02:00:00.000Z', targetPlatforms: ['miniapp'] });
assert.match(describe(form, state), /小程序[\s\S]*2026-09-26T10:00/);
form.platforms[0].checked = false;
assert.throws(() => readSchedule(form), /至少选择一个适用端/);
form.platforms[0].checked = true;
form.elements.endAt.value = '2026-09-25T10:00';
assert.throws(() => readSchedule(form), /不能早于/);
for (const page of ['banners.html', 'sections.html']) {
  const source = fs.readFileSync(path.resolve(__dirname, '..', page), 'utf8');
  assert.match(source, /admin-content-guide\.js[\s\S]*app\.js/);
}
console.log('content name and preview guide: passed');
