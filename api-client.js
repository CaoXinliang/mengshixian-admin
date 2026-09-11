(function attachAdminApi(global) {
  const config = global.MENGSHIXIAN_ADMIN_CONFIG || {};
  let cloudApp;
  let cloudAuth;
  let signingIn;
  let anonymousReady = false;

  function getToken() { return global.sessionStorage.getItem('mengshixian_admin_token') || ''; }
  function setToken(token) {
    if (token) global.sessionStorage.setItem('mengshixian_admin_token', token);
    else global.sessionStorage.removeItem('mengshixian_admin_token');
  }
  function requestId() { return `admin-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`; }
  function clearSession() { setToken(''); }

  function explainCloudAuthError(error) {
    const detail = error
      ? [error.code, error.message, error.errMsg].filter(Boolean).map(String).join(' ')
      : '未知认证错误';
    if (/PERMISSION_DENIED|anonymous/i.test(detail)) {
      return 'CloudBase 拒绝后台连接：请在测试环境开启匿名登录，并把当前后台域名加入 Web 安全域名后重试。管理员密码尚未发送到服务端。';
    }
    return detail;
  }

  function resetAnonymousAuth() {
    anonymousReady = false;
    signingIn = null;
  }

  async function ensureCloudApp() {
    if (config.provider !== 'cloudbase') throw new Error('管理后台尚未配置 CloudBase provider。');
    if (!config.envId || !config.functionName) throw new Error('管理后台缺少 CloudBase 环境 ID 或云函数名称。');
    if (!global.cloudbase) throw new Error('CloudBase Web SDK 未加载。');
    if (!cloudApp) cloudApp = global.cloudbase.init({ env: config.envId, region: 'ap-shanghai' });
    if (!cloudAuth) cloudAuth = typeof cloudApp.auth === 'function' ? cloudApp.auth() : cloudApp.auth;
    if (!cloudAuth || typeof cloudAuth.signInAnonymously !== 'function') throw new Error('CloudBase Web SDK 不支持匿名登录。');
    if (!anonymousReady && !signingIn) {
      signingIn = cloudAuth.signInAnonymously()
        .then((result) => {
          if (result && result.error) throw result.error;
          anonymousReady = true;
        })
        .catch((error) => { throw new Error(explainCloudAuthError(error)); })
        .finally(() => { signingIn = null; });
    }
    if (signingIn) await signingIn;
    return cloudApp;
  }

  async function call(action, payload, retried) {
    const app = await ensureCloudApp();
    let result;
    try {
      result = await app.callFunction({
        name: config.functionName,
        data: { action, payload: { ...(payload || {}), adminToken: payload && payload.adminToken !== undefined ? payload.adminToken : getToken() }, requestId: requestId() },
        parse: true
      });
    } catch (error) {
      resetAnonymousAuth();
      if (!retried) return call(action, payload, true);
      throw error;
    }
    let body = result && result.result;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (_) { throw new Error('云函数返回格式不正确。'); }
    }
    if (!body || typeof body.ok !== 'boolean') throw new Error('云函数返回格式不正确。');
    if (!body.ok) {
      const error = new Error((body.error && body.error.message) || '请求失败。');
      error.code = body.error && body.error.code;
      if (error.code === 'ADMIN_SESSION_EXPIRED' || error.code === 'ADMIN_UNAUTHORIZED') clearSession();
      throw error;
    }
    return body.data;
  }

  async function uploadMediaFile(file, type) {
    if (!file) throw new Error('请选择要上传的文件。');
    // 提交前先做大小预检，避免大文件读入内存后才被服务端拒绝
    if (file.size > 4 * 1024 * 1024) throw new Error('文件超过 4 MB，请先在 CloudBase 控制台上传后登记文件 ID。');
    const reader = new FileReader();
    const dataUrl = await new Promise((resolve, reject) => {
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('读取素材失败。'));
      reader.readAsDataURL(file);
    });
    const comma = dataUrl.indexOf(',');
    if (comma < 0) throw new Error('素材内容格式不正确。');
    const result = await call('admin.media.upload', { type, fileName: file.name, mimeType: file.type, sizeBytes: file.size, contentBase64: dataUrl.slice(comma + 1) });
    return result;
  }

  global.MengshixianAdminApi = { config, call, uploadMediaFile, getToken, setToken, clearSession, resetAnonymousAuth };
}(window));
