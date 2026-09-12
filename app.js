(function adminConsole(global, document) {
  const api = global.MengshixianAdminApi;
  const PAGE_SIZE = 15;
  const PAGE_WINDOW = 5;
  const state = {
    admin: null, roles: [], adminUsers: [], categories: [], products: [], skus: [],
    users: [], businessApplications: [], prices: [], warehouses: [], inventory: [],
    deliveryAreas: [], freightRules: [], deliverySlots: [], orders: [], refunds: [],
    groupCampaigns: [], imports: [], media: [], productMedia: [], banners: [],
    sections: [], audit: [],
    // 分页状态
    pageMap: {}
  };
  const $ = (selector) => document.querySelector(selector);
  const escapeHtml = (value) => String(value === undefined || value === null ? '' : value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const formatDate = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
  const formatCents = (value) => `¥${(Number(value || 0) / 100).toFixed(2)}`;
  const splitLines = (value) => String(value || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const newIdempotencyKey = () => global.crypto && global.crypto.randomUUID ? global.crypto.randomUUID() : `admin-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const activePanel = () => $('.panel.is-active') && $('.panel.is-active').dataset.panel;

  const modules = {
    workbench: { label: '工作台', panels: [['overview', '今日概况']] },
    catalog: { label: '商品中心', panels: [['products', '商品管理'], ['categories', '分类管理'], ['imports', '批量导入'], ['pricing', '价格规则']] },
    trade: { label: '订单中心', panels: [['orders', '订单履约'], ['refunds', '退款售后']] },
    fulfillment: { label: '库存配送', panels: [['fulfillment', '库存与配送']] },
    customers: { label: '客户中心', panels: [['customers', '客户与企业']] },
    content: { label: '内容运营', panels: [['content', '首页内容'], ['media', '素材库']] },
    marketing: { label: '营销中心', panels: [['groups', '拼团活动']] },
    system: { label: '系统管理', panels: [['access', '账号与权限'], ['audit', '操作记录']] }
  };
  const panelTitles = {
    overview: '今日经营概况', imports: '商品批量导入', categories: '商品分类',
    products: '商品管理', customers: '客户与企业', pricing: '价格规则',
    fulfillment: '库存、仓库与配送', orders: '订单履约', refunds: '退款售后',
    groups: '拼团活动', access: '账号与权限', content: '首页内容管理',
    media: '素材库', audit: '操作记录'
  };
  const moduleForPanel = (name) => Object.keys(modules).find((key) => modules[key].panels.some(([panelName]) => panelName === name)) || 'workbench';
  const requestedNext = () => {
    const params = new URLSearchParams(global.location.search || '');
    return params.get('next') === 'simple' ? 'simple' : '';
  };
  const continueToRequestedPage = () => {
    if (requestedNext() !== 'simple') return false;
    global.location.replace('simple.html');
    return true;
  };

  // ---------- 通用工具 ----------
  function message(text, error) {
    const target = $('#globalMessage');
    target.textContent = text || '';
    target.style.color = error ? '#c93c4d' : '#19713a';
  }
  function loginMessage(text, error) {
    const target = $('#loginMessage');
    target.textContent = text || '';
    target.style.color = error ? '#c93c4d' : '#19713a';
  }
  function badge(status) {
    const live = ['enabled', 'on_sale', 'imported', 'active'].includes(status);
    return `<span class="badge ${live ? 'live' : ''}">${escapeHtml(status || '—')}</span>`;
  }
  function paginateRows(rows, rowCountFn, targetId, colSpan, pageKey) {
    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    let page = state.pageMap[pageKey] || 1;
    if (page > pages) page = pages;
    if (page < 1) page = 1;
    state.pageMap[pageKey] = page;
    const start = (page - 1) * PAGE_SIZE;
    const sliced = rows.slice(start, start + PAGE_SIZE);
    const html = sliced.length
      ? sliced.map(rowCountFn).join('')
      : '';
    const empty = !total ? `<tr><td class="empty" colspan="${colSpan}">暂无数据</td></tr>` : '';
    const fullHtml = empty || html;
    $(targetId).innerHTML = fullHtml;
    // 分页控件
    if (total > PAGE_SIZE) {
      $(targetId).closest('.table-wrap')?.querySelector('.pagination')?.remove();
      const pagination = buildPaginationHtml(page, pages, total, pageKey);
      $(targetId).insertAdjacentHTML('afterend', pagination);
    } else {
      $(targetId).closest('.table-wrap')?.querySelector('.pagination')?.remove();
    }
  }
  function buildPaginationHtml(page, pages, total, pageKey) {
    const prev = page > 1 ? `<button data-page="${page - 1}" data-page-key="${pageKey}">上一页</button>` : `<button disabled>上一页</button>`;
    const next = page < pages ? `<button data-page="${page + 1}" data-page-key="${pageKey}">下一页</button>` : `<button disabled>下一页</button>`;
    // 页码窗口
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
        <div class="page-jump"><span>跳至</span><input type="number" min="1" max="${pages}" placeholder="页码" data-page-key="${pageKey}" style="width:48px" aria-label="跳至页码"><span>页</span></div>
      </div>
    </div>`;
  }

  async function call(action, payload) {
    try { return await api.call(action, payload); }
    catch (error) {
      if (error.code === 'ADMIN_SESSION_EXPIRED' || error.code === 'ADMIN_UNAUTHORIZED') showLogin();
      throw error;
    }
  }
  async function listAll(action) {
    if (!global.MengshixianAdminPaging) throw new Error('后台分页保护模块未加载。');
    return global.MengshixianAdminPaging.listAll(call, action);
  }

  // ---------- 模态框 ----------
  let modalFormRef = null;
  function openModal(form, title) {
    const overlay = $('#modalOverlay');
    const body = $('#modalBody');
    $('#modalTitle').textContent = title || '编辑';
    // 把表单移入模态框（DOM 移动，原有事件保留）
    if (form.parentNode !== body) {
      body.appendChild(form);
    }
    modalFormRef = form;
    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    // 重置隐藏的 id 字段
    if (form.elements && form.elements.id) form.elements.id.value = '';
    if (form.elements && form.elements.replacesMediaAssetId) form.elements.replacesMediaAssetId.value = '';
  }
  function closeModal() {
    const overlay = $('#modalOverlay');
    overlay.classList.remove('is-open');
    overlay.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    // 把表单移回原位（如果有记录的话）
    if (modalFormRef && modalFormRef.__modalAnchor) {
      modalFormRef.__modalAnchor.appendChild(modalFormRef);
    }
    modalFormRef = null;
  }

  // ---------- 登录/鉴权 ----------
  function showLogin() {
    api.setToken('');
    state.admin = null;
    $('#adminShell').classList.add('is-hidden');
    $('#loginShell').classList.remove('is-hidden');
  }
  function showAdmin() {
    $('#loginShell').classList.add('is-hidden');
    $('#adminShell').classList.remove('is-hidden');
    $('#adminUser').textContent = state.admin ? `${state.admin.displayName} · 已登录` : '已登录';
    panel(activePanel() || 'overview');
  }

  // ---------- 渲染 ----------
  function render() {
    // 工作台
    const pendingOrders = state.orders.filter((item) => item.status === 'pending_confirmation').length;
    const pendingRefunds = state.refunds.filter((item) => item.status === 'requested').length;
    const draftProducts = state.products.filter((item) => item.status !== 'on_sale').length;
    const pendingBusinesses = state.businessApplications.filter((item) => item.status === 'pending').length;
    $('#taskMetrics').innerHTML = [
      ['orders', pendingOrders, '新订单待接单', '立即处理', pendingOrders > 0],
      ['refunds', pendingRefunds, '退款申请待审核', '查看售后', pendingRefunds > 0],
      ['products', draftProducts, '商品尚未上架', '检查商品', false],
      ['customers', pendingBusinesses, '企业申请待审核', '进入审核', pendingBusinesses > 0]
    ].map(([target, count, label, action, urgent]) => `<button class="task-card${urgent ? ' is-urgent' : ''}" data-go-panel="${target}"><span class="task-label">${label}</span><strong>${count}</strong><span class="task-action">${action} <b>→</b></span></button>`).join('');
    $('#overviewDate').textContent = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
    $('#metrics').innerHTML = [
      ['全部商品', state.products.length], ['在售商品', state.products.filter((item) => item.status === 'on_sale').length], ['商品规格', state.skus.length], ['当前订单', state.orders.length]
    ].map(([label, count]) => `<article class="metric"><span>${label}</span><strong>${count}</strong></article>`).join('');

    // 选项填充
    $('#categoryOptions').innerHTML = state.categories.map((item) => `<option value="${escapeHtml(item._id)}">${escapeHtml(item.name)}（${escapeHtml(item.status)}）</option>`).join('');
    $('#productMediaProductOptions').innerHTML = state.products.map((item) => `<option value="${escapeHtml(item._id)}">${escapeHtml(item.name)}（${escapeHtml(item.status)}）</option>`).join('');
    const productNames = new Map(state.products.map((item) => [item._id, item.name]));
    const skuNames = new Map(state.skus.map((item) => [item._id, `${productNames.get(item.productId) || item.productId} · ${item.specName}`]));
    $('#skuOptions').innerHTML = state.skus.map((item) => `<option value="${escapeHtml(item._id)}">${escapeHtml(skuNames.get(item._id))}（${escapeHtml(item.status)}）</option>`).join('');
    const mediaNames = new Map(state.media.map((item) => [item._id, `${item.name} · ${item.type}`]));
    $('#mediaAssetOptions').innerHTML = state.media.map((item) => `<option value="${escapeHtml(item._id)}">${escapeHtml(item.name)}（${escapeHtml(item.type)}）</option>`).join('');
    $('#warehouseOptions').innerHTML = state.warehouses.map((item) => `<option value="${escapeHtml(item._id)}">${escapeHtml(item.name)}（${escapeHtml(item.status)}）</option>`).join('');
    $('#deliveryAreaOptions').innerHTML = state.deliveryAreas.map((item) => `<option value="${escapeHtml(item._id)}">${escapeHtml(item.name)}</option>`).join('');

    // ---- 批量导入 ----
    paginateRows(state.imports, (item) => {
      const source = item.rawPayload || {}; const parsed = item.parsedPayload || {};
      return `<tr><td>${escapeHtml(item.sourceRowNo)}</td><td>${escapeHtml(parsed.name || source.name)}</td><td>${escapeHtml(parsed.categoryName || source.category)}</td><td>${escapeHtml(parsed.specName || parsed.packageUnit)}</td><td>${badge(item.status)}</td><td>${item.status === 'staged' || item.status === 'reviewing' || item.status === 'approved' ? `<button data-approve-import="${item._id}">审核入库</button>` : '—'}</td></tr>`;
    }, '#importsTable', 6, 'imports');

    // ---- 分类 ----
    paginateRows(state.categories, (item) => `<tr><td>${escapeHtml(item.name)}</td><td>${badge(item.status)}</td><td>${escapeHtml(item.sort)}</td><td><button data-edit-category="${item._id}">编辑</button></td></tr>`, '#categoriesTable', 4, 'categories');

    // ---- 商品 ----
    paginateRows(state.products, (item) => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.categoryName)}</td><td>${escapeHtml(item.frozenTemperature || '—')}</td><td>${badge(item.status)}</td><td><button data-edit-product="${item._id}">编辑</button>${item.status !== 'on_sale' ? `<button data-publish-product="${item._id}">尝试上架</button>` : '—'}</td></tr>`, '#productsTable', 5, 'products');

    // ---- SKU ----
    paginateRows(state.skus, (item) => `<tr><td>${escapeHtml(item.specName)}</td><td>${escapeHtml(item.packageUnit || '—')}</td><td>${escapeHtml(productNames.get(item.productId) || item.productId)}</td><td>${badge(item.status)}</td><td><button data-edit-sku="${item._id}">编辑</button>${item.status !== 'on_sale' ? `<button data-publish-sku="${item._id}">上架 SKU</button>` : `<button data-offsale-sku="${item._id}">下架 SKU</button>`}</td></tr>`, '#skusTable', 5, 'skus');

    // ---- 商品媒体 ----
    const productMediaRoleNames = { cover: '封面', detail: '详情', video_cover: '视频封面', instruction: '说明' };
    paginateRows(state.productMedia, (item) => `<tr><td>${escapeHtml(productNames.get(item.productId) || item.productId)}${item.skuId ? `<br><small>${escapeHtml(skuNames.get(item.skuId) || item.skuId)}</small>` : ''}</td><td><code title="${escapeHtml(item.mediaAssetId)}">${escapeHtml(mediaNames.get(item.mediaAssetId) || item.mediaAssetId)}</code></td><td>${escapeHtml(item.mediaType)}</td><td>${escapeHtml(productMediaRoleNames[item.role] || item.role)}</td><td>${badge(item.enabled === false ? 'disabled' : 'enabled')}</td><td><button data-edit-product-media="${item._id}">编辑</button></td></tr>`, '#productMediaTable', 6, 'productMedia');

    // ---- 企业申请 ----
    paginateRows(state.businessApplications, (item) => `<tr><td>${escapeHtml(item.companyName)}<br><code>${escapeHtml(item.unifiedCode)}</code></td><td>${escapeHtml(item.contactName)} ${escapeHtml(item.contactPhoneMasked)}</td><td>${formatDate(item.submittedAt)}</td><td>${badge(item.status)}</td><td>${item.status === 'pending' ? `<button data-approve-business="${item._id}">通过</button><button data-reject-business="${item._id}">驳回</button>` : '—'}</td></tr>`, '#businessApplicationsTable', 5, 'businessApplications');

    // ---- 用户 ----
    paginateRows(state.users, (item) => `<tr><td><code>${escapeHtml(item._id)}</code></td><td>${escapeHtml(String(item.userType || 'c').toUpperCase())}</td><td><code>${escapeHtml(item.organizationId || '—')}</code></td><td>${escapeHtml(item.priceLevel || '—')}</td><td><button data-edit-user-pricing="${item._id}">调整</button></td></tr>`, '#usersTable', 5, 'users');

    // ---- 价格 ----
    paginateRows(state.prices, (item) => `<tr><td>${escapeHtml(skuNames.get(item.skuId) || item.skuId)}</td><td>${escapeHtml(item.scopeType)} ${escapeHtml(item.scopeId || '')}</td><td>${formatCents(item.amountCent)}</td><td>${escapeHtml(item.channel || 'all')}</td><td>${badge(item.status)}</td><td><button data-edit-price="${item._id}">编辑</button></td></tr>`, '#pricesTable', 6, 'prices');

    // ---- 仓库 ----
    const warehouseNames = new Map(state.warehouses.map((item) => [item._id, item.name]));
    paginateRows(state.warehouses, (item) => `<tr><td>${escapeHtml(item.name)}<br><code>${escapeHtml(item.code)}</code></td><td>${badge(item.status)}</td><td><button data-edit-warehouse="${item._id}">编辑</button></td></tr>`, '#warehousesTable', 3, 'warehouses');

    // ---- 配送区域 ----
    paginateRows(state.deliveryAreas, (item) => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml((item.regionCodes || []).length)}</td><td>${badge(item.status)}</td><td><button data-edit-delivery-area="${item._id}">编辑</button></td></tr>`, '#deliveryAreasTable', 4, 'deliveryAreas');

    // ---- 运费规则 ----
    paginateRows(state.freightRules, (item) => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(state.deliveryAreas.find((area) => area._id === item.deliveryAreaId)?.name || item.deliveryAreaId)}</td><td>${formatCents(item.baseFeeCent)}</td><td>${badge(item.status)}</td><td><button data-edit-freight="${item._id}">编辑</button></td></tr>`, '#freightRulesTable', 5, 'freightRules');

    // ---- 配送时段 ----
    paginateRows(state.deliverySlots, (item) => `<tr><td>${escapeHtml(item.name)} ${escapeHtml(item.startTime)}-${escapeHtml(item.endTime)}</td><td>${escapeHtml(state.deliveryAreas.find((area) => area._id === item.deliveryAreaId)?.name || item.deliveryAreaId)}</td><td>${escapeHtml(warehouseNames.get(item.warehouseId) || item.warehouseId || '全部')}</td><td>${badge(item.status)}</td><td><button data-edit-delivery-slot="${item._id}">编辑</button></td></tr>`, '#deliverySlotsTable', 5, 'deliverySlots');

    // ---- 库存 ----
    paginateRows(state.inventory, (item) => `<tr><td>${escapeHtml(warehouseNames.get(item.warehouseId) || item.warehouseId)}</td><td>${escapeHtml(skuNames.get(item.skuId) || item.skuId)}</td><td>${escapeHtml(item.onHand)}</td><td>${escapeHtml(item.reserved)}</td><td>${escapeHtml(item.available)}</td><td>${formatDate(item.updatedAt)}</td></tr>`, '#inventoryTable', 6, 'inventory');

    // ---- 订单 ----
    const actions = { pending_confirmation: ['picking', '开始拣货'], picking: ['shipping', '标记发货'], shipping: ['delivered', '标记送达'] };
    paginateRows(state.orders, (item) => { const action = actions[item.status]; return `<tr><td><code>${escapeHtml(item.orderNo)}</code></td><td>${badge(item.status)}</td><td>${formatCents(item.totalAmountCent)}</td><td>${escapeHtml(item.paymentStatus)}</td><td>${formatDate(item.createdAt)}</td><td>${action ? `<button data-transition-order="${item._id}" data-next-status="${action[0]}">${action[1]}</button>` : '—'}</td></tr>`; }, '#ordersTable', 6, 'orders');

    // ---- 退款 ----
    paginateRows(state.refunds, (item) => `<tr><td><code>${escapeHtml(item.refundNo)}</code></td><td><code>${escapeHtml(item.orderId)}</code></td><td>${formatCents(item.amountCent)}</td><td>${escapeHtml(item.reason || '—')}</td><td>${badge(item.status)}</td><td>${item.status === 'requested' ? `<button data-approve-refund="${item._id}">审核通过</button><button data-reject-refund="${item._id}">驳回</button>` : '—'}</td></tr>`, '#refundsTable', 6, 'refunds');

    // ---- 拼团 ----
    paginateRows(state.groupCampaigns, (item) => `<tr><td>${escapeHtml(item.title)}</td><td>${escapeHtml(skuNames.get(item.skuId) || item.skuId)}</td><td>${escapeHtml(item.groupSize)}</td><td>${formatCents(item.groupPriceCent)}</td><td>${badge(item.status)}</td><td><button data-edit-group-campaign="${item._id}">编辑</button></td></tr>`, '#groupCampaignsTable', 6, 'groupCampaigns');

    // ---- 管理员 ----
    const roleNames = new Map(state.roles.map((item) => [item._id, item.name]));
    paginateRows(state.adminUsers, (item) => `<tr><td>${escapeHtml(item.username)}<br>${escapeHtml(item.displayName)}</td><td>${escapeHtml((item.roleIds || []).map((id) => roleNames.get(id) || id).join('、'))}</td><td>${badge(item.status)}</td><td>${formatDate(item.lastLoginAt)}</td><td><button data-edit-admin-user="${item.id}">编辑</button></td></tr>`, '#adminUsersTable', 5, 'adminUsers');

    // ---- 轮播图 ----
    paginateRows(state.banners, (item) => `<tr><td>${escapeHtml(item.title)}</td><td><code>${escapeHtml(item.mediaAssetId || '未设置')}</code></td><td>${escapeHtml(item.jumpType)} ${escapeHtml(item.jumpTarget)}</td><td>${badge(item.enabled ? 'enabled' : 'disabled')}</td><td><button data-edit-banner="${item._id}">编辑</button></td></tr>`, '#bannersTable', 5, 'banners');

    // ---- 首页模块 ----
    paginateRows(state.sections, (item) => {
      const sectionLabel = ({ news: '活动头条', special: '特价专区', group: '拼团专场' })[item.moduleType] || '活动头条';
      return `<tr><td>${escapeHtml(sectionLabel)}</td><td>${escapeHtml(item.title)}</td><td>${escapeHtml(item.subtitle || '—')}</td><td><code>${escapeHtml(item.mediaAssetId || '未设置')}</code></td><td>${escapeHtml(item.jumpType)} ${escapeHtml(item.jumpTarget)}</td><td>${badge(item.enabled ? 'enabled' : 'disabled')}</td><td><button data-edit-section="${item._id}">编辑</button></td></tr>`;
    }, '#sectionsTable', 7, 'sections');

    // ---- 素材 ----
    paginateRows(state.media, (item) => `<tr><td>${escapeHtml(item.name)}${item.temporary ? ' <span class="badge">临时</span>' : ''}</td><td>${escapeHtml(item.type)}</td><td>${escapeHtml(item.source)}</td><td>${escapeHtml(item.version)}</td><td><code title="${escapeHtml(item.fileId)}">${escapeHtml(item.fileId)}</code></td><td><button data-version-media="${item._id}">新建版本</button></td></tr>`, '#mediaTable', 6, 'media');

    // ---- 操作记录 ----
    paginateRows(state.audit, (item) => `<tr><td>${formatDate(item.createdAt)}</td><td>${escapeHtml(item.action)}</td><td>${escapeHtml(item.targetType)} / ${escapeHtml(item.targetId)}</td><td>${escapeHtml(item.actorId || 'system')}</td></tr>`, '#auditTable', 4, 'audit');

    // 工具栏刷新（新增按钮）
    renderTableToolbars();
  }

  // ---------- 列表工具栏（含"新增"按钮） ----------
  function renderTableToolbars() {
    // 每个需要"新增"按钮的表格对应配置
    const toolbarMap = [
      { tbodyId: 'importsTable',    title: '批量导入商品',     addBtn: null },
      { tbodyId: 'categoriesTable', title: '商品分类列表',     addBtn: { text: '+ 新增分类', form: '#categoryForm', title: '新增分类' } },
      { tbodyId: 'productsTable',   title: '商品列表',         addBtn: { text: '+ 新增商品', form: '#productForm', title: '新增商品' } },
      { tbodyId: 'skusTable',       title: 'SKU 规格列表',     addBtn: { text: '+ 新增 SKU', form: '#skuForm', title: '新增 SKU' } },
      { tbodyId: 'productMediaTable', title: '商品媒体关联',   addBtn: { text: '+ 新增商品媒体', form: '#productMediaForm', title: '新增商品媒体关联' } },
      { tbodyId: 'usersTable',      title: '用户列表',         addBtn: null },
      { tbodyId: 'pricesTable',     title: '价格规则列表',     addBtn: { text: '+ 新增价格规则', form: '#priceForm', title: '新增价格规则' } },
      { tbodyId: 'warehousesTable',  title: '仓库列表',         addBtn: { text: '+ 新增仓库', form: '#warehouseForm', title: '新增仓库' } },
      { tbodyId: 'deliveryAreasTable', title: '配送区域列表', addBtn: { text: '+ 新增配送区域', form: '#deliveryAreaForm', title: '新增配送区域' } },
      { tbodyId: 'freightRulesTable', title: '运费规则列表',   addBtn: { text: '+ 新增运费规则', form: '#freightForm', title: '新增运费规则' } },
      { tbodyId: 'deliverySlotsTable', title: '配送时段列表', addBtn: { text: '+ 新增配送时段', form: '#deliverySlotForm', title: '新增配送时段' } },
      { tbodyId: 'inventoryTable',  title: '库存列表',         addBtn: null },
      { tbodyId: 'ordersTable',     title: '订单列表',         addBtn: null },
      { tbodyId: 'refundsTable',    title: '退款列表',         addBtn: null },
      { tbodyId: 'groupCampaignsTable', title: '拼团活动列表', addBtn: { text: '+ 新增拼团活动', form: '#groupCampaignForm', title: '新增拼团活动' } },
      { tbodyId: 'adminUsersTable', title: '管理员账号列表',   addBtn: { text: '+ 新增管理员', form: '#adminUserForm', title: '新增管理员' } },
      { tbodyId: 'bannersTable',    title: '轮播图列表',       addBtn: { text: '+ 新增轮播图', form: '#bannerForm', title: '新增轮播图' } },
      { tbodyId: 'sectionsTable',   title: '首页模块列表',     addBtn: { text: '+ 新增首页模块', form: '#sectionForm', title: '新增首页模块' } },
      { tbodyId: 'mediaTable',      title: '素材列表',         addBtn: null },
      { tbodyId: 'auditTable',      title: '操作记录',         addBtn: null },
      { tbodyId: 'businessApplicationsTable', title: '企业申请列表', addBtn: null }
    ];
    toolbarMap.forEach(({ tbodyId, title, addBtn }) => {
      const tbody = document.getElementById(tbodyId);
      if (!tbody) return;
      const wrap = tbody.closest('.table-wrap');
      if (!wrap) return;
      let toolbar = wrap.previousElementSibling;
      if (toolbar && toolbar.classList.contains('table-toolbar')) {
        // 复用
        toolbar.innerHTML = '';
      } else {
        toolbar = document.createElement('div');
        toolbar.className = 'table-toolbar';
        wrap.parentNode.insertBefore(toolbar, wrap);
      }
      const titleSpan = document.createElement('span');
      titleSpan.className = 'toolbar-title';
      titleSpan.textContent = title;
      toolbar.appendChild(titleSpan);
      if (addBtn) {
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
      }
    });
  }

  // ---------- 刷新数据 ----------
  async function refreshAll() {
    const tasks = await Promise.allSettled([
      listAll('admin.imports.list'), listAll('admin.categories.list'), listAll('admin.products.list'), listAll('admin.skus.list'),
      call('admin.roles.list', { pageSize: 100 }), call('admin.adminUsers.list', { pageSize: 100 }),
      call('admin.users.list', { pageSize: 100 }), call('admin.businessApplications.list', { pageSize: 100 }),
      call('admin.prices.list', { pageSize: 100 }), call('admin.warehouses.list', { pageSize: 100 }),
      call('admin.inventory.list', { pageSize: 100 }), call('admin.deliveryAreas.list', { pageSize: 100 }),
      call('admin.freightRules.list', { pageSize: 100 }), call('admin.deliverySlots.list', { pageSize: 100 }),
      call('admin.orders.list', { pageSize: 100 }), call('admin.refunds.list', { pageSize: 100 }),
      call('admin.groupCampaigns.list', { pageSize: 100 }), call('admin.media.list', { pageSize: 100 }),
      call('admin.productMedia.list', { pageSize: 100 }), call('admin.banners.list', { pageSize: 100 }),
      call('admin.homeSections.list', { pageSize: 100 }), call('admin.audit.list', { pageSize: 100 })
    ]);
    const failed = tasks.filter((item) => item.status === 'rejected');
    const data = tasks.map((item) => item.status === 'fulfilled' ? item.value : { rows: [] });
    [state.imports, state.categories, state.products, state.skus, state.roles, state.adminUsers, state.users, state.businessApplications, state.prices, state.warehouses, state.inventory, state.deliveryAreas, state.freightRules, state.deliverySlots, state.orders, state.refunds, state.groupCampaigns, state.media, state.productMedia, state.banners, state.sections, state.audit] = data.map((item) => item.rows || []);
    render();
    if (failed.length) message(`后台有 ${failed.length} 个列表加载失败：${failed[0].reason && failed[0].reason.message || '请检查服务端响应。'}`, true);
  }

  function panel(name) {
    const moduleKey = moduleForPanel(name);
    const currentModule = modules[moduleKey];
    document.querySelectorAll('#mainNav button').forEach((button) => button.classList.toggle('is-active', button.dataset.module === moduleKey));
    $('#moduleTabs').innerHTML = currentModule.panels.map(([panelName, label]) => `<button data-panel="${panelName}" class="${panelName === name ? 'is-active' : ''}">${label}</button>`).join('');
    $('#moduleTabs').classList.toggle('is-single', currentModule.panels.length === 1);
    document.querySelectorAll('.panel').forEach((element) => element.classList.toggle('is-active', element.dataset.panel === name));
    $('#moduleEyebrow').textContent = currentModule.label;
    $('#panelTitle').textContent = panelTitles[name] || '运营管理后台';
    message('');
  }

  // ---------- 编辑填充（打开模态框） ----------
  function fillCategory(id) {
    const item = state.categories.find((row) => row._id === id); if (!item) return;
    const form = $('#categoryForm');
    form.elements.id.value = item._id; form.elements.name.value = item.name; form.elements.imageMediaId.value = item.imageMediaId || ''; form.elements.sort.value = item.sort || 0; form.elements.status.value = item.status;
    openModal(form, '编辑分类');
  }
  function fillBanner(id) {
    const item = state.banners.find((row) => row._id === id); if (!item) return;
    const form = $('#bannerForm'); form.elements.id.value = item._id; form.elements.title.value = item.title; form.elements.mediaAssetId.value = item.mediaAssetId || ''; form.elements.jumpType.value = item.jumpType || 'none'; form.elements.jumpTarget.value = item.jumpTarget || ''; form.elements.sort.value = item.sort || 0; form.elements.enabled.checked = item.enabled !== false;
    openModal(form, '编辑轮播图');
  }
  function fillSection(id) {
    const item = state.sections.find((row) => row._id === id); if (!item) return;
    const form = $('#sectionForm'); form.elements.id.value = item._id; form.elements.moduleType.value = item.moduleType || 'news'; form.elements.title.value = item.title; form.elements.subtitle.value = item.subtitle || ''; form.elements.linkText.value = item.linkText || '更多'; form.elements.mediaAssetId.value = item.mediaAssetId || ''; form.elements.jumpType.value = item.jumpType || 'none'; form.elements.jumpTarget.value = item.jumpTarget || ''; form.elements.sort.value = item.sort || 0; form.elements.enabled.checked = item.enabled !== false;
    openModal(form, '编辑首页模块');
  }
  function startMediaVersion(id) {
    const item = state.media.find((row) => row._id === id); if (!item) return;
    const form = $('#mediaForm'); form.reset(); form.elements.replacesMediaAssetId.value = item._id; form.elements.name.value = `${item.name} v${Number(item.version || 1) + 1}`; form.elements.type.value = item.type || 'image'; form.elements.source.value = item.source || 'admin_upload'; form.elements.temporary.checked = item.temporary === true; form.elements.mimeType.value = item.mimeType || ''; form.elements.sizeBytes.value = 0; form.elements.startAt.value = String(item.startAt || '').slice(0, 16); form.elements.endAt.value = String(item.endAt || '').slice(0, 16); const targetPlatforms = item.targetPlatforms && item.targetPlatforms.length ? item.targetPlatforms : ['miniapp', 'web']; form.querySelectorAll('input[name="targetPlatforms"]').forEach((input) => { input.checked = targetPlatforms.includes(input.value); });
    $('#mediaVersionHint').textContent = `正在为"${item.name}"创建版本 ${Number(item.version || 1) + 1}；请填写新的 CloudBase 文件 ID，旧素材会保留。`;
    openModal(form, '新建素材版本');
  }
  function fillProduct(id) {
    const item = state.products.find((row) => row._id === id); if (!item) return;
    const form = $('#productForm'); form.elements.id.value = item._id; form.elements.name.value = item.name; form.elements.categoryId.value = item.categoryId; form.elements.brand.value = item.brand || ''; form.elements.origin.value = item.origin || ''; form.elements.frozenTemperature.value = item.frozenTemperature || '-18℃'; form.elements.coverMediaId.value = item.coverMediaId || ''; form.elements.sort.value = item.sort || 0;
    openModal(form, '编辑商品');
  }
  function fillProductMedia(id) {
    const item = state.productMedia.find((row) => row._id === id); if (!item) return;
    const form = $('#productMediaForm'); form.elements.id.value = item._id; form.elements.productId.value = item.productId; form.elements.skuId.value = item.skuId || ''; form.elements.mediaAssetId.value = item.mediaAssetId; form.elements.mediaType.value = item.mediaType; form.elements.role.value = item.role || 'detail'; form.elements.sort.value = item.sort || 0; form.elements.enabled.checked = item.enabled !== false;
    openModal(form, '编辑商品媒体');
  }
  function fillSku(id) {
    const item = state.skus.find((row) => row._id === id); if (!item) return;
    const form = $('#skuForm'); form.elements.id.value = item._id; form.elements.productId.value = item.productId; form.elements.specName.value = item.specName; form.elements.packageUnit.value = item.packageUnit || ''; form.elements.netWeight.value = item.netWeight || ''; form.elements.weightUnit.value = item.weightUnit || ''; form.elements.piecesPerCase.value = item.piecesPerCase || 0; form.elements.barcode.value = item.barcode || ''; form.elements.status.value = item.status;
    openModal(form, '编辑 SKU');
  }
  function fillPrice(id) {
    const item = state.prices.find((row) => row._id === id); if (!item) return;
    const form = $('#priceForm'); form.elements.id.value = item._id; form.elements.skuId.value = item.skuId; form.elements.scopeType.value = item.scopeType; form.elements.scopeId.value = item.scopeId || ''; form.elements.channel.value = item.channel || 'all'; form.elements.amountCent.value = item.amountCent; form.elements.priority.value = item.priority || 0; form.elements.status.value = item.status;
    openModal(form, '编辑价格规则');
  }
  function fillUserPricing(id) {
    const item = state.users.find((row) => row._id === id); if (!item) return;
    const form = $('#userPricingForm'); form.elements.id.value = item._id; form.elements.userType.value = item.userType || 'c'; form.elements.organizationId.value = item.organizationId || ''; form.elements.priceLevel.value = item.priceLevel || '';
    openModal(form, '调整用户身份');
  }
  function fillWarehouse(id) {
    const item = state.warehouses.find((row) => row._id === id); if (!item) return;
    const form = $('#warehouseForm'); form.elements.id.value = item._id; form.elements.code.value = item.code; form.elements.name.value = item.name; form.elements.address.value = item.address || ''; form.elements.status.value = item.status; form.elements.sort.value = item.sort || 0;
    openModal(form, '编辑仓库');
  }
  function fillDeliveryArea(id) {
    const item = state.deliveryAreas.find((row) => row._id === id); if (!item) return;
    const form = $('#deliveryAreaForm'); form.elements.id.value = item._id; form.elements.name.value = item.name; form.elements.regionCodes.value = (item.regionCodes || []).join('\n'); form.elements.warehouseIds.value = (item.warehouseIds || []).join('\n'); form.elements.status.value = item.status;
    openModal(form, '编辑配送区域');
  }
  function fillFreight(id) {
    const item = state.freightRules.find((row) => row._id === id); if (!item) return;
    const form = $('#freightForm'); form.elements.id.value = item._id; form.elements.name.value = item.name; form.elements.deliveryAreaId.value = item.deliveryAreaId; form.elements.warehouseId.value = item.warehouseId || ''; form.elements.baseFeeCent.value = item.baseFeeCent || 0; form.elements.additionalFeeCent.value = item.additionalFeeCent || 0; form.elements.freeThresholdCent.value = item.freeThresholdCent || 0; form.elements.status.value = item.status;
    openModal(form, '编辑运费规则');
  }
  function fillDeliverySlot(id) {
    const item = state.deliverySlots.find((row) => row._id === id); if (!item) return;
    const form = $('#deliverySlotForm'); form.elements.id.value = item._id; form.elements.name.value = item.name; form.elements.deliveryAreaId.value = item.deliveryAreaId; form.elements.warehouseId.value = item.warehouseId || ''; form.elements.startTime.value = item.startTime; form.elements.endTime.value = item.endTime; form.elements.status.value = item.status;
    openModal(form, '编辑配送时段');
  }
  function fillGroupCampaign(id) {
    const item = state.groupCampaigns.find((row) => row._id === id); if (!item) return;
    const form = $('#groupCampaignForm'); form.elements.id.value = item._id; form.elements.title.value = item.title; form.elements.skuId.value = item.skuId; form.elements.groupSize.value = item.groupSize; form.elements.durationMinutes.value = item.durationMinutes; form.elements.groupPriceCent.value = item.groupPriceCent; form.elements.targetUserType.value = item.targetUserType || 'all'; form.elements.status.value = item.status;
    openModal(form, '编辑拼团活动');
  }
  function fillAdminUser(id) {
    const item = state.adminUsers.find((row) => row.id === id); if (!item) return;
    const form = $('#adminUserForm'); form.elements.id.value = item.id; form.elements.username.value = item.username; form.elements.displayName.value = item.displayName; form.elements.password.value = ''; form.elements.roleIds.value = (item.roleIds || []).join('\n'); form.elements.status.value = item.status;
    openModal(form, '编辑管理员');
  }

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
    $('#toggleLoginPassword').addEventListener('change', (event) => {
      $('#loginPassword').type = event.currentTarget.checked ? 'text' : 'password';
    });
    $('#toggleChangePassword').addEventListener('change', (event) => {
      $('#changeOwnPasswordForm').querySelectorAll('input[type="password"], input[type="text"]').forEach((input) => { input.type = event.currentTarget.checked ? 'text' : 'password'; });
    });
    $('#changeOwnPasswordForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const currentPassword = form.get('currentPassword'); const newPassword = form.get('newPassword'); const confirmPassword = form.get('confirmPassword');
      if (newPassword !== confirmPassword) return message('两次输入的新密码不一致。', true);
      try {
        const result = await call('admin.password.change', { currentPassword, newPassword });
        if (!result.passwordChanged) throw new Error('密码修改未完成。');
        api.setToken(''); state.admin = null; event.currentTarget.reset(); showLogin(); loginMessage('密码修改成功，请使用新密码重新登录。');
      } catch (error) { message(error.message || '密码修改失败。', true); }
    });
    $('#loginForm').addEventListener('submit', async (event) => {
      event.preventDefault(); loginMessage('正在安全登录…');
      try {
        const form = new FormData(event.currentTarget); const result = await api.call('admin.login', { username: form.get('username'), password: form.get('password') });
        api.setToken(result.token); state.admin = result.admin;
        if (continueToRequestedPage()) return;
        showAdmin(); await refreshAll(); loginMessage('');
      } catch (error) { loginMessage(error.message || '登录失败。', true); }
    });
    $('#mainNav').addEventListener('click', (event) => { const button = event.target.closest('button[data-module]'); if (button) panel(button.dataset.defaultPanel); });
    $('#moduleTabs').addEventListener('click', (event) => { const button = event.target.closest('button[data-panel]'); if (button) panel(button.dataset.panel); });
    $('#taskMetrics').addEventListener('click', (event) => { const button = event.target.closest('button[data-go-panel]'); if (button) panel(button.dataset.goPanel); });
    $('#logoutButton').addEventListener('click', async () => { try { await call('admin.logout', {}); } catch (_) {} showLogin(); });
    $('#stagingFile').addEventListener('change', async (event) => { const file = event.target.files[0]; if (!file) return; try { await stageFile(file); await refreshAll(); message('商品草稿已写入审核队列。'); } catch (error) { message(error.message || '导入失败。', true); } finally { event.target.value = ''; } });
    $('#activateImportsButton').addEventListener('click', async (event) => {
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

    // 表单 submit handler（DOM 移动到模态框后事件仍有效）
    $('#categoryForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.categories.upsert', { id: form.get('id'), name: form.get('name'), imageMediaId: form.get('imageMediaId'), sort: Number(form.get('sort')), status: form.get('status') }); closeModal(); await refreshAll(); message('分类已保存。'); } catch (error) { message(error.message, true); } });
    $('#bannerForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.banners.upsert', { id: form.get('id'), title: form.get('title'), mediaAssetId: form.get('mediaAssetId'), jumpType: form.get('jumpType'), jumpTarget: form.get('jumpTarget'), sort: Number(form.get('sort')), enabled: form.get('enabled') === 'on' }); closeModal(); await refreshAll(); message('轮播图配置已保存。'); } catch (error) { message(error.message, true); } });
    $('#sectionForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.homeSections.upsert', { id: form.get('id'), moduleType: form.get('moduleType'), title: form.get('title'), subtitle: form.get('subtitle'), linkText: form.get('linkText'), mediaAssetId: form.get('mediaAssetId'), jumpType: form.get('jumpType'), jumpTarget: form.get('jumpTarget'), sort: Number(form.get('sort')), enabled: form.get('enabled') === 'on' }); closeModal(); await refreshAll(); message('首页模块已保存。'); } catch (error) { message(error.message, true); } });
    $('#productForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.products.upsert', { id: form.get('id'), name: form.get('name'), categoryId: form.get('categoryId'), brand: form.get('brand'), origin: form.get('origin'), frozenTemperature: form.get('frozenTemperature'), coverMediaId: form.get('coverMediaId'), sort: Number(form.get('sort')) }); closeModal(); await refreshAll(); message('商品信息已保存。'); } catch (error) { message(error.message, true); } });
    $('#productMediaForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.productMedia.upsert', { id: form.get('id'), productId: form.get('productId'), skuId: form.get('skuId'), mediaAssetId: form.get('mediaAssetId'), mediaType: form.get('mediaType'), role: form.get('role'), sort: Number(form.get('sort')), enabled: form.get('enabled') === 'on' }); closeModal(); await refreshAll(); message('商品媒体关联已保存；小程序详情页会按启用状态读取。'); } catch (error) { message(error.message, true); } });
    $('#skuForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.skus.upsert', { id: form.get('id'), productId: form.get('productId'), specName: form.get('specName'), packageUnit: form.get('packageUnit'), netWeight: form.get('netWeight'), weightUnit: form.get('weightUnit'), piecesPerCase: Number(form.get('piecesPerCase')), barcode: form.get('barcode'), status: form.get('status') }); closeModal(); await refreshAll(); message('SKU 信息已保存。'); } catch (error) { message(error.message, true); } });
    $('#userPricingForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.users.setPricingProfile', { id: form.get('id'), userType: form.get('userType'), organizationId: form.get('organizationId'), priceLevel: form.get('priceLevel') }); closeModal(); await refreshAll(); message('用户身份与价格等级已保存。'); } catch (error) { message(error.message, true); } });
    $('#priceForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.prices.upsert', { id: form.get('id'), skuId: form.get('skuId'), scopeType: form.get('scopeType'), scopeId: form.get('scopeId') || '', channel: form.get('channel'), amountCent: Number(form.get('amountCent')), priority: Number(form.get('priority')), status: form.get('status') }); closeModal(); await refreshAll(); message('价格规则已保存；用户端仅在登录后由服务端报价。'); } catch (error) { message(error.message, true); } });
    $('#warehouseForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.warehouses.upsert', { id: form.get('id'), code: form.get('code'), name: form.get('name'), address: form.get('address'), sort: Number(form.get('sort')), status: form.get('status') }); closeModal(); await refreshAll(); message('仓库已保存。'); } catch (error) { message(error.message, true); } });
    $('#deliveryAreaForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.deliveryAreas.upsert', { id: form.get('id'), name: form.get('name'), regionCodes: splitLines(form.get('regionCodes')), warehouseIds: splitLines(form.get('warehouseIds')), status: form.get('status') }); closeModal(); await refreshAll(); message('配送区域已保存。'); } catch (error) { message(error.message, true); } });
    $('#freightForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.freightRules.upsert', { id: form.get('id'), name: form.get('name'), deliveryAreaId: form.get('deliveryAreaId'), warehouseId: form.get('warehouseId'), baseFeeCent: Number(form.get('baseFeeCent')), additionalFeeCent: Number(form.get('additionalFeeCent')), freeThresholdCent: Number(form.get('freeThresholdCent')), status: form.get('status') }); closeModal(); await refreshAll(); message('运费规则已保存。'); } catch (error) { message(error.message, true); } });
    $('#inventoryForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.inventory.adjust', { warehouseId: form.get('warehouseId'), skuId: form.get('skuId'), change: Number(form.get('change')), reason: form.get('reason'), idempotencyKey: newIdempotencyKey() }); event.currentTarget.reset(); await refreshAll(); message('库存已调整并写入流水。'); } catch (error) { message(error.message, true); } });
    $('#deliverySlotForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.deliverySlots.upsert', { id: form.get('id'), name: form.get('name'), deliveryAreaId: form.get('deliveryAreaId'), warehouseId: form.get('warehouseId') || '', startTime: form.get('startTime'), endTime: form.get('endTime'), status: form.get('status') }); closeModal(); await refreshAll(); message('配送时段已保存。'); } catch (error) { message(error.message, true); } });
    $('#groupCampaignForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.groupCampaigns.upsert', { id: form.get('id'), title: form.get('title'), skuId: form.get('skuId'), groupSize: Number(form.get('groupSize')), durationMinutes: Number(form.get('durationMinutes')), groupPriceCent: Number(form.get('groupPriceCent')), targetUserType: form.get('targetUserType'), status: form.get('status') }); closeModal(); await refreshAll(); message('拼团活动已保存；支付确认与成团仍由后续受控链路处理。'); } catch (error) { message(error.message, true); } });
    $('#adminUserForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { const payload = { id: form.get('id'), username: form.get('username'), displayName: form.get('displayName'), roleIds: splitLines(form.get('roleIds')), status: form.get('status') }; if (form.get('password')) payload.password = form.get('password'); closeModal(); await call('admin.adminUsers.upsert', payload); await refreshAll(); message('管理员账号已保存。'); } catch (error) { message(error.message, true); } });
    $('#mediaSearch').addEventListener('input', (event) => { const term = event.target.value.trim().toLowerCase(); document.querySelectorAll('#mediaTable tbody tr').forEach((tr) => { tr.style.display = !term || tr.textContent.toLowerCase().includes(term) ? '' : 'none'; }); });
    $('#mediaForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const replacesMediaAssetId = form.get('replacesMediaAssetId'); const type = form.get('type'); const selectedFile = form.get('uploadFile'); let fileId = form.get('fileId'); let mimeType = form.get('mimeType'); let sizeBytes = Number(form.get('sizeBytes')); try { if (selectedFile && selectedFile.size) { const uploaded = await api.uploadMediaFile(selectedFile, type); fileId = uploaded.fileId; mimeType = uploaded.mimeType; sizeBytes = uploaded.sizeBytes; } if (!fileId) throw new Error('请选择本地文件，或填写已有的 CloudBase 文件 ID。'); const payload = { name: form.get('name'), type, source: form.get('source'), temporary: form.get('temporary') === 'on', targetPlatforms: form.getAll('targetPlatforms'), startAt: form.get('startAt'), endAt: form.get('endAt'), fileId, mimeType, sizeBytes }; await call(replacesMediaAssetId ? 'admin.media.createVersion' : 'admin.media.upsert', { ...payload, replacesMediaAssetId }); closeModal(); event.currentTarget.reset(); $('#mediaVersionHint').textContent = '素材已通过管理员会话上传并登记；替换文件请使用右侧"新建版本"，旧素材不会被覆盖。'; await refreshAll(); message(replacesMediaAssetId ? '素材新版本已登记，请将新的素材 ID 配置到对应分类、商品或内容。' : '素材已上传并登记，可复制素材 ID 配置到轮播图或商品。'); } catch (error) { message(error.message || '素材上传登记失败。', true); } });

    // 全局点击代理（表格行操作 + 工具栏新增按钮 + 分页按钮）
    $('.workspace').addEventListener('click', async (event) => {
      const target = event.target;
      // 分页
      const pageBtn = target.closest('[data-page]');
      if (pageBtn) {
        const page = Number(pageBtn.dataset.page);
        const key = pageBtn.dataset.pageKey;
        state.pageMap[key] = page;
        render();
        return;
      }
      // 新增按钮
      const addBtn = target.closest('[data-add-form]');
      if (addBtn) {
        const form = $(addBtn.dataset.addForm);
        if (form) {
          form.reset();
          if (form.elements.id) form.elements.id.value = '';
          openModal(form, addBtn.dataset.addTitle || '新增');
        }
        return;
      }
      const approve = target.closest('[data-approve-import]'); const approveBusiness = target.closest('[data-approve-business]'); const rejectBusiness = target.closest('[data-reject-business]'); const approveRefund = target.closest('[data-approve-refund]'); const rejectRefund = target.closest('[data-reject-refund]'); const editCategory = target.closest('[data-edit-category]'); const editBanner = target.closest('[data-edit-banner]'); const editSection = target.closest('[data-edit-section]'); const versionMedia = target.closest('[data-version-media]'); const editProduct = target.closest('[data-edit-product]'); const editProductMedia = target.closest('[data-edit-product-media]'); const editSku = target.closest('[data-edit-sku]'); const editUserPricing = target.closest('[data-edit-user-pricing]'); const editPrice = target.closest('[data-edit-price]'); const editWarehouse = target.closest('[data-edit-warehouse]'); const editDeliveryArea = target.closest('[data-edit-delivery-area]'); const editFreight = target.closest('[data-edit-freight]'); const editDeliverySlot = target.closest('[data-edit-delivery-slot]'); const editGroupCampaign = target.closest('[data-edit-group-campaign]'); const editAdminUser = target.closest('[data-edit-admin-user]'); const transitionOrder = target.closest('[data-transition-order]'); const publish = target.closest('[data-publish-product]'); const publishSku = target.closest('[data-publish-sku]'); const offsaleSku = target.closest('[data-offsale-sku]');
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
        if (approve) { await call('admin.imports.approve', { id: approve.dataset.approveImport }); await refreshAll(); message('草稿已生成商品和 SKU 草稿，请继续补齐信息并审核上架。'); }
        if (approveBusiness) { await call('admin.businessApplications.review', { id: approveBusiness.dataset.approveBusiness, decision: 'approved' }); await refreshAll(); message('企业申请已通过；请按需补充价格等级。'); }
        if (rejectBusiness) { await call('admin.businessApplications.review', { id: rejectBusiness.dataset.rejectBusiness, decision: 'rejected' }); await refreshAll(); message('企业申请已驳回。'); }
        if (approveRefund) { await call('admin.refunds.review', { id: approveRefund.dataset.approveRefund, decision: 'approved' }); await refreshAll(); message('退款已审核通过，等待退款渠道通知确认。'); }
        if (rejectRefund) { await call('admin.refunds.review', { id: rejectRefund.dataset.rejectRefund, decision: 'rejected' }); await refreshAll(); message('退款申请已驳回。'); }
        if (publish) { await call('admin.products.setStatus', { id: publish.dataset.publishProduct, status: 'on_sale' }); await refreshAll(); message('商品已上架。'); }
        if (publishSku) { await call('admin.skus.setStatus', { id: publishSku.dataset.publishSku, status: 'on_sale' }); await refreshAll(); message('SKU 已上架。'); }
        if (offsaleSku) { await call('admin.skus.setStatus', { id: offsaleSku.dataset.offsaleSku, status: 'off_sale' }); await refreshAll(); message('SKU 已下架。'); }
        if (transitionOrder) { await call('admin.orders.transition', { id: transitionOrder.dataset.transitionOrder, status: transitionOrder.dataset.nextStatus }); await refreshAll(); message('订单履约状态已更新。'); }
      } catch (error) { message(error.message || '操作失败。', true); }
    });

    // 分页跳转输入
    $('.workspace').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      const input = event.target.closest('input[data-page-key]');
      if (!input) return;
      const page = Number(input.value);
      const key = input.dataset.pageKey;
      if (!Number.isFinite(page) || page < 1) return;
      state.pageMap[key] = page;
      render();
    });

    // 模态框关闭
    $('#modalClose').addEventListener('click', closeModal);
    $('#modalOverlay').addEventListener('click', (event) => { if (event.target.id === 'modalOverlay') closeModal(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeModal(); });
  }

  async function init() {
    bind();
    if (!api.getToken()) {
      loginMessage('正在检查 CloudBase 服务连接…');
      try {
        await api.call('health', {});
        loginMessage(requestedNext() === 'simple'
          ? 'CloudBase 服务连接正常。请登录，成功后会自动进入简单后台。'
          : 'CloudBase 服务连接正常，请输入管理员账号和密码。');
      } catch (error) {
        loginMessage(`CloudBase 服务连接失败：${error.message || '请稍后重试。'}`, true);
      }
      return;
    }
    try {
      state.admin = (await call('admin.me', {})).admin;
      if (continueToRequestedPage()) return;
      showAdmin(); await refreshAll();
    }
    catch (_) {
      showLogin();
      try {
        await api.call('health', {});
        loginMessage(requestedNext() === 'simple'
          ? '登录状态已失效，请重新登录；成功后会自动进入简单后台。'
          : '登录状态已失效，CloudBase 服务连接正常，请重新登录。');
      } catch (error) {
        loginMessage(`CloudBase 服务连接失败：${error.message || '请稍后重试。'}`, true);
      }
    }
  }
  init();
}(window, document));
