const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { shouldClearSession } = require('../session-policy');

const source = fs.readFileSync(path.join(__dirname, '..', 'simple.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'simple.html'), 'utf8');

assert.deepEqual([
  ['ADMIN_SESSION_EXPIRED', true],
  ['ADMIN_UNAUTHORIZED', true],
  ['ADMIN_FORBIDDEN', false],
  ['NETWORK_ERROR', false],
  ['TIMEOUT', false],
  [undefined, false]
].map(([code, expected]) => shouldClearSession(code ? { code } : null) === expected), [true, true, true, true, true, true], '只有真实会话失效才可清理后台会话');

for (const action of [
  'admin.products.batchUpsert', 'admin.prices.batchUpsert', 'admin.inventory.ledger',
  'admin.orders.get', 'admin.orders.notes.list', 'admin.orders.notes.add',
  'admin.orders.batchTransition', 'admin.orders.export', 'admin.orders.pickingList',
  'admin.permissions.catalog', 'admin.roles.setStatus', 'admin.versions.list', 'admin.versions.rollback',
  'admin.groups.members', 'admin.couponGrants.list', 'admin.points.accounts.list',
  'admin.points.ledger', 'admin.storedValue.ledger'
]) assert.match(source, new RegExp(action.replace(/\./g, '\\.')), `缺少真实接口绑定 ${action}`);

assert.doesNotMatch(source, /admin\.products\.batch['"]|admin\.prices\.batch['"]|admin\.orders\.note['"]/, '不得使用旧的批量或备注 action');
assert.match(source, /items:\s*ids\.map\(id\s*=>\s*\(\{\s*id,\s*status\s*\}\)\)/, '批量履约必须提交逐项 items');
assert.match(source, /row\.recipient\s*\|\|\s*\{\}/, '拣货单必须读取脱敏 recipient');
assert.match(source, /row\.pickupSiteSnapshot\s*\|\|\s*\{\}/, '拣货单必须读取自提快照');
assert.match(source, /list\('admin\.orders\.list',\s*\{\s*status,\s*paymentStatus,\s*fulfillmentType:/, '订单筛选必须把条件提交给服务端');
assert.match(source, /生成一个新版本/, '回退确认必须说明生成新版本');
assert.match(source, /await\s+openOrderDetail\(id\)/, '新增备注成功后必须刷新详情与备注历史');
for (const retryId of ['orderLoadRetry', 'productLoadRetry', 'refundLoadRetry', 'inventoryLoadRetry', 'deliveryLoadRetry']) assert.match(source, new RegExp(retryId), `${retryId} 缺少失败重试入口`);

const primary = [...html.matchAll(/<button data-view="([^"]+)"/g)].map(match => match[1]);
assert.deepEqual(primary, ['dashboard', 'orders', 'products', 'inventory', 'refunds', 'customers', 'delivery', 'marketing', 'settings'], '普通后台必须保持九个一级入口');
for (const type of ['product', 'price', 'banner', 'homeSection', 'media', 'groupCampaign', 'bundle', 'couponTemplate', 'membershipLevel', 'pointsRule']) assert.match(html, new RegExp(`value="${type}"`), `版本入口缺少 ${type}`);

console.log('admin operations contract test: passed');
