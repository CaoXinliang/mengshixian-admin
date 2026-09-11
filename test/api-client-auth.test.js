const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.resolve(__dirname, '../api-client.js'), 'utf8');
function loadClient(cloudbase) {
  const session = new Map();
  const window = {
    MENGSHIXIAN_ADMIN_CONFIG: { provider: 'cloudbase', envId: 'test-env', functionName: 'api' },
    sessionStorage: { getItem: (key) => session.get(key) || '', setItem: (key, value) => session.set(key, value), removeItem: (key) => session.delete(key) },
    cloudbase
  };
  window.window = window;
  vm.runInNewContext(source, { window, Promise, Date, Math, Error, JSON });
  return window;
}

async function run() {
  const legacyWindow = loadClient({
    init: () => ({
      auth: () => ({ signInAnonymously: () => Promise.reject(new Error('[PERMISSION_DENIED] Permission denied')) }),
      callFunction: () => Promise.reject(new Error('should not call function when anonymous login fails'))
    })
  });
  await assert.rejects(
    () => legacyWindow.MengshixianAdminApi.call('admin.login', { username: 'owner', password: 'not-sent' }),
    /开启匿名登录，并把当前后台域名加入 Web 安全域名/
  );

  let calls = 0;
  const modernWindow = loadClient({
    init: (options) => {
      assert.equal(options.region, 'ap-shanghai');
      return {
        auth: { signInAnonymously: () => Promise.resolve({ data: { session: {} }, error: null }) },
        callFunction: ({ parse }) => {
          calls += 1;
          assert.equal(parse, true);
          return Promise.resolve({ result: JSON.stringify({ ok: true, data: { service: 'api' }, error: null, requestId: 'test' }) });
        }
      };
    }
  });
  const result = await modernWindow.MengshixianAdminApi.call('health', {});
  assert.equal(result.service, 'api');
  assert.equal(calls, 1);

  const modernErrorWindow = loadClient({
    init: () => ({
      auth: { signInAnonymously: () => Promise.resolve({ data: null, error: { code: 'PERMISSION_DENIED', message: 'Permission denied' } }) },
      callFunction: () => Promise.reject(new Error('should not call function when anonymous login fails'))
    })
  });
  await assert.rejects(
    () => modernErrorWindow.MengshixianAdminApi.call('health', {}),
    /开启匿名登录，并把当前后台域名加入 Web 安全域名/
  );
  console.log('admin api client CloudBase v2/v3 auth tests: passed');
}

run().catch((error) => { console.error(error); process.exit(1); });
