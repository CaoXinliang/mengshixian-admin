const assert = require('assert/strict');
const { collectPageMatches } = require('../lib/collection-read');

function makeStore(total) {
  const rows = Array.from({ length: total }, (_, index) => ({ _id: `id-${index}`, value: index }));
  let pagesRead = 0;
  return {
    get pagesRead() { return pagesRead; },
    async list(collection, options) {
      pagesRead += 1;
      const page = options.page || 1;
      const pageSize = options.pageSize || 20;
      const start = (page - 1) * pageSize;
      return { rows: rows.slice(start, start + pageSize), total: rows.length, page, pageSize };
    }
  };
}

async function run() {
  const store = makeStore(250);
  const matches = await collectPageMatches(store, 'items', {}, (item) => item.value % 2 === 0);
  assert.equal(matches.length, 125, '应跨页收集全部匹配项');
  assert.equal(store.pagesRead, 3, '250 条按每页 100 应读取 3 页');

  const earlyStore = makeStore(250);
  const early = await collectPageMatches(earlyStore, 'items', {}, (item) => item.value === 3, { isComplete: (rows) => rows.length >= 1 });
  assert.deepEqual(early.map((item) => item._id), ['id-3']);
  assert.equal(earlyStore.pagesRead, 1, '命中完成后应立即停止分页');

  console.log('collection read helper test: passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
