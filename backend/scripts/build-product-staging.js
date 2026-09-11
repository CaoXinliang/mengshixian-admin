const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');
const sourcePath = path.join(projectRoot, 'wechat-miniprogram', 'miniapp', 'pages', 'index', 'index.js');
const outputPath = path.join(__dirname, '..', 'data', 'product-staging.json');
const source = fs.readFileSync(sourcePath, 'utf8');

function unquote(value) {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function parseRow(line, rowNo) {
  const match = line.match(/^\s*\{ id: (\d+), name: "((?:\\.|[^"\\])*)", category: "((?:\\.|[^"\\])*)", unit: "((?:\\.|[^"\\])*)"/);
  if (!match) return null;
  const unit = unquote(match[4]);
  const specMatch = unit.match(/品名规格：([^；]+)/);
  const packageUnit = unit.replace(/；?品名规格：[^；]+/, '').replace(/^；|；$/g, '').trim();
  return {
    sourceRowNo: rowNo,
    source: { id: Number(match[1]), name: unquote(match[2]), category: unquote(match[3]), unit },
    parsed: {
      name: unquote(match[2]),
      categoryName: unquote(match[3]),
      specName: specMatch ? specMatch[1].trim() : '',
      packageUnit,
      price: null,
      mediaIds: [],
      status: 'pending_review'
    },
    mappingWarnings: [
      '价格未提供，等待甲方确认',
      '商品图片未提供，等待后台上传真实素材',
      ...(specMatch ? [] : ['原始数据未发现“品名规格”字段，需人工确认规格'])
    ],
    status: 'staged'
  };
}

const rows = source.split(/\r?\n/).map((line, index) => parseRow(line, index + 1)).filter(Boolean);
if (!rows.length) throw new Error('未解析到商品记录');

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  sourcePath: 'wechat-miniprogram/miniapp/pages/index/index.js',
  count: rows.length,
  status: 'staged',
  rows
}, null, 2) + '\n');

console.log(JSON.stringify({ outputPath, count: rows.length }));
