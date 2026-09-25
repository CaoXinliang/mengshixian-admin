const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { startLocalPreview } = require('../local-preview/server.cjs');

test('local practice preview serves real pages, dispatches real API and keeps drafts after restart', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'friend-admin-preview-'));
  let server;
  try {
    server = await startLocalPreview({ port: 0, dataDir });
    const base = server.url;
    const page = await (await fetch(`${base}/login.html`)).text();
    assert.match(page, /本机练习/);
    assert.match(page, /本机练习服务连接正常/);
    assert.match(page, /本机练习服务连接正常，可一键进入，或使用本机工作人员账号登录/);
    assert.doesNotMatch(page, /本机练习服务连接正常，请输入管理员账号和密码/);
    assert.doesNotMatch(page, /CloudBase 服务连接/);
    assert.doesNotMatch(page, /https:\/\/static\.cloudbase\.net/);
    const localLogin = await (await fetch(`${base}/__local/page.js`)).text();
    assert.match(localLogin, /原来的云端账号和密码不能用于本机练习/);
    assert.match(localLogin, /本机工作人员账号/);
    const config = await (await fetch(`${base}/config.js`)).text();
    assert.match(config, /local-practice/);
    assert.doesNotMatch(config, /cloud1-d8gcnzmltc1113cd7/);

    const session = await (await fetch(`${base}/__local/session`, { method: 'POST' })).json();
    assert.ok(session.token);
    const dispatch = async (action, payload = {}) => {
      const response = await fetch(`${base}/__local/api`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, payload: { ...payload, adminToken: session.token } })
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const me = await dispatch('admin.me');
    assert.equal(me.ok, true);
    const category = await dispatch('admin.categories.upsert', { name: '本机测试分类', status: 'enabled' });
    assert.equal(category.ok, true, JSON.stringify(category.error));
    const importRow = {
      sourceRowNo: 2,
      parsed: { productCode: 'LOCAL-TEST-001', skuCode: 'LOCAL-TEST-001-500G', name: '本机测试商品', categoryName: '本机测试分类', specName: '500克', packageUnit: '袋' },
      mappingWarnings: ['价格待补齐', '主图待补齐']
    };
    const preview = await dispatch('admin.imports.preview', { rows: [importRow] });
    assert.equal(preview.data.rows[0].status, 'ready', JSON.stringify(preview.error));
    const stage = await dispatch('admin.imports.stage', { sourceFile: '本机测试资料.csv', rows: [importRow] });
    assert.equal(stage.data.staged[0].status, 'staged', JSON.stringify(stage.error));
    const image = await dispatch('admin.media.upload', {
      type: 'image', fileName: 'practice.png', mimeType: 'image/png',
      sizeBytes: 8, contentBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]).toString('base64')
    });
    assert.equal(image.ok, true, JSON.stringify(image.error));
    const urls = await (await fetch(`${base}/__local/media-urls`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileList: [image.data.fileId] })
    })).json();
    assert.match(urls.fileList[0].tempFileURL, /^\/__local\/media\//);
    const imageResponse = await fetch(`${base}${urls.fileList[0].tempFileURL}`);
    assert.equal(imageResponse.headers.get('content-type'), 'image/png');
    assert.equal((await imageResponse.arrayBuffer()).byteLength, 8);
    const rejectedOrigin = await fetch(`${base}/__local/api`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://other.example' }, body: '{}'
    });
    assert.equal(rejectedOrigin.status, 403);
    await server.close(); server = null;

    server = await startLocalPreview({ port: 0, dataDir });
    const again = await (await fetch(`${server.url}/__local/api`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'admin.categories.list', payload: { adminToken: session.token } })
    })).json();
    assert.equal(again.ok, true, JSON.stringify(again.error));
    assert.ok(again.data.rows.some(row => row.name === '本机测试分类'));
    const persistedDrafts = await (await fetch(`${server.url}/__local/api`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'admin.imports.list', payload: { adminToken: session.token } })
    })).json();
    assert.equal(persistedDrafts.ok, true, JSON.stringify(persistedDrafts.error));
    assert.equal(persistedDrafts.data.rows.length, 1, '重启后导入草稿仍可读取');
    assert.equal(persistedDrafts.data.rows[0].status, 'staged', '保存后仍停留在待审核队列');
    const products = await (await fetch(`${server.url}/__local/api`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'admin.products.list', payload: { adminToken: session.token } })
    })).json();
    assert.equal(products.data.rows.length, 0, '保存导入草稿不得自动建立已发布商品');
    const logout = await (await fetch(`${server.url}/__local/api`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'admin.logout', payload: { adminToken: session.token } })
    })).json();
    assert.equal(logout.ok, true);
    const expired = await (await fetch(`${server.url}/__local/api`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'admin.me', payload: { adminToken: session.token } })
    })).json();
    assert.equal(expired.ok, false);
  } finally {
    if (server) await server.close();
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep), '拒绝清理非测试临时目录');
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
