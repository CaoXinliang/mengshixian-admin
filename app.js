(function adminConsole(global, document) {
  const api = global.MengshixianAdminApi;
  const PAGE_NAME = global.PAGE_NAME || 'overview';
  const PAGE_SIZE = 15;
  const PAGE_WINDOW = 5;

  // 页面 → eyebrow / panelTitle 映射
  const PAGE_META = {
    overview:   { eyebrow: '首页',     title: '今日经营概况' },
    products:   { eyebrow: '商品中心', title: '商品管理' },
    categories: { eyebrow: '商品中心', title: '分类管理' },
    imports:    { eyebrow: '商品中心', title: '商品批量导入' },
    pricing:    { eyebrow: '商品中心', title: '价格规则' },
    orders:     { eyebrow: '订单中心', title: '订单履约' },
    refunds:    { eyebrow: '订单中心', title: '退款售后' },
    warehouses: { eyebrow: '库存配送', title: '仓库管理' },
    areas:      { eyebrow: '库存配送', title: '配送区域' },
    freight:    { eyebrow: '库存配送', title: '运费规则' },
    inventory:  { eyebrow: '库存配送', title: '库存管理' },
    slots:      { eyebrow: '库存配送', title: '配送时段' },
    businesses: { eyebrow: '客户中心', title: '企业审核' },
    users:      { eyebrow: '客户中心', title: '用户列表' },
    banners:    { eyebrow: '内容运营', title: '轮播图' },
    sections:   { eyebrow: '内容运营', title: '首页模块' },
    media:      { eyebrow: '内容运营', title: '素材库' },
    groups:     { eyebrow: '营销中心', title: '拼团活动' },
    access:     { eyebrow: '系统管理', title: '账号与权限' },
    audit:      { eyebrow: '系统管理', title: '操作记录' }
  };

  // 页面 → 需要加载的数据 (stateKey → apiAction)
  const PAGE_LOADS = {
    overview: [
      ['imports', 'admin.imports.list'],
      ['categories', 'admin.categories.list'],
      ['products', 'admin.products.list'],
      ['skus', 'admin.skus.list'],
      ['orders', 'admin.orders.list'],
      ['refunds', 'admin.refunds.list'],
      ['businessApplications', 'admin.businessApplications.list']
    ],
    products: [
      ['products', 'admin.products.list'],
      ['skus', 'admin.skus.list'],
      ['productMedia', 'admin.productMedia.list'],
      ['categories', 'admin.categories.list'],
      ['media', 'admin.media.list']
    ],
    categories: [['categories', 'admin.categories.list']],
    imports:    [['imports', 'admin.imports.list']],
    pricing:    [['prices', 'admin.prices.list'], ['skus', 'admin.skus.list']],
    orders:     [['orders', 'admin.orders.list']],
    refunds:    [['refunds', 'admin.refunds.list']],
    warehouses: [['warehouses', 'admin.warehouses.list']],
    areas:      [['deliveryAreas', 'admin.deliveryAreas.list']],
    freight:    [
      ['freightRules', 'admin.freightRules.list'],
      ['deliveryAreas', 'admin.deliveryAreas.list'],
      ['warehouses', 'admin.warehouses.list']
    ],
    inventory: [
      ['inventory', 'admin.inventory.list'],
      ['warehouses', 'admin.warehouses.list'],
      ['skus', 'admin.skus.list']
    ],
    slots: [
      ['deliverySlots', 'admin.deliverySlots.list'],
      ['deliveryAreas', 'admin.deliveryAreas.list'],
      ['warehouses', 'admin.warehouses.list']
    ],
    businesses: [['businessApplications', 'admin.businessApplications.list']],
    users:      [['users', 'admin.users.list']],
    banners:    [['banners', 'admin.banners.list']],
    sections:   [['sections', 'admin.homeSections.list']],
    media:      [['media', 'admin.media.list']],
    groups:     [['groupCampaigns', 'admin.groupCampaigns.list'], ['skus', 'admin.skus.list']],
    access: [
      ['roles', 'admin.roles.list'],
      ['adminUsers', 'admin.adminUsers.list']
    ],
    audit: [['audit', 'admin.audit.list']]
  };

  const state = {
    admin: null, roles: [], adminUsers: [], categories: [], products: [], skus: [],
    users: [], businessApplications: [], prices: [], warehouses: [], inventory: [],
    deliveryAreas: [], freightRules: [], deliverySlots: [], orders: [], refunds: [],
    groupCampaigns: [], imports: [], media: [], productMedia: [], banners: [],
    sections: [], audit: [],
    pageMap: {}
  };

  const $ = (selector) => document.querySelector(selector);
  const escapeHtml = (value) => String(value === undefined || value === null ? '' : value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const formatDate = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
  const formatCents = (value) => `¥${(Number(value || 0) / 100).toFixed(2)}`;
  const splitLines = (value) => String(value || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const newIdempotencyKey = () => global.crypto && global.crypto.randomUUID ? global.crypto.randomUUID() : `admin-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  // ========== 状态中文映射 ==========
  const STATUS_MAP = {
    enabled: '启用', disabled: '停用', active: '生效', inactive: '未生效',
    draft: '草稿', pending: '待处理',
    on_sale: '上架', off_sale: '下架',
    pending_confirmation: '待确认', picking: '拣货中', shipping: '运输中',
    delivered: '已送达', cancelled: '已取消', completed: '已完成',
    requested: '申请中', reviewing: '审核中', processing: '处理中',
    refunded: '已退款', rejected: '已驳回',
    approved: '已通过',
    staged: '待审核', imported: '已入库',
    grouped: '已成团',
    unpaid: '未支付', paid: '已支付', refunded_payment: '已退款',
    all: '全部端', miniapp: '小程序', web: '网页端',
    public: '公开', customer_type: '客户类型', level: '会员等级',
    organization: '企业', user: '指定用户',
    client: '甲方提供', ai_generated: 'AI 生成', demo: '演示素材', admin_upload: '后台上传',
    image: '图片', video: '视频',
    cover: '封面', detail: '详情', video_cover: '视频封面', instruction: '说明',
    b: 'B 端', c: 'C 端',
    news: '活动头条', special: '特价专区', group: '拼团专场',
    none: '无跳转', product: '商品', category: '分类', url: '网页链接',
    rejected_apply: '已驳回',
    pay_success: '已支付', pay_pending: '待支付'
  };

  function translateStatus(status) {
    if (!status) return '—';
    const key = String(status).toLowerCase();
    return STATUS_MAP[key] || escapeHtml(status);
  }

  function getStatusClass(status) {
    if (!status) return '';
    const key = String(status).toLowerCase();
    if (['enabled', 'on_sale', 'paid', 'refunded', 'refunded_payment', 'grouped', 'delivered', 'imported', 'active', 'approved'].includes(key)) return 'live';
    if (['pending_confirmation', 'requested', 'pending', 'picking', 'shipping', 'reviewing', 'processing', 'draft', 'staged', 'inactive'].includes(key)) return 'warn';
    if (['rejected', 'rejected_apply', 'cancelled', 'off_sale', 'unpaid'].includes(key)) return 'danger';
    return '';
  }

  // ---------- 通用工具 ----------
  function message(text, error) {
    const target = $('#globalMessage');
    target.textContent = text || '';
    target.style.color = error ? '#c93c4d' : '#19713a';
  }
  function badge(status) {
    const cls = getStatusClass(status);
    return `<span class="badge ${cls}">${translateStatus(status)}</span>`;
  }

  function paginateRows(rows, rowCountFn, targetId, colSpan, pageKey) {
    const target = document.getElementById(targetId);
    if (!target) return;
    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    let page = state.pageMap[pageKey] || 1;
    if (page > pages) page = pages;
    if (page < 1) page = 1;
    state.pageMap[pageKey] = page;
    const start = (page - 1) * PAGE_SIZE;
    const sliced = rows.slice(start, start + PAGE_SIZE);

    let html = '';
    if (total === 0) {
      html = `<tr class="empty-row"><td colspan="${colSpan + 1}"><div class="empty-state"><div class="empty-icon">📭</div><div class="empty-text">暂无数据</div><div class="empty-hint">点击上方"新增"按钮开始添加</div></div></td></tr>`;
    } else {
      html = sliced.map((item, idx) => {
        const seq = start + idx + 1;
        return rowCountFn(item, seq);
      }).join('');
    }

    target.innerHTML = html;

    target.closest('.table-wrap')?.querySelector('.pagination')?.remove();
    if (total > PAGE_SIZE) {
      const pagination = buildPaginationHtml(page, pages, total, pageKey);
      target.closest('.table-wrap').insertAdjacentHTML('beforeend', pagination);
    }
  }

  function buildPaginationHtml(page, pages, total, pageKey) {
    const prev = page > 1 ? `<button data-page="${page - 1}" data-page-key="${pageKey}">上一页</button>` : `<button disabled>上一页</button>`;
    const next = page < pages ? `<button data-page="${page + 1}" data-page-key="${pageKey}">下一页</button>` : `<button disabled>下一页</button>`;
    let windowStart = Math.max(1, page - Math.floor(PAGE_WINDOW / 2));
    let windowEnd = Math.min(pages, windowStart + PAGE_WINDOW - 1);
    if (windowEnd - windowStart + 1 < PAGE_WINDOW) {
      windowStart = Math.max(1, windowEnd - PAGE_WINDOW + 1);
    }
    const pagesHtml = [];
    if (windowStart > 1) pagesHtml.push(`<button data-page="1" data-page-key="${pageKey}">1</button>`);
    if (windowStart > 2) pagesHtml.push(`<span>…</span>`);
    for (let p = windowStart; p <= windowEnd; p++) {
      pagesHtml.push(p === page
        ? `<button class="is-active" disabled>${p}</button>`
        : `<button data-page="${p}" data-page-key="${pageKey}">${p}</button>`);
    }
    if (windowEnd < pages - 1) pagesHtml.push(`<span>…</span>`);
    if (windowEnd < pages) pagesHtml.push(`<button data-page="${pages}" data-page-key="${pageKey}">${pages}</button>`);
    return `<div class="pagination" data-page-wrap="${pageKey}">
      <div class="page-info">共 ${total} 条，${pages} 页，当前第 ${page} 页</div>
      <div class="page-controls">${prev}${pagesHtml.join('')}${next}
        <div class="page-jump"><span>跳至</span><input type="number" min="1" max="${pages}" placeholder="页码" data-page-key="${pageKey}" aria-label="跳至页码"><span>页</span></div>
      </div>
    </div>`;
  }

  async function call(action, payload) {
    try { return await api.call(action, payload); }
    catch (error) {
      if (error.code === 'ADMIN_SESSION_EXPIRED' || error.code === 'ADMIN_UNAUTHORIZED') {
        api.setToken('');
        global.location.replace('login.html');
      }
      throw error;
    }
  }

  // ---------- 模态框 ----------
  let modalFormRef = null;
  function openModal(form, title) {
    const overlay = $('#modalOverlay');
    const body = $('#modalBody');
    $('#modalTitle').textContent = title || '编辑';
    if (!form.__modalAnchor) form.__modalAnchor = form.parentNode;
    if (form.parentNode !== body) body.appendChild(form);
    modalFormRef = form;
    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    if (form.elements && form.elements.id) form.elements.id.value = '';
    if (form.elements && form.elements.replacesMediaAssetId) form.elements.replacesMediaAssetId.value = '';
  }
  function closeModal() {
    const overlay = $('#modalOverlay');
    overlay.classList.remove('is-open');
    overlay.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    if (modalFormRef && modalFormRef.__modalAnchor) {
      modalFormRef.__modalAnchor.appendChild(modalFormRef);
    }
    modalFormRef = null;
  }

  // ---------- 渲染 ----------
  function render() {
    // 选项填充（所有页面都有隐藏表单，datalist 都在 DOM 里）
    const co = document.getElementById('categoryOptions');
    if (co) co.innerHTML = state.categories.map((item) => `<option value="${escapeHtml(item._id)}">${escapeHtml(item.name)}（${translateStatus(item.status)}）</option>`).join('');

    const pmpo = document.getElementById('productMediaProductOptions');
    if (pmpo) pmpo.innerHTML = state.products.map((item) => `<option value="${escapeHtml(item._id)}">${escapeHtml(item.name)}（${translateStatus(item.status)}）</option>`).join('');

    const productNames = new Map(state.products.map((item) => [item._id, item.name]));
    const skuNames = new Map(state.skus.map((item) => [item._id, `${productNames.get(item.productId) || item.productId} · ${item.specName}`]));

    const so = document.getElementById('skuOptions');
    if (so) so.innerHTML = state.skus.map((item) => `<option value="${escapeHtml(item._id)}">${escapeHtml(skuNames.get(item._id))}（${translateStatus(item.status)}）</option>`).join('');

    const mediaNames = new Map(state.media.map((item) => [item._id, `${item.name} · ${translateStatus(item.type)}`]));
    const mao = document.getElementById('mediaAssetOptions');
    if (mao) mao.innerHTML = state.media.map((item) => `<option value="${escapeHtml(item._id)}">${escapeHtml(item.name)}（${translateStatus(item.type)}）</option>`).join('');

    const wno = document.getElementById('warehouseOptions');
    if (wno) wno.innerHTML = state.warehouses.map((item) => `<option value="${escapeHtml(item._id)}">${escapeHtml(item.name)}（${translateStatus(item.status)}）</option>`).join('');

    const dao = document.getElementById('deliveryAreaOptions');
    if (dao) dao.innerHTML = state.deliveryAreas.map((item) => `<option value="${escapeHtml(item._id)}">${escapeHtml(item.name)}</option>`).join('');

    // ---- overview ----
    if (PAGE_NAME === 'overview') {
      const pendingOrders = state.orders.filter((item) => item.status === 'pending_confirmation').length;
      const pendingRefunds = state.refunds.filter((item) => item.status === 'requested').length;
      const draftProducts = state.products.filter((item) => item.status !== 'on_sale').length;
      const pendingBusinesses = state.businessApplications.filter((item) => item.status === 'pending').length;
      $('#taskMetrics').innerHTML = [
        ['orders', pendingOrders, '新订单待接单', '立即处理', pendingOrders > 0],
        ['refunds', pendingRefunds, '退款申请待审核', '查看售后', pendingRefunds > 0],
        ['products', draftProducts, '商品尚未上架', '检查商品', false],
        ['businesses', pendingBusinesses, '企业申请待审核', '进入审核', pendingBusinesses > 0]
      ].map(([target, count, label, action, urgent]) => {
        const targetHref = `${target}.html`;
        return `<a class="task-card${urgent ? ' is-urgent' : ''}" href="${targetHref}" style="text-decoration:none"><span class="task-label">${label}</span><strong>${count}</strong><span class="task-action">${action} <b>→</b></span></a>`;
      }).join('');
      $('#overviewDate').textContent = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
      $('#metrics').innerHTML = [
        ['全部商品', state.products.length],
        ['在售商品', state.products.filter((item) => item.status === 'on_sale').length],
        ['商品规格', state.skus.length],
        ['当前订单', state.orders.length]
      ].map(([label, count]) => `<article class="metric"><span>${label}</span><strong>${count}</strong></article>`).join('');
    }

    // ---- 批量导入 ----
    paginateRows(state.imports, (item, seq) => {
      const source = item.rawPayload || {}; const parsed = item.parsedPayload || {};
      return `<tr><td class="col-idx" style="text-align:center">${seq}</td><td>${escapeHtml(item.sourceRowNo)}</td><td>${escapeHtml(parsed.name || source.name)}</td><td>${escapeHtml(parsed.categoryName || source.category)}</td><td>${escapeHtml(parsed.specName || parsed.packageUnit)}</td><td>${badge(item.status)}</td><td class="col-action">${item.status === 'staged' || item.status === 'reviewing' || item.status === 'approved' ? `<button data-approve-import="${item._id}">审核入库</button>` : '—'}</td></tr>`;
    }, 'importsTable', 6, 'imports');

    // ---- 分类 ----
    paginateRows(state.categories, (item, seq) =>
      `<tr><td class="col-idx" style="text-align:center">${seq}</td><td>${escapeHtml(item.name)}</td><td>${badge(item.status)}</td><td>${escapeHtml(item.sort)}</td><td class="col-action"><button data-edit-category="${item._id}">编辑</button></td></tr>`,
      'categoriesTable', 4, 'categories');

    // ---- 商品 ----
    paginateRows(state.products, (item, seq) =>
      `<tr><td class="col-idx" style="text-align:center">${seq}</td><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.categoryName)}</td><td>${escapeHtml(item.frozenTemperature || '—')}</td><td>${badge(item.status)}</td><td class="col-action"><button data-edit-product="${item._id}">编辑</button>${item.status !== 'on_sale' ? ` <button data-publish-product="${item._id}">上架</button>` : ''}</td></tr>`,
      'productsTable', 5, 'products');

    // ---- SKU ----
    paginateRows(state.skus, (item, seq) =>
      `<tr><td class="col-idx" style="text-align:center">${seq}</td><td>${escapeHtml(item.specName)}</td><td>${escapeHtml(item.packageUnit || '—')}</td><td>${escapeHtml(productNames.get(item.productId) || item.productId)}</td><td>${badge(item.status)}</td><td class="col-action"><button data-edit-sku="${item._id}">编辑</button>${item.status !== 'on_sale' ? ` <button data-publish-sku="${item._id}">上架</button>` : ` <button data-offsale-sku="${item._id}">下架</button>`}</td></tr>`,
      'skusTable', 5, 'skus');

    // ---- 商品媒体 ----
    paginateRows(state.productMedia, (item, seq) =>
      `<tr><td class="col-idx" style="text-align:center">${seq}</td><td>${escapeHtml(productNames.get(item.productId) || item.productId)}${item.skuId ? `<br><small>${escapeHtml(skuNames.get(item.skuId) || item.skuId)}</small>` : ''}</td><td><code title="${escapeHtml(item.mediaAssetId)}">${escapeHtml(mediaNames.get(item.mediaAssetId) || item.mediaAssetId)}</code></td><td>${translateStatus(item.mediaType)}</td><td>${translateStatus(item.role)}</td><td>${badge(item.enabled === false ? 'disabled' : 'enabled')}</td><td class="col-action"><button data-edit-product-media="${item._id}">编辑</button></td></tr>`,
      'productMediaTable', 6, 'productMedia');

    // ---- 企业审核 ----
    paginateRows(state.businessApplications, (item, seq) =>
      `<tr><td class="col-idx" style="text-align:center">${seq}</td><td>${escapeHtml(item.companyName)}<br><code>${escapeHtml(item.unifiedCode)}</code></td><td>${escapeHtml(item.contactName)} ${escapeHtml(item.contactPhoneMasked)}</td><td>${formatDate(item.submittedAt)}</td><td>${badge(item.status)}</td><td class="col-action">${item.status === 'pending' ? `<button data-approve-business="${item._id}">通过</button><button data-reject-business="${item._id}">驳回</button>` : '—'}</td></tr>`,
      'businessApplicationsTable', 5, 'businessApplications');

    // ---- 用户列表 ----
    paginateRows(state.users, (item, seq) =>
      `<tr><td class="col-idx" style="text-align:center">${seq}</td><td><code>${escapeHtml(item._id)}</code></td><td>${translateStatus(item.userType || 'c')}</td><td><code>${escapeHtml(item.organizationId || '—')}</code></td><td>${escapeHtml(item.priceLevel || '—')}</td><td class="col-action"><button data-edit-user-pricing="${item._id}">调整</button></td></tr>`,
      'usersTable', 5, 'users');

    // ---- 价格规则 ----
    paginateRows(state.prices, (item, seq) =>
      `<tr><td class="col-idx" style="text-align:center">${seq}</td><td>${escapeHtml(skuNames.get(item.skuId) || item.skuId)}</td><td>${translateStatus(item.scopeType)} ${escapeHtml(item.scopeId || '')}</td><td>${formatCents(item.amountCent)}</td><td>${translateStatus(item.channel || 'all')}</td><td>${badge(item.status)}</td><td class="col-action"><button data-edit-price="${item._id}">编辑</button></td></tr>`,
      'pricesTable', 6, 'prices');

    // ---- 仓库 ----
    const warehouseNames = new Map(state.warehouses.map((item) => [item._id, item.name]));
    paginateRows(state.warehouses, (item, seq) =>
      `<tr><td class="col-idx" style="text-align:center">${seq}</td><td>${escapeHtml(item.name)}<br><code>${escapeHtml(item.code)}</code></td><td>${badge(item.status)}</td><td class="col-action"><button data-edit-warehouse="${item._id}">编辑</button></td></tr>`,
      'warehousesTable', 3, 'warehouses');

    // ---- 配送区域 ----
    paginateRows(state.deliveryAreas, (item, seq) =>
      `<tr><td class="col-idx" style="text-align:center">${seq}</td><td>${escapeHtml(item.name)}</td><td>${escapeHtml((item.regionCodes || []).length)}</td><td>${badge(item.status)}</td><td class="col-action"><button data-edit-delivery-area="${item._id}">编辑</button></td></tr>`,
      'deliveryAreasTable', 4, 'deliveryAreas');

    // ---- 运费规则 ----
    paginateRows(state.freightRules, (item, seq) =>
      `<tr><td class="col-idx" style="text-align:center">${seq}</td><td>${escapeHtml(item.name)}</td><td>${escapeHtml(state.deliveryAreas.find((area) => area._id === item.deliveryAreaId)?.name || item.deliveryAreaId)}</td><td>${formatCents(item.baseFeeCent)}</td><td>${badge(item.status)}</td><td class="col-action"><button data-edit-freight="${item._id}">编辑</button></td></tr>`,
      'freightRulesTable', 5, 'freightRules');

    // ---- 配送时段 ----
    paginateRows(state.deliverySlots, (item, seq) =>
      `<tr><td class="col-idx" style="text-align:center">${seq}</td><td>${escapeHtml(item.name)} ${escapeHtml(item.startTime)}-${escapeHtml(item.endTime)}</td><td>${escapeHtml(state.deliveryAreas.find((area) => area._id === item.deliveryAreaId)?.name || item.deliveryAreaId)}</td><td>${escapeHtml(warehouseNames.get(item.warehouseId) || item.warehouseId || '全部')}</td><td>${badge(item.status)}</td><td class="col-action"><button data-edit-delivery-slot="${item._id}">编辑</button></td></tr>`,
      'deliverySlotsTable', 5, 'deliverySlots');

    // ---- 库存 ----
    paginateRows(state.inventory, (item, seq) =>
      `<tr><td class="col-idx" style="text-align:center">${seq}</td><td>${escapeHtml(warehouseNames.get(item.warehouseId) || item.warehouseId)}</td><td>${escapeHtml(skuNames.get(item.skuId) || item.skuId)}</td><td>${escapeHtml(item.onHand)}</td><td>${escapeHtml(item.reserved)}</td><td>${escapeHtml(item.available)}</td><td>${formatDate(item.updatedAt)}</td></tr>`,
      'inventoryTable', 7, 'inventory');

    // ---- 订单 ----
    const orderActions = { pending_confirmation: ['picking', '开始拣货'], picking: ['shipping', '标记发货'], shipping: ['delivered', '标记送达'] };
    paginateRows(state.orders, (item, seq) => {
      const action = orderActions[item.status];
      return `<tr><td class="col-idx" style="text-align:center">${seq}</td><td><code>${escapeHtml(item.orderNo)}</code></td><td>${badge(item.status)}</td><td>${formatCents(item.totalAmountCent)}</td><td>${badge(item.paymentStatus)}</td><td>${formatDate(item.createdAt)}</td><td class="col-action">${action ? `<button data-transition-order="${item._id}" data-next-status="${action[0]}">${action[1]}</button>` : '—'}</td></tr>`;
    }, 'ordersTable', 6, 'orders');

    // ---- 退款 ----
    paginateRows(state.refunds, (item, seq) =>
      `<tr><td class="col-idx" style="text-align:center">${seq}</td><td><code>${escapeHtml(item.refundNo)}</code></td><td><code>${escapeHtml(item.orderId)}</code></td><td>${formatCents(item.amountCent)}</td><td>${escapeHtml(item.reason || '—')}</td><td>${badge(item.status)}</td><td class="col-action">${item.status === 'requested' ? `<button data-approve-refund="${item._id}">审核通过</button><button data-reject-refund="${item._id}">驳回</button>` : '—'}</td></tr>`,
      'refundsTable', 6, 'refunds');

    // ---- 拼团 ----
    paginateRows(state.groupCampaigns, (item, seq) =>
      `<tr><td class="col-idx" style="text-align:center">${seq}</td><td>${escapeHtml(item.title)}</td><td>${escapeHtml(skuNames.get(item.skuId) || item.skuId)}</td><td>${escapeHtml(item.groupSize)}</td><td>${formatCents(item.groupPriceCent)}</td><td>${badge(item.status)}</td><td class="col-action"><button data-edit-group-campaign="${item._id}">编辑</button></td></tr>`,
      'groupCampaignsTable', 6, 'groupCampaigns');

    // ---- 管理员 ----
    const roleNames = new Map(state.roles.map((item) => [item._id, item.name]));
    paginateRows(state.adminUsers, (item, seq) =>
      `<tr><td class="col-idx" style="text-align:center">${seq}</td><td>${escapeHtml(item.username)}<br>${escapeHtml(item.displayName)}</td><td>${escapeHtml((item.roleIds || []).map((id) => roleNames.get(id) || id).join('、'))}</td><td>${badge(item.status)}</td><td>${formatDate(item.lastLoginAt)}</td><td class="col-action"><button data-edit-admin-user="${item.id}">编辑</button></td></tr>`,
      'adminUsersTable', 5, 'adminUsers');

    // ---- 轮播图 ----
    paginateRows(state.banners, (item, seq) =>
      `<tr><td class="col-idx" style="text-align:center">${seq}</td><td>${escapeHtml(item.title)}</td><td><code>${escapeHtml(item.mediaAssetId || '未设置')}</code></td><td>${translateStatus(item.jumpType)} ${escapeHtml(item.jumpTarget)}</td><td>${badge(item.enabled ? 'enabled' : 'disabled')}</td><td class="col-action"><button data-edit-banner="${item._id}">编辑</button></td></tr>`,
      'bannersTable', 5, 'banners');

    // ---- 首页模块 ----
    paginateRows(state.sections, (item, seq) => {
      const sectionLabel = ({ news: '活动头条', special: '特价专区', group: '拼团专场' })[item.moduleType] || '活动头条';
      return `<tr><td class="col-idx" style="text-align:center">${seq}</td><td>${escapeHtml(sectionLabel)}</td><td>${escapeHtml(item.title)}</td><td>${escapeHtml(item.subtitle || '—')}</td><td><code>${escapeHtml(item.mediaAssetId || '未设置')}</code></td><td>${translateStatus(item.jumpType)} ${escapeHtml(item.jumpTarget)}</td><td>${badge(item.enabled ? 'enabled' : 'disabled')}</td><td class="col-action"><button data-edit-section="${item._id}">编辑</button></td></tr>`;
    }, 'sectionsTable', 7, 'sections');

    // ---- 素材 ----
    paginateRows(state.media, (item, seq) =>
      `<tr><td class="col-idx" style="text-align:center">${seq}</td><td>${escapeHtml(item.name)}${item.temporary ? ' <span class="badge warn">临时</span>' : ''}</td><td>${translateStatus(item.type)}</td><td>${translateStatus(item.source)}</td><td>${escapeHtml(item.version)}</td><td><code title="${escapeHtml(item.fileId)}">${escapeHtml(item.fileId)}</code></td><td class="col-action"><button data-version-media="${item._id}">新建版本</button></td></tr>`,
      'mediaTable', 6, 'media');

    // ---- 操作记录 ----
    paginateRows(state.audit, (item, seq) =>
      `<tr><td class="col-idx" style="text-align:center">${seq}</td><td>${formatDate(item.createdAt)}</td><td>${escapeHtml(item.action)}</td><td>${escapeHtml(item.targetType)} / ${escapeHtml(item.targetId)}</td><td>${escapeHtml(item.actorId || 'system')}</td></tr>`,
      'auditTable', 4, 'audit');

    if (PAGE_NAME !== 'access') renderTableToolbars();
  }

  function renderTableToolbars() {
    const toolbarMap = [
      { tbodyId: 'importsTable',    addBtn: null },
      { tbodyId: 'categoriesTable', addBtn: { text: '+ 新增分类', form: '#categoryForm', title: '新增分类' } },
      { tbodyId: 'productsTable',   addBtn: { text: '+ 新增商品', form: '#productForm', title: '新增商品' } },
      { tbodyId: 'skusTable',       addBtn: { text: '+ 新增 SKU', form: '#skuForm', title: '新增 SKU' } },
      { tbodyId: 'productMediaTable', addBtn: { text: '+ 新增媒体关联', form: '#productMediaForm', title: '新增商品媒体关联' } },
      { tbodyId: 'businessApplicationsTable', addBtn: null },
      { tbodyId: 'usersTable',      addBtn: null },
      { tbodyId: 'pricesTable',     addBtn: { text: '+ 新增价格规则', form: '#priceForm', title: '新增价格规则' } },
      { tbodyId: 'warehousesTable', addBtn: { text: '+ 新增仓库', form: '#warehouseForm', title: '新增仓库' } },
      { tbodyId: 'deliveryAreasTable', addBtn: { text: '+ 新增配送区域', form: '#deliveryAreaForm', title: '新增配送区域' } },
      { tbodyId: 'freightRulesTable', addBtn: { text: '+ 新增运费规则', form: '#freightForm', title: '新增运费规则' } },
      { tbodyId: 'deliverySlotsTable', addBtn: { text: '+ 新增配送时段', form: '#deliverySlotForm', title: '新增配送时段' } },
      { tbodyId: 'inventoryTable',  addBtn: { text: '+ 库存调整', form: '#inventoryForm', title: '库存调整' } },
      { tbodyId: 'ordersTable',     addBtn: null },
      { tbodyId: 'refundsTable',    addBtn: null },
      { tbodyId: 'groupCampaignsTable', addBtn: { text: '+ 新增拼团活动', form: '#groupCampaignForm', title: '新增拼团活动' } },
      { tbodyId: 'adminUsersTable', addBtn: { text: '+ 新增管理员', form: '#adminUserForm', title: '新增管理员' } },
      { tbodyId: 'bannersTable',    addBtn: { text: '+ 新增轮播图', form: '#bannerForm', title: '新增轮播图' } },
      { tbodyId: 'sectionsTable',   addBtn: { text: '+ 新增首页模块', form: '#sectionForm', title: '新增首页模块' } },
      { tbodyId: 'mediaTable',      addBtn: null },
      { tbodyId: 'auditTable',      addBtn: null }
    ];
    toolbarMap.forEach(({ tbodyId, addBtn }) => {
      const tbody = document.getElementById(tbodyId);
      if (!tbody) return;
      const wrap = tbody.closest('.table-wrap');
      if (!wrap) return;
      if (!addBtn) {
        const prev = wrap.previousElementSibling;
        if (prev && prev.classList.contains('table-toolbar')) prev.remove();
        return;
      }
      let toolbar = wrap.previousElementSibling;
      if (toolbar && toolbar.classList.contains('table-toolbar')) {
        toolbar.innerHTML = '';
      } else {
        toolbar = document.createElement('div');
        toolbar.className = 'table-toolbar';
        wrap.parentNode.insertBefore(toolbar, wrap);
      }
      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'toolbar-actions';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toolbar-btn';
      btn.textContent = addBtn.text;
      btn.dataset.addForm = addBtn.form;
      btn.dataset.addTitle = addBtn.title;
      actionsDiv.appendChild(btn);
      toolbar.appendChild(actionsDiv);
    });
  }

  // ---------- Loading 遮罩 ----------
  function showLoading(targetSelector) {
    const targets = targetSelector ? document.querySelectorAll(targetSelector) : [document.querySelector('.workspace')];
    targets.forEach((root) => {
      if (!root || root.querySelector('.loading-overlay')) return;
      const wrap = document.createElement('div');
      wrap.className = 'loading-overlay';
      wrap.innerHTML = '<div class="loading-spinner"></div>';
      root.style.position = root.style.position || 'relative';
      root.appendChild(wrap);
    });
  }

  function hideLoading(targetSelector) {
    const targets = targetSelector ? document.querySelectorAll(targetSelector) : [document.querySelector('.workspace')];
    targets.forEach((root) => {
      if (!root) return;
      root.querySelectorAll('.loading-overlay').forEach((el) => el.remove());
    });
  }
async function refreshAll() {
    const loads = PAGE_LOADS[PAGE_NAME] || [];
    if (!loads.length) { render(); return; }
    showLoading('.panel.is-active');
    try {

    const tasks = await Promise.allSettled(
      loads.map(([/*stateKey*/, action]) => call(action, { pageSize: 100 }).then((r) => ({ action, rows: r.rows || [] })))
    );

    let firstFail = null;
    tasks.forEach((result, idx) => {
      const [stateKey] = loads[idx];
      if (result.status === 'fulfilled') {
        state[stateKey] = result.value.rows;
      } else {
        state[stateKey] = [];
        if (!firstFail) firstFail = result.reason;
      }
    });

      render();
      if (firstFail) message(`后台数据加载失败：${firstFail.message || '请检查服务端响应。'}`, true);
    } finally {
      hideLoading('.panel.is-active');
    }
  }

  function switchPanelTab(tabName, clickedBtn) {
    const tabNav = (clickedBtn && clickedBtn.closest('.panel-tabs')) || document.querySelector('.panel .panel-tabs');
    if (!tabNav) return;
    tabNav.querySelectorAll('button').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.tab === tabName);
    });
    const scope = tabNav.parentElement;
    scope.querySelectorAll(':scope > .panel-tab-content').forEach((content) => {
      content.classList.toggle('is-active', content.dataset.tabContent === tabName);
    });
  }

  // ---------- 编辑填充 ----------
  function fillCategory(id) { const item = state.categories.find((row) => row._id === id); if (!item) return; const form = $('#categoryForm'); form.elements.id.value = item._id; form.elements.name.value = item.name; form.elements.imageMediaId.value = item.imageMediaId || ''; form.elements.sort.value = item.sort || 0; form.elements.status.value = item.status; openModal(form, '编辑分类'); }
  function fillBanner(id) { const item = state.banners.find((row) => row._id === id); if (!item) return; const form = $('#bannerForm'); form.elements.id.value = item._id; form.elements.title.value = item.title; form.elements.mediaAssetId.value = item.mediaAssetId || ''; form.elements.jumpType.value = item.jumpType || 'none'; form.elements.jumpTarget.value = item.jumpTarget || ''; form.elements.sort.value = item.sort || 0; form.elements.enabled.checked = item.enabled !== false; openModal(form, '编辑轮播图'); }
  function fillSection(id) { const item = state.sections.find((row) => row._id === id); if (!item) return; const form = $('#sectionForm'); form.elements.id.value = item._id; form.elements.moduleType.value = item.moduleType || 'news'; form.elements.title.value = item.title; form.elements.subtitle.value = item.subtitle || ''; form.elements.linkText.value = item.linkText || '更多'; form.elements.mediaAssetId.value = item.mediaAssetId || ''; form.elements.jumpType.value = item.jumpType || 'none'; form.elements.jumpTarget.value = item.jumpTarget || ''; form.elements.sort.value = item.sort || 0; form.elements.enabled.checked = item.enabled !== false; openModal(form, '编辑首页模块'); }
  function startMediaVersion(id) { const item = state.media.find((row) => row._id === id); if (!item) return; const form = $('#mediaForm'); form.reset(); form.elements.replacesMediaAssetId.value = item._id; form.elements.name.value = `${item.name} v${Number(item.version || 1) + 1}`; form.elements.type.value = item.type || 'image'; form.elements.source.value = item.source || 'admin_upload'; form.elements.temporary.checked = item.temporary === true; form.elements.mimeType.value = item.mimeType || ''; form.elements.sizeBytes.value = 0; form.elements.startAt.value = String(item.startAt || '').slice(0, 16); form.elements.endAt.value = String(item.endAt || '').slice(0, 16); const targetPlatforms = item.targetPlatforms && item.targetPlatforms.length ? item.targetPlatforms : ['miniapp', 'web']; form.querySelectorAll('input[name="targetPlatforms"]').forEach((input) => { input.checked = targetPlatforms.includes(input.value); }); $('#mediaVersionHint').textContent = `正在为"${item.name}"创建版本 ${Number(item.version || 1) + 1}；请填写新的 CloudBase 文件 ID，旧素材会保留。`; openModal(form, '新建素材版本'); }
  function fillProduct(id) { const item = state.products.find((row) => row._id === id); if (!item) return; const form = $('#productForm'); form.elements.id.value = item._id; form.elements.name.value = item.name; form.elements.categoryId.value = item.categoryId; form.elements.brand.value = item.brand || ''; form.elements.origin.value = item.origin || ''; form.elements.frozenTemperature.value = item.frozenTemperature || '-18℃'; form.elements.coverMediaId.value = item.coverMediaId || ''; form.elements.sort.value = item.sort || 0; openModal(form, '编辑商品'); }
  function fillProductMedia(id) { const item = state.productMedia.find((row) => row._id === id); if (!item) return; const form = $('#productMediaForm'); form.elements.id.value = item._id; form.elements.productId.value = item.productId; form.elements.skuId.value = item.skuId || ''; form.elements.mediaAssetId.value = item.mediaAssetId; form.elements.mediaType.value = item.mediaType; form.elements.role.value = item.role || 'detail'; form.elements.sort.value = item.sort || 0; form.elements.enabled.checked = item.enabled !== false; openModal(form, '编辑商品媒体'); }
  function fillSku(id) { const item = state.skus.find((row) => row._id === id); if (!item) return; const form = $('#skuForm'); form.elements.id.value = item._id; form.elements.productId.value = item.productId; form.elements.specName.value = item.specName; form.elements.packageUnit.value = item.packageUnit || ''; form.elements.netWeight.value = item.netWeight || ''; form.elements.weightUnit.value = item.weightUnit || ''; form.elements.piecesPerCase.value = item.piecesPerCase || 0; form.elements.barcode.value = item.barcode || ''; form.elements.status.value = item.status; openModal(form, '编辑 SKU'); }
  function fillUserPricing(id) { const item = state.users.find((row) => row._id === id); if (!item) return; const form = $('#userPricingForm'); form.elements.id.value = item._id; form.elements.userType.value = item.userType || 'c'; form.elements.organizationId.value = item.organizationId || ''; form.elements.priceLevel.value = item.priceLevel || ''; openModal(form, '调整用户身份'); }
  function fillPrice(id) { const item = state.prices.find((row) => row._id === id); if (!item) return; const form = $('#priceForm'); form.elements.id.value = item._id; form.elements.skuId.value = item.skuId; form.elements.scopeType.value = item.scopeType; form.elements.scopeId.value = item.scopeId || ''; form.elements.channel.value = item.channel || 'all'; form.elements.amountCent.value = item.amountCent; form.elements.priority.value = item.priority || 0; form.elements.status.value = item.status; openModal(form, '编辑价格规则'); }
  function fillWarehouse(id) { const item = state.warehouses.find((row) => row._id === id); if (!item) return; const form = $('#warehouseForm'); form.elements.id.value = item._id; form.elements.code.value = item.code; form.elements.name.value = item.name; form.elements.address.value = item.address || ''; form.elements.status.value = item.status; form.elements.sort.value = item.sort || 0; openModal(form, '编辑仓库'); }
  function fillDeliveryArea(id) { const item = state.deliveryAreas.find((row) => row._id === id); if (!item) return; const form = $('#deliveryAreaForm'); form.elements.id.value = item._id; form.elements.name.value = item.name; form.elements.regionCodes.value = (item.regionCodes || []).join('\n'); form.elements.warehouseIds.value = (item.warehouseIds || []).join('\n'); form.elements.status.value = item.status; openModal(form, '编辑配送区域'); }
  function fillFreight(id) { const item = state.freightRules.find((row) => row._id === id); if (!item) return; const form = $('#freightForm'); form.elements.id.value = item._id; form.elements.name.value = item.name; form.elements.deliveryAreaId.value = item.deliveryAreaId; form.elements.warehouseId.value = item.warehouseId || ''; form.elements.baseFeeCent.value = item.baseFeeCent || 0; form.elements.additionalFeeCent.value = item.additionalFeeCent || 0; form.elements.freeThresholdCent.value = item.freeThresholdCent || 0; form.elements.status.value = item.status; openModal(form, '编辑运费规则'); }
  function fillDeliverySlot(id) { const item = state.deliverySlots.find((row) => row._id === id); if (!item) return; const form = $('#deliverySlotForm'); form.elements.id.value = item._id; form.elements.name.value = item.name; form.elements.deliveryAreaId.value = item.deliveryAreaId; form.elements.warehouseId.value = item.warehouseId || ''; form.elements.startTime.value = item.startTime; form.elements.endTime.value = item.endTime; form.elements.status.value = item.status; openModal(form, '编辑配送时段'); }
  function fillGroupCampaign(id) { const item = state.groupCampaigns.find((row) => row._id === id); if (!item) return; const form = $('#groupCampaignForm'); form.elements.id.value = item._id; form.elements.title.value = item.title; form.elements.skuId.value = item.skuId; form.elements.groupSize.value = item.groupSize; form.elements.durationMinutes.value = item.durationMinutes; form.elements.groupPriceCent.value = item.groupPriceCent; form.elements.targetUserType.value = item.targetUserType || 'all'; form.elements.status.value = item.status; openModal(form, '编辑拼团活动'); }
  function fillAdminUser(id) { const item = state.adminUsers.find((row) => row.id === id); if (!item) return; const form = $('#adminUserForm'); form.elements.id.value = item.id; form.elements.username.value = item.username; form.elements.displayName.value = item.displayName; form.elements.password.value = ''; form.elements.roleIds.value = (item.roleIds || []).join('\n'); form.elements.status.value = item.status; openModal(form, '编辑管理员'); }

  async function stageFile(file) {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed.rows) || !parsed.rows.length) throw new Error('草稿文件中没有 rows 数据。');
    for (let index = 0; index < parsed.rows.length; index += 50) {
      await call('admin.imports.stage', { sourceFile: file.name, rows: parsed.rows.slice(index, index + 50) });
      message(`已写入 ${Math.min(index + 50, parsed.rows.length)} / ${parsed.rows.length} 条商品草稿。`);
    }
  }

  // ---------- 事件绑定 ----------
  function bind() {
    // Panel 内部 tab 切换（商品管理内层 3 个 tab）
    document.addEventListener('click', (event) => {
      const tabBtn = event.target.closest('.panel-tabs button');
      if (tabBtn && tabBtn.dataset.tab) {
        switchPanelTab(tabBtn.dataset.tab, tabBtn);
      }
    });

    // 首页卡片快捷跳转（已改为 <a> 跳转，但保留 fallback）
    const taskMetricsEl = $('#taskMetrics');
    if (taskMetricsEl) {
      taskMetricsEl.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-go-panel]');
        if (button) global.location.replace(`${button.dataset.goPanel}.html`);
      });
    }

    $('#logoutButton').addEventListener('click', async () => {
      try { await call('admin.logout', {}); } catch (_) {}
      api.setToken('');
      global.location.replace('login.html');
    });

    const stagingFile = document.getElementById('stagingFile');
    if (stagingFile) stagingFile.addEventListener('change', async (event) => {
      const file = event.target.files[0]; if (!file) return;
      try { await stageFile(file); await refreshAll(); message('商品草稿已写入审核队列。'); }
      catch (error) { message(error.message || '导入失败。', true); } finally { event.target.value = ''; }
    });

    const activateImportsButton = document.getElementById('activateImportsButton');
    if (activateImportsButton) activateImportsButton.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const ids = state.imports.map((item) => item._id);
      if (!ids.length) return message('当前没有可处理的商品草稿。', true);
      button.disabled = true;
      try {
        let activated = 0;
        for (let index = 0; index < ids.length; index += 10) {
          const result = await call('admin.imports.activateBatch', { ids: ids.slice(index, index + 10) });
          activated += (result.activated || []).length;
          if ((result.failed || []).length) throw new Error(`第 ${index + 1} 至 ${Math.min(index + 10, ids.length)} 条中有 ${(result.failed || []).length} 条启用失败，可再次点击继续。`);
          message(`已审核并启用 ${Math.min(index + 10, ids.length)} / ${ids.length} 条商品草稿。`);
        }
        await refreshAll();
        message(`批量处理完成：${activated} 条商品及 SKU 已启用。`);
      } catch (error) { await refreshAll(); message(error.message || '批量处理失败，可再次点击继续。', true); }
      finally { button.disabled = false; }
    });

    // 表单 submit
    const catForm = document.getElementById('categoryForm');
    if (catForm) catForm.addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.categories.upsert', { id: form.get('id'), name: form.get('name'), imageMediaId: form.get('imageMediaId'), sort: Number(form.get('sort')), status: form.get('status') }); closeModal(); await refreshAll(); message('分类已保存。'); } catch (error) { message(error.message, true); } });

    const bannerForm = document.getElementById('bannerForm');
    if (bannerForm) bannerForm.addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.banners.upsert', { id: form.get('id'), title: form.get('title'), mediaAssetId: form.get('mediaAssetId'), jumpType: form.get('jumpType'), jumpTarget: form.get('jumpTarget'), sort: Number(form.get('sort')), enabled: form.get('enabled') === 'on' }); closeModal(); await refreshAll(); message('轮播图配置已保存。'); } catch (error) { message(error.message, true); } });

    const sectionForm = document.getElementById('sectionForm');
    if (sectionForm) sectionForm.addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.homeSections.upsert', { id: form.get('id'), moduleType: form.get('moduleType'), title: form.get('title'), subtitle: form.get('subtitle'), linkText: form.get('linkText'), mediaAssetId: form.get('mediaAssetId'), jumpType: form.get('jumpType'), jumpTarget: form.get('jumpTarget'), sort: Number(form.get('sort')), enabled: form.get('enabled') === 'on' }); closeModal(); await refreshAll(); message('首页模块已保存。'); } catch (error) { message(error.message, true); } });

    const productForm = document.getElementById('productForm');
    if (productForm) productForm.addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.products.upsert', { id: form.get('id'), name: form.get('name'), categoryId: form.get('categoryId'), brand: form.get('brand'), origin: form.get('origin'), frozenTemperature: form.get('frozenTemperature'), coverMediaId: form.get('coverMediaId'), sort: Number(form.get('sort')) }); closeModal(); await refreshAll(); message('商品信息已保存。'); } catch (error) { message(error.message, true); } });

    const productMediaForm = document.getElementById('productMediaForm');
    if (productMediaForm) productMediaForm.addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.productMedia.upsert', { id: form.get('id'), productId: form.get('productId'), skuId: form.get('skuId'), mediaAssetId: form.get('mediaAssetId'), mediaType: form.get('mediaType'), role: form.get('role'), sort: Number(form.get('sort')), enabled: form.get('enabled') === 'on' }); closeModal(); await refreshAll(); message('商品媒体关联已保存。'); } catch (error) { message(error.message, true); } });

    const skuForm = document.getElementById('skuForm');
    if (skuForm) skuForm.addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.skus.upsert', { id: form.get('id'), productId: form.get('productId'), specName: form.get('specName'), packageUnit: form.get('packageUnit'), netWeight: form.get('netWeight'), weightUnit: form.get('weightUnit'), piecesPerCase: Number(form.get('piecesPerCase')), barcode: form.get('barcode'), status: form.get('status') }); closeModal(); await refreshAll(); message('SKU 信息已保存。'); } catch (error) { message(error.message, true); } });

    const userPricingForm = document.getElementById('userPricingForm');
    if (userPricingForm) userPricingForm.addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.users.setPricingProfile', { id: form.get('id'), userType: form.get('userType'), organizationId: form.get('organizationId'), priceLevel: form.get('priceLevel') }); closeModal(); await refreshAll(); message('用户身份与价格等级已保存。'); } catch (error) { message(error.message, true); } });

    const priceForm = document.getElementById('priceForm');
    if (priceForm) priceForm.addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.prices.upsert', { id: form.get('id'), skuId: form.get('skuId'), scopeType: form.get('scopeType'), scopeId: form.get('scopeId') || '', channel: form.get('channel'), amountCent: Number(form.get('amountCent')), priority: Number(form.get('priority')), status: form.get('status') }); closeModal(); await refreshAll(); message('价格规则已保存。'); } catch (error) { message(error.message, true); } });

    const warehouseForm = document.getElementById('warehouseForm');
    if (warehouseForm) warehouseForm.addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.warehouses.upsert', { id: form.get('id'), code: form.get('code'), name: form.get('name'), address: form.get('address'), sort: Number(form.get('sort')), status: form.get('status') }); closeModal(); await refreshAll(); message('仓库已保存。'); } catch (error) { message(error.message, true); } });

    const deliveryAreaForm = document.getElementById('deliveryAreaForm');
    if (deliveryAreaForm) deliveryAreaForm.addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.deliveryAreas.upsert', { id: form.get('id'), name: form.get('name'), regionCodes: splitLines(form.get('regionCodes')), warehouseIds: splitLines(form.get('warehouseIds')), status: form.get('status') }); closeModal(); await refreshAll(); message('配送区域已保存。'); } catch (error) { message(error.message, true); } });

    const freightForm = document.getElementById('freightForm');
    if (freightForm) freightForm.addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.freightRules.upsert', { id: form.get('id'), name: form.get('name'), deliveryAreaId: form.get('deliveryAreaId'), warehouseId: form.get('warehouseId'), baseFeeCent: Number(form.get('baseFeeCent')), additionalFeeCent: Number(form.get('additionalFeeCent')), freeThresholdCent: Number(form.get('freeThresholdCent')), status: form.get('status') }); closeModal(); await refreshAll(); message('运费规则已保存。'); } catch (error) { message(error.message, true); } });

    const deliverySlotForm = document.getElementById('deliverySlotForm');
    if (deliverySlotForm) deliverySlotForm.addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.deliverySlots.upsert', { id: form.get('id'), name: form.get('name'), deliveryAreaId: form.get('deliveryAreaId'), warehouseId: form.get('warehouseId') || '', startTime: form.get('startTime'), endTime: form.get('endTime'), status: form.get('status') }); closeModal(); await refreshAll(); message('配送时段已保存。'); } catch (error) { message(error.message, true); } });
  const inventoryForm = document.getElementById('inventoryForm');
  if (inventoryForm) inventoryForm.addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.inventory.adjust', { warehouseId: form.get('warehouseId'), skuId: form.get('skuId'), change: Number(form.get('change')), reason: form.get('reason'), idempotencyKey: newIdempotencyKey() }); event.currentTarget.reset(); closeModal(); await refreshAll(); message('库存已调整并写入流水。'); } catch (error) { message(error.message, true); } });

    const groupCampaignForm = document.getElementById('groupCampaignForm');
    if (groupCampaignForm) groupCampaignForm.addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.groupCampaigns.upsert', { id: form.get('id'), title: form.get('title'), skuId: form.get('skuId'), groupSize: Number(form.get('groupSize')), durationMinutes: Number(form.get('durationMinutes')), groupPriceCent: Number(form.get('groupPriceCent')), targetUserType: form.get('targetUserType'), status: form.get('status') }); closeModal(); await refreshAll(); message('拼团活动已保存。'); } catch (error) { message(error.message, true); } });

    const adminUserForm = document.getElementById('adminUserForm');
    if (adminUserForm) adminUserForm.addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { const payload = { id: form.get('id'), username: form.get('username'), displayName: form.get('displayName'), roleIds: splitLines(form.get('roleIds')), status: form.get('status') }; if (form.get('password')) payload.password = form.get('password'); closeModal(); await call('admin.adminUsers.upsert', payload); await refreshAll(); message('管理员账号已保存。'); } catch (error) { message(error.message || '操作失败。', true); } });

    const mediaSearch = document.getElementById('mediaSearch');
    if (mediaSearch) mediaSearch.addEventListener('input', (event) => { const term = event.target.value.trim().toLowerCase(); document.querySelectorAll('#mediaTable tbody tr').forEach((tr) => { tr.style.display = !term || tr.textContent.toLowerCase().includes(term) ? '' : 'none'; }); });

    const mediaForm = document.getElementById('mediaForm');
    if (mediaForm) mediaForm.addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const replacesMediaAssetId = form.get('replacesMediaAssetId'); const type = form.get('type'); const selectedFile = form.get('uploadFile'); let fileId = form.get('fileId'); let mimeType = form.get('mimeType'); let sizeBytes = Number(form.get('sizeBytes')); try { if (selectedFile && selectedFile.size) { const uploaded = await api.uploadMediaFile(selectedFile, type); fileId = uploaded.fileId; mimeType = uploaded.mimeType; sizeBytes = uploaded.sizeBytes; } if (!fileId) throw new Error('请选择本地文件，或填写已有的 CloudBase 文件 ID。'); const payload = { name: form.get('name'), type, source: form.get('source'), temporary: form.get('temporary') === 'on', targetPlatforms: form.getAll('targetPlatforms'), startAt: form.get('startAt'), endAt: form.get('endAt'), fileId, mimeType, sizeBytes }; await call(replacesMediaAssetId ? 'admin.media.createVersion' : 'admin.media.upsert', { ...payload, replacesMediaAssetId }); closeModal(); event.currentTarget.reset(); $('#mediaVersionHint').textContent = '素材已通过管理员会话上传并登记；替换文件请使用右侧"新建版本"，旧素材不会被覆盖。'; await refreshAll(); message(replacesMediaAssetId ? '素材新版本已登记。' : '素材已上传并登记。'); } catch (error) { message(error.message || '素材上传登记失败。', true); } });

    // 全局点击代理（page 按钮、add 按钮、row 操作按钮）
    document.addEventListener('click', async (event) => {
      const target = event.target;
      const pageBtn = target.closest('[data-page]');
      if (pageBtn) {
        const page = Number(pageBtn.dataset.page);
        const key = pageBtn.dataset.pageKey;
        state.pageMap[key] = page;
        render();
        return;
      }
      const addBtn = target.closest('[data-add-form]');
      if (addBtn) {
        const form = document.querySelector(addBtn.dataset.addForm);
        if (form) {
          form.reset();
          if (form.elements.id) form.elements.id.value = '';
          openModal(form, addBtn.dataset.addTitle || '新增');
        }
        return;
      }
      const editCategory = target.closest('[data-edit-category]');
      const editBanner = target.closest('[data-edit-banner]');
      const editSection = target.closest('[data-edit-section]');
      const versionMedia = target.closest('[data-version-media]');
      const editProduct = target.closest('[data-edit-product]');
      const editProductMedia = target.closest('[data-edit-product-media]');
      const editSku = target.closest('[data-edit-sku]');
      const editUserPricing = target.closest('[data-edit-user-pricing]');
      const editPrice = target.closest('[data-edit-price]');
      const editWarehouse = target.closest('[data-edit-warehouse]');
      const editDeliveryArea = target.closest('[data-edit-delivery-area]');
      const editFreight = target.closest('[data-edit-freight]');
      const editDeliverySlot = target.closest('[data-edit-delivery-slot]');
      const editGroupCampaign = target.closest('[data-edit-group-campaign]');
      const editAdminUser = target.closest('[data-edit-admin-user]');
      const approve = target.closest('[data-approve-import]');
      const approveBusiness = target.closest('[data-approve-business]');
      const rejectBusiness = target.closest('[data-reject-business]');
      const approveRefund = target.closest('[data-approve-refund]');
      const rejectRefund = target.closest('[data-reject-refund]');
      const transitionOrder = target.closest('[data-transition-order]');
      const publish = target.closest('[data-publish-product]');
      const publishSku = target.closest('[data-publish-sku]');
      const offsaleSku = target.closest('[data-offsale-sku]');

      if (editCategory) return fillCategory(editCategory.dataset.editCategory);
      if (editBanner) return fillBanner(editBanner.dataset.editBanner);
      if (editSection) return fillSection(editSection.dataset.editSection);
      if (versionMedia) return startMediaVersion(versionMedia.dataset.versionMedia);
      if (editProduct) return fillProduct(editProduct.dataset.editProduct);
      if (editProductMedia) return fillProductMedia(editProductMedia.dataset.editProductMedia);
      if (editSku) return fillSku(editSku.dataset.editSku);
      if (editUserPricing) return fillUserPricing(editUserPricing.dataset.editUserPricing);
      if (editPrice) return fillPrice(editPrice.dataset.editPrice);
      if (editWarehouse) return fillWarehouse(editWarehouse.dataset.editWarehouse);
      if (editDeliveryArea) return fillDeliveryArea(editDeliveryArea.dataset.editDeliveryArea);
      if (editFreight) return fillFreight(editFreight.dataset.editFreight);
      if (editDeliverySlot) return fillDeliverySlot(editDeliverySlot.dataset.editDeliverySlot);
      if (editGroupCampaign) return fillGroupCampaign(editGroupCampaign.dataset.editGroupCampaign);
      if (editAdminUser) return fillAdminUser(editAdminUser.dataset.editAdminUser);

      try {
        if (approve) { await call('admin.imports.approve', { id: approve.dataset.approveImport }); await refreshAll(); message('草稿已生成商品和 SKU 草稿。'); }
        if (approveBusiness) { await call('admin.businessApplications.review', { id: approveBusiness.dataset.approveBusiness, decision: 'approved' }); await refreshAll(); message('企业申请已通过。'); }
        if (rejectBusiness) { await call('admin.businessApplications.review', { id: rejectBusiness.dataset.rejectBusiness, decision: 'rejected' }); await refreshAll(); message('企业申请已驳回。'); }
        if (approveRefund) { await call('admin.refunds.review', { id: approveRefund.dataset.approveRefund, decision: 'approved' }); await refreshAll(); message('退款已审核通过。'); }
        if (rejectRefund) { await call('admin.refunds.review', { id: rejectRefund.dataset.rejectRefund, decision: 'rejected' }); await refreshAll(); message('退款申请已驳回。'); }
        if (publish) { await call('admin.products.setStatus', { id: publish.dataset.publishProduct, status: 'on_sale' }); await refreshAll(); message('商品已上架。'); }
        if (publishSku) { await call('admin.skus.setStatus', { id: publishSku.dataset.publishSku, status: 'on_sale' }); await refreshAll(); message('SKU 已上架。'); }
        if (offsaleSku) { await call('admin.skus.setStatus', { id: offsaleSku.dataset.offsaleSku, status: 'off_sale' }); await refreshAll(); message('SKU 已下架。'); }
        if (transitionOrder) { await call('admin.orders.transition', { id: transitionOrder.dataset.transitionOrder, status: transitionOrder.dataset.nextStatus }); await refreshAll(); message('订单履约状态已更新。'); }
      } catch (error) { message(error.message || '操作失败。', true); }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      const input = event.target.closest('input[data-page-key]');
      if (!input) return;
      const page = Number(input.value);
      const key = input.dataset.pageKey;
      if (!Number.isFinite(page) || page < 1) return;
      state.pageMap[key] = page;
      render();
    });

    $('#modalClose').addEventListener('click', closeModal);
    $('#modalOverlay').addEventListener('click', (event) => { if (event.target.id === 'modalOverlay') closeModal(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeModal(); });
  }

  function isAuthError(error) {
    const code = error && error.code;
    return code === 'ADMIN_SESSION_EXPIRED' || code === 'ADMIN_UNAUTHORIZED';
  }

  async function init() {
    // 按当前页面设置标题
    const meta = PAGE_META[PAGE_NAME] || PAGE_META.overview;
    const eyebrow = document.getElementById('moduleEyebrow');
    const title = document.getElementById('panelTitle');
    if (eyebrow) eyebrow.textContent = meta.eyebrow;
    if (title) title.textContent = meta.title;

    bind();
    try {
      state.admin = (await call('admin.me', {})).admin;
      $('#adminUser').textContent = state.admin ? `${state.admin.displayName} · 已登录` : '已登录';
      await refreshAll();
    } catch (error) {
      if (isAuthError(error)) {
        api.setToken('');
        global.location.replace('login.html');
      } else {
        message(`服务连接异常：${error && error.message || '请稍后刷新重试。'}`, true);
        $('#adminUser').textContent = '已登录';
        try { await refreshAll(); } catch (_) {}
      }
    }
  }
  init();
}(window, document));


