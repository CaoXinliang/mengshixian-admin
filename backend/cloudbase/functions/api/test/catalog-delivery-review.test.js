const assert = require('node:assert/strict');
const { reviewDelivery } = require('../lib/catalog-delivery-review');
const records = {
  delivery_areas: [{ _id: 'a', name: '测试区', warehouseIds: ['w'], regionCodes: ['R'], status: 'active' }],
  freight_rules: [{ _id: 'f', deliveryAreaId: 'a', warehouseId: 'w', baseFeeCent: 500, status: 'active' }],
  delivery_slots: [{ _id: 's', name: '上午', deliveryAreaId: 'a', warehouseId: 'w', status: 'active' }]
};
const match = (row, where = {}) => Object.entries(where).every(([key, value]) => row[key] === value);
const store = {
  list: async (name, options = {}) => ({ rows: records[name].filter((row) => match(row, options.where)) }),
  findOne: async (name, where) => records[name].find((row) => match(row, where))
};
const stock = [{ skuCode: 'S', specName: '一袋', locations: [{ warehouseId: 'w', warehouseName: '测试仓', usable: true }] }];
const read = () => reviewDelivery(store, stock, 'c', new Date('2026-09-23T00:00:00Z'));
(async () => {
  assert.equal((await read()).issues.length, 0);
  for (const [name, field, value] of [
    ['delivery_areas', 'status', 'disabled'], ['freight_rules', 'status', 'disabled'],
    ['freight_rules', 'customerType', 'b'], ['freight_rules', 'warehouseId', 'other'],
    ['delivery_slots', 'warehouseId', 'other'], ['delivery_slots', 'deliveryAreaId', 'other'],
    ['delivery_slots', 'status', 'disabled']
  ]) {
    const old = records[name][0][field]; records[name][0][field] = value;
    assert.equal((await read()).issues.length, 1, `${name}.${field}`);
    records[name][0][field] = old;
  }
  stock[0].locations[0].usable = false;
  assert.equal((await read()).issues.length, 1);
  console.log('Delivery review uses checkout matching and rejects incomplete routes');
})().catch((error) => { console.error(error); process.exitCode = 1; });
