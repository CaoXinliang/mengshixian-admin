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
  click() {}
  remove() {}
}
async function main() {
  const fixture = await createCatalogFixture();
  const ids = ['stagingFile', 'importPreview', 'importPreviewSummary', 'importPreviewRows', 'saveImportDrafts', 'downloadImportTemplate', 'importMapping'];
  const nodes = Object.fromEntries(ids.map(id => [id, new Element()]));
  const mapButton = new Element();
  nodes.importMapping.querySelector = selector => selector === '#applyImportMapping' ? mapButton : { value: 'new' };
  const window = { MengshixianImportParser: parser, confirm: () => true, crypto: require('node:crypto').webcrypto, setTimeout: fn => fn() };
  const document = { body: new Element(), getElementById: id => nodes[id], createElement: () => new Element() };
  const context = vm.createContext({ window, document, Blob, URL });
  for (const file of ['admin-import-mapping.js', 'admin-import-workflow.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  }
  let release, reached, delay = false;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { reached = resolve; });
  window.MengshixianImportWorkflow.start({ message() {}, refresh: async () => {}, call: async (action, payload) => {
    if (delay && action === 'admin.imports.preview') { reached(); await gate; }
    return fixture.call(action, payload);
  } });
  nodes.stagingFile.files = [new File(['商品编码,规格编码,商品名称,分类,规格,包装单位\nKNOWN,KNOWN-S,已有编码商品,测试分类,500克,袋\n,,待分配编码商品,测试分类,1千克,袋'], '编码核对.csv')];
  await nodes.stagingFile.handlers.change();
  assert.equal(nodes.saveImportDrafts.disabled, false, '原预览有一条可保存');
  delay = true;
  const mapping = mapButton.handlers.click();
  await started;
  assert.equal(mapButton.disabled, true, '核对等待中不能再次生成另一套编码');
  await mapButton.handlers.click();
  await nodes.saveImportDrafts.handlers.click();
  assert.equal((await fixture.call('admin.imports.list')).rows.length, 0, '映射预览未完成时不能保存旧的一条结果');
  assert.equal(nodes.saveImportDrafts.disabled, true);
  release(); await mapping;
  assert.equal(mapButton.disabled, false);
  assert.equal(nodes.saveImportDrafts.disabled, false);
  await nodes.saveImportDrafts.handlers.click();
  assert.equal((await fixture.call('admin.imports.list')).rows.length, 2, '核对完成后保存新的两条结果');
  console.log('Actual mapping/parser/API: pending mapping blocks stale save; completed mapping saves both drafts');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
