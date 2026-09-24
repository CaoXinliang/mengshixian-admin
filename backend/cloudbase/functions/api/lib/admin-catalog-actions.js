const { fail } = require('./response');
const { requireContentTarget } = require('./content-targets');
const { randomId } = require('./security');
const { requireProductReady } = require('./catalog-readiness');
const { code: catalogCode, uniqueByCode } = require('./catalog-import');
const { nowIso, string, integer, pageParams } = require('./api-values');

function createAdminCatalogActions({ store, storageUploader, clock, audit, getAdmin, catalogImport, catalogReview }) {
  async function validateMediaReference(value, label, expectedType = '') {
    const mediaId = string(value, label, { max: 80 });
    if (!mediaId) return '';
    const media = await store.findOne('media_assets', { _id: mediaId });
    if (!media) fail('MEDIA_NOT_FOUND', `${label}不存在。`);
    if (media.enabled === false) fail('MEDIA_NOT_AVAILABLE', `${label}已停用，不能继续引用。`);
    if (expectedType && media.type !== expectedType) fail('MEDIA_TYPE_INVALID', `${label}必须是${expectedType === 'image' ? '图片' : expectedType}素材。`);
    return mediaId;
  }

  // SKU 转入在售前以“拟写入状态”参与商品核对页同一套完整核对；catalog-review.read 只触达 findOne/list
  function skuPreviewStore(skuId, patch) {
    const override = (doc) => (doc && doc._id === skuId ? { ...doc, status: 'on_sale', ...patch } : doc);
    return {
      findOne: async (collection, where) => override(await store.findOne(collection, where)),
      list: async (collection, options) => {
        const result = await store.list(collection, options);
        return collection === 'product_skus' ? { ...result, rows: result.rows.map(override) } : result;
      }
    };
  }

  async function requireSkuReviewReady(productId, skuId, patch) {
    const reviewed = await catalogReview.read(productId, skuPreviewStore(skuId, patch));
    if (reviewed.ready) return;
    fail('PRODUCT_NOT_READY', `请先补齐：${reviewed.issues.join('；')}。请到商品核对发布页核对后再上架。`);
  }

  async function adminUpsertCategory(payload) {
    const { admin } = await getAdmin(payload, 'catalog.write');
    const timestamp = nowIso(clock);
    const patch = {
      name: string(payload.name, '分类名称', { required: true, max: 30 }),
      parentId: string(payload.parentId, '父分类 ID', { max: 80 }),
      imageMediaId: await validateMediaReference(payload.imageMediaId, '分类图片 ID', 'image'),
      sort: integer(payload.sort, 0),
      status: ['draft', 'enabled', 'disabled'].includes(payload.status) ? payload.status : 'draft',
      updatedAt: timestamp
    };
    let category;
    if (payload.id) {
      const id = string(payload.id, '分类 ID', { max: 80 });
      const existing = await store.findOne('categories', { _id: id });
      if (!existing) fail('CATEGORY_NOT_FOUND', '分类不存在。');
      await store.update('categories', id, patch);
      category = { ...existing, ...patch, _id: id };
    } else {
      category = await store.create('categories', { ...patch, createdAt: timestamp });
    }
    await audit(admin, 'catalog.category.upsert', 'category', category._id, { name: category.name, status: category.status });
    return category;
  }

  async function adminUpsertProduct(payload) {
    const { admin } = await getAdmin(payload, 'catalog.write');
    const timestamp = nowIso(clock);
    const categoryId = string(payload.categoryId, '分类 ID', { required: true, max: 80 });
    const category = await store.findOne('categories', { _id: categoryId });
    if (!category) fail('CATEGORY_NOT_FOUND', '商品分类不存在。');
    const requestedStatus = payload.status === undefined ? '' : string(payload.status, '商品状态', { max: 30 });
    if (requestedStatus && !['draft', 'pending_review', 'on_sale', 'off_sale', 'archived'].includes(requestedStatus)) fail('VALIDATION_ERROR', '商品状态不合法。');
    if (requestedStatus === 'on_sale') fail('CATALOG_REVIEW_REQUIRED', '请到商品核对页确认发布。');
    // 分层可见性：all 双端 / c 仅个人顾客 / b 仅企业采购；更新时未传则保持原值
    const requestedAudience = ['all', 'c', 'b'].includes(payload.audienceType) ? payload.audienceType : '';
    const patch = {
      spuCode: payload.spuCode ? catalogCode(payload.spuCode, '商品编码') : '',
      name: string(payload.name, '商品名称', { required: true, max: 100 }),
      subtitle: string(payload.subtitle, '商品副标题', { max: 160 }),
      categoryId,
      categoryName: category.name,
      brand: string(payload.brand, '品牌', { max: 60 }),
      origin: string(payload.origin, '产地', { max: 80 }),
      storageType: string(payload.storageType || 'frozen', '储存类型', { max: 30 }),
      frozenTemperature: string(payload.frozenTemperature || '-18℃', '储存温度', { max: 30 }),
      shelfLifeDays: integer(payload.shelfLifeDays, 0),
      description: string(payload.description, '商品介绍', { max: 5000 }),
      coverMediaId: await validateMediaReference(payload.coverMediaId, '商品主图 ID', 'image'),
      sort: integer(payload.sort, 0),
      updatedAt: timestamp
    };
    if (requestedAudience) patch.audienceType = requestedAudience;
    if (requestedStatus) patch.status = requestedStatus;
    let product;
    if (payload.id) {
      const id = string(payload.id, '商品 ID', { max: 80 });
      const existing = await store.findOne('products', { _id: id });
      if (!existing) fail('PRODUCT_NOT_FOUND', '商品不存在。');
      if (payload.spuCode === undefined) patch.spuCode = existing.spuCode || '';
      if (existing.spuCode && patch.spuCode !== existing.spuCode) fail('CATALOG_CODE_IMMUTABLE', '已设置的商品编码不能直接更改。');
      if (patch.spuCode) { const owner = await uniqueByCode(store, 'products', 'spuCode', patch.spuCode); if (owner && owner._id !== id) fail('CATALOG_CODE_DUPLICATE', '商品编码已被其他商品使用。'); }
      if (requestedStatus === 'on_sale') await requireProductReady(store, { ...existing, ...patch, _id: id }, clock());
      await store.update('products', id, patch);
      product = { ...existing, ...patch, _id: id };
    } else {
      if (requestedStatus === 'on_sale') fail('PRODUCT_NOT_READY', '新建商品需要先创建并上架至少一个 SKU。');
      if (patch.spuCode && await uniqueByCode(store, 'products', 'spuCode', patch.spuCode)) fail('CATALOG_CODE_DUPLICATE', '商品编码已被其他商品使用。');
      product = await store.create('products', { ...patch, status: requestedStatus || 'draft', createdAt: timestamp });
    }
    await audit(admin, 'catalog.product.upsert', 'product', product._id, { name: product.name, status: product.status });
    return product;
  }

  async function adminUpsertSku(payload) {
    const { admin } = await getAdmin(payload, 'catalog.write');
    const productId = string(payload.productId, '商品 ID', { required: true, max: 80 });
    const product = await store.findOne('products', { _id: productId });
    if (!product) fail('PRODUCT_NOT_FOUND', '商品不存在。');
    const timestamp = nowIso(clock);
    const patch = {
      productId,
      skuCode: payload.skuCode ? catalogCode(payload.skuCode, '规格编码') : '',
      specName: string(payload.specName, '规格名称', { required: true, max: 100 }),
      netWeight: string(payload.netWeight, '净含量', { max: 40 }),
      weightUnit: string(payload.weightUnit, '重量单位', { max: 20 }),
      piecesPerCase: integer(payload.piecesPerCase, 0),
      packageUnit: string(payload.packageUnit, '包装单位', { max: 100 }),
      barcode: string(payload.barcode, '条码', { max: 60 }),
      mediaIds: Array.isArray(payload.mediaIds) ? payload.mediaIds.slice(0, 12) : [],
      sort: integer(payload.sort, 0),
      status: ['draft', 'on_sale', 'off_sale'].includes(payload.status) ? payload.status : 'draft',
      updatedAt: timestamp
    };
    let sku;
    if (payload.id) {
      const id = string(payload.id, 'SKU ID', { max: 80 });
      const existing = await store.findOne('product_skus', { _id: id });
      if (!existing) fail('SKU_NOT_FOUND', 'SKU 不存在。');
      if (payload.skuCode === undefined) patch.skuCode = existing.skuCode || '';
      if (existing.productId !== productId) fail('SKU_PRODUCT_MISMATCH', '规格不能转到另一商品。');
      if (existing.skuCode && patch.skuCode !== existing.skuCode) fail('CATALOG_CODE_IMMUTABLE', '已设置的规格编码不能直接更改。');
      if (patch.skuCode) { const owner = await uniqueByCode(store, 'product_skus', 'skuCode', patch.skuCode); if (owner && owner._id !== id) fail('CATALOG_CODE_DUPLICATE', '规格编码已被其他规格使用。'); }
      if (patch.status === 'on_sale' && !patch.skuCode) fail('CATALOG_CODE_REQUIRED', '启用销售前必须设置规格编码。');
      if (patch.status === 'on_sale' && existing.status !== 'on_sale') await requireSkuReviewReady(productId, id, patch);
      await store.update('product_skus', id, patch);
      sku = { ...existing, ...patch, _id: id };
    } else {
      if (patch.status === 'on_sale') fail('PRODUCT_NOT_READY', '新规格请先保存草稿、设置价格，再启用销售。');
      if (patch.skuCode && await uniqueByCode(store, 'product_skus', 'skuCode', patch.skuCode)) fail('CATALOG_CODE_DUPLICATE', '规格编码已被其他规格使用。');
      sku = await store.create('product_skus', { ...patch, createdAt: timestamp });
    }
    await audit(admin, 'catalog.sku.upsert', 'product_sku', sku._id, { productId, specName: sku.specName, status: sku.status });
    return sku;
  }

  async function adminSetProductStatus(payload) {
    const { admin } = await getAdmin(payload, 'catalog.write');
    const id = string(payload.id, '商品 ID', { required: true, max: 80 });
    const status = string(payload.status, '商品状态', { required: true, max: 30 });
    if (!['draft', 'pending_review', 'on_sale', 'off_sale', 'archived'].includes(status)) fail('VALIDATION_ERROR', '商品状态不合法。');
    if (status === 'on_sale') fail('CATALOG_REVIEW_REQUIRED', '请到商品核对页逐项核对并确认发布。');
    const product = await store.findOne('products', { _id: id });
    if (!product) fail('PRODUCT_NOT_FOUND', '商品不存在。');
    if (status === 'on_sale') await requireProductReady(store, product, clock());
    await store.update('products', id, { status, updatedAt: nowIso(clock) });
    await audit(admin, 'catalog.product.status', 'product', id, { from: product.status, to: status });
    return { id, status };
  }

  async function adminSetSkuStatus(payload) {
    const { admin } = await getAdmin(payload, 'catalog.write');
    const id = string(payload.id, 'SKU ID', { required: true, max: 80 });
    const status = string(payload.status, 'SKU 状态', { required: true, max: 30 });
    if (!['draft', 'on_sale', 'off_sale'].includes(status)) fail('VALIDATION_ERROR', 'SKU 状态不合法。');
    const sku = await store.findOne('product_skus', { _id: id });
    if (!sku) fail('SKU_NOT_FOUND', 'SKU 不存在。');
    if (status === 'on_sale' && !sku.skuCode) fail('CATALOG_CODE_REQUIRED', '启用销售前必须设置规格编码。');
    if (status === 'on_sale') await requireSkuReviewReady(sku.productId, id, {});
    await store.update('product_skus', id, { status, updatedAt: nowIso(clock) });
    await audit(admin, 'catalog.sku.status', 'product_sku', id, { from: sku.status, to: status, productId: sku.productId });
    return { id, status, productId: sku.productId };
  }

  async function adminUpsertContent(payload, collection, permission, label) {
    const { admin } = await getAdmin(payload, permission);
    const timestamp = nowIso(clock);
    const contentKey = string(payload.contentKey, `${label}业务键`, { max: 100 });
    const jumpType = string(payload.jumpType || 'none', '跳转类型', { max: 30 });
    if (!['none', 'product', 'category', 'url'].includes(jumpType)) fail('JUMP_TYPE_INVALID', '跳转类型只支持 none、product、category、url。');
    const jumpTarget = string(payload.jumpTarget, '跳转目标', { max: 200 });
    if (jumpType !== 'none' && !jumpTarget) fail('JUMP_TARGET_REQUIRED', `${label}跳转目标不能为空。`);
    await requireContentTarget(store, { jumpType, jumpTarget, enabled: payload.enabled !== false });
    const targetPlatforms = Array.isArray(payload.targetPlatforms) ? [...new Set(payload.targetPlatforms.map((item) => string(item, '适用端', { required: true, max: 20 })))].slice(0, 8) : ['miniapp', 'web'];
    if (!targetPlatforms.length || targetPlatforms.some((item) => !['miniapp', 'web'].includes(item))) fail('VALIDATION_ERROR', '内容适用端只支持 miniapp、web，且至少选择一个。');
    const startAt = string(payload.startAt, '开始时间', { max: 40 });
    const endAt = string(payload.endAt, '结束时间', { max: 40 });
    if (startAt && Number.isNaN(new Date(startAt).getTime())) fail('VALIDATION_ERROR', '内容开始时间不合法。');
    if (endAt && Number.isNaN(new Date(endAt).getTime())) fail('VALIDATION_ERROR', '内容结束时间不合法。');
    if (startAt && endAt && new Date(startAt).getTime() > new Date(endAt).getTime()) fail('VALIDATION_ERROR', '内容结束时间不能早于开始时间。');
    const patch = {
      contentKey,
      title: string(payload.title, `${label}标题`, { required: true, max: 100 }),
      subtitle: string(payload.subtitle, `${label}副标题`, { max: 100 }),
      linkText: string(payload.linkText, `${label}链接文字`, { max: 30 }),
      moduleType: collection === 'home_sections' ? string(payload.moduleType || 'news', `${label}模块类型`, { max: 20 }) : '',
      mediaAssetId: await validateMediaReference(payload.mediaAssetId, `${label}素材 ID`),
      jumpType,
      jumpTarget,
      sort: integer(payload.sort, 0),
      enabled: payload.enabled !== false,
      startAt,
      endAt,
      targetPlatforms,
      updatedAt: timestamp
    };
    let item;
    if (payload.id) {
      const id = string(payload.id, `${label} ID`, { max: 80 });
      const existing = await store.findOne(collection, { _id: id });
      if (!existing) fail('CONTENT_NOT_FOUND', `${label}不存在。`);
      if (!contentKey) patch.contentKey = existing.contentKey || '';
      if (contentKey && contentKey !== existing.contentKey) {
        const duplicated = await store.findOne(collection, { contentKey });
        if (duplicated && duplicated._id !== id) fail('CONTENT_KEY_CONFLICT', `${label}业务键已存在，请编辑原记录。`);
      }
      await store.update(collection, id, patch);
      item = { ...existing, ...patch, _id: id };
    } else {
      if (contentKey && await store.findOne(collection, { contentKey })) fail('CONTENT_KEY_CONFLICT', `${label}业务键已存在，请编辑原记录。`);
      item = await store.create(collection, { ...patch, createdAt: timestamp, version: 1 });
    }
    await audit(admin, `${collection}.upsert`, collection, item._id, { title: item.title, enabled: item.enabled });
    return item;
  }

  function mediaPatch(payload, timestamp) {
    const targetPlatforms = Array.isArray(payload.targetPlatforms) ? [...new Set(payload.targetPlatforms.map((item) => string(item, '适用端', { required: true, max: 20 })))].slice(0, 8) : ['miniapp', 'web'];
    if (!targetPlatforms.length || targetPlatforms.some((item) => !['miniapp', 'web'].includes(item))) fail('VALIDATION_ERROR', '素材适用端只支持 miniapp、web，且至少选择一个。');
    const startAt = string(payload.startAt, '素材开始时间', { max: 40 });
    const endAt = string(payload.endAt, '素材结束时间', { max: 40 });
    if (startAt && Number.isNaN(new Date(startAt).getTime())) fail('VALIDATION_ERROR', '素材开始时间不合法。');
    if (endAt && Number.isNaN(new Date(endAt).getTime())) fail('VALIDATION_ERROR', '素材结束时间不合法。');
    if (startAt && endAt && new Date(startAt).getTime() > new Date(endAt).getTime()) fail('VALIDATION_ERROR', '素材结束时间不能早于开始时间。');
    return {
      name: string(payload.name, '素材名称', { required: true, max: 100 }),
      assetKey: string(payload.assetKey, '素材业务键', { max: 100 }),
      type: ['image', 'video'].includes(payload.type) ? payload.type : 'image',
      fileId: string(payload.fileId, '云存储文件 ID', { required: true, max: 300 }),
      thumbnailFileId: string(payload.thumbnailFileId, '缩略图文件 ID', { max: 300 }),
      coverFileId: string(payload.coverFileId, '视频封面文件 ID', { max: 300 }),
      source: ['client', 'ai_generated', 'demo', 'admin_upload'].includes(payload.source) ? payload.source : 'admin_upload',
      temporary: payload.temporary === true,
      checksum: string(payload.checksum, '素材校验值', { max: 128 }),
      mimeType: string(payload.mimeType, '素材类型', { max: 80 }),
      sizeBytes: integer(payload.sizeBytes, 0),
      enabled: payload.enabled !== false,
      startAt,
      endAt,
      targetPlatforms,
      updatedAt: timestamp
    };
  }

  async function adminUpsertMedia(payload) {
    const { admin } = await getAdmin(payload, 'media.write');
    const timestamp = nowIso(clock);
    const patch = mediaPatch(payload, timestamp);
    let asset;
    if (payload.id) {
      const id = string(payload.id, '素材 ID', { max: 80 });
      const existing = await store.findOne('media_assets', { _id: id });
      if (!existing) fail('MEDIA_NOT_FOUND', '素材不存在。');
      if (existing.fileId !== patch.fileId) fail('MEDIA_VERSION_REQUIRED', '素材文件不可覆盖，请使用“新建版本”保留历史素材。');
      await store.update('media_assets', id, patch);
      asset = { ...existing, ...patch, _id: id, version: integer(existing.version, 1) };
    } else {
      asset = await store.create('media_assets', { ...patch, version: 1, createdBy: admin._id, createdAt: timestamp });
    }
    await audit(admin, 'media.upsert', 'media_asset', asset._id, { name: asset.name, temporary: asset.temporary, source: asset.source });
    return asset;
  }

  async function adminCreateMediaVersion(payload) {
    const { admin } = await getAdmin(payload, 'media.write');
    const replacesMediaAssetId = string(payload.replacesMediaAssetId, '被替换素材 ID', { required: true, max: 80 });
    const existing = await store.findOne('media_assets', { _id: replacesMediaAssetId });
    if (!existing) fail('MEDIA_NOT_FOUND', '被替换素材不存在。');
    const timestamp = nowIso(clock);
    const patch = mediaPatch(payload, timestamp);
    if (existing.fileId === patch.fileId) fail('MEDIA_VERSION_SAME_FILE', '新版本必须使用不同的云存储文件。');
    const asset = await store.create('media_assets', {
      ...patch,
      version: integer(existing.version, 1) + 1,
      previousMediaAssetId: existing._id,
      createdBy: admin._id,
      createdAt: timestamp
    });
    await audit(admin, 'media.create_version', 'media_asset', asset._id, { previousMediaAssetId: existing._id, name: asset.name, temporary: asset.temporary, source: asset.source });
    return asset;
  }

  async function adminListProductMedia(payload) {
    await getAdmin(payload, 'catalog.read');
    const productId = string(payload.productId, '商品 ID', { max: 80 });
    const where = productId ? { productId } : {};
    return store.list('product_media', {
      where,
      orderBy: [{ field: 'sort', direction: 'asc' }, { field: 'updatedAt', direction: 'desc' }],
      ...pageParams(payload)
    });
  }

  async function adminUpsertProductMedia(payload) {
    const { admin } = await getAdmin(payload, 'catalog.write');
    const productId = string(payload.productId, '商品 ID', { required: true, max: 80 });
    const product = await store.findOne('products', { _id: productId });
    if (!product) fail('PRODUCT_NOT_FOUND', '关联商品不存在。');
    const skuId = string(payload.skuId, 'SKU ID', { max: 80 });
    if (skuId) {
      const sku = await store.findOne('product_skus', { _id: skuId });
      if (!sku) fail('SKU_NOT_FOUND', '关联 SKU 不存在。');
      if (sku.productId !== productId) fail('SKU_PRODUCT_MISMATCH', 'SKU 不属于当前商品。');
    }
    const mediaType = ['image', 'video'].includes(payload.mediaType) ? payload.mediaType : '';
    if (!mediaType) fail('VALIDATION_ERROR', '商品媒体类型必须是 image 或 video。');
    const mediaAssetId = await validateMediaReference(payload.mediaAssetId, '商品媒体素材 ID', mediaType);
    const role = ['cover', 'detail', 'sku_image', 'video_cover', 'instruction'].includes(payload.role) ? payload.role : 'detail';
    if (role === 'sku_image' && (!skuId || mediaType !== 'image')) fail('MEDIA_ROLE_INVALID', '规格图必须是图片并选择销售规格。');
    if (role === 'video_cover' && mediaType !== 'image') fail('MEDIA_ROLE_INVALID', '视频封面必须是图片。');
    const timestamp = nowIso(clock);
    const patch = {
      productId,
      skuId,
      mediaAssetId,
      mediaType,
      role,
      sort: integer(payload.sort, 0),
      enabled: payload.enabled !== false,
      updatedAt: timestamp
    };
    let association;
    if (payload.id) {
      const id = string(payload.id, '商品媒体关联 ID', { max: 80 });
      const existing = await store.findOne('product_media', { _id: id });
      if (!existing) fail('PRODUCT_MEDIA_NOT_FOUND', '商品媒体关联不存在。');
      await store.update('product_media', id, patch);
      association = { ...existing, ...patch, _id: id };
    } else {
      const existing = await store.findOne('product_media', { productId, skuId, mediaAssetId, mediaType, role });
      if (existing) {
        await store.update('product_media', existing._id, patch);
        association = { ...existing, ...patch, _id: existing._id };
      } else {
        association = await store.create('product_media', { ...patch, createdBy: admin._id, createdAt: timestamp });
      }
    }
    await audit(admin, 'catalog.product_media.upsert', 'product_media', association._id, { productId, skuId, mediaAssetId, mediaType, role, enabled: association.enabled });
    return association;
  }

  async function adminUploadMedia(payload) {
    const { admin } = await getAdmin(payload, 'media.write');
    if (typeof storageUploader !== 'function') fail('MEDIA_UPLOAD_UNAVAILABLE', '后台上传服务尚未配置。');
    const type = ['image', 'video'].includes(payload.type) ? payload.type : 'image';
    const mimeType = string(payload.mimeType, '素材类型', { required: true, max: 80 }).toLowerCase();
    const allowedMimeTypes = type === 'image'
      ? ['image/jpeg', 'image/png', 'image/webp']
      : ['video/mp4', 'video/webm', 'video/quicktime'];
    if (!allowedMimeTypes.includes(mimeType)) fail('MEDIA_MIME_INVALID', '素材格式不受支持。');
    const fileName = string(payload.fileName, '文件名', { required: true, max: 160 });
    const contentBase64 = string(payload.contentBase64, '文件内容', { required: true, max: 7000000 }).replace(/^data:[^;]+;base64,/, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(contentBase64)) fail('MEDIA_CONTENT_INVALID', '文件内容不是有效的 Base64。');
    // 大小以解码后的真实字节数为准，不信任客户端声明的 sizeBytes
    const sizeBytes = Buffer.byteLength(contentBase64, 'base64');
    const declaredSizeBytes = integer(payload.sizeBytes, 0);
    if (declaredSizeBytes && Math.abs(declaredSizeBytes - sizeBytes) > 1024) fail('MEDIA_SIZE_INVALID', '声明的文件大小与实际内容不一致。');
    if (!sizeBytes || sizeBytes > 4 * 1024 * 1024) fail('MEDIA_SIZE_INVALID', '直传素材不能超过 4 MB；较大视频请使用后台分段上传。');
    const extension = ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov' })[mimeType];
    const safeBaseName = fileName.replace(/[^0-9A-Za-z_\-.\u4e00-\u9fff]/g, '_').replace(/\.[^.]+$/, '') || 'media';
    const cloudPath = `mengshixian/media/uploads/${new Date(nowIso(clock)).toISOString().slice(0, 10)}/${randomId()}-${safeBaseName}${extension}`;
    const fileId = await storageUploader({ cloudPath, contentBase64, mimeType, sizeBytes });
    if (!fileId) fail('MEDIA_UPLOAD_FAILED', '素材上传未返回文件 ID。');
    await audit(admin, 'media.upload', 'media_asset_file', fileId, { type, mimeType, sizeBytes, cloudPath });
    return { fileId, cloudPath, mimeType, sizeBytes };
  }

  async function stageImport(payload) {
    const { admin } = await getAdmin(payload, 'imports.write');
    return catalogImport.stage(admin, payload);
  }

  async function approveImportRecord(admin, id) {
    return catalogImport.approve(admin, id);
  }

  async function approveImport(payload) {
    const { admin } = await getAdmin(payload, 'imports.write');
    const id = string(payload.id, '导入草稿 ID', { required: true, max: 80 });
    return approveImportRecord(admin, id);
  }

  async function activateImportBatch(payload) {
    await getAdmin(payload, 'imports.write');
    fail('IMPORT_REVIEW_REQUIRED', '批量上架入口已停用；请到商品核对页逐个确认发布。');
  }

  async function previewImport(payload) {
    await getAdmin(payload, 'imports.read');
    return catalogImport.preview(payload.rows);
  }

  async function linkMediaByCode(payload) {
    await getAdmin(payload, 'catalog.write');
    const productCode = catalogCode(payload.productCode, '商品编码');
    const product = await uniqueByCode(store, 'products', 'spuCode', productCode);
    if (!product) fail('PRODUCT_NOT_FOUND', '找不到该商品编码，请先生成商品草稿。');
    let sku = null;
    if (payload.skuCode) {
      sku = await uniqueByCode(store, 'product_skus', 'skuCode', catalogCode(payload.skuCode, '规格编码'));
      if (!sku || sku.productId !== product._id) fail('SKU_PRODUCT_MISMATCH', '规格编码不属于该商品编码。');
    }
    const mediaAssetId = string(payload.mediaAssetId, '素材库记录', { required: true, max: 80 });
    const asset = await store.findOne('media_assets', { _id: mediaAssetId });
    if (!asset || asset.enabled === false) fail('MEDIA_NOT_AVAILABLE', '素材库记录不存在或已停用。');
    if (payload.role === 'cover' && (sku || asset.type !== 'image')) fail('MEDIA_TYPE_INVALID', '商品主图只能关联到商品编码，且必须是图片。');
    const result = await adminUpsertProductMedia({ ...payload, productId: product._id, skuId: sku ? sku._id : '', mediaType: asset.type, mediaAssetId });
    if (payload.role === 'cover' && !sku) await store.update('products', product._id, { coverMediaId: asset._id, updatedAt: nowIso(clock) });
    return { ...result, productCode, skuCode: sku ? sku.skuCode : '', coverUpdated: payload.role === 'cover' };
  }

  return { validateMediaReference, adminUpsertCategory, adminUpsertProduct, adminUpsertSku, adminSetProductStatus, adminSetSkuStatus, adminUpsertContent, adminUpsertMedia, adminCreateMediaVersion, adminListProductMedia, adminUpsertProductMedia, adminUploadMedia, stageImport, approveImport, activateImportBatch, previewImport, linkMediaByCode };
}
module.exports = { createAdminCatalogActions };
