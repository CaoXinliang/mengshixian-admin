const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const window = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../admin-tables.js'), 'utf8'), { window });
function orderRow(permissions, paymentMethod = 'offline') {
  let result = '';
  const state = new Proxy({ admin: { permissions }, orders: [{ _id: 'local-order', orderNo: 'LOCAL-1', paymentMethod, paymentStatus: 'offline_pending', status: 'pending_confirmation' }] }, { get: (target, key) => target[key] || [] });
  const text = value => String(value || '');
  window.MengshixianAdminTables.render(state, { escapeHtml: text, translateStatus: text, badge: text, formatDate: text, formatCents: text, formatRegionPreview: text,
    paginateRows(rows, render, id) { if (id === 'ordersTable') result = rows.map(render).join(''); }
  });
  return result;
}
assert.match(orderRow(['orders.read', 'receipts.read']), /data-open-receipts="local-order"/);
assert.doesNotMatch(orderRow(['orders.read', 'receipts.read']), /data-transition-order/);
assert.doesNotMatch(orderRow(['orders.read']), /data-open-receipts|data-transition-order/);
assert.doesNotMatch(orderRow(['*'], 'wechat'), /data-open-receipts/);
assert.match(orderRow(['orders.write']), /data-transition-order/);
assert.match(orderRow(['receipts.*']), /data-open-receipts/);
console.log('Order receipt entry respects read and fulfillment permissions');
