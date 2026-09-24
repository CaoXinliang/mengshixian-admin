const { sha256 } = require('./security');
const { fail } = require('./response');
const { collectPageMatches } = require('./collection-read');
const { reviewStock } = require('./catalog-stock-review');
const { reviewDelivery } = require('./catalog-delivery-review');
const { captureReviewDependencies } = require('./review-dependencies');

const { currentPrice, personalMiniappPrice } = require('./catalog-price-coverage');
function createCatalogReview({ store, clock, audit }) {
  const defaultStore = store;
  async function read(productId, store = defaultStore) {
    const product = await store.findOne('products', { _id: productId });
    if (!product) fail('PRODUCT_NOT_FOUND', '商品不存在。');
    const category = await store.findOne('categories', { _id: product.categoryId });
    const skus = await collectPageMatches(store, 'product_skus', { where: { productId } }, () => true);
    const associations = await collectPageMatches(store, 'product_media', { where: { productId, enabled: true } }, () => true);
    const cover = product.coverMediaId ? await store.findOne('media_assets', { _id: product.coverMediaId }) : null;
    const videoAssociations = associations.filter((item) => item.mediaType === 'video');
    const videos = [];
    const detailImages = [];
    for (const association of videoAssociations) {
      const asset = await store.findOne('media_assets', { _id: association.mediaAssetId });
      if (asset) videos.push({ association, asset });
    }
    for (const association of associations.filter((item) => item.mediaType === 'image' && item.role !== 'cover')) {
      const asset = await store.findOne('media_assets', { _id: association.mediaAssetId });
      if (asset) detailImages.push({ association, asset });
    }
    const prices = [];
    for (const sku of skus) prices.push(...await collectPageMatches(store, 'prices', { where: { skuId: sku._id } }, () => true));
    const issues = [];
    const stock = await reviewStock(store, skus);
    issues.push(...stock.issues);
    const delivery = await reviewDelivery(store, stock.rows, product.audienceType, clock());
    issues.push(...delivery.issues);
    if (!product.spuCode) issues.push('缺少商品编码');
    if (!product.name) issues.push('缺少商品名称');
    if (!category || category.status !== 'enabled') issues.push('分类尚未启用');
    if (!cover || cover.type !== 'image' || cover.enabled === false || !cover.fileId) issues.push('缺少可用的真实主图');
    if (!skus.length) issues.push('缺少销售规格');
    for (const sku of skus) {
      if (sku.status === 'off_sale') continue;
      const label = sku.specName || sku.skuCode || '未命名规格';
      if (!sku.skuCode) issues.push(`规格「${label}」缺少规格编码`);
      if (!sku.specName || sku.specName === '待补规格') issues.push(`规格「${label}」缺少规格名称`);
      if (!sku.packageUnit) issues.push(`规格「${label}」缺少包装单位`);
      if (!prices.some((rule) => rule.skuId === sku._id && currentPrice(rule, clock()))) issues.push(`规格「${label}」缺少当前生效价格`);
      if (product.audienceType !== 'b' && !prices.some((rule) => rule.skuId === sku._id && personalMiniappPrice(rule, clock()))) issues.push(`规格「${label}」缺少面向个人顾客的小程序价格，请设置公开价或个人顾客价格`);
    }
    const activeSkus = skus.filter((sku) => sku.status !== 'off_sale');
    if (!activeSkus.length) issues.push('没有计划销售的规格');
    const skuRows = skus.map((sku) => ({ id: sku._id, skuCode: sku.skuCode || '', specName: sku.specName || '', packageUnit: sku.packageUnit || '', status: sku.status, updatedAt: sku.updatedAt,
      personalPriceReady: prices.some((rule) => rule.skuId === sku._id && personalMiniappPrice(rule, clock())),
      prices: prices.filter((rule) => rule.skuId === sku._id && currentPrice(rule, clock())).map((rule) => ({ amountCent: rule.amountCent, scopeType: rule.scopeType, scopeId: rule.scopeId, channel: rule.channel || 'all' })) }));
    const fingerprint = sha256(JSON.stringify({ product: [product._id, product.spuCode, product.name, product.categoryId, product.coverMediaId, product.status, product.audienceType, product.updatedAt],
      stock: stock.rows,
      delivery: delivery.rows,
      category: category && [category._id, category.status, category.updatedAt], cover: cover && [cover._id, cover.type, cover.enabled, cover.fileId, cover.updatedAt],
      skus: skus.map((item) => [item._id, item.skuCode, item.specName, item.packageUnit, item.status, item.updatedAt]),
      prices: prices.map((item) => [item._id, item.amountCent, item.scopeType, item.scopeId, item.channel, item.status, item.validFrom, item.validTo, item.updatedAt]),
      videos: videos.map(({ association, asset }) => [association._id, association.skuId, association.role, association.sort, association.updatedAt, asset._id, asset.fileId, asset.version, asset.enabled, asset.updatedAt]),
      detailImages: detailImages.map(({ association, asset }) => [association._id, association.skuId, association.role, association.sort, association.updatedAt, asset._id, asset.fileId, asset.version, asset.enabled, asset.updatedAt]) }));
    return { product: { id: product._id, productCode: product.spuCode || '', name: product.name, audienceType: product.audienceType || 'all', status: product.status, updatedAt: product.updatedAt },
      category: category && { name: category.name, status: category.status }, skus: skuRows,
      cover: cover && { name: cover.name, fileId: cover.fileId, enabled: cover.enabled },
      detailImages: detailImages.map(({ association, asset }) => ({ name: asset.name, fileId: asset.fileId, skuCode: skuRows.find((row) => row.id === association.skuId)?.skuCode || '', enabled: asset.enabled })),
      videos: videos.map(({ association, asset }) => ({ name: asset.name, fileId: asset.fileId, skuCode: skuRows.find((row) => row.id === association.skuId)?.skuCode || '', enabled: asset.enabled })),
      stock: stock.rows, delivery: delivery.rows, issues, ready: issues.length === 0, reviewToken: fingerprint };
  }
  async function publish(admin, productId, reviewToken) {
    const dependencies = captureReviewDependencies(store);
    const reviewed = await read(productId, dependencies.store);
    if (reviewed.reviewToken !== reviewToken) fail('CATALOG_REVIEW_STALE', '商品资料已变化，请重新核对后再发布。');
    if (!reviewed.ready) fail('PRODUCT_NOT_READY', `请先补齐：${reviewed.issues.join('；')}`);
    const timestamp = clock().toISOString();
    await store.runTransaction(async (tx) => {
      await dependencies.verify(tx);
      const current = await tx.getById('products', productId);
      if (!current || current.status !== reviewed.product.status || current.updatedAt !== reviewed.product.updatedAt) fail('CATALOG_REVIEW_STALE', '商品已变化，请重新核对。');
      for (const sku of reviewed.skus) {
        const actual = await tx.getById('product_skus', sku.id);
        if (!actual || actual.productId !== productId || actual.status !== sku.status
          || actual.updatedAt !== sku.updatedAt || (actual.skuCode || '') !== sku.skuCode
          || (actual.specName || '') !== sku.specName || (actual.packageUnit || '') !== sku.packageUnit) {
          fail('CATALOG_REVIEW_STALE', '销售规格已变化，请重新核对后再发布。');
        }
      }
      for (const sku of reviewed.skus.filter((item) => item.status === 'draft')) await tx.update('product_skus', sku.id, { status: 'on_sale', updatedAt: timestamp });
      await tx.update('products', productId, { status: 'on_sale', updatedAt: timestamp });
    });
    await audit(admin, 'catalog.product.publish_reviewed', 'product', productId, { productCode: reviewed.product.productCode, skuCodes: reviewed.skus.filter((item) => item.status !== 'off_sale').map((item) => item.skuCode) });
    return { productId, productCode: reviewed.product.productCode, status: 'on_sale' };
  }
  return { read, publish };
}
module.exports = { createCatalogReview };
