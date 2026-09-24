const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, ask } = require('../admin-operations-confirm.js');
const root = path.resolve(__dirname, '..');

assert.match(describe('businessApprove', { companyName: '海鲜商贸', unifiedCode: '9133000', contactName: '张先生' }), /成为企业客户/);
assert.match(describe('refundApprove', { refundNo: 'R-1', amountCent: 4590, reason: '破损' }), /¥45\.90[\s\S]*破损[\s\S]*不等于退款已经到账/);
assert.match(describe('orderTransition', { orderNo: 'O-1', totalAmountCent: 1800 }, { status: 'shipping' }), /O-1[\s\S]*已实际交运/);
assert.match(describe('skuPublish', { specName: '1kg' }), /完整上架核对[\s\S]*缺项时会被拒绝/);
assert.match(describe('contentEnable', { title: '秋季轮播', impact: '启用后顾客可能在首页看到此轮播图。' }), /秋季轮播[\s\S]*首页看到此轮播图/);
assert.match(describe('importApprove', { parsedPayload: { name: '虾仁', categoryName: '海鲜' } }), /虾仁[\s\S]*仍不会上架/);
assert.match(describe('productPublish', { name: '虾仁' }), /虾仁[\s\S]*顾客可能立即看到/);
let called = false;
assert.equal(ask('refundReject', { refundNo: 'R-1' }, {}, () => { called = true; return false; }), false);
assert.equal(called, true);
assert.equal(ask('refundApprove', null, {}, () => { throw new Error('不应弹窗'); }), false);

for (const page of ['orders.html', 'refunds.html', 'businesses.html', 'products.html', 'imports.html', 'categories.html', 'banners.html', 'sections.html', 'warehouses.html']) {
  const html = fs.readFileSync(path.join(root, page), 'utf8');
  assert.match(html, /admin-operations-confirm\.js[\s\S]*app\.js/, `${page} 应先加载确认模块`);
}
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
assert.doesNotMatch(app, /admin\.imports\.activateBatch/, '运营后台不得提供未核对的批量上架入口');
console.log('sensitive operation confirmation contract: passed');
