const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomBytes, randomUUID } = require('node:crypto');
const { createApplication } = require('../backend/cloudbase/functions/api/app');
const { createLocalStore } = require('./store.cjs');

const root = path.resolve(__dirname, '..');
const demoTable = 'outputs/01a0cd53-41af-7eb2-824f-c1e8b42fa25d/商品导入测试演示_仅本地.xlsx';
const sdk = 'https://static.cloudbase.net/cloudbase-js-sdk/3.9.2/cloudbase.full.js';
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };

async function readJson(request, limit = 12 * 1024 * 1024) {
  if (!String(request.headers['content-type'] || '').startsWith('application/json')) throw Object.assign(new Error('请使用 JSON 请求。'), { status: 415 });
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('上传内容过大。'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (_) { throw Object.assign(new Error('请求内容格式不正确。'), { status: 400 }); }
}
function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(body));
}
function localPage(html) {
  return html.replace(sdk, '/__local/cloudbase.js')
    .replace('CloudBase 服务连接正常，请输入管理员账号和密码。', '本机练习服务连接正常，可一键进入，或使用本机工作人员账号登录。')
    .replace(/CloudBase 服务连接/g, '本机练习服务连接')
    .replace(/<body([^>]*)>/i, '<body$1><div id="localPracticeBanner" style="position:sticky;top:0;z-index:9999;background:#e8f4ff;color:#07578e;padding:8px 16px;font:600 14px system-ui;text-align:center;border-bottom:1px solid #9fd0ef">本机练习环境｜资料仅保存在此电脑，不会写入友方云端或展示在小程序</div>')
    .replace(/<\/body>/i, '<script src="/__local/page.js"></script></body>');
}
async function readLocalSecrets(dataDir) {
  const file = path.join(dataDir, 'practice-secrets.json');
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const secrets = {
      bootstrapToken: randomBytes(32).toString('hex'),
      password: randomBytes(24).toString('hex'),
      piiEncryptionKey: randomBytes(32).toString('hex')
    };
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(file, JSON.stringify(secrets), { flag: 'wx', mode: 0o600 });
    return secrets;
  }
}

async function startLocalPreview({ port = 8766, dataDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'MengshixianFriendAdminPractice') } = {}) {
  const secrets = await readLocalSecrets(dataDir);
  const store = await createLocalStore(dataDir);
  const mediaDir = path.join(dataDir, 'media');
  await fs.mkdir(mediaDir, { recursive: true });
  const mediaFile = id => path.join(mediaDir, id.replace('local-media:', ''));
  const app = createApplication({
    store, bootstrapToken: secrets.bootstrapToken, piiEncryptionKey: secrets.piiEncryptionKey,
    getIdentity: () => ({ OPENID: 'local-practice-customer-only' }), demoMode: true,
    storageUploader: async ({ contentBase64, fileContent }) => {
      const id = `local-media:${randomUUID()}`;
      await fs.writeFile(mediaFile(id), fileContent || Buffer.from(contentBase64, 'base64'));
      return id;
    },
    storageDownloader: id => fs.readFile(mediaFile(id)),
    storageDeleter: ids => Promise.all(ids.map(id => fs.rm(mediaFile(id), { force: true }))),
    mediaUrlResolver: async ids => Object.fromEntries(ids.filter(id => /^local-media:[0-9a-f-]{36}$/.test(id)).map(id => [id, `/__local/media/${id.slice(12)}`]))
  });
  if (!(await store.list('admin_users', { pageSize: 1 })).total) {
    const result = await app.dispatch({ action: 'admin.bootstrap', payload: {
      bootstrapToken: secrets.bootstrapToken, username: 'local-owner', displayName: '本机练习管理员', password: secrets.password
    } });
    if (!result.ok) throw new Error(`本机管理员初始化失败：${result.error.message}`);
  }
  const server = http.createServer(async (request, response) => {
    try {
      const host = String(request.headers.host || '');
      if (!/^127\.0\.0\.1(?::\d+)?$/.test(host)) return json(response, 403, { error: '本机练习入口仅允许本机访问。' });
      const origin = request.headers.origin;
      if (origin && origin !== `http://${host}`) return json(response, 403, { error: '跨站请求已拒绝。' });
      const pathname = new URL(request.url, `http://${host}`).pathname;
      if (request.method === 'POST' && pathname === '/__local/session') {
        const result = await app.dispatch({ action: 'admin.login', payload: { username: 'local-owner', password: secrets.password } });
        return json(response, result.ok ? 200 : 401, result.ok ? result.data : result);
      }
      if (request.method === 'POST' && pathname === '/__local/api') {
        const event = await readJson(request);
        return json(response, 200, await app.dispatch(event));
      }
      if (request.method === 'POST' && pathname === '/__local/media-urls') {
        const body = await readJson(request, 64 * 1024);
        const files = Array.isArray(body.fileList) ? body.fileList.slice(0, 100) : [];
        const resolved = {};
        for (const id of files) {
          if (!/^local-media:[0-9a-f-]{36}$/.test(id)) continue;
          try { await fs.access(mediaFile(id)); resolved[id] = `/__local/media/${id.slice(12)}`; } catch (_) {}
        }
        return json(response, 200, { fileList: files.map(fileID => ({ fileID, tempFileURL: resolved[fileID] || '' })) });
      }
      if (request.method !== 'GET') return json(response, 405, { error: '不支持此请求。' });
      if (pathname.startsWith('/__local/media/')) {
        const id = pathname.slice('/__local/media/'.length);
        if (!/^[0-9a-f-]{36}$/.test(id)) return json(response, 404, { error: '素材不存在。' });
        const bytes = await fs.readFile(path.join(mediaDir, id));
        const type = bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) ? 'image/png'
          : bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ? 'image/jpeg'
          : bytes.toString('ascii', 0, 4) === 'RIFF' ? 'image/webp'
          : bytes.toString('ascii', 0, 4) === '\x1aE\xdf\xa3' ? 'video/webm'
          : bytes.toString('ascii', 4, 8) === 'ftyp' ? 'video/mp4' : 'application/octet-stream';
        response.writeHead(200, { 'content-type': type, 'x-content-type-options': 'nosniff' });
        return response.end(bytes);
      }
      if (pathname === '/__local/cloudbase.js' || pathname === '/__local/page.js') {
        const script = await fs.readFile(path.join(__dirname, pathname.endsWith('cloudbase.js') ? 'cloudbase-shim.js' : 'page.js'), 'utf8');
        response.writeHead(200, { 'content-type': mime['.js'], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        return response.end(script);
      }
      if (pathname === '/config.js') {
        response.writeHead(200, { 'content-type': mime['.js'], 'cache-control': 'no-store' });
        return response.end("window.MENGSHIXIAN_ADMIN_CONFIG={envId:'local-practice',functionName:'api',provider:'cloudbase',largeVideoUploadEnabled:false};");
      }
      const relative = decodeURIComponent(pathname.slice(1) || 'index.html');
      const allowed = /^[^/]+\.(?:html|js|css)$/.test(relative) || relative === 'assets/logo.png' || relative === demoTable;
      if (!allowed) return json(response, 404, { error: '页面不存在。' });
      const file = path.join(root, relative);
      const content = await fs.readFile(file);
      response.writeHead(200, { 'content-type': mime[path.extname(file)], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.end(path.extname(file) === '.html' ? localPage(content.toString('utf8')) : content);
    } catch (error) {
      json(response, error.code === 'ENOENT' ? 404 : error.status || 500, { error: error.status ? error.message : '本机练习服务处理失败。' });
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

module.exports = { startLocalPreview };
