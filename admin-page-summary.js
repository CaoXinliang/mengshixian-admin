(function attachAdminPageSummary(global, document) {
  const count = (rows, predicate) => (rows || []).filter(predicate).length;
  const all = (rows) => (rows || []).length;
  const definitions = {
    products: (s) => [['已上架商品', count(s.products, (x) => x.status === 'on_sale')], ['未上架商品', count(s.products, (x) => x.status !== 'on_sale')], ['销售规格', all(s.skus)]],
    categories: (s) => [['分类记录', all(s.categories)], ['已启用', count(s.categories, (x) => x.status === 'enabled')], ['未启用', count(s.categories, (x) => x.status !== 'enabled')]],
    imports: (s) => [['导入记录', all(s.imports)], ['待审核', count(s.imports, (x) => ['staged', 'reviewing', 'approved'].includes(x.status))], ['已入库', count(s.imports, (x) => x.status === 'imported')]],
    pricing: (s) => [['价格规则', all(s.prices)], ['生效中', count(s.prices, (x) => x.status === 'active')], ['未生效', count(s.prices, (x) => x.status !== 'active')]],
    orders: (s) => [['待确认', count(s.orders, (x) => x.status === 'pending_confirmation')], ['拣货中', count(s.orders, (x) => x.status === 'picking')], ['配送中', count(s.orders, (x) => x.status === 'shipping')], ['已送达', count(s.orders, (x) => x.status === 'delivered')]],
    refunds: (s) => [['售后申请', all(s.refunds)], ['待审核', count(s.refunds, (x) => x.status === 'requested')], ['处理中', count(s.refunds, (x) => ['reviewing', 'processing'].includes(x.status))]],
    warehouses: (s) => [['仓库记录', all(s.warehouses)], ['已启用', count(s.warehouses, (x) => x.status === 'active')]],
    areas: (s) => [['配送区域', all(s.deliveryAreas)], ['已启用', count(s.deliveryAreas, (x) => x.status === 'active')]],
    freight: (s) => [['运费规则', all(s.freightRules)], ['生效中', count(s.freightRules, (x) => x.status === 'active')]],
    inventory: (s) => [['库存记录', all(s.inventory)], ['存在预占', count(s.inventory, (x) => Number(x.reserved) > 0)], ['可售为零', count(s.inventory, (x) => Number(x.available) <= 0)]],
    slots: (s) => [['配送时段', all(s.deliverySlots)], ['生效中', count(s.deliverySlots, (x) => x.status === 'active')]],
    businesses: (s) => [['企业申请', all(s.businessApplications)], ['待审核', count(s.businessApplications, (x) => x.status === 'pending')], ['已通过', count(s.businessApplications, (x) => x.status === 'approved')]],
    users: (s) => [['用户记录', all(s.users)], ['企业客户', count(s.users, (x) => x.userType === 'b')], ['个人客户', count(s.users, (x) => (x.userType || 'c') === 'c')]],
    banners: (s) => [['轮播记录', all(s.banners)], ['已启用', count(s.banners, (x) => x.enabled !== false)]],
    sections: (s) => [['首页模块', all(s.sections)], ['已启用', count(s.sections, (x) => x.enabled !== false)]],
    media: (s) => [['素材记录', all(s.media)], ['临时素材', count(s.media, (x) => x.temporary === true)], ['图片', count(s.media, (x) => x.type === 'image')], ['视频', count(s.media, (x) => x.type === 'video')]],
    groups: (s) => [['拼团活动', all(s.groupCampaigns)], ['生效中', count(s.groupCampaigns, (x) => x.status === 'active')]],
    audit: (s) => [['操作记录', all(s.audit)]]
  };

  function render(pageName, state) {
    const build = definitions[pageName];
    const intro = document.querySelector('.page-intro');
    if (!build || !intro) return;
    let root = document.getElementById('pageSummary');
    if (!root) {
      root = document.createElement('section');
      root.id = 'pageSummary';
      root.className = 'page-summary';
      root.setAttribute('aria-label', '当前业务数据摘要');
      intro.insertAdjacentElement('afterend', root);
    }
    root.innerHTML = build(state).map(([label, value]) => `<div class="page-summary-item"><span>${label}</span><strong>${value}</strong></div>`).join('');
  }

  global.MengshixianAdminPageSummary = Object.freeze({ render });
}(window, document));
