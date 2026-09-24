(function attachAdminApi(global) {
  const config = global.MENGSHIXIAN_ADMIN_CONFIG || {};
  let cloudApp;
  let cloudAuth;
  let signingIn;
  let anonymousReady = false;

  const tokenKey = 'mengshixian_admin_token';
  // A token stored by earlier versions must not silently become a new tab's session.
  try { global.localStorage.removeItem(tokenKey); } catch (_) {}
  function getToken() { return global.sessionStorage.getItem(tokenKey) || ''; }
  function setToken(token) {
    if (token) global.sessionStorage.setItem(tokenKey, token);
    else global.sessionStorage.removeItem(tokenKey);
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

  async function uploadMediaFile(file, type, onProgress = () => {}) {
    if (!file) throw new Error('请选择要上传的文件。');
    if (file.size > 100 * 1024 * 1024) throw new Error('文件超过 100 MB，请压缩视频后再从后台上传。');
    if (file.size > 24 * 1024 * 1024) {
      if (!config.largeVideoUploadEnabled) throw new Error('当前环境的大视频直传尚未启用；请勿把文件改名后重试。');
      if (type !== 'video') throw new Error('超过 24 MB 的直传只支持视频。');
      if (!global.crypto || !global.crypto.subtle) throw new Error('当前浏览器不支持安全校验，请使用新版 Edge 或 Chrome。');
      onProgress({ phase: 'checking', completed: 0, total: file.size, percent: 0 });
      const checksum = await global.crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      const sha256 = [...new Uint8Array(checksum)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      const task = await call('admin.media.beginDirectUpload', { fileName: file.name, type, mimeType: file.type, sizeBytes: file.size, sha256 });
      if (task.completed && task.fileId) {
        onProgress({ phase: 'complete', completed: file.size, total: file.size, percent: 100, duplicate: true });
        return { fileId: task.fileId, mimeType: file.type, sizeBytes: file.size, sha256, alreadyUploaded: true };
      }
      if (!task.uploadId || !task.ticket) throw new Error('后台未返回大视频上传凭据，请稍后重试。');
      if (task.resumed) {
        onProgress({ phase: 'verifying', completed: 0, total: file.size, percent: 0 });
        try {
          const finished = await call('admin.media.finishDirectUpload', { uploadId: task.uploadId });
          onProgress({ phase: 'complete', completed: file.size, total: file.size, percent: 100 });
          return { ...finished, sha256 };
        } catch (error) { if (error.code !== 'MEDIA_UPLOAD_INCOMPLETE') throw error; }
      }
      await uploadDirectFile(file, task.ticket, onProgress);
      onProgress({ phase: 'verifying', completed: file.size, total: file.size, percent: 100 });
      const finished = await call('admin.media.finishDirectUpload', { uploadId: task.uploadId });
      onProgress({ phase: 'complete', completed: file.size, total: file.size, percent: 100 });
      return { ...finished, sha256 };
    }
    if (file.size > 4 * 1024 * 1024) {
      if (!global.crypto || !global.crypto.subtle) throw new Error('当前浏览器不支持安全校验，请使用新版 Edge 或 Chrome。');
      onProgress({ phase: 'checking', completed: 0, total: file.size, percent: 0 });
      const checksum = await global.crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      const sha256 = [...new Uint8Array(checksum)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      const task = await call('admin.media.beginUpload', { fileName: file.name, type, mimeType: file.type, sizeBytes: file.size, sha256 });
      if (task.completed && task.fileId) { onProgress({ phase: 'complete', completed: file.size, total: file.size, percent: 100, duplicate: true }); return { fileId: task.fileId, mimeType: file.type, sizeBytes: file.size, sha256, alreadyUploaded: true }; }
      onProgress({ phase: task.resumed ? 'resuming' : 'uploading', completed: 0, total: file.size, percent: 0 });
      const uploadedParts = new Set(task.uploadedParts || []);
      for (let index = 0; index < task.chunkCount; index += 1) {
        if (!uploadedParts.has(index)) {
          const part = file.slice(index * task.chunkSize, Math.min(file.size, (index + 1) * task.chunkSize));
          const contentBase64 = (await readBase64(part)).split(',')[1];
          await call('admin.media.uploadPart', { uploadId: task.uploadId, index, contentBase64 });
        }
        const completed = Math.min(file.size, (index + 1) * task.chunkSize);
        onProgress({ phase: 'uploading', completed, total: file.size, percent: Math.round(completed * 100 / file.size), resumed: task.resumed });
      }
      onProgress({ phase: 'finishing', completed: file.size, total: file.size, percent: 100 });
      const finished = await call('admin.media.finishUpload', { uploadId: task.uploadId });
      onProgress({ phase: 'complete', completed: file.size, total: file.size, percent: 100 });
      return { ...finished, sha256 };
    }
    onProgress({ phase: 'uploading', completed: 0, total: file.size, percent: 0 });
    const dataUrl = await readBase64(file);
    const comma = dataUrl.indexOf(',');
    if (comma < 0) throw new Error('素材内容格式不正确。');
    const result = await call('admin.media.upload', { type, fileName: file.name, mimeType: file.type, sizeBytes: file.size, contentBase64: dataUrl.slice(comma + 1) });
    onProgress({ phase: 'complete', completed: file.size, total: file.size, percent: 100 });
    let sha256 = '';
    if (global.crypto && global.crypto.subtle) {
      const checksum = await global.crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      sha256 = [...new Uint8Array(checksum)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    }
    return { ...result, sha256 };
  }

  function readBase64(blob) {
    const reader = new FileReader();
    return new Promise((resolve, reject) => {
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('读取素材失败。'));
      reader.readAsDataURL(blob);
    });
  }

  function uploadDirectFile(file, ticket, onProgress) {
    if (!global.XMLHttpRequest || !global.FormData) throw new Error('当前浏览器不支持大视频直传，请使用新版 Edge 或 Chrome。');
    return new Promise((resolve, reject) => {
      const form = new global.FormData();
      form.append('Signature', ticket.authorization);
      form.append('x-cos-security-token', ticket.token);
      form.append('x-cos-meta-fileid', ticket.cosFileId);
      form.append('key', ticket.cloudPath);
      form.append('file', file);
      const request = new global.XMLHttpRequest();
      request.open('POST', ticket.url);
      request.timeout = 30 * 60 * 1000;
      request.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        onProgress({ phase: 'direct-uploading', completed: event.loaded, total: event.total,
          percent: Math.round(event.loaded * 100 / event.total) });
      };
      request.onload = () => request.status >= 200 && request.status < 300
        ? resolve() : reject(new Error(`视频上传被云存储拒绝（HTTP ${request.status}），请检查网络后重试。`));
      request.onerror = () => reject(new Error('大视频上传中断，请检查网络后重试；重新选择同一文件会从头上传。'));
      request.ontimeout = () => reject(new Error('大视频上传超时，请检查网络后重试；重新选择同一文件会从头上传。'));
      request.onabort = () => reject(new Error('大视频上传已取消。'));
      onProgress({ phase: 'direct-uploading', completed: 0, total: file.size, percent: 0 });
      request.send(form);
    });
  }

  global.MengshixianAdminApi = { config, call, uploadMediaFile, getToken, setToken, clearSession, resetAnonymousAuth };
}(window));
