const assert = require('node:assert/strict');
const { parseCsv, prepareTable, prepareJson } = require('../admin-import-parser.js');

const table = parseCsv('\uFEFF商品编码,规格编码,商品名称,分类,规格,包装单位\r\nP001,S001,"虾,仁",海鲜,"500\n克",1袋\r\nP001,S002,虾仁,海鲜,500克,1袋\r\n');
assert.equal(table[0].line, 1);
assert.deepEqual(table[1].cells, ['P001', 'S001', '虾,仁', '海鲜', '500\n克', '1袋']);
assert.equal(table[1].line, 2);
assert.equal(table[2].line, 4);
assert.throws(() => parseCsv('商品名称,分类\n"未闭合,海鲜'), /引号/);

const preview = prepareTable(parseCsv('商品编码,规格编码,商品名称,分类,规格,包装单位\nP001,S001,虾仁,海鲜,500克,1袋\nP001,S001,虾仁,海鲜,500克,1袋\nP002,,鱼丸,冻品,1千克,1袋\nP003,S003,鱼丸,冻品,,1袋'), 'table-abc', '商品表.csv');
assert.equal(preview.total, 4);
assert.equal(preview.ready.length, 2);
assert.equal(preview.duplicates.length, 1);
assert.equal(preview.invalid.length, 1);
assert.equal(preview.ready[0].sourceRowNo, 2);
assert.equal(preview.ready[0].source.id, 'row-2');
assert.equal(preview.ready[0].parsed.productCode, 'P001');
assert.equal(preview.ready[0].parsed.skuCode, 'S001');
assert.equal(preview.ready[0].source.fileName, '商品表.csv');
assert.deepEqual(preview.ready[1].mappingWarnings, ['缺少规格，保存后需补齐；不会自动上架。', '缺少价格，需在商品管理中补齐。', '缺少主图，需在商品管理中补齐。']);
assert.throws(() => prepareTable(parseCsv('商品名称,未知列\n虾仁,海鲜'), 'x', 'x.csv'), /分类/);

const legacy = prepareJson(JSON.stringify({ rows: [{ sourceRowNo: 8, source: { id: '8', name: '鱼丸', category: '冻品' }, parsed: { productCode: 'P008', skuCode: 'S008', name: '鱼丸', categoryName: '冻品' } }] }), 'old.json');
assert.equal(legacy.ready.length, 1);
assert.equal(legacy.sourceFile, 'old.json');
assert.equal(legacy.ready[0].sourceRowNo, 8);
assert.equal(prepareJson(JSON.stringify({ rows: [{ source: { id: '8', name: '鱼丸', category: '冻品' }, parsed: { name: '鱼丸', categoryName: '冻品' } }] }), 'old.json').invalid.length, 1, '旧文件若无编码只能报错，不能按名称生成商品');
const sameProduct = prepareTable(parseCsv('商品编码,规格编码,商品名称,分类,规格\nP100,S100,同一商品,冻品,大\nP100,S101,同一商品,冻品,小\nP100,S102,另一个名字,冻品,中'), 'x', 'x.csv');
assert.equal(sameProduct.ready.length, 2);
assert.match(sameProduct.invalid[0].issues[0], /名称或分类不一致/);
console.log('import parser: passed');
