// Delivered XLSX -> real import page -> actual application dispatch; only storage is in memory.
const assert = require('node:assert/strict');
const { createCatalogFixture } = require('./support/catalog-flow-fixture.cjs');

module.exports = async function actualCatalogFlow({ send, evaluate, pause, socket }) {
  const fixture = await createCatalogFixture();
  const read = async () => ({
    jobs: (await fixture.call('admin.imports.list', { pageSize: 100 })).rows,
    products: (await fixture.call('admin.products.list', { pageSize: 100 })).rows,
    skus: (await fixture.call('admin.skus.list', { pageSize: 100 })).rows
  });
  assert.deepEqual(await read(), { jobs: [], products: [], skus: [] }, '夹具从空商品、空导入草稿开始');

  const requests = [];
  let holdMappingPreview = false, releaseMappingPreview;
  let loseNextInventoryReply = false;
  const binding = 'localCatalogApi';
  const handler = async ({ data }) => {
    const event = JSON.parse(data);
    if (event.method !== 'Runtime.bindingCalled' || event.params.name !== binding) return;
    const input = JSON.parse(event.params.payload);
    let response;
    try {
      requests.push({ action: input.action, payload: input.payload });
      if (holdMappingPreview && input.action === 'admin.imports.preview') {
        await new Promise(resolve => { releaseMappingPreview = resolve; });
      }
      response = { id: input.id, data: input.action === '__local.mediaUrls'
        ? { fileList: input.payload.fileList.map(fileID => ({ fileID, tempFileURL: fixture.mediaUrl(fileID) })) }
        : await fixture.call(input.action, input.payload) };
      if (loseNextInventoryReply && input.action === 'admin.inventory.adjust') {
        loseNextInventoryReply = false;
        response = { id: input.id, error: { code: 'NETWORK_TIMEOUT', message: '本地模拟：库存已记账，但成功回执丢失' } };
      }
    } catch (error) {
      response = { id: input.id, error: { code: error.code, message: error.message } };
    }
    await send('Runtime.evaluate', {
      expression: `window.__resolveLocalCatalog(${JSON.stringify(response)})`,
      contextId: event.params.executionContextId
    });
  };
  socket.addEventListener('message', handler);
  await send('Runtime.enable');
  await send('Runtime.addBinding', { name: binding });
  const script = await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    (() => {
      const pending = new Map(); let sequence = 0;
      window.__resolveLocalCatalog = response => {
        const task = pending.get(response.id); if (!task) return;
        pending.delete(response.id);
        response.error ? task.reject(Object.assign(new Error(response.error.message), { code: response.error.code })) : task.resolve(response.data);
      };
      window.MengshixianAdminApi = {
        getToken: () => 'isolated-local-only', setToken: () => {}, config: { envId: 'local-memory-only' },
        call: (action, payload = {}) => new Promise((resolve, reject) => {
          const id = ++sequence; pending.set(id, { resolve, reject });
          window.localCatalogApi(JSON.stringify({ id, action, payload }));
        })
      };
      // Browser transport and cloud storage boundaries only; upload/registration/link business APIs remain real.
      window.MengshixianAdminApi.uploadMediaFile = async (file, type, progress) => {
        if (file.size > 4 * 1024 * 1024) throw new Error('Local small-file test adapter only');
        progress({phase:'checking', percent:0});
        const contentBase64 = await new Promise((resolve, reject) => {
          const reader = new FileReader(); reader.onerror = reject;
          reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(file);
        });
        const result = await window.MengshixianAdminApi.call('admin.media.upload', {
          type, fileName:file.name, mimeType:file.type, sizeBytes:file.size, contentBase64
        });
        progress({phase:'complete', percent:100}); return result;
      };
      window.cloudbase = { init: () => ({ getTempFileURL: payload => window.MengshixianAdminApi.call('__local.mediaUrls', payload) }) };
    })();
  ` });
  const waitFor = async (expression) => {
    for (let i = 0; i < 100; i += 1) {
      if (await evaluate(expression)) return;
      await pause(40);
    }
    assert.fail(`Browser condition not met: ${expression}; actions=${requests.map((item) => item.action).join(',')}; page=${await evaluate('document.body.innerText.slice(-1400)')}`);
  };
  const workbookBase = '/outputs/01a0cd53-41af-7eb2-824f-c1e8b42fa25d/';
  const selectDelivered = async (name) => evaluate(`(async () => {
    const response = await fetch(${JSON.stringify(workbookBase)} + ${JSON.stringify(name)});
    if (!response.ok) throw new Error('交付文件不可读取：' + response.status);
    const transfer = new DataTransfer();
    transfer.items.add(new File([await response.blob()], ${JSON.stringify(name)}, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const input = document.querySelector('#stagingFile');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change'));
  })()`);
  const stageCalls = () => requests.filter((item) => item.action === 'admin.imports.stage');

  try {
    await send('Page.navigate', { url: 'http://127.0.0.1:8765/imports.html' });
    await waitFor("Boolean(window.MengshixianImportParser && document.querySelector('#stagingFile') && document.querySelector('#saveImportDrafts'))");

    await selectDelivered('商品导入空白模板.xlsx');
    await waitFor("document.querySelector('#globalMessage')?.textContent.includes('没有商品数据行')");
    assert.equal(await evaluate("document.querySelector('#importPreview').hidden"), true, '空白表格不能打开可保存预览');
    assert.equal(await evaluate("document.querySelector('#saveImportDrafts').disabled"), true);
    assert.deepEqual(await read(), { jobs: [], products: [], skus: [] }, '空白表格不得写入');
    assert.equal(stageCalls().length, 0);

    await evaluate(`(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['商品编码,规格编码,商品名称,分类,规格,包装单位\\nERR-A,ERR-A-S,,本地分类,500克,袋\\nERR-B,ERR-B-S,本地核错商品,本地分类,500克,袋\\nERR-B,ERR-B-S,本地核错商品,本地分类,500克,袋'], '仅本地逐行错误.csv'));
      const input = document.querySelector('#stagingFile'); input.files = transfer.files; input.dispatchEvent(new Event('change'));
    })()`);
    await waitFor("document.querySelector('#importPreviewSummary').textContent.includes('仅本地逐行错误.csv') && !document.querySelector('#importPreview').hidden");
    const checks = await evaluate("Array.from(document.querySelectorAll('#importPreviewRows tr'), row => ({line: row.cells[0].textContent, reason:row.cells[7].textContent}))");
    assert.match(checks.find(row => row.line === '2').reason, /商品名称/);
    assert.match(checks.find(row => row.line === '4').reason, /重复/);
    assert.match(checks.find(row => row.line === '3').reason, /价格待补齐.*主图待补齐/);
    assert.equal((await read()).jobs.length, 0, '逐行错误预览不保存任何行');

    await selectDelivered('商品导入测试演示_仅本地.xlsx');
    await waitFor("document.querySelector('#importPreviewSummary')?.textContent.includes('可保存 6 行')");
    assert.equal(await evaluate("document.querySelectorAll('#importPreviewRows tr').length"), 6);
    assert.equal(await evaluate("Array.from(document.querySelectorAll('#importPreviewRows tr')).every((row, index) => row.cells[0].textContent === String(index + 2) && /价格待补齐/.test(row.cells[7].textContent) && /主图待补齐/.test(row.cells[7].textContent))"), true, '交付演示表每行显示来源行号及实际缺项');
    assert.equal(await evaluate("document.querySelector('#importPreviewRows tr')?.textContent.includes('黄金鲍鱼肉')"), true);
    assert.equal(await evaluate("document.querySelector('#saveImportDrafts').disabled"), false);
    assert.deepEqual(await read(), { jobs: [], products: [], skus: [] }, '选择和预览演示表不得写入');
    assert.equal(stageCalls().length, 0);

    await evaluate("window.confirm = () => false; document.querySelector('#saveImportDrafts').click()");
    assert.deepEqual(await read(), { jobs: [], products: [], skus: [] }, '取消确认必须零写入');
    assert.equal(stageCalls().length, 0);

    await evaluate("window.confirm = () => true; document.querySelector('#saveImportDrafts').click()");
    await waitFor("document.querySelector('#globalMessage')?.textContent.includes('新建 6 条待补齐草稿')");
    const afterSave = await read();
    assert.equal(afterSave.jobs.length, 6, '实际 API 应保存六条导入草稿');
    assert.equal(new Set(afterSave.jobs.map((job) => job.parsedPayload.skuCode)).size, 6, '每个规格编码只建立一条草稿');
    assert.equal(afterSave.jobs.every((job) => job.status === 'staged'), true);
    assert.deepEqual(afterSave.products, [], '保存导入草稿不得自动生成商品');
    assert.deepEqual(afterSave.skus, [], '保存导入草稿不得自动生成销售规格或上架');
    assert.equal(stageCalls().length, 1);
    assert.equal(stageCalls()[0].payload.rows.length, 6, '页面须向实际 API 提交交付表的六行');

    await evaluate("document.querySelector('#saveImportDrafts').click()");
    await waitFor("document.querySelector('#globalMessage')?.textContent.includes('重复跳过 6 条')");
    assert.equal((await read()).jobs.length, 6, '重复确认不得多建草稿');
    assert.equal(stageCalls().length, 2);

    await selectDelivered('商品导入测试演示_仅本地.xlsx');
    await waitFor("document.querySelector('#importPreviewSummary')?.textContent.includes('重复 6 行')");
    assert.equal(await evaluate("document.querySelector('#saveImportDrafts').disabled"), true, '重复上传后无可保存行');
    assert.equal((await read()).jobs.length, 6, '重复上传不得多建草稿');
    assert.equal((await read()).products.length, 0, '重复上传也不能生成在售商品');
    assert.equal(stageCalls().length, 2);
    console.log('Delivered XLSX -> browser preview -> actual API: blank rejected; selection/cancel zero writes; six staged; retry and reupload deduplicated; no products published');

    // A separate synthetic two-row file exercises updating mappings while save is available.
    await evaluate(`(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['商品编码,规格编码,商品名称,分类,规格,包装单位\\nBROWSER-MAP,BROWSER-MAP-S,编码交错测试一,测试分类,500克,袋\\n,,编码交错测试二,测试分类,1千克,袋'], '仅本地编码交错.csv'));
      const input = document.querySelector('#stagingFile'); input.files = transfer.files;
      input.dispatchEvent(new Event('change'));
    })()`);
    await waitFor("!document.querySelector('#importMapping').hidden && !document.querySelector('#saveImportDrafts').disabled");
    holdMappingPreview = true;
    await evaluate("document.querySelector('#applyImportMapping').click()");
    for (let i = 0; i < 100 && !releaseMappingPreview; i++) await pause(40);
    assert.ok(releaseMappingPreview, '等待中的映射核对必须真的到达API边界');
    assert.equal(await evaluate("document.querySelector('#saveImportDrafts').disabled"), true);
    await evaluate("document.querySelector('#saveImportDrafts').click()");
    assert.equal((await read()).jobs.length, 6, '映射等待时不能保存旧结果');
    holdMappingPreview = false;
    releaseMappingPreview();
    await waitFor("document.querySelector('#importPreviewSummary').textContent.includes('可保存 2 行') && !document.querySelector('#saveImportDrafts').disabled");
    await evaluate("document.querySelector('#saveImportDrafts').click()");
    await waitFor("document.querySelector('#globalMessage').textContent.includes('新建 2 条待补齐草稿')");
    assert.equal((await read()).jobs.length, 8);
    assert.equal((await read()).products.length, 0);
    console.log('Browser mapping race: pending recheck blocks save; completed recheck stages both rows without publishing');
    const { productCode } = await require('./catalog-draft-review-browser.cjs')({ fixture, evaluate, waitFor, pause });
    if (process.argv.includes('--actual-catalog-media')) {
      await require('./catalog-media-browser.cjs')({ fixture, send, evaluate, pause, waitFor, productCode });
      if (process.argv.includes('--actual-catalog-ready')) {
        const context = {fixture, send, evaluate, pause, waitFor, productCode,
          loseNextInventoryReply: () => { loseNextInventoryReply = true; }};
        await require('./catalog-pricing-browser.cjs')(context);
        await require('./catalog-inventory-browser.cjs')(context);
        await require('./catalog-delivery-browser.cjs')(context);
        await require('./catalog-publish-browser.cjs')(context);
        await require('./sku-gate-browser.cjs')(context);
        await send('Page.navigate', { url: 'http://127.0.0.1:8765/opening-check.html' });
        await waitFor("document.querySelector('#openingCheckStatus')?.textContent.includes('基础资料均有记录')");
        const openingResult = await evaluate("({ items: document.querySelector('#openingCheckItems').textContent, payment: document.querySelector('#openingCheckPayment').textContent, status: document.querySelector('#openingCheckStatus').textContent })");
        assert.match(openingResult.items, /已找到配送区域[\s\S]*已找到配送时段[\s\S]*已找到库存记录/);
        assert.match(openingResult.payment, /尚未核验/);
        assert.doesNotMatch(openingResult.status, /可以开店|已可下单/);
        console.log('Opening check reads the same local actual API data; existing records still require delivery, quote and payment verification');
      }
    }
  } finally {
    socket.removeEventListener('message', handler);
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: script.identifier });
    await send('Runtime.removeBinding', { name: binding });
  }
};
