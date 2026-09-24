const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const parser = require('../admin-import-parser');
class Button {
  addEventListener(name, fn) { this[name] = fn; }
}
async function main() {
  let button;
  const host = {
    set innerHTML(value) { this.html = value; button = new Button(); },
    querySelector: selector => selector === '#applyImportMapping' ? button : { value: 'new' }
  };
  const document = {
    getElementById: () => host,
    body: { appendChild() {} },
    createElement: () => ({ click() {}, remove() {} })
  };
  const window = { MengshixianImportParser: parser, crypto: require('node:crypto').webcrypto, setTimeout: fn => fn() };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../admin-import-mapping.js'), 'utf8'), { window, document, Blob, URL });
  const data = name => parser.prepareTable([
    { line: 1, cells: ['商品编码', '规格编码', '商品名称', '分类', '规格', '包装单位'] },
    { line: 2, cells: ['', '', name, '测试分类', '500克', '袋'] }
  ], name, `${name}.csv`);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  window.MengshixianImportMapping.mount(data('旧表'), [], () => gate);
  const oldWork = button.click();
  window.MengshixianImportMapping.mount(data('新表'), [], async () => {});
  const newButton = button;
  assert.equal(host.hidden, false);
  release(); await oldWork;
  assert.equal(host.hidden, false, '旧表核对完成不能隐藏新表的编码面板');
  await newButton.click();
  assert.equal(host.hidden, true, '当前表核对完成可以关闭自己的面板');
  console.log('Mapping panel ownership: late old completion preserves the new table panel');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
