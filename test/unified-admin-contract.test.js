const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

for (const name of ['simple.html', 'simple.js', 'simple-editor.js', 'simple-live.js']) {
  assert.equal(fs.existsSync(path.join(root, name)), false, `${name} 不应作为第二套后台继续存在`);
}
assert.doesNotMatch(read('admin-shell.js'), /simple\.html|日常快捷版/, '侧栏只保留一个后台入口');
assert.doesNotMatch(read('index.html') + read('login.html'), /next=simple|simple\.html/, '登录后只进入统一工作台');
assert.match(read('admin-overview.js'), /orders\.html\?status=pending_confirmation/, '工作台待办应直达订单状态');
assert.match(read('products.html'), /id="productKeyword"/, '商品应支持搜索');
assert.match(read('products.html'), /href="product-workflow\.html"/, '新商品进入分步骤编辑');
assert.match(read('admin-tables.js'), /product-workflow\.html\?id=/, '现有商品进入分步骤编辑');
assert.match(read('admin-tables.js'), /data-edit-product=/, '专业资料入口仍保留');
assert.match(read('admin-tables.js'), /additionalFeeCent/, '运费行应展示附加运费');
assert.match(read('admin-tables.js'), /freeThresholdCent/, '运费行应展示免运门槛');
assert.doesNotMatch(read('admin-forms.js'), /（分）/, '表单静态文案不得再以分为单位');
assert.match(read('app.js'), /description: existing\.description \|\| ''/, '专业资料保存不得清空未展示的商品说明');
assert.match(read('product-workflow.html'), /admin-product-data\.js[\s\S]*admin-product-preview\.js[\s\S]*admin-product-workflow\.js/, '商品业务分离到独立模块');
assert.match(read('admin-product-workflow.js'), /真机验收/, '顾客预览必须说明真实验收边界');
console.log('single admin entry and guided product workflow: passed');
