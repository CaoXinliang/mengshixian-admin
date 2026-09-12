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
    cloudbase,
    setTimeout,
    clearTimeout
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

  let readCalls = 0;
  const retriedReadWindow = loadClient({
    init: () => ({
      auth: { signInAnonymously: () => Promise.resolve({ data: {} }) },
      callFunction: () => {
        readCalls += 1;
        if (readCalls === 1) return Promise.reject(new Error('temporary transport failure'));
        return Promise.resolve({ result: { ok: true, data: { rows: [] }, error: null } });
      }
    })
  });
  await retriedReadWindow.MengshixianAdminApi.call('admin.products.list');
  assert.equal(readCalls, 2, 'read-only actions may retry one transport failure');

  let unsafeWriteCalls = 0;
  const unsafeWriteWindow = loadClient({
    init: () => ({
      auth: { signInAnonymously: () => Promise.resolve({ data: {} }) },
      callFunction: () => { unsafeWriteCalls += 1; return Promise.reject(new Error('response lost after write')); }
    })
  });
  await assert.rejects(() => unsafeWriteWindow.MengshixianAdminApi.call('admin.products.upsert', { name: '商品' }), /response lost/);
  assert.equal(unsafeWriteCalls, 1, 'non-idempotent writes must never be replayed blindly');

  let safeWriteCalls = 0;
  const safeWritePayloads = [];
  const safeWriteWindow = loadClient({
    init: () => ({
      auth: { signInAnonymously: () => Promise.resolve({ data: {} }) },
      callFunction: ({ data }) => {
        safeWriteCalls += 1;
        safeWritePayloads.push(data.payload);
        if (safeWriteCalls === 1) return Promise.reject(new Error('temporary transport failure'));
        return Promise.resolve({ result: { ok: true, data: { idempotent: true }, error: null } });
      }
    })
  });
  await safeWriteWindow.MengshixianAdminApi.call('admin.orders.notes.add', { id: 'order-1', note: '备注', idempotencyKey: 'note-stable-1' });
  assert.equal(safeWriteCalls, 2, 'writes with a stable idempotency key may retry once');
  assert.deepEqual(safeWritePayloads.map((payload) => payload.idempotencyKey), ['note-stable-1', 'note-stable-1'], 'write retry must reuse the original idempotency key');

  let unsupportedKeyCalls = 0;
  const unsupportedKeyWindow = loadClient({
    init: () => ({
      auth: { signInAnonymously: () => Promise.resolve({ data: {} }) },
      callFunction: () => { unsupportedKeyCalls += 1; return Promise.reject(new Error('response lost after unsupported write')); }
    })
  });
  await assert.rejects(
    () => unsupportedKeyWindow.MengshixianAdminApi.call('admin.reviews.review', { id: 'review-1', decision: 'approved', idempotencyKey: 'client-only-key' }),
    /response lost/
  );
  assert.equal(unsupportedKeyCalls, 1, 'a client key is not retry-safe until that backend action enforces idempotency');

  let timedWriteCalls = 0;
  const timeoutWindow = loadClient({
    init: () => ({
      auth: { signInAnonymously: () => Promise.resolve({ data: {} }) },
      callFunction: () => { timedWriteCalls += 1; return new Promise(() => {}); }
    })
  });
  timeoutWindow.MENGSHIXIAN_ADMIN_CONFIG.timeoutMs = 5;
  await assert.rejects(
    () => timeoutWindow.MengshixianAdminApi.call('admin.products.upsert', { name: '超时商品' }),
    (error) => error && error.code === 'REQUEST_TIMEOUT'
  );
  assert.equal(timedWriteCalls, 1, 'timed-out non-idempotent writes must not be replayed');

  let hangingAuthCalls = 0;
  const authTimeoutWindow = loadClient({
    init: () => ({
      auth: { signInAnonymously: () => { hangingAuthCalls += 1; return new Promise(() => {}); } },
      callFunction: () => Promise.reject(new Error('must not call function before auth is ready'))
    })
  });
  authTimeoutWindow.MENGSHIXIAN_ADMIN_CONFIG.timeoutMs = 5;
  await assert.rejects(
    () => authTimeoutWindow.MengshixianAdminApi.call('admin.products.upsert', { name: '认证超时商品' }),
    (error) => error && error.code === 'REQUEST_TIMEOUT'
  );
  assert.equal(hangingAuthCalls, 1, 'authentication timeout must also be bounded and must not replay an unsafe write');

  let timedReadCalls = 0;
  const timeoutReadWindow = loadClient({
    init: () => ({
      auth: { signInAnonymously: () => Promise.resolve({ data: {} }) },
      callFunction: () => {
        timedReadCalls += 1;
        if (timedReadCalls === 1) return new Promise(() => {});
        return Promise.resolve({ result: { ok: true, data: { rows: [] }, error: null } });
      }
    })
  });
  timeoutReadWindow.MENGSHIXIAN_ADMIN_CONFIG.timeoutMs = 5;
  await timeoutReadWindow.MengshixianAdminApi.call('admin.orders.list');
  assert.equal(timedReadCalls, 2, 'timed-out reads may retry once');

  console.log('admin api client auth, timeout and replay-safety tests: passed');
}

run().catch((error) => { console.error(error); process.exit(1); });
