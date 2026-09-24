const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { File } = require('node:buffer');
const parser = require('../admin-import-parser');
const { createCatalogFixture } = require('./support/catalog-flow-fixture.cjs');

class Element {
  constructor() { this.handlers = {}; this.children = []; this.hidden = true; this.disabled = false; }
  addEventListener(name, handler) { this.handlers[name] = handler; }
  appendChild(child) { this.children.push(child); }
  replaceChildren() { this.children = []; }
}
async function main() {
  const fixture = await createCatalogFixture();
  const ids = ['stagingFile', 'importPreview', 'importPreviewSummary', 'importPreviewRows', 'saveImportDrafts', 'downloadImportTemplate', 'importMapping'];
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  const window = { MengshixianImportParser: parser, confirm: () => true };
  const document = { getElementById: id => elements[id], createElement: () => new Element() };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../admin-import-workflow.js'), 'utf8'), { window, document });
  let releaseA, reachedA;
  const gate = new Promise(resolve => { releaseA = resolve; });
  const started = new Promise(resolve => { reachedA = resolve; });
  let releaseSave, reachedSave;
  const saveGate = new Promise(resolve => { releaseSave = resolve; });
  const savingStarted = new Promise(resolve => { reachedSave = resolve; });
  const savedNames = [];
  window.MengshixianImportWorkflow.start({
    message() {}, refresh: async () => {},
    call: async (action, payload) => {
      if (action === 'admin.imports.preview' && payload.rows[0].parsed.name === '先选商品') {
        reachedA(); await gate;
      }
      if (action === 'admin.imports.stage') {
        savedNames.push(payload.rows[0].parsed.name);
        reachedSave(); await saveGate;
      }
      return fixture.call(action, payload);
    }
  });
  const choose = (code, name) => {
    elements.stagingFile.files = [new File([`商品编码,规格编码,商品名称,分类,规格,包装单位\n${code},${code}-S,${name},本地分类,500克,袋`], `${code}.csv`)];
    return elements.stagingFile.handlers.change();
  };
  const first = choose('RACE-A', '先选商品');
  await started;
  await choose('RACE-B', '最后选择商品');
  releaseA(); await first;
  assert.match(elements.importPreviewSummary.textContent, /RACE-B.csv/, '迟到的第一份预览不能覆盖最后选择的表格');
  const saving = elements.saveImportDrafts.handlers.click();
  await savingStarted;
  assert.equal(elements.stagingFile.disabled, true, '保存期间应锁定文件选择');
  await choose('RACE-C', '保存中不能换表');
  releaseSave(); await saving;
  assert.equal(elements.stagingFile.disabled, false);
  assert.match(elements.importPreviewSummary.textContent, /RACE-B.csv/);
  assert.deepEqual(savedNames, ['最后选择商品']);
  const jobs = await fixture.call('admin.imports.list');
  assert.equal(jobs.rows.length, 1);
  assert.equal(jobs.rows[0].parsedPayload.name, '最后选择商品');
  console.log('Import file selection race: actual parser/API save only the latest selected table');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
