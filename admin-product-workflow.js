(function productWorkflow(global, document) {
  'use strict';
  const api = global.MengshixianAdminApi;
  const account = global.MengshixianAdminAccount;
  const data = global.MengshixianProductData.create(api, global.MengshixianAdminPaging);
  const id = new URLSearchParams(global.location.search).get('id') || '';
  const state = { snapshot: null, selectedImage: '', busy: false, urls: {} };
  const $ = (selector) => document.querySelector(selector);
  const esc = (value) => String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const statusName = { draft: '草稿', pending_review: '待审核', on_sale: '上架中', off_sale: '已下架', archived: '已归档' };
  const freshCode = (kind) => `MSX-${kind}-${global.crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
  function notice(message, error) {
    const node = $('#globalMessage');
    node.textContent = message;
    node.classList.toggle('workflow-error', !!error);
  }
  async function run(task, success) {
    if (state.busy) return;
    state.busy = true;
    $('#workflowContent').classList.add('workflow-loading');
    try { const result = await task(); if (result !== false) notice(success || '已保存。'); }
    catch (error) {
      if (error && ['ADMIN_SESSION_EXPIRED', 'ADMIN_UNAUTHORIZED'].includes(error.code)) {
        api.clearSession(); global.location.replace('login.html'); return;
      }
      notice(error && error.message || '操作失败，请重试。', true);
    } finally {
      state.busy = false;
      $('#workflowContent').classList.remove('workflow-loading');
    }
  }
  function toCents(text) {
    const raw = String(text).trim();
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) throw new Error('价格请填写非负金额，最多两位小数。');
    const [whole, decimals = ''] = raw.split('.');
    const cents = Number(whole) * 100 + Number(decimals.padEnd(2, '0'));
    if (!Number.isSafeInteger(cents)) throw new Error('价格过大。');
    return cents;
  }
  function categoryOptions(selected) {
    return state.snapshot.categories.map((item) => `<option value="${esc(item._id)}"${item._id === selected ? ' selected' : ''}>${esc(item.name)}${item.status === 'enabled' ? '' : '（未启用）'}</option>`).join('');
  }
  function basicFields() {
    const spuCode = $('#productCode').value.trim() || freshCode('P');
    const name = $('#productName').value.trim();
    const categoryId = $('#productCategory').value;
    if (!name) throw new Error('请填写商品名称。');
    if (!categoryId) throw new Error('请选择分类；如没有合适分类，请先去分类管理创建。');
    return { spuCode, name, categoryId, audienceType: $('#productAudience').value, coverMediaId: state.selectedImage };
  }
  async function loadUrls() {
    const fileIds = [...new Set(state.snapshot.media.filter((row) => row.type === 'image' && row.fileId).map((row) => row.fileId))];
    if (!fileIds.length || !global.cloudbase) return;
    try {
      const app = global.cloudbase.init({ env: api.config.envId, region: 'ap-shanghai' });
      const result = await app.getTempFileURL({ fileList: fileIds });
      (result.fileList || []).forEach((row) => { if (row.tempFileURL) state.urls[row.fileID || row.fileId] = row.tempFileURL; });
    } catch (_) { /* 素材名仍可选择；缩略图不是保存前提 */ }
  }
  function imageChoices() {
    const images = state.snapshot.media.filter((row) => row.type === 'image');
    if (!images.length) return '<p class="hint">素材库暂时没有图片。可以在下方上传新图片，也可以先保存商品草稿。</p>';
    return `<div class="workflow-media">${images.map((item) => `<label><input type="radio" name="coverImage" value="${esc(item._id)}"${item._id === state.selectedImage ? ' checked' : ''}>${state.urls[item.fileId] ? `<img src="${esc(state.urls[item.fileId])}" alt="">` : ''}<span title="${esc(item.name)}">${esc(item.name || '未命名图片')}</span></label>`).join('')}</div>`;
  }
  function skuSection(product) {
    if (!product) return '<p class="hint">先保存基本资料，再添加规格和价格。</p>';
    const rows = state.snapshot.skus.map((sku) => {
      const price = data.publicPrice(state.snapshot.prices, sku._id);
      return `<div class="workflow-sku" data-sku="${esc(sku._id)}"><h3>${esc(sku.specName || '未命名规格')} · ${sku.status === 'on_sale' ? '销售中' : '未销售'}</h3><div class="workflow-grid">
        <label>规格编码<input data-field="code" maxlength="60" value="${esc(sku.skuCode || '')}"${sku.skuCode ? ' readonly' : ''}></label>
        <label>规格名称<input data-field="name" maxlength="100" value="${esc(sku.specName)}"></label>
        <label>公开价格（元）<input data-field="price" inputmode="decimal" value="${price ? (price.amountCent / 100).toFixed(2) : ''}" placeholder="未设置"></label>
        <label>包装单位<input data-field="unit" maxlength="100" value="${esc(sku.packageUnit || '')}"></label>
        <label>净含量<input data-field="weight" maxlength="40" value="${esc(sku.netWeight || '')}"></label>
      </div><div class="workflow-actions"><button type="button" data-save-sku="${esc(sku._id)}">保存此规格</button><button type="button" class="${sku.status === 'on_sale' ? 'danger' : 'secondary'}" data-toggle-sku="${esc(sku._id)}" data-next-status="${sku.status === 'on_sale' ? 'off_sale' : 'on_sale'}">${sku.status === 'on_sale' ? '停止销售此规格' : '启用此规格销售'}</button></div></div>`;
    }).join('');
    return `${rows}<div class="workflow-sku"><h3>新增一个规格</h3><div class="workflow-grid"><label>规格编码（可留空，后台生成）<input id="newSkuCode" maxlength="60" placeholder="自动生成"></label><label>规格名称<input id="newSkuName" maxlength="100" placeholder="例如：1kg/包"></label><label>公开价格（元，可稍后填写）<input id="newSkuPrice" inputmode="decimal" placeholder="例如：49.90"></label><label>包装单位<input id="newSkuUnit" maxlength="100"></label><label>净含量<input id="newSkuWeight" maxlength="40"></label></div><div class="workflow-actions"><button type="button" id="addSku">添加规格</button></div></div>`;
  }
  function render() {
    const { product, categories, skus, associations, media } = state.snapshot;
    const selected = categories.find((row) => row._id === (product && product.categoryId));
    const publishIssues = global.MengshixianProductPreview.readiness(state.snapshot);
    const video = associations.find((row) => row.mediaType === 'video' && row.enabled !== false);
    const videoAsset = video && media.find((row) => row._id === video.mediaAssetId);
    $('#workflowTitle').textContent = product ? `编辑商品：${product.name}` : '新增商品';
    $('#workflowStatus').textContent = product ? statusName[product.status] || product.status : '尚未创建';
    $('#workflowContent').innerHTML = `
      <section class="workflow-section" id="basicSection"><h2>1 基本资料</h2><p class="hint">先填写顾客看得懂的名称，按名称选择分类，不用复制编号。</p>
        <div class="workflow-grid"><label>商品编码（可留空，后台生成）<input id="productCode" maxlength="60" value="${esc(product && product.spuCode)}" placeholder="自动生成"${product && product.spuCode ? ' readonly' : ''}></label><label class="wide">商品名称<input id="productName" maxlength="100" value="${esc(product && product.name)}" placeholder="例如：智利三文鱼块"></label>
          <label>商品分类<select id="productCategory"><option value="">请选择分类</option>${categoryOptions(product && product.categoryId)}</select></label>
          <label>面向客户<select id="productAudience"><option value="all"${!product || product.audienceType === 'all' ? ' selected' : ''}>个人与企业顾客</option><option value="c"${product && product.audienceType === 'c' ? ' selected' : ''}>仅个人顾客</option><option value="b"${product && product.audienceType === 'b' ? ' selected' : ''}>仅企业顾客</option></select></label></div>
        ${product && product.status === 'on_sale' ? '<p class="workflow-warning">商品正在销售：保存基本资料会立即改变顾客可见信息。</p>' : ''}
        <div class="workflow-actions"><button type="button" id="saveBasics">${product ? '保存基本资料' : '创建商品草稿'}</button><a class="secondary" href="categories.html">管理分类</a></div>
      </section>
      <section class="workflow-section" id="mediaSection"><h2>2 商品图片与详情视频</h2><p class="hint">图片按名称选择；上传后会自动选中。保存基本资料时会一并保存选中的封面。</p>
        ${imageChoices()}<div class="workflow-actions"><label class="workflow-primary">上传图片<input id="uploadImage" type="file" accept="image/jpeg,image/png,image/webp" hidden></label>${product ? '<button type="button" id="saveCover" class="secondary">保存封面图片</button>' : ''}</div>
        <div class="workflow-sku"><h3>详情视频</h3>${videoAsset ? `<p>当前视频：${esc(videoAsset.name)}</p><div class="workflow-actions"><button type="button" class="danger" id="removeVideo">移除详情视频</button></div>` : '<p class="hint">当前没有详情视频。</p>'}
        ${product ? '<label class="workflow-primary">上传详情视频（不超过 24 MB）<input id="uploadVideo" type="file" accept="video/mp4,video/webm,video/quicktime" hidden></label>' : '<p class="hint">创建商品后才能上传详情视频。</p>'}</div>
      </section>
      <section class="workflow-section" id="skuSection"><h2>3 规格与价格</h2><p class="hint">每个规格单独保存；公开价格同时适用于小程序与网页端。企业专属价仍由“价格规则”单独维护，最终报价由服务端决定。</p>${skuSection(product)}</section>
      <section class="workflow-section" id="reviewSection"><h2>4 核对并上架</h2><p class="hint">保存是留在后台；上架后符合客户范围的顾客才可能看到。最终能否看到，还取决于分类、规格和服务端权限。</p>
        <div class="workflow-review"><div><strong>商品</strong>${esc(product ? product.name : '尚未创建')}</div><div><strong>分类</strong>${esc(selected ? selected.name : '未选择')} · ${selected && selected.status === 'enabled' ? '已启用' : '未启用'}</div><div><strong>可销售规格</strong>${skus.filter((row) => row.status === 'on_sale').length} 个</div><div><strong>主图</strong>${product && product.coverMediaId ? '已保存' : '待补'}</div><div><strong>上架准备</strong>${publishIssues.length ? esc(publishIssues.join('；')) : '资料已齐'}</div></div>
        ${product ? `<div class="workflow-actions">${product.status === 'on_sale' ? '<button type="button" id="toggleSale" class="danger" data-status="off_sale">下架商品</button>' : `<a class="secondary" href="product-review.html?code=${encodeURIComponent(product.spuCode || '')}">去核对页确认发布</a>`}<a class="secondary" href="products.html">返回商品列表</a></div>` : '<p class="workflow-warning">请先创建商品草稿，再添加至少一个销售规格。</p>'}
      </section>
      <section class="workflow-section" id="previewSection"><h2>顾客视角核对</h2><p class="hint">下面只按当前后台资料模拟个人/企业顾客可见性与价格；真实展示仍以相应身份的微信小程序真机验收为准。</p>
        <div class="workflow-actions"><button type="button" id="previewCustomer"${product ? '' : ' disabled'}>核对顾客可见性</button></div><div id="customerPreview"></div>
      </section>`;
  }
  async function reload(productId) {
    state.snapshot = await data.load(productId);
    state.selectedImage = state.snapshot.product ? state.snapshot.product.coverMediaId || '' : state.selectedImage;
    await loadUrls(); render();
  }
  $('#workflowContent').addEventListener('change', (event) => {
    if (event.target.name === 'coverImage') state.selectedImage = event.target.value;
    if (event.target.id === 'uploadImage' || event.target.id === 'uploadVideo') {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      const video = event.target.id === 'uploadVideo';
      run(async () => {
        const asset = await data.upload(file, video ? 'video' : 'image');
        if (video) await data.linkVideo(state.snapshot.product._id, asset._id, true);
        else state.selectedImage = asset._id;
        await reload(state.snapshot.product && state.snapshot.product._id);
        if (!video) state.selectedImage = asset._id;
        render();
      }, video ? '视频已关联到商品。' : '图片上传成功；请点击“保存封面图片”或保存基本资料。');
    }
  });
  $('#workflowContent').addEventListener('click', (event) => {
    const target = event.target;
    if (target.id === 'saveBasics' || target.id === 'saveCover') run(async () => {
      const product = state.snapshot.product;
      if (product && product.status === 'on_sale' && !global.confirm('该商品正在销售，保存后顾客可见信息可能立即变化。继续保存？')) return false;
      const saved = await data.saveProduct(product, basicFields());
      if (!saved || !saved._id) throw new Error('商品保存失败，请刷新后重试。');
      await reload(saved._id);
      if (!product) global.history.replaceState(null, '', `product-workflow.html?id=${encodeURIComponent(saved._id)}`);
    }, '商品资料已保存。');
    if (target.dataset.saveSku) run(async () => {
      const sku = state.snapshot.skus.find((row) => row._id === target.dataset.saveSku);
      const block = target.closest('[data-sku]');
      const field = (name) => block.querySelector(`[data-field="${name}"]`).value.trim();
      if (!field('name')) throw new Error('规格名称不能为空。');
      const price = field('price');
      if (!field('code')) throw new Error('请填写规格编码。');
      const cents = price === '' ? null : toCents(price);
      if (cents !== null && state.snapshot.product && state.snapshot.product.status === 'on_sale') {
        const previous = data.publicPrice(state.snapshot.prices, sku._id);
        const previousCents = previous ? previous.amountCent : null;
        if ((previousCents === null || previousCents !== cents) && !global.confirm(`确认把「${field('name')}」价格设为 ¥${(cents / 100).toFixed(2)}？${previousCents === null ? '此前没有生效的公开价。' : `原价 ¥${(previousCents / 100).toFixed(2)}。`}商品正在销售，顾客可能立即看到新价格。`)) return false;
      }
      await data.saveSku(sku.productId, sku, { skuCode: field('code'), specName: field('name'), packageUnit: field('unit'), netWeight: field('weight') });
      if (cents !== null) await data.savePublicPrice(state.snapshot.prices, sku._id, cents);
      await reload(sku.productId);
    }, '规格与价格已保存。');
    if (target.dataset.toggleSku) run(async () => {
      const sku = state.snapshot.skus.find((row) => row._id === target.dataset.toggleSku);
      if (!sku) throw new Error('找不到此规格，请刷新页面。');
      const next = target.dataset.nextStatus;
      if (next === 'on_sale' && !global.MengshixianProductPreview.skuPriceReady(state.snapshot, sku._id)) throw new Error('请先保存此规格当前生效的真实价格，再启用销售。');
      if (!global.confirm(next === 'on_sale' ? `确认启用规格「${sku.specName}」？若商品已上架，顾客可能立即看到并购买。` : `确认停止销售规格「${sku.specName}」？顾客将不能购买。`)) return false;
      await data.setSkuStatus(sku._id, next);
      await reload(sku.productId);
    }, target.dataset.nextStatus === 'on_sale' ? '规格已启用。请核对商品是否已上架。' : '规格已停止销售。');
    if (target.id === 'addSku') run(async () => {
      const name = $('#newSkuName').value.trim();
      if (!name) throw new Error('请填写规格名称。');
      const skuCode = $('#newSkuCode').value.trim() || freshCode('S');
      const price = $('#newSkuPrice').value.trim();
      const cents = price === '' ? null : toCents(price);
      const sku = await data.saveSku(state.snapshot.product._id, null, { skuCode, specName: name, packageUnit: $('#newSkuUnit').value.trim(), netWeight: $('#newSkuWeight').value.trim() });
      if (cents !== null) await data.savePublicPrice(state.snapshot.prices, sku._id, cents);
      await reload(state.snapshot.product._id);
    }, '新规格已添加。');
    if (target.id === 'removeVideo') run(async () => {
      const association = state.snapshot.associations.find((row) => row.mediaType === 'video' && row.enabled !== false);
      if (!association || !global.confirm('移除该商品的详情视频？素材库里的文件仍会保留。')) return false;
      await data.linkVideo(state.snapshot.product._id, association.mediaAssetId, false);
      await reload(state.snapshot.product._id);
    }, '详情视频已从商品移除。');
    if (target.id === 'toggleSale') run(async () => {
      const product = state.snapshot.product;
      const next = target.dataset.status;
      if (!global.confirm(next === 'on_sale' ? `确认上架「${product.name}」？上架后符合条件的顾客可以看到。` : `确认下架「${product.name}」？`)) return false;
      if (next === 'on_sale') {
        const issues = global.MengshixianProductPreview.readiness(state.snapshot);
        if (issues.length) throw new Error(issues.join('；'));
      }
      await data.setStatus(product._id, next);
      await reload(product._id);
    }, target.dataset.status === 'on_sale' ? '商品已上架。请用顾客端核对实际展示。' : '商品已下架。');
    if (target.id === 'previewCustomer') {
      const preview = global.MengshixianProductPreview;
      $('#customerPreview').innerHTML = ['c', 'b'].map((viewer) => {
        const result = preview.summarize(state.snapshot, viewer);
        const prices = result.prices.map(({ specName, rule }) => `${esc(specName)}：${rule ? `¥${(rule.amountCent / 100).toFixed(2)}` : '未设置此身份可用价格'}`).join('；');
        return `<div class="workflow-sku"><h3>${viewer === 'c' ? '个人顾客' : '企业顾客'} · ${esc(result.reason)}</h3><p>${prices || '无销售中的规格'}</p></div>`;
      }).join('');
    }
  });
  account.bindLogout({ call: (action, payload) => api.call(action, payload), clearSession: () => api.clearSession(), message: notice });
  (async () => {
    const page = global.MengshixianAdminPages.pages.productWorkflow;
    $('#moduleEyebrow').textContent = page.groupLabel;
    $('#panelTitle').textContent = page.title;
    let me;
    try {
      me = await api.call('admin.me');
      if (!me || !me.admin) throw Object.assign(new Error('未取得已验证的账号信息。'), {code: 'ADMIN_UNAUTHORIZED'});
    } catch (error) {
      if (error && ['ADMIN_SESSION_EXPIRED', 'ADMIN_UNAUTHORIZED'].includes(error.code)) {
        api.clearSession(); global.location.replace('login.html'); return;
      }
      notice('账号验证暂时失败，请检查连接后刷新重试。', true);
      $('#adminConnectionState').textContent = '连接异常';
      return;
    }
    account.setAdmin(me.admin);
    try {
      $('#adminConnectionState').innerHTML = '<i></i>已连接';
      await reload(id);
      if (id && !state.snapshot.product) throw new Error('找不到此商品，请返回商品列表重新选择。');
    } catch (error) {
      if (error && ['ADMIN_SESSION_EXPIRED', 'ADMIN_UNAUTHORIZED'].includes(error.code)) { api.clearSession(); global.location.replace('login.html'); return; }
      notice(error && error.message || '商品加载失败。', true);
      $('#workflowContent').textContent = '加载失败，请刷新页面重试。';
      $('#adminConnectionState').textContent = '连接异常';
    }
  })();
}(window, document));
