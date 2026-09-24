(function attachProductPreview(global) {
  'use strict';
  function priceFor(prices, skuId, viewer) {
    const now = Date.now();
    return prices.filter((rule) => rule.skuId === skuId && rule.status === 'active')
      .filter((rule) => !rule.channel || rule.channel === 'all' || rule.channel === 'miniapp')
      .filter((rule) => !rule.validFrom || new Date(rule.validFrom).getTime() <= now)
      .filter((rule) => !rule.validTo || new Date(rule.validTo).getTime() >= now)
      .map((rule) => ({ rule, rank: rule.scopeType === 'customer_type' && rule.scopeId === viewer ? 200 : rule.scopeType === 'public' ? 100 : 0 }))
      .filter((entry) => entry.rank)
      .sort((left, right) => right.rank - left.rank || Number(right.rule.priority || 0) - Number(left.rule.priority || 0))[0]?.rule || null;
  }
  function summarize(snapshot, viewer) {
    const { product, categories, skus, prices } = snapshot;
    if (!product) return { visible: false, reason: '商品尚未创建', prices: [] };
    const category = categories.find((row) => row._id === product.categoryId);
    const activeSkus = skus.filter((row) => row.status === 'on_sale');
    const visible = product.status === 'on_sale' && category && category.status === 'enabled'
      && activeSkus.length > 0 && (!product.audienceType || product.audienceType === 'all' || product.audienceType === viewer);
    const reason = visible ? '按后台资料推算：可见' : product.status !== 'on_sale' ? '商品未上架'
      : !category || category.status !== 'enabled' ? '分类未启用'
        : !activeSkus.length ? '没有销售中的规格' : '不面向当前顾客类型';
    return { visible, reason, prices: activeSkus.map((sku) => ({ specName: sku.specName, rule: priceFor(prices, sku._id, viewer) })) };
  }
  function skuPriceReady(snapshot, skuId, now = Date.now()) {
    return snapshot.prices.some((rule) => rule.skuId === skuId && rule.status === 'active' && Number(rule.amountCent) > 0
      && (!rule.validFrom || new Date(rule.validFrom).getTime() <= now)
      && (!rule.validTo || new Date(rule.validTo).getTime() >= now));
  }
  function readiness(snapshot, now = Date.now()) {
    const { product, categories, skus, media } = snapshot;
    if (!product) return ['请先创建商品草稿。'];
    const issues = [];
    if (!categories.some((row) => row._id === product.categoryId && row.status === 'enabled')) issues.push('请先启用商品分类。');
    if (!media.some((row) => row._id === product.coverMediaId && row.type === 'image' && row.enabled !== false)) issues.push('请先保存真实主图。');
    const active = skus.filter((row) => row.status === 'on_sale');
    if (!active.length) issues.push('请先启用至少一个销售规格。');
    active.filter((row) => !skuPriceReady(snapshot, row._id, now)).forEach((row) => issues.push(`规格「${row.specName || '未命名'}」缺少当前生效的价格。`));
    return issues;
  }
  global.MengshixianProductPreview = Object.freeze({ summarize, priceFor, skuPriceReady, readiness });
  if (typeof module !== 'undefined' && module.exports) module.exports = { summarize, priceFor, skuPriceReady, readiness };
}(typeof window !== 'undefined' ? window : globalThis));
