(function adminConsole(global, document) {
  const api = global.MengshixianAdminApi;
  const PAGE_NAME = global.PAGE_NAME || 'overview';
  const PAGE_SIZE = 15;
  const PAGE_WINDOW = 5;

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
    categories: [['categories', 'admin.categories.list'], ['media', 'admin.media.list']],
    imports:    [['imports', 'admin.imports.list']],
    pricing:    [['prices', 'admin.prices.list'], ['skus', 'admin.skus.list'], ['products', 'admin.products.list']],
    orders:     [['orders', 'admin.orders.list']],
    refunds:    [['refunds', 'admin.refunds.list'], ['orders', 'admin.orders.list']],
    warehouses: [['warehouses', 'admin.warehouses.list']],
    areas:      [['deliveryAreas', 'admin.deliveryAreas.list'], ['warehouses', 'admin.warehouses.list']],
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
    users:      [['users', 'admin.users.list'], ['organizations', 'admin.users.organizations']],
    banners:    [['banners', 'admin.banners.list'], ['media', 'admin.media.list'], ['products', 'admin.products.list'], ['categories', 'admin.categories.list']],
    sections:   [['sections', 'admin.homeSections.list'], ['media', 'admin.media.list'], ['products', 'admin.products.list'], ['categories', 'admin.categories.list']],
    media:      [['media', 'admin.media.list']],
    groups:     [['groupCampaigns', 'admin.groupCampaigns.list'], ['skus', 'admin.skus.list'], ['products', 'admin.products.list']],
    access: [],
    audit: [['audit', 'admin.audit.list']]
  };

  const state = {
    admin: null, roles: [], adminUsers: [], categories: [], products: [], skus: [],
    users: [], organizations: [], businessApplications: [], prices: [], warehouses: [], inventory: [],
    deliveryAreas: [], freightRules: [], deliverySlots: [], orders: [], refunds: [],
    groupCampaigns: [], imports: [], media: [], productMedia: [], banners: [],
    sections: [], audit: [], pricingTargetNames: {},
    pageMap: {}, loadStates: {}
  };

  const $ = (selector) => document.querySelector(selector);
  const escapeHtml = (value) => String(value === undefined || value === null ? '' : value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const formatDate = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
  const formatCents = (value) => `¥${(Number(value || 0) / 100).toFixed(2)}`;
  const formatRegionPreview = (codes) => {
    const arr = Array.isArray(codes) ? codes : [];
    if (!arr.length) return '—';
    const g = typeof window !== 'undefined' ? window : globalThis;
    const map = g.MENGSHIXIAN_REGIONS_MAP || {};
    if (!Object.keys(map).length) return arr.length + ' 个编码';
    const names = arr.slice(0, 4).map((code) => (map[code] && map[code].district) || code);
    const suffix = arr.length > 4 ? ' 等' + arr.length + ' 个' : '';
    return escapeHtml(names.join('、')) + suffix;
  };
  const splitLines = (value) => String(value || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const newIdempotencyKey = () => global.crypto && global.crypto.randomUUID ? global.crypto.randomUUID() : `admin-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  // ========== 状态中文映射 ==========
  const STATUS_MAP = {
    enabled: '启用', disabled: '停用', active: '生效', inactive: '未生效',
    draft: '草稿', pending: '待处理', pending_payment: '待支付',
    on_sale: '上架', off_sale: '下架',
    pending_confirmation: '待确认', picking: '拣货中', shipping: '运输中',
    delivered: '已送达', cancelled: '已取消', completed: '已完成',
    requested: '申请中', reviewing: '审核中', processing: '处理中',
    refunded: '已退款', rejected: '已驳回',
    approved: '已通过',
    staged: '待审核', imported: '已入库',
    grouped: '已成团',
    unpaid: '未支付', paid: '已支付', refunded_payment: '已退款',
    not_required: '无需在线支付', demo_not_required: '演示免支付',
    offline_pending: '未收款', offline_partial: '部分收款', offline_paid: '已收齐',
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
    if (global.MengshixianCategoryGuide) global.MengshixianCategoryGuide.onOpen(form, state);
    if (global.MengshixianContentGuide) global.MengshixianContentGuide.onOpen(form, state);
    if (global.MengshixianOperationForms) global.MengshixianOperationForms.onOpen(form, state);
    if (global.MengshixianPricingTargets) global.MengshixianPricingTargets.onOpen(form);
    if (global.MengshixianProductFormGuide) global.MengshixianProductFormGuide.onOpen(form, state);
    if (global.MengshixianCustomerGuide) global.MengshixianCustomerGuide.onOpen(form, state);
    if (form.getAttribute('id') === 'mediaForm') {
      $('#mediaVersionHint').textContent = '从电脑选择图片或视频（最大 24 MB）。后台会自动上传并登记；替换素材请使用“新建版本”，旧素材保留。';
    }
    const overlay = $('#modalOverlay');
    const body = $('#modalBody');
    $('#modalTitle').textContent = title || '编辑';
    if (!form.__modalAnchor) form.__modalAnchor = form.parentNode;
    if (form.parentNode !== body) body.appendChild(form);
    modalFormRef = form;
    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }
  function closeModal() {
    const overlay = $('#modalOverlay');
    overlay.classList.remove('is-open');
    overlay.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    if (modalFormRef) {
      delete modalFormRef.dataset.editingId;
      if (modalFormRef.__modalAnchor) modalFormRef.__modalAnchor.appendChild(modalFormRef);
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
    if (PAGE_NAME === 'overview') global.MengshixianAdminOverview.render(state);
    if (PAGE_NAME !== 'overview' && PAGE_NAME !== 'access') global.MengshixianAdminPageSummary.render(PAGE_NAME, state);

    global.MengshixianAdminTables.render(state, { escapeHtml, translateStatus, badge, formatDate, formatCents, formatRegionPreview, paginateRows });

    renderTableToolbars();
  }

  function renderTableToolbars() {
    const toolbarMap = [
      { tbodyId: 'importsTable',    addBtn: null },
      { tbodyId: 'categoriesTable', addBtn: { text: '+ 新增分类', form: '#categoryForm', title: '新增分类' } },
      { tbodyId: 'productsTable',   addBtn: null },
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
      { tbodyId: 'bannersTable',    addBtn: { text: '+ 新增轮播图', form: '#bannerForm', title: '新增轮播图' } },
      { tbodyId: 'sectionsTable',   addBtn: { text: '+ 新增首页模块', form: '#sectionForm', title: '新增首页模块' } },
      { tbodyId: 'mediaTable',      addBtn: { text: '+ 上传素材', form: '#mediaForm', title: '上传新素材' } },
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
    loads.forEach(([key]) => { state.loadStates[key] = 'loading'; });
    if (PAGE_NAME === 'overview') render();
    try {

    const tasks = await Promise.allSettled(
      loads.map(([/*stateKey*/, action]) => global.MengshixianAdminPaging.listAll(call, action).then((r) => ({ action, rows: r.rows })))
    );

    let firstFail = null;
    tasks.forEach((result, idx) => {
      const [stateKey] = loads[idx];
      if (result.status === 'fulfilled') {
        state[stateKey] = result.value.rows;
        state.loadStates[stateKey] = 'ready';
      } else {
        state[stateKey] = [];
        state.loadStates[stateKey] = 'failed';
        if (!firstFail) firstFail = result.reason;
      }
    });

    if (PAGE_NAME === 'pricing' && state.loadStates.prices === 'ready' && global.MengshixianPricingTargets) {
      try {
        state.pricingTargetNames = await global.MengshixianPricingTargets.loadNames(call, state.prices);
        state.loadStates.pricingTargetNames = 'ready';
      } catch (error) {
        state.pricingTargetNames = {};
        state.loadStates.pricingTargetNames = 'failed';
        if (!firstFail) firstFail = error;
      }
    }

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
  function fillCategory(id) { const item = state.categories.find((row) => row._id === id); if (!item) return; const form = $('#categoryForm'); form.elements.id.value = item._id; form.dataset.editingId = id; form.elements.name.value = item.name; form.elements.imageMediaId.value = item.imageMediaId || ''; form.elements.sort.value = item.sort || 0; form.elements.status.value = item.status; openModal(form, '编辑分类'); }
  function fillBanner(id) { const item = state.banners.find((row) => row._id === id); if (!item) return; const form = $('#bannerForm'); form.elements.id.value = item._id; form.dataset.editingId = id; form.elements.title.value = item.title; form.elements.mediaAssetId.value = item.mediaAssetId || ''; form.elements.jumpType.value = item.jumpType || 'none'; form.elements.jumpTarget.value = item.jumpTarget || ''; form.elements.sort.value = item.sort || 0; form.elements.enabled.checked = item.enabled !== false; openModal(form, '编辑轮播图'); }
  function fillSection(id) { const item = state.sections.find((row) => row._id === id); if (!item) return; const form = $('#sectionForm'); form.elements.id.value = item._id; form.dataset.editingId = id; form.elements.moduleType.value = item.moduleType || 'news'; form.elements.title.value = item.title; form.elements.subtitle.value = item.subtitle || ''; form.elements.linkText.value = item.linkText || '更多'; form.elements.mediaAssetId.value = item.mediaAssetId || ''; form.elements.jumpType.value = item.jumpType || 'none'; form.elements.jumpTarget.value = item.jumpTarget || ''; form.elements.sort.value = item.sort || 0; form.elements.enabled.checked = item.enabled !== false; openModal(form, '编辑首页模块'); }
  function startMediaVersion(id) { const item = state.media.find((row) => row._id === id); if (!item) return; const form = $('#mediaForm'); form.reset(); form.elements.replacesMediaAssetId.value = item._id; form.elements.name.value = `${item.name} v${Number(item.version || 1) + 1}`; form.elements.type.value = item.type || 'image'; form.elements.source.value = item.source || 'admin_upload'; form.elements.temporary.checked = item.temporary === true; form.elements.startAt.value = String(item.startAt || '').slice(0, 16); form.elements.endAt.value = String(item.endAt || '').slice(0, 16); const targetPlatforms = item.targetPlatforms && item.targetPlatforms.length ? item.targetPlatforms : ['miniapp', 'web']; form.querySelectorAll('input[name="targetPlatforms"]').forEach((input) => { input.checked = targetPlatforms.includes(input.value); }); openModal(form, '新建素材版本'); }
  function fillProduct(id) { const item = state.products.find((row) => row._id === id); if (!item) return; const form = $('#productForm'); form.elements.id.value = item._id; form.dataset.editingId = id; form.elements.name.value = item.name; form.elements.categoryId.value = item.categoryId; form.elements.brand.value = item.brand || ''; form.elements.origin.value = item.origin || ''; form.elements.frozenTemperature.value = item.frozenTemperature || '-18℃'; form.elements.coverMediaId.value = item.coverMediaId || ''; form.elements.sort.value = item.sort || 0; openModal(form, '编辑商品'); }
  function fillProductMedia(id) { const item = state.productMedia.find((row) => row._id === id); if (!item) return; const form = $('#productMediaForm'); form.elements.id.value = item._id; form.dataset.editingId = id; form.elements.productId.value = item.productId; form.elements.skuId.value = item.skuId || ''; form.elements.mediaAssetId.value = item.mediaAssetId; form.elements.mediaType.value = item.mediaType; form.elements.role.value = item.role || 'detail'; form.elements.sort.value = item.sort || 0; form.elements.enabled.checked = item.enabled !== false; openModal(form, '编辑商品媒体'); }
  function fillSku(id) { const item = state.skus.find((row) => row._id === id); if (!item) return; const form = $('#skuForm'); form.elements.id.value = item._id; form.dataset.editingId = id; form.elements.productId.value = item.productId; form.elements.specName.value = item.specName; form.elements.packageUnit.value = item.packageUnit || ''; form.elements.netWeight.value = item.netWeight || ''; form.elements.weightUnit.value = item.weightUnit || ''; form.elements.piecesPerCase.value = item.piecesPerCase || 0; form.elements.barcode.value = item.barcode || ''; form.elements.status.value = item.status; openModal(form, '编辑 SKU'); }
  function fillUserPricing(id) { const item = state.users.find((row) => row._id === id); if (!item) return; const form = $('#userPricingForm'); form.elements.id.value = item._id; form.dataset.editingId = id; form.elements.userType.value = item.userType || 'c'; form.elements.organizationId.value = item.organizationId || ''; form.elements.priceLevel.value = item.priceLevel || ''; openModal(form, '调整用户身份'); }
  function fillPrice(id) { const item = state.prices.find((row) => row._id === id); if (!item) return; const form = $('#priceForm'); form.elements.id.value = item._id; form.dataset.editingId = id; form.elements.skuId.value = item.skuId; form.elements.scopeType.value = item.scopeType; form.elements.scopeId.value = item.scopeId || ''; form.elements.scopeId.dataset.savedValue = item.scopeId || ''; form.elements.channel.value = item.channel || 'all'; form.elements.amountCent.value = item.amountCent; form.elements.priority.value = item.priority || 0; form.elements.status.value = item.status; openModal(form, '编辑价格规则'); }
  function fillWarehouse(id) { const item = state.warehouses.find((row) => row._id === id); if (!item) return; const form = $('#warehouseForm'); form.elements.id.value = item._id; form.dataset.editingId = id; form.elements.code.value = item.code; form.elements.name.value = item.name; form.elements.address.value = item.address || ''; form.elements.status.value = item.status; form.elements.sort.value = item.sort || 0; openModal(form, '编辑仓库'); }
  function fillDeliveryArea(id) { const item = state.deliveryAreas.find((row) => row._id === id); if (!item) return; const form = $('#deliveryAreaForm'); form.elements.id.value = item._id; form.dataset.editingId = id; form.elements.name.value = item.name; form.elements.regionCodes.value = (item.regionCodes || []).join('\n'); const namesTa = form.querySelector('textarea[name="regionNames"]'); if (namesTa) namesTa.value = (item.regionNames || []).join('\n'); form.elements.warehouseIds.value = (item.warehouseIds || []).join('\n'); form.elements.status.value = item.status; openModal(form, '编辑配送区域'); setTimeout(function(){ if(form.__syncRegionCodes) form.__syncRegionCodes(); }, 50); }
  function fillFreight(id) { const item = state.freightRules.find((row) => row._id === id); if (!item) return; const form = $('#freightForm'); form.elements.id.value = item._id; form.dataset.editingId = id; form.elements.name.value = item.name; form.elements.deliveryAreaId.value = item.deliveryAreaId; form.elements.warehouseId.value = item.warehouseId || ''; form.elements.baseFeeCent.value = item.baseFeeCent || 0; form.elements.additionalFeeCent.value = item.additionalFeeCent || 0; form.elements.freeThresholdCent.value = item.freeThresholdCent || 0; form.elements.status.value = item.status; openModal(form, '编辑运费规则'); }
  function fillDeliverySlot(id) { const item = state.deliverySlots.find((row) => row._id === id); if (!item) return; const form = $('#deliverySlotForm'); form.elements.id.value = item._id; form.dataset.editingId = id; form.elements.name.value = item.name; form.elements.deliveryAreaId.value = item.deliveryAreaId; form.elements.warehouseId.value = item.warehouseId || ''; form.elements.startTime.value = item.startTime; form.elements.endTime.value = item.endTime; form.elements.status.value = item.status; openModal(form, '编辑配送时段'); }
  function fillGroupCampaign(id) { const item = state.groupCampaigns.find((row) => row._id === id); if (!item) return; const form = $('#groupCampaignForm'); form.elements.id.value = item._id; form.dataset.editingId = id; form.elements.title.value = item.title; form.elements.skuId.value = item.skuId; form.elements.groupSize.value = item.groupSize; form.elements.durationMinutes.value = item.durationMinutes; form.elements.groupPriceCent.value = item.groupPriceCent; form.elements.targetUserType.value = item.targetUserType || 'all'; form.elements.status.value = item.status; openModal(form, '编辑拼团活动'); }

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

    if (global.MengshixianAdminAccount) global.MengshixianAdminAccount.bindLogout({ call, clearSession: () => api.setToken(''), message });

    if (PAGE_NAME === 'imports' && global.MengshixianImportWorkflow) {
      global.MengshixianImportWorkflow.start({ call, refresh: refreshAll, message });
    }

    // 表单 submit
    const catForm = document.getElementById('categoryForm');
    if (catForm) catForm.addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { const id = event.currentTarget.dataset.editingId || form.get('id'); const existing = state.categories.find((row) => row._id === id); const status = form.get('status'); if (status === 'enabled' && (!existing || existing.status !== 'enabled') && !global.MengshixianAdminOperationsConfirm.ask('contentEnable', { title: form.get('name'), impact: '启用后该分类及其下商品可能对顾客可见。' })) return; await call('admin.categories.upsert', { id, name: form.get('name'), imageMediaId: form.get('imageMediaId'), sort: Number(form.get('sort')), status }); closeModal(); await refreshAll(); message('分类已保存。'); } catch (error) { message(error.message, true); } });

    const bannerForm = document.getElementById('bannerForm');
    if (bannerForm) bannerForm.addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { const id = event.currentTarget.dataset.editingId || form.get('id'); const existing = state.banners.find((row) => row._id === id); const enabled = form.get('enabled') === 'on'; if (enabled && (!existing || existing.enabled === false) && !global.MengshixianAdminOperationsConfirm.ask('contentEnable', { title: form.get('title'), impact: '启用后顾客可能在首页看到此轮播图。' })) return; await call('admin.banners.upsert', { id, title: form.get('title'), mediaAssetId: form.get('mediaAssetId'), jumpType: form.get('jumpType'), jumpTarget: form.get('jumpTarget'), sort: Number(form.get('sort')), enabled }); closeModal(); await refreshAll(); message('轮播图配置已保存。'); } catch (error) { message(error.message, true); } });

    const sectionForm = document.getElementById('sectionForm');
    if (sectionForm) sectionForm.addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { const id = event.currentTarget.dataset.editingId || form.get('id'); const existing = state.sections.find((row) => row._id === id); const enabled = form.get('enabled') === 'on'; if (enabled && (!existing || existing.enabled === false) && !global.MengshixianAdminOperationsConfirm.ask('contentEnable', { title: form.get('title'), impact: '启用后顾客可能在首页看到此首页模块。' })) return; await call('admin.homeSections.upsert', { id, moduleType: form.get('moduleType'), title: form.get('title'), subtitle: form.get('subtitle'), linkText: form.get('linkText'), mediaAssetId: form.get('mediaAssetId'), jumpType: form.get('jumpType'), jumpTarget: form.get('jumpTarget'), sort: Number(form.get('sort')), enabled }); closeModal(); await refreshAll(); message('首页模块已保存。'); } catch (error) { message(error.message, true); } });

    const productForm = document.getElementById('productForm');
    if (productForm) productForm.addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { const id = event.currentTarget.dataset.editingId || form.get('id'); const existing = state.products.find((row) => row._id === id) || {}; if (existing.status === 'on_sale' && !global.confirm(`商品「${existing.name || form.get('name')}」正在销售，保存后顾客可见资料可能立即变化。继续保存？`)) return; await call('admin.products.upsert', { id, spuCode: existing.spuCode || '', name: form.get('name'), subtitle: existing.subtitle || '', categoryId: form.get('categoryId'), brand: form.get('brand'), origin: form.get('origin'), storageType: existing.storageType || 'frozen', frozenTemperature: form.get('frozenTemperature'), shelfLifeDays: existing.shelfLifeDays || 0, description: existing.description || '', coverMediaId: form.get('coverMediaId'), audienceType: existing.audienceType || 'all', sort: Number(form.get('sort')) }); closeModal(); await refreshAll(); message('商品信息已保存。'); } catch (error) { message(error.message, true); } });

    const productMediaForm = document.getElementById('productMediaForm');
    if (productMediaForm) productMediaForm.addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { const id = event.currentTarget.dataset.editingId || form.get('id'); const existing = state.productMedia.find((row) => row._id === id); const enabled = form.get('enabled') === 'on'; if (enabled && (!existing || existing.enabled === false) && !global.MengshixianAdminOperationsConfirm.ask('contentEnable', { title: (state.media.find((row) => row._id === form.get('mediaAssetId')) || {}).name || '该素材', impact: '启用后此素材可能立即出现在商品详情或作为规格图展示。' })) return; await call('admin.productMedia.upsert', { id, productId: form.get('productId'), skuId: form.get('skuId'), mediaAssetId: form.get('mediaAssetId'), mediaType: form.get('mediaType'), role: form.get('role'), sort: Number(form.get('sort')), enabled }); closeModal(); await refreshAll(); message('商品媒体关联已保存。'); } catch (error) { message(error.message, true); } });

    const skuForm = document.getElementById('skuForm');
    if (skuForm) skuForm.addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { const id = event.currentTarget.dataset.editingId || form.get('id'); const existing = state.skus.find((row) => row._id === id); const status = form.get('status'); const record = existing || { specName: form.get('specName') }; if (status === 'on_sale' && (!existing || existing.status !== 'on_sale') && !global.MengshixianAdminOperationsConfirm.ask('skuPublish', record)) return; if (status === 'off_sale' && existing && existing.status === 'on_sale' && !global.MengshixianAdminOperationsConfirm.ask('skuOffsale', record)) return; await call('admin.skus.upsert', { id, productId: form.get('productId'), specName: form.get('specName'), packageUnit: form.get('packageUnit'), netWeight: form.get('netWeight'), weightUnit: form.get('weightUnit'), piecesPerCase: Number(form.get('piecesPerCase')), barcode: form.get('barcode'), status }); closeModal(); await refreshAll(); message('SKU 信息已保存。'); } catch (error) { message(error.message, true); } });

    const userPricingForm = document.getElementById('userPricingForm');
    if (userPricingForm) userPricingForm.addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { if (!global.MengshixianCustomerGuide || !global.MengshixianCustomerGuide.confirm(event.currentTarget, state)) return; await call('admin.users.setPricingProfile', { id: event.currentTarget.dataset.editingId || form.get('id'), userType: form.get('userType'), organizationId: form.get('organizationId') || '', priceLevel: form.get('priceLevel') }); closeModal(); await refreshAll(); message('用户身份与价格等级已保存。'); } catch (error) { message(error.message, true); } });

    const priceForm = document.getElementById('priceForm');
    if (priceForm) priceForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      try {
        const amounts = global.MengshixianOperationForms.values(event.currentTarget);
        if (!global.MengshixianOperationForms.ask(event.currentTarget, state)) return;
        await call('admin.prices.upsert', { id: event.currentTarget.dataset.editingId || form.get('id'), skuId: form.get('skuId'), scopeType: form.get('scopeType'), scopeId: form.get('scopeId') || '', channel: form.get('channel'), amountCent: amounts.amountCent, priority: Number(form.get('priority')), status: form.get('status') });
        closeModal(); await refreshAll(); message('价格规则已保存。');
      } catch (error) { message(error.message, true); }
    });

    const warehouseForm = document.getElementById('warehouseForm');
    if (warehouseForm) warehouseForm.addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { const id = event.currentTarget.dataset.editingId || form.get('id'); const existing = state.warehouses.find((row) => row._id === id); const status = form.get('status'); if (status === 'enabled' && (!existing || existing.status !== 'enabled') && !global.MengshixianAdminOperationsConfirm.ask('contentEnable', { title: form.get('name'), impact: '启用后该仓库将参与库存与配送匹配。' })) return; await call('admin.warehouses.upsert', { id, code: form.get('code'), name: form.get('name'), address: form.get('address'), sort: Number(form.get('sort')), status }); closeModal(); await refreshAll(); message('仓库已保存。'); } catch (error) { message(error.message, true); } });

    const deliveryAreaForm = document.getElementById('deliveryAreaForm');
    if (deliveryAreaForm) deliveryAreaForm.addEventListener('submit', async (event) => { event.preventDefault(); if (!window.MengshixianOperationForms.ask(event.currentTarget, state)) return; const form = new FormData(event.currentTarget); try { await call('admin.deliveryAreas.upsert', { id: event.currentTarget.dataset.editingId || form.get('id'), name: form.get('name'), regionCodes: splitLines(form.get('regionCodes')), regionNames: splitLines(form.get('regionNames')), warehouseIds: splitLines(form.get('warehouseIds')), status: form.get('status') }); closeModal(); await refreshAll(); message('配送区域已保存。'); } catch (error) { message(error.message, true); } });

    const freightForm = document.getElementById('freightForm');
    if (freightForm) freightForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      try {
        const amounts = global.MengshixianOperationForms.values(event.currentTarget);
        if (!global.MengshixianOperationForms.ask(event.currentTarget, state)) return;
        await call('admin.freightRules.upsert', { id: event.currentTarget.dataset.editingId || form.get('id'), name: form.get('name'), deliveryAreaId: form.get('deliveryAreaId'), warehouseId: form.get('warehouseId'), ...amounts, status: form.get('status') });
        closeModal(); await refreshAll(); message('运费规则已保存。');
      } catch (error) { message(error.message, true); }
    });

    const deliverySlotForm = document.getElementById('deliverySlotForm');
    if (deliverySlotForm) deliverySlotForm.addEventListener('submit', async (event) => { event.preventDefault(); if (!window.MengshixianOperationForms.ask(event.currentTarget, state)) return; const form = new FormData(event.currentTarget); try { await call('admin.deliverySlots.upsert', { id: event.currentTarget.dataset.editingId || form.get('id'), name: form.get('name'), deliveryAreaId: form.get('deliveryAreaId'), warehouseId: form.get('warehouseId') || '', startTime: form.get('startTime'), endTime: form.get('endTime'), status: form.get('status') }); closeModal(); await refreshAll(); message('配送时段已保存。'); } catch (error) { message(error.message, true); } });
  const inventoryForm = document.getElementById('inventoryForm');
  if (inventoryForm) inventoryForm.addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(inventoryForm); try { await call('admin.inventory.adjust', { warehouseId: form.get('warehouseId'), skuId: form.get('skuId'), change: Number(form.get('change')), reason: form.get('reason'), idempotencyKey: newIdempotencyKey() }); inventoryForm.reset(); closeModal(); await refreshAll(); message('库存已调整并写入流水。'); } catch (error) { message(error.message, true); } });

    const groupCampaignForm = document.getElementById('groupCampaignForm');
    if (groupCampaignForm) groupCampaignForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      try {
        const amounts = global.MengshixianOperationForms.values(event.currentTarget);
        if (!global.MengshixianOperationForms.ask(event.currentTarget, state)) return;
        await call('admin.groupCampaigns.upsert', { id: event.currentTarget.dataset.editingId || form.get('id'), title: form.get('title'), skuId: form.get('skuId'), groupSize: Number(form.get('groupSize')), durationMinutes: Number(form.get('durationMinutes')), groupPriceCent: amounts.groupPriceCent, targetUserType: form.get('targetUserType'), status: form.get('status') });
        closeModal(); await refreshAll(); message('拼团活动已保存。');
      } catch (error) { message(error.message, true); }
    });


    const mediaSearch = document.getElementById('mediaSearch');
    if (mediaSearch) mediaSearch.addEventListener('input', (event) => { global.__mediaKeyword = event.target.value.trim().toLowerCase(); state.pageMap.media = 1; render(); });

    const mediaForm = document.getElementById('mediaForm');
    if (mediaForm && global.MengshixianMediaGuide) global.MengshixianMediaGuide.mount({ api, call, refresh: refreshAll, message, closeModal, assets: () => state.media });

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
          delete form.dataset.editingId;
          if (form.elements.id) form.elements.id.value = '';
          if (['bannerForm', 'sectionForm'].includes(form.getAttribute('id')) && form.elements.enabled) form.elements.enabled.checked = false;
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

      try {
        if (approve) { const id = approve.dataset.approveImport; if (!global.MengshixianAdminOperationsConfirm.ask('importApprove', state.imports.find((row) => row._id === id))) return; await call('admin.imports.approve', { id }); await refreshAll(); message('已生成商品草稿。请点击该行“补齐商品资料”，核对图片、规格和价格后再决定上架。'); }
        if (approveBusiness) { const id = approveBusiness.dataset.approveBusiness; if (!global.MengshixianAdminOperationsConfirm.ask('businessApprove', state.businessApplications.find((row) => row._id === id))) return; await call('admin.businessApplications.review', { id, decision: 'approved' }); await refreshAll(); message('企业申请已通过。'); }
        if (rejectBusiness) { const id = rejectBusiness.dataset.rejectBusiness; if (!global.MengshixianAdminOperationsConfirm.ask('businessReject', state.businessApplications.find((row) => row._id === id))) return; await call('admin.businessApplications.review', { id, decision: 'rejected' }); await refreshAll(); message('企业申请已驳回。'); }
        if (approveRefund) { const id = approveRefund.dataset.approveRefund; if (!global.MengshixianAdminOperationsConfirm.ask('refundApprove', state.refunds.find((row) => row._id === id))) return; await call('admin.refunds.review', { id, decision: 'approved' }); await refreshAll(); message('退款已审核通过。'); }
        if (rejectRefund) { const id = rejectRefund.dataset.rejectRefund; if (!global.MengshixianAdminOperationsConfirm.ask('refundReject', state.refunds.find((row) => row._id === id))) return; await call('admin.refunds.review', { id, decision: 'rejected' }); await refreshAll(); message('退款申请已驳回。'); }
        if (publish) { const id = publish.dataset.publishProduct; if (!global.MengshixianAdminOperationsConfirm.ask('productPublish', state.products.find((row) => row._id === id))) return; await call('admin.products.setStatus', { id, status: 'on_sale' }); await refreshAll(); message('商品已上架。'); }
        if (publishSku) { const id = publishSku.dataset.publishSku; if (!global.MengshixianAdminOperationsConfirm.ask('skuPublish', state.skus.find((row) => row._id === id))) return; await call('admin.skus.setStatus', { id, status: 'on_sale' }); await refreshAll(); message('SKU 已上架。'); }
        if (offsaleSku) { const id = offsaleSku.dataset.offsaleSku; if (!global.MengshixianAdminOperationsConfirm.ask('skuOffsale', state.skus.find((row) => row._id === id))) return; await call('admin.skus.setStatus', { id, status: 'off_sale' }); await refreshAll(); message('SKU 已下架。'); }
        if (transitionOrder) { const id = transitionOrder.dataset.transitionOrder; const status = transitionOrder.dataset.nextStatus; if (!global.MengshixianAdminOperationsConfirm.ask('orderTransition', state.orders.find((row) => row._id === id), { status })) return; await call('admin.orders.transition', { id, status }); await refreshAll(); message('订单履约状态已更新。'); }
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
    const meta = global.MengshixianAdminPages.pages[PAGE_NAME] || global.MengshixianAdminPages.pages.overview;
    const eyebrow = document.getElementById('moduleEyebrow');
    const title = document.getElementById('panelTitle');
    if (eyebrow) eyebrow.textContent = meta.groupLabel;
    if (title) title.textContent = meta.title;

    bind();
    if (PAGE_NAME === 'orders' && global.MengshixianAdminOrderReceipts) {
      global.MengshixianAdminOrderReceipts.mount({ call, getAdmin: () => state.admin, onSaved: refreshAll });
    }
    const productKeyword = document.getElementById('productKeyword');
    if (productKeyword) productKeyword.addEventListener('input', () => {
      global.__productKeyword = productKeyword.value.trim().toLowerCase();
      state.pageMap.products = 1;
      render();
    });
    // 订单筛选
    const orderFilterBtn = document.getElementById('orderFilterBtn');
    const orderFilterReset = document.getElementById('orderFilterReset');
    const orderKeyword = document.getElementById('orderFilterKeyword');
    const orderStatus = document.getElementById('orderFilterStatus');
    window.__orderFilters = { keyword: '', status: '' };
    if (orderFilterBtn) orderFilterBtn.addEventListener('click', () => {
      window.__orderFilters.keyword = orderKeyword ? orderKeyword.value : '';
      window.__orderFilters.status = orderStatus ? orderStatus.value : '';
      render();
    });
    if (orderFilterReset) orderFilterReset.addEventListener('click', () => {
      if (orderKeyword) orderKeyword.value = '';
      if (orderStatus) orderStatus.value = '';
      window.__orderFilters = { keyword: '', status: '' };
      render();
    });
    try {
      state.admin = (await call('admin.me', {})).admin;
      if (global.MengshixianAdminAccount) global.MengshixianAdminAccount.setAdmin(state.admin);
      const connection = $('#adminConnectionState');
      if (connection) connection.innerHTML = '<i></i>已连接';
      await refreshAll();
      if (PAGE_NAME === 'access' && global.MengshixianStaffPage) await global.MengshixianStaffPage.mount({ call, admin: state.admin, message });
    } catch (error) {
      if (isAuthError(error)) {
        api.setToken('');
        global.location.replace('login.html');
      } else {
        message(`服务连接异常：${error && error.message || '请稍后刷新重试。'}`, true);
        const connection = $('#adminConnectionState');
        if (connection) { connection.classList.add('is-error'); connection.innerHTML = '<i></i>连接异常'; }
        if (global.MengshixianAdminAccount) global.MengshixianAdminAccount.setAdmin(null);
        try { await refreshAll(); } catch (_) {}
      }
    }
  }
  init();
}(window, document));







