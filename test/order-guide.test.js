const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'admin-order-guide.js'), 'utf8');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

function setup(page, search = '') {
  const listeners = {};
  const elements = {};
  const element = (id) => elements[id] ||= {
    value: '', textContent: '', innerHTML: '', dataset: {},
    addEventListener(type, listener) { listeners[`${id}:${type}`] = listener; }
  };
  const tbodyId = page === 'orders' ? 'ordersTable' : 'refundsTable';
  const tbody = element(tbodyId);
  const calls = [];
  const window = {
    PAGE_NAME: page,
    location: { search },
    MengshixianAdminTables: {
      render(state) {
        calls.push(state);
        const rows = page === 'orders' ? state.orders : state.refunds;
        tbody.rows = rows.map((row) => {
          const cells = Array.from({ length: page === 'orders' ? 8 : 7 }, () => ({
            textContent: '', notes: [],
            querySelector(selector) { return selector === '.badge' ? this.badge : null; },
            appendChild(node) { this.notes.push(node); }
          }));
          cells[1].textContent = page === 'orders' ? row.orderNo : row.refundNo;
          cells[page === 'orders' ? 3 : 5].badge = { textContent: '' };
          return { querySelectorAll: () => cells, querySelector: () => null, cells };
        });
      }
    }
  };
  tbody.querySelectorAll = () => tbody.rows || [];
  const document = {
    getElementById: element,
    addEventListener(type, listener) { listeners[type] = listener; },
    createElement: () => ({ className: '', textContent: '' })
  };
  vm.runInNewContext(source, { window, document, URLSearchParams });
  element('orderFilterBtn').click = () => {
    window.__orderFilters = { status: element('orderFilterStatus').value, keyword: element('orderFilterKeyword').value };
    window.MengshixianAdminTables.render(calls.at(-1));
  };
  return { window, element, listeners, calls, tbody };
}

for (const status of ['pending_confirmation', 'picking', 'shipping']) {
  const ui = setup('orders', `?status=${status}`);
  assert.equal(ui.window.MengshixianAdminOrderGuide.knownOrderStatus(`?status=${status}`), status);
  assert.equal(ui.element('orderFilterStatus').value, status);
  ui.window.MengshixianAdminTables.render({ orders: [
    { orderNo: 'O1', status: 'pending_confirmation' },
    { orderNo: 'O2', status: 'picking' },
    { orderNo: 'O3', status: 'shipping' }
  ] });
  assert.equal(ui.window.__orderFilters.status, status, '工作台链接须触发原有筛选按钮');
  assert.equal(ui.calls.length, 2, '首次渲染后只触发一次筛选');
  assert.match(ui.element('orderGuideCards').innerHTML, /待确认[\s\S]*<strong>1<\/strong>/);
  assert.match(ui.tbody.rows[0].cells[7].notes[0].textContent, /开始拣货/);
}

const invalid = setup('orders', '?status=cancelled');
assert.equal(invalid.window.MengshixianAdminOrderGuide.knownOrderStatus('?status=cancelled'), '');
assert.equal(invalid.window.MengshixianAdminOrderGuide.knownOrderStatus('?status=%3Cscript%3E'), '');
invalid.window.MengshixianAdminTables.render({ orders: [] });
assert.equal(invalid.calls.length, 1, '非允许状态不应应用查询筛选');

const refund = setup('refunds');
const refundRows = [
  { refundNo: 'R1', status: 'requested' },
  { refundNo: 'R2', status: 'processing' },
  { refundNo: 'R3', status: 'succeeded' },
  { refundNo: 'R4', status: 'rejected' }
];
refund.window.MengshixianAdminTables.render({ refunds: refundRows });
assert.equal(refund.calls.at(-1).refunds.length, 4);
assert.match(refund.element('refundGuideCards').innerHTML, /待审核[\s\S]*<strong>1<\/strong>/);
refund.element('refundGuideStatus').value = 'processing';
refund.listeners['refundGuideStatus:change']();
assert.equal(refund.calls.at(-1).refunds.length, 1);
assert.equal(refund.calls.at(-1).refunds[0].refundNo, 'R2');
assert.equal(refund.tbody.rows[0].cells[5].badge.textContent, '退款处理中');
assert.match(refund.tbody.rows[0].cells[6].notes[0].textContent, /不能视为到账/);
refund.listeners.click({ target: { closest: () => ({ dataset: { guideStatus: 'succeeded' } }) } });
assert.equal(refund.calls.at(-1).refunds[0].refundNo, 'R3');
assert.equal(refund.tbody.rows[0].cells[5].badge.textContent, '已退款');

refund.element('globalMessage').textContent = '后台数据加载失败：服务异常';
refund.window.MengshixianAdminTables.render({ refunds: [] });
assert.equal(refund.element('refundGuideCards').innerHTML, '', '加载失败不能显示误导性零待办');
assert.match(refund.element('refundGuideMessage').textContent, /数据加载失败/);

for (const page of ['orders', 'refunds']) {
  const html = read(`${page}.html`);
  assert.match(html, /admin-order-guide\.css/);
  assert.match(html, /admin-page-summary\.js[\s\S]*admin-order-guide\.js[\s\S]*app\.js/);
}
console.log('order/refund guide uses loaded records and allowed order links: passed');
