const { fail } = require('./response');
const { decryptText, sha256 } = require('./security');
const { inventoryId, inventoryLedgerId } = require('./transaction-ids');
const { hasPermission } = require('./permissions');
const { cents, expireReservations, expireGroups, orderReservations, releaseReservation } = require('./commerce');
const { assertTransition } = require('./order-state');
const { releaseSlot } = require('./groups');
const { collectPageMatches } = require('./collection-read');
const { customerLabel } = require('./pricing-targets');
const { nowIso, string, integer, demoMetadata, pageParams, pick, safeOrder, safeUser } = require('./api-values');

function createAdminOperationsActions({ store, piiEncryptionKey, demoMode, clock, audit, getAdmin, validateMediaReference, pricingTargets, mediaUrlResolver }) {
  function businessReviewToken(application) {
    const fields = ['_id', 'status', 'userId', 'companyName', 'storeName', 'storeAddress', 'mainBusinessType', 'unifiedCode',
      'storefrontMediaId', 'businessLicenseMediaId', 'contactName', 'contactPhoneCiphertext', 'salesCode', 'chainEnabled', 'submittedAt', 'updatedAt'];
    return sha256(JSON.stringify(fields.map((field) => application[field] ?? null)));
  }

  async function adminUpsertPrice(payload) {
    const { admin } = await getAdmin(payload, 'pricing.write');
    const skuId = string(payload.skuId, 'SKU ID', { required: true, max: 80 });
    const sku = await store.findOne('product_skus', { _id: skuId });
    if (!sku) fail('SKU_NOT_FOUND', 'SKU 不存在。');
    const scopeType = string(payload.scopeType || 'public', '价格适用范围', { max: 30 });
    if (!['public', 'customer_type', 'level', 'organization', 'user'].includes(scopeType)) fail('VALIDATION_ERROR', '价格适用范围不合法。');
    const scopeId = string(payload.scopeId, '价格适用对象 ID', { max: 100 });
    if (scopeType !== 'public' && !scopeId) fail('VALIDATION_ERROR', '定向价格必须指定适用对象。');
    await pricingTargets.validate(scopeType, scopeId);
    const timestamp = nowIso(clock);
    const patch = {
      skuId, scopeType, scopeId, channel: ['all', 'miniapp', 'web'].includes(payload.channel) ? payload.channel : 'all',
      amountCent: cents(payload.amountCent === undefined ? payload.price : payload.amountCent, '商品价格'), currency: 'CNY',
      priority: integer(payload.priority, 0), validFrom: string(payload.validFrom, '生效开始时间', { max: 40 }), validTo: string(payload.validTo, '生效结束时间', { max: 40 }),
      status: ['draft', 'active', 'disabled'].includes(payload.status) ? payload.status : 'draft', ...demoMetadata(payload), updatedAt: timestamp
    };
    if (patch.validFrom && Number.isNaN(new Date(patch.validFrom).getTime())) fail('VALIDATION_ERROR', '生效开始时间不合法。');
    if (patch.validTo && Number.isNaN(new Date(patch.validTo).getTime())) fail('VALIDATION_ERROR', '生效结束时间不合法。');
    if (patch.validFrom && patch.validTo && new Date(patch.validFrom).getTime() > new Date(patch.validTo).getTime()) fail('VALIDATION_ERROR', '生效结束时间不能早于开始时间。');
    let rule;
    if (payload.id) {
      const id = string(payload.id, '价格规则 ID', { max: 80 });
      const existing = await store.findOne('prices', { _id: id });
      if (!existing) fail('PRICE_RULE_NOT_FOUND', '价格规则不存在。');
      await store.update('prices', id, patch);
      rule = { ...existing, ...patch, _id: id };
    } else {
      rule = await store.create('prices', { ...patch, createdBy: admin._id, createdAt: timestamp });
    }
    await audit(admin, 'pricing.upsert', 'price', rule._id, { skuId, scopeType, scopeId, amountCent: rule.amountCent, status: rule.status });
    return rule;
  }

  async function adminSeedDemoCommerce(payload) {
    const { admin, permissions } = await getAdmin(payload, 'catalog.write');
    if (!demoMode || !hasPermission(permissions, '*')) fail('DEMO_SEED_FORBIDDEN', '演示批量初始化仅允许测试环境的超级管理员执行。');
    const warehouseId = string(payload.warehouseId, '仓库 ID', { required: true, max: 80 });
    const sourceFile = string(payload.sourceFile, '演示来源文件', { required: true, max: 120 });
    const entries = Array.isArray(payload.entries) ? payload.entries.slice(0, 50) : [];
    if (!entries.length) fail('VALIDATION_ERROR', '演示初始化至少需要一条商品数据。');
    const warehouse = await store.findOne('warehouses', { _id: warehouseId, status: 'active' });
    if (!warehouse) fail('WAREHOUSE_NOT_AVAILABLE', '演示仓库不可用。');
    const jobs = await collectPageMatches(store, 'import_jobs', { where: { sourceFile, status: 'imported' } }, () => true);
    const jobBySourceId = new Map(jobs.map((job) => [String(job.sourceKey || '').split(':').pop(), job]));
    const metadata = demoMetadata(payload);
    const output = [];
    for (const entry of entries) {
      const sourceId = string(entry.sourceId, '演示商品来源 ID', { required: true, max: 80 });
      const job = jobBySourceId.get(sourceId);
      if (!job || !job.skuId) fail('DEMO_PRODUCT_NOT_IMPORTED', `演示商品 ${sourceId} 尚未导入。`);
      const timestamp = nowIso(clock);
      const variants = Array.isArray(entry.skus) && entry.skus.length ? entry.skus.slice(0, 6) : [{ key: 'retail', specName: '标准装', packageUnit: '1份', amountCent: entry.amountCent, initialStock: entry.initialStock, sort: 0 }];
      for (let variantIndex = 0; variantIndex < variants.length; variantIndex += 1) {
        const variant = variants[variantIndex] || {};
        const variantKey = string(variant.key || `option-${variantIndex + 1}`, '规格键', { required: true, max: 30 }).replace(/[^a-zA-Z0-9_-]/g, '-');
        const skuId = variantIndex === 0 ? job.skuId : `demo-sku-${sourceId}-${variantKey}`;
        const amountCent = cents(variant.amountCent === undefined ? entry.amountCent : variant.amountCent, '商品价格');
        const stock = integer(variant.initialStock === undefined ? entry.initialStock : variant.initialStock, 0);
        if (stock <= 0) fail('VALIDATION_ERROR', '初始库存必须大于 0。');
        const existingSku = await store.getById('product_skus', skuId);
        const skuPatch = {
          productId: job.productId,
          skuCode: `MSX-${sourceId}-${variantKey}`.toUpperCase(),
          specName: string(variant.specName, '规格名称', { required: true, max: 100 }),
          netWeight: string(variant.netWeight, '净含量', { max: 40 }),
          weightUnit: string(variant.weightUnit, '重量单位', { max: 20 }),
          piecesPerCase: integer(variant.piecesPerCase, 0),
          packageUnit: string(variant.packageUnit, '包装单位', { required: true, max: 100 }),
          barcode: '', mediaIds: [], sort: integer(variant.sort, variantIndex * 10), status: 'on_sale', sourceImportId: job._id,
          ...metadata, updatedAt: timestamp, createdAt: existingSku && existingSku.createdAt || timestamp
        };
        if (existingSku) await store.update('product_skus', skuId, skuPatch);
        else await store.set('product_skus', skuId, skuPatch);

        const existingPrice = await store.findOne('prices', { skuId, scopeType: 'public', scopeId: '', channel: 'miniapp' });
        const pricePatch = { skuId, scopeType: 'public', scopeId: '', channel: 'miniapp', amountCent, currency: 'CNY', priority: 0, validFrom: '', validTo: '', status: 'active', ...metadata, updatedAt: timestamp };
        if (existingPrice) await store.update('prices', existingPrice._id, pricePatch);
        else await store.create('prices', { ...pricePatch, createdBy: admin._id, createdAt: timestamp });

        // Deterministic IDs keep repeated test-data provisioning idempotent.
        // Customer reservations and later stock changes still use transactions.
        const inventoryDocumentId = inventoryId(warehouseId, skuId);
        const seedKey = variantIndex === 0 ? `demo-stock-${sourceId}` : `demo-stock-${sourceId}-${variantKey}`;
        const ledgerDocumentId = inventoryLedgerId('demo_initial_stock', seedKey, skuId);
        const existingLedger = await store.getById('inventory_ledger', ledgerDocumentId);
        let inventory;
        if (existingLedger) inventory = await store.getById('inventory', inventoryDocumentId);
        else {
          const previous = await store.getById('inventory', inventoryDocumentId);
          const onHand = Number(previous && previous.onHand || 0);
          const reserved = Number(previous && previous.reserved || 0);
          const saved = { warehouseId, skuId, onHand: onHand + stock, reserved, available: onHand + stock - reserved, version: Number(previous && previous.version || 0) + 1, ...metadata, updatedAt: timestamp, createdAt: previous && previous.createdAt || timestamp };
          inventory = await store.set('inventory', inventoryDocumentId, saved);
          await store.set('inventory_ledger', ledgerDocumentId, { warehouseId, skuId, change: stock, reservedChange: 0, before: onHand - reserved, after: saved.available, reason: 'demo_initial_stock', referenceType: 'demo_seed', referenceId: sourceFile, operatorId: admin._id, idempotencyKey: seedKey, ...metadata, createdAt: timestamp });
        }
        let stockNormalized = false;
        if (payload.normalizeStock === true && inventory && Number(inventory.reserved || 0) === 0 && Number(inventory.onHand || 0) !== stock) {
          const before = Number(inventory.onHand || 0) - Number(inventory.reserved || 0);
          inventory = await store.set('inventory', inventoryDocumentId, { ...inventory, onHand: stock, available: stock, version: Number(inventory.version || 0) + 1, ...metadata, updatedAt: timestamp });
          const normalizeKey = `demo-stock-normalize-${sourceId}-${variantKey}`;
          await store.set('inventory_ledger', inventoryLedgerId('demo_stock_normalize', normalizeKey, skuId), { warehouseId, skuId, change: stock - before, reservedChange: 0, before, after: stock, reason: 'demo_stock_normalize', referenceType: 'demo_seed', referenceId: sourceFile, operatorId: admin._id, idempotencyKey: normalizeKey, ...metadata, createdAt: timestamp });
          stockNormalized = true;
        }
        output.push({ sourceId, skuId, specName: skuPatch.specName, priceUpdated: true, inventoryId: inventory && inventory._id || inventoryDocumentId, stockNormalized });
      }
    }
    await audit(admin, 'demo.commerce.seed', 'import_job', '', { sourceFile, productCount: entries.length, skuCount: output.length, warehouseId });
    return { seededProducts: entries.length, seededSkus: output.length, rows: output };
  }

  async function adminUpsertGroupCampaign(payload) {
    const { admin } = await getAdmin(payload, 'marketing.write');
    const skuId = string(payload.skuId, '活动 SKU ID', { required: true, max: 80 });
    const sku = await store.findOne('product_skus', { _id: skuId });
    if (!sku) fail('SKU_NOT_FOUND', '活动 SKU 不存在。');
    const timestamp = nowIso(clock);
    const patch = { title: string(payload.title, '活动标题', { required: true, max: 100 }), skuId, groupSize: integer(payload.groupSize, 0), durationMinutes: integer(payload.durationMinutes, 0), groupPriceCent: cents(payload.groupPriceCent === undefined ? payload.groupPrice : payload.groupPriceCent, '拼团价格'), coverMediaId: await validateMediaReference(payload.coverMediaId, '活动封面素材 ID', 'image'), targetUserType: ['all', 'b', 'c'].includes(payload.targetUserType) ? payload.targetUserType : 'all', startAt: string(payload.startAt, '开始时间', { max: 40 }), endAt: string(payload.endAt, '结束时间', { max: 40 }), sort: integer(payload.sort, 0), status: ['draft', 'active', 'disabled'].includes(payload.status) ? payload.status : 'draft', updatedAt: timestamp };
    if (patch.groupSize < 2 || patch.groupSize > 12) fail('VALIDATION_ERROR', '拼团人数必须在 2 到 12 人之间。');
    if (patch.durationMinutes < 5 || patch.durationMinutes > 10080) fail('VALIDATION_ERROR', '拼团有效期必须在 5 分钟到 7 天之间。');
    if (patch.startAt && Number.isNaN(new Date(patch.startAt).getTime())) fail('VALIDATION_ERROR', '活动开始时间不合法。');
    if (patch.endAt && Number.isNaN(new Date(patch.endAt).getTime())) fail('VALIDATION_ERROR', '活动结束时间不合法。');
    let campaign;
    if (payload.id) {
      const id = string(payload.id, '拼团活动 ID', { max: 80 });
      const existing = await store.findOne('group_campaigns', { _id: id });
      if (!existing) fail('GROUP_CAMPAIGN_NOT_FOUND', '拼团活动不存在。');
      await store.update('group_campaigns', id, patch);
      campaign = { ...existing, ...patch, _id: id };
    } else campaign = await store.create('group_campaigns', { ...patch, createdBy: admin._id, createdAt: timestamp });
    await audit(admin, 'marketing.group_campaign.upsert', 'group_campaign', campaign._id, { skuId, groupSize: campaign.groupSize, status: campaign.status });
    return campaign;
  }

  async function adminUsers(payload) {
    await getAdmin(payload, 'users.read');
    const listed = await store.list('users', { orderBy: [{ field: 'updatedAt', direction: 'desc' }], ...pageParams(payload) });
    return { ...listed, rows: listed.rows.map((user) => ({ ...safeUser(user), displayName: customerLabel(user) })) };
  }

  async function adminSetUserPricingProfile(payload) {
    const { admin } = await getAdmin(payload, 'users.write');
    const id = string(payload.id, '用户 ID', { required: true, max: 80 });
    const user = await store.findOne('users', { _id: id });
    if (!user) fail('USER_NOT_FOUND', '用户不存在。');
    const userType = string(payload.userType || user.userType || 'c', '用户类型', { max: 10 });
    if (!['b', 'c'].includes(userType)) fail('VALIDATION_ERROR', '用户类型仅支持 B 或 C。');
    const organizationId = string(payload.organizationId === undefined ? user.organizationId : payload.organizationId, '企业 ID', { max: 80 });
    if (userType === 'b' && !organizationId) fail('VALIDATION_ERROR', 'B 端用户必须归属企业。');
    if (organizationId && !await store.findOne('customer_organizations', { _id: organizationId, status: 'active' })) fail('ORGANIZATION_NOT_FOUND', '企业不存在或未启用。');
    const patch = { userType, organizationId, priceLevel: string(payload.priceLevel, '价格等级', { max: 40 }), businessStatus: userType === 'b' ? 'approved' : 'none', updatedAt: nowIso(clock) };
    await store.update('users', id, patch);
    await audit(admin, 'users.pricing_profile.set', 'user', id, { userType, organizationId, priceLevel: patch.priceLevel });
    return { user: safeUser({ ...user, ...patch }) };
  }

  async function adminReviewBusinessApplication(payload) {
    const { admin } = await getAdmin(payload, 'organizations.write');
    const id = string(payload.id, '企业申请 ID', { required: true, max: 80 });
    const decision = string(payload.decision, '审核结论', { required: true, max: 20 });
    if (!['approved', 'rejected'].includes(decision)) fail('VALIDATION_ERROR', '审核结论不合法。');
    const reviewToken = string(payload.reviewToken, '申请核对凭据', { required: true, max: 128 });
    if (typeof store.runTransaction !== 'function') fail('TRANSACTION_NOT_AVAILABLE', '当前环境不能安全审核企业申请。');
    const application = await store.findOne('business_applications', { _id: id });
    if (!application) fail('BUSINESS_APPLICATION_NOT_FOUND', '企业申请不存在。');
    const knownOrganization = decision === 'approved' ? await store.findOne('customer_organizations', { unifiedCode: application.unifiedCode }) : null;
    const reviewNote = string(payload.reviewNote, '审核备注', { max: 300 });
    const priceLevel = string(payload.priceLevel, '价格等级', { max: 40 });
    return store.runTransaction(async (tx) => {
      const current = await tx.getById('business_applications', id);
      if (!current) fail('BUSINESS_APPLICATION_NOT_FOUND', '企业申请不存在。');
      if (current.status !== 'pending') fail('BUSINESS_APPLICATION_REVIEWED', '该企业申请已处理，不能重复审核。');
      if (current.unifiedCode !== application.unifiedCode || reviewToken !== businessReviewToken(current)) fail('BUSINESS_APPLICATION_CHANGED', '企业申请资料已变化，请刷新后重新核对。');
      if (!await tx.getById('users', current.userId)) fail('USER_NOT_FOUND', '申请人不存在，不能完成审核。');
      const timestamp = nowIso(clock);
      if (decision === 'rejected') {
        await tx.update('business_applications', id, { status: 'rejected', reviewedBy: admin._id, reviewedAt: timestamp, reviewNote, updatedAt: timestamp });
        await tx.update('users', current.userId, { businessStatus: 'rejected', updatedAt: timestamp });
        await audit(admin, 'organizations.application.reject', 'business_application', id, { userId: current.userId, reviewNote }, tx);
        return { id, status: 'rejected' };
      }
      const organizationId = knownOrganization?._id || `organization-${sha256(current.unifiedCode).slice(0, 32)}`;
      let organization = await tx.getById('customer_organizations', organizationId);
      if (organization && organization.unifiedCode !== current.unifiedCode) fail('ORGANIZATION_CONFLICT', '企业资料不一致，请刷新后重新核对。');
      if (!organization) organization = await tx.set('customer_organizations', organizationId, { name: current.companyName, unifiedCode: current.unifiedCode, status: 'active', createdAt: timestamp, updatedAt: timestamp, approvedBy: admin._id });
      else if (organization.status !== 'active') {
        await tx.update('customer_organizations', organizationId, { status: 'active', updatedAt: timestamp });
        organization = { ...organization, status: 'active' };
      }
      await tx.update('users', current.userId, { userType: 'b', organizationId, priceLevel, businessStatus: 'approved', updatedAt: timestamp });
      await tx.update('business_applications', id, { status: 'approved', organizationId, reviewedBy: admin._id, reviewedAt: timestamp, reviewNote, updatedAt: timestamp });
      await audit(admin, 'organizations.application.approve', 'business_application', id, { userId: current.userId, organizationId, priceLevel }, tx);
      return { id, status: 'approved', organization: pick(organization, ['_id', 'name', 'unifiedCode', 'status']) };
    });
  }

  async function adminBusinessApplications(payload) {
    await getAdmin(payload, 'organizations.read');
    const listed = await store.list('business_applications', { orderBy: [{ field: 'submittedAt', direction: 'desc' }], ...pageParams(payload) });
    return { ...listed, rows: listed.rows.map((item) => ({ ...pick(item, ['_id', 'userId', 'companyName', 'storeName', 'storeAddress', 'mainBusinessType', 'unifiedCode', 'contactName', 'contactPhoneMasked', 'status', 'submittedAt', 'reviewedBy', 'reviewedAt', 'reviewNote', 'organizationId']), reviewToken: businessReviewToken(item) })) };
  }

  async function adminBusinessApplicationReviewDetail(payload) {
    await getAdmin(payload, 'organizations.read');
    const id = string(payload.id, '企业申请 ID', { required: true, max: 80 });
    const application = await store.findOne('business_applications', { _id: id });
    if (!application) fail('BUSINESS_APPLICATION_NOT_FOUND', '企业申请不存在。');
    const fileIds = [application.storefrontMediaId, application.businessLicenseMediaId].filter(Boolean);
    const urls = fileIds.length && typeof mediaUrlResolver === 'function' ? await mediaUrlResolver([...new Set(fileIds)]) : {};
    return {
      ...pick(application, ['_id', 'companyName', 'storeName', 'storeAddress', 'mainBusinessType', 'unifiedCode', 'contactName', 'contactPhoneMasked', 'status', 'submittedAt']),
      reviewToken: businessReviewToken(application),
      storefrontPreviewUrl: urls && urls[application.storefrontMediaId] || '',
      licensePreviewUrl: urls && urls[application.businessLicenseMediaId] || ''
    };
  }

  async function adminUpsertWarehouse(payload) {
    const { admin } = await getAdmin(payload, '*');
    const timestamp = nowIso(clock);
    const patch = { code: string(payload.code, '仓库编码', { required: true, max: 40 }), name: string(payload.name, '仓库名称', { required: true, max: 80 }), address: string(payload.address, '仓库地址', { max: 200 }), status: ['active', 'disabled'].includes(payload.status) ? payload.status : 'active', sort: integer(payload.sort, 0), ...demoMetadata(payload), updatedAt: timestamp };
    let warehouse;
    if (payload.id) {
      const id = string(payload.id, '仓库 ID', { max: 80 });
      const existing = await store.findOne('warehouses', { _id: id });
      if (!existing) fail('WAREHOUSE_NOT_FOUND', '仓库不存在。');
      await store.update('warehouses', id, patch);
      warehouse = { ...existing, ...patch, _id: id };
    } else warehouse = await store.create('warehouses', { ...patch, createdAt: timestamp });
    await audit(admin, 'inventory.warehouse.upsert', 'warehouse', warehouse._id, { code: warehouse.code, status: warehouse.status });
    return warehouse;
  }

  async function adminAdjustInventory(payload) {
    const { admin } = await getAdmin(payload, 'inventory.write');
    const warehouseId = string(payload.warehouseId, '仓库 ID', { required: true, max: 80 });
    const skuId = string(payload.skuId, 'SKU ID', { required: true, max: 80 });
    const change = integer(payload.change, 0);
    const idempotencyKey = string(payload.idempotencyKey, '库存调整幂等键', { required: true, max: 120 });
    if (!change || Math.abs(change) > 1000000) fail('VALIDATION_ERROR', '库存调整数量不合法。');
    if (typeof store.runTransaction !== 'function') fail('TRANSACTION_NOT_AVAILABLE', '当前环境不支持库存事务。');
    const inventoryDocumentId = inventoryId(warehouseId, skuId);
    const ledgerDocumentId = inventoryLedgerId('manual_adjust', idempotencyKey, skuId);
    const adjustmentReason = string(payload.reason || 'manual_adjust', '调整原因', { max: 80 });
    const result = await store.runTransaction(async (tx) => {
      const existingLedger = await tx.getById('inventory_ledger', ledgerDocumentId);
      if (existingLedger) {
        if (existingLedger.warehouseId !== warehouseId || existingLedger.skuId !== skuId || existingLedger.change !== change
          || existingLedger.reason !== adjustmentReason || existingLedger.operatorId !== admin._id || existingLedger.idempotencyKey !== idempotencyKey) {
          fail('IDEMPOTENCY_CONFLICT', '这次库存调整与已提交的记录不一致，请刷新库存后再核对。');
        }
        const existingInventory = await tx.getById('inventory', inventoryDocumentId);
        return { inventory: existingInventory, idempotent: true };
      }
      const [warehouse, sku] = await Promise.all([tx.getById('warehouses', warehouseId), tx.getById('product_skus', skuId)]);
      if (!warehouse || warehouse.status !== 'active') fail('WAREHOUSE_NOT_AVAILABLE', '仓库不存在或不可用。');
      if (!sku) fail('SKU_NOT_FOUND', 'SKU 不存在。');
      const timestamp = nowIso(clock);
      const inventory = await tx.getById('inventory', inventoryDocumentId);
      const onHand = Number(inventory && inventory.onHand || 0);
      const reserved = Number(inventory && inventory.reserved || 0);
      if (onHand + change < reserved) fail('INVENTORY_BELOW_RESERVED', '调整后库存不能低于已预占库存。');
      const patch = { warehouseId, skuId, onHand: onHand + change, reserved, available: onHand + change - reserved, version: Number(inventory && inventory.version || 0) + 1, ...demoMetadata(payload), updatedAt: timestamp };
      const saved = await tx.set('inventory', inventoryDocumentId, { ...patch, createdAt: inventory && inventory.createdAt || timestamp });
      await tx.set('inventory_ledger', ledgerDocumentId, { warehouseId, skuId, change, reservedChange: 0, before: onHand - reserved, after: patch.available, reason: adjustmentReason, referenceType: 'manual', referenceId: idempotencyKey, operatorId: admin._id, idempotencyKey, createdAt: timestamp });
      return { inventory: saved, idempotent: false };
    });
    if (!result.idempotent) await audit(admin, 'inventory.adjust', 'inventory', result.inventory._id, { warehouseId, skuId, change, available: result.inventory.available });
    return result;
  }

  async function adminUpsertDeliveryArea(payload) {
    const { admin } = await getAdmin(payload, 'delivery.write');
    const regionCodes = Array.isArray(payload.regionCodes) ? [...new Set(payload.regionCodes.map((item) => string(item, '配送区域编码', { required: true, max: 80 })))].slice(0, 500) : [];
    if (!regionCodes.length) fail('VALIDATION_ERROR', '配送区域至少需要一个区域编码。');
    const timestamp = nowIso(clock);
    const patch = { name: string(payload.name, '配送区域名称', { required: true, max: 80 }), regionCodes, warehouseIds: Array.isArray(payload.warehouseIds) ? [...new Set(payload.warehouseIds.map((item) => string(item, '仓库 ID', { required: true, max: 80 })))].slice(0, 50) : [], status: ['active', 'disabled'].includes(payload.status) ? payload.status : 'active', sort: integer(payload.sort, 0), ...demoMetadata(payload), updatedAt: timestamp };
    let area;
    if (payload.id) {
      const id = string(payload.id, '配送区域 ID', { max: 80 });
      const existing = await store.findOne('delivery_areas', { _id: id });
      if (!existing) fail('DELIVERY_AREA_NOT_FOUND', '配送区域不存在。');
      await store.update('delivery_areas', id, patch);
      area = { ...existing, ...patch, _id: id };
    } else area = await store.create('delivery_areas', { ...patch, createdAt: timestamp });
    await audit(admin, 'delivery.area.upsert', 'delivery_area', area._id, { name: area.name, regionCodeCount: area.regionCodes.length, status: area.status });
    return area;
  }

  async function adminUpsertFreightRule(payload) {
    const { admin } = await getAdmin(payload, 'delivery.write');
    const timestamp = nowIso(clock);
    const deliveryAreaId = string(payload.deliveryAreaId, '配送区域 ID', { required: true, max: 80 });
    const area = await store.findOne('delivery_areas', { _id: deliveryAreaId });
    if (!area) fail('DELIVERY_AREA_NOT_FOUND', '配送区域不存在。');
    const customerType = string(payload.customerType, '客户类型', { max: 30 });
    if (!['', 'c', 'b'].includes(customerType)) fail('VALIDATION_ERROR', '运费适用顾客只支持个人、企业或两者。');
    const priority = payload.priority === undefined ? 0 : Number(payload.priority);
    if (!Number.isSafeInteger(priority)) fail('VALIDATION_ERROR', '运费匹配优先级必须是整数。');
    const patch = { name: string(payload.name, '运费规则名称', { required: true, max: 80 }), deliveryAreaId, warehouseId: string(payload.warehouseId, '仓库 ID', { max: 80 }), customerType, baseFeeCent: cents(payload.baseFeeCent === undefined ? (payload.baseFee === undefined ? 0 : payload.baseFee) : payload.baseFeeCent, '基础配送费'), additionalFeeCent: cents(payload.additionalFeeCent === undefined ? (payload.additionalFee === undefined ? 0 : payload.additionalFee) : payload.additionalFeeCent, '附加配送费'), freeThresholdCent: cents(payload.freeThresholdCent === undefined ? (payload.freeThreshold === undefined ? 0 : payload.freeThreshold) : payload.freeThresholdCent, '免运门槛'), priority, validFrom: string(payload.validFrom, '生效开始时间', { max: 40 }), validTo: string(payload.validTo, '生效结束时间', { max: 40 }), status: ['draft', 'active', 'disabled'].includes(payload.status) ? payload.status : 'draft', ...demoMetadata(payload), updatedAt: timestamp };
    if (patch.validFrom && Number.isNaN(new Date(patch.validFrom).getTime())) fail('VALIDATION_ERROR', '运费开始生效时间不合法。');
    if (patch.validTo && Number.isNaN(new Date(patch.validTo).getTime())) fail('VALIDATION_ERROR', '运费结束生效时间不合法。');
    if (patch.validFrom && patch.validTo && new Date(patch.validFrom).getTime() > new Date(patch.validTo).getTime()) fail('VALIDATION_ERROR', '运费结束生效时间不能早于开始时间。');
    let rule;
    if (payload.id) {
      const id = string(payload.id, '运费规则 ID', { max: 80 });
      const existing = await store.findOne('freight_rules', { _id: id });
      if (!existing) fail('FREIGHT_RULE_NOT_FOUND', '运费规则不存在。');
      await store.update('freight_rules', id, patch);
      rule = { ...existing, ...patch, _id: id };
    } else rule = await store.create('freight_rules', { ...patch, createdBy: admin._id, createdAt: timestamp });
    await audit(admin, 'delivery.freight.upsert', 'freight_rule', rule._id, { deliveryAreaId, warehouseId: rule.warehouseId, status: rule.status });
    return rule;
  }

  async function adminUpsertDeliverySlot(payload) {
    const { admin } = await getAdmin(payload, 'delivery.write');
    const deliveryAreaId = string(payload.deliveryAreaId, '配送区域 ID', { required: true, max: 80 });
    const area = await store.findOne('delivery_areas', { _id: deliveryAreaId });
    if (!area) fail('DELIVERY_AREA_NOT_FOUND', '配送区域不存在。');
    const startTime = string(payload.startTime, '开始时间', { required: true, max: 10 });
    const endTime = string(payload.endTime, '结束时间', { required: true, max: 10 });
    if (!/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime) || startTime >= endTime) fail('VALIDATION_ERROR', '配送时段格式或起止时间不合法。');
    const timestamp = nowIso(clock);
    const id = payload.id ? string(payload.id, '配送时段 ID', { max: 80 }) : '';
    const existing = id ? await store.findOne('delivery_slots', { _id: id }) : null;
    if (id && !existing) fail('DELIVERY_SLOT_NOT_FOUND', '配送时段不存在。');
    const capacity = payload.capacity === undefined ? Number(existing?.capacity || 0) : Number(payload.capacity);
    const sort = payload.sort === undefined ? Number(existing?.sort || 0) : Number(payload.sort);
    if (!Number.isSafeInteger(capacity) || capacity < 0) fail('VALIDATION_ERROR', '配送时段容量记录必须是非负整数。');
    if (!Number.isSafeInteger(sort)) fail('VALIDATION_ERROR', '显示顺序必须是整数。');
    const patch = { name: string(payload.name, '配送时段名称', { required: true, max: 80 }), deliveryAreaId, warehouseId: string(payload.warehouseId, '仓库 ID', { max: 80 }), startTime, endTime, capacity, validFrom: string(payload.validFrom === undefined ? existing?.validFrom : payload.validFrom, '生效开始时间', { max: 40 }), validTo: string(payload.validTo === undefined ? existing?.validTo : payload.validTo, '生效结束时间', { max: 40 }), status: ['draft', 'active', 'disabled'].includes(payload.status) ? payload.status : 'draft', sort, ...demoMetadata(payload), updatedAt: timestamp };
    if (patch.validFrom && Number.isNaN(new Date(patch.validFrom).getTime())) fail('VALIDATION_ERROR', '配送时段开始生效时间不合法。');
    if (patch.validTo && Number.isNaN(new Date(patch.validTo).getTime())) fail('VALIDATION_ERROR', '配送时段结束生效时间不合法。');
    if (patch.validFrom && patch.validTo && new Date(patch.validFrom).getTime() > new Date(patch.validTo).getTime()) fail('VALIDATION_ERROR', '配送时段结束生效时间不能早于开始时间。');
    let slot;
    if (id) {
      await store.update('delivery_slots', id, patch); slot = { ...existing, ...patch, _id: id };
    } else slot = await store.create('delivery_slots', { ...patch, createdAt: timestamp });
    await audit(admin, 'delivery.slot.upsert', 'delivery_slot', slot._id, { deliveryAreaId, warehouseId: slot.warehouseId, status: slot.status });
    return slot;
  }

  async function adminTransitionOrder(payload) {
    const { admin } = await getAdmin(payload, 'orders.write');
    const id = string(payload.id, '订单 ID', { required: true, max: 80 });
    const nextStatus = string(payload.status, '目标订单状态', { required: true, max: 30 });
    if (nextStatus === 'pending_confirmation') fail('PAYMENT_CALLBACK_REQUIRED', '待确认状态只能由验签后的支付回调写入。');
    if (typeof store.runTransaction !== 'function') fail('TRANSACTION_NOT_AVAILABLE', '当前环境不支持订单事务。');
    const result = await store.runTransaction(async (tx) => {
      const order = await tx.getById('orders', id);
      if (!order) fail('ORDER_NOT_FOUND', '订单不存在。');
      // 已支付订单的预占已消耗，直接取消会不退款、不回补且关闭退款入口，必须走退款售后流程。
      if (nextStatus === 'cancelled' && (order.paymentStatus === 'paid' || Number(order.receivedAmountCent || 0) > 0)) fail('ORDER_PAID_CANCEL_FORBIDDEN', '已有实际收款的订单不能直接取消，请先核实退款处理。');
      assertTransition(order.status, nextStatus, 'admin');
      const timestamp = nowIso(clock);
      const patch = { status: nextStatus, updatedAt: timestamp };
      if (nextStatus === 'shipping') patch.shipInfo = { carrier: string(payload.carrier, '配送承运方', { max: 80 }), trackingNo: string(payload.trackingNo, '运单号', { max: 100 }), shippedAt: timestamp };
      if (nextStatus === 'delivered') patch.deliveredAt = timestamp;
      if (nextStatus === 'cancelled') {
        patch.cancelledAt = timestamp;
        patch.cancelReason = 'admin_cancelled';
        // 与用户侧取消保持一致：后台取消未支付订单必须在同一事务内释放库存预占与拼团名额。
        for (const reservation of await orderReservations(tx, order)) await releaseReservation(tx, reservation, order, clock(), 'admin_cancel_release');
        await releaseSlot(tx, { groupId: order.groupId, orderId: order._id, now: clock() });
      }
      await tx.update('orders', id, patch);
      return { order: safeOrder({ ...order, ...patch }), from: order.status };
    });
    await audit(admin, 'orders.transition', 'order', id, { from: result.from, to: nextStatus });
    return { order: result.order };
  }

  async function adminOrderFulfillmentContact(payload) {
    const { admin } = await getAdmin(payload, 'orders.read');
    if (!piiEncryptionKey || String(piiEncryptionKey).length < 16) fail('PII_ENCRYPTION_NOT_CONFIGURED', '个人信息加密尚未配置，不能读取履约联系方式。');
    const id = string(payload.id, '订单 ID', { required: true, max: 80 });
    const order = await store.findOne('orders', { _id: id });
    if (!order) fail('ORDER_NOT_FOUND', '订单不存在。');
    // 优先匹配手机号密文与订单一致的地址，避免多地址用户解出与订单无关的联系方式
    const address = order.fulfillmentContactCiphertext
      ? await store.findOne('addresses', { userId: order.userId, status: 'active', phoneCiphertext: order.fulfillmentContactCiphertext }) || await store.findOne('addresses', { userId: order.userId, status: 'active' })
      : await store.findOne('addresses', { userId: order.userId, status: 'active' });
    const phoneCiphertext = order.fulfillmentContactCiphertext || (address && address.phoneCiphertext) || '';
    if (!phoneCiphertext) fail('FULFILLMENT_CONTACT_NOT_AVAILABLE', '订单关联的收货联系方式不可用。');
    const phone = decryptText(phoneCiphertext, piiEncryptionKey);
    await audit(admin, 'orders.fulfillment_contact.read', 'order', id, { purpose: string(payload.purpose || 'delivery', '读取用途', { max: 80 }) });
    return { orderId: id, recipient: { name: order.addressSnapshot && order.addressSnapshot.name || address.name, phone, detail: order.addressSnapshot && order.addressSnapshot.detail || address.detail, regionCode: order.addressSnapshot && order.addressSnapshot.regionCode || address.regionCode } };
  }

  async function adminExpireReservations(payload) {
    const { admin } = await getAdmin(payload, 'orders.write');
    const result = await expireReservations({ store, now: clock(), limit: integer(payload.limit, 50) });
    await audit(admin, 'orders.reservations.expire', 'inventory_reservation', '', result);
    return result;
  }

  async function adminExpireGroups(payload) {
    const { admin } = await getAdmin(payload, 'orders.write');
    const result = await expireGroups({ store, now: clock(), limit: integer(payload.limit, 50) });
    await audit(admin, 'groups.expire', 'group', '', result);
    return result;
  }

  return { adminUpsertPrice, adminSeedDemoCommerce, adminUpsertGroupCampaign, adminUsers, adminSetUserPricingProfile, adminReviewBusinessApplication, adminBusinessApplications, adminBusinessApplicationReviewDetail, adminUpsertWarehouse, adminAdjustInventory, adminUpsertDeliveryArea, adminUpsertFreightRule, adminUpsertDeliverySlot, adminTransitionOrder, adminOrderFulfillmentContact, adminExpireReservations, adminExpireGroups };
}
module.exports = { createAdminOperationsActions };
