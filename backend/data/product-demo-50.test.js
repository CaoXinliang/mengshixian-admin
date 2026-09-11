const assert = require('assert/strict');
const fixture = require('./product-demo-50.json');

assert.equal(fixture.count, 50, 'demo manifest must declare 50 products');
assert.equal(fixture.rows.length, 50, 'demo manifest must contain 50 products');
assert.equal(fixture.source, 'ai_generated');
assert.equal(fixture.temporary, true);
assert.equal(new Set(fixture.rows.map((row) => row.source.id)).size, 50, 'demo rows must be unique');
let multiSkuProducts = 0;
for (const row of fixture.rows) {
  assert.equal(row.parsed.source, 'ai_generated');
  assert.equal(row.parsed.temporary, true);
  assert(Number.isInteger(row.parsed.demoPriceCent) && row.parsed.demoPriceCent > 0);
  assert(Number.isInteger(row.parsed.demoInitialStock) && row.parsed.demoInitialStock > 0);
  assert(Array.isArray(row.parsed.demoSkus) && row.parsed.demoSkus.length >= 1);
  assert(Array.isArray(row.demo.skus) && row.demo.skus.length >= 1);
  if (row.demo.skus.length > 1) multiSkuProducts += 1;
  assert.equal(new Set(row.demo.skus.map((sku) => sku.specName)).size, row.demo.skus.length);
  for (const sku of row.demo.skus) {
    assert(sku.key && sku.specName && sku.packageUnit);
    assert(Number.isInteger(sku.amountCent) && sku.amountCent > 0);
    assert(Number.isInteger(sku.initialStock) && sku.initialStock > 0);
  }
}
assert.equal(multiSkuProducts, 8, 'fixture must include eight representative multi-SKU products');
console.log('demo product fixture test: passed');
