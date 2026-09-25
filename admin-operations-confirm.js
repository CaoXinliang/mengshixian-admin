(function attachOperationsConfirm(global) {
  'use strict';
  const money = (cents) => `¥${(Number(cents || 0) / 100).toFixed(2)}`;
  const orderNext = { picking: '开始拣货', shipping: '标记发货', delivered: '标记送达' };

  function describe(type, record, extra = {}) {
    if (!record) return '';
    if (type === 'importApprove') {
      const item = record.parsedPayload || {};
      return `请核对导入记录：\n商品：${item.name || '未命名商品'}\n分类：${item.categoryName || '未填写'}\n规格：${item.specName || '待补'}\n\n确认生成商品草稿？这一步仍不会上架；图片、价格和规格还需要逐项核对。`;
    }
    if (type === 'productPublish') {
      return `确认上架商品「${record.name || '未命名商品'}」？\n上架后，符合分类、价格、规格和客户范围的顾客可能立即看到。`;
    }
    if (type === 'businessApprove' || type === 'businessReject') {
      const decision = type === 'businessApprove' ? '通过' : '驳回';
      const businessType = { restaurant: '餐饮', retail: '零售' }[record.mainBusinessType] || '待核对';
      return `请再次核对企业申请：\n${record.companyName || '未命名企业'}\n门店：${record.storeName || '未填写'}\n地址：${record.storeAddress || '未填写'}\n主营：${businessType}\n统一社会信用代码：${record.unifiedCode || '未填写'}\n联系人：${record.contactName || '未填写'} ${record.contactPhoneMasked || ''}\n\n确认${decision}？${type === 'businessApprove' ? '通过后该客户将成为企业客户；请确认门头照片与营业执照的实际内容已核对。' : '驳回后该申请将结束。'}`;
    }
    if (type === 'refundApprove' || type === 'refundReject') {
      const decision = type === 'refundApprove' ? '通过' : '驳回';
      return `请核对售后申请：\n编号：${record.refundNo || '未编号'}\n金额：${money(record.amountCent)}\n原因：${record.reason || '未填写'}\n\n确认${decision}？${type === 'refundApprove' ? '审核通过不等于退款已经到账，仍需等待退款渠道确认。' : '驳回后本次申请将结束。'}`;
    }
    if (type === 'orderTransition') {
      const next = orderNext[extra.status];
      if (!next) return '';
      const warning = extra.status === 'shipping' ? '请先确认货物已实际交运。' : extra.status === 'delivered' ? '请先确认货物已实际送达。' : '请先核对订单。';
      return `请核对订单：\n订单号：${record.orderNo || record._id}\n收货人：${record.addressSnapshot?.name || '未填写'}\n金额：${money(record.totalAmountCent)}\n\n${warning}\n确认${next}？`;
    }
    if (type === 'contentEnable') {
      return `确认启用「${record.title || '未命名'}」？\n${record.impact || '启用后顾客可能立即看到。'}`;
    }
    if (type === 'skuPublish' || type === 'skuOffsale') {
      const action = type === 'skuPublish' ? '上架' : '下架';
      return `确认${action}规格「${record.specName || '未命名规格'}」？\n${type === 'skuPublish' ? '服务端将重新执行完整上架核对（价格、库存、配送、图片等）；缺项时会被拒绝并提示补齐。核对通过且商品已上架后，顾客可能立即看到此规格。' : '下架后顾客将不能购买此规格。'}`;
    }
    return '';
  }
  function ask(type, record, extra, confirmFn = global.confirm) {
    const message = describe(type, record, extra);
    return Boolean(message && confirmFn(message));
  }
  const exported = Object.freeze({ describe, ask });
  global.MengshixianAdminOperationsConfirm = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
}(typeof window !== 'undefined' ? window : globalThis));
