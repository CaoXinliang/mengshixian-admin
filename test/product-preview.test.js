const assert = require('node:assert/strict');
const { summarize, readiness, skuPriceReady } = require('../admin-product-preview.js');

const snapshot = {
  product: { status: 'on_sale', categoryId: 'cat', audienceType: 'c' },
  categories: [{ _id: 'cat', status: 'enabled' }],
  skus: [{ _id: 'sku', status: 'on_sale', specName: '1kg' }],
  prices: [
    { skuId: 'sku', scopeType: 'public', channel: 'all', status: 'active', amountCent: 3000 },
    { skuId: 'sku', scopeType: 'customer_type', scopeId: 'c', channel: 'all', status: 'active', amountCent: 2800 }
  ]
};
assert.equal(summarize(snapshot, 'c').visible, true);
assert.equal(summarize(snapshot, 'c').prices[0].rule.amountCent, 2800);
assert.equal(summarize(snapshot, 'b').visible, false);
assert.equal(summarize(snapshot, 'b').prices[0].rule.amountCent, 3000);
assert.equal(summarize({ ...snapshot, product: { ...snapshot.product, status: 'off_sale' } }, 'c').visible, false);
assert.equal(skuPriceReady(snapshot, 'sku'), true);
assert.match(readiness({ ...snapshot, media: [] }).join('；'), /主图/);
assert.deepEqual(readiness({ ...snapshot, product: { ...snapshot.product, coverMediaId: 'm1' }, media: [{ _id: 'm1', type: 'image' }] }), []);
assert.equal(skuPriceReady({ ...snapshot, prices: [{ skuId: 'sku', status: 'active', amountCent: 0 }] }, 'sku'), false);
console.log('product preview identity and price simulation: passed');
