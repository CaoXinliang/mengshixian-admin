const { fail } = require('./response');
const { sha256, randomId } = require('./security');
const { stableDocumentId } = require('./transaction-ids');
const { collectPageMatches } = require('./collection-read');
const { ROLE_PERMISSIONS, KNOWN_PERMISSIONS } = require('./permissions');

const VERSION_TARGETS = {
  product: { collection: 'products', permission: 'catalog', draftField: 'status', activeValues: ['on_sale'], draftValue: 'draft' },
  price: { collection: 'prices', permission: 'pricing', draftField: 'status', activeValues: ['active'], draftValue: 'draft' },
  banner: { collection: 'banners', permission: 'content', draftField: 'enabled', activeValues: [true], draftValue: false },
  homeSection: { collection: 'home_sections', permission: 'content', draftField: 'enabled', activeValues: [true], draftValue: false },
  media: { collection: 'media_assets', permission: 'media', draftField: 'enabled', activeValues: [true], draftValue: false },
  groupCampaign: { collection: 'group_campaigns', permission: 'marketing', draftField: 'status', activeValues: ['active'], draftValue: 'draft' },
  bundle: { collection: 'bundles', permission: 'marketing', draftField: 'status', activeValues: ['active'], draftValue: 'draft' },
  couponTemplate: { collection: 'coupon_templates', permission: 'marketing', draftField: 'status', activeValues: ['active'], draftValue: 'draft' },
  membershipLevel: { collection: 'membership_levels', permission: 'points', draftField: 'status', activeValues: ['active'], draftValue: 'draft' },
  pointsRule: { collection: 'points_rules', permission: 'points', draftField: 'status', activeValues: ['active'], draftValue: 'draft' }
};

function integer(value, fallback = 0) { const number = Number(value); return Number.isInteger(number) ? number : fallback; }
function text(value, max = 200) { return String(value === undefined || value === null ? '' : value).trim().slice(0, max); }
function pageParams(payload) { return { page: Math.max(1, integer(payload.page, 1)), pageSize: Math.min(100, Math.max(1, integer(payload.pageSize, 20))) }; }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((out, key) => { out[key] = canonical(value[key]); return out; }, {});
  return value;
}
function fingerprint(value) { return sha256(JSON.stringify(canonical(value))); }
function isTemporary(item) { return item && (item.temporary === true || ['ai_generated', 'demo'].includes(item.source)); }
function publicError(error) { return { code: error && error.code || 'ITEM_FAILED', message: error && error.message || '处理失败。' }; }
function withoutInternal(item) {
  const output = { ...(item || {}) };
  delete output._id; delete output.createdAt; delete output.updatedAt; delete output.createdBy; delete output.updatedBy;
  delete output.adminToken; delete output.sessionToken; delete output.webSessionToken; delete output.password;
  return output;
}
function safeAdminRow(item) {
  const output = { ...(item || {}) };
  Object.keys(output).forEach((key) => {
    if (/ciphertext|tokenHash|password|idempotencyKey/i.test(key)) delete output[key];
  });
  if (output.taxNo) { output.taxNoMasked = `${String(output.taxNo).slice(0, 3)}***${String(output.taxNo).slice(-2)}`; delete output.taxNo; }
  if (output.bankAccount) { output.bankAccountMasked = `****${String(output.bankAccount).slice(-4)}`; delete output.bankAccount; }
  return output;
}

function createAdminOperations({ store, clock, getAdmin, audit, safeOrder, safeOrderItemDetail, safeAdminInvoice, upsertProduct, upsertPrice, transitionOrder }) {
  const nowIso = () => clock().toISOString();

  async function recordVersion(entityType, entityId, admin, operation = 'update') {
    const target = VERSION_TARGETS[entityType];
    if (!target) fail('VERSION_ENTITY_INVALID', '不支持该版本实体。');
    if (typeof store.runTransaction !== 'function') fail('TRANSACTION_NOT_AVAILABLE', '当前环境不支持版本事务。');
    return store.runTransaction(async (tx) => {
      const current = await tx.getById(target.collection, entityId);
      if (!current) fail('VERSION_ENTITY_NOT_FOUND', '版本实体不存在。');
      const version = Math.max(0, integer(current.revision, 0)) + 1;
      const timestamp = nowIso();
      const next = { ...current, revision: version, updatedAt: current.updatedAt || timestamp };
      await tx.set(target.collection, entityId, next);
      const historyId = stableDocumentId('ver', [entityType, entityId, version]);
      const history = { _id: historyId, entityType, entityId, version, operation, snapshot: next, createdBy: admin._id, createdAt: timestamp };
      await tx.set('entity_versions', historyId, history);
      return { entity: next, history };
    });
  }

  async function versionedUpsert(entityType, handler, payload) {
    const { admin } = await getAdmin(payload, `${VERSION_TARGETS[entityType].permission}.write`);
    const entityId = text(payload.id, 80);
    const lockId = entityId ? stableDocumentId('version_lock', [entityType, entityId]) : '';
    const lockToken = lockId ? randomId('lock') : '';
    if (lockId) {
      await store.runTransaction(async (tx) => {
        const old = await tx.getById('entity_version_locks', lockId);
        if (old && new Date(old.expiresAt).getTime() > clock().getTime()) fail('VERSION_WRITE_IN_PROGRESS', '该记录正在被其他管理员修改，请稍后重试。');
        await tx.set('entity_version_locks', lockId, { _id: lockId, entityType, entityId, lockToken, adminId: admin._id, expiresAt: new Date(clock().getTime() + 60000).toISOString(), createdAt: nowIso() });
      });
    }
    try {
      const result = await handler(payload);
      const versioned = await recordVersion(entityType, result._id, admin, payload.id ? 'update' : 'create');
      return versioned.entity;
    } finally {
      if (lockId) await store.runTransaction(async (tx) => { const lock = await tx.getById('entity_version_locks', lockId); if (lock && lock.lockToken === lockToken) await tx.remove('entity_version_locks', lockId); });
    }
  }

  async function runBatch(payload, kind, permission, handler) {
    const { admin } = await getAdmin(payload, permission);
    const key = text(payload.idempotencyKey, 120);
    if (!key) fail('IDEMPOTENCY_KEY_REQUIRED', '批量操作必须提供幂等键。');
    const items = Array.isArray(payload.items) ? payload.items.slice(0, 50) : [];
    if (!items.length) fail('VALIDATION_ERROR', '批量操作至少需要一项。');
    const hash = fingerprint(items);
    const operationId = stableDocumentId('admin_batch', [admin._id, kind, key]);
    if (typeof store.runTransaction !== 'function') fail('TRANSACTION_NOT_AVAILABLE', '当前环境不支持批量幂等事务。');
    const claim = await store.runTransaction(async (tx) => {
      const old = await tx.getById('admin_batch_operations', operationId);
      if (old) {
        if (old.payloadHash !== hash) fail('IDEMPOTENCY_CONFLICT', '幂等键已用于不同批量请求。');
        if (old.status === 'completed' || old.result) return { replay: true, result: old.result };
        if (new Date(old.expiresAt || 0).getTime() > clock().getTime()) return { inProgress: true };
      }
      await tx.set('admin_batch_operations', operationId, { _id: operationId, adminId: admin._id, kind, idempotencyKey: key, payloadHash: hash, status: 'processing', startedAt: nowIso(), expiresAt: new Date(clock().getTime() + 5 * 60 * 1000).toISOString() });
      return { claimed: true };
    });
    if (claim.replay) return { ...claim.result, operationId, idempotent: true };
    if (claim.inProgress) fail('BATCH_IN_PROGRESS', '相同批量请求正在处理中，请稍后使用原幂等键重试。');
    const rows = [];
    for (let index = 0; index < items.length; index += 1) {
      try {
        const item = await handler({ ...items[index], adminToken: payload.adminToken });
        rows.push({ index, ok: true, id: item._id, revision: item.revision || 0 });
      } catch (error) { rows.push({ index, ok: false, error: publicError(error) }); }
    }
    const result = { rows, succeeded: rows.filter((row) => row.ok).length, failed: rows.filter((row) => !row.ok).length };
    await store.update('admin_batch_operations', operationId, { status: 'completed', result, completedAt: nowIso() });
    await audit(admin, `${kind}.batch`, kind, '', { operationId, count: rows.length, succeeded: result.succeeded, failed: result.failed });
    return { ...result, operationId, idempotent: false };
  }

  async function productsBatch(payload) { return runBatch(payload, 'products', 'catalog.write', (item) => versionedUpsert('product', upsertProduct, item)); }
  async function pricesBatch(payload) { return runBatch(payload, 'prices', 'pricing.write', (item) => versionedUpsert('price', upsertPrice, item)); }

  async function inventoryLedger(payload) {
    await getAdmin(payload, 'inventory.read');
    const filter = { warehouseId: text(payload.warehouseId, 80), skuId: text(payload.skuId, 80), reason: text(payload.reason, 80), referenceId: text(payload.referenceId, 120) };
    const from = payload.dateFrom ? new Date(payload.dateFrom).getTime() : NaN;
    const to = payload.dateTo ? new Date(payload.dateTo).getTime() : NaN;
    if (payload.dateFrom && Number.isNaN(from) || payload.dateTo && Number.isNaN(to)) fail('VALIDATION_ERROR', '库存流水日期不合法。');
    const matched = await collectPageMatches(store, 'inventory_ledger', { orderBy: [{ field: 'createdAt', direction: 'desc' }] }, (row) => {
      if (filter.warehouseId && row.warehouseId !== filter.warehouseId) return false;
      if (filter.skuId && row.skuId !== filter.skuId) return false;
      if (filter.reason && row.reason !== filter.reason) return false;
      if (filter.referenceId && row.referenceId !== filter.referenceId) return false;
      const time = new Date(row.createdAt).getTime();
      return (Number.isNaN(from) || time >= from) && (Number.isNaN(to) || time <= to);
    });
    const { page, pageSize } = pageParams(payload); const start = (page - 1) * pageSize;
    return { rows: matched.slice(start, start + pageSize), total: matched.length, page, pageSize };
  }

  async function filteredList(payload, collection, permission, allowedFilters, dateField = 'createdAt', projector = safeAdminRow) {
    await getAdmin(payload, permission);
    const filters = {};
    for (const field of allowedFilters) if (payload[field] !== undefined && payload[field] !== '') filters[field] = String(payload[field]);
    const from = payload.dateFrom ? new Date(payload.dateFrom).getTime() : NaN; const to = payload.dateTo ? new Date(payload.dateTo).getTime() : NaN;
    if (payload.dateFrom && Number.isNaN(from) || payload.dateTo && Number.isNaN(to) || !Number.isNaN(from) && !Number.isNaN(to) && from > to) fail('VALIDATION_ERROR', '筛选日期不合法。');
    const matched = await collectPageMatches(store, collection, { orderBy: [{ field: dateField, direction: 'desc' }] }, (row) => {
      if (Object.entries(filters).some(([field, value]) => String(row[field] === undefined ? '' : row[field]) !== value)) return false;
      const time = new Date(row[dateField] || row.createdAt).getTime(); return (Number.isNaN(from) || time >= from) && (Number.isNaN(to) || time <= to);
    });
    const { page, pageSize } = pageParams(payload); const start = (page - 1) * pageSize;
    return { rows: matched.slice(start, start + pageSize).map(projector), total: matched.length, page, pageSize };
  }
  const couponGrants = (payload) => filteredList(payload, 'user_coupons', 'marketing.read', ['status', 'templateId', 'userId'], 'createdAt');
  const pointsAccounts = (payload) => filteredList(payload, 'points_accounts', 'points.read', ['userId', 'levelCode'], 'updatedAt');
  const pointsLedger = (payload) => filteredList(payload, 'points_ledger', 'points.read', ['userId', 'action', 'orderId'], 'createdAt');
  const storedValueLedger = (payload) => filteredList(payload, 'stored_value_ledger', 'storedValue.read', ['userId', 'action', 'orderId'], 'createdAt');
  const groupMembers = (payload) => filteredList(payload, 'group_members', 'marketing.read', ['groupId', 'campaignId', 'userId', 'status'], 'createdAt');
  const reviews = (payload) => filteredList(payload, 'reviews', 'reviews.read', ['status', 'userId', 'productId', 'orderId', 'rating'], 'createdAt');
  const invoices = (payload) => filteredList(payload, 'invoices', 'invoices.read', ['status', 'userId', 'orderId', 'titleType'], 'createdAt', safeAdminInvoice || safeAdminRow);
  const receivables = (payload) => filteredList(payload, 'receivable_ledger', 'receivables.read', ['organizationId', 'accountId', 'orderId', 'statementId', 'action'], 'createdAt');
  const statements = (payload) => filteredList(payload, 'statements', 'receivables.read', ['organizationId', 'accountId', 'orderId', 'status'], 'createdAt');

  function orderMatches(order, payload) {
    const exact = ['status', 'paymentStatus', 'paymentMethod', 'fulfillmentType', 'warehouseId', 'organizationId', 'userId'];
    if (exact.some((field) => payload[field] && order[field] !== String(payload[field]))) return false;
    if (payload.orderNo && !String(order.orderNo || '').includes(String(payload.orderNo))) return false;
    const created = new Date(order.createdAt).getTime();
    if (payload.createdFrom && created < new Date(payload.createdFrom).getTime()) return false;
    if (payload.createdTo && created > new Date(payload.createdTo).getTime()) return false;
    return true;
  }
  async function filteredOrders(payload) {
    if (payload.createdFrom && Number.isNaN(new Date(payload.createdFrom).getTime()) || payload.createdTo && Number.isNaN(new Date(payload.createdTo).getTime())) fail('VALIDATION_ERROR', '订单日期不合法。');
    return collectPageMatches(store, 'orders', { orderBy: [{ field: 'createdAt', direction: 'desc' }] }, (order) => orderMatches(order, payload));
  }
  async function ordersSearch(payload) {
    await getAdmin(payload, 'orders.read'); const matched = await filteredOrders(payload); const { page, pageSize } = pageParams(payload); const start = (page - 1) * pageSize;
    return { rows: matched.slice(start, start + pageSize).map(safeOrder), total: matched.length, page, pageSize };
  }
  async function orderNote(payload) {
    const { admin } = await getAdmin(payload, 'orders.write'); const id = text(payload.id, 80); const noteText = text(payload.note, 500); const key = text(payload.idempotencyKey, 120);
    if (!id || !noteText || !key) fail('VALIDATION_ERROR', '订单、备注和幂等键不能为空。');
    const noteId = stableDocumentId('order_note', [admin._id, key]);
    const result = await store.runTransaction(async (tx) => { const old = await tx.getById('order_notes', noteId); if (old) { if (old.orderId !== id || old.content !== noteText) fail('IDEMPOTENCY_CONFLICT', '幂等键已用于其他备注。'); return { note: old, idempotent: true }; } const order = await tx.getById('orders', id); if (!order) fail('ORDER_NOT_FOUND', '订单不存在。'); const note = { _id: noteId, orderId: id, content: noteText, adminId: admin._id, createdAt: nowIso() }; await tx.set('order_notes', noteId, note); return { note, idempotent: false }; });
    if (!result.idempotent) await audit(admin, 'orders.note', 'order', id, { noteId }); return result;
  }
  async function orderNotes(payload) { await getAdmin(payload, 'orders.read'); const orderId = text(payload.id, 80); if (!orderId) fail('VALIDATION_ERROR', '订单 ID 不能为空。'); return store.list('order_notes', { where: { orderId }, orderBy: [{ field: 'createdAt', direction: 'desc' }], ...pageParams(payload) }); }
  async function ordersBatchTransition(payload) { return runBatch(payload, 'orders.transition', 'orders.write', async (item) => (await transitionOrder({ ...payload, ...item, idempotencyKey: undefined, adminToken: payload.adminToken })).order); }

  async function ordersExport(payload) {
    const { admin } = await getAdmin(payload, 'orders.read'); const matched = await filteredOrders(payload); const limit = Math.min(2000, Math.max(1, integer(payload.limit, 1000)));
    const rows = matched.slice(0, limit).map((order) => { const safe = safeOrder(order); return { orderId: safe._id, orderNo: safe.orderNo, status: safe.status, paymentStatus: safe.paymentStatus, paymentMethod: safe.paymentMethod, fulfillmentType: safe.fulfillmentType, warehouseId: safe.warehouseId, totalAmountCent: safe.totalAmountCent, createdAt: safe.createdAt }; });
    await audit(admin, 'orders.export', 'order', '', { filters: withoutInternal(payload), count: rows.length, truncated: matched.length > limit });
    return { rows, total: matched.length, generatedAt: nowIso(), truncated: matched.length > limit };
  }
  async function pickingList(payload) {
    const { admin } = await getAdmin(payload, 'orders.read'); const ids = Array.isArray(payload.ids) ? [...new Set(payload.ids.map((id) => text(id, 80)).filter(Boolean))].slice(0, 100) : [];
    if (!ids.length) fail('VALIDATION_ERROR', '至少选择一个订单。'); const rows = [];
    for (const id of ids) { const order = await store.getById('orders', id); if (!order) continue; const items = (order.itemsSnapshot || []).map(safeOrderItemDetail); rows.push({ orderId: id, orderNo: order.orderNo, status: order.status, warehouseId: order.warehouseId, fulfillmentType: order.fulfillmentType || 'delivery', pickupSiteSnapshot: order.fulfillmentType === 'pickup' ? order.pickupSiteSnapshot || null : null, recipient: order.fulfillmentType === 'pickup' ? null : { name: order.addressSnapshot && order.addressSnapshot.name || '', phoneMasked: order.addressSnapshot && order.addressSnapshot.phoneMasked || '', regionCode: order.addressSnapshot && order.addressSnapshot.regionCode || '' }, deliverySlotSnapshot: order.deliverySlotSnapshot || null, items }); }
    await audit(admin, 'orders.picking_list', 'order', '', { orderIds: rows.map((row) => row.orderId) }); return { rows, generatedAt: nowIso() };
  }

  async function permissionsCatalog(payload) { await getAdmin(payload, 'admin.read'); return { permissions: KNOWN_PERMISSIONS.map((code) => ({ code, module: code.split('.')[0], operation: code.split('.')[1] })), builtInRoles: Object.entries(ROLE_PERMISSIONS).map(([code, permissions]) => ({ code, permissions })) }; }
  async function roleSetStatus(payload) { const { admin } = await getAdmin(payload, 'admin.write'); const id = text(payload.id, 80); const status = text(payload.status, 20); if (!['active', 'disabled'].includes(status)) fail('VALIDATION_ERROR', '角色状态不合法。'); const role = await store.getById('admin_roles', id); if (!role) fail('ADMIN_ROLE_NOT_FOUND', '角色不存在。'); if (role.code === 'super_admin') fail('ADMIN_ROLE_PROTECTED', '超级管理员角色不能停用。'); await store.update('admin_roles', id, { status, updatedAt: nowIso() }); await audit(admin, 'admin.role.status', 'admin_role', id, { from: role.status, to: status }); return { id, status }; }

  async function versionsList(payload) { const type = text(payload.entityType, 40); const target = VERSION_TARGETS[type]; if (!target) fail('VERSION_ENTITY_INVALID', '不支持该版本实体。'); await getAdmin(payload, `${target.permission}.read`); const entityId = text(payload.entityId, 80); if (!entityId) fail('VALIDATION_ERROR', '版本实体 ID 不能为空。'); const all = await collectPageMatches(store, 'entity_versions', { where: { entityType: type, entityId } }, () => true); all.sort((a, b) => b.version - a.version); const { page, pageSize } = pageParams(payload); const start = (page - 1) * pageSize; return { rows: all.slice(start, start + pageSize), total: all.length, page, pageSize }; }
  async function versionsRollback(payload) {
    const type = text(payload.entityType, 40); const target = VERSION_TARGETS[type]; if (!target) fail('VERSION_ENTITY_INVALID', '不支持该版本实体。'); const { admin } = await getAdmin(payload, `${target.permission}.write`); const entityId = text(payload.entityId, 80); const version = integer(payload.version, 0); const key = text(payload.idempotencyKey, 120); if (!entityId || version < 1 || !key) fail('VALIDATION_ERROR', '实体、版本和幂等键不能为空。'); const operationId = stableDocumentId('rollback', [admin._id, type, key]);
    const result = await store.runTransaction(async (tx) => { const old = await tx.getById('version_operations', operationId); if (old) { if (old.entityId !== entityId || old.version !== version || old.entityType !== type) fail('IDEMPOTENCY_CONFLICT', '幂等键已用于其他回滚。'); const history = await tx.getById('entity_versions', old.historyId); return { entity: history && history.snapshot, history, idempotent: true }; } const current = await tx.getById(target.collection, entityId); const source = await tx.getById('entity_versions', stableDocumentId('ver', [type, entityId, version])); if (!current || !source) fail('VERSION_NOT_FOUND', '目标版本不存在。'); const nextVersion = Math.max(integer(current.revision, 0), version) + 1; const timestamp = nowIso(); const snapshot = { ...source.snapshot, _id: entityId, createdAt: current.createdAt || source.snapshot.createdAt, updatedAt: timestamp, revision: nextVersion, rollbackFromRevision: version }; if (target.activeValues.includes(snapshot[target.draftField])) snapshot[target.draftField] = target.draftValue; const historyId = stableDocumentId('ver', [type, entityId, nextVersion]); const history = { _id: historyId, entityType: type, entityId, version: nextVersion, operation: 'rollback', sourceVersion: version, snapshot, createdBy: admin._id, createdAt: timestamp }; await tx.set(target.collection, entityId, snapshot); await tx.set('entity_versions', historyId, history); await tx.set('version_operations', operationId, { _id: operationId, entityType: type, entityId, version, historyId, adminId: admin._id, createdAt: timestamp }); return { entity: snapshot, history, idempotent: false }; }); if (!result.idempotent) await audit(admin, 'versions.rollback', type, entityId, { sourceVersion: version, newRevision: result.entity.revision }); return result;
  }

  return { versionedUpsert, productsBatch, pricesBatch, inventoryLedger, couponGrants, pointsAccounts, pointsLedger, storedValueLedger, groupMembers, reviews, invoices, receivables, statements, ordersSearch, orderNote, orderNotes, ordersBatchTransition, ordersExport, pickingList, permissionsCatalog, roleSetStatus, versionsList, versionsRollback };
}

module.exports = { createAdminOperations, VERSION_TARGETS, isTemporary };
