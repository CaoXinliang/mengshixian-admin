// Isolated browser layout check. All API responses are synthetic; it never writes CloudBase.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.join(os.tmpdir(), `friend-admin-visual-${process.pid}`);
const port = 9321;
const browser = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore', windowsHide: true });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForBrowser() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const result = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (result.ok) return;
    } catch (_) { /* startup */ }
    await pause(100);
  }
  throw new Error('Edge DevTools did not start.');
}
async function main() {
  await waitForBrowser();
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let sequence = 0;
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    const item = pending.get(data.id);
    if (!item) return;
    pending.delete(data.id);
    if (data.error) item.reject(new Error(data.error.message)); else item.resolve(data.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Page.enable');
  await send('Network.enable');
  await send('Network.setBlockedURLs', { urls: ['*api-client.js*', '*static.cloudbase.net*'] });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.MengshixianAdminApi = {
      config: { envId: 'mock' }, getToken: () => 'visual-only', clearSession: () => {},
      call: async (action) => {
        if (action === 'admin.me') return { admin: { displayName: '演示管理员' } };
        const rows = {
          'admin.products.list': [{ _id: 'p1', name: '三文鱼块', categoryId: 'cat1', categoryName: '海鲜', audienceType: 'all', status: 'on_sale', frozenTemperature: '-18℃' }],
          'admin.categories.list': [{ _id: 'cat1', name: '海鲜', status: 'enabled' }],
          'admin.skus.list': [{ _id: 'sku1', productId: 'p1', specName: '1kg/包', packageUnit: '包', netWeight: '1kg', status: 'on_sale' }],
          'admin.prices.list': [{ _id: 'price1', skuId: 'sku1', scopeType: 'public', channel: 'all', amountCent: 4990, status: 'active' }],
          'admin.media.list': [], 'admin.productMedia.list': []
        };
        return { rows: rows[action] || [], total: (rows[action] || []).length };
      }
    };
  ` });
  await send('Page.navigate', { url: 'http://127.0.0.1:8765/product-workflow.html?id=p1' });
  for (let i = 0; i < 40; i += 1) {
    await pause(100);
    const result = await send('Runtime.evaluate', { expression: "document.querySelector('#workflowTitle')?.textContent || ''", returnByValue: true });
    if (result.result.value === '编辑商品：三文鱼块') break;
    if (i === 39) throw new Error(`Product workflow did not render: ${result.result.value}`);
  }
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const file = path.join(os.tmpdir(), 'friend-admin-product-visual-20260923.png');
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log(`Mock product workflow screenshot: ${file}`);
  await send('Page.navigate', { url: 'http://127.0.0.1:8765/index.html' });
  for (let i = 0; i < 40; i += 1) {
    await pause(100);
    const result = await send('Runtime.evaluate', { expression: "document.querySelector('#taskMetrics')?.children.length || 0", returnByValue: true });
    if (result.result.value > 0) break;
    if (i === 39) throw new Error('Workbench tasks did not render.');
  }
  const overviewShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const overviewFile = path.join(os.tmpdir(), 'friend-admin-overview-visual-20260923.png');
  fs.writeFileSync(overviewFile, Buffer.from(overviewShot.data, 'base64'));
  console.log(`Mock workbench screenshot: ${overviewFile}`);
  socket.close();
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => browser.kill());
