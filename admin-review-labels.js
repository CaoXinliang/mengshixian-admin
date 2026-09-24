(function (root, factory) {
  const labels = factory();
  if (typeof module === 'object' && module.exports) module.exports = labels;
  if (root) root.MengshixianReviewLabels = labels;
}(typeof window !== 'undefined' ? window : null, function () {
  function priceLabel(price) {
    const types = { public: '公开价格', user: '指定客户专属价格', organization: '指定企业专属价格', level: '指定等级价格' };
    const scope = price.scopeType === 'customer_type'
      ? ({ c: '个人顾客价格', b: '企业顾客价格' }[price.scopeId] || '顾客类型待核实')
      : types[price.scopeType] || '价格适用范围待核实';
    const channel = { all: '小程序和网页', miniapp: '仅小程序', web: '仅网页' }[price.channel || 'all'] || '适用端待核实';
    const amount = Number.isSafeInteger(price.amountCent) && price.amountCent > 0 ? `¥${(price.amountCent / 100).toFixed(2)}` : '金额待核实';
    return `${amount}（${scope} · ${channel}）`;
  }
  return { priceLabel };
}));
