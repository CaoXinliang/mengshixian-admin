(function adminTables(global) {
  // 业务表格从已加载状态生成行；分页与格式化规则由调用方提供。
  function render(state, helpers) {
    const { escapeHtml, translateStatus, badge, formatDate, formatCents, formatRegionPreview, paginateRows } = helpers;
    const productNames = new Map(state.products.map((item) => [item._id, item.name]));
    const productCodes = new Map(state.products.map((item) => [item._id, item.spuCode || '']));
    const skuNames = new Map(state.skus.map((item) => [item._id, productNames.has(item.productId) ? `${productNames.get(item.productId)} · ${item.specName}` : (item.specName || item._id)]));
    const mediaNames = new Map(state.media.map((item) => [item._id, `${item.name} · ${translateStatus(item.type)}`]));
    const categoryNames = new Map(state.categories.map((item) => [item._id, item.name]));
    const priceTargetLabel = (item) => item.scopeType === 'public' ? '所有登录顾客'
      : !item.scopeId ? '未选择适用对象，请核对'
        : state.pricingTargetNames?.[item.scopeType]?.[item.scopeId]
          || (state.loadStates?.pricingTargetNames === 'failed' ? '对象名称暂不可用，请刷新' : '原对象已不可用，请核对');
    const jumpLabel = (item) => item.jumpType === 'product' ? `商品：${productNames.get(item.jumpTarget) || '原商品已不存在'}` : item.jumpType === 'category' ? `分类：${categoryNames.get(item.jumpTarget) || '原分类已不存在'}` : item.jumpType === 'url' ? `网页：${item.jumpTarget || '未设置'}` : '不跳转';
    const freightAudience = (type) => type === 'c' ? '仅个人顾客' : type === 'b' ? '仅企业顾客' : !type ? '个人和企业顾客' : '原适用顾客需核对';

    // ---- 批量导入 ----
    paginateRows(state.imports, (item, seq) => {
      const source = item.rawPayload || {}; const parsed = item.parsedPayload || {};
      return `<tr><td class="col-idx" style="text-align:center">${seq}</td><td>${escapeHtml(item.sourceRowNo)}</td><td>${escapeHtml(parsed.name || source.name)}<small>${escapeHtml(parsed.productCode || '编码待补')}</small></td><td>${escapeHtml(parsed.categoryName || source.category)}</td><td>${escapeHtml(parsed.specName || parsed.packageUnit)}<small>${escapeHtml(parsed.skuCode || '规格编码待补')}</small></td><td>${badge(item.status)}</td><td class="col-action">${item.status === 'staged' || item.status === 'reviewing' || item.status === 'approved' ? `<button data-approve-import="${escapeHtml(item._id)}">生成商品草稿</button>` : item.productId ? `<a href="product-workflow.html?id=${encodeURIComponent(item.productId)}">补齐资料</a> · <a href="product-review.html?code=${encodeURIComponent(parsed.productCode || '')}">核对发布</a>` : '—'}</td></tr>`;
    }, 'importsTable', 6, 'imports');

    // ---- 分类 ----
    paginateRows(state.categories, (item, seq) =>
      `<tr><td class="col-idx" style="text-align:center">${seq}</td><td>${escapeHtml(item.name)}</td><td>${badge(item.status)}</td><td>${escapeHtml(item.sort)}</td><td class="col-action"><button data-edit-category="${item._id}">编辑</button></td></tr>`,
      'categoriesTable', 4, 'categories');

    // ---- 商品 ----
    paginateRows(state.products.filter((item) => !global.__productKeyword || `${item.name || ''} ${item.categoryName || ''}`.toLowerCase().includes(global.__productKeyword)), (item, seq) =>
      `<tr><td class="col-idx" style="text-align:center">${seq}</td><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.categoryName)}</td><td>${escapeHtml(item.frozenTemperature || '—')}</td><td>${badge(item.status)}</td><td class="col-action"><a href="product-workflow.html?id=${encodeURIComponent(item._id)}">按步骤编辑</a> <button data-edit-product="${escapeHtml(item._id)}" title="修改编码、产地、保质期等专业字段">专业资料</button></td></tr>`,
      'productsTable', 5, 'products');

    // ---- SKU ----
    paginateRows(state.skus, (item, seq) =>
      `<tr><td class="col-idx" style="text-align:center">${seq}</td><td>${escapeHtml(item.specName)}</td><td>${escapeHtml(item.packageUnit || '—')}</td><td>${escapeHtml(productNames.get(item.productId) || item.productId)}${productCodes.get(item.productId) ? `<br><small><a href="product-review.html?code=${encodeURIComponent(productCodes.get(item.productId))}">核对发布</a></small>` : ''}</td><td>${badge(item.status)}</td><td class="col-action"><button data-edit-sku="${item._id}">编辑</button>${item.status !== 'on_sale' ? ` <button data-publish-sku="${item._id}">上架</button>` : ` <button data-offsale-sku="${item._id}">下架</button>`}</td></tr>`,
      'skusTable', 5, 'skus');

    // ---- 商品媒体 ----
    paginateRows(state.productMedia, (item, seq) =>
      `<tr><td class="col-idx" style="text-align:center">${seq}</td><td>${escapeHtml(productNames.get(item.productId) || item.productId)}${item.skuId ? `<br><small>${escapeHtml(skuNames.get(item.skuId) || item.skuId)}</small>` : ''}</td><td><code title="${escapeHtml(item.mediaAssetId)}">${escapeHtml(mediaNames.get(item.mediaAssetId) || item.mediaAssetId)}</code></td><td>${translateStatus(item.mediaType)}</td><td>${translateStatus(item.role)}</td><td>${badge(item.enabled === false ? 'disabled' : 'enabled')}</td><td class="col-action"><button data-edit-product-media="${item._id}">编辑</button></td></tr>`,
      'productMediaTable', 6, 'productMedia');

    // ---- 企业审核 ----
    paginateRows(state.businessApplications, (item, seq) =>
      `<tr><td class="col-idx" style="text-align:center">${seq}</td><td>${escapeHtml(item.companyName)}<br><code>${escapeHtml(item.unifiedCode)}</code></td><td>${escapeHtml(item.contactName)} ${escapeHtml(item.contactPhoneMasked)}</td><td>${formatDate(item.submittedAt)}</td><td>${badge(item.status)}</td><td class="col-action"><button data-review-business="${escapeHtml(item._id)}">查看并审核</button></td></tr>`,
      'businessApplicationsTable', 5, 'businessApplications');

    // ---- 用户列表 ----
    paginateRows(state.users, (item, seq) =>
      `<tr><td class="col-idx" style="text-align:center">${seq}</td><td>${escapeHtml(item.displayName || '未提供客户名称')}</td><td>${translateStatus(item.userType || 'c')}</td><td>${escapeHtml((state.organizations || []).find((row) => row._id === item.organizationId)?.label || (item.organizationId ? '原企业不可用，请核对' : '—'))}</td><td>${escapeHtml(item.priceLevel || '—')}</td><td class="col-action"><button data-edit-user-pricing="${item._id}">调整</button></td></tr>`,
      'usersTable', 5, 'users');

    // ---- 价格规则 ----
    paginateRows(state.prices, (item, seq) =>
      `<tr><td class="col-idx" style="text-align:center">${seq}</td><td>${escapeHtml(skuNames.get(item.skuId) || '原规格已不可用，请核对')}</td><td>${translateStatus(item.scopeType)} ${escapeHtml(priceTargetLabel(item))}</td><td>${formatCents(item.amountCent)}</td><td>${translateStatus(item.channel || 'all')}</td><td>${badge(item.status)}</td><td class="col-action"><button data-edit-price="${item._id}">编辑</button></td></tr>`,
      'pricesTable', 6, 'prices');

    // ---- 仓库 ----
    const warehouseNames = new Map(state.warehouses.map((item) => [item._id, item.name]));
    paginateRows(state.warehouses, (item, seq) =>
      `<tr><td class="col-idx" style="text-align:center">${seq}</td><td>${escapeHtml(item.name)}<br><code>${escapeHtml(item.code)}</code></td><td>${badge(item.status)}</td><td class="col-action"><button data-edit-warehouse="${item._id}">编辑</button></td></tr>`,
      'warehousesTable', 3, 'warehouses');

    // ---- 配送区域 ----
    paginateRows(state.deliveryAreas, (item, seq) =>
      `<tr><td class="col-idx" style="text-align:center">${seq}</td><td>${escapeHtml(item.name)}</td><td class="delivery-area-regions-preview">${formatRegionPreview(item.regionCodes)}</td><td>${badge(item.status)}</td><td class="col-action"><button data-edit-delivery-area="${item._id}">编辑</button></td></tr>`,
      'deliveryAreasTable', 4, 'deliveryAreas');

    // ---- 运费规则 ----
    paginateRows(state.freightRules, (item, seq) =>
      `<tr><td class="col-idx" style="text-align:center">${seq}</td><td>${escapeHtml(item.name)}<small>${freightAudience(item.customerType)} · 优先级 ${escapeHtml(item.priority || 0)}</small></td><td>${escapeHtml(state.deliveryAreas.find((area) => area._id === item.deliveryAreaId)?.name || item.deliveryAreaId)}</td><td>${formatCents(item.baseFeeCent)}<br><small>附加运费 ${item.additionalFeeCent ? formatCents(item.additionalFeeCent) : '—'}</small><br><small>免运门槛 ${item.freeThresholdCent ? formatCents(item.freeThresholdCent) : '—'}</small></td><td>${badge(item.status)}${item.validFrom || item.validTo ? `<small>${item.validFrom ? `从 ${escapeHtml(formatDate(item.validFrom))}` : '不限定开始'} 至 ${item.validTo ? escapeHtml(formatDate(item.validTo)) : '不限定结束'}</small>` : ''}</td><td class="col-action"><button data-edit-freight="${item._id}">编辑</button></td></tr>`,
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
    const orderPermissions = state.admin && state.admin.permissions || [];
    const canOrder = permission => orderPermissions.includes('*') || orderPermissions.includes(permission) || orderPermissions.includes(`${permission.split('.')[0]}.*`);
    const orderActions = { pending_confirmation: ['picking', '开始拣货'], picking: ['shipping', '标记发货'], shipping: ['delivered', '标记送达'] };
    const filteredOrders = state.orders.filter((o) => { const kw = (window.__orderFilters && window.__orderFilters.keyword || '').trim(); const st = (window.__orderFilters && window.__orderFilters.status || ''); const matchKw = !kw || ((o.addressSnapshot && o.addressSnapshot.name) || '').includes(kw) || (o.orderNo || '').includes(kw); const matchSt = !st || o.status === st; return matchKw && matchSt; }); paginateRows(filteredOrders, (item, seq) => {
      const action = canOrder('orders.write') && orderActions[item.status];
      const receiptButton = item.paymentMethod === 'offline' && canOrder('receipts.read') ? `<button data-open-receipts="${escapeHtml(item._id)}">查看收款</button>` : '';
      const fulfillmentButton = action ? `<button data-transition-order="${escapeHtml(item._id)}" data-next-status="${action[0]}">${action[1]}</button>` : '';
      return `<tr><td class="col-idx" style="text-align:center">${seq}</td><td><code>${escapeHtml(item.orderNo)}</code></td><td>${escapeHtml((item.addressSnapshot && item.addressSnapshot.name) || '—')}</td><td>${badge(item.status)}</td><td>${formatCents(item.totalAmountCent)}</td><td>${badge(item.paymentStatus)}</td><td>${formatDate(item.createdAt)}</td><td class="col-action">${fulfillmentButton || receiptButton ? `${fulfillmentButton} ${receiptButton}` : '—'}</td></tr>`;
    }, 'ordersTable', 6, 'orders');

    const orderNumbers = new Map((state.orders || []).map((item) => [item._id, item.orderNo || '']));
    // ---- 退款 ----
    paginateRows(state.refunds, (item, seq) =>
      `<tr><td class="col-idx" style="text-align:center">${seq}</td><td><code>${escapeHtml(item.refundNo)}</code></td><td>${escapeHtml(orderNumbers.get(item.orderId) || '打开核对页查看原订单')}</td><td>${formatCents(item.amountCent)}</td><td>${escapeHtml(item.reason || '—')}</td><td>${badge(item.status)}</td><td class="col-action"><button data-review-refund="${escapeHtml(item._id)}">${item.status === 'requested' ? '查看并核对' : '查看详情'}</button></td></tr>`,
      'refundsTable', 6, 'refunds');

    // ---- 拼团 ----
    paginateRows(state.groupCampaigns, (item, seq) =>
      `<tr><td class="col-idx" style="text-align:center">${seq}</td><td>${escapeHtml(item.title)}</td><td>${escapeHtml(skuNames.get(item.skuId) || item.skuId)}</td><td>${escapeHtml(item.groupSize)}</td><td>${formatCents(item.groupPriceCent)}</td><td>${badge(item.status)}</td><td class="col-action"><button data-edit-group-campaign="${item._id}">编辑</button></td></tr>`,
      'groupCampaignsTable', 6, 'groupCampaigns');

    // ---- 轮播图 ----
    paginateRows(state.banners, (item, seq) =>
      `<tr><td class="col-idx" style="text-align:center">${seq}</td><td>${escapeHtml(item.title)}</td><td>${escapeHtml(mediaNames.get(item.mediaAssetId) || '未设置素材')}</td><td>${escapeHtml(jumpLabel(item))}</td><td>${badge(item.enabled ? 'enabled' : 'disabled')}</td><td class="col-action"><button data-edit-banner="${item._id}">编辑</button></td></tr>`,
      'bannersTable', 5, 'banners');

    // ---- 首页模块 ----
    paginateRows(state.sections, (item, seq) => {
      const sectionLabel = ({ news: '活动头条', special: '特价专区', group: '拼团专场' })[item.moduleType] || '活动头条';
      return `<tr><td class="col-idx" style="text-align:center">${seq}</td><td>${escapeHtml(sectionLabel)}</td><td>${escapeHtml(item.title)}</td><td>${escapeHtml(item.subtitle || '—')}</td><td>${escapeHtml(mediaNames.get(item.mediaAssetId) || '未设置素材')}</td><td>${escapeHtml(jumpLabel(item))}</td><td>${badge(item.enabled ? 'enabled' : 'disabled')}</td><td class="col-action"><button data-edit-section="${item._id}">编辑</button></td></tr>`;
    }, 'sectionsTable', 7, 'sections');

    // ---- 素材 ----
    paginateRows(state.media.filter((item) => !global.__mediaKeyword || String(item.name || '').toLowerCase().includes(global.__mediaKeyword)), (item, seq) =>
        `<tr><td class="col-idx" style="text-align:center">${seq}</td><td>${escapeHtml(item.name)}${item.temporary ? ' <span class="badge warn">临时</span>' : ''}</td><td>${translateStatus(item.type)}</td><td>${translateStatus(item.source)}</td><td>${escapeHtml(item.version)}</td><td>${item.fileId ? '已上传' : '缺少文件'}</td><td class="col-action"><button data-preview-media="${escapeHtml(item._id)}">预览</button> <button data-edit-media-metadata="${escapeHtml(item._id)}">改资料</button> <button data-version-media="${escapeHtml(item._id)}">新建版本</button></td></tr>`,
      'mediaTable', 6, 'media');

  }

  global.MengshixianAdminTables = { render };
}(window));
