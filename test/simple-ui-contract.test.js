const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'simple.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'simple.js'), 'utf8');
const fullSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

assert.match(html, /<script src="paging\.js\?v=[^"]+"><\/script>/, '简单后台必须加载分页保护模块');
assert.match(source, /MengshixianAdminPaging\.listAll\(api\.call, action\)/, '简单后台列表必须完整分页加载');
assert.doesNotMatch(source, /async function reloadTrade\(\)[\s\S]{0,400}pageSize:\s*50/, '订单和退款不能静默截断为前 50 条');

assert.match(source, /function previewPriceOf\(skuId, viewer\)/, 'B\/C 预览必须按顾客类型解析价格');
assert.match(source, /rule\.scopeType === 'customer_type' && rule\.scopeId === viewer/, '预览必须优先匹配顾客类型价格');
assert.match(source, /previewPriceOf\(sku\._id, state\.live\.viewer\)/, '商品列表模拟必须使用当前顾客视角价格');
assert.match(source, /previewPriceOf\(activeSku\._id, state\.live\.viewer\)/, '商品详情模拟必须使用当前顾客视角价格');

assert.match(html, /顾客视角模拟/, '预览标题必须明确其为模拟结果');
assert.doesNotMatch(html, /预览变了＝数据已经生效|与小程序顾客端同一接口实时读取/, '页面不得把管理端模拟描述成真机结果');
assert.match(html, /最终展示仍以体验版中对应身份的真机结果为准/, '页面必须提示最终真机验收边界');

assert.match(source, /const skuSummary = skus\.length/, '商品列表必须使用摘要，避免逐条展开所有规格');
assert.match(source, /categoryName \|\| categoryOf\(p\.categoryId\)/, '商品搜索必须支持分类名称回退');

assert.doesNotMatch(html, /<form id="loginForm">/, '简单后台不应维护第二套管理员登录表单');
assert.doesNotMatch(source, /api\.call\('admin\.login'/, '简单后台不应重复提交管理员密码');
assert.match(source, /redirectToFullLogin\('login_required'\)/, '简单后台无会话时必须转到统一登录入口');
assert.match(source, /index\.html\?\$\{query\.toString\(\)\}/, '统一登录入口必须带受控返回标记');
assert.match(fullSource, /params\.get\('next'\) === 'simple'/, '完整版只允许返回固定的简单后台页面');
assert.match(fullSource, /continueToRequestedPage\(\)/, '完整版登录成功后必须继续到请求页面');

console.log('simple admin UI and data-boundary contract: passed');
