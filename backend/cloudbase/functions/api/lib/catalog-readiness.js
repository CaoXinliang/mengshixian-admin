const { fail } = require('./response');
const { collectPageMatches } = require('./collection-read');

async function requireCurrentPrice(store, skuId, now) {
  const rules = await collectPageMatches(store, 'prices', { where: { skuId, status: 'active' } }, (rule) => {
    const from = rule.validFrom ? new Date(rule.validFrom).getTime() : -Infinity;
    const to = rule.validTo ? new Date(rule.validTo).getTime() : Infinity;
    return Number(rule.amountCent) > 0 && from <= now.getTime() && to >= now.getTime();
  }, { isComplete: (matched) => matched.length > 0 });
  if (!rules.length) fail('PRODUCT_NOT_READY', '请先为销售规格设置当前生效的真实价格。');
}

async function requireProductReady(store, product, now) {
  const category = await store.findOne('categories', { _id: product.categoryId, status: 'enabled' });
  if (!category) fail('PRODUCT_NOT_READY', '商品所属分类必须先启用。');
  if (!product.coverMediaId) fail('PRODUCT_NOT_READY', '请先为商品设置真实主图。');
  const cover = await store.findOne('media_assets', { _id: product.coverMediaId });
  if (!cover || cover.enabled === false || cover.type !== 'image') fail('PRODUCT_NOT_READY', '商品主图不可用，请重新选择图片。');
  const skus = await collectPageMatches(store, 'product_skus', { where: { productId: product._id, status: 'on_sale' } }, () => true);
  if (!skus.length) fail('PRODUCT_NOT_READY', '至少需要一个已启用销售的规格。');
  for (const sku of skus) await requireCurrentPrice(store, sku._id, now);
}

module.exports = { requireCurrentPrice, requireProductReady };
