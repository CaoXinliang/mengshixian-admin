const { fail } = require('./response');
const { sha256 } = require('./security');

function canonical(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])]));
}
const digest = (row) => sha256(JSON.stringify(canonical(row)));

// Tracks existing documents only. Collection membership changes need a separate revision guard.
function captureReviewDependencies(store) {
  const documents = new Map();
  function capture(collection, row) {
    if (!row || !row._id) return;
    const key = JSON.stringify([collection, row._id]);
    const hash = digest(row);
    if (documents.has(key) && documents.get(key).hash !== hash) fail('CATALOG_REVIEW_STALE', '核对过程中资料已变化，请重新读取。');
    documents.set(key, { collection, id: row._id, hash });
  }
  return {
    store: {
      async findOne(collection, where, options) {
        const row = await store.findOne(collection, where, options); capture(collection, row); return row;
      },
      async list(collection, options) {
        const result = await store.list(collection, options);
        result.rows.forEach((row) => capture(collection, row)); return result;
      }
    },
    async verify(tx) {
      for (const item of documents.values()) {
        const current = await tx.getById(item.collection, item.id);
        if (!current || digest(current) !== item.hash) fail('CATALOG_REVIEW_STALE', '价格、库存、配送或商品资料已变化，请重新核对后再发布。');
      }
    }
  };
}

module.exports = { captureReviewDependencies };
