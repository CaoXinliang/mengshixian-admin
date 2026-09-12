const assert = require('assert/strict');
const marketing = require('../lib/marketing');

async function run() {
  const calls = [];
  const store = {
    async getById() { return null; },
    async list(collection, options = {}) {
      calls.push({ collection, options });
      assert.equal(options.allowMissingCollection, true, `${collection} 必须显式允许尚未初始化的可选集合`);
      return { rows: [], total: 0, page: options.page || 1, pageSize: options.pageSize || 20 };
    }
  };
  const now = new Date('2026-09-12T00:00:00.000Z');
  const user = { _id: 'user-optional-empty' };

  assert.deepEqual((await marketing.bundleList({ store, payload: { page: 1, pageSize: 20 }, now })).rows, []);
  assert.deepEqual((await marketing.couponTemplates({ store, payload: { page: 1, pageSize: 20 }, now })).rows, []);
  assert.deepEqual((await marketing.couponList({ store, user, payload: { page: 1, pageSize: 20 }, now })).rows, []);
  assert.equal((await marketing.pointsAccount({ store, user })).account.balance, 0);
  assert.equal((await marketing.membership({ store, user })).level, null);
  assert.deepEqual((await marketing.userRows({ store, user, collection: 'points_ledger', payload: { page: 1, pageSize: 20 } })).rows, []);
  assert.deepEqual((await marketing.publicReviews({ store, payload: { productId: 'product-1', page: 1, pageSize: 20 } })).rows, []);

  assert.deepEqual(
    [...new Set(calls.map((item) => item.collection))].sort(),
    ['bundles', 'coupon_templates', 'membership_levels', 'points_ledger', 'reviews', 'user_coupons'].sort()
  );
  console.log('optional marketing empty-state test: passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
