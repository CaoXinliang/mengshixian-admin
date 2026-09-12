(function adminConsole(global, document) {
  const api = global.MengshixianAdminApi;
  const state = { admin: null, roles: [], adminUsers: [], categories: [], products: [], skus: [], users: [], businessApplications: [], prices: [], warehouses: [], inventory: [], deliveryAreas: [], freightRules: [], deliverySlots: [], pickupSites: [], orders: [], refunds: [], refundFilter: 'all', refundDetail: null, groupCampaigns: [], imports: [], media: [], productMedia: [], banners: [], sections: [], audit: [] };
  const $ = (selector) => document.querySelector(selector);
  const escapeHtml = (value) => String(value === undefined || value === null ? '' : value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const formatDate = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
  const formatCents = (value) => `¥${(Number(value || 0) / 100).toFixed(2)}`;
  const splitLines = (value) => String(value || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const formatQuantityTiers = (tiers) => (Array.isArray(tiers) ? tiers : []).map((tier) => `${tier.minQuantity}${tier.maxQuantity === null || tier.maxQuantity === undefined ? '+' : `-${tier.maxQuantity}`}=${tier.amountCent}`).join('\n');
  function parseQuantityTiers(value) {
    return splitLines(value).map((line) => {
      const match = line.match(/^(\d+)\s*(?:-\s*(\d+)|(\+))\s*[=:]\s*(\d+)$/);
      if (!match) throw new Error(`阶梯格式不正确：${line}。请使用 10-19=2200 或 20+=2000。`);
      return { minQuantity: Number(match[1]), maxQuantity: match[3] ? null : Number(match[2]), amountCent: Number(match[4]) };
    });
  }
  const quantityTierSummary = (tiers) => (Array.isArray(tiers) && tiers.length ? tiers.map((tier) => `${tier.minQuantity}${tier.maxQuantity === null || tier.maxQuantity === undefined ? '+' : `-${tier.maxQuantity}`}件 ${formatCents(tier.amountCent)}`).join(' / ') : '无阶梯');
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
  const panelTitles = { overview: '今日经营概况', imports: '商品批量导入', categories: '商品分类', products: '商品管理', customers: '客户与企业', pricing: '价格规则', fulfillment: '库存、仓库与配送', orders: '订单履约', refunds: '退款售后', groups: '拼团活动', access: '账号与权限', content: '首页内容管理', media: '素材库', audit: '操作记录' };
  const moduleForPanel = (name) => Object.keys(modules).find((key) => modules[key].panels.some(([panelName]) => panelName === name)) || 'workbench';
  const requestedNext = () => {
    const params = new URLSearchParams(global.location.search || '');
    return params.get('next') === 'simple' ? 'simple' : '';
  };
  const advancedRequested = () => new URLSearchParams(global.location.search || '').get('mode') === 'advanced';
  const continueToRequestedPage = () => {
    if (advancedRequested()) return false;
    global.location.replace('simple.html');
    return true;
  };

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
  function rows(target, html, colspan) {
    $(target).innerHTML = html || `<tr><td class="empty" colspan="${colspan}">暂无数据</td></tr>`;
  }
  function badge(status) {
    const live = ['enabled', 'on_sale', 'imported', 'active'].includes(status);
    return `<span class="badge ${live ? 'live' : ''}">${escapeHtml(status || '—')}</span>`;
  }
  function refundStatus(refund) {
    if (refund.status === 'succeeded' && refund.channelStatus !== 'succeeded') return '退款结果待渠道核验';
    return ({ requested: '待审核', approved: '审核通过', rejected: '已驳回', processing: '退款处理中', awaiting_manual_refund: '待人工提交退款', channel_pending: '已提交退款渠道', succeeded: '退款成功', failed: '退款失败' })[refund.status] || refund.status || '—';
  }
  function refundMatches(refund) {
    if (state.refundFilter === 'todo') return refund.status === 'requested';
    if (state.refundFilter === 'processing') return ['approved', 'processing', 'channel_pending'].includes(refund.status);
    if (state.refundFilter === 'manual') return refund.status === 'awaiting_manual_refund' || refund.manualRefundRequired === true;
    if (state.refundFilter === 'done') return ['rejected', 'succeeded', 'failed'].includes(refund.status);
    return true;
  }
  function renderAdvancedRefundDetail(detail) {
    const target = $('#advancedRefundDetail');
    if (!target) return;
    if (!detail) { target.innerHTML = '<h3>售后详情</h3><p class="muted">点击列表中的“查看详情”读取订单、商品、凭证和退款通道状态。</p>'; return; }
    const refund = detail.refund || detail; const order = detail.order || {}; const items = detail.items || refund.items || [];
    const canReview = refund.status === 'requested'; const canProcess = ['awaiting_manual_refund', 'processing'].includes(refund.status);
    const refundSplit = refund.creditAdjustmentCent !== undefined || refund.cashRefundRequiredCent !== undefined
      ? `<p><b>账期应收冲减：</b>${formatCents(refund.creditAdjustmentCent)}　<b>仍需原路退款：</b>${formatCents(refund.cashRefundRequiredCent)}</p>`
      : '';
    target.innerHTML = `<h3>售后单 ${escapeHtml(refund.refundNo || refund._id)}</h3><p><b>状态：</b>${escapeHtml(refundStatus(refund))}　<b>退款通道：</b>${escapeHtml(refund.channelStatus || '尚未提交')}</p><p><b>订单：</b>${escapeHtml(order.orderNo || refund.orderId || '—')}　<b>申请金额：</b>${formatCents(refund.amountCent)}</p>${refundSplit}<p><b>原因与说明：</b>${escapeHtml(refund.reason || refund.reasonCode || '—')} · ${escapeHtml(refund.description || '未填写')}</p><div>${items.map(item => `<p>${escapeHtml(item.productNameSnapshot || item.productName || item.skuId || '商品')} · ${escapeHtml(item.specSnapshot || '')} · 数量 ${Number(item.quantity || 0)} · 本次申请 ${formatCents(item.amountCent)} · 订单项实付 ${formatCents(item.paidSubtotalCent === undefined ? item.amountCent : item.paidSubtotalCent)}</p>`).join('') || '<p class="muted">没有商品明细</p>'}</div>${(refund.mediaIds || []).length ? `<p><b>凭证媒体：</b>${refund.mediaIds.map(escapeHtml).join('、')}</p>` : ''}${canReview ? `<label>审核说明<textarea id="advancedRefundReviewNote" maxlength="300"></textarea></label><button data-approve-refund="${escapeHtml(refund._id)}">审核通过</button><button data-reject-refund="${escapeHtml(refund._id)}">驳回</button>` : ''}${canProcess ? `<label>通道提交备注<textarea id="advancedRefundProcessNote" maxlength="300"></textarea></label><button data-process-refund="${escapeHtml(refund._id)}">登记为已提交退款渠道</button><p class="muted">此操作不代表退款成功，仍需等待退款渠道返回结果。</p>` : ''}<p class="muted">账期冲减以服务端账务流水为准，现金退款以渠道验签通知为准；售后退款不代表退货商品已经入库。</p>`;
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
  function render() {
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
    rows('#importsTable', state.imports.map((item) => {
      const source = item.rawPayload || {}; const parsed = item.parsedPayload || {};
      return `<tr><td>${escapeHtml(item.sourceRowNo)}</td><td>${escapeHtml(parsed.name || source.name)}</td><td>${escapeHtml(parsed.categoryName || source.category)}</td><td>${escapeHtml(parsed.specName || parsed.packageUnit)}</td><td>${badge(item.status)}</td><td>${item.status === 'staged' || item.status === 'reviewing' || item.status === 'approved' ? `<button data-approve-import="${item._id}">审核入库</button>` : '—'}</td></tr>`;
    }).join(''), 6);
    rows('#categoriesTable', state.categories.map((item) => `<tr><td>${escapeHtml(item.name)}</td><td>${badge(item.status)}</td><td>${escapeHtml(item.sort)}</td><td><button data-edit-category="${item._id}">编辑</button></td></tr>`).join(''), 4);
    $('#categoryOptions').innerHTML = state.categories.map((item) => `<option value="${escapeHtml(item._id)}">${escapeHtml(item.name)}（${escapeHtml(item.status)}）</option>`).join('');
    rows('#productsTable', state.products.map((item) => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.categoryName)}</td><td>${escapeHtml(item.frozenTemperature || '—')}</td><td>${badge(item.status)}</td><td><button data-edit-product="${item._id}">编辑</button>${item.status !== 'on_sale' ? `<button data-publish-product="${item._id}">尝试上架</button>` : '—'}</td></tr>`).join(''), 5);
    const productNames = new Map(state.products.map((item) => [item._id, item.name]));
    const skuNames = new Map(state.skus.map((item) => [item._id, `${productNames.get(item.productId) || item.productId} · ${item.specName}`]));
    $('#productMediaProductOptions').innerHTML = state.products.map((item) => `<option value="${escapeHtml(item._id)}">${escapeHtml(item.name)}（${escapeHtml(item.status)}）</option>`).join('');
    $('#skuOptions').innerHTML = state.skus.map((item) => `<option value="${escapeHtml(item._id)}">${escapeHtml(skuNames.get(item._id))}（${escapeHtml(item.status)}）</option>`).join('');
    const mediaNames = new Map(state.media.map((item) => [item._id, `${item.name} · ${item.type}`]));
    $('#mediaAssetOptions').innerHTML = state.media.map((item) => `<option value="${escapeHtml(item._id)}">${escapeHtml(item.name)}（${escapeHtml(item.type)}）</option>`).join('');
    rows('#skusTable', state.skus.map((item) => `<tr><td>${escapeHtml(item.specName)}</td><td>${escapeHtml(item.packageUnit || '—')}</td><td>${escapeHtml(item.minOrderQuantity || 1)} 起购 / ${escapeHtml(item.orderMultiple || 1)} 倍数</td><td>${escapeHtml(productNames.get(item.productId) || item.productId)}</td><td>${badge(item.status)}</td><td><button data-edit-sku="${item._id}">编辑</button>${item.status !== 'on_sale' ? `<button data-publish-sku="${item._id}">上架 SKU</button>` : `<button data-offsale-sku="${item._id}">下架 SKU</button>`}</td></tr>`).join(''), 6);
    const productMediaRoleNames = { cover: '封面', detail: '详情', video_cover: '视频封面', instruction: '说明' };
    rows('#productMediaTable', state.productMedia.map((item) => `<tr><td>${escapeHtml(productNames.get(item.productId) || item.productId)}${item.skuId ? `<br><small>${escapeHtml(skuNames.get(item.skuId) || item.skuId)}</small>` : ''}</td><td><code title="${escapeHtml(item.mediaAssetId)}">${escapeHtml(mediaNames.get(item.mediaAssetId) || item.mediaAssetId)}</code></td><td>${escapeHtml(item.mediaType)}</td><td>${escapeHtml(productMediaRoleNames[item.role] || item.role)}</td><td>${badge(item.enabled === false ? 'disabled' : 'enabled')}</td><td><button data-edit-product-media="${item._id}">编辑</button></td></tr>`).join(''), 6);
    rows('#businessApplicationsTable', state.businessApplications.map((item) => `<tr><td>${escapeHtml(item.companyName)}<br><code>${escapeHtml(item.unifiedCode)}</code></td><td>${escapeHtml(item.contactName)} ${escapeHtml(item.contactPhoneMasked)}</td><td>${formatDate(item.submittedAt)}</td><td>${badge(item.status)}</td><td>${item.status === 'pending' ? `<button data-approve-business="${item._id}">通过</button><button data-reject-business="${item._id}">驳回</button>` : '—'}</td></tr>`).join(''), 5);
    rows('#usersTable', state.users.map((item) => `<tr><td><code>${escapeHtml(item._id)}</code></td><td>${escapeHtml(String(item.userType || 'c').toUpperCase())}</td><td><code>${escapeHtml(item.organizationId || '—')}</code></td><td>${escapeHtml(item.priceLevel || '—')}</td><td><button data-edit-user-pricing="${item._id}">调整</button></td></tr>`).join(''), 5);
    rows('#pricesTable', state.prices.map((item) => `<tr><td>${escapeHtml(skuNames.get(item.skuId) || item.skuId)}</td><td>${escapeHtml(item.scopeType)} ${escapeHtml(item.scopeId || '')}</td><td>${formatCents(item.amountCent)}<br><small>${escapeHtml(quantityTierSummary(item.quantityTiers))}</small></td><td>${escapeHtml(item.minOrderQuantity || 0) || 0} / ${escapeHtml(item.orderMultiple || 0) || 0}<br><small>0=继承 SKU</small></td><td>${escapeHtml(item.source || '未标记')}${item.temporary ? '<br><small>AI/测试草案</small>' : ''}</td><td>${escapeHtml(item.channel || 'all')}</td><td>${badge(item.status)}</td><td><button data-edit-price="${item._id}">编辑</button></td></tr>`).join(''), 8);
    const warehouseNames = new Map(state.warehouses.map((item) => [item._id, item.name]));
    $('#warehouseOptions').innerHTML = state.warehouses.map((item) => `<option value="${escapeHtml(item._id)}">${escapeHtml(item.name)}（${escapeHtml(item.status)}）</option>`).join('');
    $('#deliveryAreaOptions').innerHTML = state.deliveryAreas.map((item) => `<option value="${escapeHtml(item._id)}">${escapeHtml(item.name)}</option>`).join('');
    rows('#warehousesTable', state.warehouses.map((item) => `<tr><td>${escapeHtml(item.name)}<br><code>${escapeHtml(item.code)}</code></td><td>${badge(item.status)}</td><td><button data-edit-warehouse="${item._id}">编辑</button></td></tr>`).join(''), 3);
    rows('#deliveryAreasTable', state.deliveryAreas.map((item) => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml((item.regionCodes || []).length)}</td><td>${badge(item.status)}</td><td><button data-edit-delivery-area="${item._id}">编辑</button></td></tr>`).join(''), 4);
    rows('#freightRulesTable', state.freightRules.map((item) => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(state.deliveryAreas.find((area) => area._id === item.deliveryAreaId)?.name || item.deliveryAreaId)}</td><td>${formatCents(item.baseFeeCent)}</td><td>${badge(item.status)}</td><td><button data-edit-freight="${item._id}">编辑</button></td></tr>`).join(''), 5);
    rows('#deliverySlotsTable', state.deliverySlots.map((item) => `<tr><td>${escapeHtml(item.name)} ${escapeHtml(item.startTime)}-${escapeHtml(item.endTime)}</td><td>${escapeHtml(state.deliveryAreas.find((area) => area._id === item.deliveryAreaId)?.name || item.deliveryAreaId)}</td><td>${escapeHtml(warehouseNames.get(item.warehouseId) || item.warehouseId || '全部')}</td><td>${badge(item.status)}</td><td><button data-edit-delivery-slot="${item._id}">编辑</button></td></tr>`).join(''), 5);
    rows('#pickupSitesTable', state.pickupSites.map((item) => `<tr><td>${escapeHtml(item.name)}<br><small>${escapeHtml(item.address)}</small></td><td>${escapeHtml(item.regionCode)}<br><small>${escapeHtml(warehouseNames.get(item.warehouseId) || item.warehouseId)}</small></td><td>${escapeHtml(item.openingHours)}</td><td>${badge(item.status)}</td><td><button data-edit-pickup-site="${item._id}">编辑</button><button data-toggle-pickup-site="${item.status === 'active' ? 'disabled' : 'active'}" data-id="${item._id}">${item.status === 'active' ? '停用' : '启用'}</button></td></tr>`).join(''), 5);
    rows('#inventoryTable', state.inventory.map((item) => `<tr><td>${escapeHtml(warehouseNames.get(item.warehouseId) || item.warehouseId)}</td><td>${escapeHtml(skuNames.get(item.skuId) || item.skuId)}</td><td>${escapeHtml(item.onHand)}</td><td>${escapeHtml(item.reserved)}</td><td>${escapeHtml(item.available)}</td><td>${formatDate(item.updatedAt)}</td></tr>`).join(''), 6);
    const actions = { pending_confirmation: ['picking', '开始拣货'], picking: ['shipping', '标记发货'], shipping: ['delivered', '标记送达'] };
    rows('#ordersTable', state.orders.map((item) => { const action = actions[item.status]; return `<tr><td><code>${escapeHtml(item.orderNo)}</code></td><td>${badge(item.status)}</td><td>${formatCents(item.totalAmountCent)}</td><td>${escapeHtml(item.paymentStatus)}</td><td>${formatDate(item.createdAt)}</td><td>${action ? `<button data-transition-order="${item._id}" data-next-status="${action[0]}">${action[1]}</button>` : '—'}</td></tr>`; }).join(''), 6);
    $('#advancedRefundFilter').value = state.refundFilter;
    rows('#refundsTable', state.refunds.filter(refundMatches).map((item) => `<tr><td><code>${escapeHtml(item.refundNo)}</code></td><td><code>${escapeHtml(item.orderId)}</code></td><td>${formatCents(item.amountCent)}</td><td>${escapeHtml(item.reason || item.reasonCode || '—')}</td><td>${escapeHtml(refundStatus(item))}<br><small>通道：${escapeHtml(item.channelStatus || '尚未提交')}</small></td><td><button data-refund-detail="${escapeHtml(item._id)}">查看详情</button>${item.status === 'requested' ? `<button data-approve-refund="${escapeHtml(item._id)}">审核通过</button><button data-reject-refund="${escapeHtml(item._id)}">驳回</button>` : ''}${['awaiting_manual_refund', 'processing'].includes(item.status) ? `<button data-process-refund="${escapeHtml(item._id)}">登记为已提交退款渠道</button>` : ''}</td></tr>`).join(''), 6);
    renderAdvancedRefundDetail(state.refundDetail);
    rows('#groupCampaignsTable', state.groupCampaigns.map((item) => `<tr><td>${escapeHtml(item.title)}</td><td>${escapeHtml(skuNames.get(item.skuId) || item.skuId)}</td><td>${escapeHtml(item.groupSize)}</td><td>${formatCents(item.groupPriceCent)}</td><td>${badge(item.status)}</td><td><button data-edit-group-campaign="${item._id}">编辑</button></td></tr>`).join(''), 6);
    const roleNames = new Map(state.roles.map((item) => [item._id, item.name]));
    rows('#adminUsersTable', state.adminUsers.map((item) => `<tr><td>${escapeHtml(item.username)}<br>${escapeHtml(item.displayName)}</td><td>${escapeHtml((item.roleIds || []).map((id) => roleNames.get(id) || id).join('、'))}</td><td>${badge(item.status)}</td><td>${formatDate(item.lastLoginAt)}</td><td><button data-edit-admin-user="${item.id}">编辑</button></td></tr>`).join(''), 5);
    rows('#rolesTable', state.roles.map((item) => `<tr><td>${escapeHtml(item.name)}<br><code>${escapeHtml(item.code)}</code></td><td>${escapeHtml((item.permissions || []).length)}</td><td>${badge(item.status)}</td></tr>`).join(''), 3);
    rows('#bannersTable', state.banners.map((item) => `<tr><td>${escapeHtml(item.title)}</td><td><code>${escapeHtml(item.mediaAssetId || '未设置')}</code></td><td>${escapeHtml(item.jumpType)} ${escapeHtml(item.jumpTarget)}</td><td>${badge(item.enabled ? 'enabled' : 'disabled')}</td><td><button data-edit-banner="${item._id}">编辑</button></td></tr>`).join(''), 5);
    rows('#sectionsTable', state.sections.map((item) => {
      const sectionLabel = ({ news: '活动头条', special: '特价专区', group: '拼团专场' })[item.moduleType] || '活动头条';
      return `<tr><td>${escapeHtml(sectionLabel)}</td><td>${escapeHtml(item.title)}</td><td>${escapeHtml(item.subtitle || '—')}</td><td><code>${escapeHtml(item.mediaAssetId || '未设置')}</code></td><td>${escapeHtml(item.jumpType)} ${escapeHtml(item.jumpTarget)}</td><td>${badge(item.enabled ? 'enabled' : 'disabled')}</td><td><button data-edit-section="${item._id}">编辑</button></td></tr>`;
    }).join(''), 7);
    rows('#mediaTable', state.media.map((item) => `<tr><td>${escapeHtml(item.name)}${item.temporary ? ' <span class="badge">临时</span>' : ''}</td><td>${escapeHtml(item.type)}</td><td>${escapeHtml(item.source)}</td><td>${escapeHtml(item.version)}</td><td><code title="${escapeHtml(item.fileId)}">${escapeHtml(item.fileId)}</code></td><td><button data-version-media="${item._id}">新建版本</button></td></tr>`).join(''), 6);
    rows('#auditTable', state.audit.map((item) => `<tr><td>${formatDate(item.createdAt)}</td><td>${escapeHtml(item.action)}</td><td>${escapeHtml(item.targetType)} / ${escapeHtml(item.targetId)}</td><td>${escapeHtml(item.actorId || 'system')}</td></tr>`).join(''), 4);
  }
  async function refreshAll() {
    const tasks = await Promise.allSettled([
      listAll('admin.imports.list'), listAll('admin.categories.list'), listAll('admin.products.list'), listAll('admin.skus.list'),
      call('admin.roles.list', { pageSize: 100 }), call('admin.adminUsers.list', { pageSize: 100 }), call('admin.users.list', { pageSize: 100 }), call('admin.businessApplications.list', { pageSize: 100 }), call('admin.prices.list', { pageSize: 100 }), call('admin.warehouses.list', { pageSize: 100 }), call('admin.inventory.list', { pageSize: 100 }), call('admin.deliveryAreas.list', { pageSize: 100 }), call('admin.freightRules.list', { pageSize: 100 }), call('admin.deliverySlots.list', { pageSize: 100 }), listAll('admin.pickupSites.list'), listAll('admin.orders.list'), listAll('admin.refunds.list'), call('admin.groupCampaigns.list', { pageSize: 100 }),
      call('admin.media.list', { pageSize: 100 }), call('admin.productMedia.list', { pageSize: 100 }), call('admin.banners.list', { pageSize: 100 }), call('admin.homeSections.list', { pageSize: 100 }), call('admin.audit.list', { pageSize: 100 })
    ]);
    const failed = tasks.filter((item) => item.status === 'rejected');
    const data = tasks.map((item) => item.status === 'fulfilled' ? item.value : { rows: [] });
    [state.imports, state.categories, state.products, state.skus, state.roles, state.adminUsers, state.users, state.businessApplications, state.prices, state.warehouses, state.inventory, state.deliveryAreas, state.freightRules, state.deliverySlots, state.pickupSites, state.orders, state.refunds, state.groupCampaigns, state.media, state.productMedia, state.banners, state.sections, state.audit] = data.map((item) => item.rows || []);
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
  function fillCategory(id) {
    const item = state.categories.find((row) => row._id === id); if (!item) return;
    const form = $('#categoryForm'); form.elements.id.value = item._id; form.elements.name.value = item.name; form.elements.imageMediaId.value = item.imageMediaId || ''; form.elements.sort.value = item.sort || 0; form.elements.status.value = item.status;
    panel('categories'); window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function fillBanner(id) {
    const item = state.banners.find((row) => row._id === id); if (!item) return;
    const form = $('#bannerForm'); form.elements.id.value = item._id; form.elements.title.value = item.title; form.elements.mediaAssetId.value = item.mediaAssetId || ''; form.elements.jumpType.value = item.jumpType || 'none'; form.elements.jumpTarget.value = item.jumpTarget || ''; form.elements.sort.value = item.sort || 0; form.elements.enabled.checked = item.enabled !== false;
    panel('content'); window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function fillSection(id) {
    const item = state.sections.find((row) => row._id === id); if (!item) return;
    const form = $('#sectionForm'); form.elements.id.value = item._id; form.elements.moduleType.value = item.moduleType || 'news'; form.elements.title.value = item.title; form.elements.subtitle.value = item.subtitle || ''; form.elements.linkText.value = item.linkText || '更多'; form.elements.mediaAssetId.value = item.mediaAssetId || ''; form.elements.jumpType.value = item.jumpType || 'none'; form.elements.jumpTarget.value = item.jumpTarget || ''; form.elements.sort.value = item.sort || 0; form.elements.enabled.checked = item.enabled !== false;
    panel('content'); window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function startMediaVersion(id) {
    const item = state.media.find((row) => row._id === id); if (!item) return;
    const form = $('#mediaForm'); form.reset(); form.elements.replacesMediaAssetId.value = item._id; form.elements.name.value = `${item.name} v${Number(item.version || 1) + 1}`; form.elements.type.value = item.type || 'image'; form.elements.source.value = item.source || 'admin_upload'; form.elements.temporary.checked = item.temporary === true; form.elements.mimeType.value = item.mimeType || ''; form.elements.sizeBytes.value = 0; form.elements.startAt.value = String(item.startAt || '').slice(0, 16); form.elements.endAt.value = String(item.endAt || '').slice(0, 16); const targetPlatforms = item.targetPlatforms && item.targetPlatforms.length ? item.targetPlatforms : ['miniapp', 'web']; form.querySelectorAll('input[name="targetPlatforms"]').forEach((input) => { input.checked = targetPlatforms.includes(input.value); });
    $('#mediaVersionHint').textContent = `正在为“${item.name}”创建版本 ${Number(item.version || 1) + 1}；请填写新的 CloudBase 文件 ID，旧素材会保留。`;
    panel('media'); window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function fillProduct(id) {
    const item = state.products.find((row) => row._id === id); if (!item) return;
    const form = $('#productForm'); form.elements.id.value = item._id; form.elements.name.value = item.name; form.elements.categoryId.value = item.categoryId; form.elements.brand.value = item.brand || ''; form.elements.origin.value = item.origin || ''; form.elements.frozenTemperature.value = item.frozenTemperature || '-18℃'; form.elements.coverMediaId.value = item.coverMediaId || ''; form.elements.sort.value = item.sort || 0;
    panel('products'); window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function fillProductMedia(id) {
    const item = state.productMedia.find((row) => row._id === id); if (!item) return;
    const form = $('#productMediaForm'); form.elements.id.value = item._id; form.elements.productId.value = item.productId; form.elements.skuId.value = item.skuId || ''; form.elements.mediaAssetId.value = item.mediaAssetId; form.elements.mediaType.value = item.mediaType; form.elements.role.value = item.role || 'detail'; form.elements.sort.value = item.sort || 0; form.elements.enabled.checked = item.enabled !== false;
    panel('products'); window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function fillSku(id) {
    const item = state.skus.find((row) => row._id === id); if (!item) return;
    const form = $('#skuForm'); form.elements.id.value = item._id; form.elements.productId.value = item.productId; form.elements.specName.value = item.specName; form.elements.packageUnit.value = item.packageUnit || ''; form.elements.netWeight.value = item.netWeight || ''; form.elements.weightUnit.value = item.weightUnit || ''; form.elements.piecesPerCase.value = item.piecesPerCase || 0; form.elements.minOrderQuantity.value = item.minOrderQuantity || 1; form.elements.orderMultiple.value = item.orderMultiple || 1; form.elements.barcode.value = item.barcode || ''; form.elements.status.value = item.status;
    panel('products'); window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function fillPrice(id) {
    const item = state.prices.find((row) => row._id === id); if (!item) return;
    const form = $('#priceForm'); form.elements.id.value = item._id; form.elements.skuId.value = item.skuId; form.elements.scopeType.value = item.scopeType; form.elements.scopeId.value = item.scopeId || ''; form.elements.channel.value = item.channel || 'all'; form.elements.amountCent.value = item.amountCent; form.elements.quantityTiers.value = formatQuantityTiers(item.quantityTiers); form.elements.minOrderQuantity.value = item.minOrderQuantity || 0; form.elements.orderMultiple.value = item.orderMultiple || 0; form.elements.priority.value = item.priority || 0; form.elements.source.value = item.source || 'client'; form.elements.temporary.checked = item.temporary === true; form.elements.demoNote.value = item.demoNote || ''; form.elements.status.value = item.status;
    panel('pricing'); window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function fillUserPricing(id) {
    const item = state.users.find((row) => row._id === id); if (!item) return;
    const form = $('#userPricingForm'); form.elements.id.value = item._id; form.elements.userType.value = item.userType || 'c'; form.elements.organizationId.value = item.organizationId || ''; form.elements.priceLevel.value = item.priceLevel || '';
    panel('customers'); window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function fillWarehouse(id) {
    const item = state.warehouses.find((row) => row._id === id); if (!item) return;
    const form = $('#warehouseForm'); form.elements.id.value = item._id; form.elements.code.value = item.code; form.elements.name.value = item.name; form.elements.address.value = item.address || ''; form.elements.status.value = item.status; form.elements.sort.value = item.sort || 0;
    panel('fulfillment'); window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function fillDeliveryArea(id) {
    const item = state.deliveryAreas.find((row) => row._id === id); if (!item) return;
    const form = $('#deliveryAreaForm'); form.elements.id.value = item._id; form.elements.name.value = item.name; form.elements.regionCodes.value = (item.regionCodes || []).join('\n'); form.elements.warehouseIds.value = (item.warehouseIds || []).join('\n'); form.elements.status.value = item.status;
    panel('fulfillment'); window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function fillFreight(id) {
    const item = state.freightRules.find((row) => row._id === id); if (!item) return;
    const form = $('#freightForm'); form.elements.id.value = item._id; form.elements.name.value = item.name; form.elements.deliveryAreaId.value = item.deliveryAreaId; form.elements.warehouseId.value = item.warehouseId || ''; form.elements.baseFeeCent.value = item.baseFeeCent || 0; form.elements.additionalFeeCent.value = item.additionalFeeCent || 0; form.elements.freeThresholdCent.value = item.freeThresholdCent || 0; form.elements.status.value = item.status;
    panel('fulfillment'); window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function fillDeliverySlot(id) {
    const item = state.deliverySlots.find((row) => row._id === id); if (!item) return;
    const form = $('#deliverySlotForm'); form.elements.id.value = item._id; form.elements.name.value = item.name; form.elements.deliveryAreaId.value = item.deliveryAreaId; form.elements.warehouseId.value = item.warehouseId || ''; form.elements.startTime.value = item.startTime; form.elements.endTime.value = item.endTime; form.elements.status.value = item.status;
    panel('fulfillment'); window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function fillPickupSite(id) {
    const item = state.pickupSites.find((row) => row._id === id); if (!item) return;
    const form = $('#pickupSiteForm'); form.elements.id.value = item._id; form.elements.name.value = item.name; form.elements.address.value = item.address; form.elements.regionCode.value = item.regionCode; form.elements.warehouseId.value = item.warehouseId; form.elements.openingHours.value = item.openingHours; form.elements.status.value = item.status; form.elements.sort.value = item.sort || 0;
    panel('fulfillment'); window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function fillGroupCampaign(id) {
    const item = state.groupCampaigns.find((row) => row._id === id); if (!item) return;
    const form = $('#groupCampaignForm'); form.elements.id.value = item._id; form.elements.title.value = item.title; form.elements.skuId.value = item.skuId; form.elements.groupSize.value = item.groupSize; form.elements.durationMinutes.value = item.durationMinutes; form.elements.groupPriceCent.value = item.groupPriceCent; form.elements.targetUserType.value = item.targetUserType || 'all'; form.elements.status.value = item.status;
    panel('groups'); window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function fillAdminUser(id) {
    const item = state.adminUsers.find((row) => row.id === id); if (!item) return;
    const form = $('#adminUserForm'); form.elements.id.value = item.id; form.elements.username.value = item.username; form.elements.displayName.value = item.displayName; form.elements.password.value = ''; form.elements.roleIds.value = (item.roleIds || []).join('\n'); form.elements.status.value = item.status;
    panel('access'); window.scrollTo({ top: 0, behavior: 'smooth' });
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
  async function loadAdvancedRefundDetail(id) {
    const target = $('#advancedRefundDetail');
    target.innerHTML = '<h3>售后详情</h3><p class="muted">正在加载…</p>';
    try { state.refundDetail = await call('admin.refunds.get', { id }); renderAdvancedRefundDetail(state.refundDetail); }
    catch (error) { state.refundDetail = null; target.innerHTML = `<h3>售后详情加载失败</h3><p class="muted">${escapeHtml(error.message || '请稍后重试')}</p><button data-refund-detail="${escapeHtml(id)}">重试</button>`; message(error.message || '售后详情加载失败。', true); }
  }
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
    $('#advancedRefundFilter').addEventListener('change', (event) => { state.refundFilter = event.target.value; render(); });
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
    $('#categoryForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.categories.upsert', { id: form.get('id'), name: form.get('name'), imageMediaId: form.get('imageMediaId'), sort: Number(form.get('sort')), status: form.get('status') }); event.currentTarget.reset(); await refreshAll(); message('分类已保存。'); } catch (error) { message(error.message, true); } });
    $('#bannerForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.banners.upsert', { id: form.get('id'), title: form.get('title'), mediaAssetId: form.get('mediaAssetId'), jumpType: form.get('jumpType'), jumpTarget: form.get('jumpTarget'), sort: Number(form.get('sort')), enabled: form.get('enabled') === 'on' }); event.currentTarget.reset(); await refreshAll(); message('轮播图配置已保存。'); } catch (error) { message(error.message, true); } });
    $('#sectionForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.homeSections.upsert', { id: form.get('id'), moduleType: form.get('moduleType'), title: form.get('title'), subtitle: form.get('subtitle'), linkText: form.get('linkText'), mediaAssetId: form.get('mediaAssetId'), jumpType: form.get('jumpType'), jumpTarget: form.get('jumpTarget'), sort: Number(form.get('sort')), enabled: form.get('enabled') === 'on' }); event.currentTarget.reset(); await refreshAll(); message('首页模块已保存。'); } catch (error) { message(error.message, true); } });
    $('#productForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.products.upsert', { id: form.get('id'), name: form.get('name'), categoryId: form.get('categoryId'), brand: form.get('brand'), origin: form.get('origin'), frozenTemperature: form.get('frozenTemperature'), coverMediaId: form.get('coverMediaId'), sort: Number(form.get('sort')) }); event.currentTarget.reset(); await refreshAll(); message('商品信息已保存。'); } catch (error) { message(error.message, true); } });
    $('#productMediaForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.productMedia.upsert', { id: form.get('id'), productId: form.get('productId'), skuId: form.get('skuId'), mediaAssetId: form.get('mediaAssetId'), mediaType: form.get('mediaType'), role: form.get('role'), sort: Number(form.get('sort')), enabled: form.get('enabled') === 'on' }); event.currentTarget.reset(); await refreshAll(); message('商品媒体关联已保存；小程序详情页会按启用状态读取。'); } catch (error) { message(error.message, true); } });
    $('#skuForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.skus.upsert', { id: form.get('id'), productId: form.get('productId'), specName: form.get('specName'), packageUnit: form.get('packageUnit'), netWeight: form.get('netWeight'), weightUnit: form.get('weightUnit'), piecesPerCase: Number(form.get('piecesPerCase')), minOrderQuantity: Number(form.get('minOrderQuantity')), orderMultiple: Number(form.get('orderMultiple')), barcode: form.get('barcode'), status: form.get('status') }); event.currentTarget.reset(); await refreshAll(); message('SKU 信息和购买规则已保存。'); } catch (error) { message(error.message, true); } });
    $('#userPricingForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.users.setPricingProfile', { id: form.get('id'), userType: form.get('userType'), organizationId: form.get('organizationId'), priceLevel: form.get('priceLevel') }); event.currentTarget.reset(); await refreshAll(); message('用户身份与价格等级已保存。'); } catch (error) { message(error.message, true); } });
    $('#priceForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.prices.upsert', { id: form.get('id'), skuId: form.get('skuId'), scopeType: form.get('scopeType'), scopeId: form.get('scopeId'), channel: form.get('channel'), amountCent: Number(form.get('amountCent')), quantityTiers: parseQuantityTiers(form.get('quantityTiers')), minOrderQuantity: Number(form.get('minOrderQuantity')), orderMultiple: Number(form.get('orderMultiple')), priority: Number(form.get('priority')), source: form.get('source'), temporary: form.get('temporary') === 'on', demoNote: form.get('demoNote'), status: form.get('status') }); event.currentTarget.reset(); await refreshAll(); message('价格、阶梯和购买规则已保存；用户端仅在登录后由服务端报价。'); } catch (error) { message(error.message, true); } });
    $('#warehouseForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.warehouses.upsert', { id: form.get('id'), code: form.get('code'), name: form.get('name'), address: form.get('address'), sort: Number(form.get('sort')), status: form.get('status') }); event.currentTarget.reset(); await refreshAll(); message('仓库已保存。'); } catch (error) { message(error.message, true); } });
    $('#deliveryAreaForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.deliveryAreas.upsert', { id: form.get('id'), name: form.get('name'), regionCodes: splitLines(form.get('regionCodes')), warehouseIds: splitLines(form.get('warehouseIds')), status: form.get('status') }); event.currentTarget.reset(); await refreshAll(); message('配送区域已保存。'); } catch (error) { message(error.message, true); } });
    $('#freightForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.freightRules.upsert', { id: form.get('id'), name: form.get('name'), deliveryAreaId: form.get('deliveryAreaId'), warehouseId: form.get('warehouseId'), baseFeeCent: Number(form.get('baseFeeCent')), additionalFeeCent: Number(form.get('additionalFeeCent')), freeThresholdCent: Number(form.get('freeThresholdCent')), status: form.get('status') }); event.currentTarget.reset(); await refreshAll(); message('运费规则已保存。'); } catch (error) { message(error.message, true); } });
    $('#inventoryForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.inventory.adjust', { warehouseId: form.get('warehouseId'), skuId: form.get('skuId'), change: Number(form.get('change')), reason: form.get('reason'), idempotencyKey: newIdempotencyKey() }); event.currentTarget.reset(); await refreshAll(); message('库存已调整并写入流水。'); } catch (error) { message(error.message, true); } });
    $('#deliverySlotForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.deliverySlots.upsert', { id: form.get('id'), name: form.get('name'), deliveryAreaId: form.get('deliveryAreaId'), warehouseId: form.get('warehouseId'), startTime: form.get('startTime'), endTime: form.get('endTime'), status: form.get('status') }); event.currentTarget.reset(); await refreshAll(); message('配送时段已保存。'); } catch (error) { message(error.message, true); } });
    $('#pickupSiteForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.pickupSites.upsert', { id: form.get('id'), name: form.get('name'), address: form.get('address'), regionCode: form.get('regionCode'), warehouseId: form.get('warehouseId'), openingHours: form.get('openingHours'), status: form.get('status'), sort: Number(form.get('sort')) }); event.currentTarget.reset(); await refreshAll(); message('自提点已保存。'); } catch (error) { message(error.message, true); } });
    $('#groupCampaignForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await call('admin.groupCampaigns.upsert', { id: form.get('id'), title: form.get('title'), skuId: form.get('skuId'), groupSize: Number(form.get('groupSize')), durationMinutes: Number(form.get('durationMinutes')), groupPriceCent: Number(form.get('groupPriceCent')), targetUserType: form.get('targetUserType'), status: form.get('status') }); event.currentTarget.reset(); await refreshAll(); message('拼团活动已保存；支付确认与成团仍由后续受控链路处理。'); } catch (error) { message(error.message, true); } });
    $('#adminUserForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { const payload = { id: form.get('id'), username: form.get('username'), displayName: form.get('displayName'), roleIds: splitLines(form.get('roleIds')), status: form.get('status') }; if (form.get('password')) payload.password = form.get('password'); await call('admin.adminUsers.upsert', payload); event.currentTarget.reset(); await refreshAll(); message('管理员账号已保存。'); } catch (error) { message(error.message, true); } });
    $('#mediaSearch').addEventListener('input', (event) => { const term = event.target.value.trim().toLowerCase(); document.querySelectorAll('#mediaTable tbody tr').forEach((tr) => { tr.style.display = !term || tr.textContent.toLowerCase().includes(term) ? '' : 'none'; }); });
    $('#mediaForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const replacesMediaAssetId = form.get('replacesMediaAssetId'); const type = form.get('type'); const selectedFile = form.get('uploadFile'); let fileId = form.get('fileId'); let mimeType = form.get('mimeType'); let sizeBytes = Number(form.get('sizeBytes')); try { if (selectedFile && selectedFile.size) { const uploaded = await api.uploadMediaFile(selectedFile, type); fileId = uploaded.fileId; mimeType = uploaded.mimeType; sizeBytes = uploaded.sizeBytes; } if (!fileId) throw new Error('请选择本地文件，或填写已有的 CloudBase 文件 ID。'); const payload = { name: form.get('name'), type, source: form.get('source'), temporary: form.get('temporary') === 'on', targetPlatforms: form.getAll('targetPlatforms'), startAt: form.get('startAt'), endAt: form.get('endAt'), fileId, mimeType, sizeBytes }; await call(replacesMediaAssetId ? 'admin.media.createVersion' : 'admin.media.upsert', { ...payload, replacesMediaAssetId }); event.currentTarget.reset(); $('#mediaVersionHint').textContent = '素材已通过管理员会话上传并登记；替换文件请使用右侧“新建版本”，旧素材不会被覆盖。'; await refreshAll(); message(replacesMediaAssetId ? '素材新版本已登记，请将新的素材 ID 配置到对应分类、商品或内容。' : '素材已上传并登记，可复制素材 ID 配置到轮播图或商品。'); } catch (error) { message(error.message || '素材上传登记失败。', true); } });
    $('.workspace').addEventListener('click', async (event) => {
      const approve = event.target.closest('[data-approve-import]'); const approveBusiness = event.target.closest('[data-approve-business]'); const rejectBusiness = event.target.closest('[data-reject-business]'); const approveRefund = event.target.closest('[data-approve-refund]'); const rejectRefund = event.target.closest('[data-reject-refund]'); const refundDetail = event.target.closest('[data-refund-detail]'); const processRefund = event.target.closest('[data-process-refund]'); const editCategory = event.target.closest('[data-edit-category]'); const editBanner = event.target.closest('[data-edit-banner]'); const editSection = event.target.closest('[data-edit-section]'); const versionMedia = event.target.closest('[data-version-media]'); const editProduct = event.target.closest('[data-edit-product]'); const editProductMedia = event.target.closest('[data-edit-product-media]'); const editSku = event.target.closest('[data-edit-sku]'); const editUserPricing = event.target.closest('[data-edit-user-pricing]'); const editPrice = event.target.closest('[data-edit-price]'); const editWarehouse = event.target.closest('[data-edit-warehouse]'); const editDeliveryArea = event.target.closest('[data-edit-delivery-area]'); const editFreight = event.target.closest('[data-edit-freight]'); const editDeliverySlot = event.target.closest('[data-edit-delivery-slot]'); const editPickupSite = event.target.closest('[data-edit-pickup-site]'); const togglePickupSite = event.target.closest('[data-toggle-pickup-site]'); const editGroupCampaign = event.target.closest('[data-edit-group-campaign]'); const editAdminUser = event.target.closest('[data-edit-admin-user]'); const transitionOrder = event.target.closest('[data-transition-order]'); const publish = event.target.closest('[data-publish-product]'); const publishSku = event.target.closest('[data-publish-sku]'); const offsaleSku = event.target.closest('[data-offsale-sku]');
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
      if (editPickupSite) return fillPickupSite(editPickupSite.dataset.editPickupSite);
      if (editGroupCampaign) return fillGroupCampaign(editGroupCampaign.dataset.editGroupCampaign);
      if (editAdminUser) return fillAdminUser(editAdminUser.dataset.editAdminUser);
      try {
        if (refundDetail) return loadAdvancedRefundDetail(refundDetail.dataset.refundDetail);
        if (approve) { await call('admin.imports.approve', { id: approve.dataset.approveImport }); await refreshAll(); message('草稿已生成商品和 SKU 草稿，请继续补齐信息并审核上架。'); }
        if (approveBusiness) { await call('admin.businessApplications.review', { id: approveBusiness.dataset.approveBusiness, decision: 'approved' }); await refreshAll(); message('企业申请已通过；请按需补充价格等级。'); }
        if (rejectBusiness) { await call('admin.businessApplications.review', { id: rejectBusiness.dataset.rejectBusiness, decision: 'rejected' }); await refreshAll(); message('企业申请已驳回。'); }
        if (approveRefund && global.confirm('确认审核通过该售后申请？审核通过不代表退款成功，后续仍需退款渠道处理。')) { await call('admin.refunds.review', { id: approveRefund.dataset.approveRefund, decision: 'approved', reviewNote: $('#advancedRefundReviewNote')?.value || '', idempotencyKey: newIdempotencyKey() }); state.refundDetail = null; await refreshAll(); message('退款已审核通过，等待退款渠道处理。'); }
        if (rejectRefund && global.confirm('确认驳回该售后申请？此操作会改变申请状态。')) { await call('admin.refunds.review', { id: rejectRefund.dataset.rejectRefund, decision: 'rejected', reviewNote: $('#advancedRefundReviewNote')?.value || '', idempotencyKey: newIdempotencyKey() }); state.refundDetail = null; await refreshAll(); message('退款申请已驳回。'); }
        if (processRefund && global.confirm('确认登记为已提交退款渠道？此操作不代表退款成功，仍需等待渠道返回结果。')) { await call('admin.refunds.process', { id: processRefund.dataset.processRefund, action: 'channel_pending', idempotencyKey: newIdempotencyKey(), note: $('#advancedRefundProcessNote')?.value || '' }); state.refundDetail = null; await refreshAll(); message('已登记提交退款渠道，等待渠道结果。'); }
        if (publish) { await call('admin.products.setStatus', { id: publish.dataset.publishProduct, status: 'on_sale' }); await refreshAll(); message('商品已上架。'); }
        if (publishSku) { await call('admin.skus.setStatus', { id: publishSku.dataset.publishSku, status: 'on_sale' }); await refreshAll(); message('SKU 已上架。'); }
        if (offsaleSku) { await call('admin.skus.setStatus', { id: offsaleSku.dataset.offsaleSku, status: 'off_sale' }); await refreshAll(); message('SKU 已下架。'); }
        if (transitionOrder) { await call('admin.orders.transition', { id: transitionOrder.dataset.transitionOrder, status: transitionOrder.dataset.nextStatus }); await refreshAll(); message('订单履约状态已更新。'); }
        if (togglePickupSite) { const item = state.pickupSites.find((row) => row._id === togglePickupSite.dataset.id); if (item) { await call('admin.pickupSites.upsert', { id: item._id, name: item.name, address: item.address, regionCode: item.regionCode, warehouseId: item.warehouseId, openingHours: item.openingHours, status: togglePickupSite.dataset.togglePickupSite, sort: Number(item.sort || 0) }); await refreshAll(); message(togglePickupSite.dataset.togglePickupSite === 'active' ? '自提点已启用。' : '自提点已停用。'); } }
      } catch (error) { message(error.message || '操作失败。', true); }
    });
  }
  async function init() {
    bind();
    if (!api.getToken()) {
      loginMessage('正在检查系统连接…');
      try {
        await api.call('health', {});
        loginMessage(requestedNext() === 'simple'
          ? '系统连接正常。请登录，成功后会自动进入运营后台。'
          : '系统连接正常，请输入管理员账号和密码。');
      } catch (error) {
        loginMessage(`系统暂时连接失败：${error.message || '请稍后重试。'}`, true);
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
          ? '登录状态已失效，请重新登录；成功后会自动进入运营后台。'
          : '登录状态已失效，系统连接正常，请重新登录。');
      } catch (error) {
        loginMessage(`系统暂时连接失败：${error.message || '请稍后重试。'}`, true);
      }
    }
  }
  init();
}(window, document));
