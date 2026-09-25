const assert = require('node:assert/strict');
const { createApplication } = require('../backend/cloudbase/functions/api/app');
const { createMemoryStore } = require('./support/receipt-flow-fixture.cjs');

async function main() {
  const store = createMemoryStore();
  const app = createApplication({ store, bootstrapToken: 'local-audit-bootstrap', piiEncryptionKey: 'audit-feed-local-only-encryption-key', clock: () => new Date('2026-09-24T10:00:00Z') });
  async function call(action, payload = {}) {
    const result = await app.dispatch({ action, payload });
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
    return result.data;
  }
  await call('admin.bootstrap', { bootstrapToken: 'local-audit-bootstrap', username: 'audit-owner', displayName: '海的后台管理员', password: 'audit-local-password' });
  const login = await call('admin.login', { username: 'audit-owner', password: 'audit-local-password' });
  const owner = (await call('admin.me', { adminToken: login.token })).admin;
  const operator = await call('admin.staff.create', { adminToken: login.token, username: 'audit-operator', displayName: '运营小李', password: 'audit-operator-password', phone: '13800138000', role: 'operator', status: 'active' });
  await store.set('products', 'product-1', { name: '冷冻玉米', status: 'draft' });
  await store.create('audit_logs', { actorType: 'admin', actorId: owner.id, action: 'catalog.product.upsert', targetType: 'product', targetId: 'product-1', details: {}, createdAt: '2026-09-24T10:02:00Z' });
  await store.create('audit_logs', { actorType: 'admin', actorId: owner.id, action: 'catalog.product.status', targetType: 'product', targetId: 'removed-product', details: { to: 'off_sale' }, createdAt: '2026-09-24T10:03:00Z' });
  const first = await call('admin.audit.list', { adminToken: login.token, page: 1, pageSize: 1 });
  assert.equal(first.rows[0].action, 'catalog.product.status');
  assert.equal(first.rows[0].targetTypeName, '商品');
  assert.equal(first.rows[0].targetName, '原记录（当前名称不可用）');
  assert.equal(first.rows[0].actorName, '海的后台管理员');
  assert.equal(first.rows[0].actorRole, 'super_admin');
  const second = await call('admin.audit.list', { adminToken: login.token, page: 2, pageSize: 1 });
  assert.equal(second.rows[0].targetName, '冷冻玉米');
  assert.equal(second.rows[0].actorId, owner.id, '原始审计字段仍供排查');
  assert.equal(second.total, first.total);
  const all = await call('admin.audit.list', { adminToken: login.token, pageSize: 20 });
  assert.ok(all.rows.some((row) => row.action === 'staff.create' && row.targetName === '运营小李'));
  assert.ok(!JSON.stringify(all).includes('13800138000'), '审计列表不可泄露手机号');
  const operatorLogin = await call('admin.login', { username: 'audit-operator', password: 'audit-operator-password' });
  await assert.rejects(call('admin.audit.list', { adminToken: operatorLogin.token }), (error) => error.code === 'ADMIN_FORBIDDEN');
  console.log('Audit feed: newest first, readable actor/target, missing-record fallback, page count, phone redaction, permission gate');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
