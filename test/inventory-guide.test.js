const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'admin-inventory-guide.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'inventory.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
assert.match(html, /admin-inventory-guide\.css/);
assert.match(html, /app\.js"><\/script>[\s\S]*admin-inventory-guide\.js/);
assert.match(html, /id="inventoryKeyword"/);
assert.doesNotMatch(script, /admin\.inventory\.adjust/, '引导脚本不得接管库存写入');
assert.match(app, /admin\.inventory\.adjust[^\n]*warehouseId: form\.get\('warehouseId'\)[^\n]*skuId: form\.get\('skuId'\)[^\n]*idempotencyKey: newIdempotencyKey\(\)/,
  '库存写入必须继续由原表单生成幂等键');

class Element {
  constructor(tag = 'div') {
    this.tag = tag;
    this.children = [];
    this.handlers = {};
    this.dataset = {};
    this.value = '';
    this.textContent = '';
    this.classList = {
      add: () => {},
      remove: () => {},
      toggle: () => {}
    };
  }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren() { this.children = []; }
  setAttribute() {}
  insertAdjacentElement() {}
  addEventListener(name, handler) { this.handlers[name] = handler; }
  closest(selector) { return selector === 'label' ? this.parentLabel : null; }
}

const warehouseInput = new Element('input');
const skuInput = new Element('input');
const amount = new Element('input');
const reason = new Element('input');
for (const input of [warehouseInput, skuInput, amount, reason]) {
  input.parentLabel = new Element('label');
  input.parentLabel.firstChild = { textContent: '' };
}
const submitButton = new Element('button');
const hint = new Element('p');
const form = new Element('form');
const fields = {
  'input[name="warehouseId"]': warehouseInput,
  'input[name="skuId"]': skuInput,
  'input[name="change"]': amount,
  'input[name="reason"]': reason,
  '.muted': hint,
  'button[type="submit"], button.primary': submitButton
};
form.querySelector = (selector) => fields[selector];
const keyword = new Element('input');
const status = new Element('p');
const globalMessage = new Element('p');
const original = new Element();
const matches = new Element();
const rows = new Element();
const elements = {
  inventoryForm: form,
  inventoryKeyword: keyword,
  inventoryGuideStatus: status,
  globalMessage,
  inventoryOriginalTable: original,
  inventoryMatches: matches,
  inventoryMatchRows: rows
};
let opened = 0;
const document = {
  getElementById: (id) => elements[id],
  createElement: (tag) => new Element(tag),
  querySelector: (selector) => selector === '[data-add-form="#inventoryForm"]' ? { click: () => { opened += 1; } } : null
};
const fixtures = {
  'admin.inventory.list': [{ warehouseId: 'warehouse-1', skuId: 'sku-1', onHand: 20, reserved: 3, available: 17 }],
  'admin.warehouses.list': [{ _id: 'warehouse-1', name: '南山仓', status: 'active', address: '深圳南山' }],
  'admin.skus.list': [{ _id: 'sku-1', productId: 'product-1', specName: '500克', packageUnit: '每箱10包' }],
  'admin.products.list': [{ _id: 'product-1', name: '鲜虾仁' }]
};
const readActions = [];
let confirmation = false;
let confirmationText = '';
let observeMessage;
const window = {
  MengshixianAdminApi: { call: () => { throw new Error('测试中不允许访问云端'); } },
  MengshixianAdminPaging: { listAll: async (_call, action) => {
    readActions.push(action);
    return { rows: fixtures[action] };
  } },
  confirm: (message) => { confirmationText = message; return confirmation; },
  MutationObserver: class { constructor(callback) { observeMessage = callback; } observe() {} }
};

async function main() {
  vm.runInNewContext(script, { window, document });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(readActions, Object.keys(fixtures), '只能读取库存、仓库、规格和商品列表');
  const guide = window.MengshixianAdminInventoryGuide;
  const entry = guide.buildEntries(fixtures['admin.inventory.list'], fixtures['admin.warehouses.list'],
    fixtures['admin.skus.list'], fixtures['admin.products.list'])[0];
  assert.equal(entry.productName, '鲜虾仁');
  assert.equal(entry.canAdjust, true);
  assert.equal(guide.filterEntries([entry], '鲜虾')[0], entry);
  assert.equal(guide.filterEntries([entry], '南山')[0], entry);
  assert.equal(guide.changeDescription(-2), '减少 2');
  assert.equal(guide.changeDescription(0), '');
  assert.equal(guide.changeDescription(1.5), '');
  assert.equal(guide.changeDescription(1000001), '');
  const missingName = guide.buildEntries(fixtures['admin.inventory.list'], fixtures['admin.warehouses.list'],
    fixtures['admin.skus.list'], [])[0];
  assert.equal(missingName.canAdjust, false, '找不到商品名称时不提供调整入口');
  assert.match(status.textContent, /共有 1 条/);
  assert.match(rows.children[0].children[0].textContent, /鲜虾仁 · 500克/);

  keyword.value = '虾仁';
  keyword.handlers.input();
  const button = rows.children[0].children[5].children[0];
  rows.handlers.click({ target: { closest: () => button } });
  assert.equal(opened, 1);
  assert.equal(warehouseInput.value, 'warehouse-1');
  assert.equal(skuInput.value, 'sku-1');

  amount.value = '-2';
  reason.value = '盘点修正';
  const event = () => ({ prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } });
  const cancelled = event();
  form.handlers.submit(cancelled);
  assert.equal(cancelled.prevented, true, '取消确认必须拦住原表单提交');
  assert.equal(cancelled.stopped, true);
  assert.match(confirmationText, /南山仓.*鲜虾仁.*减少 2/);
  confirmation = true;
  const approved = event();
  form.handlers.submit(approved);
  assert.equal(approved.prevented, false, '确认后由原表单处理，保留原幂等逻辑');
  assert.equal(approved.stopped, false);
  assert.equal(submitButton.disabled, true);
  const repeated = event();
  form.handlers.submit(repeated);
  assert.equal(repeated.prevented, true, '等待原请求返回期间不得重复提交');
  globalMessage.textContent = '服务暂时不可用';
  observeMessage();
  assert.equal(submitButton.disabled, false);
  amount.value = '0';
  const invalid = event();
  form.handlers.submit(invalid);
  assert.equal(invalid.prevented, true, '零数量不可进入原表单提交');
  console.log('inventory guide names, search, ID handoff and confirmation: passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
