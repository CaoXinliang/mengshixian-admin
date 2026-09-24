const assert = require('node:assert/strict');
const { priceLabel } = require('../admin-review-labels');
assert.equal(priceLabel({ amountCent: 1250, scopeType: 'customer_type', scopeId: 'c', channel: 'miniapp' }), '¥12.50（个人顾客价格 · 仅小程序）');
assert.match(priceLabel({ amountCent: 100, scopeType: 'public' }), /公开价格.*小程序和网页/);
assert.match(priceLabel({ amountCent: 100, scopeType: 'customer_type', scopeId: 'b', channel: 'web' }), /企业顾客价格.*仅网页/);
assert.doesNotMatch(priceLabel({ amountCent: 100, scopeType: 'user', scopeId: 'private-id' }), /private-id/);
assert.match(priceLabel({ amountCent: -1, scopeType: 'unknown', channel: 'unknown' }), /金额待核实.*范围待核实.*适用端待核实/);
console.log('Review price labels use readable scope, audience, yuan and channel');
