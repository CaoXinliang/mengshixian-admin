const assert = require('node:assert/strict');
const { captureReviewDependencies } = require('../lib/review-dependencies');
let record = { _id: 'one', amount: 10, nested: { b: 2, a: 1 } };
const store = { findOne: async () => record, list: async () => ({ rows: record ? [record] : [] }) };
(async () => {
  const snapshot = captureReviewDependencies(store);
  await snapshot.store.list('prices', {});
  record = { nested: { a: 1, b: 2 }, amount: 10, _id: 'one' };
  await snapshot.verify({ getById: async () => record });
  record.amount = 20;
  await assert.rejects(() => snapshot.verify({ getById: async () => record }), { code: 'CATALOG_REVIEW_STALE' });
  await assert.rejects(() => snapshot.store.findOne('prices', {}), { code: 'CATALOG_REVIEW_STALE' });
  await assert.rejects(() => snapshot.verify({ getById: async () => null }), { code: 'CATALOG_REVIEW_STALE' });
  console.log('Review snapshot detects mutation/deletion without depending on object key ordering');
})().catch((error) => { console.error(error); process.exitCode = 1; });
