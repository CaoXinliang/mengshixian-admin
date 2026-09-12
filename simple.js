// 梦食鲜运营后台：普通员工的日常任务（订单/商品/价格/图片/规格/退款/库存/客户审核）。
// 复用统一登录与管理员会话；低频技术配置收进“高级设置”。
// 商品列表点「修改」进入独立编辑页：预览在左、表单在右；顾客视角与小程序顾客端同一公开接口。
(function attachSimpleAdmin(global) {
  'use strict';

  const api = global.MengshixianAdminApi;
  const sessionPolicy = global.MengshixianAdminSessionPolicy || { shouldClearSession: (error) => error && (error.code === 'ADMIN_SESSION_EXPIRED' || error.code === 'ADMIN_UNAUTHORIZED') };
  const config = global.MENGSHIXIAN_ADMIN_CONFIG || {};
  const $ = (sel) => document.querySelector(sel);

  const state = {
    me: null,
    products: [], skus: [], prices: [], categories: [], media: [],
    orders: [], refunds: [], inventory: [], warehouses: [], businessApplications: [], users: [],
    deliveryAreas: [], freightRules: [], deliverySlots: [], pickupSites: [], groupCampaigns: [], creditAccounts: [], receivables: [], statements: [], inquiries: [], bundles: [], groups: [], groupMembers: [], groupRefundTasks: [], couponTemplates: [], couponGrants: [], membershipLevels: [], pointsRules: [], pointsAccounts: [], pointsLedger: [], reviews: [], invoices: [], storedValueRecords: [], storedValueLedger: [], webAccounts: [], roles: [], permissionCatalog: [], auditLogs: [], inventoryLedger: [], configVersions: [], loadErrors: {},
    urlMap: {}, imagePickId: '',
    orderFilter: 'todo', orderPage: 1, orderKeyword: '', orderPaymentFilter: 'all', orderFulfillmentFilter: 'all', orderQueryRows: null, selectedOrderIds: [], refundFilter: 'all', productKeyword: '', productPage: 1, inventoryKeyword: '', inventoryWarehouseFilter: 'all', inventoryPage: 1, customerFilter: 'pending', customerMode: 'applications',
    batchCatalogPreview: null,
    editor: null, editorMediaRows: [],
    live: { rows: [], categories: [], activeCategory: '', focusId: '', viewer: 'c', detailId: '', detailSkuId: '', detailQty: 1, detailCache: {}, syncedAt: '' }
  };

  const ORDER_STATUS_TEXT = {
    pending_payment: '待支付', pending_confirmation: '待确认', picking: '拣货中',
    shipping: '配送中', delivered: '已送达', completed: '已完成', cancelled: '已取消'
  };
  const ORDER_FLOW = ['pending_confirmation', 'picking', 'shipping'];
  const PAY_TEXT = { unpaid: '未支付', paid: '已支付', refunded: '已退款', demo_not_required: '无需支付' };
  const PAY_METHOD_TEXT = { demo: '演示支付', wechat: '微信支付', offline: '线下支付' };
  const REFUND_STATUS_TEXT = {
    requested: '待处理', approved: '已同意', rejected: '已驳回',
    processing: '退款处理中', awaiting_manual_refund: '待人工提交退款', channel_pending: '已提交退款渠道', succeeded: '退款成功', failed: '退款失败'
  };
  const PRODUCT_STATUS_TEXT = { draft: '草稿', pending_review: '待审核', on_sale: '上架中', off_sale: '已下架', archived: '已归档' };
  const BUSINESS_STATUS_TEXT = { pending: '待审核', approved: '已通过', rejected: '已驳回' };
  const PAGE_META = {
    dashboard: ['日常经营', '今日待办', '先处理需要马上完成的事情。'],
    orders: ['订单履约', '订单处理', '系统只提供当前订单可以执行的下一步。'],
    products: ['商品经营', '商品管理', '在一个地方完成商品资料、规格、价格和上下架。'],
    editor: ['商品经营', '商品编辑', '修改后先核对左侧顾客视角，再保存。'],
    inventory: ['商品履约', '库存管理', '按商品规格入库或出库，系统自动计算可售数量。'],
    refunds: ['顾客服务', '退款售后', '优先处理新申请，重要操作都会再次确认。'],
    customers: ['顾客经营', '客户管理', '查看顾客概况并处理企业采购申请。'],
    delivery: ['履约设置', '配送设置', '统一管理配送区域、费用、时段和自提点。'],
    marketing: ['商品推广', '营销活动', '只管理小程序已经支持的拼团活动。'],
    settings: ['账号与帮助', '系统设置', '修改自己的密码，或进入管理员高级设置。']
  };

  // ---------- 基础工具 ----------
  function esc(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function yuan(cent) { return '¥' + (Number(cent || 0) / 100).toFixed(2); }
  function toCents(text) {
    const value = Number(text);
    if (!Number.isFinite(value) || value < 0) return NaN;
    return Math.round(value * 100);
  }
  function newIdempotencyKey() {
    return global.crypto && typeof global.crypto.randomUUID === 'function'
      ? global.crypto.randomUUID()
      : `admin-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function localInputTime(iso) {
    const d = iso ? new Date(iso) : null;
    if (!d || Number.isNaN(d.getTime())) return '';
    const offset = d.getTimezoneOffset() * 60000;
    return new Date(d.getTime() - offset).toISOString().slice(0, 16);
  }
  function showNotice(text, isError) {
    const el = $('#notice');
    el.className = 'notice ' + (isError ? 'err' : 'ok');
    el.textContent = text;
    clearTimeout(showNotice._timer);
    showNotice._timer = setTimeout(() => { el.className = 'notice'; el.textContent = ''; }, isError ? 10000 : 4000);
  }
  function friendlyError(error) {
    const raw = String(error && error.message || '操作失败，请重试');
    return raw
      .replace(/商品所属分类必须先启用。?/g, '这个商品的分类尚未启用，请联系管理员启用分类后再上架。')
      .replace(/至少需要一个已上架 SKU 才能上架商品。?/g, '请先添加至少一个完整规格，再上架商品。')
      .replace(/SKU ID/g, '商品规格')
      .replace(/商品 ID/g, '商品')
      .replace(/仓库 ID/g, '仓库')
      .replace(/素材 ID/g, '图片或视频');
  }
  let busy = false;
  async function guard(fn, doneText) {
    if (busy) return;
    busy = true;
    try {
      await fn();
      if (doneText) showNotice(doneText);
    } catch (error) {
      showNotice(friendlyError(error), true);
      if (sessionPolicy.shouldClearSession(error)) { api.clearSession(); redirectToFullLogin('session_expired'); }
    } finally { busy = false; }
  }

  // ---------- 云存储临时链接（缩略图用） ----------
  let thumbApp = null; let thumbAuthTried = false;
  async function tempUrls(fileIds) {
    const unique = [...new Set(fileIds.filter(Boolean))];
    const missing = unique.filter((id) => !(id in state.urlMap));
    if (!missing.length) return;
    if (!global.cloudbase) return;
    if (!thumbApp) thumbApp = global.cloudbase.init({ env: config.envId, region: 'ap-shanghai' });
    const resolve = async () => {
      const res = await thumbApp.getTempFileURL({ fileList: missing });
      (res && res.fileList || []).forEach((f) => {
        const id = f.fileID || f.fileId || f.fileIdList;
        if (id && f.tempFileURL) state.urlMap[id] = f.tempFileURL;
      });
    };
    try { await resolve(); }
    catch (_) {
      if (!thumbAuthTried) {
        thumbAuthTried = true;
        try { await thumbApp.auth().signInAnonymously(); await resolve(); } catch (_) { return; }
      }
    }
  }
  function coverUrlOf(product) {
    const asset = state.media.find((m) => m._id === product.coverMediaId);
    return asset ? state.urlMap[asset.fileId] || '' : '';
  }

  // ---------- 登录 ----------
  function redirectToFullLogin(reason) {
    const query = new URLSearchParams({ next: 'simple' });
    if (reason) query.set('reason', reason);
    global.location.replace(`index.html?${query.toString()}`);
  }
  function enterApp() {
    $('#loginView').style.display = 'none';
    $('#appView').style.display = 'grid';
    $('#topBar').style.display = 'flex';
    $('#whoami').textContent = state.me ? `你好，${state.me.displayName || state.me.username}` : '';
  }
  function showBootFailure(error) {
    $('#appView').style.display = 'none'; $('#topBar').style.display = 'none'; $('#loginView').style.display = '';
    $('#loginView').innerHTML = `<h1>后台暂时无法进入</h1><p class="hint">${esc(friendlyError(error))}</p><p class="hint">登录状态已保留，请检查网络后重试。</p><button class="act" id="bootRetry">重新加载</button>`;
    $('#bootRetry').addEventListener('click', () => {
      $('#loginView').innerHTML = '<h1>正在进入运营后台</h1><p class="hint">正在检查登录状态，请稍候。</p>';
      boot();
    });
  }
  async function boot() {
    if (!api.getToken()) return redirectToFullLogin('login_required');
    try {
      const me = await api.call('admin.me');
      state.me = me && me.admin;
      await api.call('health');
      await reloadAll();
      enterApp();
      refreshLive();
    } catch (error) {
      if (sessionPolicy.shouldClearSession(error)) {
        api.clearSession();
        return redirectToFullLogin('session_expired');
      }
      showBootFailure(error);
    }
  }
  $('#logoutBtn').addEventListener('click', () => guard(async () => {
    try { await api.call('admin.logout'); } catch (_) { /* 本地退出不受影响 */ }
    api.clearSession();
    global.location.replace('index.html');
  }));

  // ---------- 数据加载 ----------
  async function list(action, params = {}) {
    if (!global.MengshixianAdminPaging) throw new Error('数据列表加载组件未就绪，请刷新页面。');
    const result = await global.MengshixianAdminPaging.listAll(api.call, action, { params });
    return result && Array.isArray(result.rows) ? result.rows : [];
  }
  async function optionalList(action, params = {}) {
    try { delete state.loadErrors[action]; return await list(action, params); }
    catch (error) { state.loadErrors[action] = error && error.message || '没有权限读取'; return []; }
  }
  async function reloadCore() {
    const [products, skus, prices, categories, media, warehouses, inventory, bundles] = await Promise.all([
      optionalList('admin.products.list'), optionalList('admin.skus.list'), optionalList('admin.prices.list'),
      optionalList('admin.categories.list'), optionalList('admin.media.list'), optionalList('admin.warehouses.list'), optionalList('admin.inventory.list'), optionalList('admin.bundles.list')
    ]);
    state.products = products; state.skus = skus; state.prices = prices;
    state.categories = categories; state.media = media; state.warehouses = warehouses; state.inventory = inventory; state.bundles = bundles;
    state.live.detailCache = {};
    await tempUrls([
      ...media.map((m) => m.fileId),
      ...products.map((p) => { const asset = media.find((m) => m._id === p.coverMediaId); return asset && asset.fileId; })
    ]);
  }
  async function reloadTrade() {
    const [orders, refunds, invoices] = await Promise.all([optionalList('admin.orders.list'), optionalList('admin.refunds.list'), optionalList('admin.invoices.list')]);
    state.orders = orders;
    state.orderQueryRows = null;
    state.refunds = refunds;
    state.invoices = invoices;
  }
  async function reloadCustomers() {
    const [applications, users, creditAccounts, receivables, statements, inquiries, membershipLevels, pointsRules, reviews, webAccounts] = await Promise.all([optionalList('admin.businessApplications.list'), optionalList('admin.users.list'), optionalList('admin.creditAccounts.list'), optionalList('admin.receivables.list'), optionalList('admin.statements.list'), optionalList('admin.inquiries.list'), optionalList('admin.membershipLevels.list'), optionalList('admin.points.rules.list'), optionalList('admin.reviews.list'), optionalList('admin.webAccounts.list')]);
    state.businessApplications = applications; state.users = users; state.creditAccounts = creditAccounts; state.receivables = receivables; state.statements = statements; state.inquiries = inquiries; state.membershipLevels = membershipLevels; state.pointsRules = pointsRules; state.reviews = reviews; state.webAccounts = webAccounts;
  }
  async function reloadOperations() {
    const [areas, rules, slots, pickupSites, campaigns, groups, refundTasks, couponTemplates, storedValueRecords, roles, auditLogs] = await Promise.all([
      optionalList('admin.deliveryAreas.list'), optionalList('admin.freightRules.list'),
      optionalList('admin.deliverySlots.list'), optionalList('admin.pickupSites.list'), optionalList('admin.groupCampaigns.list'), optionalList('admin.groups.list'), optionalList('admin.groups.refundTasks'), optionalList('admin.couponTemplates.list'), optionalList('admin.storedValue.list'), optionalList('admin.roles.list'), optionalList('admin.audit.list')
    ]);
    state.deliveryAreas = areas; state.freightRules = rules; state.deliverySlots = slots; state.pickupSites = pickupSites; state.groupCampaigns = campaigns; state.groups = groups; state.groupRefundTasks = refundTasks; state.couponTemplates = couponTemplates; state.storedValueRecords = storedValueRecords; state.roles = roles; state.auditLogs = auditLogs;
    try {
      const catalog = await api.call('admin.permissions.catalog');
      state.permissionCatalog = Array.isArray(catalog && catalog.rows) ? catalog.rows : Array.isArray(catalog && catalog.permissions) ? catalog.permissions : [];
      delete state.loadErrors['admin.permissions.catalog'];
    } catch (error) {
      state.permissionCatalog = [];
      state.loadErrors['admin.permissions.catalog'] = error && error.message || '没有权限读取';
    }
  }
  async function reloadAll() { await Promise.all([reloadCore(), reloadTrade(), reloadCustomers(), reloadOperations()]); await loadInventoryLedger(); renderAll(); }
  function renderAll() { renderDashboard(); renderOrders(); renderProducts(); renderRefunds(); renderInventory(); renderCustomers(); renderDelivery(); renderMarketing(); renderCommerceExtensions(); renderGovernance(); }

  // ---------- 视图切换 ----------
  $('#tabs').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-view]');
    if (!btn) return;
    if (btn.dataset.view !== 'editor') state.editor = null;
    switchView(btn.dataset.view);
  });
  function switchView(name) {
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('is-active', b.dataset.view === name));
    document.querySelectorAll('section.view').forEach((s) => s.classList.toggle('is-active', s.dataset.view === name));
    const meta = PAGE_META[name] || PAGE_META.dashboard;
    $('#pageKicker').textContent = meta[0]; $('#pageTitle').textContent = meta[1]; $('#pageDescription').textContent = meta[2];
    $('#pageReady').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
    global.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---------- 今日待办 ----------
  function renderDashboard() {
    const dashboardDependencies = ['admin.orders.list', 'admin.refunds.list', 'admin.inventory.list', 'admin.businessApplications.list'];
    const dashboardError = dashboardDependencies.map(action => state.loadErrors[action]).find(Boolean);
    if (dashboardError) {
      $('#statGrid').innerHTML = `<div class="empty">待办数据不完整，不能把未读取的数据当作 0：${esc(dashboardError)}<br><button class="act" id="dashboardLoadRetry">重试</button></div>`;
      $('#pendingBadge').textContent = '部分待办暂不可用'; $('#todaySummary').innerHTML = '';
      const retry = $('#dashboardLoadRetry'); if (retry) retry.addEventListener('click', () => guard(async () => { await reloadAll(); }, '待办数据已刷新'));
      return;
    }
    const counts = { pending_confirmation: 0, picking: 0, shipping: 0 };
    state.orders.forEach((o) => { if (counts[o.status] !== undefined) counts[o.status] += 1; });
    const refundTodo = state.refunds.filter((r) => r.status === 'requested').length;
    const customerTodo = state.businessApplications.filter((item) => item.status === 'pending').length;
    const lowStock = state.inventory.filter((item) => Number(item.available || 0) <= 10).length;
    const todayKey = new Date().toLocaleDateString('zh-CN');
    const todayOrders = state.orders.filter((item) => item.createdAt && new Date(item.createdAt).toLocaleDateString('zh-CN') === todayKey);
    const activeProducts = state.products.filter((item) => item.status === 'on_sale').length;
    const cards = [
      { view: 'orders', filter: 'pending_confirmation', num: counts.pending_confirmation, label: '新订单，待接单', alert: counts.pending_confirmation > 0 },
      { view: 'orders', filter: 'picking', num: counts.picking, label: '拣货中，待发货', alert: false },
      { view: 'orders', filter: 'shipping', num: counts.shipping, label: '配送中', alert: false },
      { view: 'refunds', num: refundTodo, label: '待处理的退款申请', alert: refundTodo > 0 },
      { view: 'inventory', num: lowStock, label: '可售不超过10件', alert: lowStock > 0 },
      { view: 'customers', num: customerTodo, label: '待审核的企业客户', alert: customerTodo > 0 }
    ];
    $('#statGrid').innerHTML = cards.map((c) => `
      <div class="stat-card ${c.alert ? 'is-urgent' : ''}" data-go="${c.view}" data-filter="${c.filter || ''}">
        <div class="num ${c.alert ? 'alert' : ''}">${c.num}</div>
        <div class="label">${esc(c.label)}</div>
      </div>`).join('');
    const pendingTotal = counts.pending_confirmation + counts.picking + counts.shipping + refundTodo + customerTodo + lowStock;
    $('#pendingBadge').textContent = pendingTotal ? `今天有 ${pendingTotal} 项需要关注` : '今天没有紧急待办';
    $('#todaySummary').innerHTML = `<span>今日订单<strong>${todayOrders.length}</strong></span><span>在售商品<strong>${activeProducts}</strong></span>`;
    const hour = new Date().getHours();
    $('#dashboardGreeting').textContent = hour < 12 ? '上午好，先处理这些' : hour < 18 ? '下午好，先处理这些' : '晚上好，看看还有哪些没完成';
  }
  $('#statGrid').addEventListener('click', (event) => {
    const card = event.target.closest('[data-go]');
    if (!card) return;
    if (card.dataset.filter) { state.orderFilter = card.dataset.filter; state.orderPage = 1; renderOrders(); }
    switchView(card.dataset.go);
  });
  document.querySelector('.quick-actions').addEventListener('click', (event) => {
    const button = event.target.closest('[data-quick]');
    if (!button) return;
    if (button.dataset.quick === 'new-product') { $('#newProductBtn').click(); return; }
    if (button.dataset.quick === 'inventory') { switchView('inventory'); return; }
    if (button.dataset.quick === 'all-orders') { state.orderFilter = 'all'; state.orderPage = 1; renderOrders(); switchView('orders'); }
  });

  // ---------- 客户管理 ----------
  function renderCustomerOverview() {
    const personal = state.users.filter((item) => item.userType === 'c');
    const business = state.users.filter((item) => item.userType === 'b');
    $('#customerSummary').innerHTML = [
      ['全部顾客账号', state.users.length], ['个人顾客', personal.length], ['企业采购客户', business.length]
    ].map(([label, count]) => `<div class="summary-card"><span>${label}</span><strong>${count}</strong></div>`).join('');
    if (state.loadErrors['admin.users.list']) {
      $('#userList').innerHTML = `<div class="empty">当前账号不能查看顾客概况，请联系管理员。</div>`;
      return;
    }
    const rows = [...state.users].sort((a, b) => String(b.lastLoginAt || b.createdAt || '').localeCompare(String(a.lastLoginAt || a.createdAt || ''))).slice(0, 30);
    $('#userList').innerHTML = rows.map((item, index) => `
      <article class="oc">
        <div class="row1"><strong>${item.userType === 'b' ? '企业采购客户' : '个人顾客'} ${index + 1}</strong><span class="badge ${item.status === 'disabled' ? 'b-gray' : 'b-green'}">${item.status === 'disabled' ? '已停用' : '正常'}</span></div>
        <div class="meta">注册时间：${fmtTime(item.createdAt)}　最近登录：${fmtTime(item.lastLoginAt)}</div>
      </article>`).join('') || '<div class="empty"><div class="big">👥</div>还没有顾客账号</div>';
  }
  function renderCustomers() {
    document.querySelectorAll('#customerModeChips [data-customer-mode]').forEach((button) => button.classList.toggle('is-active', button.dataset.customerMode === state.customerMode));
    $('#customerApplicationsPane').style.display = state.customerMode === 'applications' ? 'block' : 'none';
    $('#customerOverviewPane').style.display = state.customerMode === 'overview' ? 'block' : 'none';
    $('#customerWebAccountPane').style.display = state.customerMode === 'webaccounts' ? 'block' : 'none';
    $('#customerFinancePane').style.display = state.customerMode === 'finance' ? 'block' : 'none';
    $('#customerInquiryPane').style.display = state.customerMode === 'inquiries' ? 'block' : 'none';
    $('#customerMembershipPane').style.display = state.customerMode === 'membership' ? 'block' : 'none';
    if (state.loadErrors['admin.businessApplications.list'] && state.customerMode === 'applications') {
      $('#customerChips').innerHTML = '';
      $('#customerList').innerHTML = `<div class="empty">企业申请读取失败或当前角色无权限：${esc(state.loadErrors['admin.businessApplications.list'])}<br><button class="act" id="customerLoadRetry">重试</button></div>`;
      const retry = $('#customerLoadRetry'); if (retry) retry.addEventListener('click', () => guard(async () => { await reloadCustomers(); renderCustomers(); renderDashboard(); }, '客户申请已刷新'));
      return;
    }
    const filters = [['pending', '待审核'], ['approved', '已通过'], ['rejected', '已驳回'], ['all', '全部']];
    $('#customerChips').innerHTML = filters.map(([key, label]) => {
      const count = key === 'all' ? state.businessApplications.length : state.businessApplications.filter((item) => item.status === key).length;
      return `<button class="${state.customerFilter === key ? 'is-active' : ''}" data-customer-filter="${key}">${label} ${count}</button>`;
    }).join('');
    const rows = state.businessApplications.filter((item) => state.customerFilter === 'all' || item.status === state.customerFilter);
    $('#customerList').innerHTML = rows.map((item) => `
      <article class="oc">
        <div class="row1"><strong>${esc(item.companyName || '未填写企业名称')}</strong><span class="badge ${item.status === 'approved' ? 'b-green' : item.status === 'rejected' ? 'b-gray' : 'b-orange'}">${esc(BUSINESS_STATUS_TEXT[item.status] || item.status)}</span></div>
        <div class="meta">联系人：${esc(item.contactName || '—')}　${esc(item.contactPhoneMasked || '')}<br>统一社会信用代码：${esc(item.unifiedCode || '—')}<br>申请时间：${fmtTime(item.submittedAt)}</div>
        ${item.status === 'pending' ? `<div class="actions"><button class="act green" data-customer-review="approved" data-id="${esc(item._id)}">审核通过</button><button class="act danger" data-customer-review="rejected" data-id="${esc(item._id)}">驳回申请</button></div>` : ''}
      </article>`).join('') || '<div class="empty"><div class="big">✓</div>这里没有需要处理的企业申请</div>';
    renderCustomerOverview();
    renderBusinessFinance(); renderAdminInquiries(); renderWebAccounts();
  }
  function renderWebAccounts() {
    const error = state.loadErrors['admin.webAccounts.list'];
    $('#webAccountList').innerHTML = error ? `<div class="empty">网页账号读取失败或当前管理员无权限：${esc(error)}</div>` : state.webAccounts.map(item => { const user = state.users.find(row => row._id === item.userId); return `<article class="oc"><div class="row1"><strong>${esc(item.loginIdMasked || item._id)}</strong><span class="badge ${item.status === 'active' ? 'b-green' : 'b-gray'}">${item.status === 'active' ? '已启用' : '已禁用'}</span></div><div class="meta">绑定用户：${esc(user?.displayName || user?.nickname || item.userId || '—')} · 最近登录 ${fmtTime(item.lastLoginAt)}${item.lockedUntil ? ` · 锁定至 ${fmtTime(item.lockedUntil)}` : ''}</div><div class="actions"><button class="act ${item.status === 'active' ? 'danger' : 'green'}" data-web-account-status="${item.status === 'active' ? 'disabled' : 'active'}" data-id="${esc(item._id)}">${item.status === 'active' ? '禁用账号' : '重新启用'}</button><button class="act plain" data-web-account-reset="${esc(item._id)}">重置密码</button></div></article>`; }).join('') || '<div class="empty">暂无网页登录账号</div>';
  }
  function renderBusinessFinance() {
    const financeError = state.loadErrors['admin.creditAccounts.list'] || state.loadErrors['admin.receivables.list'] || state.loadErrors['admin.statements.list'];
    $('#creditAccountList').innerHTML = financeError ? `<div class="empty">账期数据读取失败或当前账号无权限：${esc(financeError)}</div>` : state.creditAccounts.map(item => { const available = Math.max(0, Number(item.creditLimitCent || 0) - Number(item.occupiedCent || 0) - Number(item.receivableCent || 0)); return `<article class="oc"><div class="row1"><strong>企业 ${esc(item.organizationId || '—')}</strong><span class="badge ${item.status === 'active' && !item.temporary ? 'b-green' : 'b-orange'}">${item.temporary ? '临时草案' : esc(item.status || 'draft')}</span></div><div class="meta">额度 ${yuan(item.creditLimitCent)}　可用 ${yuan(available)}　占用 ${yuan(item.occupiedCent)}　应收 ${yuan(item.receivableCent)}　账期 ${Number(item.paymentTermDays || 0)} 天<br>来源：${esc(item.source || '未标记')}</div><div class="actions"><button class="act plain" data-credit-edit="${esc(item._id)}">编辑额度</button></div></article>`; }).join('') || '<div class="empty">暂无企业账期账户</div>';
    $('#receivableList').innerHTML = state.receivables.map(item => `<div class="compact-row"><div><strong>${esc(item.action || item.receivableNo || item._id)}</strong><span>${yuan(item.amountCent)} · ${esc(item.status || item.createdAt || '—')}</span></div></div>`).join('') || '<div class="empty">暂无应收流水</div>';
    $('#statementList').innerHTML = state.statements.map(item => `<div class="compact-row"><div><strong>${esc(item.statementNo || item.period || item._id)}</strong><span>总额 ${yuan(item.amountCent || item.totalAmountCent)} · 未收 ${yuan(item.outstandingCent)} · ${esc(item.status || '—')}</span></div>${Number(item.outstandingCent || 0) > 0 ? `<button class="act danger" data-receivable-settle="${esc(item._id)}" data-outstanding-cent="${Number(item.outstandingCent)}">登记回款</button>` : ''}</div>`).join('') || '<div class="empty">暂无对账单</div>';
  }
  function renderAdminInquiries() {
    const inquiryError = state.loadErrors['admin.inquiries.list'];
    $('#adminInquiryList').innerHTML = inquiryError ? `<div class="empty">询价读取失败或当前账号无权限：${esc(inquiryError)}</div>` : state.inquiries.map(item => `<article class="oc"><div class="row1"><strong>${esc(item.inquiryNo || item._id)}</strong><span class="badge ${item.status === 'accepted' ? 'b-green' : 'b-orange'}">${esc(item.status || '—')}</span></div><div class="meta">企业：${esc(item.organizationId || '—')}　更新时间：${fmtTime(item.updatedAt || item.createdAt)}</div><div class="actions"><button class="act" data-admin-inquiry="${esc(item._id)}">查看与报价</button></div></article>`).join('') || '<div class="empty">暂无询价</div>';
  }
  $('#customerModeChips').addEventListener('click', (event) => {
    const button = event.target.closest('[data-customer-mode]');
    if (!button) return;
    state.customerMode = button.dataset.customerMode;
    renderCustomers();
  });
  $('#customerChips').addEventListener('click', (event) => {
    const button = event.target.closest('[data-customer-filter]');
    if (!button) return;
    state.customerFilter = button.dataset.customerFilter;
    renderCustomers();
  });
  $('#customerRefresh').addEventListener('click', () => guard(async () => { await reloadCustomers(); renderCustomers(); renderDashboard(); }, '客户申请已刷新'));
  $('#customerList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-customer-review]');
    if (!button) return;
    const approved = button.dataset.customerReview === 'approved';
    const application = state.businessApplications.find((item) => item._id === button.dataset.id);
    const company = application && application.companyName || '该企业';
    if (!global.confirm(approved ? `确认通过“${company}”的企业采购申请？` : `确认驳回“${company}”的企业采购申请？`)) return;
    guard(async () => {
      await api.call('admin.businessApplications.review', { id: button.dataset.id, decision: button.dataset.customerReview });
      await reloadCustomers();
      renderCustomers();
      renderDashboard();
    }, approved ? '企业申请已通过' : '企业申请已驳回');
  });
  function openCreditAccountEditor(item = {}) {
    openModal(`<h3>${item._id ? '编辑' : '新增'}企业账期额度</h3><form id="creditAccountForm"><input type="hidden" name="id" value="${esc(item._id || '')}"><label class="field">企业 ID<input name="organizationId" required maxlength="80" value="${esc(item.organizationId || '')}"></label><label class="field">授信额度（元）<input name="creditLimit" type="number" min="0" step="0.01" required value="${Number(item.creditLimitCent || 0) / 100}"></label><label class="field">账期天数<input name="paymentTermDays" type="number" min="0" max="365" required value="${Number(item.paymentTermDays || 0)}"></label><label class="field">来源<select name="source"><option value="ai_generated" ${item.source === 'ai_generated' ? 'selected' : ''}>AI 初始草案</option><option value="client" ${item.source === 'client' ? 'selected' : ''}>人工复核/甲方资料</option></select></label><label class="check-line"><input name="temporary" type="checkbox" ${item.temporary !== false ? 'checked' : ''}>临时草案</label><label class="field">状态<select name="status"><option value="disabled">草稿/停用</option><option value="active" ${item.status === 'active' ? 'selected' : ''}>启用</option></select></label><label class="field">配置说明<textarea name="note" maxlength="300">${esc(item.note || '')}</textarea></label><p class="hint">AI 或临时额度只能保存为草稿；正式启用必须标记为人工复核且取消“临时草案”。</p><div class="actions"><button type="button" class="act plain" data-close>取消</button><button class="act" type="submit">保存额度</button></div></form>`);
    $('#creditAccountForm').addEventListener('submit', (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const source = form.get('source'); const temporary = form.get('temporary') === 'on'; const status = form.get('status'); if (status === 'active' && (temporary || source !== 'client')) return showNotice('临时或 AI 额度不能启用，请先完成人工复核', true); if (status === 'active' && !global.confirm(`确认启用企业授信额度：${form.get('creditLimit')} 元、账期 ${form.get('paymentTermDays')} 天？这会影响企业下单可用额度；已产生的占用和应收不会因后续停用自动撤销。`)) return; guard(async () => { await api.call('admin.creditAccounts.upsert', { id: form.get('id'), organizationId: form.get('organizationId'), creditLimitCent: Math.round(Number(form.get('creditLimit')) * 100), paymentTermDays: Number(form.get('paymentTermDays')), source, temporary, status, note: form.get('note'), idempotencyKey: newIdempotencyKey() }); closeModal(); await reloadCustomers(); renderCustomers(); }, status === 'active' ? '正式授信额度已启用' : '授信额度草案已保存'); });
  }
  async function openAdminInquiry(id) {
    openModal('<h3>询价详情</h3><p class="hint">正在加载…</p>');
    let detail; try { detail = await api.call('admin.inquiries.get', { id }); } catch (error) { openModal(`<h3>询价详情加载失败</h3><p>${esc(friendlyError(error))}</p><div class="actions"><button class="act plain" data-close>关闭</button><button class="act" id="inquiryRetry">重试</button></div>`); $('#inquiryRetry').addEventListener('click', () => openAdminInquiry(id)); return; }
    const inquiry = detail.inquiry || detail; const inquiryItems = detail.items || inquiry.items || []; const quotes = inquiry.quotes || detail.quotes || [];
    openModal(`<h3>询价 ${esc(inquiry.inquiryNo || inquiry._id)}</h3><div class="compact-list">${inquiryItems.map(item => `<div class="compact-row"><div><strong>${esc(item.productName || item.skuId)}</strong><span>数量 ${Number(item.quantity || 0)}</span></div></div>`).join('')}</div><h4>报价版本</h4>${quotes.map(quote => `<p>V${Number(quote.version || 1)} · ${yuan(quote.totalAmountCent)} · 有效至 ${fmtTime(quote.validUntil)} · ${quote.temporary ? '临时草案（客户不可接受）' : '正式报价'} · ${esc(quote.source || '未标记')} · ${esc(quote.status || '—')}</p>`).join('') || '<p class="hint">尚未报价</p>'}<form id="inquiryQuoteForm"><label class="field">报价明细<textarea name="items" required placeholder="每行：SKU ID,数量,单价（分）">${inquiryItems.map(item => `${item.skuId},${item.quantity},`).join('\n')}</textarea></label><label class="field">有效期<input name="validUntil" type="datetime-local" required></label><label class="field">来源<select name="source"><option value="ai_generated">AI 初始草案</option><option value="client">人工复核/甲方资料</option></select></label><label class="check-line"><input name="temporary" type="checkbox" checked>临时报价草案</label><label class="field">发布方式<select name="releaseMode"><option value="draft">保存草案</option><option value="active">正式发布</option></select></label><p class="hint">AI 或临时报价不得正式发布，也不能被客户接受。</p>${['submitted', 'quoted'].includes(inquiry.status) ? `<button type="button" class="act danger" data-inquiry-transition="cancelled" data-id="${esc(id)}">取消询价</button>` : ''}${inquiry.status === 'accepted' ? `<button type="button" class="act danger" data-inquiry-transition="closed" data-id="${esc(id)}">关闭已接受询价</button>` : ''}<div class="actions"><button type="button" class="act plain" data-close>关闭</button><button class="act" type="submit">生成新报价版本</button></div></form>`);
    $('#inquiryQuoteForm').addEventListener('submit', (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const source = form.get('source'); const temporary = form.get('temporary') === 'on'; const releaseMode = form.get('releaseMode'); if (releaseMode === 'active' && (temporary || source !== 'client')) return showNotice('临时或 AI 报价不能发布，请先完成人工复核', true); const items = String(form.get('items') || '').split(/\r?\n/).map(line => { const [skuId, quantity, unitPriceCent] = line.split(/[,，\s]+/); return { skuId, quantity: Number(quantity), unitPriceCent: Number(unitPriceCent) }; }).filter(item => item.skuId && Number.isInteger(item.quantity) && item.quantity > 0 && Number.isInteger(item.unitPriceCent) && item.unitPriceCent > 0); if (items.length !== inquiryItems.length) return showNotice('每个询价商品都必须填写大于 0 的单价', true); if (releaseMode === 'active' && !global.confirm('确认发布正式报价？客户将在有效期内看到并可接受该版本。')) return; guard(async () => { await api.call('admin.inquiries.quote', { id, items, validUntil: new Date(form.get('validUntil')).toISOString(), source, temporary, note: releaseMode === 'active' ? '已人工复核发布' : '临时报价草案', idempotencyKey: newIdempotencyKey() }); closeModal(); await reloadCustomers(); renderCustomers(); }, releaseMode === 'active' ? '正式报价已发布' : '报价草案已保存，客户不可接受'); });
    document.querySelectorAll('[data-inquiry-transition]').forEach(button => button.addEventListener('click', () => { if (!global.confirm(`确认将询价状态变更为 ${button.dataset.inquiryTransition}？`)) return; guard(async () => { await api.call('admin.inquiries.transition', { id: button.dataset.id, status: button.dataset.inquiryTransition, idempotencyKey: newIdempotencyKey() }); closeModal(); await reloadCustomers(); renderCustomers(); }, '询价状态已更新'); }));
  }
  $('#newCreditAccountBtn').addEventListener('click', () => openCreditAccountEditor());
  $('#creditAccountList').addEventListener('click', (event) => { const button = event.target.closest('[data-credit-edit]'); if (button) openCreditAccountEditor(state.creditAccounts.find(item => item._id === button.dataset.creditEdit)); });
  $('#adminInquiryList').addEventListener('click', (event) => { const button = event.target.closest('[data-admin-inquiry]'); if (button) openAdminInquiry(button.dataset.adminInquiry); });
  $('#newWebAccountBtn').addEventListener('click', () => {
    openModal(`<h3>开通网页登录账号</h3><form id="webAccountCreateForm"><label class="field">绑定用户<select name="userId" required>${state.users.filter(user => user.status !== 'disabled').map(user => `<option value="${esc(user._id)}">${esc(user.displayName || user.nickname || user._id)} · ${user.userType === 'b' ? '企业' : '个人'}</option>`).join('')}</select></label><label class="field">登录账号<input name="loginId" autocomplete="off" maxlength="80" required></label><label class="field">初始密码<input name="password" type="password" autocomplete="new-password" minlength="10" maxlength="128" required></label><label class="field">确认初始密码<input name="confirmPassword" type="password" autocomplete="new-password" minlength="10" maxlength="128" required></label><p class="hint">密码只在本次表单中输入并直接提交到服务端，不会在后台显示或记录。请通过安全渠道告知用户。</p><div class="actions"><button type="button" class="act plain" data-close>取消</button><button class="act green" type="submit">确认开通</button></div></form>`);
    $('#webAccountCreateForm').addEventListener('submit', (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const password = String(form.get('password') || ''); if (password !== String(form.get('confirmPassword') || '')) return showNotice('两次输入的密码不一致', true); if (!global.confirm('确认开通网页登录账号？账号启用后可访问该用户权限范围内的数据。')) return; guard(async () => { await api.call('admin.webAccounts.upsert', { userId: form.get('userId'), loginId: form.get('loginId'), password, status: 'active' }); event.currentTarget.reset(); closeModal(); await reloadCustomers(); renderCustomers(); }, '网页账号已开通；密码不会再次显示'); });
  });
  $('#webAccountList').addEventListener('click', (event) => {
    const statusButton = event.target.closest('[data-web-account-status]');
    if (statusButton) { const status = statusButton.dataset.webAccountStatus; if (!global.confirm(status === 'disabled' ? '确认禁用网页登录账号？当前会话将失效，用户会立即无法访问订单、价格与账户数据。' : '确认重新启用网页登录账号？用户将恢复登录权限。')) return; return guard(async () => { await api.call('admin.webAccounts.setStatus', { id: statusButton.dataset.id, status }); await reloadCustomers(); renderCustomers(); }, status === 'disabled' ? '网页账号已禁用' : '网页账号已启用'); }
    const resetButton = event.target.closest('[data-web-account-reset]'); if (!resetButton) return;
    openModal(`<h3>重置网页登录密码</h3><form id="webAccountResetForm"><label class="field">新密码<input name="newPassword" type="password" autocomplete="new-password" minlength="10" maxlength="128" required></label><label class="field">确认新密码<input name="confirmPassword" type="password" autocomplete="new-password" minlength="10" maxlength="128" required></label><p class="hint">提交后该账号所有已有会话立即失效。密码不会由接口返回，也不会保存在页面。</p><div class="actions"><button type="button" class="act plain" data-close>取消</button><button class="act danger" type="submit">确认重置</button></div></form>`);
    $('#webAccountResetForm').addEventListener('submit', (submitEvent) => { submitEvent.preventDefault(); const form = new FormData(submitEvent.currentTarget); const newPassword = String(form.get('newPassword') || ''); if (newPassword !== String(form.get('confirmPassword') || '')) return showNotice('两次输入的新密码不一致', true); if (!global.confirm('确认重置密码并使该账号所有已有会话失效？此操作不能撤销。')) return; guard(async () => { await api.call('admin.webAccounts.resetPassword', { id: resetButton.dataset.webAccountReset, newPassword }); submitEvent.currentTarget.reset(); closeModal(); }, '密码已重置；请通过安全渠道告知用户'); });
  });
  $('#statementList').addEventListener('click', (event) => { const button = event.target.closest('[data-receivable-settle]'); if (!button) return; const max = Number(button.dataset.outstandingCent || 0); openModal(`<h3>登记企业回款</h3><form id="receivableSettleForm"><label class="field">本次回款（元）<input name="amount" type="number" min="0.01" max="${max / 100}" step="0.01" required value="${max / 100}"></label><label class="field">入账备注<textarea name="note" maxlength="300" required></textarea></label><p class="hint">支持部分回款。提交后会减少应收并写入流水，不能在前端撤销。</p><div class="actions"><button type="button" class="act plain" data-close>取消</button><button class="act danger" type="submit">确认入账</button></div></form>`); $('#receivableSettleForm').addEventListener('submit', (submitEvent) => { submitEvent.preventDefault(); const form = new FormData(submitEvent.currentTarget); const amountCent = Math.round(Number(form.get('amount')) * 100); if (!global.confirm(`确认登记回款 ${yuan(amountCent)}？此操作会写入应收流水。`)) return; guard(async () => { await api.call('admin.receivables.settle', { statementId: button.dataset.receivableSettle, amountCent, idempotencyKey: newIdempotencyKey(), note: form.get('note') }); closeModal(); await reloadCustomers(); renderCustomers(); }, '回款已入账，应收额度已按服务端结果更新'); }); });

  // ---------- 订单处理 ----------
  function orderActionButtons(order) {
    const buttons = [];
    if (order.status === 'pending_confirmation') buttons.push(`<button class="act" data-order-action="picking" data-id="${esc(order._id)}">接单，开始拣货</button>`);
    if (order.status === 'picking') buttons.push(`<button class="act green" data-order-action="shipping" data-id="${esc(order._id)}">发货</button>`);
    if (order.status === 'shipping') buttons.push(`<button class="act green" data-order-action="delivered" data-id="${esc(order._id)}">确认送达</button>`);
    if (order.status === 'delivered') buttons.push(`<button class="act plain" data-order-action="completed" data-id="${esc(order._id)}">完成订单</button>`);
    if ((order.status === 'pending_confirmation' || order.status === 'picking') && order.paymentStatus !== 'paid') {
      buttons.push(`<button class="act danger" data-order-action="cancelled" data-id="${esc(order._id)}">取消订单</button>`);
    }
    return buttons.join('');
  }
  function filteredOrders() {
    const keyword = state.orderKeyword.trim().toLowerCase();
    return (state.orderQueryRows || state.orders).filter((o) => {
      const statusMatches = state.orderFilter === 'todo' ? ORDER_FLOW.includes(o.status) : state.orderFilter === 'all' || o.status === state.orderFilter;
      const paymentMatches = state.orderPaymentFilter === 'all'
        || (state.orderPaymentFilter === 'pending' && ['unpaid', 'pending'].includes(o.paymentStatus))
        || (state.orderPaymentFilter === 'not_required' && ['not_required', 'demo_not_required'].includes(o.paymentStatus))
        || o.paymentStatus === state.orderPaymentFilter;
      const fulfillmentMatches = state.orderFulfillmentFilter === 'all' || o.fulfillmentType === state.orderFulfillmentFilter;
      const address = o.addressSnapshot || {}; const pickup = o.pickupSiteSnapshot || {};
      const haystack = [o.orderNo, o._id, address.name, address.phoneMasked, pickup.name, ...(o.itemsSnapshot || []).map(item => item.productName || item.name || item.skuName || '')].join(' ').toLowerCase();
      return statusMatches && paymentMatches && fulfillmentMatches && (!keyword || haystack.includes(keyword));
    });
  }
  function renderOrders() {
    const filters = [
      { key: 'todo', label: '待处理' }, { key: 'all', label: '全部订单' }, { key: 'pending_confirmation', label: '待确认' },
      { key: 'picking', label: '拣货中' }, { key: 'shipping', label: '配送中' },
      { key: 'delivered', label: '已送达' }, { key: 'completed', label: '已完成' }, { key: 'cancelled', label: '已取消' }
    ];
    $('#orderChips').innerHTML = filters.map((f) => `<button data-chip="${f.key}" class="${state.orderFilter === f.key ? 'is-active' : ''}">${f.label}</button>`).join('');
    if (state.loadErrors['admin.orders.list']) { $('#orderList').innerHTML = `<div class="empty">订单读取失败或当前角色无权限：${esc(state.loadErrors['admin.orders.list'])}<br><button class="act" id="orderLoadRetry">重试</button></div>`; $('#orderPager').innerHTML = ''; const retry = $('#orderLoadRetry'); if (retry) retry.addEventListener('click', () => guard(async () => { await reloadTrade(); renderOrders(); }, '订单已刷新')); return; }
    const rows = filteredOrders();
    state.selectedOrderIds = state.selectedOrderIds.filter(id => state.orders.some(order => order._id === id));
    $('#orderSelectionCount').textContent = state.selectedOrderIds.length ? `已选择 ${state.selectedOrderIds.length} 张订单` : '未选择订单';
    if (!rows.length) {
      $('#orderList').innerHTML = `<div class="empty"><div class="big">🍃</div>这里没有需要处理的订单</div>`;
      $('#orderPager').innerHTML = '';
      return;
    }
    const pageSize = 12;
    const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
    state.orderPage = Math.min(Math.max(1, state.orderPage), pageCount);
    const pageRows = rows.slice((state.orderPage - 1) * pageSize, state.orderPage * pageSize);
    $('#orderList').innerHTML = pageRows.map((o) => {
      const address = o.addressSnapshot || {};
      const slot = o.deliverySlotSnapshot || {};
      const payText = PAY_TEXT[o.paymentStatus] || o.paymentStatus || '—';
      return `<div class="oc">
        <div class="row1">
          <label class="check-line" title="选择订单"><input type="checkbox" data-order-select="${esc(o._id)}" ${state.selectedOrderIds.includes(o._id) ? 'checked' : ''}> 选择</label>
          <strong>订单 ${esc(o.orderNo || o._id)}</strong>
          <span class="badge b-blue">${ORDER_STATUS_TEXT[o.status] || esc(o.status)}</span>
          <span class="badge ${o.paymentStatus === 'paid' ? 'b-green' : 'b-gray'}">${payText}</span>
          <span class="spacer" style="flex:1"></span>
          <span class="money">${yuan(o.totalAmountCent)}</span>
        </div>
        <div class="meta">下单时间：${fmtTime(o.createdAt)}　支付方式：${esc(PAY_METHOD_TEXT[o.paymentMethod] || o.paymentMethod || '—')}<br>
        ${o.fulfillmentType === 'pickup' ? `自提：${esc((o.pickupSiteSnapshot || {}).name || '—')}　${esc((o.pickupSiteSnapshot || {}).address || '')}` : `收货：${esc(address.name || '—')}　${esc(address.phoneMasked || '')}<br>${esc(address.detail || '')}${slot.name ? `　｜　配送时段：${esc(slot.name)} ${esc(slot.startTime || '')}-${esc(slot.endTime || '')}` : ''}`}</div>
        <div class="actions"><button class="act plain" data-order-detail="${esc(o._id)}">查看详情</button>${orderActionButtons(o)}</div>
      </div>`;
    }).join('');
    $('#orderPager').innerHTML = `
      <span>共 ${rows.length} 张订单</span>
      <button class="act plain" data-order-page="${state.orderPage - 1}" ${state.orderPage === 1 ? 'disabled' : ''}>上一页</button>
      <strong>第 ${state.orderPage} / ${pageCount} 页</strong>
      <button class="act plain" data-order-page="${state.orderPage + 1}" ${state.orderPage === pageCount ? 'disabled' : ''}>下一页</button>`;
  }
  $('#orderChips').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-chip]');
    if (!chip) return;
    state.orderFilter = chip.dataset.chip;
    state.orderPage = 1;
    loadOrderSearch();
  });
  let orderSearchTimer = null;
  $('#orderSearch').addEventListener('input', (event) => { state.orderKeyword = event.target.value; state.orderPage = 1; clearTimeout(orderSearchTimer); orderSearchTimer = setTimeout(loadOrderSearch, 250); });
  $('#orderPaymentFilter').addEventListener('change', (event) => { state.orderPaymentFilter = event.target.value; state.orderPage = 1; loadOrderSearch(); });
  $('#orderFulfillmentFilter').addEventListener('change', (event) => { state.orderFulfillmentFilter = event.target.value; state.orderPage = 1; loadOrderSearch(); });
  async function loadOrderSearch() {
    $('#orderList').innerHTML = '<div class="empty">正在按条件读取订单…</div>'; $('#orderPager').innerHTML = '';
    const statuses = state.orderFilter === 'todo' ? ORDER_FLOW : state.orderFilter === 'all' ? [undefined] : [state.orderFilter];
    const payments = state.orderPaymentFilter === 'pending' ? ['unpaid', 'pending'] : state.orderPaymentFilter === 'not_required' ? ['not_required', 'demo_not_required'] : [state.orderPaymentFilter === 'all' ? undefined : state.orderPaymentFilter];
    try {
      const groups = await Promise.all(statuses.flatMap(status => payments.map(paymentStatus => list('admin.orders.list', { status, paymentStatus, fulfillmentType: state.orderFulfillmentFilter === 'all' ? undefined : state.orderFulfillmentFilter, orderNo: state.orderKeyword.trim() || undefined }))));
      const seen = new Set(); state.orderQueryRows = groups.flat().filter(order => order && !seen.has(order._id) && seen.add(order._id)); delete state.loadErrors['admin.orders.list']; renderOrders();
    } catch (error) { state.orderQueryRows = []; state.loadErrors['admin.orders.list'] = friendlyError(error); renderOrders(); }
  }
  $('#orderPager').addEventListener('click', (event) => {
    const button = event.target.closest('[data-order-page]');
    if (!button || button.disabled) return;
    state.orderPage = Number(button.dataset.orderPage) || 1;
    renderOrders();
    document.querySelector('section.view[data-view="orders"]').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#orderList').addEventListener('click', (event) => {
    const selection = event.target.closest('[data-order-select]');
    if (selection) {
      state.selectedOrderIds = selection.checked ? [...new Set([...state.selectedOrderIds, selection.dataset.orderSelect])] : state.selectedOrderIds.filter(id => id !== selection.dataset.orderSelect);
      $('#orderSelectionCount').textContent = state.selectedOrderIds.length ? `已选择 ${state.selectedOrderIds.length} 张订单` : '未选择订单';
      return;
    }
    const detail = event.target.closest('[data-order-detail]');
    if (detail) return openOrderDetail(detail.dataset.orderDetail);
    const btn = event.target.closest('[data-order-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    const next = btn.dataset.orderAction;
    const confirmText = {
      picking: '确认接单并开始拣货？',
      shipping: '确认发货？',
      delivered: '确认已送达客户？',
      completed: '确认完成这张订单？',
      cancelled: '确定取消这张订单？取消后库存会自动放回。'
    }[next] || '确认执行？';
    if (!global.confirm(confirmText)) return;
    guard(async () => {
      await api.call('admin.orders.transition', { id, status: next, carrier: '', trackingNo: '' });
      await reloadTrade();
      renderDashboard(); renderOrders(); renderRefunds();
    }, { picking: '已接单，进入拣货', shipping: '已发货', delivered: '已确认送达', completed: '订单已完成', cancelled: '订单已取消' }[next] || '操作成功');
  });
  function orderItemsHtml(items) {
    return (items || []).map(item => `<div class="compact-row"><div><strong>${esc(item.productName || item.name || '商品')} · ${esc(item.specName || item.skuName || '')}</strong><span>${Number(item.quantity || 0)} 件 · 实付 ${yuan(item.paidSubtotalCent !== undefined ? item.paidSubtotalCent : item.subtotalCent)}</span></div></div>`).join('') || '<div class="empty">没有订单商品快照</div>';
  }
  async function openOrderDetail(id) {
    openModal('<h3>订单详情</h3><div class="empty">正在读取订单快照…</div>');
    try {
      const [result, notesResult] = await Promise.all([api.call('admin.orders.get', { id }), api.call('admin.orders.notes.list', { id, page: 1, pageSize: 100 })]); const order = result.order || {}; const items = result.items || order.itemsSnapshot || []; const notes = notesResult.rows || [];
      const address = order.addressSnapshot || {}; const pickup = order.pickupSiteSnapshot || {};
      const timeline = order.statusTimeline || order.timeline || [];
      openModal(`<h3>订单 ${esc(order.orderNo || order._id || id)}</h3><div class="compact-list">${orderItemsHtml(items)}</div><div class="summary-grid"><div class="summary-card"><span>商品金额</span><strong>${yuan((order.pricingSnapshot || {}).goodsAmountCent)}</strong></div><div class="summary-card"><span>配送费</span><strong>${yuan((order.freightSnapshot || {}).amountCent)}</strong></div><div class="summary-card"><span>实付合计</span><strong>${yuan(order.totalAmountCent)}</strong></div></div><p class="meta">履约：${order.fulfillmentType === 'pickup' ? `自提 · ${esc(pickup.name || '—')} · ${esc(pickup.address || '')}` : `配送 · ${esc(address.name || '—')} ${esc(address.phoneMasked || '')} · ${esc(address.detail || '')}`}<br>状态：${esc(ORDER_STATUS_TEXT[order.status] || order.status || '—')} · ${esc(PAY_TEXT[order.paymentStatus] || order.paymentStatus || '—')}<br>承运：${esc((order.shipInfo || {}).carrier || order.carrier || '—')} ${esc((order.shipInfo || {}).trackingNo || order.trackingNo || '')}</p><div class="form-panel"><h3>新增订单备注</h3><textarea id="orderNoteInput" maxlength="500" rows="3"></textarea><button class="act" id="orderNoteSave">保存备注</button><div class="compact-list">${notes.map(note => `<div class="compact-row"><div><strong>${esc(note.content)}</strong><span>${fmtTime(note.createdAt)} · 操作人 ${esc(note.adminId || '—')}</span></div></div>`).join('') || '<div class="empty">暂无订单备注</div>'}</div></div><div class="compact-list">${timeline.map(row => `<div class="compact-row"><div><strong>${esc(ORDER_STATUS_TEXT[row.status] || row.status || row.action || '状态更新')}</strong><span>${fmtTime(row.at || row.createdAt)} · ${esc(row.note || '')}</span></div></div>`).join('') || '<div class="empty">暂无时间线</div>'}</div><div class="actions">${order.fulfillmentType === 'delivery' ? `<button class="act danger" id="orderContactRead">读取明文履约联系方式</button>` : ''}<button class="act plain" data-close>关闭</button></div><p id="orderContactResult" class="hint">导出和拣货单默认只使用脱敏信息；明文读取会二次确认并记录审计。</p>`);
      $('#orderNoteSave').addEventListener('click', () => { const note = $('#orderNoteInput').value.trim(); if (!note) return showNotice('订单备注不能为空', true); if (!global.confirm('确认新增订单备注？备注会写入服务端并保留操作记录。')) return; guard(async () => { await api.call('admin.orders.notes.add', { id, note, idempotencyKey: newIdempotencyKey() }); await reloadTrade(); await openOrderDetail(id); showNotice('订单备注已保存'); }, ''); });
      const contactButton = $('#orderContactRead'); if (contactButton) contactButton.addEventListener('click', () => { if (!global.confirm('确认读取明文履约联系方式？仅限当前订单履约使用，本次读取将写入审计。')) return; guard(async () => { const contact = await api.call('admin.orders.fulfillmentContact', { id, purpose: 'order_fulfillment' }); const recipient = contact.recipient || {}; $('#orderContactResult').textContent = `履约联系人：${recipient.name || '—'} ${recipient.phone || '—'} ${recipient.detail || ''}`; }, '已读取履约联系方式并记录审计'); });
    } catch (error) {
      $('#modalBody').innerHTML = `<h3>订单详情读取失败</h3><p class="hint">${esc(friendlyError(error))}</p><div class="actions"><button class="act" id="orderDetailRetry">重试</button><button class="act plain" data-close>关闭</button></div>`;
      $('#orderDetailRetry').addEventListener('click', () => openOrderDetail(id));
    }
  }
  $('#orderBatchSubmit').addEventListener('click', () => {
    const ids = state.selectedOrderIds.slice(); const status = $('#orderBatchStatus').value;
    if (!ids.length) return showNotice('请先选择要处理的订单', true);
    if (!global.confirm(`确认把选中的 ${ids.length} 张订单批量变更为“${ORDER_STATUS_TEXT[status] || status}”？服务端会逐张校验状态。`)) return;
    guard(async () => { const result = await api.call('admin.orders.batchTransition', { items: ids.map(id => ({ id, status })), idempotencyKey: newIdempotencyKey() }); state.selectedOrderIds = []; await reloadTrade(); renderOrders(); renderDashboard(); showBatchResult('订单批量处理', result); }, '');
  });
  function currentOrderFilters(statusOverride) { return { status: statusOverride || (state.orderFilter === 'todo' || state.orderFilter === 'all' ? undefined : state.orderFilter), paymentStatus: state.orderPaymentFilter === 'all' ? undefined : state.orderPaymentFilter, fulfillmentType: state.orderFulfillmentFilter === 'all' ? undefined : state.orderFulfillmentFilter, orderNo: state.orderKeyword.trim() || undefined }; }
  function csvCell(value) { return `"${String(value === undefined || value === null ? '' : value).replace(/"/g, '""')}"`; }
  function downloadCsv(rows, name) {
    const keys = rows.length ? Object.keys(rows[0]) : []; const content = '\ufeff' + [keys.map(csvCell).join(','), ...rows.map(row => keys.map(key => csvCell(typeof row[key] === 'object' ? JSON.stringify(row[key]) : row[key])).join(','))].join('\r\n');
    if (!global.Blob || !global.URL || typeof global.URL.createObjectURL !== 'function' || !document.createElement) throw new Error('当前浏览器不能生成下载文件，请升级浏览器后重试。');
    const url = global.URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); global.URL.revokeObjectURL(url);
  }
  $('#exportOrdersBtn').addEventListener('click', () => guard(async () => { const results = state.orderFilter === 'todo' ? await Promise.all(ORDER_FLOW.map(status => api.call('admin.orders.export', { ...currentOrderFilters(status), limit: 2000 }))) : [await api.call('admin.orders.export', { ...currentOrderFilters(), limit: 2000 })]; const rows = results.flatMap(result => result.rows || []); if (!rows.length) return showNotice('当前筛选没有可导出的订单', true); downloadCsv(rows, `梦食鲜订单-${new Date().toISOString().slice(0, 10)}.csv`); showNotice(results.some(result => result.truncated) ? `已导出 ${rows.length} 条脱敏订单，结果已达到上限` : `已导出 ${rows.length} 条脱敏订单`); }, ''));
  $('#printPickingBtn').addEventListener('click', () => guard(async () => { const ids = state.selectedOrderIds.length ? state.selectedOrderIds.slice() : filteredOrders().map(order => order._id); if (!ids.length) return showNotice('当前没有可生成拣货单的订单', true); const result = await api.call('admin.orders.pickingList', { ids }); const rows = result.rows || []; openModal(`<h3>拣货单（脱敏）</h3><p class="hint">共 ${rows.length} 张订单。明文联系方式不包含在拣货单中。</p><div class="compact-list">${rows.map(row => { const recipient = row.recipient || {}; const pickup = row.pickupSiteSnapshot || {}; const fulfillment = row.fulfillmentType === 'pickup' ? `${pickup.name || '自提点'} ${pickup.address || ''}` : `${recipient.name || ''} ${recipient.phoneMasked || ''} ${recipient.regionCode || ''} ${recipient.detail || ''}`; return `<div class="compact-row"><div><strong>${esc(row.orderNo || row.orderId || '订单')}</strong><span>${esc(fulfillment)}</span></div><span>${esc((row.items || []).map(item => `${item.productName || item.skuName || item.skuId} × ${item.quantity}`).join('；'))}</span></div>`; }).join('') || '<div class="empty">没有可拣货项目</div>'}</div><div class="actions"><button class="act plain" data-close>关闭</button></div>`); }, ''));

  // ---------- 批量商品与价格 ----------
  function batchRowsOf(result) { return result && Array.isArray(result.rows) ? result.rows : []; }
  function showBatchResult(title, result) {
    const rows = batchRowsOf(result); const html = `<h3>${esc(title)}</h3><p class="hint">成功 ${Number(result && result.succeeded || rows.filter(row => row.ok).length)} 条，失败 ${Number(result && result.failed || rows.filter(row => !row.ok).length)} 条。失败行可修正后安全重试。</p><div class="compact-list">${rows.map(row => `<div class="compact-row"><div><strong>第 ${Number(row.index) + 1} 行 · ${row.ok ? '成功' : '失败'}</strong><span>${esc(row.ok ? `${row.id || ''}${row.revision ? ` · 修订 ${row.revision}` : ''}` : row.error && (row.error.message || row.error.code) || row.error || '')}</span></div></div>`).join('') || '<div class="empty">服务端未返回逐行结果</div>'}</div><div class="actions"><button class="act plain" data-close>关闭</button></div>`; openModal(html);
  }
  function validateBatchCatalog() {
    const raw = $('#batchCatalogInput').value.trim(); const type = $('#batchCatalogType').value;
    let items;
    try { items = JSON.parse(raw); } catch (_) { throw new Error('JSON 格式不正确，请检查括号、逗号和引号。'); }
    if (!Array.isArray(items) || !items.length) throw new Error('请提供至少一条批量数据。');
    if (items.length > 50) throw new Error('单次最多提交 50 条，请拆分后再操作。');
    items.forEach((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`第 ${index + 1} 条必须是对象。`);
      if (type === 'products' && !String(item.id || item.name || '').trim()) throw new Error(`第 ${index + 1} 条缺少商品 id 或 name。`);
      if (type === 'prices' && (!String(item.skuId || '').trim() || !Number.isInteger(Number(item.amountCent)) || Number(item.amountCent) < 0)) throw new Error(`第 ${index + 1} 条需要 skuId 和非负整数 amountCent。`);
    });
    state.batchCatalogPreview = { raw, type, items };
    $('#batchCatalogResult').innerHTML = `<div class="compact-row"><div><strong>本地格式校验通过</strong><span>${items.length} 条${type === 'products' ? '商品资料' : '价格规则'}；提交时仍由服务端逐条校验权限、版本和字段。</span></div></div>`;
    return state.batchCatalogPreview;
  }
  $('#batchCatalogType').addEventListener('change', () => { state.batchCatalogPreview = null; $('#batchCatalogResult').innerHTML = ''; });
  $('#batchCatalogInput').addEventListener('input', () => { state.batchCatalogPreview = null; $('#batchCatalogResult').innerHTML = ''; });
  $('#batchCatalogValidate').addEventListener('click', () => { try { validateBatchCatalog(); } catch (error) { showNotice(error.message, true); } });
  $('#batchCatalogSubmit').addEventListener('click', () => {
    let preview;
    try { preview = validateBatchCatalog(); } catch (error) { return showNotice(error.message, true); }
    if (!global.confirm(`确认批量提交 ${preview.items.length} 条${preview.type === 'products' ? '商品资料' : '价格规则'}？服务端可能返回部分成功，请核对逐行结果。`)) return;
    guard(async () => { const result = await api.call(preview.type === 'products' ? 'admin.products.batchUpsert' : 'admin.prices.batchUpsert', { items: preview.items, idempotencyKey: newIdempotencyKey() }); state.batchCatalogPreview = null; await reloadCore(); renderProducts(); showBatchResult(preview.type === 'products' ? '批量商品处理结果' : '批量价格处理结果', result); }, '');
  });

  // ---------- 顾客视角模拟（管理端最新数据 + 与服务端一致的 C/B 可见性和基础价格优先级） ----------
  function audienceVisibleSim(audienceType, viewer) {
    const audience = ['all', 'c', 'b'].includes(audienceType) ? audienceType : 'all';
    return audience === 'all' || audience === viewer;
  }
  async function refreshLive() {
    const paneHead = $('#livePaneHead');
    if (paneHead) paneHead.classList.add('is-syncing');
    state.live.rows = state.products
      .filter((p) => p.status === 'on_sale')
      .filter((p) => audienceVisibleSim(p.audienceType, state.live.viewer))
      .map((p) => ({
        ...p,
        skus: state.skus
          .filter((s) => s.productId === p._id && s.status === 'on_sale')
          .map((s) => ({ _id: s._id, specName: s.specName, packageUnit: s.packageUnit }))
      }));
    try {
      const categoriesRes = await api.call('catalog.categories', { page: 1, pageSize: 100 });
      state.live.categories = categoriesRes && Array.isArray(categoriesRes.rows) ? categoriesRes.rows : [];
    } catch (_) { /* 预览失败不打断编辑 */ }
    state.live.syncedAt = fmtTime(new Date().toISOString());
    // 详情模式下把详情数据（视频关联等）一并刷新，避免停留在旧状态
    if (state.live.detailId && state.live.detailCache) delete state.live.detailCache[state.live.detailId];
    if (state.live.detailId && !detailExtrasOf(state.live.detailId)) {
      await loadDetailExtras(state.live.detailId).catch(() => {});
    }
    renderLive();
    if (paneHead) paneHead.classList.remove('is-syncing');
  }
  function renderLivePane(gridEl, chipsEl, bannerEl) {
    if (!gridEl || !chipsEl || !bannerEl) return;
    gridEl.classList.toggle('is-detail', Boolean(state.live.detailId));
    const syncEl = $('#liveSync');
    if (syncEl) syncEl.textContent = state.live.syncedAt ? `更新于 ${state.live.syncedAt}` : '';
    // 焦点商品因改分类等原因不在当前分类视图时，自动回到“全部”保证它可见
    if (state.live.focusId && state.live.activeCategory) {
      const focusProduct = state.live.rows.find((r) => r._id === state.live.focusId);
      if (focusProduct && focusProduct.categoryId !== state.live.activeCategory) state.live.activeCategory = '';
    }
    const focus = state.live.focusId ? state.products.find((p) => p._id === state.live.focusId) : null;
    const viewerLabel = state.live.viewer === 'b' ? '企业采购客户' : '个人顾客';
    document.querySelectorAll('#edViewerChips button').forEach((b) => b.classList.toggle('is-active', b.dataset.liveViewer === state.live.viewer));
    if (state.editor && state.editor.mode === 'new') {
      bannerEl.style.cssText = '';
      bannerEl.className = 'pv-banner';
      bannerEl.style.cssText = 'background:#e3edfd;color:var(--blue-dark)';
      bannerEl.textContent = '新商品创建并上架后，会出现在下面这个顾客列表里。';
    } else if (!focus) {
      bannerEl.className = 'pv-banner';
      bannerEl.style.cssText = 'background:#eef1f5;color:var(--muted)';
      bannerEl.textContent = '顾客视角会自动定位到你正在修改的商品。';
    } else {
      const visible = state.live.rows.some((r) => r._id === focus._id);
      bannerEl.style.cssText = '';
      bannerEl.className = 'pv-banner ' + (visible ? 'ok' : 'no');
      bannerEl.textContent = visible ? `${viewerLabel}现在能看到「${focus.name}」（高亮的就是它）` : `${viewerLabel}现在看不到「${focus.name}」——${focus.status === 'on_sale' ? '该商品不面向这类顾客' : '它还没上架或已下架'}`;
    }
    chipsEl.innerHTML = [{ _id: '', name: '全部' }, ...state.live.categories]
      .map((c) => `<button data-live-cat="${esc(c._id)}" class="${state.live.activeCategory === c._id ? 'is-active' : ''}">${esc(c.name)}</button>`).join('');
    if (state.live.detailId) {
      renderDetailInto(gridEl);
      return;
    }
    const list = state.live.rows.filter((r) => !state.live.activeCategory || r.categoryId === state.live.activeCategory);
    gridEl.innerHTML = list.map((r) => {
      const sku = (r.skus && r.skus[0]) || null;
      const rule = sku ? previewPriceOf(sku._id, state.live.viewer) : null;
      const spec = sku && sku.specName ? sku.specName : '';
      const asset = state.media.find((m) => m._id === r.coverMediaId);
      const img = asset ? state.urlMap[asset.fileId] || '' : '';
      const isFocus = state.live.focusId && r._id === state.live.focusId;
      const isCurrent = state.editor && state.editor.mode === 'edit' && r._id === state.editor.productId;
      return `<div class="pcell ${isFocus ? 'is-focus' : ''}" ${isCurrent ? `data-live-id="${esc(r._id)}" title="点击查看它的详情页"` : `data-locked="${esc(r._id)}" title="预览只展示当前修改的商品"`} style="${isCurrent ? '' : 'cursor:default;opacity:.82'}">
        ${isFocus ? '<span class="target-tag">就是它</span>' : ''}
        <img src="${esc(img)}" alt="" onerror="this.style.visibility='hidden'">
        <div class="n">${esc(r.name)}</div>
        ${spec ? `<div class="s">${esc(spec)}</div>` : ''}
        <div class="p ${rule ? '' : 'nologin'}">${rule ? yuan(rule.amountCent) : '登录后显示价格'}</div>
        ${sku ? `<div class="s">${esc(purchaseRuleSummary(sku, rule))}</div>` : ''}
      </div>`;
    }).join('') || '<p class="hint" style="grid-column:1/-1;text-align:center;padding:30px 0">这个分类暂时没有在售商品</p>';
    if (state.live.focusId) {
      const cell = gridEl.querySelector(`[data-live-id="${state.live.focusId}"]`);
      if (cell) cell.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }
  // 顾客详情页模拟：点预览列表里的商品进入；详情媒体优先核对顾客侧接口，不可见时回退管理端关联
  function detailExtrasOf(productId) {
    return (state.live.detailCache && state.live.detailCache[productId]) || null;
  }
  async function loadDetailExtras(productId) {
    state.live.detailCache = state.live.detailCache || {};
    if (state.live.detailCache[productId]) return state.live.detailCache[productId];
    let mediaRows = [];
    try {
      // 与顾客端一致：优先走公开详情接口（只含在售商品）
      const detail = await api.call('catalog.product', { productId });
      mediaRows = detail && Array.isArray(detail.media) ? detail.media : [];
    } catch (_) {
      // 未上架商品顾客接口不可见，退回管理端关联，方便上架前核对
      try {
        const res = await api.call('admin.productMedia.list', { productId });
        mediaRows = res && Array.isArray(res.rows) ? res.rows.filter((m) => m.enabled !== false) : [];
      } catch (_) { mediaRows = []; }
    }
    let videoUrl = '';
    const videoRow = mediaRows.find((m) => m.mediaType === 'video');
    if (videoRow) {
      const asset = state.media.find((a) => a._id === videoRow.mediaAssetId);
      videoUrl = asset ? (state.urlMap[asset.fileId] || '') : '';
    }
    const extras = { videoUrl };
    state.live.detailCache[productId] = extras;
    return extras;
  }
  // 详情页预览：按小程序真实详情页 1:1 还原（区块顺序与文案取自 pages/index/index.wxml）
  function renderDetailInto(gridEl) {
    const p = state.live.rows.find((r) => r._id === state.live.detailId);
    if (!p) {
      state.live.detailId = '';
      state.live.detailSkuId = '';
      renderLive();
      return;
    }
    const skus = Array.isArray(p.skus) ? p.skus : [];
    const activeSku = skus.find((s) => s._id === state.live.detailSkuId) || skus[0] || null;
    const rule = activeSku ? previewPriceOf(activeSku._id, state.live.viewer) : null;
    const specName = activeSku ? (activeSku.specName || activeSku.packageUnit || '默认规格') : '';
    const packageUnit = activeSku && activeSku.packageUnit ? activeSku.packageUnit : '';
    const asset = state.media.find((m) => m._id === p.coverMediaId);
    const img = asset ? state.urlMap[asset.fileId] || '' : '';
    const extras = detailExtrasOf(p._id);
    const minimum = Number(rule && rule.minOrderQuantity || activeSku && activeSku.minOrderQuantity || 1);
    const multiple = Number(rule && rule.orderMultiple || activeSku && activeSku.orderMultiple || 1);
    const qty = Math.max(minimum, state.live.detailQty || minimum);
    const warehouseName = (state.warehouses[0] && state.warehouses[0].name) || '梦食鲜仓';
    const qtyHtml = `<span class="qty"><button data-detail-qty="-${multiple}" ${qty <= minimum ? 'disabled' : ''}>−</button><b>${qty}</b><button data-detail-qty="${multiple}">+</button></span>`;
    const specPanel = skus.length > 1 ? `
      <div class="detail-panel">
        <div class="detail-quantity detail-quantity-first"><span>购买数量</span>${qtyHtml}</div>
        <div class="detail-line" style="border-top:1px solid #edf1f4;margin-top:9px;padding-top:9px;"><span>选择规格</span><span>${esc(specName)}</span></div>
        <div class="spec-flow-hint">已选 ${qty} 件，当前规格：${esc(specName)}</div>
        <div class="spec-list">${skus.map((s) => `<button class="${activeSku && s._id === activeSku._id ? 'is-active' : ''}" data-detail-sku="${esc(s._id)}">${esc(s.specName || s.packageUnit || '默认规格')}</button>`).join('')}</div>
      </div>` : `
      <div class="detail-panel detail-quantity single-spec"><span>购买数量</span>${qtyHtml}</div>`;
    const videoHtml = extras === null
      ? '<div class="d-loading">正在加载商品视频信息…</div>'
      : (extras.videoUrl
        ? `<video class="detail-video" controls preload="metadata" src="${esc(extras.videoUrl)}" poster="${esc(img)}"></video>`
        : `<div class="detail-video-empty"><span>该商品暂未上传视频</span><span>如需了解商品，可联系客服咨询</span></div>`);
    gridEl.innerHTML = `
      <div class="pdetail">
        <div class="detail-head"><button data-detail-back>‹</button><span class="dt">商品详情</span><span></span></div>
        <div class="detail-product">
          <div class="detail-image"><img src="${esc(img)}" alt="" onerror="this.style.visibility='hidden'"></div>
          <div class="d-name">${esc(p.name)}</div>
          <div class="d-spec">${esc(specName)}</div>
          <div class="d-price-row"><span class="d-price ${rule ? '' : 'is-locked'}">${rule ? yuan(previewAmountCent(rule, qty)) : '登录后查看价格'}</span></div>
          ${activeSku ? `<div class="d-spec">${esc(purchaseRuleSummary(activeSku, rule))}</div>` : ''}
        </div>
        ${specPanel}
        <div class="detail-panel">
          <div class="detail-line"><span>配送</span><span>${esc(warehouseName)} · 冷链配送 · 配送时间以确认订单为准</span></div>
          <div class="detail-line"><span>服务</span><span>全程冷链 · 商品异常请在签收后 48 小时内联系售后客服</span></div>
        </div>
        <div class="detail-panel">
          <span class="detail-title">商品详情</span>
          ${packageUnit && packageUnit !== specName ? `<div class="detail-line"><span>包装规格</span><span>${esc(packageUnit)}</span></div>` : ''}
          <div class="detail-line"><span>贮存条件</span><span>-18℃ 冷冻保存</span></div>
          <div class="detail-line"><span>温馨提示</span><span>开封后请尽快食用；预计送达时间以订单页面展示为准。</span></div>
        </div>
        <div class="detail-panel detail-video-panel">
          <span class="detail-title">商品视频</span>
          ${videoHtml}
        </div>
        <div class="detail-panel">
          <span class="detail-title">食材保障</span>
          <span class="detail-note">本商品由梦食鲜冷冻仓配发出，出库前完成包装与低温核验。</span>
        </div>
      </div>`;
    const body = gridEl.closest('.pbody');
    if (body) body.scrollTop = 0;
  }
  function renderLive() {
    renderLivePane($('#edGrid'), $('#edChips'), $('#edBanner'));
  }
  function focusLive(productId) {
    state.live.focusId = productId;
    renderLive();
  }
  $('#liveRefreshBtn').addEventListener('click', () => guard(async () => {
    await refreshLive();
    if (state.live.focusId) focusLive(state.live.focusId);
  }, '预览已刷新'));
  // 编辑页打开期间每 30 秒自动同步一次顾客端数据，预览始终保真
  setInterval(() => {
    if (!state.me || busy) return;
    if (document.visibilityState !== 'visible') return;
    const editorActive = document.querySelector('section.view[data-view="editor"]').classList.contains('is-active');
    if (editorActive) refreshLive();
  }, 30000);
  document.addEventListener('click', (event) => {
    const viewerChip = event.target.closest('[data-live-viewer]');
    if (viewerChip) {
      state.live.viewer = viewerChip.dataset.liveViewer;
      refreshLive();
      return;
    }
    const qtyBtn = event.target.closest('[data-detail-qty]');
    if (qtyBtn) {
      const p = state.live.rows.find((r) => r._id === state.live.detailId);
      const sku = p && Array.isArray(p.skus) ? p.skus.find((s) => s._id === state.live.detailSkuId) : null;
      const rule = sku ? previewPriceOf(sku._id, state.live.viewer) : null;
      const minimum = Number(rule && rule.minOrderQuantity || sku && sku.minOrderQuantity || 1);
      state.live.detailQty = Math.max(minimum, (state.live.detailQty || minimum) + Number(qtyBtn.dataset.detailQty));
      renderLive();
      return;
    }
    const lockedCell = event.target.closest('[data-locked]');
    if (lockedCell) {
      const locked = state.live.rows.find((r) => r._id === lockedCell.dataset.locked);
      return showNotice(`预览只展示当前修改的商品。要查看「${locked ? locked.name : '其他商品'}」，请在左侧列表点它的「修改」。`, true);
    }
    const back = event.target.closest('[data-detail-back]');
    if (back) {
      state.live.detailId = '';
      state.live.detailSkuId = '';
      renderLive();
      return;
    }
    const pill = event.target.closest('[data-detail-sku]');
    if (pill) {
      state.live.detailSkuId = pill.dataset.detailSku;
      const p = state.live.rows.find((r) => r._id === state.live.detailId);
      const sku = p && Array.isArray(p.skus) ? p.skus.find((s) => s._id === state.live.detailSkuId) : null;
      const rule = sku ? previewPriceOf(sku._id, state.live.viewer) : null;
      state.live.detailQty = Number(rule && rule.minOrderQuantity || sku && sku.minOrderQuantity || 1);
      renderLive();
      return;
    }
    const cell = event.target.closest('[data-live-id]');
    if (cell) {
      // 工作区边界：只能打开当前正在修改的商品的详情页
      if (cell.dataset.locked) {
        const locked = state.live.rows.find((r) => r._id === cell.dataset.liveId);
        return showNotice(`预览只展示当前修改的商品。要查看「${locked ? locked.name : '其他商品'}」，请在左侧列表点它的「修改」。`, true);
      }
      state.live.detailId = cell.dataset.liveId;
      state.live.focusId = cell.dataset.liveId;
      const p = state.live.rows.find((r) => r._id === state.live.detailId);
      state.live.detailSkuId = p && Array.isArray(p.skus) && p.skus[0] ? p.skus[0]._id : '';
      const sku = p && Array.isArray(p.skus) ? p.skus[0] : null;
      const rule = sku ? previewPriceOf(sku._id, state.live.viewer) : null;
      state.live.detailQty = Number(rule && rule.minOrderQuantity || sku && sku.minOrderQuantity || 1);
      renderLive();
      loadDetailExtras(state.live.detailId).then(() => {
        if (state.live.detailId === cell.dataset.liveId) renderLive();
      }).catch(() => {});
      return;
    }
    const chip = event.target.closest('[data-live-cat]');
    if (chip) {
      state.live.activeCategory = chip.dataset.liveCat;
      state.live.detailId = '';
      state.live.detailSkuId = '';
      renderLive();
    }
  });

  // ---------- 商品列表 ----------
  function activePriceRule(rule, now) {
    if (!rule || rule.status !== 'active') return false;
    const point = now.getTime();
    return !(rule.validFrom && new Date(rule.validFrom).getTime() > point)
      && !(rule.validTo && new Date(rule.validTo).getTime() < point);
  }
  function previewPriceOf(skuId, viewer) {
    const now = new Date();
    const candidates = state.prices
      .filter((rule) => rule.skuId === skuId && activePriceRule(rule, now))
      .map((rule) => {
        if (rule.channel && rule.channel !== 'all' && rule.channel !== 'miniapp') return null;
        if (rule.scopeType === 'customer_type' && rule.scopeId === viewer) return { rule, rank: 200 };
        if (rule.scopeType === 'public') return { rule, rank: 100 };
        return null;
      })
      .filter(Boolean)
      .sort((left, right) => right.rank - left.rank
        || Number(right.rule.priority || 0) - Number(left.rule.priority || 0)
        || String(right.rule.validFrom || '').localeCompare(String(left.rule.validFrom || '')));
    return candidates.length ? candidates[0].rule : null;
  }
  function previewAmountCent(rule, quantity) {
    if (!rule) return null;
    const qty = Number(quantity || 1);
    const tier = (Array.isArray(rule.quantityTiers) ? rule.quantityTiers : [])
      .filter((item) => qty >= Number(item.minQuantity) && (item.maxQuantity === null || item.maxQuantity === undefined || qty <= Number(item.maxQuantity)))
      .sort((left, right) => Number(right.minQuantity) - Number(left.minQuantity))[0];
    return tier ? Number(tier.amountCent) : Number(rule.amountCent);
  }
  function publicPriceOf(skuId) {
    const rules = state.prices.filter((p) => p.skuId === skuId && p.scopeType === 'public' && p.status === 'active');
    return rules.find((r) => !r.channel || r.channel === 'all') || rules[0] || null;
  }
  function formatTierLines(tiers) {
    return (Array.isArray(tiers) ? tiers : []).map((tier) => `${tier.minQuantity}${tier.maxQuantity === null || tier.maxQuantity === undefined ? '+' : `-${tier.maxQuantity}`}=${(Number(tier.amountCent || 0) / 100).toFixed(2)}`).join('\n');
  }
  function parseTierLines(value) {
    return String(value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const match = line.match(/^(\d+)\s*(?:-\s*(\d+)|(\+))\s*[=:]\s*(\d+(?:\.\d{1,2})?)$/);
      if (!match) throw new Error(`阶梯格式不对：${line}。请使用 10-19=22.00 或 20+=20.00`);
      const minQuantity = Number(match[1]);
      const maxQuantity = match[3] ? null : Number(match[2]);
      const amountCent = toCents(match[4]);
      if (!Number.isInteger(minQuantity) || minQuantity < 1 || minQuantity > 999 || (maxQuantity !== null && (!Number.isInteger(maxQuantity) || maxQuantity < minQuantity || maxQuantity > 999)) || Number.isNaN(amountCent)) throw new Error(`阶梯数值不合法：${line}`);
      return { minQuantity, maxQuantity, amountCent };
    });
  }
  function purchaseRuleSummary(sku, rule) {
    const min = Number(rule && rule.minOrderQuantity || sku.minOrderQuantity || 1);
    const multiple = Number(rule && rule.orderMultiple || sku.orderMultiple || 1);
    const tiers = rule && Array.isArray(rule.quantityTiers) ? rule.quantityTiers : [];
    return `${min} 件起购 · ${multiple} 件倍数${tiers.length ? ` · ${tiers.length} 档阶梯价` : ''}`;
  }
  function categoryOf(categoryId) {
    const cat = state.categories.find((c) => c._id === categoryId);
    return cat ? cat.name : '';
  }
  async function loadEditorMedia(productId) {
    try {
      const res = await api.call('admin.productMedia.list', { productId });
      return res && Array.isArray(res.rows) ? res.rows : [];
    } catch (_) { return []; }
  }
  // 价格保存：写入“全部端”公开价，并停用同 SKU 其他端的公开价规则，保证小程序端/网页端一致
  async function saveSkuPrice(sku, cents, options = {}) {
    const rules = state.prices.filter((p) => p.skuId === sku._id && p.scopeType === 'public');
    const preferred = rules.find((r) => !r.channel || r.channel === 'all');
    const quantityTiers = options.quantityTiers === undefined ? (preferred && preferred.quantityTiers || []) : options.quantityTiers;
    const minOrderQuantity = options.minOrderQuantity === undefined ? Number(preferred && preferred.minOrderQuantity || 0) : options.minOrderQuantity;
    const orderMultiple = options.orderMultiple === undefined ? Number(preferred && preferred.orderMultiple || 0) : options.orderMultiple;
    const aiDraft = options.aiDraft === undefined ? Boolean(preferred && preferred.temporary) : options.aiDraft;
    const metadata = { source: aiDraft ? 'ai_generated' : 'client', temporary: aiDraft, demoNote: aiDraft ? '由 AI 生成的测试草案，不代表真实经营价格' : '' };
    if (preferred) {
      await api.call('admin.prices.upsert', {
        id: preferred._id, skuId: sku._id, scopeType: 'public', scopeId: preferred.scopeId || '',
        channel: 'all', amountCent: cents, quantityTiers, minOrderQuantity, orderMultiple,
        priority: preferred.priority || 0, status: 'active', ...metadata
      });
    } else {
      await api.call('admin.prices.upsert', {
        skuId: sku._id, scopeType: 'public', scopeId: '', channel: 'all', amountCent: cents,
        quantityTiers, minOrderQuantity, orderMultiple, priority: 0, status: 'active', ...metadata
      });
    }
    for (const other of rules) {
      if (preferred && other._id === preferred._id) continue;
      if (other.status === 'active' && (other.channel === 'miniapp' || other.channel === 'web')) {
        await api.call('admin.prices.upsert', {
          id: other._id, skuId: sku._id, scopeType: 'public', scopeId: other.scopeId || '', channel: other.channel,
          amountCent: other.amountCent, priority: other.priority || 0, status: 'disabled'
        });
      }
    }
  }
  // 商品保存：全字段回传，避免服务端把未填字段清空
  async function saveProductFields(p, patch) {
    await api.call('admin.products.upsert', {
      id: p._id,
      spuCode: p.spuCode || '', name: patch.name !== undefined ? patch.name : (p.name || ''),
      subtitle: p.subtitle || '', categoryId: patch.categoryId !== undefined ? patch.categoryId : p.categoryId,
      brand: patch.brand !== undefined ? patch.brand : (p.brand || ''),
      origin: patch.origin !== undefined ? patch.origin : (p.origin || ''),
      storageType: p.storageType || 'frozen',
      frozenTemperature: patch.frozenTemperature !== undefined ? patch.frozenTemperature : (p.frozenTemperature || '-18℃'),
      shelfLifeDays: p.shelfLifeDays || 0, description: p.description || '',
      coverMediaId: patch.coverMediaId !== undefined ? patch.coverMediaId : (p.coverMediaId || ''),
      audienceType: patch.audienceType !== undefined ? patch.audienceType : (p.audienceType || 'all'),
      sort: p.sort || 0
    });
  }
  // 规格保存：全字段回传（status 缺省会被服务端重置为草稿，商品会消失，必须带上）
  async function saveSkuFields(s, patch) {
    await api.call('admin.skus.upsert', {
      id: s._id, productId: s.productId,
      skuCode: s.skuCode || '', specName: patch.specName !== undefined ? patch.specName : (s.specName || '默认规格'),
      netWeight: patch.netWeight !== undefined ? patch.netWeight : (s.netWeight || ''),
      weightUnit: s.weightUnit || '', piecesPerCase: s.piecesPerCase || 0,
      packageUnit: patch.packageUnit !== undefined ? patch.packageUnit : (s.packageUnit || ''),
      barcode: s.barcode || '', mediaIds: Array.isArray(s.mediaIds) ? s.mediaIds : [],
      minOrderQuantity: patch.minOrderQuantity !== undefined ? patch.minOrderQuantity : Number(s.minOrderQuantity || 1),
      orderMultiple: patch.orderMultiple !== undefined ? patch.orderMultiple : Number(s.orderMultiple || 1),
      sort: s.sort || 0, status: patch.status !== undefined ? patch.status : (s.status || 'on_sale')
    });
  }
  function renderProducts() {
    const productError = state.loadErrors['admin.products.list'] || state.loadErrors['admin.skus.list'] || state.loadErrors['admin.prices.list'] || state.loadErrors['admin.categories.list'] || state.loadErrors['admin.media.list'];
    if (productError) { $('#productList').innerHTML = `<div class="empty">商品资料读取不完整或当前角色无权限：${esc(productError)}<br><button class="act" id="productLoadRetry">重试</button></div>`; $('#productPager').innerHTML = ''; const retry = $('#productLoadRetry'); if (retry) retry.addEventListener('click', () => guard(async () => { await reloadCore(); renderProducts(); }, '商品已刷新')); return; }
    const keyword = state.productKeyword.trim();
    const rows = state.products.filter((p) => p.status !== 'archived');
    const matched = !keyword ? rows : rows.filter((p) => `${p.name || ''}${p.categoryName || categoryOf(p.categoryId)}`.includes(keyword));
    const pageSize = 12;
    const pageCount = Math.max(1, Math.ceil(matched.length / pageSize));
    state.productPage = Math.min(Math.max(1, state.productPage), pageCount);
    const pageRows = matched.slice((state.productPage - 1) * pageSize, state.productPage * pageSize);
    const listHtml = pageRows.length ? pageRows.map((p) => {
      const skus = state.skus.filter((s) => s.productId === p._id);
      const readiness = productReadiness(p, skus);
      const statusBadge = p.status === 'on_sale' ? '<span class="badge b-green">上架中</span>'
        : p.status === 'off_sale' ? '<span class="badge b-gray">已下架</span>' : `<span class="badge b-orange">${PRODUCT_STATUS_TEXT[p.status] || esc(p.status)}</span>`;
      const priceValues = skus.map((s) => publicPriceOf(s._id)).filter(Boolean).map((rule) => Number(rule.amountCent || 0));
      const priceText = priceValues.length
        ? (Math.min(...priceValues) === Math.max(...priceValues)
          ? yuan(priceValues[0])
          : `${yuan(Math.min(...priceValues))}–${yuan(Math.max(...priceValues))}`)
        : '未设公开价';
      const skuSummary = skus.length
        ? `<div class="summary"><span>${skus.length} 个规格</span><span>·</span><span class="price-range">${priceText}</span><span>·</span><span>${esc(skus.map((sku) => purchaseRuleSummary(sku, publicPriceOf(sku._id))).join(' / '))}</span></div>`
        : '<div class="hint">该商品还没有规格</div>';
      return `<div class="pc">
        <img class="cover" src="${esc(coverUrlOf(p))}" alt="" onerror="this.style.visibility='hidden'">
        <div class="info">
          <div class="pname">${esc(p.name)}</div>
          <div class="pcat">${esc(p.categoryName || categoryOf(p.categoryId))}　${statusBadge}${p.audienceType === 'c' ? ' <span class="badge b-orange">仅个人顾客</span>' : p.audienceType === 'b' ? ' <span class="badge b-orange">仅企业采购客户</span>' : ''}</div>
          ${skuSummary}
        </div>
        <div class="btns">
          <button class="act" data-open-editor="${esc(p._id)}">修改</button>
          ${p.status === 'on_sale'
            ? `<button class="act danger" data-set-status="off_sale" data-id="${esc(p._id)}">下架</button>`
            : `<button class="act green" data-set-status="on_sale" data-id="${esc(p._id)}" ${readiness.ready ? '' : 'disabled'} title="${readiness.ready ? '资料齐全，可以上架' : `还需补充：${esc(readiness.missing.join('、'))}`}">上架</button>`}
          <button class="act plain narrow-only" data-preview-modal="${esc(p._id)}">顾客视角</button>
        </div>
      </div>`;
    }).join('') : `<div class="empty"><div class="big">📦</div>没有找到商品</div>`;
    $('#productList').innerHTML = listHtml;
    $('#productPager').innerHTML = matched.length ? `
      <span>共 ${matched.length} 个商品</span>
      <button class="act plain" data-product-page="${state.productPage - 1}" ${state.productPage === 1 ? 'disabled' : ''}>上一页</button>
      <strong>第 ${state.productPage} / ${pageCount} 页</strong>
      <button class="act plain" data-product-page="${state.productPage + 1}" ${state.productPage === pageCount ? 'disabled' : ''}>下一页</button>
    ` : '';
  }
  $('#productSearch').addEventListener('input', (event) => { state.productKeyword = event.target.value; state.productPage = 1; renderProducts(); });
  $('#productPager').addEventListener('click', (event) => {
    const button = event.target.closest('[data-product-page]');
    if (!button || button.disabled) return;
    state.productPage = Number(button.dataset.productPage) || 1;
    renderProducts();
    document.querySelector('section.view[data-view="products"]').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#productRefresh').addEventListener('click', () => guard(async () => { await reloadCore(); renderProducts(); await refreshLive(); }, '已刷新'));
  $('#newProductBtn').addEventListener('click', () => {
    state.editor = { mode: 'new', productId: '' };
    state.imagePickId = '';
    state.live.focusId = '';
    renderEditor();
    switchView('editor');
    refreshLive();
  });
  $('#productList').addEventListener('click', (event) => {
    const editorBtn = event.target.closest('[data-open-editor]');
    if (editorBtn) {
      state.editor = { mode: 'edit', productId: editorBtn.dataset.openEditor };
      state.imagePickId = '';
      state.live.focusId = editorBtn.dataset.openEditor;
      state.editorMediaRows = [];
      renderEditor();
      switchView('editor');
      refreshLive();
      loadEditorMedia(state.editor.productId).then((rows) => {
        if (state.editor && state.editor.mode === 'edit' && state.editor.productId === editorBtn.dataset.openEditor) {
          state.editorMediaRows = rows;
          renderEditor();
        }
      });
      return;
    }
    const modalPreview = event.target.closest('[data-preview-modal]');
    if (modalPreview) { openPreviewModal(modalPreview.dataset.previewModal); return; }
    const statusBtn = event.target.closest('[data-set-status]');
    if (statusBtn) {
      const next = statusBtn.dataset.setStatus;
      const id = statusBtn.dataset.id;
      const product = state.products.find((p) => p._id === id);
      if (!product) return;
      if (next === 'on_sale') {
        const readiness = productReadiness(product, state.skus.filter((sku) => sku.productId === id));
        if (!readiness.ready) return showNotice(`还不能上架，请先补充：${readiness.missing.join('、')}`, true);
      }
      if (next === 'on_sale' && !global.confirm(`确认上架「${product.name}」？上架后顾客立即可见。`)) return;
      if (next === 'off_sale' && !global.confirm(`确认下架「${product.name}」？下架后顾客看不到这个商品。`)) return;
      guard(async () => {
        if (next === 'on_sale') {
          for (const sku of state.skus.filter((s) => s.productId === id && s.status !== 'on_sale')) {
            await api.call('admin.skus.setStatus', { id: sku._id, status: 'on_sale' });
          }
        }
        await api.call('admin.products.setStatus', { id, status: next });
        await reloadCore();
        renderProducts(); renderDashboard();
        await refreshLive();
        focusLive(id);
      }, next === 'on_sale' ? '商品已上架' : '商品已下架');
    }
  });

  // ---------- 商品编辑页（预览在左，表单在右） ----------
  function categoryOptions(selected) {
    return state.categories.map((c) => `<option value="${esc(c._id)}" ${c._id === selected ? 'selected' : ''}>${esc(c.name)}${c.status === 'enabled' ? '' : '（已停用）'}</option>`).join('');
  }
  function imageStripHtml() {
    const images = state.media.filter((m) => m.type === 'image');
    return `<div class="imgstrip">${images.map((m) => `
      <div class="mcell ${m._id === state.imagePickId ? 'is-picked' : ''}" data-pick-image="${esc(m._id)}">
        <img src="${esc(state.urlMap[m.fileId] || '')}" alt="" onerror="this.style.visibility='hidden'">
        <div class="mname">${esc(m.name || '未命名')}</div>
      </div>`).join('')}</div>`;
  }
  function productReadiness(product, skus) {
    const category = state.categories.find((item) => item._id === product.categoryId);
    const pricedSkus = skus.filter((sku) => publicPriceOf(sku._id));
    const stockedSkus = skus.filter((sku) => state.inventory.some((row) => row.skuId === sku._id && Number(row.available || 0) > 0));
    const checks = [
      { key: 'basics', label: '名称与分类', ok: Boolean(product.name && category && category.status === 'enabled') },
      { key: 'image', label: '商品图片', ok: Boolean(product.coverMediaId) },
      { key: 'price', label: '规格与价格', ok: Boolean(skus.length && pricedSkus.length === skus.length) },
      { key: 'stock', label: '可售库存', ok: Boolean(stockedSkus.length) }
    ];
    return { checks, ready: checks.every((item) => item.ok), missing: checks.filter((item) => !item.ok).map((item) => item.label) };
  }
  function workflowHtml(checks) {
    return `<div class="workflow-card"><h3>上架准备</h3><div class="workflow-steps">${checks.map((item) => `<div class="workflow-step ${item.ok ? 'is-done' : ''}">${esc(item.label)}</div>`).join('')}</div><div class="readiness-list">${checks.map((item) => `<div class="readiness-item ${item.ok ? 'is-done' : ''}">${item.ok ? `${esc(item.label)}已完成` : `还需补充：${esc(item.label)}`}</div>`).join('')}</div></div>`;
  }
  function renderEditor() {
    if (!state.editor) return;
    if (state.editor.mode === 'new') {
      $('#editorTitle').textContent = '新增商品';
      $('#editorForm').innerHTML = `
        <div class="workflow-card">
          <h3>按顺序完成商品资料</h3>
          <div class="workflow-steps"><div class="workflow-step">基本信息</div><div class="workflow-step">商品图片</div><div class="workflow-step">价格与库存</div><div class="workflow-step">确认上架</div></div>
          <p class="hint">资料没准备齐时可以先保存草稿，顾客不会看到。</p>
        </div>
        <div class="form-section">
          <h3>基本信息</h3>
          <div class="frow"><label class="f">商品名称<input id="edName" maxlength="100" placeholder="例如：智利三文鱼块"></label></div>
          <div class="frow">
            <label class="f">分类<select id="edCat">${categoryOptions('')}</select></label>
            <label class="f">面向客户<select id="edAudience">
              <option value="all">所有顾客</option>
              <option value="c">仅个人顾客</option>
              <option value="b">仅企业采购客户</option>
            </select></label>
          </div>
        </div>
        <div class="form-section">
          <h3>商品图片（可选）</h3>
          ${imageStripHtml()}
          <div class="frow" style="margin-top:8px"><label class="act plain upload-mini">上传新图<input type="file" id="edUpload" accept="image/jpeg,image/png,image/webp"></label><span class="hint">不选则先用默认图，之后可再换。</span></div>
        </div>
        <div class="form-section">
          <h3>规格、价格与初始库存</h3>
          <div id="newSpecRows"></div>
          <button class="act plain" id="addSpecRow">+ 再加一个规格</button>
        </div>
        <div class="form-section">
          <h3>完成</h3>
          <div class="frow">
            <button class="act plain" id="saveDraftProductBtn">保存草稿</button>
            <button class="act green" id="createProductBtn">检查并上架</button>
            <button class="act plain" id="cancelNewBtn">取消</button>
          </div>
          <p class="hint">“检查并上架”会确认分类、图片、每个规格的价格和初始库存都已准备好。</p>
        </div>`;
      $('#addSpecRow').addEventListener('click', () => appendNewSpecRow());
      appendNewSpecRow();
      $('#cancelNewBtn').addEventListener('click', () => {
        state.editor = null;
        switchView('products');
      });
      $('#saveDraftProductBtn').addEventListener('click', () => guard(() => submitNewProduct(false), ''));
      $('#createProductBtn').addEventListener('click', () => guard(() => submitNewProduct(true), ''));
      return;
    }
    const p = state.products.find((x) => x._id === state.editor.productId);
    if (!p) { state.editor = null; switchView('products'); return; }
    const skus = state.skus.filter((s) => s.productId === p._id);
    const videoAssoc = (state.editorMediaRows || []).find((m) => m.mediaType === 'video' && m.enabled !== false);
    const videoAsset = videoAssoc ? state.media.find((m) => m._id === videoAssoc.mediaAssetId) : null;
    const videoUrl = videoAsset ? (state.urlMap[videoAsset.fileId] || '') : '';
    const statusBadge = p.status === 'on_sale' ? '<span class="badge b-green">上架中</span>'
      : p.status === 'off_sale' ? '<span class="badge b-gray">已下架</span>' : `<span class="badge b-orange">${PRODUCT_STATUS_TEXT[p.status] || esc(p.status)}</span>`;
    $('#editorTitle').textContent = `修改商品 · ${p.name}`;
    const audienceValue = p.audienceType || 'all';
    const readiness = productReadiness(p, skus);
    $('#editorForm').innerHTML = `
      ${workflowHtml(readiness.checks)}
      <div class="form-section">
        <h3>基本信息 ${statusBadge}</h3>
        <div class="frow"><label class="f">商品名称<input id="edName" maxlength="100" value="${esc(p.name || '')}"></label></div>
        <div class="frow">
          <label class="f">分类<select id="edCat">${categoryOptions(p.categoryId)}</select></label>
          <label class="f">面向客户<select id="edAudience">
            <option value="all" ${audienceValue === 'all' ? 'selected' : ''}>所有顾客</option>
            <option value="c" ${audienceValue === 'c' ? 'selected' : ''}>仅个人顾客</option>
            <option value="b" ${audienceValue === 'b' ? 'selected' : ''}>仅企业采购客户</option>
          </select></label>
        </div>
        <div class="frow"><button class="act" id="saveInfoBtn">保存基本信息</button></div>
        <p class="hint">“面向客户”决定哪些顾客能看到商品。品牌、产地等低频资料可在高级设置中维护。</p>
      </div>
      <div class="form-section">
        <h3>商品图片</h3>
        ${imageStripHtml()}
        <div class="frow" style="margin-top:8px">
          <label class="act plain upload-mini">上传新图<input type="file" id="edUpload" accept="image/jpeg,image/png,image/webp"></label>
          <button class="act" id="saveImageBtn">保存图片</button>
        </div>
        <p class="hint">先点一张图选中（蓝框），再点“保存图片”。</p>
      </div>
      <div class="form-section">
        <h3>规格与价格</h3>
        ${skus.map((s) => {
          const rule = publicPriceOf(s._id);
          const inventoryRows = state.inventory.filter((row) => row.skuId === s._id);
          const available = inventoryRows.reduce((sum, row) => sum + Number(row.available || 0), 0);
          const preferredWarehouse = (inventoryRows[0] && inventoryRows[0].warehouseId) || ((state.warehouses.find((item) => item.status === 'active') || {})._id || '');
          return `<div class="spec-block" data-spec-block="${esc(s._id)}">
            <div class="frow">
              <label class="f">规格名称<input data-f="specName" maxlength="100" value="${esc(s.specName || '')}"></label>
              <label class="f">价格（元）<input data-f="price" type="number" step="0.01" min="0" value="${rule ? (rule.amountCent / 100).toFixed(2) : ''}" placeholder="例如 25.5"></label>
            </div>
            <div class="frow">
              <label class="f">包装单位<input data-f="packageUnit" maxlength="100" value="${esc(s.packageUnit || '')}"></label>
              <label class="f">净含量<input data-f="netWeight" maxlength="40" value="${esc(s.netWeight || '')}"></label>
            </div>
            <div class="purchase-rule-box">
              <strong>起订与阶梯价</strong>
              <div class="frow">
                <label class="f">最少购买数量<input data-f="minOrderQuantity" type="number" min="1" max="999" step="1" value="${esc(s.minOrderQuantity || 1)}"></label>
                <label class="f">整箱倍数（按几件递增）<input data-f="orderMultiple" type="number" min="1" max="999" step="1" value="${esc(s.orderMultiple || 1)}"></label>
              </div>
              <label class="f">数量阶梯价（每行一档，金额填元）<textarea data-f="quantityTiers" rows="3" placeholder="10-19=22.00&#10;20+=20.00">${esc(formatTierLines(rule && rule.quantityTiers))}</textarea></label>
              <label class="draft-check"><input data-f="aiDraft" type="checkbox" ${rule && rule.temporary ? 'checked' : ''}> 这是 AI 测试草案，后续还需运营核实</label>
              <p class="hint">例如“最少 10、按 5 递增”，可买 10、15、20 件。未命中阶梯时使用上方基础价。</p>
            </div>
            <div class="frow">
              <button class="act" data-save-spec="${esc(s._id)}">保存此规格</button>
              <button class="act plain" data-editor-stock="${esc(s._id)}" data-wh="${esc(preferredWarehouse)}">入库</button>
              <span class="hint">当前可售库存：${available}</span>
            </div>
          </div>`;
        }).join('')}
        <div class="spec-block new">
          <div class="head"><strong>新增规格</strong></div>
          <div class="frow">
            <label class="f">规格名称<input id="newSpecName" maxlength="100" placeholder="例如：10包/件"></label>
            <label class="f">价格（元）<input id="newSpecPrice" type="number" step="0.01" min="0" placeholder="例如 120"></label>
          </div>
          <div class="frow">
            <label class="f">包装单位<input id="newSpecUnit" maxlength="100"></label>
            <label class="f">净含量<input id="newSpecWeight" maxlength="40"></label>
          </div>
          <div class="purchase-rule-box">
            <strong>起订与阶梯价</strong>
            <div class="frow"><label class="f">最少购买数量<input id="newSpecMinOrder" type="number" min="1" max="999" step="1" value="1"></label><label class="f">整箱倍数（按几件递增）<input id="newSpecMultiple" type="number" min="1" max="999" step="1" value="1"></label></div>
            <label class="f">数量阶梯价（每行一档，金额填元）<textarea id="newSpecTiers" rows="3" placeholder="10-19=22.00&#10;20+=20.00"></textarea></label>
            <label class="draft-check"><input id="newSpecAiDraft" type="checkbox" checked> 这是 AI 测试草案，后续还需运营核实</label>
          </div>
          <div class="frow"><button class="act green" id="addSkuBtn">添加此规格</button></div>
        </div>
      </div>
      <div class="form-section">
        <h3>详情视频</h3>
        ${videoAssoc ? `
          ${videoUrl ? `<video controls preload="metadata" src="${esc(videoUrl)}" style="width:100%;min-height:170px;border-radius:10px;background:#08131f"></video>` : '<p class="hint">视频已关联（加载中…）</p>'}
          <div class="frow" style="margin-top:8px"><button class="act danger" id="removeVideoBtn">移除详情视频</button></div>
          <p class="hint">移除后顾客端详情页不再显示此视频（素材仍保留在素材库）。</p>
        ` : `
          <div class="frow">
            <label class="act plain upload-mini">上传详情视频（≤4MB，mp4/webm）<input type="file" id="edVideoUpload" accept="video/mp4,video/webm,video/quicktime"></label>
          </div>
          <p class="hint">上传后会自动显示在商品详情页。超过 4MB 的视频请交给管理员处理。</p>
        `}
      </div>
      <div class="form-section">
        <h3>上架状态</h3>
        <p class="hint">上架后，符合“面向客户”设置的顾客可以看到商品；下架后所有顾客都看不到。不同顾客看到的价格由系统自动判断。</p>
        <div class="publish-actions">
          ${p.status === 'on_sale'
            ? `<button class="act danger" id="statusBtn" data-next="off_sale">下架商品</button>`
            : `<button class="act green" id="statusBtn" data-next="on_sale" ${readiness.ready ? '' : 'disabled'}>确认上架</button>`}
          ${!readiness.ready && p.status !== 'on_sale' ? `<p class="hint">还不能上架：请补充${esc(readiness.missing.join('、'))}。</p>` : ''}
        </div>
      </div>`;
    $('#saveInfoBtn').addEventListener('click', () => guard(async () => {
      await saveProductFields(p, collectEditorBasics(p));
      await reloadCore();
      renderEditor();
      await refreshLive();
      focusLive(p._id);
    }, '基本信息已保存'));
    $('#saveImageBtn').addEventListener('click', () => guard(async () => {
      if (!state.imagePickId) return showNotice('请先在图里点选一张（蓝框）', true);
      await saveProductFields(p, { coverMediaId: state.imagePickId, ...collectEditorBasics(p) });
      await reloadCore();
      renderEditor();
      await refreshLive();
      focusLive(p._id);
    }, '商品图片已保存'));
    $('#addSkuBtn').addEventListener('click', () => guard(async () => {
      const specName = ($('#newSpecName').value || '').trim();
      if (!specName) return showNotice('请填写规格名称', true);
      const priceText = $('#newSpecPrice').value;
      const minOrderQuantity = Number($('#newSpecMinOrder').value);
      const orderMultiple = Number($('#newSpecMultiple').value);
      if (!Number.isInteger(minOrderQuantity) || minOrderQuantity < 1 || minOrderQuantity > 999) return showNotice('最少购买数量必须是 1 到 999 的整数', true);
      if (!Number.isInteger(orderMultiple) || orderMultiple < 1 || orderMultiple > 999) return showNotice('整箱倍数必须是 1 到 999 的整数', true);
      const quantityTiers = parseTierLines($('#newSpecTiers').value);
      const aiDraft = $('#newSpecAiDraft').checked;
      let cents = null;
      if (priceText !== '') {
        cents = toCents(priceText);
        if (Number.isNaN(cents)) return showNotice('价格格式不对，例如 25.5', true);
      }
      const created = await api.call('admin.skus.upsert', {
        productId: p._id, specName, packageUnit: ($('#newSpecUnit').value || '').trim(),
        netWeight: ($('#newSpecWeight').value || '').trim(), minOrderQuantity, orderMultiple,
        mediaIds: [], sort: skus.length, status: 'on_sale'
      });
      if (cents !== null && created) {
        await saveSkuPrice(created, cents, { quantityTiers, minOrderQuantity: 0, orderMultiple: 0, aiDraft });
      }
      await reloadCore();
      renderEditor();
      await refreshLive();
      focusLive(p._id);
    }, '规格已添加并上架'));
    $('#statusBtn').addEventListener('click', (event) => {
      const next = event.currentTarget.dataset.next;
      const confirmText = next === 'on_sale' ? `确认上架「${p.name}」？上架后顾客立即可见。` : `确认下架「${p.name}」？下架后顾客看不到这个商品。`;
      if (!global.confirm(confirmText)) return;
      guard(async () => {
        if (next === 'on_sale') {
          for (const sku of state.skus.filter((s) => s.productId === p._id && s.status !== 'on_sale')) {
            await api.call('admin.skus.setStatus', { id: sku._id, status: 'on_sale' });
          }
        }
        await api.call('admin.products.setStatus', { id: p._id, status: next });
        await reloadCore();
        renderEditor();
        renderDashboard();
        await refreshLive();
        focusLive(p._id);
      }, next === 'on_sale' ? '商品已上架' : '商品已下架');
    });
    const removeVideoBtn = $('#removeVideoBtn');
    if (removeVideoBtn) {
      removeVideoBtn.addEventListener('click', () => guard(async () => {
        await api.call('admin.productMedia.upsert', { productId: p._id, mediaAssetId: videoAssoc.mediaAssetId, mediaType: 'video', role: videoAssoc.role || 'detail', sort: videoAssoc.sort || 0, enabled: false });
        await reloadCore();
        state.editorMediaRows = await loadEditorMedia(p._id);
        renderEditor();
        await refreshLive();
        focusLive(p._id);
      }, '详情视频已移除，顾客端详情页不再显示'));
    }
  }
  // 编辑页里保存任何区块时，基本信息输入框的当前值一并带回，避免互相覆盖
  function collectEditorBasics(p) {
    const nameEl = $('#edName');
    if (!nameEl) return {};
    const patch = { name: (nameEl.value || '').trim() || p.name };
    if ($('#edCat')) patch.categoryId = $('#edCat').value;
    if ($('#edAudience')) patch.audienceType = $('#edAudience').value;
    return patch;
  }
  $('#backToProducts').addEventListener('click', () => {
    state.editor = null;
    renderProducts();
    switchView('products');
  });
  $('#editorForm').addEventListener('click', (event) => {
    const stockButton = event.target.closest('[data-editor-stock]');
    if (stockButton) {
      openStockAdjustment(stockButton.dataset.editorStock, stockButton.dataset.wh, 'in');
      return;
    }
    const pickImage = event.target.closest('[data-pick-image]');
    if (pickImage) {
      state.imagePickId = pickImage.dataset.pickImage;
      document.querySelectorAll('#editorForm .imgstrip .mcell').forEach((el) => el.classList.toggle('is-picked', el.dataset.pickImage === state.imagePickId));
      return;
    }
    const saveSpecBtn = event.target.closest('[data-save-spec]');
    if (saveSpecBtn) {
      const sku = state.skus.find((s) => s._id === saveSpecBtn.dataset.saveSpec);
      if (!sku) return;
      const block = saveSpecBtn.closest('.spec-block');
      const read = (name) => { const el = block.querySelector(`[data-f="${name}"]`); return el ? el.value : undefined; };
      const specName = (read('specName') || '').trim();
      if (!specName) return showNotice('规格名称不能为空', true);
      const priceText = read('price');
      const minOrderQuantity = Number(read('minOrderQuantity'));
      const orderMultiple = Number(read('orderMultiple'));
      if (!Number.isInteger(minOrderQuantity) || minOrderQuantity < 1 || minOrderQuantity > 999) return showNotice('最少购买数量必须是 1 到 999 的整数', true);
      if (!Number.isInteger(orderMultiple) || orderMultiple < 1 || orderMultiple > 999) return showNotice('整箱倍数必须是 1 到 999 的整数', true);
      let quantityTiers;
      try { quantityTiers = parseTierLines(read('quantityTiers')); } catch (error) { return showNotice(error.message, true); }
      const aiDraftEl = block.querySelector('[data-f="aiDraft"]');
      const aiDraft = Boolean(aiDraftEl && aiDraftEl.checked);
      guard(async () => {
        await saveSkuFields(sku, { specName, packageUnit: (read('packageUnit') || '').trim(), netWeight: (read('netWeight') || '').trim(), minOrderQuantity, orderMultiple });
        if (priceText !== '') {
          const cents = toCents(priceText);
          if (Number.isNaN(cents)) throw new Error('价格格式不对，例如 25.5');
          await saveSkuPrice(sku, cents, { quantityTiers, minOrderQuantity: 0, orderMultiple: 0, aiDraft });
        }
        await reloadCore();
        renderEditor();
        await refreshLive();
        focusLive(sku.productId);
      }, '规格已保存，价格对小程序端和网页端同时生效');
    }
  });
  $('#editorForm').addEventListener('change', (event) => {
    if (event.target.id === 'edVideoUpload') {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      const pid = state.editor && state.editor.productId;
      if (!pid) return;
      guard(async () => {
        showNotice('正在上传视频…');
        const uploaded = await api.uploadMediaFile(file, 'video');
        const asset = await api.call('admin.media.upsert', {
          name: ((file.name || '详情视频').replace(/\.[^.]+$/, '').slice(0, 80)) || '详情视频',
          type: 'video', source: 'admin_upload', temporary: false,
          targetPlatforms: ['miniapp', 'web'], fileId: uploaded.fileId, mimeType: uploaded.mimeType, sizeBytes: uploaded.sizeBytes
        });
        await api.call('admin.productMedia.upsert', { productId: pid, mediaAssetId: asset._id, mediaType: 'video', role: 'detail', enabled: true });
        await reloadCore();
        state.editorMediaRows = await loadEditorMedia(pid);
        renderEditor();
        await refreshLive();
        focusLive(pid);
      }, '详情视频已上传并挂到商品详情页');
      return;
    }
    if (event.target.id !== 'edUpload') return;
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    guard(async () => {
      showNotice('正在上传图片…');
      const uploaded = await api.uploadMediaFile(file, 'image');
      const name = (file.name || '商品图').replace(/\.[^.]+$/, '').slice(0, 80) || '商品图';
      const asset = await api.call('admin.media.upsert', {
        name, type: 'image', source: 'admin_upload', temporary: false,
        targetPlatforms: ['miniapp', 'web'], fileId: uploaded.fileId, mimeType: uploaded.mimeType, sizeBytes: uploaded.sizeBytes
      });
      state.media = await list('admin.media.list');
      if (asset && asset.fileId) await tempUrls([asset.fileId]);
      state.imagePickId = asset && asset._id || '';
      renderEditor();
      showNotice('上传成功，已选中这张图，记得点“保存图片”');
    }, '');
  });
  function appendNewSpecRow() {
    const row = document.createElement('div');
    row.className = 'spec-block';
    row.innerHTML = `
      <div class="frow">
        <label class="f">规格名称<input data-new="specName" maxlength="100" placeholder="例如：1KG/包"></label>
        <label class="f">价格（元）<input data-new="price" type="number" step="0.01" min="0" placeholder="例如 49.9"></label>
      </div>
      <div class="frow">
        <label class="f">包装单位<input data-new="packageUnit" maxlength="100"></label>
        <label class="f">净含量<input data-new="netWeight" maxlength="40"></label>
      </div>
      <div class="frow">
        <label class="f">初始库存<input data-new="stock" type="number" min="0" step="1" value="0"><small>填实际可售数量，之后可在库存管理继续入库。</small></label>
      </div>
      <div class="purchase-rule-box">
        <strong>起订与阶梯价</strong>
        <div class="frow">
          <label class="f">最少购买数量<input data-new="minOrderQuantity" type="number" min="1" max="999" step="1" value="1"></label>
          <label class="f">整箱倍数（按几件递增）<input data-new="orderMultiple" type="number" min="1" max="999" step="1" value="1"></label>
        </div>
        <label class="f">数量阶梯价（每行一档，金额填元）<textarea data-new="quantityTiers" rows="3" placeholder="10-19=22.00&#10;20+=20.00"></textarea></label>
        <label class="draft-check"><input data-new="aiDraft" type="checkbox" checked> 这是 AI 测试草案，后续还需运营核实</label>
        <p class="hint">测试值不代表真实经营价格；保存后仍可继续修改。</p>
      </div>
      <div class="frow"><button class="act plain" data-remove-spec>移除此规格</button></div>`;
    const container = $('#newSpecRows');
    container.appendChild(row);
    row.querySelector('[data-remove-spec]').addEventListener('click', () => {
      if (container.children.length <= 1) return showNotice('至少保留一个规格', true);
      row.remove();
    });
  }
  async function submitNewProduct(shouldPublish) {
    const name = ($('#edName').value || '').trim();
    if (!name) return showNotice('请填写商品名称', true);
    const categoryId = $('#edCat') ? $('#edCat').value : '';
    if (!categoryId) return showNotice('请选择分类；没有合适分类时，请到高级设置新增分类', true);
    const audienceType = $('#edAudience') ? $('#edAudience').value : 'all';
    const specs = [...document.querySelectorAll('#newSpecRows .spec-block')].map((block) => ({
      specName: (block.querySelector('[data-new="specName"]').value || '').trim(),
      packageUnit: (block.querySelector('[data-new="packageUnit"]').value || '').trim(),
      netWeight: (block.querySelector('[data-new="netWeight"]').value || '').trim(),
      priceText: block.querySelector('[data-new="price"]').value,
      stock: Number(block.querySelector('[data-new="stock"]').value || 0),
      minOrderQuantity: Number(block.querySelector('[data-new="minOrderQuantity"]').value),
      orderMultiple: Number(block.querySelector('[data-new="orderMultiple"]').value),
      quantityTiersText: block.querySelector('[data-new="quantityTiers"]').value,
      aiDraft: block.querySelector('[data-new="aiDraft"]').checked
    }));
    if (!specs.some((s) => s.specName)) return showNotice('至少填写一个规格名称', true);
    if (specs.some((s) => !Number.isInteger(s.stock) || s.stock < 0)) return showNotice('初始库存必须填写0或正整数', true);
    if (specs.some((s) => s.specName && (!Number.isInteger(s.minOrderQuantity) || s.minOrderQuantity < 1 || s.minOrderQuantity > 999))) return showNotice('最少购买数量必须是 1 到 999 的整数', true);
    if (specs.some((s) => s.specName && (!Number.isInteger(s.orderMultiple) || s.orderMultiple < 1 || s.orderMultiple > 999))) return showNotice('整箱倍数必须是 1 到 999 的整数', true);
    for (const s of specs) {
      if (s.specName && s.priceText !== '') {
        if (Number.isNaN(toCents(s.priceText))) return showNotice(`规格「${s.specName}」的价格格式不对`, true);
        try { s.quantityTiers = parseTierLines(s.quantityTiersText); } catch (error) { return showNotice(`规格「${s.specName}」：${error.message}`, true); }
      }
    }
    if (shouldPublish) {
      const category = state.categories.find((item) => item._id === categoryId);
      const namedSpecs = specs.filter((item) => item.specName);
      const missing = [];
      if (!category || category.status !== 'enabled') missing.push('启用的商品分类');
      if (!state.imagePickId) missing.push('商品图片');
      if (namedSpecs.some((item) => item.priceText === '')) missing.push('每个规格的价格');
      if (!namedSpecs.some((item) => item.stock > 0)) missing.push('至少一个规格的初始库存');
      if (!state.warehouses.some((item) => item.status === 'active')) missing.push('可用仓库');
      if (missing.length) return showNotice(`暂时不能上架，请先补充：${missing.join('、')}。也可以先保存草稿。`, true);
      if (!global.confirm(`确认上架“${name}”？上架后符合客户范围的顾客可以看到。`)) return;
    }
    showNotice('正在创建商品…');
    const product = await api.call('admin.products.upsert', {
      name, categoryId, audienceType,
      coverMediaId: state.imagePickId || '', sort: 0, status: 'draft'
    });
    if (!product || !product._id) throw new Error('商品创建失败，请重试');
    let liveFail = '';
    const warehouse = state.warehouses.find((item) => item.status === 'active');
    for (let index = 0; index < specs.length; index += 1) {
      const s = specs[index];
      if (!s.specName) continue;
      const sku = await api.call('admin.skus.upsert', {
        productId: product._id, specName: s.specName, packageUnit: s.packageUnit, netWeight: s.netWeight,
        minOrderQuantity: s.minOrderQuantity, orderMultiple: s.orderMultiple,
        mediaIds: [], sort: index, status: shouldPublish ? 'on_sale' : 'draft'
      });
      if (s.priceText !== '' && sku) {
        await saveSkuPrice(sku, toCents(s.priceText), { quantityTiers: s.quantityTiers || [], minOrderQuantity: 0, orderMultiple: 0, aiDraft: s.aiDraft });
      }
      if (sku && warehouse && s.stock > 0) {
        await api.call('admin.inventory.adjust', { warehouseId: warehouse._id, skuId: sku._id, change: s.stock, reason: '新品首次入库', idempotencyKey: `new-product-${product._id}-${sku._id}` });
      }
    }
    if (shouldPublish) try {
      await api.call('admin.products.setStatus', { id: product._id, status: 'on_sale' });
    } catch (error) {
      liveFail = error && error.message || '上架失败';
    }
    await reloadCore();
    renderProducts(); renderDashboard();
    state.editor = { mode: 'edit', productId: product._id };
    state.live.focusId = product._id;
    renderEditor();
    switchView('editor');
    await refreshLive();
    focusLive(product._id);
    showNotice(liveFail ? `商品已保存，但上架没成功：${friendlyError({ message: liveFail })}` : shouldPublish ? '商品已创建并上架，顾客现在可以看到' : '商品草稿已保存，顾客暂时看不到');
  }

  // 顾客视角弹窗（窄屏时替代侧栏）
  async function openPreviewModal(productId) {
    const product = state.products.find((p) => p._id === productId);
    if (!product) return;
    openModal(`
      <h3>顾客视角 · ${esc(product.name)}</h3>
      <div id="pvBanner" class="pv-banner" style="background:#eef1f5;color:var(--muted)">正在读取顾客端实时数据…</div>
      <div class="phone">
        <div class="ptop">梦食鲜 · 冻品商城</div>
        <div class="pbody"><div class="pgrid" id="pvGrid"></div></div>
      </div>
      <p class="pv-note">这里显示顾客当前能够看到的商品效果。</p>
      <div class="actions"><button class="act plain" data-close>关闭</button></div>
    `);
    let pvRows = [];
    try {
      const productsRes = await api.call('catalog.products', { page: 1, pageSize: 100 });
      if (!$('#pvBanner')) return;
      pvRows = productsRes && Array.isArray(productsRes.rows) ? productsRes.rows : [];
    } catch (error) {
      const banner = $('#pvBanner');
      if (banner) { banner.className = 'pv-banner no'; banner.textContent = '预览加载失败：' + (error && error.message || '请重试'); }
      return;
    }
    const visible = pvRows.some((r) => r._id === productId);
    const banner = $('#pvBanner');
    banner.className = 'pv-banner ' + (visible ? 'ok' : 'no');
    banner.textContent = visible ? `当前网页顾客身份能看到「${product.name}」` : `当前网页顾客身份看不到「${product.name}」——它可能未上架，或不面向当前身份`;
    $('#pvGrid').innerHTML = pvRows.map((r) => {
      const sku = (r.skus && r.skus[0]) || null;
      const rule = sku ? publicPriceOf(sku._id) : null;
      const asset = state.media.find((m) => m._id === r.coverMediaId);
      const img = asset ? state.urlMap[asset.fileId] || '' : '';
      return `<div class="pcell ${r._id === productId ? 'is-target' : ''}">
        ${r._id === productId ? '<span class="target-tag">这个商品</span>' : ''}
        <img src="${esc(img)}" alt="" onerror="this.style.visibility='hidden'">
        <div class="n">${esc(r.name)}</div>
        <div class="p ${rule ? '' : 'nologin'}">${rule ? yuan(rule.amountCent) : '登录后显示价格'}</div>
      </div>`;
    }).join('');
  }

  // ---------- 退款 ----------
  function refundStatusLabel(refund) {
    if (refund.status === 'succeeded' && refund.channelStatus !== 'succeeded') return '退款结果待渠道核验';
    return REFUND_STATUS_TEXT[refund.status] || refund.status || '状态未知';
  }
  function refundMatchesFilter(refund) {
    if (state.refundFilter === 'todo') return refund.status === 'requested';
    if (state.refundFilter === 'processing') return ['approved', 'processing', 'channel_pending'].includes(refund.status);
    if (state.refundFilter === 'manual') return refund.status === 'awaiting_manual_refund' || refund.manualRefundRequired === true;
    if (state.refundFilter === 'done') return ['rejected', 'succeeded', 'failed'].includes(refund.status);
    return true;
  }
  function renderRefunds() {
    const rows = state.refunds.filter(refundMatchesFilter);
    $('#refundChips').querySelectorAll('[data-refund-filter]').forEach((button) => button.classList.toggle('is-active', button.dataset.refundFilter === state.refundFilter));
    if (state.loadErrors['admin.refunds.list']) { $('#refundList').innerHTML = `<div class="empty">售后读取失败或当前角色无权限：${esc(state.loadErrors['admin.refunds.list'])}<br><button class="act" id="refundLoadRetry">重试</button></div>`; const retry = $('#refundLoadRetry'); if (retry) retry.addEventListener('click', () => guard(async () => { await reloadTrade(); renderRefunds(); }, '售后已刷新')); return; }
    if (!rows.length) { $('#refundList').innerHTML = `<div class="empty"><div class="big">🌤️</div>当前筛选下没有售后申请</div>`; return; }
    $('#refundList').innerHTML = rows.map((r) => {
      const isTodo = r.status === 'requested';
      const manual = r.status === 'awaiting_manual_refund' || r.manualRefundRequired === true;
      return `<div class="oc">
        <div class="row1">
          <strong>退款单 ${esc(r.refundNo || r._id)}</strong>
          <span class="badge ${isTodo || manual ? 'b-red' : 'b-gray'}">${esc(refundStatusLabel(r))}</span>
          <span class="spacer" style="flex:1"></span>
          <span class="money">${yuan(r.amountCent)}</span>
        </div>
        <div class="meta">申请时间：${fmtTime(r.createdAt)}　原因：${esc(r.reason || r.reasonCode || '—')}　退款通道：${esc(r.channelStatus || '未提交')}</div>
        <div class="actions"><button class="act plain" data-refund-detail="${esc(r._id)}">查看详情</button></div>
        ${isTodo ? `<div class="actions">
          <button class="act green" data-refund="approved" data-id="${esc(r._id)}">同意退款</button>
          <button class="act danger" data-refund="rejected" data-id="${esc(r._id)}">驳回</button>
        </div>` : ''}${['awaiting_manual_refund', 'processing'].includes(r.status) ? `<div class="actions"><button class="act danger" data-refund-process="channel_pending" data-id="${esc(r._id)}">登记为已提交退款渠道</button><small>此操作不代表退款成功</small></div>` : ''}
      </div>`;
    }).join('');
  }
  async function openRefundDetail(id) {
    openModal('<h3>售后详情</h3><div class="empty">正在加载订单与售后快照…</div>');
    let detail;
    try { detail = await api.call('admin.refunds.get', { id }); }
    catch (error) { openModal(`<h3>售后详情加载失败</h3><p class="hint">${esc(friendlyError(error))}</p><div class="actions"><button class="act plain" data-close>关闭</button><button class="act" id="refundDetailRetry">重试</button></div>`); $('#refundDetailRetry').addEventListener('click', () => openRefundDetail(id)); return; }
    const refund = detail.refund || detail; const order = detail.order || {}; const items = detail.items || refund.items || [];
    const canReview = refund.status === 'requested'; const canProcess = ['awaiting_manual_refund', 'processing'].includes(refund.status);
    const refundSplit = refund.creditAdjustmentCent !== undefined || refund.cashRefundRequiredCent !== undefined
      ? `<div><b>账期应收冲减</b><span>${yuan(refund.creditAdjustmentCent)}</span></div><div><b>仍需原路退款</b><span>${yuan(refund.cashRefundRequiredCent)}</span></div>`
      : '';
    openModal(`<h3>售后单 ${esc(refund.refundNo || refund._id)}</h3><div class="readiness-list"><div><b>当前状态</b><span>${esc(refundStatusLabel(refund))}</span></div><div><b>退款通道</b><span>${esc(refund.channelStatus || '尚未提交')}</span></div><div><b>关联订单</b><span>${esc(order.orderNo || refund.orderId || '—')}</span></div><div><b>申请金额</b><span>${yuan(refund.amountCent)}</span></div>${refundSplit}<div><b>原因与说明</b><span>${esc(refund.reason || refund.reasonCode || '—')} · ${esc(refund.description || '未填写')}</span></div></div><div class="compact-list">${items.map(item => `<div class="compact-row"><div><strong>${esc(item.productNameSnapshot || item.productName || item.skuId || '商品')}</strong><span>${esc(item.specSnapshot || '')} · 数量 ${Number(item.quantity || 0)} · 本次申请 ${yuan(item.amountCent)} · 订单项实付 ${yuan(item.paidSubtotalCent === undefined ? item.amountCent : item.paidSubtotalCent)}</span></div></div>`).join('') || '<div class="empty">没有商品明细</div>'}</div>${(refund.mediaIds || []).length ? `<p class="hint">凭证媒体：${refund.mediaIds.map(esc).join('、')}</p>` : ''}${canReview ? '<label class="field">审核说明<textarea id="refundReviewNote" maxlength="300"></textarea></label><div class="actions"><button class="act danger" data-detail-review="rejected">驳回申请</button><button class="act green" data-detail-review="approved">审核通过</button></div>' : ''}${canProcess ? '<label class="field">通道提交备注<textarea id="refundProcessNote" maxlength="300"></textarea></label><div class="actions"><button class="act danger" data-detail-process>登记为已提交退款渠道</button></div><p class="hint">登记后仍需等待退款渠道返回结果，不会标记退款成功。</p>' : ''}<p class="hint">账期冲减以服务端账务流水为准，现金退款以渠道验签通知为准；售后退款不代表退货商品已经入库。</p><div class="actions"><button class="act plain" data-close>关闭</button></div>`);
    document.querySelectorAll('[data-detail-review]').forEach(button => button.addEventListener('click', () => reviewRefund(id, button.dataset.detailReview, $('#refundReviewNote').value.trim())));
    const processButton = document.querySelector('[data-detail-process]'); if (processButton) processButton.addEventListener('click', () => processRefund(id, $('#refundProcessNote').value.trim()));
  }
  async function reviewRefund(id, decision, reviewNote = '') {
    if (!global.confirm(decision === 'approved' ? '确认审核通过？通过后只会进入退款处理，不代表退款成功。' : '确认驳回这笔售后申请？')) return;
    await guard(async () => { await api.call('admin.refunds.review', { id, decision, reviewNote, idempotencyKey: newIdempotencyKey() }); closeModal(); await reloadTrade(); renderRefunds(); renderDashboard(); }, decision === 'approved' ? '已审核通过，等待后续退款处理' : '已驳回售后申请');
  }
  async function processRefund(id, note = '') {
    if (!global.confirm('确认已把这笔退款提交给真实退款渠道？此操作不会标记退款成功，仍需等待渠道结果。')) return;
    await guard(async () => { await api.call('admin.refunds.process', { id, action: 'channel_pending', idempotencyKey: newIdempotencyKey(), note }); closeModal(); await reloadTrade(); renderRefunds(); renderDashboard(); }, '已登记提交退款渠道，等待渠道结果');
  }
  $('#refundChips').addEventListener('click', (event) => { const button = event.target.closest('[data-refund-filter]'); if (!button) return; state.refundFilter = button.dataset.refundFilter; renderRefunds(); });
  $('#refundRefresh').addEventListener('click', () => guard(async () => { await reloadTrade(); renderRefunds(); renderDashboard(); }, '已刷新'));
  $('#refundList').addEventListener('click', (event) => {
    const detail = event.target.closest('[data-refund-detail]'); if (detail) return openRefundDetail(detail.dataset.refundDetail);
    const process = event.target.closest('[data-refund-process]'); if (process) return processRefund(process.dataset.id, '运营后台登记退款渠道待确认');
    const btn = event.target.closest('[data-refund]');
    if (!btn) return;
    return reviewRefund(btn.dataset.id, btn.dataset.refund);
  });

  // ---------- 库存 ----------
  function renderInventory() {
    const warehouseSelect = $('#inventoryWarehouseFilter');
    if (warehouseSelect) warehouseSelect.innerHTML = '<option value="all">全部仓库</option>' + state.warehouses.map(item => `<option value="${esc(item._id)}" ${state.inventoryWarehouseFilter === item._id ? 'selected' : ''}>${esc(item.name || item._id)}</option>`).join('');
    const inventoryError = state.loadErrors['admin.inventory.list'] || state.loadErrors['admin.products.list'] || state.loadErrors['admin.skus.list'] || state.loadErrors['admin.warehouses.list'];
    if (inventoryError) { $('#inventoryList').innerHTML = `<div class="empty">库存资料读取不完整或当前角色无权限：${esc(inventoryError)}<br><button class="act" id="inventoryLoadRetry">重试</button></div>`; $('#inventoryPager').innerHTML = ''; const retry = $('#inventoryLoadRetry'); if (retry) retry.addEventListener('click', () => guard(async () => { await reloadCore(); renderInventory(); }, '库存已刷新')); return; }
    if (!state.inventory.length) { $('#inventoryList').innerHTML = `<div class="empty"><div class="big">🏷️</div>还没有库存记录</div>`; $('#inventoryPager').innerHTML = ''; return; }
    const keyword = state.inventoryKeyword.trim();
    const rows = state.inventory.map((inv) => {
      const sku = state.skus.find((s) => s._id === inv.skuId);
      const product = sku && state.products.find((p) => p._id === sku.productId);
      const warehouse = state.warehouses.find((w) => w._id === inv.warehouseId);
      return { inv, sku, product, warehouse };
    }).filter((row) => row.sku && (state.inventoryWarehouseFilter === 'all' || row.inv.warehouseId === state.inventoryWarehouseFilter) && (!keyword || (row.product && row.product.name || '').includes(keyword)));
    if (!rows.length) { $('#inventoryList').innerHTML = `<div class="empty"><div class="big">📦</div>没有匹配的库存记录</div>`; $('#inventoryPager').innerHTML = ''; return; }
    const pageSize = 15;
    const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
    state.inventoryPage = Math.min(Math.max(1, state.inventoryPage), pageCount);
    const pageRows = rows.slice((state.inventoryPage - 1) * pageSize, state.inventoryPage * pageSize);
    $('#inventoryList').innerHTML = pageRows.map(({ inv, sku, product, warehouse }) => `
      <div class="oc">
        <div class="row1">
          <strong>${esc(product ? product.name : sku.specName)}</strong>
          <span class="hint">${esc(sku.specName || '')}</span>
          <span class="spacer" style="flex:1"></span>
          <span>可售 <strong style="font-size:20px;color:${inv.available > 0 ? 'var(--green)' : 'var(--red)'}">${Number(inv.available || 0)}</strong></span>
        </div>
        <div class="meta">仓库：${esc(warehouse ? warehouse.name : inv.warehouseId)}　在库 ${Number(inv.onHand || 0)}　预占 ${Number(inv.reserved || 0)}</div>
        <div class="actions">
          <button class="act green" data-stock="in" data-sku="${esc(inv.skuId)}" data-wh="${esc(inv.warehouseId)}">入库</button>
          <button class="act danger" data-stock="out" data-sku="${esc(inv.skuId)}" data-wh="${esc(inv.warehouseId)}">出库</button>
        </div>
      </div>`).join('');
    $('#inventoryPager').innerHTML = `
      <span>共 ${rows.length} 条库存</span>
      <button class="act plain" data-inventory-page="${state.inventoryPage - 1}" ${state.inventoryPage === 1 ? 'disabled' : ''}>上一页</button>
      <strong>第 ${state.inventoryPage} / ${pageCount} 页</strong>
      <button class="act plain" data-inventory-page="${state.inventoryPage + 1}" ${state.inventoryPage === pageCount ? 'disabled' : ''}>下一页</button>`;
  }
  $('#inventorySearch').addEventListener('input', (event) => { state.inventoryKeyword = event.target.value; state.inventoryPage = 1; renderInventory(); });
  $('#inventoryWarehouseFilter').addEventListener('change', (event) => { state.inventoryWarehouseFilter = event.target.value; state.inventoryPage = 1; renderInventory(); });
  $('#inventoryPager').addEventListener('click', (event) => {
    const button = event.target.closest('[data-inventory-page]');
    if (!button || button.disabled) return;
    state.inventoryPage = Number(button.dataset.inventoryPage) || 1;
    renderInventory();
    document.querySelector('section.view[data-view="inventory"]').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#inventoryRefresh').addEventListener('click', () => guard(async () => { await Promise.all([reloadCore(), loadInventoryLedger()]); renderInventory(); }, '已刷新'));
  function renderInventoryLedger() {
    const el = $('#inventoryLedgerList');
    if (state.loadErrors['admin.inventory.ledger']) { el.innerHTML = `<div class="empty">${esc(state.loadErrors['admin.inventory.ledger'])}<br><button class="act" id="inventoryLedgerRetry">重试</button></div>`; const retry = $('#inventoryLedgerRetry'); if (retry) retry.addEventListener('click', () => loadInventoryLedger()); return; }
    el.innerHTML = state.inventoryLedger.map(row => { const sku = state.skus.find(item => item._id === row.skuId); const warehouse = state.warehouses.find(item => item._id === row.warehouseId); return `<div class="compact-row"><div><strong>${esc(sku ? sku.specName : row.skuId || '商品规格')} · ${Number(row.change || 0) > 0 ? '+' : ''}${Number(row.change || 0)}</strong><span>${esc(warehouse ? warehouse.name : row.warehouseId || '—')} · ${esc(row.reason || '未注明原因')} · ${fmtTime(row.createdAt)}</span></div><span>${esc(row.referenceId || '')}</span></div>`; }).join('') || '<div class="empty">当前筛选没有库存流水</div>';
  }
  async function loadInventoryLedger() {
    $('#inventoryLedgerList').innerHTML = '<div class="empty">正在读取库存流水…</div>';
    const params = { warehouseId: state.inventoryWarehouseFilter === 'all' ? undefined : state.inventoryWarehouseFilter, skuId: $('#ledgerSkuFilter').value.trim() || undefined, reason: $('#ledgerReasonFilter').value.trim() || undefined, dateFrom: $('#ledgerFrom').value || undefined, dateTo: $('#ledgerTo').value || undefined };
    try { state.inventoryLedger = await list('admin.inventory.ledger', params); delete state.loadErrors['admin.inventory.ledger']; }
    catch (error) { state.inventoryLedger = []; state.loadErrors['admin.inventory.ledger'] = friendlyError(error); }
    renderInventoryLedger();
  }
  $('#inventoryLedgerRefresh').addEventListener('click', () => loadInventoryLedger());
  function openStockAdjustment(skuId, warehouseId, stockMode) {
    const direction = stockMode === 'in' ? 1 : -1;
    const sku = state.skus.find((s) => s._id === skuId);
    const product = sku && state.products.find((p) => p._id === sku.productId);
    if (!sku) return showNotice('没有找到这个商品规格，请刷新后重试', true);
    if (!warehouseId) return showNotice('还没有可用仓库，请让管理员先完成仓库设置', true);
    openModal(`
      <h3>库存${stockMode === 'in' ? '入库' : '出库'} · ${esc(product ? product.name : '')}</h3>
      <p class="hint">规格：${esc(sku.specName || '')}</p>
      <div class="field">
        <label>${stockMode === 'in' ? '入库数量' : '出库数量'}</label>
        <input id="stockInput" type="number" step="1" min="1" placeholder="例如 10">
      </div>
      <div class="actions">
        <button class="act plain" data-close>取消</button>
        <button class="act" id="stockSave">确认${stockMode === 'in' ? '入库' : '出库'}</button>
      </div>
    `);
    $('#stockInput').focus();
    $('#stockSave').addEventListener('click', () => {
      const count = Math.floor(Number($('#stockInput').value));
      if (!Number.isFinite(count) || count <= 0) return showNotice('请输入正确的数量', true);
      guard(async () => {
        await api.call('admin.inventory.adjust', {
          warehouseId, skuId, change: direction * count,
          reason: direction > 0 ? 'simple_inbound' : 'simple_outbound',
          idempotencyKey: `simple-${direction > 0 ? 'in' : 'out'}-${skuId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        });
        closeModal();
        await reloadCore();
        renderInventory();
        if (state.editor && state.editor.mode === 'edit') renderEditor();
      }, '库存已更新');
    });
  }
  $('#inventoryList').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-stock]');
    if (!btn) return;
    openStockAdjustment(btn.dataset.sku, btn.dataset.wh, btn.dataset.stock);
  });

  // ---------- 配送设置 ----------
  function areaName(id) {
    const row = state.deliveryAreas.find((item) => item._id === id);
    return row ? row.name : '未命名区域';
  }
  function warehouseName(id) {
    const row = state.warehouses.find((item) => item._id === id);
    return row ? row.name : '统一仓库';
  }
  function fillDeliveryFee(areaId) {
    const form = $('#deliveryFeeForm');
    if (!form) return;
    const rule = state.freightRules.find((item) => item.deliveryAreaId === areaId && item.status === 'active')
      || state.freightRules.find((item) => item.deliveryAreaId === areaId);
    form.elements.baseFee.value = rule ? (Number(rule.baseFeeCent || 0) / 100).toFixed(2) : '0.00';
    form.elements.freeThreshold.value = rule ? (Number(rule.freeThresholdCent || 0) / 100).toFixed(2) : '0.00';
  }
  function renderDelivery() {
    const form = $('#deliveryFeeForm');
    const deliveryError = state.loadErrors['admin.deliveryAreas.list'] || state.loadErrors['admin.freightRules.list'] || state.loadErrors['admin.deliverySlots.list'] || state.loadErrors['admin.pickupSites.list'];
    if (deliveryError) {
      [...form.elements].forEach(control => { control.disabled = true; });
      $('#deliverySummary').innerHTML = `<div class="empty">配送设置读取失败或当前角色无权限：${esc(deliveryError)}<br><button class="act" id="deliveryLoadRetry">重试</button></div>`;
      $('#deliverySlotList').innerHTML = '<div class="empty">配送时段暂不可用</div>'; $('#pickupSiteList').innerHTML = '<div class="empty">自提点暂不可用</div>';
      const retry = $('#deliveryLoadRetry'); if (retry) retry.addEventListener('click', () => guard(async () => { await reloadOperations(); renderDelivery(); }, '配送设置已刷新'));
      return;
    }
    const previousArea = form.elements.deliveryAreaId.value;
    form.elements.deliveryAreaId.innerHTML = state.deliveryAreas.map((area) => `<option value="${esc(area._id)}">${esc(area.name)}</option>`).join('');
    const selected = state.deliveryAreas.some((area) => area._id === previousArea) ? previousArea : (state.deliveryAreas[0] && state.deliveryAreas[0]._id || '');
    form.elements.deliveryAreaId.value = selected;
    [...form.elements].forEach((control) => { control.disabled = !state.deliveryAreas.length; });
    if (selected) fillDeliveryFee(selected);
    $('#deliverySummary').innerHTML = state.deliveryAreas.map((area) => {
      const rule = state.freightRules.find((item) => item.deliveryAreaId === area._id && item.status === 'active') || state.freightRules.find((item) => item.deliveryAreaId === area._id);
      const enabled = area.status === 'active';
      return `<article class="summary-card">
        <span>${esc(area.name)}</span><strong>${rule ? yuan(rule.baseFeeCent) : '未设配送费'}</strong>
        <small>${esc((area.warehouseIds || []).map(warehouseName).join('、') || '统一仓库')} · ${enabled ? '配送中' : '已暂停'}</small>
        <button class="act ${enabled ? 'plain' : 'green'} mini" data-area-toggle="${enabled ? 'disabled' : 'active'}" data-id="${esc(area._id)}">${enabled ? '暂停配送' : '恢复配送'}</button>
      </article>`;
    }).join('') || '<div class="empty">还没有配送区域。区域范围请由管理员在高级设置中建立。</div>';
    $('#deliverySlotList').innerHTML = state.deliverySlots.map((slot) => {
      const active = slot.status === 'active';
      return `<div class="compact-row"><div><strong>${esc(slot.name)}</strong><span>${esc(areaName(slot.deliveryAreaId))} · ${esc(slot.startTime || '--:--')}-${esc(slot.endTime || '--:--')}</span></div><div><span class="badge ${active ? 'b-green' : 'b-gray'}">${active ? '启用' : '停用'}</span><button class="act plain mini" data-slot-toggle="${active ? 'disabled' : 'active'}" data-id="${esc(slot._id)}">${active ? '停用' : '启用'}</button></div></div>`;
    }).join('') || '<div class="empty">还没有配送时段</div>';
    $('#pickupSiteList').innerHTML = state.pickupSites.map((site) => {
      const active = site.status === 'active';
      return `<div class="compact-row"><div><strong>${esc(site.name)}</strong><span>${esc(site.address)} · ${esc(warehouseName(site.warehouseId))}</span><small>${esc(site.regionCode)} · ${esc(site.openingHours)} · 排序 ${Number(site.sort || 0)}</small></div><div><span class="badge ${active ? 'b-green' : 'b-gray'}">${active ? '启用' : '停用'}</span><button class="act plain mini" data-pickup-edit="${esc(site._id)}">编辑</button><button class="act plain mini" data-pickup-toggle="${active ? 'disabled' : 'active'}" data-id="${esc(site._id)}">${active ? '停用' : '启用'}</button></div></div>`;
    }).join('') || '<div class="empty">还没有自提点</div>';
    $('#newDeliverySlotBtn').disabled = !state.deliveryAreas.length;
    $('#newPickupSiteBtn').disabled = !state.warehouses.length;
  }
  $('#deliveryAreaSelect').addEventListener('change', (event) => fillDeliveryFee(event.target.value));
  $('#deliveryRefresh').addEventListener('click', () => guard(async () => { await reloadOperations(); renderDelivery(); renderMarketing(); }, '配送设置已刷新'));
  $('#deliveryFeeForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const areaId = form.elements.deliveryAreaId.value;
    const baseFeeCent = toCents(form.elements.baseFee.value);
    const freeThresholdCent = toCents(form.elements.freeThreshold.value);
    if (!areaId || !Number.isFinite(baseFeeCent) || !Number.isFinite(freeThresholdCent)) return showNotice('请正确填写配送区域和金额', true);
    const old = state.freightRules.find((item) => item.deliveryAreaId === areaId && item.status === 'active') || state.freightRules.find((item) => item.deliveryAreaId === areaId);
    if (!global.confirm(`确认保存“${areaName(areaId)}”的配送费？顾客下单时会按新金额计算。`)) return;
    guard(async () => {
      await api.call('admin.freightRules.upsert', {
        id: old && old._id, name: old && old.name || `${areaName(areaId)}配送费`, deliveryAreaId: areaId,
        warehouseId: old && old.warehouseId || (state.warehouses[0] && state.warehouses[0]._id) || '',
        baseFeeCent, additionalFeeCent: Number(old && old.additionalFeeCent || 0), freeThresholdCent,
        customerType: old && old.customerType || 'all', priority: Number(old && old.priority || 0),
        validFrom: old && old.validFrom || '', validTo: old && old.validTo || '', status: 'active'
      });
      await reloadOperations(); renderDelivery();
    }, '配送费已保存');
  });
  $('#deliverySummary').addEventListener('click', (event) => {
    const button = event.target.closest('[data-area-toggle]');
    if (!button) return;
    const area = state.deliveryAreas.find((item) => item._id === button.dataset.id);
    if (!area) return;
    const enable = button.dataset.areaToggle === 'active';
    if (!global.confirm(`${enable ? '恢复' : '暂停'}“${area.name}”配送？${enable ? '恢复后顾客可以重新选择该区域。' : '暂停后顾客暂时不能选择该区域。'}`)) return;
    guard(async () => {
      await api.call('admin.deliveryAreas.upsert', {
        id: area._id, name: area.name, regionCodes: area.regionCodes || [], warehouseIds: area.warehouseIds || [],
        sort: Number(area.sort || 0), status: button.dataset.areaToggle
      });
      await reloadOperations(); renderDelivery();
    }, enable ? '配送区域已恢复' : '配送区域已暂停');
  });
  $('#newDeliverySlotBtn').addEventListener('click', () => {
    if (!state.deliveryAreas.length) return showNotice('请先让管理员建立配送区域', true);
    openModal(`<h3>新增配送时段</h3><p class="hint">顾客结算时会看到这个名称和时间。</p>
      <div class="field"><label>时段名称</label><input id="slotName" placeholder="例如 上午配送"></div>
      <div class="field"><label>配送区域</label><select id="slotArea">${state.deliveryAreas.filter((area) => area.status === 'active').map((area) => `<option value="${esc(area._id)}">${esc(area.name)}</option>`).join('')}</select></div>
      <div class="form-two"><div class="field"><label>开始时间</label><input id="slotStart" type="time" value="09:00"></div><div class="field"><label>结束时间</label><input id="slotEnd" type="time" value="12:00"></div></div>
      <div class="actions"><button class="act plain" data-close>取消</button><button class="act" id="slotSave">保存并启用</button></div>`);
    $('#slotSave').addEventListener('click', () => {
      const name = $('#slotName').value.trim(); const deliveryAreaId = $('#slotArea').value;
      const startTime = $('#slotStart').value; const endTime = $('#slotEnd').value;
      if (!name || !deliveryAreaId || !startTime || !endTime || startTime >= endTime) return showNotice('请填写正确的时段名称和起止时间', true);
      guard(async () => {
        await api.call('admin.deliverySlots.upsert', { name, deliveryAreaId, warehouseId: (state.warehouses[0] && state.warehouses[0]._id) || '', startTime, endTime, capacity: 0, status: 'active' });
        closeModal(); await reloadOperations(); renderDelivery();
      }, '配送时段已启用');
    });
  });
  $('#deliverySlotList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-slot-toggle]');
    if (!button) return;
    const slot = state.deliverySlots.find((item) => item._id === button.dataset.id); if (!slot) return;
    const enable = button.dataset.slotToggle === 'active';
    if (!global.confirm(`${enable ? '启用' : '停用'}“${slot.name}”？`)) return;
    guard(async () => {
      await api.call('admin.deliverySlots.upsert', { ...slot, id: slot._id, status: button.dataset.slotToggle });
      await reloadOperations(); renderDelivery();
    }, enable ? '配送时段已启用' : '配送时段已停用');
  });
  function openPickupSiteEditor(site) {
    if (!state.warehouses.length) return showNotice('请先让管理员建立仓库', true);
    const current = site || {};
    openModal(`<h3>${site ? '编辑' : '新增'}自提点</h3><p class="hint">保存后顾客端会按启用状态读取，自提点地址请填写完整。</p>
      <div class="field"><label>自提点名称</label><input id="pickupName" maxlength="80" value="${esc(current.name || '')}" placeholder="例如 章贡区中心自提点"></div>
      <div class="field"><label>详细地址</label><input id="pickupAddress" maxlength="200" value="${esc(current.address || '')}" placeholder="街道、门牌号和楼层"></div>
      <div class="form-two"><div class="field"><label>区域编码</label><input id="pickupRegionCode" maxlength="80" value="${esc(current.regionCode || '')}" placeholder="例如 360702"></div><div class="field"><label>关联仓库</label><select id="pickupWarehouse">${state.warehouses.map((warehouse) => `<option value="${esc(warehouse._id)}" ${warehouse._id === current.warehouseId ? 'selected' : ''}>${esc(warehouse.name)}</option>`).join('')}</select></div></div>
      <div class="form-two"><div class="field"><label>营业时间（可留空）</label><input id="pickupOpeningHours" maxlength="200" value="${esc(current.openingHours || '')}" placeholder="例如 08:30-18:00"></div><div class="field"><label>排序</label><input id="pickupSort" type="number" value="${Number(current.sort || 0)}"></div></div>
      <div class="actions"><button class="act plain" data-close>取消</button><button class="act" id="pickupSave">保存${site && site.status === 'disabled' ? '（保持停用）' : '并启用'}</button></div>`);
    $('#pickupSave').addEventListener('click', () => {
      const payload = {
        id: current._id || '', name: $('#pickupName').value.trim(), address: $('#pickupAddress').value.trim(),
        regionCode: $('#pickupRegionCode').value.trim(), warehouseId: $('#pickupWarehouse').value,
        openingHours: $('#pickupOpeningHours').value.trim(), status: current.status || 'active', sort: Number($('#pickupSort').value || 0)
      };
      if (!payload.name || !payload.address || !payload.regionCode || !payload.warehouseId || !Number.isInteger(payload.sort)) return showNotice('请完整填写自提点名称、地址、区域和仓库，排序必须是整数', true);
      guard(async () => {
        await api.call('admin.pickupSites.upsert', payload);
        closeModal(); await reloadOperations(); renderDelivery();
      }, site ? '自提点已更新' : '自提点已新增并启用');
    });
  }
  $('#newPickupSiteBtn').addEventListener('click', () => openPickupSiteEditor(null));
  $('#pickupSiteList').addEventListener('click', (event) => {
    const edit = event.target.closest('[data-pickup-edit]');
    if (edit) return openPickupSiteEditor(state.pickupSites.find((item) => item._id === edit.dataset.pickupEdit));
    const toggle = event.target.closest('[data-pickup-toggle]');
    if (!toggle) return;
    const site = state.pickupSites.find((item) => item._id === toggle.dataset.id); if (!site) return;
    const enable = toggle.dataset.pickupToggle === 'active';
    if (!global.confirm(`${enable ? '启用' : '停用'}“${site.name}”？`)) return;
    guard(async () => {
      await api.call('admin.pickupSites.upsert', { id: site._id, name: site.name, address: site.address, regionCode: site.regionCode, warehouseId: site.warehouseId, openingHours: site.openingHours, status: toggle.dataset.pickupToggle, sort: Number(site.sort || 0) });
      await reloadOperations(); renderDelivery();
    }, enable ? '自提点已启用' : '自提点已停用');
  });

  // ---------- 套餐、会员、优惠券、评价、发票与储值 ----------
  function renderCommerceExtensions() {
    $('#bundleList').innerHTML = state.loadErrors['admin.bundles.list'] ? `<div class="empty">${esc(state.loadErrors['admin.bundles.list'])}</div>` : state.bundles.map(item => `<div class="compact-row"><div><strong>${esc(item.name || item._id)}</strong><span>${yuan(item.bundlePriceCent)} · ${esc(item.status || 'draft')} · ${item.temporary ? '临时草案' : esc(item.source || '未标记')}</span></div><button class="act plain" data-bundle-edit="${esc(item._id)}">编辑</button><button class="act ${item.status === 'active' ? 'danger' : 'green'}" data-bundle-status="${item.status === 'active' ? 'disabled' : 'active'}" data-id="${esc(item._id)}">${item.status === 'active' ? '停用' : '启用'}</button></div>`).join('') || '<div class="empty">暂无套餐</div>';
    $('#groupInstanceList').innerHTML = state.groups.map(item => `<div class="compact-row"><div><strong>${esc(item.groupNo || item._id)}</strong><span>${esc(item.status || '—')} · ${Number(item.memberCount || 0)}/${Number(item.groupSize || 0)} 人 · 到期 ${fmtTime(item.expiresAt)}</span></div><button class="act plain" data-group-members="${esc(item._id)}">查看成员</button></div>`).join('') || '<div class="empty">暂无拼团实例</div>';
    $('#groupMemberList').innerHTML = state.groupMembers.map(item => `<div class="compact-row"><div><strong>成员 ${esc(item.userId || item._id)}</strong><span>${esc(item.status || '—')} · ${fmtTime(item.createdAt)}</span></div></div>`).join('') || '<div class="empty">选择一个拼团实例查看成员</div>';
    $('#groupRefundTaskList').innerHTML = state.groupRefundTasks.map(item => `<div class="compact-row"><div><strong>${esc(item.groupNo || item.groupId || item._id)}</strong><span>失败团已支付订单待退款 · ${esc(item.refundStatus || item.status || '待处理')}</span></div></div>`).join('') || '<div class="empty">暂无失败团退款待办</div>';
    $('#couponTemplateList').innerHTML = state.couponTemplates.map(item => `<div class="compact-row"><div><strong>${esc(item.name || item._id)}</strong><span>${esc(item.type || 'fixed')} · ${esc(item.status || 'draft')} · 已发放 ${Number(item.claimedCount || item.issuedCount || 0)}/${Number(item.totalLimit || 0)} · 已核销 ${Number(item.usedCount || 0)} · ${item.temporary ? '临时草案' : esc(item.source || '未标记')}</span></div><button class="act plain" data-coupon-edit="${esc(item._id)}">编辑</button></div>`).join('') || '<div class="empty">暂无优惠券模板</div>';
    $('#couponGrantList').innerHTML = state.couponGrants.map(item => `<div class="compact-row"><div><strong>券 ${esc(item._id)}</strong><span>用户 ${esc(item.userId || '—')} · ${esc(item.status || '—')} · 模板 ${esc(item.templateId || '—')}</span></div></div>`).join('') || '<div class="empty">输入模板或选择状态后查询领取核销明细</div>';
    $('#membershipLevelList').innerHTML = state.membershipLevels.map(item => `<div class="compact-row"><div><strong>${esc(item.name || item.code)}</strong><span>${Number(item.minPoints || 0)} 积分起 · 奖励率 ${Number(item.rewardRateBps || 0) / 100}% · ${esc(item.status || 'draft')} ${item.temporary ? '· 临时草案' : ''}</span></div><button class="act plain" data-level-edit="${esc(item._id)}">编辑</button></div>`).join('') || '<div class="empty">暂无会员等级</div>';
    $('#pointsRuleList').innerHTML = state.loadErrors['admin.points.rules.list'] ? `<div class="empty">${esc(state.loadErrors['admin.points.rules.list'])}</div>` : state.pointsRules.map(item => `<div class="compact-row"><div><strong>${esc(item.code === 'order_reward' ? '订单积分奖励' : item.code || item._id)}</strong><span>每消费 1 元奖励 ${Number(item.pointsPerYuan || 0)} 积分 · ${esc(item.status || 'draft')} · ${item.temporary ? '临时草案' : esc(item.source || '未标记')}</span></div><button class="act plain" data-points-rule-edit="${esc(item._id)}">编辑</button></div>`).join('') || '<div class="empty">暂无积分规则</div>';
    $('#pointsAccountList').innerHTML = state.pointsAccounts.map(item => `<div class="compact-row"><div><strong>用户 ${esc(item.userId || '—')} · ${Number(item.balance || item.points || 0)} 积分</strong><span>等级 ${esc(item.levelCode || '—')} · ${fmtTime(item.updatedAt)}</span></div></div>`).join('') || '<div class="empty">输入用户 ID 查询积分账户</div>';
    $('#pointsLedgerList').innerHTML = state.pointsLedger.map(item => `<div class="compact-row"><div><strong>${Number(item.change || 0) > 0 ? '+' : ''}${Number(item.change || 0)} 积分</strong><span>${esc(item.action || item.reason || '变动')} · ${fmtTime(item.createdAt)}</span></div></div>`).join('') || '';
    $('#reviewAdminList').innerHTML = state.reviews.map(item => `<div class="compact-row"><div><strong>${Number(item.rating || 0)} 星 · ${esc(item.content || '无文字')}</strong><span>${esc(item.status || 'pending')} · 用户 ${esc(item.userId || '—')}</span></div>${item.status === 'pending' ? `<button class="act green" data-review-decision="approved" data-id="${esc(item._id)}">通过</button><button class="act danger" data-review-decision="rejected" data-id="${esc(item._id)}">驳回</button>` : ''}</div>`).join('') || '<div class="empty">暂无待审评价</div>';
    $('#invoiceAdminList').innerHTML = state.invoices.map(item => `<div class="compact-row"><div><strong>${esc(item.invoiceNo || item._id)}</strong><span>${esc(item.status || 'requested')} · 订单 ${esc(item.orderId || '—')}</span></div>${['requested', 'provider_unconfigured'].includes(item.status) ? `<button class="act" data-invoice-action="pending_manual" data-id="${esc(item._id)}">转人工处理</button><button class="act danger" data-invoice-action="rejected" data-id="${esc(item._id)}">驳回</button>${item.providerConfigured ? `<button class="act green" data-invoice-action="issued" data-id="${esc(item._id)}">登记已开票</button>` : '<span class="badge b-orange">服务商未配置</span>'}` : ''}</div>`).join('') || '<div class="empty">暂无开票申请</div>';
    $('#storedValueAdminList').innerHTML = state.storedValueRecords.map(item => `<div class="compact-row"><div><strong>用户 ${esc(item.userId || '—')}</strong><span>余额 ${yuan(item.balanceCent)} · ${esc(item.status || 'test_only')}</span></div></div>`).join('') || '<div class="empty">暂无储值测试记录；真实充值保持关闭，后台不能手工增加余额</div>';
    $('#storedValueLedgerList').innerHTML = state.storedValueLedger.map(item => `<div class="compact-row"><div><strong>${yuan(item.changeCent || item.amountCent)} · ${esc(item.action || '流水')}</strong><span>用户 ${esc(item.userId || '—')} · ${fmtTime(item.createdAt)}</span></div></div>`).join('') || '<div class="empty">输入用户 ID 查询储值流水；此处不提供加余额操作</div>';
  }
  function parseSkuQuantities(text) { return String(text || '').split(/\r?\n/).map(line => { const [skuId, quantity] = line.split(/[,，\s]+/); return { skuId: String(skuId || '').trim(), quantity: Number(quantity) }; }).filter(item => item.skuId && Number.isInteger(item.quantity) && item.quantity > 0); }
  function openBundleEditor(item = {}) {
    openModal(`<h3>${item._id ? '编辑' : '新建'}组合套餐</h3><form id="bundleForm"><input type="hidden" name="id" value="${esc(item._id || '')}"><label class="field">套餐名称<input name="name" required maxlength="100" value="${esc(item.name || '')}"></label><label class="field">说明<textarea name="description" maxlength="500">${esc(item.description || '')}</textarea></label><label class="field">SKU 与数量（每行 SKU ID,数量）<textarea name="items" required>${esc((item.items || []).map(row => `${row.skuId},${row.quantity}`).join('\n'))}</textarea></label><label class="field">套餐价（元）<input name="price" type="number" min="0.01" step="0.01" required value="${Number(item.bundlePriceCent || 0) / 100}"></label><label class="field">来源<select name="source"><option value="ai_generated" ${item.source === 'ai_generated' ? 'selected' : ''}>AI 草案</option><option value="client" ${item.source === 'client' ? 'selected' : ''}>人工复核</option></select></label><label class="check-line"><input name="temporary" type="checkbox" ${item.temporary !== false ? 'checked' : ''}>临时草案</label><label class="field">状态<select name="status"><option value="draft">草稿</option><option value="disabled" ${item.status === 'disabled' ? 'selected' : ''}>停用</option><option value="active" ${item.status === 'active' ? 'selected' : ''}>启用</option></select></label><p class="hint">AI 或临时套餐不能启用；正式启用会影响顾客可购买套餐。</p><div class="actions"><button type="button" class="act plain" data-close>取消</button><button class="act" type="submit">保存套餐</button></div></form>`);
    $('#bundleForm').addEventListener('submit', (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const source = form.get('source'); const temporary = form.get('temporary') === 'on'; const status = form.get('status'); const items = parseSkuQuantities(form.get('items')); if (!items.length) return showNotice('请填写有效套餐商品', true); if (status === 'active' && (temporary || source !== 'client')) return showNotice('AI 或临时套餐不能启用，请先人工复核', true); if (status === 'active' && !global.confirm('确认正式启用套餐？启用后顾客可以按套餐规则购买。')) return; guard(async () => { await api.call('admin.bundles.upsert', { id: form.get('id'), name: form.get('name'), description: form.get('description'), items, bundlePriceCent: toCents(form.get('price')), status, source, temporary }); closeModal(); await reloadCore(); renderCommerceExtensions(); }, status === 'active' ? '套餐已启用' : '套餐草案已保存'); });
  }
  function openCouponEditor(item = {}) {
    openModal(`<h3>${item._id ? '编辑' : '新建'}优惠券模板</h3><form id="couponForm"><input type="hidden" name="id" value="${esc(item._id || '')}"><label class="field">名称<input name="name" required maxlength="100" value="${esc(item.name || '')}"></label><label class="field">类型<select name="type"><option value="fixed">固定金额</option><option value="percent" ${item.type === 'percent' ? 'selected' : ''}>折扣</option></select></label><div class="form-two"><label class="field">优惠金额（元）<input name="discount" type="number" min="0" step="0.01" value="${Number(item.discountCent || 0) / 100}"></label><label class="field">折扣基点<input name="rate" type="number" min="1" max="10000" value="${Number(item.discountRateBps || 9500)}"></label></div><div class="form-two"><label class="field">折扣封顶（元）<input name="maxDiscount" type="number" min="0" step="0.01" value="${Number(item.maxDiscountCent || 0) / 100}"></label><label class="field">最低消费（元）<input name="minSpend" type="number" min="0" step="0.01" value="${Number(item.minSpendCent || 0) / 100}"></label></div><label class="field">适用范围<select name="scopeType"><option value="all">全部商品</option><option value="product" ${item.scopeType === 'product' ? 'selected' : ''}>指定商品</option><option value="category" ${item.scopeType === 'category' ? 'selected' : ''}>指定分类</option></select></label><label class="field">范围 ID（逗号分隔）<input name="scopeIds" value="${esc((item.scopeIds || []).join(','))}"></label><div class="form-two"><label class="field">总发行量<input name="totalLimit" type="number" min="1" value="${Number(item.totalLimit || 100)}"></label><label class="field">每人限领<input name="perUserLimit" type="number" min="1" value="${Number(item.perUserLimit || 1)}"></label></div><div class="form-two"><label class="field">有效开始<input name="validFrom" type="datetime-local" required value="${localInputTime(item.validFrom)}"></label><label class="field">有效结束<input name="validTo" type="datetime-local" required value="${localInputTime(item.validTo)}"></label></div><label class="field">来源<select name="source"><option value="ai_generated">AI 草案</option><option value="client" ${item.source === 'client' ? 'selected' : ''}>人工复核</option></select></label><label class="check-line"><input name="temporary" type="checkbox" ${item.temporary !== false ? 'checked' : ''}>临时草案</label><label class="field">状态<select name="status"><option value="draft">草稿</option><option value="disabled">停用</option><option value="active" ${item.status === 'active' ? 'selected' : ''}>启用</option></select></label><p class="hint">AI 或临时优惠券模板不能启用。</p><div class="actions"><button type="button" class="act plain" data-close>取消</button><button class="act" type="submit">保存模板</button></div></form>`);
    $('#couponForm').addEventListener('submit', (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const source = form.get('source'); const temporary = form.get('temporary') === 'on'; const status = form.get('status'); if (status === 'active' && (temporary || source !== 'client')) return showNotice('AI 或临时优惠券不能启用', true); if (status === 'active' && !global.confirm('确认启用优惠券模板？启用后符合条件的顾客可以领取。')) return; guard(async () => { await api.call('admin.couponTemplates.upsert', { id: form.get('id'), name: form.get('name'), type: form.get('type'), discountCent: toCents(form.get('discount')), discountRateBps: Number(form.get('rate')), maxDiscountCent: toCents(form.get('maxDiscount')), minSpendCent: toCents(form.get('minSpend')), scopeType: form.get('scopeType'), scopeIds: String(form.get('scopeIds') || '').split(/[,，\s]+/).filter(Boolean), totalLimit: Number(form.get('totalLimit')), perUserLimit: Number(form.get('perUserLimit')), validFrom: new Date(form.get('validFrom')).toISOString(), validTo: new Date(form.get('validTo')).toISOString(), status, source, temporary }); closeModal(); await reloadOperations(); renderCommerceExtensions(); }, status === 'active' ? '优惠券模板已启用' : '优惠券草案已保存'); });
  }
  function openLevelEditor(item = {}) {
    openModal(`<h3>${item._id ? '编辑' : '新增'}会员等级</h3><form id="levelForm"><input type="hidden" name="id" value="${esc(item._id || '')}"><label class="field">等级编码<input name="code" required maxlength="40" value="${esc(item.code || '')}"></label><label class="field">等级名称<input name="name" required maxlength="80" value="${esc(item.name || '')}"></label><label class="field">最低积分<input name="minPoints" type="number" min="0" required value="${Number(item.minPoints || 0)}"></label><label class="field">奖励率（基点）<input name="rewardRateBps" type="number" min="0" max="10000" required value="${Number(item.rewardRateBps || 0)}"></label><label class="field">来源<select name="source"><option value="ai_generated">AI 草案</option><option value="client" ${item.source === 'client' ? 'selected' : ''}>人工复核</option></select></label><label class="check-line"><input name="temporary" type="checkbox" ${item.temporary !== false ? 'checked' : ''}>临时草案</label><label class="field">状态<select name="status"><option value="draft">草稿</option><option value="disabled">停用</option><option value="active" ${item.status === 'active' ? 'selected' : ''}>启用</option></select></label><p class="hint">AI 或临时会员规则不能启用。</p><div class="actions"><button type="button" class="act plain" data-close>取消</button><button class="act" type="submit">保存等级</button></div></form>`);
    $('#levelForm').addEventListener('submit', (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const source = form.get('source'); const temporary = form.get('temporary') === 'on'; const status = form.get('status'); if (status === 'active' && (temporary || source !== 'client')) return showNotice('AI 或临时会员等级不能启用', true); if (status === 'active' && !global.confirm('确认启用会员等级？这会影响顾客等级与积分奖励。')) return; guard(async () => { await api.call('admin.membershipLevels.upsert', { id: form.get('id'), code: form.get('code'), name: form.get('name'), minPoints: Number(form.get('minPoints')), rewardRateBps: Number(form.get('rewardRateBps')), status, source, temporary }); closeModal(); await reloadCustomers(); renderCommerceExtensions(); }, status === 'active' ? '会员等级已启用' : '会员等级草案已保存'); });
  }
  function openPointsRuleEditor(item = {}) {
    openModal(`<h3>${item._id ? '编辑' : '新增'}积分规则</h3><form id="pointsRuleForm"><label class="field">每消费 1 元奖励积分<input name="pointsPerYuan" type="number" min="0" max="10000" step="1" required value="${Number(item.pointsPerYuan || 0)}"></label><label class="field">来源<select name="source"><option value="ai_generated">AI 草案</option><option value="client" ${item.source === 'client' ? 'selected' : ''}>人工复核</option></select></label><label class="check-line"><input name="temporary" type="checkbox" ${item.temporary !== false ? 'checked' : ''}>临时草案</label><label class="field">状态<select name="status"><option value="draft">草稿</option><option value="disabled" ${item.status === 'disabled' ? 'selected' : ''}>停用</option><option value="active" ${item.status === 'active' ? 'selected' : ''}>启用</option></select></label><p class="hint">AI 或临时积分规则不能启用；正式启用会影响后续订单积分。</p><div class="actions"><button type="button" class="act plain" data-close>取消</button><button class="act" type="submit">保存规则</button></div></form>`);
    $('#pointsRuleForm').addEventListener('submit', (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const source = form.get('source'); const temporary = form.get('temporary') === 'on'; const status = form.get('status'); const pointsPerYuan = Number(form.get('pointsPerYuan')); if (!Number.isInteger(pointsPerYuan) || pointsPerYuan < 0) return showNotice('积分奖励必须是非负整数', true); if (status === 'active' && (temporary || source !== 'client')) return showNotice('AI 或临时积分规则不能启用', true); if (status === 'active' && !global.confirm('确认启用正式积分规则？这会影响顾客后续订单积分。')) return; guard(async () => { await api.call('admin.points.rules.upsert', { pointsPerYuan, status, source, temporary, idempotencyKey: newIdempotencyKey() }); closeModal(); await reloadCustomers(); renderCommerceExtensions(); }, status === 'active' ? '积分规则已启用' : '积分规则草案已保存'); });
  }
  $('#newBundleBtn').addEventListener('click', () => openBundleEditor());
  $('#bundleList').addEventListener('click', (event) => { const edit = event.target.closest('[data-bundle-edit]'); if (edit) return openBundleEditor(state.bundles.find(item => item._id === edit.dataset.bundleEdit) || {}); const toggle = event.target.closest('[data-bundle-status]'); if (!toggle) return; const item = state.bundles.find(row => row._id === toggle.dataset.id); const status = toggle.dataset.bundleStatus; if (status === 'active' && (item?.temporary || item?.source !== 'client')) return showNotice('AI 或临时套餐不能启用', true); if (!global.confirm(`${status === 'active' ? '确认启用套餐并允许顾客购买' : '确认停用套餐'}？`)) return; guard(async () => { await api.call('admin.bundles.setStatus', { id: toggle.dataset.id, status }); await reloadCore(); renderCommerceExtensions(); }, '套餐状态已更新'); });
  $('#newCouponTemplateBtn').addEventListener('click', () => openCouponEditor());
  $('#couponTemplateList').addEventListener('click', (event) => { const button = event.target.closest('[data-coupon-edit]'); if (button) openCouponEditor(state.couponTemplates.find(item => item._id === button.dataset.couponEdit) || {}); });
  $('#newMembershipLevelBtn').addEventListener('click', () => openLevelEditor());
  $('#membershipLevelList').addEventListener('click', (event) => { const button = event.target.closest('[data-level-edit]'); if (button) openLevelEditor(state.membershipLevels.find(item => item._id === button.dataset.levelEdit) || {}); });
  $('#newPointsRuleBtn').addEventListener('click', () => openPointsRuleEditor());
  $('#pointsRuleList').addEventListener('click', (event) => { const button = event.target.closest('[data-points-rule-edit]'); if (button) openPointsRuleEditor(state.pointsRules.find(item => item._id === button.dataset.pointsRuleEdit) || {}); });
  $('#adjustPointsBtn').addEventListener('click', () => { openModal(`<h3>调整用户积分</h3><form id="pointsAdjustForm"><label class="field">用户 ID<input name="userId" required maxlength="80"></label><label class="field">积分变动<input name="change" type="number" required></label><label class="field">原因<textarea name="reason" maxlength="300" required></textarea></label><p class="hint">提交后写入积分流水与审计，不可在前端撤销。</p><div class="actions"><button type="button" class="act plain" data-close>取消</button><button class="act danger" type="submit">确认调整</button></div></form>`); $('#pointsAdjustForm').addEventListener('submit', (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); if (!global.confirm(`确认调整用户积分 ${form.get('change')}？该操作会写入流水。`)) return; guard(async () => { await api.call('admin.points.adjust', { userId: form.get('userId'), change: Number(form.get('change')), reason: form.get('reason'), idempotencyKey: newIdempotencyKey() }); closeModal(); }, '积分调整已写入'); }); });
  $('#reviewAdminList').addEventListener('click', (event) => { const button = event.target.closest('[data-review-decision]'); if (!button || !global.confirm(`确认${button.dataset.reviewDecision === 'approved' ? '公开这条评价' : '驳回这条评价'}？`)) return; guard(async () => { await api.call('admin.reviews.review', { id: button.dataset.id, decision: button.dataset.reviewDecision, note: '运营审核', idempotencyKey: newIdempotencyKey() }); await reloadCustomers(); renderCommerceExtensions(); }, '评价审核状态已更新'); });
  $('#invoiceAdminList').addEventListener('click', (event) => { const button = event.target.closest('[data-invoice-action]'); if (!button) return; const action = button.dataset.invoiceAction; const row = state.invoices.find(item => item._id === button.dataset.id); if (action === 'issued' && !row?.providerConfigured) return showNotice('真实开票服务商未配置，不能登记已开票', true); if (!global.confirm(`确认执行发票操作“${action}”？状态变更会写入审计。`)) return; const invoiceNo = action === 'issued' ? global.prompt('请输入真实发票号码') : ''; if (action === 'issued' && !invoiceNo) return; guard(async () => { await api.call('admin.invoices.process', { id: button.dataset.id, action, invoiceNo, fileMediaId: '', note: '运营处理', idempotencyKey: newIdempotencyKey() }); await reloadTrade(); renderCommerceExtensions(); }, '发票状态已更新'); });
  $('#groupInstanceList').addEventListener('click', (event) => { const button = event.target.closest('[data-group-members]'); if (!button) return; $('#groupMemberList').innerHTML = '<div class="empty">正在读取拼团成员…</div>'; guard(async () => { state.groupMembers = await list('admin.groups.members', { groupId: button.dataset.groupMembers }); renderCommerceExtensions(); }, ''); });
  $('#couponGrantFilterBtn').addEventListener('click', () => guard(async () => { state.couponGrants = await list('admin.couponGrants.list', { templateId: $('#couponGrantTemplateFilter').value.trim() || undefined, status: $('#couponGrantStatusFilter').value || undefined }); renderCommerceExtensions(); }, ''));
  $('#pointsFilterBtn').addEventListener('click', () => guard(async () => { const userId = $('#pointsUserFilter').value.trim() || undefined; [state.pointsAccounts, state.pointsLedger] = await Promise.all([list('admin.points.accounts.list', { userId }), list('admin.points.ledger', { userId })]); renderCommerceExtensions(); }, ''));
  $('#storedValueFilterBtn').addEventListener('click', () => guard(async () => { state.storedValueLedger = await list('admin.storedValue.ledger', { userId: $('#storedValueUserFilter').value.trim() || undefined }); renderCommerceExtensions(); }, ''));
  $('#reviewFilterBtn').addEventListener('click', () => guard(async () => { state.reviews = await list('admin.reviews.list', { status: $('#reviewStatusFilter').value || undefined }); renderCommerceExtensions(); }, ''));
  $('#invoiceFilterBtn').addEventListener('click', () => guard(async () => { state.invoices = await list('admin.invoices.list', { status: $('#invoiceStatusFilter').value || undefined, orderId: $('#invoiceOrderFilter').value.trim() || undefined }); renderCommerceExtensions(); }, ''));
  $('#financeFilterBtn').addEventListener('click', () => guard(async () => { const organizationId = $('#financeOrganizationFilter').value.trim() || undefined; [state.receivables, state.statements] = await Promise.all([list('admin.receivables.list', { organizationId }), list('admin.statements.list', { organizationId, status: $('#statementStatusFilter').value || undefined })]); renderCustomers(); }, ''));

  // ---------- 营销活动 ----------
  function skuLabel(skuId) {
    const sku = state.skus.find((item) => item._id === skuId);
    const product = sku && state.products.find((item) => item._id === sku.productId);
    return product ? `${product.name} · ${sku.specName || '默认规格'}` : '商品已不可用';
  }
  function campaignTargetText(value) { return value === 'b' ? '企业采购客户' : value === 'c' ? '个人顾客' : '全部顾客'; }
  function renderMarketing() {
    if (state.loadErrors['admin.groupCampaigns.list']) {
      $('#campaignList').innerHTML = `<div class="empty">拼团活动读取失败或当前角色无权限：${esc(state.loadErrors['admin.groupCampaigns.list'])}<br><button class="act" id="campaignLoadRetry">重试</button></div>`; const retry = $('#campaignLoadRetry'); if (retry) retry.addEventListener('click', () => guard(async () => { await reloadOperations(); renderMarketing(); }, '拼团活动已刷新')); return;
    }
    $('#campaignList').innerHTML = state.groupCampaigns.map((item) => {
      const active = item.status === 'active';
      return `<article class="oc"><div class="row1"><strong>${esc(item.title)}</strong><span class="badge ${active ? 'b-green' : 'b-gray'}">${active ? '进行中' : item.status === 'draft' ? '草稿' : '已停用'}</span><span class="spacer" style="flex:1"></span><span class="money">${yuan(item.groupPriceCent)}</span></div>
        <div class="meta">商品：${esc(skuLabel(item.skuId))}<br>${Number(item.groupSize || 2)} 人成团 · ${esc(campaignTargetText(item.targetUserType))} · 成团时限 ${Number(item.durationMinutes || 0)} 分钟</div>
        <div class="actions"><button class="act ${active ? 'danger' : 'green'}" data-campaign-toggle="${active ? 'disabled' : 'active'}" data-id="${esc(item._id)}">${active ? '停止活动' : '启用活动'}</button></div></article>`;
    }).join('') || '<div class="empty"><div class="big">🎁</div>还没有拼团活动<br><button class="act green" style="margin-top:14px" data-empty-campaign>新建第一个拼团</button></div>';
  }
  function openNewCampaign() {
    const skuOptions = state.skus.filter((sku) => sku.status === 'on_sale').map((sku) => {
      const product = state.products.find((item) => item._id === sku.productId);
      return product && product.status === 'on_sale' ? `<option value="${esc(sku._id)}">${esc(skuLabel(sku._id))}</option>` : '';
    }).join('');
    if (!skuOptions) return showNotice('请先上架至少一个带规格的商品', true);
    openModal(`<h3>新建拼团活动</h3><p class="hint">只需选择商品、人数和拼团价。</p>
      <div class="field"><label>活动名称</label><input id="campaignTitle" placeholder="例如 火锅丸子2人拼团"></div>
      <div class="field"><label>参加拼团的商品规格</label><select id="campaignSku">${skuOptions}</select></div>
      <div class="form-two"><div class="field"><label>几人成团</label><input id="campaignSize" type="number" min="2" max="12" value="2"></div><div class="field"><label>拼团价（元）</label><input id="campaignPrice" type="number" min="0.01" step="0.01"></div></div>
      <div class="form-two"><div class="field"><label>成团时限（小时）</label><input id="campaignHours" type="number" min="1" max="168" value="2"></div><div class="field"><label>面向顾客</label><select id="campaignTarget"><option value="all">全部顾客</option><option value="c">个人顾客</option><option value="b">企业采购客户</option></select></div></div>
      <div class="actions"><button class="act plain" data-close>取消</button><button class="act plain" data-campaign-save="draft">保存草稿</button><button class="act green" data-campaign-save="active">立即启用</button></div>`);
  }
  $('#newCampaignBtn').addEventListener('click', openNewCampaign);
  $('#campaignList').addEventListener('click', (event) => {
    if (event.target.closest('[data-empty-campaign]')) return openNewCampaign();
    const button = event.target.closest('[data-campaign-toggle]'); if (!button) return;
    const item = state.groupCampaigns.find((row) => row._id === button.dataset.id); if (!item) return;
    const enable = button.dataset.campaignToggle === 'active';
    if (!global.confirm(`${enable ? '启用' : '停止'}“${item.title}”？${enable ? '启用后符合条件的顾客可以参加。' : '停止后顾客不能再参加新拼团。'}`)) return;
    guard(async () => {
      await api.call('admin.groupCampaigns.upsert', { ...item, id: item._id, status: button.dataset.campaignToggle });
      await reloadOperations(); renderMarketing();
    }, enable ? '拼团活动已启用' : '拼团活动已停止');
  });
  $('#overlay').addEventListener('click', (event) => {
    const save = event.target.closest('[data-campaign-save]'); if (!save) return;
    const title = $('#campaignTitle').value.trim(); const skuId = $('#campaignSku').value;
    const groupSize = Math.floor(Number($('#campaignSize').value)); const groupPriceCent = toCents($('#campaignPrice').value);
    const durationMinutes = Math.floor(Number($('#campaignHours').value) * 60); const targetUserType = $('#campaignTarget').value;
    if (!title || !skuId || groupSize < 2 || groupSize > 12 || !Number.isFinite(groupPriceCent) || groupPriceCent <= 0 || durationMinutes < 60) return showNotice('请正确填写活动名称、人数、价格和时限', true);
    const sku = state.skus.find((item) => item._id === skuId); const product = sku && state.products.find((item) => item._id === sku.productId);
    guard(async () => {
      await api.call('admin.groupCampaigns.upsert', { title, skuId, groupSize, durationMinutes, groupPriceCent, coverMediaId: product && product.coverMediaId || '', targetUserType, status: save.dataset.campaignSave });
      closeModal(); await reloadOperations(); renderMarketing();
    }, save.dataset.campaignSave === 'active' ? '拼团活动已启用' : '拼团草稿已保存');
  });

  // ---------- 系统设置 ----------
  $('#simplePasswordForm').elements.showPassword.addEventListener('change', (event) => {
    const type = event.target.checked ? 'text' : 'password';
    ['currentPassword', 'newPassword', 'confirmPassword'].forEach((name) => { $('#simplePasswordForm').elements[name].type = type; });
  });
  $('#simplePasswordForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget; const currentPassword = form.elements.currentPassword.value; const newPassword = form.elements.newPassword.value;
    if (newPassword !== form.elements.confirmPassword.value) return showNotice('两次输入的新密码不一致', true);
    if (newPassword.length < 12) return showNotice('新密码至少需要12位', true);
    if (!global.confirm('确认修改密码？保存后所有已登录设备都会退出。')) return;
    guard(async () => {
      await api.call('admin.password.change', { currentPassword, newPassword });
      api.clearSession(); global.location.replace('index.html?reason=password_changed');
    });
  });

  // ---------- 权限、审计与配置版本 ----------
  function permissionLabel(code) {
    const item = state.permissionCatalog.find(row => (row.code || row.permission) === code);
    return item ? item.label || item.name || code : code;
  }
  function renderGovernance() {
    const roleError = state.loadErrors['admin.roles.list'] || state.loadErrors['admin.permissions.catalog'];
    $('#rolePermissionList').innerHTML = roleError ? `<div class="empty">${esc(roleError)}<br>当前账号可能没有角色读取权限。</div>` : state.roles.map(role => `<div class="compact-row"><div><strong>${esc(role.name || role.code || role._id)}</strong><span>${(role.permissions || []).map(permission => esc(permissionLabel(permission))).join('、') || '没有业务权限'} · ${role.status === 'disabled' ? '已停用' : '已启用'}</span></div><button class="act ${role.status === 'disabled' ? 'green' : 'danger'}" data-role-status="${role.status === 'disabled' ? 'active' : 'disabled'}" data-id="${esc(role._id)}">${role.status === 'disabled' ? '启用角色' : '停用角色'}</button></div>`).join('') || '<div class="empty">暂无可查看角色</div>';
    $('#auditLogList').innerHTML = state.loadErrors['admin.audit.list'] ? `<div class="empty">${esc(state.loadErrors['admin.audit.list'])}</div>` : state.auditLogs.slice(0, 30).map(row => `<div class="compact-row"><div><strong>${esc(row.action || '操作')}</strong><span>${esc(row.targetType || '')} ${esc(row.targetId || '')} · ${fmtTime(row.createdAt)} · 操作人 ${esc(row.adminId || row.actorId || '—')}</span></div></div>`).join('') || '<div class="empty">暂无操作记录</div>';
    $('#configVersionList').innerHTML = state.loadErrors['admin.versions.list'] ? `<div class="empty">${esc(state.loadErrors['admin.versions.list'])}<br><button class="act" id="versionRetry">重试</button></div>` : state.configVersions.map(row => `<div class="compact-row"><div><strong>版本 ${esc(row.version)}</strong><span>${fmtTime(row.createdAt)} · ${esc(row.action || row.source || '')}</span></div><button class="act plain" data-version-preview="${esc(row.version)}">预览快照</button><button class="act danger" data-version-rollback="${esc(row.version)}">由此生成新版本</button></div>`).join('') || '<div class="empty">填写配置类型和 ID 后查看历史版本</div>';
    const retry = $('#versionRetry'); if (retry) retry.addEventListener('click', loadConfigVersions);
  }
  $('#rolePermissionList').addEventListener('click', (event) => { const button = event.target.closest('[data-role-status]'); if (!button) return; const role = state.roles.find(row => row._id === button.dataset.id); const status = button.dataset.roleStatus; if (!global.confirm(`确认${status === 'active' ? '启用' : '停用'}角色“${role && (role.name || role.code) || button.dataset.id}”？这会影响关联管理员的可用权限。`)) return; guard(async () => { await api.call('admin.roles.setStatus', { id: button.dataset.id, status, idempotencyKey: newIdempotencyKey() }); await reloadOperations(); renderGovernance(); }, '角色状态已更新'); });
  $('#auditRefresh').addEventListener('click', () => guard(async () => { state.auditLogs = await optionalList('admin.audit.list'); renderGovernance(); }, '操作记录已刷新'));
  async function loadConfigVersions() {
    const entityType = $('#versionEntityType').value; const entityId = $('#versionEntityId').value.trim();
    if (!entityId) return showNotice('请填写要查看的配置 ID', true);
    $('#configVersionList').innerHTML = '<div class="empty">正在读取版本历史…</div>';
    try { state.configVersions = await list('admin.versions.list', { entityType, entityId }); delete state.loadErrors['admin.versions.list']; }
    catch (error) { state.configVersions = []; state.loadErrors['admin.versions.list'] = friendlyError(error); }
    renderGovernance();
  }
  $('#versionLoadBtn').addEventListener('click', loadConfigVersions);
  $('#configVersionList').addEventListener('click', (event) => {
    const preview = event.target.closest('[data-version-preview]');
    if (preview) { const row = state.configVersions.find(item => String(item.version) === preview.dataset.version); return openModal(`<h3>版本 ${esc(preview.dataset.version)} 只读预览</h3><p class="hint">这是服务端保存的历史快照，不会改变当前配置。</p><pre class="version-preview">${esc(JSON.stringify(row && (row.snapshot || row.data || row), null, 2))}</pre><div class="actions"><button class="act plain" data-close>关闭</button></div>`); }
    const rollback = event.target.closest('[data-version-rollback]'); if (!rollback) return;
    const entityType = $('#versionEntityType').value; const entityId = $('#versionEntityId').value.trim(); const version = Number(rollback.dataset.version);
    if (!global.confirm(`确认以历史版本 ${version} 生成一个新版本？不会覆盖或删除原有历史，发布状态仍由服务端规则校验。`)) return;
    guard(async () => { await api.call('admin.versions.rollback', { entityType, entityId, version, idempotencyKey: newIdempotencyKey() }); await loadConfigVersions(); await Promise.all([reloadCore(), reloadCustomers(), reloadOperations()]); renderAll(); }, '已根据历史快照生成新版本');
  });

  // ---------- 弹窗 ----------
  function openModal(html) {
    $('#modalBody').innerHTML = html;
    $('#overlay').classList.add('is-open');
  }
  function closeModal() {
    $('#overlay').classList.remove('is-open');
    $('#modalBody').innerHTML = '';
  }
  $('#overlay').addEventListener('click', (event) => {
    if (event.target === event.currentTarget || event.target.closest('[data-close]')) closeModal();
  });

  boot();
}(window));
