const assert = require('assert/strict');
const { inventoryId, ledgerId, expireReservationCandidate, expireGroupCandidate, expireReservations } = require('../lib/expiry');

function createTx(records) {
  const data = new Map();
  for (const [key, value] of Object.entries(records)) data.set(key, { ...value });
  return {
    collection(name) {
      return {
        doc(id) {
          const key = `${name}:${String(id)}`;
          return {
            async get() { return { data: data.get(key) || null }; },
            async set(options) { data.set(key, { ...options.data, _id: String(id) }); return {}; },
            async update(options) { data.set(key, { ...(data.get(key) || {}), ...options.data, _id: String(id) }); return {}; },
            async remove() { data.delete(key); return {}; }
          };
        }
      };
    }
  };
}

async function read(tx, collection, id) {
  const result = await tx.collection(collection).doc(id).get();
  return result.data;
}

async function run() {
  const now = new Date('2026-09-07T12:31:00.000Z');
  const inventoryDocumentId = inventoryId('warehouse-1', 'sku-1');
  const reservationRecords = {
    [`inventory:${inventoryDocumentId}`]: { _id: inventoryDocumentId, warehouseId: 'warehouse-1', skuId: 'sku-1', onHand: 10, reserved: 2, available: 8, version: 1 },
    'inventory_reservations:res-1': { _id: 'res-1', orderId: 'order-1', warehouseId: 'warehouse-1', skuId: 'sku-1', quantity: 2, status: 'reserved', expiresAt: '2026-09-07T12:00:00.000Z' },
    'orders:order-1': { _id: 'order-1', userId: 'user-1', status: 'pending_payment', reservationIds: ['res-1'] }
  };
  const reservationTx = createTx(reservationRecords);
  const reservationReleased = await expireReservationCandidate(reservationTx, { _id: 'res-1' }, now);
  assert.equal(reservationReleased, true);
  assert.equal((await read(reservationTx, 'inventory', inventoryDocumentId)).reserved, 0);
  assert.equal((await read(reservationTx, 'inventory', inventoryDocumentId)).available, 10);
  assert.equal((await read(reservationTx, 'inventory_reservations', 'res-1')).status, 'expired');
  assert.equal((await read(reservationTx, 'orders', 'order-1')).status, 'cancelled');
  assert.equal((await read(reservationTx, 'orders', 'order-1')).paymentStatus, 'closed');
  assert.equal(Boolean(await read(reservationTx, 'inventory_ledger', ledgerId('payment_timeout_release', 'order-1', 'sku-1'))), true);

  const groupRecords = {
    [`inventory:${inventoryDocumentId}`]: { _id: inventoryDocumentId, warehouseId: 'warehouse-1', skuId: 'sku-1', onHand: 5, reserved: 1, available: 4, version: 1 },
    'inventory_reservations:group-res': { _id: 'group-res', orderId: 'group-order', warehouseId: 'warehouse-1', skuId: 'sku-1', quantity: 1, status: 'reserved', expiresAt: '2026-09-07T12:00:00.000Z' },
    'orders:group-order': { _id: 'group-order', userId: 'user-1', groupId: 'group-1', status: 'pending_payment', reservationIds: ['group-res'] },
    'groups:group-1': { _id: 'group-1', status: 'open', orderIds: ['group-order'], reservedOrderIds: ['group-order'], reservedUserIds: ['user-1'], memberCount: 0, reservedMemberCount: 1, expiresAt: '2026-09-07T12:00:00.000Z' }
  };
  const groupTx = createTx(groupRecords);
  const groupResult = await expireGroupCandidate(groupTx, { _id: 'group-1' }, now);
  assert.deepEqual(groupResult, { released: 1, paid: 0 });
  assert.equal((await read(groupTx, 'groups', 'group-1')).status, 'failed');
  assert.equal((await read(groupTx, 'groups', 'group-1')).failureReason, 'expired');
  assert.equal((await read(groupTx, 'inventory_reservations', 'group-res')).status, 'expired');
  assert.equal((await read(groupTx, 'orders', 'group-order')).status, 'cancelled');

  // 分页扫描回归：首页被永不过期的预占占满时，仍能翻页找到真实过期记录
  function createScanDb() {
    const data = new Map();
    const reservationOrder = [];
    const docOps = (name) => ({
      doc(id) {
        const key = `${name}:${String(id)}`;
        return {
          async get() { return { data: data.get(key) || null }; },
          async set(options) { data.set(key, { ...options.data, _id: String(id) }); return {}; },
          async update(options) { data.set(key, { ...(data.get(key) || {}), ...options.data, _id: String(id) }); return {}; }
        };
      }
    });
    const db = {
      data,
      collection(name) {
        if (name === 'inventory_reservations') {
          return {
            ...docOps(name),
            where(where) {
              return {
                skip(skip) {
                  return {
                    limit(rowLimit) {
                      return {
                        async get() {
                          const rows = reservationOrder.map((id) => data.get(`inventory_reservations:${id}`)).filter((row) => row && row.status === where.status);
                          return { data: rows.slice(skip, skip + rowLimit) };
                        }
                      };
                    }
                  };
                }
              };
            }
          };
        }
        if (name === 'audit_logs') {
          return { async add(options) { data.set(`audit:${data.size}`, options.data); return {}; } };
        }
        return docOps(name);
      },
      runTransaction(work) { return work({ collection: db.collection }); },
      seedReservation(record) { data.set(`inventory_reservations:${record._id}`, { ...record }); reservationOrder.push(record._id); },
      seed(key, record) { data.set(key, { ...record }); }
    };
    return db;
  }

  const scanDb = createScanDb();
  const scanInventoryId = inventoryId('warehouse-bulk', 'sku-bulk');
  scanDb.seed(`inventory:${scanInventoryId}`, { _id: scanInventoryId, warehouseId: 'warehouse-bulk', skuId: 'sku-bulk', onHand: 1, reserved: 1, available: 0, version: 1 });
  scanDb.seed('orders:bulk-order', { _id: 'bulk-order', userId: 'user-1', status: 'pending_payment', reservationIds: ['bulk-res'] });
  for (let index = 0; index < 120; index += 1) {
    scanDb.seedReservation({ _id: `perm-res-${index}`, orderId: 'bulk-order', warehouseId: 'warehouse-bulk', skuId: 'sku-bulk', quantity: 0, status: 'reserved', expiresAt: '' });
  }
  scanDb.seedReservation({ _id: 'bulk-res', orderId: 'bulk-order', warehouseId: 'warehouse-bulk', skuId: 'sku-bulk', quantity: 1, status: 'reserved', expiresAt: '2026-09-07T12:00:00.000Z' });
  const scanResult = await expireReservations(scanDb, new Date('2026-09-07T13:00:00.000Z'), 10);
  assert.equal(scanResult.released, 1, '分页扫描必须能越过 120 条永久预占释放真实过期预占');
  assert.equal(scanResult.scanned, 121, '分页扫描应覆盖全部 reserved 预占');
  assert.equal(scanDb.data.get('inventory_reservations:bulk-res').status, 'expired');

  console.log('maintenance expiry test: passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
