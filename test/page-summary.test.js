const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../admin-page-summary.js'), 'utf8');
let root;
const document = {
  querySelector: (selector) => selector === '.page-intro' ? {
    insertAdjacentElement: (_position, element) => { root = element; }
  } : null,
  getElementById: (id) => id === 'pageSummary' ? root : null,
  createElement: () => ({ id: '', className: '', innerHTML: '', setAttribute() {} })
};
const window = {};
vm.runInNewContext(source, { window, document });

window.MengshixianAdminPageSummary.render('orders', {
  orders: [{ status: 'pending_confirmation' }, { status: 'picking' }, { status: 'picking' }]
});
assert.match(root.innerHTML, /待确认<\/span><strong>1<\/strong>/);
assert.match(root.innerHTML, /拣货中<\/span><strong>2<\/strong>/);

window.MengshixianAdminPageSummary.render('inventory', {
  inventory: [{ reserved: 2, available: 0 }, { reserved: 0, available: 8 }]
});
assert.match(root.innerHTML, /存在预占<\/span><strong>1<\/strong>/);
assert.match(root.innerHTML, /可售为零<\/span><strong>1<\/strong>/);
window.MengshixianAdminPageSummary.render('orders', { orders: [], loadStates: { orders: 'failed' } });
assert.match(root.innerHTML, /暂不可用/);
assert.doesNotMatch(root.innerHTML, /<strong>0<\/strong>/);
window.MengshixianAdminPageSummary.render('orders', { orders: [], loadStates: { orders: 'loading' } });
assert.match(root.innerHTML, /正在读取/);
console.log('admin page summary derives values from loaded records: passed');
