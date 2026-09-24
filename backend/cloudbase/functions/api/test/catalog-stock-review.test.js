const assert = require('node:assert/strict');
const { reviewStock } = require('../lib/catalog-stock-review');
const warehouse = { _id: 'w', name: '测试仓', status: 'active' };
let inventory = [];
const store = { list: async (name) => ({ rows: name === 'warehouses' ? [warehouse] : inventory }) };
const skus = [{ _id: 's', skuCode: 'S', specName: '一袋', status: 'draft' }];
(async () => {
  assert.equal((await reviewStock(store, skus)).rows[0].ready, false);
  for (const available of [0, -1, null, undefined, '2', 1.5]) {
    inventory = [{ warehouseId: 'w', available }];
    assert.equal((await reviewStock(store, skus)).rows[0].ready, false);
  }
  inventory = [{ warehouseId: 'w', available: 2 }];
  assert.equal((await reviewStock(store, skus)).rows[0].ready, true);
  warehouse.status = 'disabled';
  assert.equal((await reviewStock(store, skus)).rows[0].ready, false);
  inventory[0].warehouseId = 'missing';
  assert.equal((await reviewStock(store, skus)).rows[0].ready, false);
  assert.deepEqual((await reviewStock(store, [{ ...skus[0], status: 'off_sale' }])).issues, []);
  console.log('Stock review missing, invalid, zero, active and disabled warehouse tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
