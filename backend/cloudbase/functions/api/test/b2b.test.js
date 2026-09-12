const assert = require('assert/strict');
const b2b = require('../lib/b2b');
const { acceptedQuoteOverrides } = require('../lib/commerce');
const { reserveCredit, convertCredit, applyCreditRefund, accountId } = require('../lib/b2b-credit');
const { inventoryId } = require('../lib/transaction-ids');

function storeFactory() {
  const data = new Map(); let n = 0; let tail = Promise.resolve(); const rows = (c) => data.get(c) || []; const match = (x, w = {}) => Object.entries(w).every(([k, v]) => x[k] === v);
  const store = { async getById(c, id) { return rows(c).find((x) => x._id === id) || null; }, async findOne(c, w) { return rows(c).find((x) => match(x, w)) || null; }, async list(c, o = {}) { let out = rows(c).filter((x) => match(x, o.where)); (o.orderBy || []).slice().reverse().forEach(({ field, direction }) => { out = out.slice().sort((a, b) => direction === 'desc' ? String(b[field] || '').localeCompare(String(a[field] || '')) : String(a[field] || '').localeCompare(String(b[field] || ''))); }); const page = o.page || 1; const pageSize = o.pageSize || 20; return { rows: out.slice((page - 1) * pageSize, page * pageSize), total: out.length, page, pageSize }; }, async create(c, x) { const row = { ...x, _id: x._id || `${c}-${++n}` }; data.set(c, [...rows(c), row]); return row; }, async set(c, id, x) { const row = { ...x, _id: id }; data.set(c, rows(c).some((v) => v._id === id) ? rows(c).map((v) => v._id === id ? row : v) : [...rows(c), row]); return row; }, async update(c, id, p) { data.set(c, rows(c).map((v) => v._id === id ? { ...v, ...p } : v)); }, async remove(c, id) { data.set(c, rows(c).filter((v) => v._id !== id)); }, async runTransaction(work) { let release; const prior = tail; tail = new Promise((r) => { release = r; }); await prior; try { return await work({ getById: store.getById, set: store.set, update: store.update, remove: store.remove }); } finally { release(); } } }; return store;
}
async function errorCode(work) { try { await work(); return ''; } catch (error) { return error.code; } }

async function run() {
  const store = storeFactory(); const now = new Date('2026-09-12T00:00:00.000Z'); const user = { _id: 'b-user', userType: 'b', businessStatus: 'approved', organizationId: 'org-1', priceLevel: 'b_standard' }; const admin = { _id: 'admin-1' };
  await store.create('customer_organizations', { _id: 'org-1', name: '测试企业', status: 'active' }); await store.create('products', { _id: 'p1', name: '企业商品', status: 'on_sale', audienceType: 'b' }); await store.create('product_skus', { _id: 's1', productId: 'p1', status: 'on_sale', minOrderQuantity: 2, orderMultiple: 2 }); await store.create('prices', { _id: 'price-1', skuId: 's1', scopeType: 'customer_type', scopeId: 'b', amountCent: 1000, status: 'active' }); await store.create('warehouses', { _id: 'w1', status: 'active' }); await store.create('inventory', { _id: inventoryId('w1', 's1'), warehouseId: 'w1', skuId: 's1', onHand: 20, reserved: 0, available: 20 }); await store.create('delivery_areas', { _id: 'area-1', status: 'active', regionCodes: ['340100'], warehouseIds: ['w1'] }); await store.create('freight_rules', { _id: 'freight-1', status: 'active', warehouseId: 'w1', deliveryAreaId: 'area-1', baseFeeCent: 500, additionalFeeCent: 0 });

  assert.equal(await errorCode(() => b2b.savedUpsert({ store, user, kind: 'frequent_items', payload: { skuId: 's1', quantity: 1 }, now })), 'MIN_ORDER_QUANTITY_NOT_MET');
  const saved = await b2b.savedUpsert({ store, user, kind: 'frequent_items', payload: { skuId: 's1', quantity: 2 }, now });
  const batch = await b2b.savedBatchAdd({ store, user, kind: 'frequent_items', payload: { items: [{ id: saved.item._id, quantity: 4 }], idempotencyKey: 'batch-1' }, now }); assert.equal(batch.addedItems[0].quantity, 4);
  const repeatedBatch = await b2b.savedBatchAdd({ store, user, kind: 'frequent_items', payload: { items: [{ id: saved.item._id, quantity: 4 }], idempotencyKey: 'batch-1' }, now }); assert.equal(repeatedBatch.idempotent, true); assert.equal((await store.findOne('cart_items', { userId: user._id, skuId: 's1' })).quantity, 4);

  assert.equal(await errorCode(() => b2b.inquiryCreate({ store, user, payload: { items: [{ skuId: 's1', quantity: 2 }] }, now })), 'IDEMPOTENCY_KEY_REQUIRED');
  assert.equal(await errorCode(() => b2b.inquiryCreate({ store, user, payload: { idempotencyKey: 'dup', items: [{ skuId: 's1', quantity: 2 }, { skuId: 's1', quantity: 4 }] }, now })), 'INQUIRY_ITEMS_INVALID');
  const inquiry = await b2b.inquiryCreate({ store, user, payload: { idempotencyKey: 'inq-1', items: [{ skuId: 's1', quantity: 2 }] }, now });
  const draft = await b2b.adminInquiryQuote({ store, admin, payload: { id: inquiry.inquiry._id, items: [{ skuId: 's1', unitPriceCent: 800 }], validUntil: '2026-09-20T00:00:00.000Z', source: 'ai_generated', temporary: true }, now }); assert.equal(draft.quote.status, 'draft');
  assert.equal(await errorCode(() => b2b.inquiryAccept({ store, user, payload: { id: inquiry.inquiry._id, quoteId: draft.quote._id, version: draft.quote.version, idempotencyKey: 'accept-draft' }, now })), 'INQUIRY_QUOTE_CHANGED');
  const official = await b2b.adminInquiryQuote({ store, admin, payload: { id: inquiry.inquiry._id, items: [{ skuId: 's1', unitPriceCent: 750 }], validUntil: '2026-09-20T00:00:00.000Z', source: 'client', temporary: false }, now });
  const accepted = await b2b.inquiryAccept({ store, user, payload: { id: inquiry.inquiry._id, quoteId: official.quote._id, version: official.quote.version, idempotencyKey: 'accept-1', addToCart: false }, now }); const replay = await b2b.inquiryAccept({ store, user, payload: { id: inquiry.inquiry._id, quoteId: official.quote._id, version: official.quote.version, idempotencyKey: 'accept-1', addToCart: false }, now }); assert.equal(replay.idempotent, true);
  const locked = await acceptedQuoteOverrides(store, user, accepted.acceptedQuoteToken, official.quote.items, now); assert.equal(locked.overrides.s1.amountCent, 750);
  assert.equal(await errorCode(() => acceptedQuoteOverrides(store, { ...user, _id: 'other' }, accepted.acceptedQuoteToken, official.quote.items, now)), 'INQUIRY_QUOTE_FORBIDDEN');

  const draftCredit = await b2b.adminCreditUpsert({ store, admin, payload: { organizationId: 'org-1', creditLimitCent: 10000, paymentTermDays: 30, status: 'disabled', source: 'ai_generated', temporary: true }, now }); assert.equal(draftCredit.status, 'disabled'); assert.equal(await errorCode(() => b2b.adminCreditUpsert({ store, admin, payload: { organizationId: 'org-1', creditLimitCent: 10000, status: 'active', source: 'ai_generated', temporary: true }, now })), 'CREDIT_DRAFT_CANNOT_ACTIVATE');
  await b2b.adminCreditUpsert({ store, admin, payload: { organizationId: 'org-1', creditLimitCent: 10000, paymentTermDays: 30, status: 'active', source: 'client', temporary: false }, now });
  const order = { _id: 'credit-order', orderNo: 'C1', organizationId: 'org-1', paymentMethod: 'credit', creditStatus: 'reserved', totalAmountCent: 3000 };
  await store.runTransaction(async (tx) => { order.creditAccountId = await reserveCredit(tx, { user, orderId: order._id, amountCent: order.totalAmountCent, now }); await store.set('orders', order._id, order); }); assert.equal((await store.getById('credit_accounts', accountId('org-1'))).occupiedCent, 3000);
  await store.runTransaction(async (tx) => convertCredit(tx, order, now)); assert.equal((await store.getById('credit_accounts', accountId('org-1'))).receivableCent, 3000);
  const invoiceOrder = { ...order, creditStatus: 'invoiced' }; await store.runTransaction(async (tx) => applyCreditRefund(tx, invoiceOrder, { _id: 'refund-1', amountCent: 1000 }, 'admin-1', now, 1000)); assert.equal((await store.getById('credit_accounts', accountId('org-1'))).receivableCent, 2000);
  const profile = await b2b.accountGet({ store, user }); assert.equal(profile.organization.name, '测试企业'); assert.equal(profile.organization.priceLevel, 'b_standard'); assert.equal(profile.organization.paymentTermDays, 30);
  console.log('b2b procurement tests: passed');
}
run().catch((error) => { console.error(error); process.exit(1); });
