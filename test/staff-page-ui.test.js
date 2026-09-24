const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'access.html'), 'utf8');
assert.match(html, /id="staffPage"/);
assert.match(html, /admin-staff-page\.js/);
assert.doesNotMatch(html, /id="adminUsersTable"|id="adminUserForm"/);

function loadPage() {
  const listeners = {};
  const host = {
    innerHTML: '',
    addEventListener(type, listener) { listeners[type] = listener; },
    dispatch(type, target, extra = {}) { return listeners[type]({ target, preventDefault() {}, ...extra }); }
  };
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'admin-staff-page.js'), 'utf8'), {
    window, document: { getElementById(id) { return id === 'staffPage' ? host : null; } },
    FormData: class { constructor(form) { this.form = form; } get(name) { return this.form.values[name]; } }
  });
  return { page: window.MengshixianStaffPage, host };
}

async function main() {
  const owner = { id: 'owner-1', displayName: '总管理员', role: 'super_admin', permissions: ['*'], phoneMasked: '138****8000', phoneVerificationStatus: 'unverified' };
  const operator = { id: 'operator-1', username: 'operator', displayName: '运营', role: 'operator', permissions: ['catalog.read'], phoneMasked: '139****9000', phoneVerificationStatus: 'unverified', status: 'active' };
  const calls = [];
  const messages = [];
  let rejectCreate = true;
  const call = async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'admin.adminUsers.list') return { rows: [owner, operator], total: 2 };
    if (action === 'admin.staff.create' && rejectCreate) throw new Error('本地创建失败');
    return { ...operator, id: 'created-1' };
  };
  const { page, host } = loadPage();
  assert.equal(typeof page.mount, 'function');
  await page.mount({ call, admin: owner, message: (...args) => messages.push(args) });
  assert.match(host.innerHTML, /新增工作人员/);
  assert.match(host.innerHTML, /超级管理员/);
  assert.match(host.innerHTML, /运营/);
  assert.match(host.innerHTML, /138\*\*\*\*8000/);
  assert.match(host.innerHTML, /operator-1/);
  assert.doesNotMatch(host.innerHTML, /密文|角色 ID（每行/);
  assert.equal(calls[0].action, 'admin.adminUsers.list');
  await host.dispatch('click', { closest(selector) { return selector === '[data-staff-select]' ? { getAttribute: () => operator.id } : null; } });
  assert.match(host.innerHTML, /139\*\*\*\*9000/);
  await host.dispatch('click', { closest(selector) { return selector === '[data-staff-action]' ? { getAttribute: () => 'create' } : null; } });
  assert.match(host.innerHTML, /<select name="role" required><option value="" selected>请选择角色/);
  assert.doesNotMatch(host.innerHTML, /name="roleIds"/);
  const form = { values: { username: 'new-operator', displayName: '新增运营', phone: '13700137000', password: 'local-password-123', role: 'operator', status: 'active' }, getAttribute: () => 'create' };
  await host.dispatch('submit', { closest: () => form });
  assert.match(host.innerHTML, /确认创建工作人员/);
  assert.equal(calls.filter(item => item.action === 'admin.staff.create').length, 0, '确认前不能写入');
  const confirm = { closest: selector => selector === '[data-staff-action]' ? { getAttribute: () => 'confirm' } : null };
  await host.dispatch('click', confirm);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(host.innerHTML, /本地创建失败/);
  assert.match(host.innerHTML, /role="alertdialog"/);
  assert.equal(calls.filter(item => item.action === 'admin.staff.create').length, 1);
  await host.dispatch('click', { closest: selector => selector === '[data-staff-action]' ? { getAttribute: () => 'cancel-confirm' } : null });
  assert.match(host.innerHTML, /value="new-operator"/);
  assert.match(host.innerHTML, /value="新增运营"/);
  rejectCreate = false;
  await host.dispatch('submit', { closest: () => form });
  await host.dispatch('click', confirm);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(item => item.action === 'admin.staff.create').length, 2);
  assert.ok(messages.some(item => item[0].includes('创建工作人员成功')));

  const refreshPage = loadPage();
  let listing = 0;
  let saved = 0;
  const refreshMessages = [];
  await refreshPage.page.mount({admin: owner, message: (...args) => refreshMessages.push(args), call: async action => {
    if (action === 'admin.adminUsers.list') {
      listing += 1;
      if (listing > 1) throw new Error('本地列表读取失败');
      return {rows: [owner], total: 1};
    }
    if (action === 'admin.staff.create') { saved += 1; return {id: 'saved-1'}; }
  }});
  await refreshPage.host.dispatch('click', {closest: selector => selector === '[data-staff-action]' ? {getAttribute: () => 'create'} : null});
  await refreshPage.host.dispatch('submit', {closest: () => form});
  await refreshPage.host.dispatch('click', confirm);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saved, 1);
  assert.match(refreshMessages.at(-1)[0], /已保存.*列表刷新失败.*不要重复提交/);
  assert.doesNotMatch(refreshPage.host.innerHTML, /role="alertdialog"/);

  const listCountBeforeOperator = calls.filter(item => item.action === 'admin.adminUsers.list').length;
  const limited = loadPage();
  await limited.page.mount({ call, admin: operator, message: () => {} });
  assert.match(limited.host.innerHTML, /修改我的密码/);
  assert.doesNotMatch(limited.host.innerHTML, /新增工作人员|重置.*密码|adminUsersTable/);
  assert.equal(calls.filter(item => item.action === 'admin.adminUsers.list').length, listCountBeforeOperator);
  console.log('Staff page public mount: owner list and fixed roles, operator self-only, safe visible projection');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
