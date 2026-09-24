const { audienceVisible } = require('./commerce');
const { fail } = require('./response');

async function contentTargetAvailable(store, item, viewerType) {
  if (!['product', 'category'].includes(item.jumpType)) return true;
  const product = item.jumpType === 'product';
  const target = await store.findOne(product ? 'products' : 'categories', { _id: item.jumpTarget });
  if (!target || target.status !== (product ? 'on_sale' : 'enabled')) return false;
  return !product || !viewerType || audienceVisible(target.audienceType, viewerType);
}

async function requireContentTarget(store, item) {
  if (!['product', 'category'].includes(item.jumpType)) return;
  const target = await store.findOne(item.jumpType === 'product' ? 'products' : 'categories', { _id: item.jumpTarget });
  if (!target) fail('CONTENT_TARGET_NOT_FOUND', '跳转目标不存在，请按名称重新选择。');
  if (item.enabled && !await contentTargetAvailable(store, item)) {
    fail('CONTENT_TARGET_UNAVAILABLE', '跳转商品尚未上架或分类未启用，请先完成目标资料，或取消启用以保存草稿。');
  }
}

module.exports = { contentTargetAvailable, requireContentTarget };
