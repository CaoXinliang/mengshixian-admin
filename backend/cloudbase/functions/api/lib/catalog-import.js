const { sha256 } = require('./security');
const { fail } = require('./response');
const { collectPageMatches } = require('./collection-read');

function code(value, label) {
  const normalized = String(value == null ? '' : value).trim().toUpperCase();
  if (!normalized) fail('CATALOG_CODE_REQUIRED', `${label}不能为空。`);
  if (!/^[A-Z0-9._-]{1,60}$/.test(normalized)) fail('CATALOG_CODE_INVALID', `${label}只能使用英文字母、数字、点、横线或下划线，最多 60 字。`);
  return normalized;
}
function documentId(prefix, value) { return `${prefix}_${sha256(value).slice(0, 40)}`; }
async function uniqueByCode(store, collection, field, value) {
  const rows = await collectPageMatches(store, collection, { where: { [field]: value } }, () => true, { isComplete: (found) => found.length > 1 });
  if (rows.length > 1) fail('CATALOG_CODE_DUPLICATE', `${value} 已关联多条记录，请先处理编码冲突。`);
  return rows[0] || null;
}
function createCatalogImport({ store, clock, audit }) {
  async function inspectRow(row) {
    const parsed = row && row.parsed || {};
    const line = Number(row && row.sourceRowNo) || 0;
    const issues = [];
    let productCode = '', skuCode = '';
    try { productCode = code(parsed.productCode, '商品编码'); } catch (error) { issues.push(error.message); }
    try { skuCode = code(parsed.skuCode, '规格编码'); } catch (error) { issues.push(error.message); }
    const name = String(parsed.name || '').trim();
    const categoryName = String(parsed.categoryName || '').trim();
    const specName = String(parsed.specName || '').trim();
    const packageUnit = String(parsed.packageUnit || '').trim();
    if (!name) issues.push('商品名称不能为空。');
    if (!categoryName) issues.push('分类不能为空。');
    if (name.length > 100 || categoryName.length > 30 || specName.length > 100 || packageUnit.length > 100) issues.push('名称、分类或规格过长。');
    if (issues.length) return { line, productCode, skuCode, status: 'invalid', issues };
    try {
      const product = await uniqueByCode(store, 'products', 'spuCode', productCode);
      const sku = await uniqueByCode(store, 'product_skus', 'skuCode', skuCode);
      const job = await uniqueByCode(store, 'import_jobs', 'sourceKey', `code:${skuCode}`);
      if (product && (product.name !== name || product.categoryName !== categoryName)) issues.push('商品编码已存在，但名称或分类不同；请先核对原商品，不能按名称自动覆盖。');
      if (sku && (!product || sku.productId !== product._id)) issues.push('规格编码已属于其他商品编码。');
      if (job && job.parsedPayload && job.parsedPayload.productCode !== productCode) issues.push('规格编码已在其他商品编码的导入草稿中使用。');
      const warnings = [];
      if (!specName) warnings.push('规格名称待补齐');
      if (!packageUnit) warnings.push('包装单位待补齐');
      if (!sku) warnings.push('价格待补齐');
      if (!product || !product.coverMediaId) warnings.push('主图待补齐');
      return { line, productCode, skuCode, status: issues.length ? 'invalid' : job ? 'already_staged' : 'ready', issues, warnings,
        mapping: { product: product ? '关联现有商品' : '新建商品草稿', sku: sku ? '关联现有规格' : '新建规格草稿' } };
    } catch (error) { return { line, productCode, skuCode, status: 'invalid', issues: [error.message] }; }
  }
  async function preview(rows) {
    if (!Array.isArray(rows) || !rows.length || rows.length > 50) fail('VALIDATION_ERROR', '每批只能核对 1 到 50 行。');
    const seen = new Map(), products = new Map(), results = [];
    for (const row of rows) {
      const result = await inspectRow(row);
      if (result.skuCode) {
        if (seen.has(result.skuCode)) { result.status = 'invalid'; result.issues.push(`规格编码与第 ${seen.get(result.skuCode)} 行重复。`); }
        else seen.set(result.skuCode, result.line);
      }
      const parsed = row.parsed || {};
      const previous = products.get(result.productCode);
      if (previous && (previous.name !== String(parsed.name || '').trim() || previous.categoryName !== String(parsed.categoryName || '').trim())) {
        result.status = 'invalid'; result.issues.push(`商品编码与第 ${previous.line} 行对应的名称或分类不一致。`);
      } else if (result.productCode && !previous) products.set(result.productCode, { line: result.line, name: String(parsed.name || '').trim(), categoryName: String(parsed.categoryName || '').trim() });
      results.push(result);
    }
    return { rows: results };
  }
  async function stage(admin, payload) {
    const checked = await preview(payload.rows);
    const staged = [];
    for (let i = 0; i < payload.rows.length; i += 1) {
      const result = checked.rows[i];
      const row = payload.rows[i];
      if (result.status === 'invalid') { staged.push({ ...result, status: 'invalid' }); continue; }
      if (result.status === 'already_staged') { staged.push({ ...result, status: 'already_staged' }); continue; }
      const parsed = row.parsed;
      const timestamp = clock().toISOString();
      const sourceKey = `code:${result.skuCode}`;
      const id = documentId('import', sourceKey);
      let created = false;
      await store.runTransaction(async (tx) => {
        if (await tx.getById('import_jobs', id)) return;
        await tx.set('import_jobs', id, {
          sourceKey, sourceFile: String(payload.sourceFile || '').slice(0, 120), sourceRowNo: result.line,
          rawPayload: row.source || {}, parsedPayload: { productCode: result.productCode, skuCode: result.skuCode,
            name: String(parsed.name).trim(), categoryName: String(parsed.categoryName).trim(),
            specName: String(parsed.specName || '').trim(), packageUnit: String(parsed.packageUnit || '').trim(), price: null, mediaIds: [] },
          mappingWarnings: result.warnings, status: 'staged', createdBy: admin._id, createdAt: timestamp, updatedAt: timestamp
        });
        created = true;
      });
      staged.push({ ...result, id, sourceKey, status: created ? 'staged' : 'already_staged' });
    }
    await audit(admin, 'imports.stage', 'import_job', '', { count: staged.filter((item) => item.status === 'staged').length });
    return { staged };
  }
  async function approve(admin, id) {
    const job = await store.findOne('import_jobs', { _id: id });
    if (!job) fail('IMPORT_NOT_FOUND', '导入草稿不存在。');
    if (job.status === 'imported') return { importId: id, productId: job.productId, skuId: job.skuId, alreadyImported: true };
    if (!['staged', 'reviewing', 'approved'].includes(job.status)) fail('IMPORT_NOT_APPROVABLE', '当前导入草稿不能生成商品草稿。');
    const source = job.parsedPayload || {};
    const checked = await inspectRow({ parsed: source, sourceRowNo: job.sourceRowNo });
    if (checked.status === 'invalid') fail('IMPORT_MAPPING_INVALID', `第 ${job.sourceRowNo} 行：${checked.issues.join('；')}`);
    const timestamp = clock().toISOString();
    const categories = await collectPageMatches(store, 'categories', { where: { name: source.categoryName } }, () => true, { isComplete: (found) => found.length > 1 });
    if (categories.length > 1) fail('CATEGORY_AMBIGUOUS', '同名分类有多条，不能自动关联；请先整理分类。');
    let category = categories[0];
    if (!category) category = await store.create('categories', { name: source.categoryName, parentId: '', sort: 0, status: 'draft', createdAt: timestamp, updatedAt: timestamp });
    let product = await uniqueByCode(store, 'products', 'spuCode', checked.productCode);
    if (!product) {
      const productId = documentId('spu', checked.productCode);
      await store.runTransaction(async (tx) => {
        if (await tx.getById('products', productId)) return;
        await tx.set('products', productId, { spuCode: checked.productCode, name: source.name, subtitle: '', categoryId: category._id,
          categoryName: category.name, brand: '', origin: '', storageType: 'frozen', frozenTemperature: '-18℃', shelfLifeDays: 0,
          description: '', coverMediaId: '', sort: 0, status: 'draft', sourceImportId: id, createdAt: timestamp, updatedAt: timestamp });
      });
      product = await store.findOne('products', { _id: productId });
    }
    if (product.spuCode !== checked.productCode || product.name !== source.name || product.categoryName !== source.categoryName) fail('IMPORT_MAPPING_INVALID', '商品编码现有资料与导入行不一致，请人工核对。');
    let sku = await uniqueByCode(store, 'product_skus', 'skuCode', checked.skuCode);
    if (!sku) {
      const skuId = documentId('sku', checked.skuCode);
      await store.runTransaction(async (tx) => {
        if (await tx.getById('product_skus', skuId)) return;
        await tx.set('product_skus', skuId, { productId: product._id, skuCode: checked.skuCode, specName: source.specName || source.packageUnit || '待补规格',
          netWeight: '', weightUnit: '', piecesPerCase: 0, packageUnit: source.packageUnit || '', barcode: '', mediaIds: [],
          sort: 0, status: 'draft', sourceImportId: id, createdAt: timestamp, updatedAt: timestamp });
      });
      sku = await store.findOne('product_skus', { _id: skuId });
    }
    if (sku.productId !== product._id || sku.skuCode !== checked.skuCode) fail('IMPORT_MAPPING_INVALID', '规格编码已关联其他商品，不能重复建立。');
    await store.update('import_jobs', id, { status: 'imported', productId: product._id, skuId: sku._id, reviewedBy: admin._id, reviewedAt: timestamp, updatedAt: timestamp });
    await audit(admin, 'imports.approve', 'import_job', id, { productCode: checked.productCode, skuCode: checked.skuCode, productId: product._id, skuId: sku._id });
    return { importId: id, productId: product._id, skuId: sku._id, alreadyImported: false };
  }
  return { code, preview, stage, approve, uniqueByCode };
}
module.exports = { code, documentId, uniqueByCode, createCatalogImport };
