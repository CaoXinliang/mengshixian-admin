// 梦食鲜简单后台：日常运营任务（订单/价格/图片/名称/规格/新增商品/上下架/退款/库存）。
// 复用完整版的 config.js、api-client.js 与同标签页管理员会话；未登录统一跳完整版登录。
// 商品列表点「修改」进入独立编辑页：预览在左、表单在右；顾客视角与小程序顾客端同一公开接口。
(function attachSimpleAdmin(global) {
  'use strict';

  const api = global.MengshixianAdminApi;
  const config = global.MENGSHIXIAN_ADMIN_CONFIG || {};
  const $ = (sel) => document.querySelector(sel);

  const SIMPLE_PAGE_SIZE = 10;
  const state = {
    me: null,
    products: [], skus: [], prices: [], categories: [], media: [],
    orders: [], refunds: [], inventory: [], warehouses: [],
    urlMap: {}, imagePickId: '',
    orderFilter: 'todo', productKeyword: '', inventoryKeyword: '',
    editor: null, editorMediaRows: [],
    live: { rows: [], categories: [], activeCategory: '', focusId: '', viewer: 'c', detailId: '', detailSkuId: '', detailQty: 1, detailCache: {}, syncedAt: '' },
    pageMap: { orders: 1, products: 1, refunds: 1, inventory: 1 }
  };
  // 分页通用函数
  function applyPagination(list, pageKey, containerEl, rowHtmlFn) {
    const total = list.length;
    const pages = Math.max(1, Math.ceil(total / SIMPLE_PAGE_SIZE));
    let page = state.pageMap[pageKey] || 1;
    if (page > pages) page = pages;
    if (page < 1) page = 1;
    state.pageMap[pageKey] = page;
    const start = (page - 1) * SIMPLE_PAGE_SIZE;
    const sliced = list.slice(start, start + SIMPLE_PAGE_SIZE);
    containerEl.innerHTML = sliced.map(rowHtmlFn).join('');
    // 移除旧分页
    const oldPager = containerEl.nextElementSibling;
    if (oldPager && oldPager.classList.contains('pager')) oldPager.remove();
    if (total > SIMPLE_PAGE_SIZE) {
      containerEl.insertAdjacentHTML('afterend', buildSimplePagerHtml(page, pages, total, pageKey));
    }
  }
  function buildSimplePagerHtml(page, pages, total, pageKey) {
    const prev = page > 1 ? `<button data-page="${page - 1}" data-pk="${pageKey}">上一页</button>` : `<button disabled>上一页</button>`;
    const next = page < pages ? `<button data-page="${page + 1}" data-pk="${pageKey}">下一页</button>` : `<button disabled>下一页</button>`;
    const pagesHtml = [];
    let winStart = Math.max(1, page - 2);
    let winEnd = Math.min(pages, winStart + 4);
    if (winEnd - winStart + 1 < 5) winStart = Math.max(1, winEnd - 4);
    if (winStart > 1) pagesHtml.push(`<button data-page="1" data-pk="${pageKey}">1</button>`);
    if (winStart > 2) pagesHtml.push(`<span>…</span>`);
    for (let p = winStart; p <= winEnd; p++) {
      pagesHtml.push(p === page ? `<button class="is-active" disabled>${p}</button>` : `<button data-page="${p}" data-pk="${pageKey}">${p}</button>`);
    }
    if (winEnd < pages - 1) pagesHtml.push(`<span>…</span>`);
    if (winEnd < pages) pagesHtml.push(`<button data-page="${pages}" data-pk="${pageKey}">${pages}</button>`);
    return `<div class="pager"><div class="p-info">共 ${total} 条，第 ${page}/${pages} 页</div><div class="p-btns">${prev}${pagesHtml.join('')}${next}<div class="p-jump"><span>跳至</span><input type="number" min="1" max="${pages}" placeholder="页码" data-pk="${pageKey}"><span>页</span></div></div></div>`;
  }

  const ORDER_STATUS_TEXT = {
    pending_payment: '待支付', pending_confirmation: '待确认', picking: '拣货中',
    shipping: '配送中', delivered: '已送达', completed: '已完成', cancelled: '已取消'
  };
  const ORDER_FLOW = ['pending_confirmation', 'picking', 'shipping'];
  const PAY_TEXT = { unpaid: '未支付', paid: '已支付', refunded: '已退款', demo_not_required: '无需支付' };
  const PAY_METHOD_TEXT = { demo: '演示支付', wechat: '微信支付', offline: '线下支付' };
  const REFUND_STATUS_TEXT = {
    requested: '待处理', approved: '已同意', rejected: '已驳回',
    processing: '退款中', succeeded: '退款成功', failed: '退款失败'
  };
  const PRODUCT_STATUS_TEXT = { draft: '草稿', pending_review: '待审核', on_sale: '上架中', off_sale: '已下架', archived: '已归档' };

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
  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function showNotice(text, isError) {
    const el = $('#notice');
    el.className = 'notice ' + (isError ? 'err' : 'ok');
    el.textContent = text;
    clearTimeout(showNotice._timer);
    showNotice._timer = setTimeout(() => { el.className = 'notice'; el.textContent = ''; }, isError ? 10000 : 4000);
  }
  let busy = false;
  async function guard(fn, doneText) {
    if (busy) return;
    busy = true;
    try {
      await fn();
      if (doneText) showNotice(doneText);
    } catch (error) {
      showNotice(error && error.message || '操作失败，请重试', true);
      if (error && (error.code === 'ADMIN_SESSION_EXPIRED' || error.code === 'ADMIN_UNAUTHORIZED')) enterLogin('登录已失效，请重新登录');
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
    $('#appView').style.display = 'block';
    $('#topBar').style.display = 'flex';
    $('#whoami').textContent = state.me ? `你好，${state.me.displayName || state.me.username}` : '';
  }
  async function boot() {
    if (!api.getToken()) return redirectToFullLogin('login_required');
    try {
      const me = await api.call('admin.me');
      state.me = me && me.admin;
      await api.call('health');
      enterApp();
      await reloadAll();
      refreshLive();
    } catch (error) {
      api.clearSession();
      redirectToFullLogin('session_expired');
    }
  }
  $('#logoutBtn').addEventListener('click', () => guard(async () => {
    try { await api.call('admin.logout'); } catch (_) { /* 本地退出不受影响 */ }
    api.clearSession();
    global.location.replace('index.html');
  }));

  // ---------- 数据加载 ----------
  async function list(action) {
    if (!global.MengshixianAdminPaging) throw new Error('后台分页保护模块未加载。');
    const result = await global.MengshixianAdminPaging.listAll(api.call, action);
    return result && Array.isArray(result.rows) ? result.rows : [];
  }
  async function reloadCore() {
    const [products, skus, prices, categories, media, warehouses, inventory] = await Promise.all([
      list('admin.products.list'), list('admin.skus.list'), list('admin.prices.list'),
      list('admin.categories.list'), list('admin.media.list'), list('admin.warehouses.list'), list('admin.inventory.list')
    ]);
    state.products = products; state.skus = skus; state.prices = prices;
    state.categories = categories; state.media = media; state.warehouses = warehouses; state.inventory = inventory;
    state.live.detailCache = {};
    await tempUrls([
      ...media.map((m) => m.fileId),
      ...products.map((p) => { const asset = media.find((m) => m._id === p.coverMediaId); return asset && asset.fileId; })
    ]);
  }
  async function reloadTrade() {
    const [orders, refunds] = await Promise.all([list('admin.orders.list'), list('admin.refunds.list')]);
    state.orders = orders;
    state.refunds = refunds;
  }
  async function reloadAll() { await Promise.all([reloadCore(), reloadTrade()]); renderAll(); }
  function renderAll() { renderDashboard(); renderOrders(); renderProducts(); renderRefunds(); renderInventory(); }

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
  }

  // ---------- 今日待办 ----------
  function renderDashboard() {
    const counts = { pending_confirmation: 0, picking: 0, shipping: 0 };
    state.orders.forEach((o) => { if (counts[o.status] !== undefined) counts[o.status] += 1; });
    const refundTodo = state.refunds.filter((r) => r.status === 'requested').length;
    const onSale = state.products.filter((p) => p.status === 'on_sale').length;
    const cards = [
      { view: 'orders', filter: 'pending_confirmation', num: counts.pending_confirmation, label: '新订单，待接单', alert: counts.pending_confirmation > 0 },
      { view: 'orders', filter: 'picking', num: counts.picking, label: '拣货中，待发货', alert: false },
      { view: 'orders', filter: 'shipping', num: counts.shipping, label: '配送中', alert: false },
      { view: 'refunds', num: refundTodo, label: '待处理的退款申请', alert: refundTodo > 0 },
      { view: 'products', num: onSale, label: '在售商品数', alert: false }
    ];
    $('#statGrid').innerHTML = cards.map((c) => `
      <div class="stat-card" data-go="${c.view}" data-filter="${c.filter || ''}">
        <div class="num ${c.alert ? 'alert' : ''}">${c.num}</div>
        <div class="label">${esc(c.label)}</div>
      </div>`).join('');
  }
  $('#statGrid').addEventListener('click', (event) => {
    const card = event.target.closest('[data-go]');
    if (!card) return;
    if (card.dataset.filter) { state.orderFilter = card.dataset.filter; renderOrders(); }
    switchView(card.dataset.go);
  });

  // ---------- 订单处理 ----------
  function orderActionButtons(order) {
    const buttons = [];
    if (order.status === 'pending_confirmation') buttons.push(`<button class="act" data-order-action="picking" data-id="${esc(order._id)}">接单，开始拣货</button>`);
    if (order.status === 'picking') buttons.push(`<button class="act green" data-order-action="shipping" data-confirm-text="确认发货？" data-id="${esc(order._id)}">发货</button>`);
    if (order.status === 'shipping') buttons.push(`<button class="act green" data-order-action="completed" data-confirm-text="确认已完成这张订单？" data-id="${esc(order._id)}">标记完成</button>`);
    if (order.status === 'completed') buttons.push(`<button class="act plain" data-order-action="shipping" data-confirm-text="确认取消送达，订单回退到配送中？" data-id="${esc(order._id)}">取消送达</button>`);
    if ((order.status === 'pending_confirmation' || order.status === 'picking') && order.paymentStatus !== 'paid') {
      buttons.push(`<button class="act danger" data-order-action="cancelled" data-id="${esc(order._id)}">取消订单</button>`);
    }
    return buttons.join('');
  }
  function renderOrders() {
    const filters = [
      { key: 'todo', label: '待处理' }, { key: 'pending_confirmation', label: '待确认' },
      { key: 'picking', label: '拣货中' }, { key: 'shipping', label: '配送中' },
      { key: 'completed', label: '已完成' }, { key: 'cancelled', label: '已取消' }
    ];
    $('#orderChips').innerHTML = filters.map((f) => `<button data-chip="${f.key}" class="${state.orderFilter === f.key ? 'is-active' : ''}">${f.label}</button>`).join('');
    const rows = state.orders.filter((o) => {
      if (state.orderFilter === 'todo') return ORDER_FLOW.includes(o.status);
      return o.status === state.orderFilter;
    });
    const listEl = $('#orderList');
    if (!rows.length) {
      listEl.innerHTML = `<div class="empty"><div class="big">🍃</div>这里没有需要处理的订单</div>`;
      listEl.nextElementSibling?.classList.contains('pager') && listEl.nextElementSibling.remove();
      return;
    }
    applyPagination(rows, 'orders', listEl, (o) => {
      const address = o.addressSnapshot || {};
      const slot = o.deliverySlotSnapshot || {};
      const payText = PAY_TEXT[o.paymentStatus] || o.paymentStatus || '—';
      return `<div class="oc">
        <div class="row1">
          <strong>订单 ${esc(o.orderNo || o._id)}</strong>
          <span class="badge b-blue">${ORDER_STATUS_TEXT[o.status] || esc(o.status)}</span>
          <span class="badge ${o.paymentStatus === 'paid' ? 'b-green' : 'b-gray'}">${payText}</span>
          <span class="spacer" style="flex:1"></span>
          <span class="money">${yuan(o.totalAmountCent)}</span>
        </div>
        <div class="meta">下单时间：${fmtTime(o.createdAt)}　支付方式：${esc(PAY_METHOD_TEXT[o.paymentMethod] || o.paymentMethod || '—')}<br>
        收货：${esc(address.name || '—')}　${esc(address.phoneMasked || '')}<br>${esc(address.detail || '')}${slot.name ? `　｜　配送时段：${esc(slot.name)} ${esc(slot.startTime || '')}-${esc(slot.endTime || '')}` : ''}</div>
        <div class="actions">${orderActionButtons(o)}</div>
      </div>`;
    });
  }
  $('#orderChips').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-chip]');
    if (!chip) return;
    state.orderFilter = chip.dataset.chip;
    state.pageMap.orders = 1;
    renderOrders();
  });
  $('#orderList').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-order-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    const next = btn.dataset.orderAction;
    const confirmText = btn.dataset.confirmText || {
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
    const viewerLabel = state.live.viewer === 'b' ? 'B 端顾客' : 'C 端顾客';
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
    const qty = state.live.detailQty || 1;
    const warehouseName = (state.warehouses[0] && state.warehouses[0].name) || '梦食鲜仓';
    const qtyHtml = `<span class="qty"><button data-detail-qty="-1" ${qty <= 1 ? 'disabled' : ''}>−</button><b>${qty}</b><button data-detail-qty="1">+</button></span>`;
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
          <div class="d-price-row"><span class="d-price ${rule ? '' : 'is-locked'}">${rule ? yuan(rule.amountCent) : '登录后查看价格'}</span></div>
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
    // 分页按钮
    const pagerBtn = event.target.closest('[data-page]');
    if (pagerBtn) {
      state.pageMap[pagerBtn.dataset.pk] = Number(pagerBtn.dataset.page);
      const renderers = { orders: renderOrders, products: renderProducts, refunds: renderRefunds, inventory: renderInventory };
      (renderers[pagerBtn.dataset.pk] || (() => {}))();
      return;
    }
    const viewerChip = event.target.closest('[data-live-viewer]');
    if (viewerChip) {
      state.live.viewer = viewerChip.dataset.liveViewer;
      refreshLive();
      return;
    }
    const qtyBtn = event.target.closest('[data-detail-qty]');
    if (qtyBtn) {
      state.live.detailQty = Math.max(1, (state.live.detailQty || 1) + Number(qtyBtn.dataset.detailQty));
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
      state.live.detailQty = 1;
      const p = state.live.rows.find((r) => r._id === state.live.detailId);
      state.live.detailSkuId = p && Array.isArray(p.skus) && p.skus[0] ? p.skus[0]._id : '';
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
  function publicPriceOf(skuId) {
    const rules = state.prices.filter((p) => p.skuId === skuId && p.scopeType === 'public' && p.status === 'active');
    return rules.find((r) => !r.channel || r.channel === 'all') || rules[0] || null;
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
  async function saveSkuPrice(sku, cents) {
    const rules = state.prices.filter((p) => p.skuId === sku._id && p.scopeType === 'public');
    const preferred = rules.find((r) => !r.channel || r.channel === 'all');
    if (preferred) {
      await api.call('admin.prices.upsert', {
        id: preferred._id, skuId: sku._id, scopeType: 'public', scopeId: preferred.scopeId || '',
        channel: 'all', amountCent: cents, priority: preferred.priority || 0, status: 'active'
      });
    } else {
      await api.call('admin.prices.upsert', {
        skuId: sku._id, scopeType: 'public', scopeId: '', channel: 'all', amountCent: cents, priority: 0, status: 'active'
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
      sort: s.sort || 0, status: patch.status !== undefined ? patch.status : (s.status || 'on_sale')
    });
  }
  function renderProducts() {
    const keyword = state.productKeyword.trim();
    const rows = state.products.filter((p) => p.status !== 'archived');
    const matched = !keyword ? rows : rows.filter((p) => `${p.name || ''}${p.categoryName || categoryOf(p.categoryId)}`.includes(keyword));
    const listEl = $('#productList');
    if (!matched.length) {
      listEl.innerHTML = `<div class="empty"><div class="big">📦</div>没有找到商品</div>`;
      listEl.nextElementSibling?.classList.contains('pager') && listEl.nextElementSibling.remove();
      return;
    }
    applyPagination(matched, 'products', listEl, (p) => {
      const skus = state.skus.filter((s) => s.productId === p._id);
      const statusBadge = p.status === 'on_sale' ? '<span class="badge b-green">上架中</span>'
        : p.status === 'off_sale' ? '<span class="badge b-gray">已下架</span>' : `<span class="badge b-orange">${PRODUCT_STATUS_TEXT[p.status] || esc(p.status)}</span>`;
      const priceValues = skus.map((s) => publicPriceOf(s._id)).filter(Boolean).map((rule) => Number(rule.amountCent || 0));
      const priceText = priceValues.length
        ? (Math.min(...priceValues) === Math.max(...priceValues)
          ? yuan(priceValues[0])
          : `${yuan(Math.min(...priceValues))}–${yuan(Math.max(...priceValues))}`)
        : '未设公开价';
      const skuSummary = skus.length
        ? `<div class="summary"><span>${skus.length} 个规格</span><span>·</span><span class="price-range">${priceText}</span></div>`
        : '<div class="hint">该商品还没有规格</div>';
      return `<div class="pc">
        <img class="cover" src="${esc(coverUrlOf(p))}" alt="" onerror="this.style.visibility='hidden'">
        <div class="info">
          <div class="pname">${esc(p.name)}</div>
          <div class="pcat">${esc(p.categoryName || categoryOf(p.categoryId))}　${statusBadge}${p.audienceType === 'c' ? ' <span class="badge b-orange">仅C端</span>' : p.audienceType === 'b' ? ' <span class="badge b-orange">仅B端</span>' : ''}</div>
          ${skuSummary}
        </div>
        <div class="btns">
          <button class="act" data-open-editor="${esc(p._id)}">修改</button>
          ${p.status === 'on_sale'
            ? `<button class="act danger" data-set-status="off_sale" data-id="${esc(p._id)}">下架</button>`
            : `<button class="act green" data-set-status="on_sale" data-id="${esc(p._id)}">上架</button>`}
          <button class="act plain narrow-only" data-preview-modal="${esc(p._id)}">顾客视角</button>
        </div>
      </div>`;
    });
  }
  $('#productSearch').addEventListener('input', (event) => { state.productKeyword = event.target.value; state.pageMap.products = 1; renderProducts(); });
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
  function renderEditor() {
    if (!state.editor) return;
    if (state.editor.mode === 'new') {
      $('#editorTitle').textContent = '新增商品';
      $('#editorForm').innerHTML = `
        <div class="form-section">
          <h3>基本信息</h3>
          <div class="frow"><label class="f">商品名称<input id="edName" maxlength="100" placeholder="例如：智利三文鱼块"></label></div>
          <div class="frow">
            <label class="f">分类<select id="edCat">${categoryOptions('')}</select></label>
            <label class="f">面向客户<select id="edAudience">
              <option value="all">全部顾客（C 端 + B 端）</option>
              <option value="c">仅 C 端（个人顾客）</option>
              <option value="b">仅 B 端（企业采购）</option>
            </select></label>
          </div>
        </div>
        <div class="form-section">
          <h3>商品图片（可选）</h3>
          ${imageStripHtml()}
          <div class="frow" style="margin-top:8px"><label class="act plain upload-mini">上传新图<input type="file" id="edUpload" accept="image/jpeg,image/png,image/webp"></label><span class="hint">不选则先用默认图，之后可再换。</span></div>
        </div>
        <div class="form-section">
          <h3>规格与价格</h3>
          <div id="newSpecRows"></div>
          <button class="act plain" id="addSpecRow">+ 再加一个规格</button>
        </div>
        <div class="form-section">
          <h3>完成</h3>
          <div class="frow">
            <button class="act green" id="createProductBtn">创建并上架</button>
            <button class="act plain" id="cancelNewBtn">取消</button>
          </div>
          <p class="hint">创建后立即对顾客可见；如分类未启用会先存为草稿，请在完整版启用分类后再上架。</p>
        </div>`;
      $('#addSpecRow').addEventListener('click', () => appendNewSpecRow());
      appendNewSpecRow();
      $('#cancelNewBtn').addEventListener('click', () => {
        state.editor = null;
        switchView('products');
      });
      $('#createProductBtn').addEventListener('click', () => guard(submitNewProduct, ''));
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
    $('#editorForm').innerHTML = `
      <div class="form-section">
        <h3>基本信息 ${statusBadge}</h3>
        <div class="frow"><label class="f">商品名称<input id="edName" maxlength="100" value="${esc(p.name || '')}"></label></div>
        <div class="frow">
          <label class="f">分类<select id="edCat">${categoryOptions(p.categoryId)}</select></label>
          <label class="f">面向客户<select id="edAudience">
            <option value="all" ${audienceValue === 'all' ? 'selected' : ''}>全部顾客（C 端 + B 端）</option>
            <option value="c" ${audienceValue === 'c' ? 'selected' : ''}>仅 C 端（个人顾客）</option>
            <option value="b" ${audienceValue === 'b' ? 'selected' : ''}>仅 B 端（企业采购）</option>
          </select></label>
        </div>
        <div class="frow"><button class="act" id="saveInfoBtn">保存基本信息</button></div>
        <p class="hint">面向客户决定哪个端能看到此商品：仅 C 端＝个人顾客可见、B 端顾客看不到；仅 B 端则相反。品牌/产地等不影响展示的字段请在完整版维护。</p>
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
          return `<div class="spec-block" data-spec-block="${esc(s._id)}">
            <div class="frow">
              <label class="f">规格名称<input data-f="specName" maxlength="100" value="${esc(s.specName || '')}"></label>
              <label class="f">价格（元）<input data-f="price" type="number" step="0.01" min="0" value="${rule ? (rule.amountCent / 100).toFixed(2) : ''}" placeholder="例如 25.5"></label>
            </div>
            <div class="frow">
              <label class="f">包装单位<input data-f="packageUnit" maxlength="100" value="${esc(s.packageUnit || '')}"></label>
              <label class="f">净含量<input data-f="netWeight" maxlength="40" value="${esc(s.netWeight || '')}"></label>
            </div>
            <div class="frow"><button class="act" data-save-spec="${esc(s._id)}">保存此规格</button></div>
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
          <p class="hint">上传后自动挂到本商品详情页，顾客在详情页可直接播放。更大的视频请先在 CloudBase 控制台上传后再关联。</p>
        `}
      </div>
      <div class="form-section">
        <h3>上架状态</h3>
        <p class="hint">上架后仅“面向客户”设置匹配的顾客可见；下架后所有顾客都看不到。价格在顾客登录后按身份由服务端计算。</p>
        <div class="frow">
          ${p.status === 'on_sale'
            ? `<button class="act danger" id="statusBtn" data-next="off_sale">下架商品</button>`
            : `<button class="act green" id="statusBtn" data-next="on_sale">上架商品</button>`}
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
      let cents = null;
      if (priceText !== '') {
        cents = toCents(priceText);
        if (Number.isNaN(cents)) return showNotice('价格格式不对，例如 25.5', true);
      }
      const created = await api.call('admin.skus.upsert', {
        productId: p._id, specName, packageUnit: ($('#newSpecUnit').value || '').trim(),
        netWeight: ($('#newSpecWeight').value || '').trim(), mediaIds: [], sort: skus.length, status: 'on_sale'
      });
      if (cents !== null && created) {
        await api.call('admin.prices.upsert', { skuId: created._id, scopeType: 'public', scopeId: '', channel: 'all', amountCent: cents, priority: 0, status: 'active' });
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
      guard(async () => {
        await saveSkuFields(sku, { specName, packageUnit: (read('packageUnit') || '').trim(), netWeight: (read('netWeight') || '').trim() });
        if (priceText !== '') {
          const cents = toCents(priceText);
          if (Number.isNaN(cents)) throw new Error('价格格式不对，例如 25.5');
          await saveSkuPrice(sku, cents);
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
      <div class="frow"><button class="act plain" data-remove-spec>移除此规格</button></div>`;
    const container = $('#newSpecRows');
    container.appendChild(row);
    row.querySelector('[data-remove-spec]').addEventListener('click', () => {
      if (container.children.length <= 1) return showNotice('至少保留一个规格', true);
      row.remove();
    });
  }
  async function submitNewProduct() {
    const name = ($('#edName').value || '').trim();
    if (!name) return showNotice('请填写商品名称', true);
    const categoryId = $('#edCat') ? $('#edCat').value : '';
    if (!categoryId) return showNotice('请选择分类；没有合适分类请先在完整版里新增', true);
    const audienceType = $('#edAudience') ? $('#edAudience').value : 'all';
    const specs = [...document.querySelectorAll('#newSpecRows .spec-block')].map((block) => ({
      specName: (block.querySelector('[data-new="specName"]').value || '').trim(),
      packageUnit: (block.querySelector('[data-new="packageUnit"]').value || '').trim(),
      netWeight: (block.querySelector('[data-new="netWeight"]').value || '').trim(),
      priceText: block.querySelector('[data-new="price"]').value
    }));
    if (!specs.some((s) => s.specName)) return showNotice('至少填写一个规格名称', true);
    for (const s of specs) {
      if (s.specName && s.priceText !== '') {
        if (Number.isNaN(toCents(s.priceText))) return showNotice(`规格「${s.specName}」的价格格式不对`, true);
      }
    }
    showNotice('正在创建商品…');
    const product = await api.call('admin.products.upsert', {
      name, categoryId, audienceType,
      coverMediaId: state.imagePickId || '', sort: 0, status: 'draft'
    });
    if (!product || !product._id) throw new Error('商品创建失败，请重试');
    let liveFail = '';
    for (let index = 0; index < specs.length; index += 1) {
      const s = specs[index];
      if (!s.specName) continue;
      const sku = await api.call('admin.skus.upsert', {
        productId: product._id, specName: s.specName, packageUnit: s.packageUnit, netWeight: s.netWeight,
        mediaIds: [], sort: index, status: 'on_sale'
      });
      if (s.priceText !== '' && sku) {
        await api.call('admin.prices.upsert', { skuId: sku._id, scopeType: 'public', scopeId: '', channel: 'all', amountCent: toCents(s.priceText), priority: 0, status: 'active' });
      }
    }
    try {
      await api.call('admin.products.setStatus', { id: product._id, status: 'on_sale' });
    } catch (error) {
      liveFail = error && error.message || '上架失败';
    }
    state.editor = null;
    await reloadCore();
    renderProducts(); renderDashboard();
    switchView('products');
    await refreshLive();
    focusLive(product._id);
    showNotice(liveFail ? `商品已创建，但上架没成功：${liveFail}（通常是分类未启用）` : '商品已创建并上架，符合“面向客户”设置的顾客现在可以看到');
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
      <p class="pv-note">与小程序顾客端同一接口实时读取。</p>
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
  function renderRefunds() {
    const rows = state.refunds;
    const listEl = $('#refundList');
    if (!rows.length) { listEl.innerHTML = `<div class="empty"><div class="big">🌤️</div>没有退款申请</div>`; listEl.nextElementSibling?.classList.contains('pager') && listEl.nextElementSibling.remove(); return; }
    applyPagination(rows, 'refunds', listEl, (r) => {
      const isTodo = r.status === 'requested';
      return `<div class="oc">
        <div class="row1">
          <strong>退款单 ${esc(r.refundNo || r._id)}</strong>
          <span class="badge ${isTodo ? 'b-red' : 'b-gray'}">${REFUND_STATUS_TEXT[r.status] || esc(r.status)}</span>
          <span class="spacer" style="flex:1"></span>
          <span class="money">${yuan(r.amountCent)}</span>
        </div>
        <div class="meta">申请时间：${fmtTime(r.createdAt)}　原因：${esc(r.reason || '—')}</div>
        ${isTodo ? `<div class="actions">
          <button class="act green" data-refund="approved" data-id="${esc(r._id)}">同意退款</button>
          <button class="act danger" data-refund="rejected" data-id="${esc(r._id)}">驳回</button>
        </div>` : ''}
      </div>`;
    });
  }
  $('#refundRefresh').addEventListener('click', () => guard(async () => { await reloadTrade(); renderRefunds(); renderDashboard(); }, '已刷新'));
  $('#refundList').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-refund]');
    if (!btn) return;
    const decision = btn.dataset.refund;
    if (!global.confirm(decision === 'approved' ? '确认同意这笔退款？同意后进入退款流程。' : '确认驳回这笔退款申请？')) return;
    guard(async () => {
      await api.call('admin.refunds.review', { id: btn.dataset.id, decision });
      await reloadTrade();
      renderRefunds(); renderDashboard();
    }, decision === 'approved' ? '已同意退款' : '已驳回退款申请');
  });

  // ---------- 库存 ----------
  function renderInventory() {
    const keyword = state.inventoryKeyword.trim();
    const rows = state.inventory.map((inv) => {
      const sku = state.skus.find((s) => s._id === inv.skuId);
      const product = sku && state.products.find((p) => p._id === sku.productId);
      const warehouse = state.warehouses.find((w) => w._id === inv.warehouseId);
      return { inv, sku, product, warehouse };
    }).filter((row) => row.sku && (!keyword || (row.product && row.product.name || '').includes(keyword)));
    const listEl = $('#inventoryList');
    if (!rows.length) { listEl.innerHTML = `<div class="empty"><div class="big">${state.inventory.length ? '📦' : '🏷️'}</div>${state.inventory.length ? '没有匹配的库存记录' : '还没有库存记录'}</div>`; listEl.nextElementSibling?.classList.contains('pager') && listEl.nextElementSibling.remove(); return; }
    applyPagination(rows, 'inventory', listEl, ({ inv, sku, product, warehouse }) => `
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
      </div>`);
  }
  $('#inventorySearch').addEventListener('input', (event) => { state.inventoryKeyword = event.target.value; state.pageMap.inventory = 1; renderInventory(); });
  $('#inventoryRefresh').addEventListener('click', () => guard(async () => { await reloadCore(); renderInventory(); }, '已刷新'));
  $('#inventoryList').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-stock]');
    if (!btn) return;
    const direction = btn.dataset.stock === 'in' ? 1 : -1;
    const sku = state.skus.find((s) => s._id === btn.dataset.sku);
    const product = sku && state.products.find((p) => p._id === sku.productId);
    openModal(`
      <h3>库存${btn.dataset.stock === 'in' ? '入库' : '出库'} · ${esc(product ? product.name : '')}</h3>
      <p class="hint">规格：${esc(sku && sku.specName || '')}</p>
      <div class="field">
        <label>${btn.dataset.stock === 'in' ? '入库数量' : '出库数量'}</label>
        <input id="stockInput" type="number" step="1" min="1" placeholder="例如 10">
      </div>
      <div class="actions">
        <button class="act plain" data-close>取消</button>
        <button class="act" id="stockSave">确认${btn.dataset.stock === 'in' ? '入库' : '出库'}</button>
      </div>
    `);
    $('#stockInput').focus();
    $('#stockSave').addEventListener('click', () => {
      const count = Math.floor(Number($('#stockInput').value));
      if (!Number.isFinite(count) || count <= 0) return showNotice('请输入正确的数量', true);
      guard(async () => {
        await api.call('admin.inventory.adjust', {
          warehouseId: btn.dataset.wh, skuId: btn.dataset.sku, change: direction * count,
          reason: direction > 0 ? 'simple_inbound' : 'simple_outbound',
          idempotencyKey: `simple-${direction > 0 ? 'in' : 'out'}-${btn.dataset.sku}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        });
        closeModal();
        await reloadCore();
        renderInventory();
      }, '库存已更新');
    });
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

  // 分页跳转回车
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const input = event.target.closest('input[data-pk]');
    if (!input) return;
    const page = Number(input.value);
    const pk = input.dataset.pk;
    if (!Number.isFinite(page) || page < 1) return;
    state.pageMap[pk] = page;
    const renderers = { orders: renderOrders, products: renderProducts, refunds: renderRefunds, inventory: renderInventory };
    (renderers[pk] || (() => {}))();
  });

  boot();
}(window));
