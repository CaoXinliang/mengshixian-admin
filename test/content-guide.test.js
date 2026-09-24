const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe } = require('../admin-content-guide.js');

const form = { elements: {
  title: { value: '秋季鲜品' }, mediaAssetId: { value: 'm1' }, jumpType: { value: 'product' },
  jumpTarget: { value: 'p1' }, enabled: { checked: false }
} };
const state = { media: [{ _id: 'm1', name: '秋季主图' }], products: [{ _id: 'p1', name: '精选虾仁' }], categories: [] };
assert.match(describe(form, state), /秋季鲜品[\s\S]*秋季主图[\s\S]*精选虾仁[\s\S]*仅保存草稿/);
form.elements.enabled.checked = true;
assert.match(describe(form, state), /保存后立即启用/);
for (const page of ['banners.html', 'sections.html']) {
  const source = fs.readFileSync(path.resolve(__dirname, '..', page), 'utf8');
  assert.match(source, /admin-content-guide\.js[\s\S]*app\.js/);
}
console.log('content name and preview guide: passed');
