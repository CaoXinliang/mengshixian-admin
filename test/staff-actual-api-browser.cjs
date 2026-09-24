// Same-process staff/browser acceptance. Only the persistence adapter is in memory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createReceiptFixture } = require('./support/receipt-flow-fixture.cjs');

module.exports = async function staffActualApiBrowser({ send, evaluate, pause, socket }) {
  const fixture = await createReceiptFixture();
  const tokenKey = 'mengshixian_admin_token';
  const binding = 'localStaffApi';
  const base = 'http://127.0.0.1:8765/';
  const operator = {
    username: 'receipt-staff-operator-local',
    displayName: '本地测试运营',
    phone: '13900139001',
    password: 'receipt-staff-password-local-only',
    role: 'operator',
    status: 'active'
  };
  const resetPassword = 'reset-staff-password-local-only';
  const ownPassword = 'changed-staff-password-local-only';
  let requestSequence = 0;
  let failNextLogout = false;
  const dispatch = (action, payload = {}) => fixture.app.dispatch({
    action, payload, requestId: `staff-browser-${++requestSequence}`
  });
  const waitFor = async (expression) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if (await evaluate(expression)) return; } catch (_) { /* navigation changes execution context */ }
      await pause(50);
    }
    throw new Error(`Staff browser condition not met: ${expression}`);
  };
  const capture = async name => {
    const directory = path.join(__dirname, '..', 'outputs', 'staff-browser');
    fs.mkdirSync(directory, {recursive: true});
    const image = await send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
    fs.writeFileSync(path.join(directory, name), Buffer.from(image.data, 'base64'));
  };
  const handler = async ({ data }) => {
    const event = JSON.parse(data);
    if (event.method !== 'Runtime.bindingCalled' || event.params.name !== binding) return;
    const input = JSON.parse(event.params.payload);
    let response;
    try {
      if (input.action === 'admin.logout' && failNextLogout) {
        failNextLogout = false;
        throw Object.assign(new Error('本地模拟退出连接中断'), {code: 'LOCAL_NETWORK_FAILURE'});
      }
      const result = await dispatch(input.action, input.payload);
      response = result.ok
        ? { id: input.id, data: result.data }
        : { id: input.id, error: result.error };
    } catch (error) {
      response = { id: input.id, error: { code: error.code || 'LOCAL_BRIDGE_ERROR', message: error.message } };
    }
    try {
      await send('Runtime.evaluate', {
        expression: `window.__resolveLocalStaff(${JSON.stringify(response)})`,
        contextId: event.params.executionContextId
      });
    } catch (error) {
      if (!/Cannot find context with specified id/.test(error.message)) throw error;
    }
  };

  socket.addEventListener('message', handler);
  await send('Runtime.enable');
  await send('Network.setBlockedURLs', { urls: ['*api-client.js*', '*static.cloudbase.net*'] });
  await send('Runtime.addBinding', { name: binding });
  const script = await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    (() => {
      const tokenKey = ${JSON.stringify(tokenKey)};
      const pending = new Map();
      let sequence = 0;
      const getToken = () => sessionStorage.getItem(tokenKey) || '';
      const setToken = token => token ? sessionStorage.setItem(tokenKey, token) : sessionStorage.removeItem(tokenKey);
      window.__resolveLocalStaff = response => {
        const task = pending.get(response.id);
        if (!task) return;
        pending.delete(response.id);
        if (response.error) {
          const error = Object.assign(new Error(response.error.message), { code: response.error.code });
          if (['ADMIN_SESSION_EXPIRED', 'ADMIN_UNAUTHORIZED'].includes(error.code)) setToken('');
          task.reject(error);
        } else task.resolve(response.data);
      };
      window.MengshixianAdminApi = {
        config: { envId: 'local-memory-only' }, getToken, setToken,
        clearSession: () => setToken(''),
        call: (action, payload = {}) => new Promise((resolve, reject) => {
          const id = ++sequence;
          pending.set(id, { resolve, reject });
          window.localStaffApi(JSON.stringify({
            id, action,
            payload: { ...payload, adminToken: payload.adminToken === undefined ? getToken() : payload.adminToken }
          }));
        })
      };
    })();
  ` });

  try {
    await send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
    // The shared Edge tab may still hold a token from an earlier isolated check.
    await evaluate(`sessionStorage.removeItem(${JSON.stringify(tokenKey)})`);
    await send('Page.navigate', { url: `${base}login.html` });
    await waitFor("Boolean(document.querySelector('#loginForm')) && location.pathname.endsWith('/login.html')");
    assert.equal(await evaluate(`sessionStorage.getItem(${JSON.stringify(tokenKey)})`), null);

    // The fixture has already bootstrapped the owner; use that real local session for page setup.
    await evaluate(`MengshixianAdminApi.setToken(${JSON.stringify(fixture.adminToken)})`);
    await send('Page.navigate', { url: `${base}access.html` });
    await waitFor("Boolean(document.querySelector('#staffPage [data-staff-action=create]'))");
    await evaluate(`(() => {
      document.querySelector('#staffPage [data-staff-action=create]').click();
      const form = document.querySelector('[data-staff-form=create]');
      form.elements.username.value = ${JSON.stringify(operator.username)};
      form.elements.displayName.value = ${JSON.stringify(operator.displayName)};
      form.elements.phone.value = ${JSON.stringify(operator.phone)};
      form.elements.password.value = ${JSON.stringify(operator.password)};
      form.elements.role.value = 'operator';
      form.elements.status.value = 'active';
      form.requestSubmit();
    })()`);
    await waitFor("Boolean(document.querySelector('#staffPage [role=alertdialog]'))");
    assert.match(await evaluate("document.querySelector('#staffPage [role=alertdialog]').textContent"), /本地测试运营.*运营/);
    await evaluate("document.querySelector('#staffPage [data-staff-action=confirm]').click()");
    await waitFor(`Array.from(document.querySelectorAll('#staffPage [data-staff-select]')).some(item => item.textContent.includes(${JSON.stringify(operator.username)}))`);
    const created = await dispatch('admin.adminUsers.list', { adminToken: fixture.adminToken });
    assert.equal(created.ok, true);
    const staff = created.data.rows.find(row => row.username === operator.username);
    assert.equal(staff?.role, 'operator');
    assert.equal(staff.phoneVerificationStatus, 'unverified', '登记手机号不能冒充真实验证');

    await evaluate(`Array.from(document.querySelectorAll('#staffPage [data-staff-select]'))
      .find(item => item.textContent.includes(${JSON.stringify(operator.username)})).click()`);
    await evaluate("document.querySelector('#staffPage [data-staff-action=edit]').click()");
    await evaluate(`(() => {
      const form = document.querySelector('[data-staff-form=update]');
      form.elements.displayName.value = '本地测试运营已编辑';
      form.elements.phone.value = '13700137002';
      form.requestSubmit();
    })()`);
    await waitFor("Boolean(document.querySelector('#staffPage [role=alertdialog]'))");
    await evaluate("document.querySelector('#staffPage [data-staff-action=confirm]').click()");
    await waitFor("document.querySelector('#staffPage .staff-detail')?.textContent.includes('本地测试运营已编辑')");
    const edited = await dispatch('admin.adminUsers.list', { adminToken: fixture.adminToken });
    assert.equal(edited.data.rows.find(row => row.id === staff.id).phoneVerificationStatus, 'unverified');

    await evaluate("document.querySelector('#staffPage [data-staff-action=edit]').click()");
    await evaluate("(() => { const form = document.querySelector('[data-staff-form=update]'); form.elements.status.value = 'disabled'; form.requestSubmit(); })()");
    await waitFor("Boolean(document.querySelector('#staffPage [role=alertdialog]'))");
    await evaluate("document.querySelector('#staffPage [data-staff-action=confirm]').click()");
    await waitFor("document.querySelector('#staffPage .staff-detail')?.textContent.includes('已停用')");
    const disabledLogin = await dispatch('admin.login', { username: operator.username, password: operator.password });
    assert.equal(disabledLogin.ok, false, '停用后不能继续登录');

    await evaluate("document.querySelector('#staffPage [data-staff-action=edit]').click()");
    await evaluate("(() => { const form = document.querySelector('[data-staff-form=update]'); form.elements.status.value = 'active'; form.requestSubmit(); })()");
    await waitFor("Boolean(document.querySelector('#staffPage [role=alertdialog]'))");
    await evaluate("document.querySelector('#staffPage [data-staff-action=confirm]').click()");
    await waitFor("document.querySelector('#staffPage .staff-detail')?.textContent.includes('状态启用')");

    await evaluate("document.querySelector('#staffPage [data-staff-action=reset]').click()");
    await evaluate(`(() => {
      const form = document.querySelector('[data-staff-form=reset-password]');
      form.elements.newPassword.value = ${JSON.stringify(resetPassword)};
      form.elements.confirmPassword.value = ${JSON.stringify(resetPassword)};
      form.requestSubmit();
    })()`);
    await waitFor("Boolean(document.querySelector('#staffPage [role=alertdialog]'))");
    await evaluate("document.querySelector('#staffPage [data-staff-action=confirm]').click()");
    await waitFor("Boolean(document.querySelector('#staffPage .staff-detail'))");
    const oldPasswordLogin = await dispatch('admin.login', { username: operator.username, password: operator.password });
    assert.equal(oldPasswordLogin.ok, false, '重置后原密码不能登录');

    await evaluate("document.querySelector('#adminAccountLogout').click()");
    await waitFor(`location.pathname.endsWith('/login.html') && !sessionStorage.getItem(${JSON.stringify(tokenKey)})`);
    await waitFor("document.readyState === 'complete' && Boolean(document.querySelector('#loginForm'))");
    await evaluate(`(() => {
      const form = document.querySelector('#loginForm');
      form.elements.username.value = ${JSON.stringify(operator.username)};
      form.elements.password.value = ${JSON.stringify(resetPassword)};
      form.requestSubmit();
    })()`);
    await waitFor(`location.pathname.endsWith('/index.html') && Boolean(sessionStorage.getItem(${JSON.stringify(tokenKey)})) && Boolean(document.querySelector('#adminAccountLogout'))`);
    const operatorToken = await evaluate(`sessionStorage.getItem(${JSON.stringify(tokenKey)})`);
    assert.notEqual(operatorToken, fixture.adminToken);

    await send('Page.navigate', { url: `${base}access.html` });
    await waitFor("Boolean(document.querySelector('#staffPage .staff-detail'))");
    assert.match(await evaluate("document.querySelector('#staffPage').textContent"), /本地测试运营[\s\S]*角色运营/);
    assert.equal(await evaluate("Boolean(document.querySelector('#staffPage [data-staff-action=create]'))"), false);
    await capture('operator-own-profile.png');
    const denied = await evaluate("MengshixianAdminApi.call('admin.staff.create', {}).then(() => 'ALLOWED', error => error.code)");
    assert.equal(denied, 'ADMIN_FORBIDDEN', '运营直调工作人员写接口必须由实际 API 拒绝');

    await send('Page.navigate', { url: `${base}orders.html` });
    await waitFor(`Array.from(document.querySelectorAll('#ordersTable [data-open-receipts]')).some(item => item.dataset.openReceipts === ${JSON.stringify(fixture.order._id)})`);
    assert.match(await evaluate("document.querySelector('#ordersTable').textContent"), /未收款/);
    await evaluate(`(() => {
      window.confirm = () => true;
      Array.from(document.querySelectorAll('#ordersTable [data-transition-order]'))
        .find(item => item.dataset.transitionOrder === ${JSON.stringify(fixture.order._id)}).click();
    })()`);
    await waitFor("document.querySelector('#ordersTable').textContent.includes('拣货中')");
    const transitioned = await dispatch('admin.orders.list', { adminToken: operatorToken });
    assert.equal(transitioned.ok, true);
    assert.equal(transitioned.data.rows.find(row => row._id === fixture.order._id)?.status, 'picking');

    await evaluate(`Array.from(document.querySelectorAll('#ordersTable [data-open-receipts]'))
      .find(item => item.dataset.openReceipts === ${JSON.stringify(fixture.order._id)}).click()`);
    await waitFor("Boolean(document.querySelector('[data-receipt-form]')) && !document.querySelector('[data-receipt-form]').hidden");
    await evaluate(`(() => {
      const form = document.querySelector('[data-receipt-form]');
      form.elements.amountYuan.value = '30.00';
      form.elements.receivedLocal.value = '2026-09-07T19:00';
      form.elements.method.value = 'bank_transfer';
      form.elements.note.value = '仅本地工作人员实际 API 测试';
      window.confirm = () => true;
      form.requestSubmit();
    })()`);
    await waitFor("document.querySelector('[data-receipt-summary]').textContent.includes('70.00')");
    const history = await dispatch('admin.orders.receipts.list', { adminToken: operatorToken, orderId: fixture.order._id });
    assert.equal(history.ok, true);
    assert.equal(history.data.receivedAmountCent, 3000);
    assert.equal(history.data.outstandingAmountCent, 7000);
    assert.equal(history.data.rows.length, 1);
    assert.equal(history.data.orderStatus, 'picking', '收款不能改变履约状态');

    await send('Page.navigate', { url: `${base}access.html` });
    await waitFor("Boolean(document.querySelector('#staffPage [data-staff-action=own-password]'))");
    await evaluate("document.querySelector('#staffPage [data-staff-action=own-password]').click()");
    await evaluate(`(() => {
      const form = document.querySelector('[data-staff-form=own-password]');
      form.elements.currentPassword.value = ${JSON.stringify(resetPassword)};
      form.elements.newPassword.value = ${JSON.stringify(ownPassword)};
      form.elements.confirmPassword.value = ${JSON.stringify(ownPassword)};
      form.requestSubmit();
    })()`);
    await waitFor("Boolean(document.querySelector('#staffPage [role=alertdialog]'))");
    await evaluate("document.querySelector('#staffPage [data-staff-action=confirm]').click()");
    await waitFor(`location.pathname.endsWith('/login.html') && !sessionStorage.getItem(${JSON.stringify(tokenKey)})`);
    const passwordReplay = await dispatch('admin.me', { adminToken: operatorToken });
    assert.equal(passwordReplay.ok, false, '本人改密后旧令牌必须失效');
    await waitFor("document.readyState === 'complete' && Boolean(document.querySelector('#loginForm'))");
    await evaluate(`(() => {
      const form = document.querySelector('#loginForm');
      form.elements.username.value = ${JSON.stringify(operator.username)};
      form.elements.password.value = ${JSON.stringify(ownPassword)};
      form.requestSubmit();
    })()`);
    await waitFor(`location.pathname.endsWith('/index.html') && Boolean(sessionStorage.getItem(${JSON.stringify(tokenKey)}))`);
    const finalToken = await evaluate(`sessionStorage.getItem(${JSON.stringify(tokenKey)})`);
    await waitFor("Boolean(document.querySelector('#adminAccountLogout'))");
    failNextLogout = true;
    await evaluate("document.querySelector('#adminAccountLogout').click()");
    await waitFor("document.querySelector('#globalMessage')?.textContent.includes('退出未完成')");
    assert.equal(await evaluate(`sessionStorage.getItem(${JSON.stringify(tokenKey)})`), finalToken, '退出接口故障不得假装已经退出');
    const stillSignedIn = await dispatch('admin.me', {adminToken: finalToken});
    assert.equal(stillSignedIn.ok, true, '退出失败后会话仍有效，页面必须允许重试');
    await evaluate("document.querySelector('#adminAccountLogout').click()");
    await waitFor(`location.pathname.endsWith('/login.html') && !sessionStorage.getItem(${JSON.stringify(tokenKey)})`);
    const replay = await dispatch('admin.me', { adminToken: finalToken });
    assert.equal(replay.ok, false, '退出后旧令牌不能再访问实际 API');
    assert.equal(replay.error.code, 'ADMIN_SESSION_EXPIRED');
    await send('Page.navigate', { url: `${base}access.html` });
    await waitFor("location.pathname.endsWith('/login.html')");
    assert.equal(await evaluate("Boolean(document.querySelector('#loginForm'))"), true);
    await capture('reopen-requires-login.png');
    console.log('Local actual API staff browser: create, edit, disable, reset, login, order, partial receipt, forbidden write, own password and revoked logout session passed');
  } finally {
    socket.removeEventListener('message', handler);
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: script.identifier });
    await send('Runtime.removeBinding', { name: binding });
  }
};
