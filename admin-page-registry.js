(function registerAdminPages(global) {
  const groups = [
    { id: 'overview', label: '工作台', pages: [['overview', '工作台', 'index.html']] },
    { id: 'catalog', label: '商品中心', pages: [['products', '商品管理', 'products.html'], ['productWorkflow', '商品编辑', 'product-workflow.html'], ['productReview', '核对发布', 'product-review.html'], ['categories', '分类管理', 'categories.html'], ['imports', '商品导入', 'imports.html'], ['pricing', '价格规则', 'pricing.html']] },
    { id: 'trade', label: '订单中心', pages: [['orders', '订单履约', 'orders.html'], ['refunds', '退款售后', 'refunds.html']] },
    { id: 'fulfillment', label: '库存配送', pages: [['inventory', '库存管理', 'inventory.html'], ['warehouses', '仓库管理', 'warehouses.html'], ['areas', '配送区域', 'areas.html'], ['freight', '运费规则', 'freight.html'], ['slots', '配送时段', 'slots.html']] },
    { id: 'customers', label: '客户中心', pages: [['businesses', '企业审核', 'businesses.html'], ['users', '用户列表', 'users.html']] },
    { id: 'content', label: '内容运营', pages: [['banners', '轮播图', 'banners.html'], ['sections', '首页模块', 'sections.html'], ['media', '素材库', 'media.html']] },
    { id: 'marketing', label: '营销中心', pages: [['groups', '拼团活动', 'groups.html']] },
    { id: 'system', label: '系统管理', pages: [['access', '账号与权限', 'access.html'], ['audit', '操作记录', 'audit.html']] }
  ];

  const pages = Object.fromEntries(groups.flatMap((group) => group.pages.map(([id, title, href]) => [id, { id, title, href, groupId: group.id, groupLabel: group.label }])));
  const descriptions = {
    products: '维护商品资料、销售规格与商品媒体，发布前核对信息完整性。',
    productWorkflow: '按步骤编辑商品资料、图片、规格与价格，核对后再上架。',
    productReview: '按商品编码核对分类、规格、价格、素材，资料齐全后逐件确认发布。',
    categories: '维护分类、展示顺序和启用状态。',
    imports: '查看商品导入草稿，逐条审核后再入库。',
    pricing: '按商品规格与适用对象维护价格，最终报价由服务端裁决。',
    orders: '按状态处理订单，跟进拣货、发货和送达。',
    refunds: '审核售后申请并核对退款状态。',
    inventory: '按仓库和规格查看库存，并记录受控调整。',
    warehouses: '维护仓库资料和启用状态。',
    areas: '维护配送服务区域和仓库适用范围。',
    freight: '维护配送区域的运费规则与免运门槛。',
    slots: '维护可选配送时段与服务范围。',
    businesses: '审核企业申请，核对企业信息与联系人。',
    users: '查看客户身份与企业归属，受控调整价格身份。',
    banners: '维护首页轮播内容、素材与跳转目标。',
    sections: '维护首页内容模块和发布顺序。',
    media: '登记素材、查看来源与版本，替换时保留历史。',
    groups: '维护拼团活动和适用商品。',
    access: '管理后台账号与角色权限。',
    audit: '按操作记录追溯后台变更。'
  };
  Object.values(pages).forEach((page) => { page.description = descriptions[page.id] || ''; });
  global.MengshixianAdminPages = Object.freeze({ groups, pages });
}(window));
