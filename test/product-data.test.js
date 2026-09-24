const assert = require('node:assert/strict');
const { create } = require('../admin-product-data.js');

async function test() {
  const calls = [];
  const api = {
    call: async (action, payload) => { calls.push({ action, payload }); return { _id: 'saved' }; },
    uploadMediaFile: async () => ({ fileId: 'cloud://file', mimeType: 'image/png', sizeBytes: 12 })
  };
  const data = create(api, { listAll: async () => ({ rows: [] }) });
  await data.saveProduct({ _id: 'p1', spuCode: 'old', name: 'old', brand: 'brand', shelfLifeDays: 365, description: 'keep', storageType: 'frozen', frozenTemperature: '-18℃', sort: 3, coverMediaId: 'old-image' }, { name: 'new', categoryId: 'cat1', audienceType: 'c', coverMediaId: 'new-image' });
  const product = calls.pop();
  assert.equal(product.action, 'admin.products.upsert');
  assert.equal(product.payload.id, 'p1');
  assert.equal(product.payload.name, 'new');
  assert.equal(product.payload.brand, 'brand');
  assert.equal(product.payload.description, 'keep');
  assert.equal(product.payload.shelfLifeDays, 365);
  assert.equal(product.payload.coverMediaId, 'new-image');
  await data.saveSku('p1', { _id: 's1', skuCode: 'old-sku', status: 'off_sale', weightUnit: 'kg', piecesPerCase: 8, mediaIds: ['m1'], barcode: 'code' }, { specName: '1kg', netWeight: '1', packageUnit: '包' });
  const sku = calls.pop();
  assert.equal(sku.action, 'admin.skus.upsert');
  assert.equal(sku.payload.status, 'off_sale', '编辑不能使原下架 SKU 自动上架');
  assert.equal(sku.payload.skuCode, 'old-sku');
  assert.equal(sku.payload.piecesPerCase, 8);
  assert.deepEqual(sku.payload.mediaIds, ['m1']);
  await data.saveSku('p1', null, { specName: '新规格', packageUnit: '包' });
  assert.equal(calls.pop().payload.status, 'draft', '新规格必须先建草稿，不能自动销售');
  await data.savePublicPrice([
    { _id: 'mini', skuId: 's1', scopeType: 'public', channel: 'miniapp', amountCent: 100, status: 'active' },
    { _id: 'web', skuId: 's1', scopeType: 'public', channel: 'web', amountCent: 200, status: 'active' }
  ], 's1', 350);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].payload.channel, 'all');
  assert.equal(calls[0].payload.amountCent, 350);
  assert.equal(calls[1].payload.status, 'disabled');
  assert.equal(calls[2].payload.status, 'disabled');
  calls.length = 0;
  await data.saveProduct(null, { name: 'new', categoryId: 'cat1', audienceType: 'all' });
  assert.equal(calls[0].payload.status, 'draft', '新商品必须先建草稿');
  assert.equal(calls[0].payload.id, undefined);
  console.log('product data preservation and pricing contract: passed');
}
test().catch((error) => { console.error(error); process.exitCode = 1; });
