// Isolated Edge: default checks mock APIs; --actual-receipts also runs real business API with in-memory storage. Never CloudBase.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const zlib = require('node:zlib');
const os = require('node:os');
const path = require('node:path');

function zip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const fileName = Buffer.from(name);
    const data = Buffer.from(value);
    const compressed = zlib.deflateRawSync(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(fileName.length, 26);
    local.push(header, fileName, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(fileName.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, fileName);
    offset += header.length + fileName.length + compressed.length;
  }
  const listing = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(listing.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, listing, end]);
}

const workbook = zip({
  'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="商品" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>',
  'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>商品编码</t></is></c><c r="B1" t="inlineStr"><is><t>规格编码</t></is></c><c r="C1" t="inlineStr"><is><t>商品名称</t></is></c><c r="D1" t="inlineStr"><is><t>分类</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>FISH-001</t></is></c><c r="B2" t="inlineStr"><is><t>FISH-500G</t></is></c><c r="C2" t="inlineStr"><is><t>测试鱼丸</t></is></c><c r="D2" t="inlineStr"><is><t>冻品</t></is></c></row></sheetData></worksheet>'
});
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9341;
const profile = process.env.IMPORT_BROWSER_PROFILE || path.join(os.tmpdir(), `friend-import-test-${process.pid}`);
const browser = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
let browserError = '';
browser.stderr.on('data', (chunk) => { browserError += chunk.toString().slice(0, 3000); });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function main() {
  let ready = false;
  for (let i = 0; i < 200; i += 1) {
    try { ready = (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch (_) { /* startup */ }
    if (ready) break;
    await pause(100);
  }
  assert.ok(ready, `Edge did not start (exit ${browser.exitCode}): ${browserError.slice(-1500)}`);
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let sequence = 0;
  let lastProtocolMethod = '';
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', ({ data }) => {
    const response = JSON.parse(data);
    const item = pending.get(response.id);
    if (!item) return;
    pending.delete(response.id);
    response.error ? item.reject(new Error(response.error.message)) : item.resolve(response.result);
  });
  socket.addEventListener('close', () => {
    for (const item of pending.values()) item.reject(new Error(`Edge 调试连接提前关闭；最近指令 ${lastProtocolMethod}；浏览器退出码 ${browser.exitCode}；${browserError.slice(-500)}`));
    pending.clear();
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    lastProtocolMethod = method;
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const watchdog = setTimeout(() => {
    console.error(`Edge 浏览器验收超时：最近指令 ${lastProtocolMethod}，待回应 ${pending.size}`);
    process.exitCode = 1;
    socket.close();
  }, 60000);
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  try {
    await send('Page.enable');
    await send('Network.enable');
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    await send('Network.setBlockedURLs', { urls: ['*api-client.js*', '*static.cloudbase.net*'] });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__writes = [];
      window.__media = []; window.__uploads = 0;
      window.MengshixianAdminApi = {
        uploadMediaFile: async (file, type, progress) => { window.__uploads++; progress({ phase: 'complete', percent: 100 }); return { fileId: 'cloud://mock/file-' + window.__uploads, mimeType: file.type, sizeBytes: file.size }; },
        getToken: () => 'mock-only', setToken: () => {}, config: { envId: 'mock-env' },
        call: async (action, payload) => {
          if (action === 'admin.media.upsert') {
            if (window.__failRegistration) { window.__failRegistration = false; throw new Error('本地模拟登记失败'); }
            const asset = { ...payload, _id: 'asset-' + window.__media.length, enabled: true }; window.__media.push(asset); window.__writes.push({ action, ...payload }); return asset;
          }
          if (action === 'admin.pricingTargets.list') return { rows: payload.scopeType === 'customer_type' ? [{ _id: 'c', label: '个人顾客（C 端）' }, { _id: 'b', label: '企业顾客（B 端）' }] : [{ _id: 'org-a', label: '甲方门店' }], total: payload.scopeType === 'customer_type' ? 2 : 1 };
          if (action === 'admin.orders.list' && location.search.includes('failOrders=1')) throw new Error('本地模拟订单读取失败');
          if (['admin.deliverySlots.upsert', 'admin.deliveryAreas.upsert'].includes(action)) { window.__writes.push(payload); return payload; }
          if (action === 'admin.me') return { admin: { id: 'mock-local-admin', username: 'local-super', displayName: '本地测试', role: 'super_admin', status: 'active', phoneMasked: '138****0000', phoneVerificationStatus: 'unverified', permissions: ['*'] } };
          if (action === 'admin.imports.stage') {
            window.__writes.push(payload);
            return { staged: payload.rows.map(() => ({ status: 'staged' })) };
          }
          if (action === 'admin.imports.preview') return { rows: payload.rows.map((row) => ({ line: row.sourceRowNo, status: 'ready', mapping: { product: '新建商品草稿', sku: '新建规格草稿' }, warnings: ['价格待补齐', '主图待补齐'] })) };
          if (action === 'admin.products.review') return { product: { id: 'p1', productCode: 'P-001', name: '精选虾仁', status: 'draft' }, category: { name: '海鲜水产', status: 'enabled' }, skus: [{ id: 's1', skuCode: 'S-001', specName: '500克/袋', packageUnit: '袋', status: 'draft', prices: [{ amountCent: 1250, scopeType: 'customer_type', scopeId: 'c', channel: 'miniapp' }], personalPriceReady: true }], cover: null, videos: [], issues: ['缺少可用的真实主图'], ready: false, reviewToken: 'mock-review' };
          if (action === 'admin.productMedia.linkByCode') { window.__writes.push({ action, ...payload }); return { productCode: payload.productCode }; }
          if (action === 'admin.users.setPricingProfile') { window.__writes.push({ action, ...payload }); return { user: { _id: payload.id } }; }
          if (action === 'admin.prices.upsert') {
            window.__writes.push({ action, ...payload });
            return { _id: 'price-mock' };
          }
          if (action === 'admin.categories.upsert') {
            window.__writes.push({ action, ...payload });
            return { _id: payload.id || 'category-mock' };
          }
          const rows = {
            'admin.users.list': [{ _id: 'customer-private-id', displayName: '张先生 · 138****1234 · 客户号 KH-TEST1234', userType: 'c', status: 'active' }],
            'admin.users.organizations': [{ _id: 'org-a', label: '甲方门店' }],
            'admin.media.list': [{ _id: 'm1', name: '秋季主图', type: 'image', enabled: true }, { _id: 'm2', name: '冬季主图', type: 'image', enabled: true }, ...window.__media],
            'admin.products.list': [{ _id: 'p1', spuCode: 'P-001', name: '精选虾仁', status: 'draft' }, { _id: 'p-live', name: '在售虾仁', status: 'on_sale' }],
            'admin.skus.list': [{ _id: 's1', productId: 'p1', skuCode: 'S-001', specName: '500克/袋', status: 'draft' }],
            'admin.prices.list': [{ _id: 'price-c', skuId: 's1', scopeType: 'customer_type', scopeId: 'c', amountCent: 1250, channel: 'miniapp', status: 'active' }, { _id: 'price-org', skuId: 's1', scopeType: 'organization', scopeId: 'org-a', amountCent: 1100, channel: 'miniapp', status: 'active' }],
            'admin.categories.list': [{ _id: 'c1', name: '海鲜水产', imageMediaId: 'm1', status: 'enabled' }],
            'admin.deliveryAreas.list': [{ _id: 'area-private', name: '城区配送', status: 'active' }],
            'admin.warehouses.list': [{ _id: 'warehouse-private', name: '中心仓', status: 'active' }],
            'admin.roles.list': [{ _id: 'r1', name: '商品运营', status: 'active' }],
            'admin.adminUsers.list': [{ id: 'mock-local-admin', username: 'local-super', displayName: '本地测试', role: 'super_admin', status: 'active', phoneMasked: '138****0000', phoneVerificationStatus: 'unverified' }]
          };
          if (rows[action]) return { rows: rows[action], total: rows[action].length };
          return { rows: [], total: 0 };
        }
      };
    ` });
    await send('Page.navigate', { url: 'http://127.0.0.1:8765/imports.html' });
    for (let i = 0; i < 50; i += 1) {
      if (await evaluate("Boolean(window.MengshixianImportParser && document.querySelector('#stagingFile'))")) break;
      if (i === 49) throw new Error('Import page did not load');
      await pause(100);
    }
    const xlsx = await evaluate(`(async () => { const binary = atob('${workbook.toString('base64')}'); const bytes = Uint8Array.from(binary, c => c.charCodeAt(0)); return (await MengshixianImportParser.parseFile(new File([bytes], '商品.xlsx'))).ready[0].parsed.name; })()`);
    assert.equal(xlsx, '测试鱼丸');
    await evaluate(`(() => { const file = new File(['商品编码,规格编码,商品名称,分类,规格,包装单位\\nFISH-002,FISH-2-500G,虾仁,海鲜,500克,1袋'], '商品.csv'); const transfer = new DataTransfer(); transfer.items.add(file); const input = document.querySelector('#stagingFile'); input.files = transfer.files; input.dispatchEvent(new Event('change')); })()`);
    for (let i = 0; i < 40; i += 1) {
      if (await evaluate("document.querySelector('#importPreview').hidden === false")) break;
      if (i === 39) throw new Error('Preview did not render');
      await pause(100);
    }
    assert.equal(await evaluate('window.__writes.length'), 0, 'Selecting file must not write');
    await evaluate("window.confirm = () => false; document.querySelector('#saveImportDrafts').click()");
    assert.equal(await evaluate('window.__writes.length'), 0, 'Cancel must not write');
    await evaluate("window.confirm = () => true; document.querySelector('#saveImportDrafts').click()");
    for (let i = 0; i < 40; i += 1) {
      if (await evaluate('window.__writes.length') === 1) break;
      await pause(100);
    }
    assert.equal(await evaluate('window.__writes.length'), 1);
    assert.equal(await evaluate('window.__writes[0].rows.length'), 1);
    const workbookBase = '/outputs/01a0cd53-41af-7eb2-824f-c1e8b42fa25d/';
    const delivered = await evaluate(`(async () => { const file = await fetch('${workbookBase}商品导入测试演示_仅本地.xlsx').then(r => r.blob()); const parsed = await MengshixianImportParser.parseFile(new File([file], '商品导入测试演示_仅本地.xlsx')); return { ready: parsed.ready.length, first: parsed.ready[0].parsed.name, last: parsed.ready.at(-1).parsed.skuCode }; })()`);
    assert.deepEqual(delivered, { ready: 6, first: '黄金鲍鱼肉', last: 'TEST-S-0006' }, '必须用交付的 XLSX 演示表实际解析');
    await evaluate(`(async () => { const blob = await fetch('${workbookBase}商品导入测试演示_仅本地.xlsx').then(r => r.blob()); const input = document.querySelector('#stagingFile'); const transfer = new DataTransfer(); transfer.items.add(new File([blob], '商品导入测试演示_仅本地.xlsx')); input.files = transfer.files; input.dispatchEvent(new Event('change')); })()`);
    for (let i = 0; i < 40; i += 1) {
      if (await evaluate("document.querySelector('#saveImportDrafts').textContent.includes('6')")) break;
      if (i === 39) throw new Error('Delivered demo workbook did not reach preview');
      await pause(100);
    }
    await evaluate("window.confirm = () => true; document.querySelector('#saveImportDrafts').click()");
    for (let i = 0; i < 40; i += 1) {
      if (await evaluate('window.__writes.length') === 2) break;
      await pause(100);
    }
    assert.equal(await evaluate('window.__writes[1].rows.length'), 6, '交付演示表必须能走到仅保存草稿的模拟接口');
    const blank = await evaluate(`(async () => { const blob = await fetch('${workbookBase}商品导入空白模板.xlsx').then(r => r.blob()); try { await MengshixianImportParser.parseFile(new File([blob], '商品导入空白模板.xlsx')); return 'unexpected'; } catch (error) { return error.message; } })()`);
    assert.match(blank, /没有商品数据行/, '空白模板在填写前不得生成草稿');
    await evaluate(`(() => { const file = new File(['商品编码,规格编码,商品名称,分类,规格,包装单位\\n,,精选虾仁,海鲜水产,500克,袋\\n,,精选虾仁,海鲜水产,1千克,袋'], '待建立编码.csv'); const transfer = new DataTransfer(); transfer.items.add(file); const input = document.querySelector('#stagingFile'); input.files = transfer.files; input.dispatchEvent(new Event('change')); })()`);
    for (let i = 0; i < 40; i += 1) {
      if (await evaluate("document.querySelector('#importMapping').hidden === false")) break;
      if (i === 39) throw new Error('Missing-code mapping UI did not open');
      await pause(100);
    }
    await evaluate("(() => { document.querySelector('[data-map-line=\"2\"] [data-map-product]').value = 'existing:P-001'; document.querySelector('[data-map-line=\"3\"] [data-map-product]').value = 'row:2'; document.querySelector('#applyImportMapping').click(); })()");
    for (let i = 0; i < 40; i += 1) {
      if (await evaluate("document.querySelector('#saveImportDrafts').textContent.includes('2')")) break;
      if (i === 39) throw new Error('Code mapping did not produce two preview rows');
      await pause(100);
    }
    assert.equal(await evaluate("document.querySelectorAll('#importPreviewRows tr').length"), 2);
    assert.equal(await evaluate("[...document.querySelectorAll('#importPreviewRows tr')].every(row => row.cells[1].textContent === 'P-001')"), true, '多规格可明确选择同一商品编码');
    assert.equal(await evaluate("[...document.querySelectorAll('#importPreviewRows tr')].every(row => /^MSX-S-/.test(row.cells[2].textContent))"), true, '规格编码由后台辅助生成');
    assert.equal(await evaluate('window.__writes.length'), 2, '建立编码和预览不能写云端');
    await send('Page.navigate', { url: 'http://127.0.0.1:8765/media.html' });
    for (let i = 0; i < 40; i += 1) {
      if (await evaluate("document.querySelectorAll('#mediaTable tr').length") === 2) break;
      await pause(100);
    }
    assert.equal(await evaluate("document.querySelectorAll('#mediaTable tr').length"), 2);
    await evaluate("(() => { const input = document.querySelector('#mediaSearch'); input.value = '秋季'; input.dispatchEvent(new Event('input')); })()");
    assert.equal(await evaluate("document.querySelectorAll('#mediaTable tr').length"), 1, 'Media search must filter loaded rows');
    await evaluate("document.querySelector('[data-add-form=\"#mediaForm\"]').click()");
    assert.equal(await evaluate("document.querySelector('#mediaForm [name=fileId]') === null"), true, 'Operators must not need file IDs');
    assert.match(await evaluate("document.querySelector('#mediaVersionHint').textContent"), /24 MB/);
    await evaluate("(async () => { const bytes = await fetch('/assets/logo.png').then(r => r.blob()); const file = new File([bytes], '本地标识测试.png', { type: 'image/png' }); window.__imageFixture = file; const transfer = new DataTransfer(); transfer.items.add(file); const f = document.querySelector('#mediaForm'); f.elements.uploadFile.files = transfer.files; f.elements.uploadFile.dispatchEvent(new Event('change')); window.__failRegistration = true; window.confirm = () => true; f.requestSubmit(); })()");
    for (let i = 0; i < 40; i += 1) { if (await evaluate("document.querySelector('#mediaUploadStatus').textContent.includes('模拟登记失败')")) break; await pause(50); }
    assert.equal(await evaluate('window.__uploads'), 1);
    assert.equal(await evaluate('window.__media.length'), 0, 'Failed registration must not create a media record');
    await evaluate("window.confirm = () => true; document.querySelector('#mediaForm').requestSubmit()");
    for (let i = 0; i < 40; i += 1) { if (await evaluate('window.__media.length === 1')) break; await pause(50); }
    assert.equal(await evaluate('window.__media.length'), 1);
    assert.equal(await evaluate('window.__uploads'), 1, 'Registration retry must reuse the uploaded file');
    await pause(100);
    await evaluate("(() => { document.querySelector('[data-add-form=\"#mediaForm\"]').click(); const f = document.querySelector('#mediaForm'); const transfer = new DataTransfer(); transfer.items.add(window.__imageFixture); f.elements.uploadFile.files = transfer.files; f.elements.uploadFile.dispatchEvent(new Event('change')); window.confirm = () => true; f.requestSubmit(); })()");
    for (let i = 0; i < 40; i += 1) { if (await evaluate("document.querySelector('#mediaUploadStatus').textContent.includes('无需再次上传')")) break; await pause(50); }
    assert.match(await evaluate("document.querySelector('#mediaUploadStatus').textContent"), /无需再次上传/);
    assert.equal(await evaluate('window.__uploads'), 1, 'Duplicate file detection must precede upload');
    await evaluate("(async () => { const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#1565c0'; ctx.fillRect(0,0,64,64); const stream = canvas.captureStream(10); const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' }); const chunks = []; recorder.ondataavailable = e => chunks.push(e.data); const done = new Promise(resolve => recorder.onstop = resolve); recorder.start(); await new Promise(resolve => setTimeout(resolve, 350)); recorder.stop(); await done; stream.getTracks().forEach(track => track.stop()); const file = new File(chunks, '本地蓝色视频测试.webm', { type: 'video/webm' }); if (!file.size) throw new Error('Test video generation failed'); const transfer = new DataTransfer(); transfer.items.add(file); const f = document.querySelector('#mediaForm'); f.elements.type.value = 'video'; f.elements.name.value = '本地蓝色视频测试'; f.elements.uploadFile.files = transfer.files; window.confirm = () => true; f.requestSubmit(); })()");
    for (let i = 0; i < 40; i += 1) { if (await evaluate('window.__media.length === 2')) break; await pause(50); }
    assert.equal(await evaluate('window.__media[1].type'), 'video');
    assert.equal(await evaluate('window.__media[1].mimeType'), 'video/webm');
    assert.equal(await evaluate('window.__uploads'), 2);
    await send('Page.navigate', { url: 'http://127.0.0.1:8765/categories.html' });
    for (let i = 0; i < 40; i += 1) {
      if (await evaluate("Boolean(document.querySelector('#categoriesTable [data-edit-category=c1]'))")) break;
      await pause(100);
    }
    await evaluate("document.querySelector('#categoriesTable [data-edit-category=c1]').click()");
    assert.equal(await evaluate("document.querySelector('#categoryForm [name=imageMediaId]').tagName"), 'SELECT', '分类图片必须按名称选择，不填写素材 ID');
    assert.match(await evaluate("document.querySelector('#categoryForm [name=imageMediaId]').selectedOptions[0].textContent"), /秋季主图/, '编辑时应保留原分类图片');
    assert.equal(await evaluate("document.querySelector('#categoryForm [name=imageMediaId] option[value=m2]')?.textContent"), '冬季主图');
    await evaluate("(() => { const form = document.querySelector('#categoryForm'); form.elements.imageMediaId.value = 'm2'; form.requestSubmit(); })()");
    for (let i = 0; i < 40; i += 1) {
      if (await evaluate("window.__writes.some(item => item.action === 'admin.categories.upsert')")) break;
      await pause(100);
    }
    assert.equal(await evaluate("window.__writes.find(item => item.action === 'admin.categories.upsert').imageMediaId"), 'm2');
    await send('Page.navigate', { url: 'http://127.0.0.1:8765/banners.html' });
    for (let i = 0; i < 40; i += 1) {
      if (await evaluate("Boolean(document.querySelector('[data-add-form=\"#bannerForm\"]'))")) break;
      await pause(100);
    }
    await evaluate("document.querySelector('[data-add-form=\"#bannerForm\"]').click()");
    assert.equal(await evaluate("document.querySelector('#bannerForm [name=enabled]').checked"), false, 'New banner must be draft');
    assert.equal(await evaluate("document.querySelector('#bannerForm [name=mediaAssetId]').tagName"), 'SELECT');
    await evaluate("(() => { const form = document.querySelector('#bannerForm'); form.elements.title.value = '秋季轮播'; form.elements.mediaAssetId.value = 'm1'; form.elements.jumpType.value = 'product'; form.elements.jumpType.dispatchEvent(new Event('change', { bubbles: true })); form.elements.jumpTarget.value = 'p1'; form.elements.jumpTarget.dispatchEvent(new Event('change', { bubbles: true })); })()");
    assert.equal(await evaluate("Boolean(document.querySelector('#bannerForm [name=jumpTarget] option[value=p1]'))"), false, 'Draft product must not be selectable for homepage');
    await evaluate("(() => { const target = document.querySelector('#bannerForm [name=jumpTarget]'); target.value = 'p-live'; target.dispatchEvent(new Event('change', { bubbles: true })); })()");
    assert.match(await evaluate("document.querySelector('#bannerForm .content-save-preview').textContent"), /秋季轮播[\s\S]*秋季主图[\s\S]*在售虾仁[\s\S]*仅保存草稿/);
    await send('Page.navigate', { url: 'http://127.0.0.1:8765/pricing.html' });
    for (let i = 0; i < 40; i += 1) {
      if (await evaluate("Boolean(document.querySelector('[data-add-form=\"#priceForm\"]')) && document.querySelectorAll('#pricesTable tr').length === 2")) break;
      await pause(100);
    }
    assert.match(await evaluate("document.querySelector('#pricesTable').textContent"), /个人顾客（C 端）/);
    assert.match(await evaluate("document.querySelector('#pricesTable').textContent"), /甲方门店/);
    assert.doesNotMatch(await evaluate("document.querySelector('#pricesTable').textContent"), /org-a|客户类型 c/);
    await evaluate("document.querySelector('[data-add-form=\"#priceForm\"]').click()");
    assert.equal(await evaluate("document.querySelector('#priceForm [name=skuId]').tagName"), 'SELECT');
    assert.equal(await evaluate("document.querySelector('#priceForm [name=amountCent]').parentElement.textContent.includes('（元）')"), true);
    assert.equal(await evaluate("document.querySelector('#priceForm [name=scopeId]').tagName"), 'SELECT');
    await evaluate("(() => { const f = document.querySelector('#priceForm'); f.elements.scopeType.value = 'customer_type'; f.elements.scopeType.dispatchEvent(new Event('change')); })()");
    for (let i = 0; i < 40; i += 1) { if (await evaluate("document.querySelector('#priceForm [name=scopeId]').options.length === 3")) break; await pause(50); }
    assert.match(await evaluate("document.querySelector('#priceForm [name=scopeId]').textContent"), /个人顾客.*企业顾客/);
    await evaluate("(() => { const f = document.querySelector('#priceForm'); f.elements.scopeId.value = 'b'; f.elements.scopeType.value = 'organization'; f.elements.scopeType.dispatchEvent(new Event('change')); })()");
    for (let i = 0; i < 40; i += 1) { if (await evaluate("document.querySelector('#priceForm [name=scopeId]').textContent.includes('甲方门店')")) break; await pause(50); }
    assert.equal(await evaluate("document.querySelector('#priceForm [name=scopeId]').value"), '', 'Switching price scope must clear previous customer');
    await evaluate("(() => { const f = document.querySelector('#priceForm'); f.elements.scopeType.value = 'public'; f.elements.scopeType.dispatchEvent(new Event('change')); })()");
    await evaluate("(() => { const f = document.querySelector('#priceForm'); f.elements.skuId.value = 's1'; f.elements.amountCent.value = '25.999'; window.confirm = () => true; f.requestSubmit(); })()");
    await pause(50);
    assert.equal(await evaluate('window.__writes.length'), 0, 'Invalid money must not write');
    await evaluate("(() => { const f = document.querySelector('#priceForm'); f.elements.amountCent.value = '25.00'; window.confirm = () => false; f.requestSubmit(); })()");
    await pause(50);
    assert.equal(await evaluate('window.__writes.length'), 0, 'Cancelled price save must not write');
    await evaluate("(() => { window.confirm = () => true; document.querySelector('#priceForm').requestSubmit(); })()");
    for (let i = 0; i < 40; i += 1) {
      if (await evaluate('window.__writes.length') === 1) break;
      await pause(100);
    }
    assert.equal(await evaluate('window.__writes[0].amountCent'), 2500, '25 yuan must be stored as 2500 cents');
    await send('Page.navigate', { url: 'http://127.0.0.1:8765/access.html' });
    for (let i = 0; i < 40; i += 1) {
      if (await evaluate("Boolean(document.querySelector('[data-staff-action=\"create\"]'))")) break;
      await pause(100);
    }
    assert.match(await evaluate("document.querySelector('#staffPage').textContent"), /账号 ID（只读）/);
    assert.match(await evaluate("document.querySelector('#staffPage').textContent"), /未验证/);
    await evaluate("document.querySelector('[data-staff-action=\"create\"]').click()");
    assert.match(await evaluate("document.querySelector('[data-staff-form=\"create\"] [name=role]').textContent"), /超级管理员/);
    assert.match(await evaluate("document.querySelector('[data-staff-form=\"create\"] [name=role]').textContent"), /运营/);
    await send('Page.navigate', { url: 'http://127.0.0.1:8765/product-review.html' });
    for (let i = 0; i < 40; i += 1) {
      if (await evaluate("Boolean(document.querySelector('#linkMediaAsset'))")) break;
      if (i === 39) throw new Error('Product review did not load');
      await pause(100);
    }
    assert.equal(await evaluate("document.querySelector('#publishReviewed').disabled"), true, 'Missing cover cannot publish');
    assert.match(await evaluate("document.querySelector('#reviewDetail').textContent"), /¥12.50（个人顾客价格 · 仅小程序）/);
    await evaluate("(() => { document.querySelector('#linkMediaAsset').value = 'm1'; document.querySelector('#linkMediaRole').value = 'detail'; document.querySelector('#linkSkuCode').value = 'S-001'; document.querySelector('#linkMedia').click(); })()");
    for (let i = 0; i < 40; i += 1) {
      if (await evaluate("window.__writes.some(item => item.action === 'admin.productMedia.linkByCode')")) break;
      await pause(100);
    }
    assert.equal(await evaluate("window.__writes.find(item => item.action === 'admin.productMedia.linkByCode').productCode"), 'P-001');
    assert.equal(await evaluate("window.__writes.find(item => item.action === 'admin.productMedia.linkByCode').skuCode"), 'S-001');
    await evaluate(`(() => {
      const call = window.MengshixianAdminApi.call;
      window.__publishes = [];
      window.MengshixianAdminApi.call = async (action, payload) => {
        if (action === 'admin.products.publishReviewed') { window.__publishes.push(payload); window.__published = true; return { status: 'on_sale' }; }
        const result = await call(action, payload);
        return action === 'admin.products.review' ? { ...result, product: { ...result.product, status: window.__published ? 'on_sale' : 'draft' }, ready: true, issues: [], cover: { name: '本地主图', fileId: 'test-cover' } } : result;
      };
      window.cloudbase = { init: () => ({ getTempFileURL: async () => ({ fileList: [{ tempFileURL: '/missing-preview-test.png' }] }) }) };
      document.querySelector('#retryReview').click();
    })()`);
    for (let i = 0; i < 60; i += 1) {
      if (await evaluate("document.querySelector('#mediaPreviewWarning')?.textContent.includes('预览失败')")) break;
      await pause(50);
    }
    assert.equal(await evaluate("document.querySelector('#publishReviewed').disabled"), true, 'Broken image URL must block publish even when API says ready');
    await evaluate("window.cloudbase.init = () => ({ getTempFileURL: async () => ({ fileList: [{ tempFileURL: '/assets/logo.png' }] }) }); document.querySelector('#retryReview').click()");
    for (let i = 0; i < 60; i += 1) {
      if (await evaluate("document.querySelector('#publishReviewed')?.disabled === false")) break;
      await pause(50);
    }
    assert.equal(await evaluate("document.querySelector('#publishReviewed').disabled"), false, 'Successfully loaded real local PNG permits manual confirmation');
    assert.equal(await evaluate("document.querySelector('#reviewDetail img').naturalWidth > 0"), true);
    await evaluate(`(() => {
      const previous = window.MengshixianAdminApi.call;
      window.MengshixianAdminApi.call = async (action, payload) => {
        const result = await previous(action, payload);
        return action === 'admin.products.review' ? { ...result, videos: [{ name: '测试视频', fileId: 'test-video' }] } : result;
      };
      window.cloudbase.init = () => ({ getTempFileURL: async ({ fileList }) => ({ fileList: [{ tempFileURL: fileList[0] === 'test-video' ? '/missing-video-test.webm' : '/assets/logo.png' }] }) });
      document.querySelector('#retryReview').click();
    })()`);
    for (let i = 0; i < 60; i += 1) {
      if (await evaluate("document.querySelector('#mediaPreviewWarning')?.textContent.includes('预览失败')")) break;
      await pause(50);
    }
    assert.equal(await evaluate("document.querySelector('#publishReviewed').disabled"), true, 'Unplayable video must block publication');
    assert.equal(await evaluate("Boolean(document.querySelector('#reviewDetail video').error)"), true);
    await evaluate(`(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
      const context = canvas.getContext('2d'); const stream = canvas.captureStream(10);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' }); const chunks = [];
      recorder.ondataavailable = event => chunks.push(event.data);
      const stopped = new Promise(resolve => recorder.onstop = resolve); recorder.start();
      for (let i = 0; i < 8; i++) { context.fillStyle = i % 2 ? '#1565c0' : '#ffffff'; context.fillRect(0, 0, 64, 64); await new Promise(resolve => setTimeout(resolve, 100)); }
      recorder.stop(); await stopped; stream.getTracks().forEach(track => track.stop());
      window.__videoPreviewUrl = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
      window.cloudbase.init = () => ({ getTempFileURL: ({ fileList }) => fileList[0] === 'test-video'
        ? new Promise(resolve => { window.__releaseVideoUrl = () => resolve({ fileList: [{ tempFileURL: window.__videoPreviewUrl }] }); })
        : Promise.resolve({ fileList: [{ tempFileURL: '/assets/logo.png' }] }) });
      document.querySelector('#retryReview').click();
    })()`);
    for (let i = 0; i < 60; i += 1) { if (await evaluate('Boolean(window.__releaseVideoUrl)')) break; await pause(50); }
    assert.equal(await evaluate("!document.querySelector('#publishReviewed') || document.querySelector('#publishReviewed').disabled"), true, 'Pending video URL must not leave an enabled publish button');
    await evaluate('window.__releaseVideoUrl()');
    for (let i = 0; i < 60; i += 1) { if (await evaluate("document.querySelector('#publishReviewed')?.disabled === false")) break; await pause(50); }
    assert.equal(await evaluate("document.querySelector('#publishReviewed').disabled"), false);
    await evaluate("(async () => { const video = document.querySelector('#reviewDetail video'); video.muted = true; await video.play(); })()");
    for (let i = 0; i < 60; i += 1) { if (await evaluate("document.querySelector('#reviewDetail video').currentTime > 0.1")) break; await pause(50); }
    assert.equal(await evaluate("document.querySelector('#reviewDetail video').currentTime > 0.1"), true, 'Generated WebM must actually play, not merely have a URL');
    await evaluate("document.querySelector('#reviewDetail video').pause(); window.confirm = text => { window.__publishConfirmation = text; return false; }; document.querySelector('#publishReviewed').click()");
    await pause(50);
    assert.equal(await evaluate('window.__publishes.length'), 0, 'Cancelling publication must not call publish API');
    assert.match(await evaluate('window.__publishConfirmation'), /精选虾仁[\s\S]*P-001[\s\S]*1 个销售规格/);
    await evaluate(`(() => {
      window.cloudbase.init = () => ({ getTempFileURL: async ({ fileList }) => ({ fileList: [{ tempFileURL: fileList[0] === 'test-video' ? window.__videoPreviewUrl : '/assets/logo.png' }] }) });
      window.confirm = () => true;
      document.querySelector('#publishReviewed').click();
      document.querySelector('#publishReviewed').click();
    })()`);
    for (let i = 0; i < 60; i += 1) { if (await evaluate("document.querySelector('#globalMessage').textContent.includes('已明确确认并发布')")) break; await pause(50); }
    assert.deepEqual(await evaluate('window.__publishes'), [{ id: 'p1', reviewToken: 'mock-review' }], 'Double click must submit only current product and review token once');
    assert.match(await evaluate("document.querySelector('#reviewDetail').textContent"), /当前已上架/);
    assert.equal(await evaluate("document.querySelector('#publishReviewed') === null"), true);
    await evaluate('URL.revokeObjectURL(window.__videoPreviewUrl)');
    await send('Page.navigate', { url: 'http://127.0.0.1:8765/products.html' });
    for (let i = 0; i < 40; i += 1) { if (await evaluate("Boolean(document.querySelector('[data-add-form=\"#productMediaForm\"]'))")) break; await pause(50); }
    await evaluate("document.querySelector('[data-tab=\"prod-media\"]').click(); document.querySelector('[data-add-form=\"#productMediaForm\"]').click()");
    assert.deepEqual(await evaluate("['productId','skuId','mediaAssetId'].map(name => document.querySelector('#productMediaForm').elements[name].tagName)"), ['SELECT', 'SELECT', 'SELECT']);
    await evaluate("(() => { const f = document.querySelector('#productMediaForm'); f.elements.productId.value = 'p1'; f.elements.productId.dispatchEvent(new Event('change')); })()");
    assert.match(await evaluate("document.querySelector('#productMediaForm').elements.skuId.textContent"), /500克/);
    await evaluate("(() => { const f = document.querySelector('#productMediaForm'); f.elements.skuId.value = 's1'; f.elements.productId.value = ''; f.elements.productId.dispatchEvent(new Event('change')); })()");
    assert.equal(await evaluate("document.querySelector('#productMediaForm').elements.skuId.value"), '', 'Changing product must clear previous SKU association');
    await send('Page.navigate', { url: 'http://127.0.0.1:8765/users.html' });
    for (let i = 0; i < 40; i += 1) { if (await evaluate("Boolean(document.querySelector('[data-edit-user-pricing]'))")) break; await pause(50); }
    assert.match(await evaluate("document.querySelector('#usersTable').textContent"), /张先生/);
    assert.doesNotMatch(await evaluate("document.querySelector('#usersTable').textContent"), /customer-private-id/);
    await evaluate("document.querySelector('[data-edit-user-pricing]').click()");
    assert.equal(await evaluate("document.querySelector('#userPricingForm').elements.id.type"), 'hidden');
    assert.equal(await evaluate("document.querySelector('#userPricingForm').elements.organizationId.tagName"), 'SELECT');
    await evaluate("(() => { const f = document.querySelector('#userPricingForm'); f.elements.userType.value = 'b'; f.elements.userType.dispatchEvent(new Event('change')); f.elements.organizationId.value = 'org-a'; window.confirm = () => false; f.requestSubmit(); })()");
    await pause(50);
    assert.equal(await evaluate('window.__writes.length'), 0, 'Cancelling customer identity adjustment must not write');
    await evaluate("window.confirm = (text) => { window.__confirmation = text; return true; }; document.querySelector('#userPricingForm').requestSubmit()");
    for (let i = 0; i < 40; i += 1) { if (await evaluate('window.__writes.length === 1')) break; await pause(50); }
    assert.match(await evaluate('window.__confirmation'), /张先生[\s\S]*甲方门店/);
    assert.equal(await evaluate('window.__writes[0].organizationId'), 'org-a');
    assert.equal(await evaluate('window.__writes[0].id'), 'customer-private-id');
    await send('Page.navigate', { url: 'http://127.0.0.1:8765/index.html?failOrders=1' });
    for (let i = 0; i < 60; i += 1) {
      if (await evaluate("document.querySelector('#overviewOrders')?.textContent.includes('暂不可用')")) break;
      await pause(100);
    }
    assert.match(await evaluate("document.querySelector('#taskMetrics').textContent"), /暂不可用/);
    assert.doesNotMatch(await evaluate("document.querySelector('#overviewOrders').textContent"), /没有订单记录/);
    assert.doesNotMatch(await evaluate("document.querySelector('#overviewQueue').textContent"), /没有待处理事项/);
    await send('Page.navigate', { url: 'http://127.0.0.1:8765/index.html' });
    for (let i = 0; i < 60; i += 1) {
      if (await evaluate("document.querySelector('#overviewOrders')?.textContent.includes('当前没有订单记录')")) break;
      await pause(100);
    }
    assert.equal(await evaluate("document.querySelector('#taskMetrics .task-card strong').textContent"), '0');
    assert.doesNotMatch(await evaluate("document.querySelector('#taskMetrics').textContent"), /暂不可用|正在读取/);
    await send('Page.navigate', { url: 'http://127.0.0.1:8765/slots.html' });
    for (let i = 0; i < 60; i += 1) { if (await evaluate("Boolean(document.querySelector('[data-add-form=\"#deliverySlotForm\"]'))")) break; await pause(50); }
    await evaluate("document.querySelector('[data-add-form=\"#deliverySlotForm\"]').click()");
    await evaluate(`(() => { const form = document.querySelector('#deliverySlotForm'); form.elements.name.value = '上午配送'; form.elements.deliveryAreaId.value = 'area-private'; form.elements.warehouseId.value = 'warehouse-private'; form.elements.startTime.value = '09:00'; form.elements.endTime.value = '12:00'; window.confirm = text => { window.__confirmation = text; return false; }; form.requestSubmit(); })()`);
    await pause(50);
    assert.equal(await evaluate('window.__writes.length'), 0);
    assert.match(await evaluate('window.__confirmation'), /城区配送[\s\S]*中心仓[\s\S]*09:00–12:00/);
    assert.doesNotMatch(await evaluate('window.__confirmation'), /area-private|warehouse-private/);
    await evaluate("window.confirm = () => true; document.querySelector('#deliverySlotForm').requestSubmit()");
    for (let i = 0; i < 60; i += 1) { if (await evaluate('window.__writes.length === 1')) break; await pause(50); }
    assert.equal(await evaluate('window.__writes[0].warehouseId'), 'warehouse-private');
    await send('Page.navigate', { url: 'http://127.0.0.1:8765/areas.html' });
    for (let i = 0; i < 60; i += 1) { if (await evaluate("Boolean(document.querySelector('[data-add-form=\"#deliveryAreaForm\"]'))")) break; await pause(50); }
    await evaluate("document.querySelector('[data-add-form=\"#deliveryAreaForm\"]').click()");
    assert.equal(await evaluate("document.querySelector('#deliveryAreaForm').elements.status.value"), 'disabled', 'New delivery area must stay disabled until operator enables it');
    await evaluate("document.querySelector('#deliveryAreaForm [data-role=open-picker]').click()");
    await evaluate("document.querySelector('[data-col=province] .region-picker-item').click(); document.querySelector('[data-col=city] .region-picker-item').click(); document.querySelector('[data-col=district] .region-picker-item').click(); document.querySelector('[data-role=confirm]').click()");
    await evaluate("(() => { const form = document.querySelector('#deliveryAreaForm'); form.elements.name.value = '本地配送验收'; form.querySelector('.warehouse-name-choices input').click(); window.confirm = text => { window.__confirmation = text; return false; }; form.requestSubmit(); })()");
    await pause(50);
    assert.equal(await evaluate('window.__writes.length'), 0);
    assert.match(await evaluate('window.__confirmation'), /中心仓[\s\S]*保存后停用/);
    assert.equal(await evaluate("document.querySelector('#deliveryAreaForm').elements.regionNames.value.length > 0"), true);
    await evaluate("window.confirm = () => true; document.querySelector('#deliveryAreaForm').requestSubmit()");
    for (let i = 0; i < 60; i += 1) { if (await evaluate('window.__writes.length === 1')) break; await pause(50); }
    assert.equal(await evaluate('window.__writes[0].status'), 'disabled');
    assert.equal(await evaluate('window.__writes[0].regionCodes.length'), 1);
    assert.deepEqual(await evaluate('window.__writes[0].warehouseIds'), ['warehouse-private']);
    await require('./order-receipts-browser.cjs')({ send, evaluate, pause });
    if (process.argv.includes('--actual-receipts')) await require('./receipt-actual-api-browser.cjs')({ send, evaluate, pause, socket });
    if (process.argv.includes('--actual-catalog')) await require('./catalog-actual-api-browser.cjs')({ send, evaluate, pause, socket });
    if (process.argv.includes('--actual-staff')) await require('./staff-actual-api-browser.cjs')({ send, evaluate, pause, socket });
    console.log('Edge mock import, content, pricing, customer, media, dashboard, delivery and receipt confirmation workflow: passed');
  } finally {
    clearTimeout(watchdog);
    socket.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => browser.kill());
