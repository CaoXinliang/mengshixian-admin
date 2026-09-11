const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

const moduleNames = ['工作台', '商品中心', '订单中心', '库存配送', '客户中心', '内容运营', '营销中心', '系统管理'];
moduleNames.forEach((name) => assert.match(html, new RegExp(`<strong>${name}</strong>`), `左侧必须包含业务模块：${name}`));

assert.equal((html.match(/data-module=/g) || []).length, 8, '左侧只能展示 8 个一级业务模块');
assert.doesNotMatch(html.match(/<nav id="mainNav"[\s\S]*?<\/nav>/)[0], /data-panel=/, '一级导航不得继续平铺技术功能面板');
assert.match(html, /id="moduleTabs"/, '业务模块内部必须提供二级页签容器');
assert.match(source, /catalog:[\s\S]*?\['products', '商品管理'\][\s\S]*?\['categories', '分类管理'\][\s\S]*?\['imports', '批量导入'\][\s\S]*?\['pricing', '价格规则'\]/, '商品相关功能必须归入商品中心');
assert.match(source, /trade:[\s\S]*?\['orders', '订单履约'\][\s\S]*?\['refunds', '退款售后'\]/, '履约和售后必须归入订单中心');
assert.match(source, /data-go-panel/, '工作台待办卡必须能直接进入对应业务页面');
assert.match(styles, /\.module-tabs/, '模块页签必须有清晰的当前状态样式');
assert.match(styles, /button:focus-visible/, '键盘操作必须保留可见焦点');

console.log('admin module navigation contract: passed');
