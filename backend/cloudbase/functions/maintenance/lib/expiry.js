const crypto = require('crypto');

function id(prefix, parts) { return `${prefix}_${crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 48)}`; }
function inventoryId(warehouseId, skuId) { return id('inv', [String(warehouseId), String(skuId)]); }
function ledgerId(reason, referenceId, skuId) { return id('ledger', [String(reason), String(referenceId), String(skuId)]); }
function nowIso(now) { return now.toISOString(); }

async function get(tx, collection, documentId) {
  const result = await tx.collection(collection).doc(String(documentId)).get();
  return Array.isArray(result && result.data) ? result.data[0] || null : result && result.data || null;
}

async function set(tx, collection, documentId, data) {
  const record = { ...data };
  delete record._id;
  return tx.collection(collection).doc(String(documentId)).set({ data: record });
}

async function update(tx, collection, documentId, patch) { return tx.collection(collection).doc(String(documentId)).update({ data: patch }); }

async function releaseReservation(tx, reservation, order, now, reason) {
  if (!reservation || reservation.status !== 'reserved') return false;
  const inventory = await get(tx, 'inventory', inventoryId(reservation.warehouseId, reservation.skuId));
  if (!inventory) throw new Error('INVENTORY_NOT_FOUND');
  const timestamp = nowIso(now);
  const onHand = Number(inventory.onHand || 0);
  const reserved = Math.max(0, Number(inventory.reserved || 0) - Number(reservation.quantity || 0));
  await update(tx, 'inventory', inventory._id, { reserved, available: onHand - reserved, version: Number(inventory.version || 0) + 1, updatedAt: timestamp });
  await update(tx, 'inventory_reservations', reservation._id, { status: 'expired', releasedAt: timestamp });
  await set(tx, 'inventory_ledger', ledgerId(reason, order._id, reservation.skuId), { warehouseId: reservation.warehouseId, skuId: reservation.skuId, change: 0, reservedChange: -Number(reservation.quantity || 0), before: onHand - Number(inventory.reserved || 0), after: onHand - reserved, reason, referenceType: 'order', referenceId: order._id, operatorId: 'system', idempotencyKey: `${reason}:${reservation._id}`, createdAt: timestamp });
  return true;
}

async function expireReservationCandidate(tx, candidate, now) {
  const reservation = await get(tx, 'inventory_reservations', candidate._id);
  if (!reservation || reservation.status !== 'reserved' || !reservation.expiresAt || new Date(reservation.expiresAt).getTime() > now.getTime()) return false;
  const order = await get(tx, 'orders', reservation.orderId);
  if (!order || order.status !== 'pending_payment') return false;
  await releaseReservation(tx, reservation, order, now, 'payment_timeout_release');
  const reservations = await Promise.all((order.reservationIds || []).map((documentId) => get(tx, 'inventory_reservations', documentId)));
  const timestamp = nowIso(now);
  if (!reservations.some((item) => item && item.status === 'reserved')) {
    await update(tx, 'orders', order._id, { status: 'cancelled', paymentStatus: 'closed', cancelledAt: timestamp, cancelReason: 'payment_timeout', updatedAt: timestamp });
    if (order.groupId) {
      const group = await get(tx, 'groups', order.groupId);
      if (group) await update(tx, 'groups', group._id, { reservedMemberCount: Math.max(Number(group.memberCount || 0), Number(group.reservedMemberCount || 0) - 1), reservedOrderIds: (group.reservedOrderIds || []).filter((value) => value !== order._id), reservedUserIds: (group.reservedUserIds || []).filter((value) => value !== order.userId), updatedAt: timestamp });
    }
  }
  return true;
}

async function expireGroupCandidate(tx, candidate, now) {
  const group = await get(tx, 'groups', candidate._id);
  if (!group || group.status !== 'open' || !group.expiresAt || new Date(group.expiresAt).getTime() > now.getTime()) return null;
  const orders = await Promise.all((group.orderIds || []).map((documentId) => get(tx, 'orders', documentId)));
  const timestamp = nowIso(now);
  let transactionReleased = 0;
  let paid = 0;
  for (const order of orders.filter(Boolean)) {
    if (order.status === 'pending_payment') {
      for (const reservationDocumentId of order.reservationIds || []) {
        const reservation = await get(tx, 'inventory_reservations', reservationDocumentId);
        if (await releaseReservation(tx, reservation, order, now, 'group_expire_release')) transactionReleased += 1;
      }
      await update(tx, 'orders', order._id, { status: 'cancelled', paymentStatus: 'closed', cancelledAt: timestamp, cancelReason: 'group_expired', groupStatus: 'failed', updatedAt: timestamp });
    } else if (['pending_confirmation', 'picking', 'shipping', 'delivered', 'completed'].includes(order.status)) {
      paid += 1;
      await update(tx, 'orders', order._id, { groupStatus: 'failed', updatedAt: timestamp });
    }
  }
  await update(tx, 'groups', group._id, { status: 'failed', reservedMemberCount: Number(group.memberCount || 0), reservedOrderIds: [], reservedUserIds: [], failedAt: timestamp, failureReason: paid ? 'paid_members_require_refund' : 'expired', updatedAt: timestamp });
  return { released: transactionReleased, paid };
}

// 分页扫描全部待处理记录：永不过期的预占（如演示/线下订单）不得阻塞真实过期记录的释放
async function collectExpired(db, collection, status, now, limit) {
  const pageSize = 100;
  const candidates = [];
  let scanned = 0;
  for (let page = 0; candidates.length < limit; page += 1) {
    const batch = (await db.collection(collection).where({ status }).skip(page * pageSize).limit(pageSize).get()).data || [];
    scanned += batch.length;
    for (const item of batch) {
      if (item.expiresAt && new Date(item.expiresAt).getTime() <= now.getTime()) {
        candidates.push(item);
        if (candidates.length >= limit) break;
      }
    }
    if (batch.length < pageSize) break;
  }
  return { candidates, scanned };
}

async function expireReservations(db, now, limit = 100) {
  const maxProcess = Math.max(1, Math.min(100, limit));
  const { candidates, scanned } = await collectExpired(db, 'inventory_reservations', 'reserved', now, maxProcess);
  let released = 0;
  for (const candidate of candidates) {
    const didRelease = await db.runTransaction(async (tx) => expireReservationCandidate(tx, candidate, now));
    if (didRelease) released += 1;
  }
  return { scanned, released, hasMore: candidates.length >= maxProcess };
}

async function expireGroups(db, now, limit = 100) {
  const maxProcess = Math.max(1, Math.min(100, limit));
  const { candidates, scanned } = await collectExpired(db, 'groups', 'open', now, maxProcess);
  let closed = 0;
  let released = 0;
  let refundRequired = 0;
  for (const candidate of candidates) {
    const result = await db.runTransaction(async (tx) => expireGroupCandidate(tx, candidate, now));
    if (result) {
      closed += 1;
      released += result.released;
      refundRequired += result.paid;
    }
  }
  return { scanned, closed, released, refundRequired, hasMore: candidates.length >= maxProcess };
}

// 过期超过 7 天的管理员会话文档定期清理，防止无限膨胀（每轮有 500 条扫描上限，剩余下轮继续）
async function cleanupSessions(db, now) {
  const cutoff = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  let scanned = 0;
  let removed = 0;
  const pageSize = 100;
  for (let page = 0; page < 5; page += 1) {
    const batch = (await db.collection('admin_sessions').skip(page * pageSize).limit(pageSize).get()).data || [];
    scanned += batch.length;
    if (!batch.length) break;
    for (const session of batch) {
      if (session.expiresAt && new Date(session.expiresAt).getTime() < cutoff) {
        await db.collection('admin_sessions').doc(String(session._id)).remove();
        removed += 1;
      }
    }
    if (batch.length < pageSize) break;
  }
  return { scanned, removed };
}

async function run(db, now, limit = 100) {
  const reservations = await expireReservations(db, now, limit);
  const groups = await expireGroups(db, now, limit);
  const sessions = await cleanupSessions(db, now);
  await db.collection('audit_logs').add({ data: { actorType: 'system', actorId: '', action: 'system.maintenance.tick', targetType: 'maintenance', targetId: '', details: { reservations, groups, sessions }, createdAt: nowIso(now) } });
  return { ok: true, reservations, groups, sessions };
}

module.exports = { inventoryId, ledgerId, nowIso, releaseReservation, expireReservationCandidate, expireGroupCandidate, expireReservations, expireGroups, cleanupSessions, run };
