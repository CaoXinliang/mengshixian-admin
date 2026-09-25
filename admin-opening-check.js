(function openingCheck(global, document) {
  'use strict';
  const status = document.getElementById('openingCheckStatus');
  const items = document.getElementById('openingCheckItems');
  const payment = document.getElementById('openingCheckPayment');
  if (!status || !items || !payment) return;

  const checks = [
    { title: '仓库', field: 'activeWarehouses', missing: '缺少启用的仓库', found: '已找到启用仓库，仍需核对地址与可配送范围', href: 'warehouses.html' },
    { title: '配送区域', field: 'activeDeliveryAreas', missing: '缺少启用的配送区域', found: '已找到配送区域，仍需核对具体区县和对应仓库', href: 'areas.html' },
    { title: '配送时段', field: 'activeDeliverySlots', missing: '缺少生效的配送时段', found: '已找到配送时段，仍需核对时间与区域是否匹配', href: 'slots.html' },
    { title: '运费规则', field: 'activeFreightRules', missing: '缺少生效的运费规则', found: '已找到运费规则，仍需核对顾客范围、区域和实际报价', href: 'freight.html' },
    { title: '库存', field: 'inventoryRecords', missing: '缺少库存记录', found: '已找到库存记录，仍需核对具体规格、仓库和真实可售数量', href: 'inventory.html' },
    { title: '商品价格', field: 'activePriceRules', missing: '缺少生效的商品价格', found: '已找到价格规则，仍需核对个人与企业顾客适用价格', href: 'pricing.html' }
  ];

  function renderRow(check, count) {
    const row = document.createElement('li');
    row.className = `opening-check-row${count ? '' : ' is-missing'}`;
    const title = document.createElement('strong');
    title.textContent = check.title;
    const detail = document.createElement('p');
    detail.textContent = count ? `${check.found}（${count} 条）` : check.missing;
    const link = document.createElement('a');
    link.href = check.href;
    link.textContent = count ? '去核对' : '去补齐';
    row.append(title, detail, link);
    return row;
  }

  async function load() {
    status.textContent = '正在读取开店条件；读取完成前不能判断是否已准备好。';
    items.replaceChildren();
    payment.textContent = '收款状态尚未核验。本后台没有可直接完成线上收款配置的入口；企业线下收款登记也不能代替实际到账核对。';
    try {
      const result = await global.MengshixianAdminApi.call('admin.readiness', {});
      const counts = result && result.counts;
      if (!counts || checks.some((check) => !Number.isSafeInteger(counts[check.field]) || counts[check.field] < 0)) throw new Error('检查数据不完整');
      let missing = 0;
      checks.forEach((check) => {
        if (!counts[check.field]) missing++;
        items.appendChild(renderRow(check, counts[check.field]));
      });
      status.textContent = missing
        ? `有 ${missing} 项缺少基础资料。其他项目只是“已找到记录”，仍需核对；此页不会启用店铺或证明顾客可以下单。`
        : '基础资料均有记录，但配送组合、顾客报价和真实收款尚须分别验证；此页不会启用店铺。';
    } catch (error) {
      items.replaceChildren();
      status.textContent = '开店检查暂不可用，请确认登录和连接后刷新重试；不能把读取失败当成已完成或没有配置。';
    }
  }

  document.getElementById('openingCheckReload')?.addEventListener('click', load);
  load();
}(window, document));
