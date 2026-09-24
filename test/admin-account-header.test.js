const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

function makeElement() {
  const listeners = [];
  return {
    innerHTML: '', textContent: '', disabled: false, value: '', dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(type, handler, options) { listeners.push({ type, handler, capture: options === true || !!(options && options.capture) }); },
    insertAdjacentHTML() {},
    async click() {
      let stopped = false;
      const event = { preventDefault() {}, stopImmediatePropagation() { stopped = true; } };
      for (const listener of listeners.filter((item) => item.type === 'click').sort((a, b) => Number(b.capture) - Number(a.capture))) {
        if (stopped) break;
        await listener.handler(event);
      }
    },
    listenerCount(type) { return listeners.filter((item) => item.type === type).length; }
  };
}

function loadShell(pageId = 'overview') {
  const nodes = Object.fromEntries(['adminSidebar', 'adminHeader', 'globalMessage', 'adminPageSearch', 'adminUser', 'adminConnectionState', 'logoutButton', 'adminAccountLogout', 'workflowContent', 'moduleEyebrow', 'panelTitle', 'reviewSearch', 'reviewProducts', 'reviewDetail'].map((id) => [id, makeElement()]));
  const document = { getElementById: (id) => nodes[id] || null, querySelector: (selector) => nodes[selector.slice(1)] || null };
  const page = { id: pageId, title: '商品页面', groupId: 'catalog', groupLabel: '商品中心', description: '核对商品资料' };
  const window = {
    PAGE_NAME: pageId,
    MengshixianAdminPages: { pages: { [pageId]: page }, groups: [{ id: page.groupId, label: page.groupLabel, pages: [[pageId, page.title, `${pageId}.html`]] }] },
    location: { search: '', replaced: '', replace(url) { this.replaced = url; }, assign() {} }
  };
  vm.runInNewContext(read('admin-shell.js'), { window, document });
  return { window, document, nodes };
}

test('公共顶栏显示服务端确认的身份、固定角色和手机号验证状态', () => {
  const { window, nodes } = loadShell();
  assert.match(nodes.adminHeader.innerHTML, /id="adminAccountLogout"/);
  window.MengshixianAdminAccount.setAdmin({ displayName: '小李', username: 'li', role: 'operator', phoneMasked: '138****8000', phoneVerificationStatus: 'unverified' });
  assert.match(nodes.adminUser.textContent, /小李.*运营.*138\*\*\*\*8000.*手机号未验证/);
  window.MengshixianAdminAccount.setAdmin({ displayName: '主管', role: 'super_admin', phoneVerificationStatus: 'verified' });
  assert.match(nodes.adminUser.textContent, /主管.*超级管理员.*手机号已验证/);
});

test('退出失败保留会话并可重试；重复绑定和旧按钮不会重复请求', async () => {
  const { window, nodes } = loadShell();
  const messages = [];
  let calls = 0;
  let cleared = 0;
  const call = async (action) => {
    assert.equal(action, 'admin.logout');
    calls += 1;
    if (calls === 1) throw new Error('网络中断');
    return { loggedOut: true };
  };
  const options = { call, clearSession: () => { cleared += 1; }, message: (text, error) => messages.push({ text, error }) };
  window.MengshixianAdminAccount.bindLogout(options);
  window.MengshixianAdminAccount.bindLogout(options);
  assert.equal(nodes.adminAccountLogout.listenerCount('click'), 1);
  assert.equal(nodes.logoutButton.listenerCount('click'), 1);
  let oldHandlerRan = false;
  nodes.logoutButton.addEventListener('click', () => { oldHandlerRan = true; });
  await nodes.adminAccountLogout.click();
  assert.equal(cleared, 0);
  assert.equal(window.location.replaced, '');
  assert.match(messages.at(-1).text, /未完成.*重试/);
  assert.equal(messages.at(-1).error, true);
  assert.equal(nodes.adminAccountLogout.disabled, false);
  await nodes.logoutButton.click();
  assert.equal(calls, 2);
  assert.equal(cleared, 1);
  assert.equal(oldHandlerRan, false);
  assert.equal(window.location.replaced, 'login.html');
});

test('已失效会话可本地清理；响应期间两处入口只发一次退出请求', async () => {
  const { window, nodes } = loadShell();
  let finish;
  let calls = 0;
  let cleared = 0;
  const pending = new Promise((resolve, reject) => { finish = { resolve, reject }; });
  window.MengshixianAdminAccount.bindLogout({
    call: async () => { calls += 1; return pending; },
    clearSession: () => { cleared += 1; },
    message: () => { throw new Error('已失效会话不应报告网络故障'); }
  });
  const first = nodes.adminAccountLogout.click();
  await nodes.logoutButton.click();
  assert.equal(calls, 1);
  assert.equal(nodes.adminAccountLogout.disabled, true);
  const error = new Error('会话过期'); error.code = 'ADMIN_SESSION_EXPIRED';
  finish.reject(error);
  await first;
  assert.equal(cleared, 1);
  assert.equal(window.location.replaced, 'login.html');
});

test('两张商品独立页仅在会话失效时清凭据；临时网络故障保留会话并提示刷新', async () => {
  for (const pageId of ['productWorkflow', 'productReview']) {
    for (const code of [undefined, 'ADMIN_SESSION_EXPIRED']) {
      const { window, document, nodes } = loadShell(pageId);
      let cleared = 0;
      const actions = [];
      window.MengshixianAdminApi = {
        call: async (action) => { actions.push(action); throw Object.assign(new Error('服务暂不可用'), {code}); },
        clearSession: () => { cleared += 1; }
      };
      window.MengshixianProductData = { create: () => ({}) };
      window.MengshixianAdminPaging = {};
      vm.runInNewContext(read(pageId === 'productWorkflow' ? 'admin-product-workflow.js' : 'admin-product-review.js'), { window, document, URLSearchParams });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(actions, ['admin.me'], `${pageId} 不得在身份校验失败后读取业务资料`);
      assert.equal(cleared, code ? 1 : 0, `${pageId} 临时网络故障不能清除有效凭据`);
      assert.equal(window.location.replaced, code ? 'login.html' : '', `${pageId} 仅失效会话才返回登录页`);
      if (!code) assert.match(nodes.globalMessage.textContent, /刷新重试/);
    }
  }
});
