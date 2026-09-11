const assert = require('assert/strict');
const path = require('path');

const staging = require(path.resolve(__dirname, 'product-staging.json'));

assert.equal(staging.count, 200, 'staging manifest must declare 200 products');
assert.equal(staging.rows.length, 200, 'staging rows must contain exactly 200 products');
assert.equal(new Set(staging.rows.map((item) => item.source && item.source.id)).size, 200, 'source ids must be unique');

for (const item of staging.rows) {
  assert(item.source && item.sourceRowNo > 0, 'every row must keep source row traceability');
  assert(item.parsed, 'every row must keep parsed fields');
  assert.equal(item.parsed.name, item.source.name, 'parsed name must match source name');
  assert.equal(item.parsed.price, null, 'price must stay null until confirmed');
  assert.deepStrictEqual(item.parsed.mediaIds, [], 'media must stay empty until real assets are uploaded');
  assert(item.parsed.packageUnit, 'packaging/package unit must be split into its own field');
  assert(!item.parsed.name.includes('品名规格'), 'specification must not be embedded in product name');
  assert(item.parsed.status === 'pending_review', 'staged products must remain pending review');
}

console.log('product staging test: passed');
