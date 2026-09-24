(function productReview(global, document) {
  'use strict';
  const api = global.MengshixianAdminApi;
  const account = global.MengshixianAdminAccount;
  const paging = global.MengshixianAdminPaging;
  const state = { products: [], media: [], selectedId: '', review: null, busy: false, previewFailed: false, previewPending: 0 };
  const $ = (selector) => document.querySelector(selector);
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  function message(value, error) { $('#globalMessage').textContent = value; $('#globalMessage').classList.toggle('workflow-error', !!error); }
  async function all(action) { return (await paging.listAll((name, options) => api.call(name, options), action)).rows; }
  async function tempUrl(fileId) {
    if (!fileId || !global.cloudbase) return '';
    try {
      const cloud = global.cloudbase.init({ env: api.config.envId, region: 'ap-shanghai' });
      const result = await cloud.getTempFileURL({ fileList: [fileId] });
      return result.fileList && result.fileList[0] && result.fileList[0].tempFileURL || '';
    } catch (_) { return ''; }
  }
  function renderList() {
    const term = $('#reviewSearch').value.trim().toLowerCase();
    const rows = state.products.filter((item) => !term || `${item.name} ${item.spuCode || ''}`.toLowerCase().includes(term));
    $('#reviewProducts').innerHTML = rows.map((item) => `<button type="button" class="review-item${item._id === state.selectedId ? ' is-selected' : ''}" data-review-id="${esc(item._id)}"><span>${esc(item.name || '未命名商品')}</span><small>${esc(item.spuCode || '编码待补')} · ${item.status === 'on_sale' ? '已上架' : '待核对草稿'}</small></button>`).join('') || '<p>没有匹配的商品。</p>';
  }
  function mediaOptions(type) {
    return state.media.filter((item) => item.type === type && item.enabled !== false).map((item) => `<option value="${esc(item._id)}">${esc(item.name)}（${type === 'image' ? '图片' : '视频'} · 第 ${Number(item.version) || 1} 版）</option>`).join('');
  }
  async function renderReview() {
    const row = state.review;
    if (!row) return;
    const coverUrl = await tempUrl(row.cover && row.cover.fileId);
    const detailImages = await Promise.all((row.detailImages || []).map(async (item) => ({ ...item, url: await tempUrl(item.fileId) })));
    const videos = await Promise.all((row.videos || []).map(async (item) => ({ ...item, url: await tempUrl(item.fileId) })));
    state.previewFailed = Boolean(row.cover && !coverUrl) || [...detailImages, ...videos].some((item) => !item.url);
    state.previewPending = (coverUrl ? 1 : 0) + [...detailImages, ...videos].filter((item) => item.url).length;
    const skuOptions = row.skus.map((sku) => `<option value="${esc(sku.skuCode)}">${esc(sku.specName)} · ${esc(sku.skuCode)}</option>`).join('');
    $('#reviewDetail').innerHTML = `<h2>${esc(row.product.name)}</h2><p>商品编码：${esc(row.product.productCode || '待补')} · ${row.product.status === 'on_sale' ? '已上架' : '待补齐草稿'}</p>
      <div class="review-grid"><div class="review-field"><strong>商品名称</strong>${esc(row.product.name)}</div><div class="review-field"><strong>分类</strong>${esc(row.category && row.category.name || '待补')} · ${row.category && row.category.status === 'enabled' ? '已启用' : '未启用'}</div>
      <div class="review-field"><strong>面向客户</strong>${row.product.audienceType === 'b' ? '仅企业' : row.product.audienceType === 'c' ? '仅个人' : '个人与企业'}</div>
      <div class="review-field"><strong>个人顾客小程序价格</strong>${row.product.audienceType === 'b' ? '不适用' : row.skus.filter((sku) => sku.status !== 'off_sale').length && row.skus.filter((sku) => sku.status !== 'off_sale').every((sku) => sku.personalPriceReady) ? '各销售规格已覆盖' : '待补齐：请设置公开价或个人顾客价格'} · <a href="pricing.html">去核对价格</a></div>
      <div class="review-field"><strong>主图</strong>${esc(row.cover && row.cover.name || '待补')}${coverUrl ? `<img src="${esc(coverUrl)}" alt="商品主图">` : ''}</div>
      <div class="review-field"><strong>详情图</strong>${detailImages.length ? detailImages.map((item) => `<div>${esc(item.name)}${item.skuCode ? `（规格 ${esc(item.skuCode)}）` : ''}${item.url ? `<img src="${esc(item.url)}" alt="详情图">` : ''}</div>`).join('') : '暂无详情图'}</div>
      <div class="review-field"><strong>视频（可选）</strong>${videos.length ? videos.map((item) => `<div>${esc(item.name)}${item.skuCode ? `（规格 ${esc(item.skuCode)}）` : ''}${item.url ? `<video controls preload="metadata" src="${esc(item.url)}" style="max-width:100%;max-height:180px"></video>` : ''}</div>`).join('') : '暂无视频'}</div></div>
      <h3>销售规格与价格</h3><div class="table-wrap"><table><thead><tr><th>规格编码</th><th>规格名称</th><th>包装单位</th><th>当前价格</th><th>状态</th></tr></thead><tbody>${row.skus.map((sku) => `<tr><td>${esc(sku.skuCode || '待补')}</td><td>${esc(sku.specName || '待补')}</td><td>${esc(sku.packageUnit || '待补')}</td><td>${sku.prices.length ? sku.prices.map((price) => esc(global.MengshixianReviewLabels.priceLabel(price))).join('；') : '待补'}</td><td>${sku.status === 'off_sale' ? '不销售' : sku.status === 'on_sale' ? '销售中' : '草稿'}</td></tr>`).join('')}</tbody></table></div>
      <h3>仓库与可售库存</h3>${(row.stock || []).map((sku) => `<p>${esc(sku.specName || sku.skuCode)}：${sku.locations.length ? sku.locations.map((location) => `${esc(location.warehouseName)}（${location.warehouseActive ? '已启用' : '未启用'}）可售 ${location.available == null ? '待核实' : esc(location.available)}`).join('；') : '待补齐库存'} · ${sku.ready ? '有可售库存' : '尚不满足上架条件'}</p>`).join('') || '<p>库存尚未核对。</p>'}<p><a href="inventory.html">去登记实际库存</a> · <a href="warehouses.html">去核对仓库</a></p>
      <h3>配送条件</h3>${(row.delivery || []).map((sku) => `<p>${esc(sku.specName || sku.skuCode)}：${sku.routes.length ? sku.routes.map((route) => `${esc(route.warehouseName)} → ${esc(route.areaName)} → ${esc(route.slotName)}（${esc(route.startTime)}–${esc(route.endTime)}），已匹配运费规则`).join('；') : '尚无完整的可配送配置'}</p>`).join('') || '<p>配送尚未核对。</p>'}<p>以上仅确认配置可匹配；顾客实际地址、购买数量与结算时库存仍须下单时校验。</p><p><a href="areas.html">核对配送区域</a> · <a href="freight.html">核对运费</a> · <a href="slots.html">核对配送时段</a></p>
      <div class="review-media-link"><h3>从素材库按编码关联</h3><p>先到<a href="media.html">素材库上传图片或视频</a>，再在这里选择；名称仅用于识别，关联使用商品编码及可选的规格编码。</p>
      <label>素材类型<select id="linkMediaType"><option value="image">图片</option><option value="video">视频</option></select></label>
      <label>素材库记录<select id="linkMediaAsset"><option value="">请选择素材</option>${mediaOptions('image')}</select></label>
      <label>关联到哪个规格（可选）<select id="linkSkuCode"><option value="">整个商品</option>${skuOptions}</select></label>
      <label>图片用途<select id="linkMediaRole"><option value="cover">商品主图</option><option value="detail">详情图片</option><option value="sku_image">规格图（需选规格）</option><option value="video_cover">视频封面</option></select></label>
      <div class="review-action"><button type="button" id="linkMedia"${row.product.productCode ? '' : ' disabled'}>保存素材关联</button></div></div>
      ${row.issues.length ? `<div class="review-issues"><strong>上架前需补齐：</strong>${row.issues.map(esc).join('；')}。可用下方入口进入对应页面。</div>` : '<div class="review-ready">商品资料已满足上架条件，请核对以上内容后明确确认发布。</div>'}
      <div class="review-action"><a href="product-workflow.html?id=${encodeURIComponent(row.product.id)}">编辑商品、规格与价格</a><a href="categories.html">核对分类</a>
      <button type="button" id="retryReview">重新读取并预览</button>
      ${row.product.status === 'on_sale' ? '<span>当前已上架</span>' : `<button type="button" id="publishReviewed"${row.ready && !state.previewFailed && !state.previewPending ? '' : ' disabled'}>确认发布这件商品</button>`}</div>
      <p id="mediaPreviewWarning" class="review-issues"${state.previewFailed ? '' : ' hidden'}>素材已关联，但预览尚未成功。请点“重新读取并预览”；确认看清图片与视频后再发布。</p>`;
    const refreshPreviewState = () => {
      if (state.review !== row) return;
      const warning = $('#mediaPreviewWarning');
      warning.hidden = !state.previewFailed && !state.previewPending;
      warning.textContent = state.previewFailed ? '素材预览失败，请重新读取或更换素材，确认看清后再发布。' : '正在加载素材预览，请稍候；视频还需点击试播核对内容。';
      if ($('#publishReviewed')) $('#publishReviewed').disabled = !row.ready || state.previewFailed || state.previewPending > 0;
    };
    $('#reviewDetail').querySelectorAll('img,video').forEach((element) => {
      let settled = false;
      const finish = (failed) => {
        if (settled || state.review !== row) return;
        settled = true;
        state.previewPending -= 1;
        if (failed) state.previewFailed = true;
        refreshPreviewState();
      };
      element.addEventListener(element.tagName === 'IMG' ? 'load' : 'loadedmetadata', () => finish(false), { once: true });
      element.addEventListener('error', () => {
        if (state.review !== row) return;
        state.previewFailed = true; finish(true); refreshPreviewState();
      }, { once: true });
      if (element.tagName === 'IMG' && element.complete) finish(!element.naturalWidth);
      if (element.tagName === 'VIDEO' && element.readyState >= 1) finish(false);
    });
    refreshPreviewState();
  }
  async function select(id) {
    state.selectedId = id;
    renderList();
    $('#reviewDetail').textContent = '正在读取商品、规格、价格与素材…';
    state.review = await api.call('admin.products.review', { id });
    await renderReview();
  }
  async function run(task) {
    if (state.busy) return;
    state.busy = true;
    try { await task(); } catch (error) {
      if (error && ['ADMIN_SESSION_EXPIRED', 'ADMIN_UNAUTHORIZED'].includes(error.code)) { api.clearSession(); global.location.replace('login.html'); return; }
      message(error.message || '操作失败，请刷新后重试。', true);
    } finally { state.busy = false; }
  }
  $('#reviewSearch').addEventListener('input', renderList);
  $('#reviewProducts').addEventListener('click', (event) => {
    const target = event.target.closest('[data-review-id]');
    if (target) run(() => select(target.dataset.reviewId));
  });
  $('#reviewDetail').addEventListener('change', (event) => {
    if (event.target.id !== 'linkMediaType') return;
    const type = event.target.value;
    $('#linkMediaAsset').innerHTML = `<option value="">请选择素材</option>${mediaOptions(type)}`;
    $('#linkMediaRole').innerHTML = type === 'image' ? '<option value="cover">商品主图</option><option value="detail">详情图片</option><option value="sku_image">规格图（需选规格）</option><option value="video_cover">视频封面</option>' : '<option value="detail">详情视频</option>';
  });
  $('#reviewDetail').addEventListener('click', (event) => {
    if (event.target.id === 'retryReview') run(() => select(state.selectedId));
    if (event.target.id === 'linkMedia') run(async () => {
      const mediaAssetId = $('#linkMediaAsset').value;
      const skuCode = $('#linkSkuCode').value;
      const role = $('#linkMediaRole').value;
      if (!mediaAssetId) throw new Error('请先从素材库选择图片或视频。');
      if (skuCode && role === 'cover') throw new Error('商品主图应关联整个商品；规格图片请选择“详情图片”。');
      if (!skuCode && role === 'sku_image') throw new Error('规格图请先选择对应的销售规格。');
      await api.call('admin.productMedia.linkByCode', { productCode: state.review.product.productCode, skuCode, mediaAssetId, role });
      await select(state.selectedId);
      message('素材已按编码关联到商品草稿。');
    });
    if (event.target.id === 'publishReviewed') run(async () => {
      const reviewed = state.review;
      if (!reviewed || !reviewed.ready || state.previewFailed || state.previewPending) throw new Error('商品资料或素材预览尚未完成核对。');
      if (!global.confirm(`请最后核对：${reviewed.product.name}（${reviewed.product.productCode}），${reviewed.skus.filter((sku) => sku.status !== 'off_sale').length} 个销售规格。\n确认发布后顾客可能立即看到并购买。继续吗？`)) return;
      await api.call('admin.products.publishReviewed', { id: reviewed.product.id, reviewToken: reviewed.reviewToken });
      state.products = await all('admin.products.list');
      await select(reviewed.product.id);
      message('已明确确认并发布。请用顾客端核对实际展示。');
    });
  });
  account.bindLogout({ call: (action, payload) => api.call(action, payload), clearSession: () => api.clearSession(), message });
  (async () => {
    let me;
    try {
      me = await api.call('admin.me');
      if (!me || !me.admin) throw Object.assign(new Error('未取得已验证的账号信息。'), {code: 'ADMIN_UNAUTHORIZED'});
    } catch (error) {
      if (error && ['ADMIN_SESSION_EXPIRED', 'ADMIN_UNAUTHORIZED'].includes(error.code)) {
        api.clearSession(); global.location.replace('login.html'); return;
      }
      message('账号验证暂时失败，请检查连接后刷新重试。', true);
      $('#adminConnectionState').textContent = '连接异常';
      return;
    }
    account.setAdmin(me.admin);
    $('#adminConnectionState').innerHTML = '<i></i>已连接';
    await run(async () => {
      [state.products, state.media] = await Promise.all([all('admin.products.list'), all('admin.media.list')]);
      renderList();
      const wanted = new URLSearchParams(global.location.search).get('code');
      const first = state.products.find((item) => item.spuCode === wanted) || state.products[0];
      if (first) await select(first._id);
    });
  })();
}(window, document));
