const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');
const staging = require(path.join(projectRoot, 'backend', 'data', 'product-staging.json'));
const outputPath = path.join(projectRoot, 'backend', 'data', 'product-demo-50.json');

// These are deliberately not commercial prices. They produce a varied, stable
// demo catalogue until the client supplies a reviewed price sheet.
const categoryPlan = [
  ['海鲜水产', 12, 6990], ['蔬菜类', 2, 2590], ['其他冻品', 1, 3590],
  ['猪肉类', 5, 4590], ['面点类', 7, 2290], ['甜品类', 4, 2690],
  ['烧烤炸品', 1, 3290], ['牛肉类', 5, 5990], ['丸滑类', 1, 2890],
  ['调味酱料', 3, 1990], ['禽肉类', 6, 3990], ['预制菜熟食', 1, 3490],
  ['羊肉类', 1, 5690], ['耗材', 1, 1290]
];
const notes = 'AI 生成的演示价格与库存，须由甲方在后台审核替换；不得用于正式交易。';
const selected = [];
const multiSkuSourceIds = new Set([1, 4, 14, 24, 40, 48, 66, 105]);

function clean(value) {
  return String(value || '').replace(/\s+/g, '').replace(/克/gi, 'g').replace(/公斤/gi, 'kg');
}

function buildSkuPlan(row, amountCent, initialStock) {
  const packageUnit = clean(row.parsed.packageUnit || row.source.unit);
  const specName = clean(row.parsed.specName);
  const packMatch = packageUnit.match(/(?:1件[\/*]|件[\/*]?)(\d+)(包|盒|只|条|盅|卷)/i);
  const tailMatch = packageUnit.match(/(\d+(?:\.\d+)?(?:g|kg|斤)(?:左右)?)/i);
  const multiplyMatch = packageUnit.match(/(\d+(?:\.\d+)?(?:g|kg|斤))\*(\d+)/i);
  let retailLabel = specName || (tailMatch && tailMatch[1]) || '标准装';
  let caseLabel = packageUnit || '整件装';
  let unitsPerCase = 2;
  let retailUnit = '份';

  if (/称重/.test(packageUnit)) {
    retailLabel = '500g装';
    caseLabel = '1kg装';
    unitsPerCase = 2;
    retailUnit = '500g';
  } else if (packMatch) {
    unitsPerCase = Number(packMatch[1]);
    retailUnit = `1${packMatch[2]}`;
    retailLabel = tailMatch ? `${tailMatch[1]}/${packMatch[2]}` : retailUnit;
    caseLabel = `${unitsPerCase}${packMatch[2]}/件`;
  } else if (multiplyMatch) {
    retailLabel = `${multiplyMatch[1]}/包`;
    unitsPerCase = Number(multiplyMatch[2]);
    retailUnit = '1包';
    caseLabel = `${unitsPerCase}包/件`;
  } else if (/件/.test(packageUnit)) {
    retailLabel = specName || '单份装';
    caseLabel = packageUnit;
    retailUnit = '1份';
  } else {
    caseLabel = `${retailLabel}×2`;
  }

  return [
    { key: 'retail', specName: retailLabel, packageUnit: retailUnit, amountCent, initialStock, sort: 0 },
    { key: 'case', specName: caseLabel, packageUnit: '1件', amountCent: Math.max(amountCent + 100, Math.round(amountCent * unitsPerCase * 0.95)), initialStock: Math.max(12, Math.floor(initialStock / 2)), sort: 10 }
  ];
}

for (const [categoryName, count, basePriceCent] of categoryPlan) {
  const rows = staging.rows.filter((row) => row.parsed.categoryName === categoryName).slice(0, count);
  if (rows.length !== count) throw new Error(`${categoryName} cannot satisfy the demo selection.`);
  rows.forEach((row, index) => {
    const sourceId = Number(row.source.id);
    const amountCent = basePriceCent + ((sourceId * 37 + index * 113) % 1800);
    const initialStock = 30 + (sourceId % 41);
    const skus = multiSkuSourceIds.has(sourceId) ? buildSkuPlan(row, amountCent, initialStock) : [{
      key: 'default',
      specName: clean(row.parsed.specName || row.parsed.packageUnit || row.source.unit) || '标准装',
      packageUnit: clean(row.parsed.packageUnit || row.source.unit) || '1份',
      amountCent,
      initialStock,
      sort: 0
    }];
    selected.push({
      ...row,
      parsed: {
        ...row.parsed,
        source: 'ai_generated',
        temporary: true,
        demoNote: notes,
        demoPriceCent: amountCent,
        demoInitialStock: initialStock,
        demoSkus: skus
      },
      mappingWarnings: [...row.mappingWarnings, notes],
      demo: { source: 'ai_generated', temporary: true, priceCent: amountCent, initialStock, skus, note: notes }
    });
  });
}

if (selected.length !== 50 || new Set(selected.map((row) => row.source.id)).size !== 50) throw new Error('Demo fixture must contain 50 unique source products.');
if (selected.filter((row) => row.demo.skus.length > 1).length !== multiSkuSourceIds.size) throw new Error('Fixture multi-SKU coverage is incomplete.');

const fixture = {
  generatedAt: new Date().toISOString(),
  sourcePath: 'backend/data/product-staging.json',
  count: selected.length,
  source: 'ai_generated',
  temporary: true,
  status: 'demo_review_required',
  note: notes,
  rows: selected
};
fs.writeFileSync(outputPath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ outputPath, count: fixture.count, categories: categoryPlan.map(([name, count]) => ({ name, count })) }));
