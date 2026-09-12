const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'simple.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'simple.js'), 'utf8');
const fullSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

assert.match(html, /<script src="paging\.js\?v=[^"]+"><\/script>/, '简单后台必须加载分页保护模块');
assert.match(source, /MengshixianAdminPaging\.listAll\(api\.call, action, \{ params \}\)/, '简单后台列表必须完整分页加载并透传筛选参数');
assert.doesNotMatch(source, /async function reloadTrade\(\)[\s\S]{0,400}pageSize:\s*50/, '订单和退款不能静默截断为前 50 条');

assert.match(source, /function previewPriceOf\(skuId, viewer\)/, 'B\/C 预览必须按顾客类型解析价格');
assert.match(source, /function previewAmountCent\(rule, quantity\)/, '顾客视角详情必须随购买数量预览阶梯单价');
assert.match(source, /rule\.scopeType === 'customer_type' && rule\.scopeId === viewer/, '预览必须优先匹配顾客类型价格');
assert.match(source, /previewPriceOf\(sku\._id, state\.live\.viewer\)/, '商品列表模拟必须使用当前顾客视角价格');
assert.match(source, /previewPriceOf\(activeSku\._id, state\.live\.viewer\)/, '商品详情模拟必须使用当前顾客视角价格');
assert.match(source, /function parseTierLines\(value\)/, '普通后台必须把易读的元制阶梯价解析为服务端数据');
assert.match(source, /function purchaseRuleSummary\(sku, rule\)/, '商品列表与预览必须展示关键购买规则');
assert.match(source, /minOrderQuantity:\s*patch\.minOrderQuantity/, '规格保存必须提交起订量');
assert.match(source, /orderMultiple:\s*patch\.orderMultiple/, '规格保存必须提交整箱购买倍数');
assert.match(source, /quantityTiers, minOrderQuantity, orderMultiple/, '价格保存必须提交阶梯和价格级购买规则');
assert.match(source, /source:\s*aiDraft \? 'ai_generated' : 'client'/, 'AI 测试草案必须显式标记来源，不能伪装成运营正式数据');
assert.match(source, /temporary:\s*aiDraft/, 'AI 测试草案必须标记为临时数据');
assert.match(source, /由 AI 生成的测试草案，不代表真实经营价格/, '普通后台必须提示 AI 测试值不代表生产事实');

assert.match(html, /顾客视角模拟/, '预览标题必须明确其为模拟结果');
assert.doesNotMatch(html, /预览变了＝数据已经生效|与小程序顾客端同一接口实时读取/, '页面不得把管理端模拟描述成真机结果');
assert.match(html, /最终效果仍以手机体验版为准/, '页面必须提示最终真机验收边界');
assert.match(html, /purchase-rule-box/, '普通商品编辑器必须提供起订与阶梯价二级区块样式');

assert.match(source, /const skuSummary = skus\.length/, '商品列表必须使用摘要，避免逐条展开所有规格');
assert.match(source, /categoryName \|\| categoryOf\(p\.categoryId\)/, '商品搜索必须支持分类名称回退');
assert.match(html, /id="productPager"/, '商品列表必须提供明确的翻页区域');
assert.match(source, /const pageSize = 12/, '商品列表不得一次铺满所有商品');
assert.match(source, /共 \$\{matched\.length\} 个商品/, '分页必须告诉普通用户商品总数');
assert.match(html, /id="orderPager"/, '订单列表必须提供明确的翻页区域');
assert.match(html, /id="inventoryPager"/, '库存列表必须提供明确的翻页区域');
assert.match(source, /共 \$\{rows\.length\} 张订单/, '订单分页必须显示当前筛选总数');
assert.match(source, /共 \$\{rows\.length\} 条库存/, '库存分页必须显示搜索结果总数');

assert.doesNotMatch(html, /<form id="loginForm">/, '简单后台不应维护第二套管理员登录表单');
assert.doesNotMatch(source, /api\.call\('admin\.login'/, '简单后台不应重复提交管理员密码');
assert.match(source, /redirectToFullLogin\('login_required'\)/, '简单后台无会话时必须转到统一登录入口');
assert.match(source, /index\.html\?\$\{query\.toString\(\)\}/, '统一登录入口必须带受控返回标记');
assert.match(fullSource, /params\.get\('next'\) === 'simple'/, '完整版只允许返回固定的简单后台页面');
assert.match(fullSource, /continueToRequestedPage\(\)/, '完整版登录成功后必须继续到请求页面');

assert.match(html, /梦食鲜商家后台/, '普通用户主入口必须使用商家能理解的名称');
assert.doesNotMatch(html, />完整版</, '普通用户不应在两套后台模式之间选择');
assert.match(html, /href="index\.html\?mode=advanced">管理员高级设置</, '低频技术能力只能从高级设置进入');
const menuLabels = [...html.matchAll(/<button data-view="(dashboard|orders|products|inventory|refunds|customers|delivery|marketing|settings)"[^>]*>[\s\S]*?<strong>([^<]+)<\/strong>/g)].map((match) => match[2]);
assert.deepEqual(menuLabels, ['今日待办', '订单处理', '商品管理', '库存管理', '退款售后', '客户管理', '配送设置', '营销活动', '系统设置'], '左侧菜单必须严格保持九个日常经营模块');
assert.match(html, /id="customerModeChips"/, '客户管理必须同时提供企业申请和顾客概况');
assert.match(source, /admin\.businessApplications\.list/, '客户审核必须读取真实服务端申请列表');
assert.match(source, /admin\.businessApplications\.review/, '客户审核必须复用服务端审核动作');
assert.match(source, /admin\.deliveryAreas\.list/, '配送设置必须读取真实配送区域');
assert.match(source, /admin\.freightRules\.upsert/, '配送费必须保存到服务端');
assert.match(source, /admin\.deliverySlots\.upsert/, '配送时段必须保存到服务端');
assert.match(source, /admin\.groupCampaigns\.upsert/, '拼团活动必须保存到服务端');
assert.match(source, /admin\.password\.change/, '普通员工必须能修改自己的密码');
assert.match(source, /保存草稿/, '新增商品必须允许先保存草稿');
assert.match(source, /检查并上架/, '新增商品必须把上架作为明确检查动作');
assert.match(source, /function productReadiness\(product, skus\)/, '商品编辑页必须计算上架准备情况');
assert.match(source, /还不能上架：请补充/, '商品未准备好时必须给普通员工明确缺失项');
assert.match(source, /新品首次入库/, '新增商品必须允许在同一流程填写初始库存');
assert.match(source, /if \(shouldPublish\)/, '保存草稿与确认上架必须是两个不同动作');
assert.match(source, /data-editor-stock=/, '草稿商品必须能在编辑页直接补库存，不能依赖已存在的库存记录');
assert.match(source, /function openStockAdjustment\(skuId, warehouseId, stockMode\)/, '库存页与商品编辑页必须复用同一业务入库动作');
assert.match(source, /if \(next === 'on_sale'\) \{[\s\S]{0,260}productReadiness/, '商品列表的上架入口也必须执行资料完整性检查');
assert.match(source, /data-set-status="on_sale"[\s\S]{0,220}readiness\.ready[\s\S]{0,220}disabled/, '资料不完整时商品列表必须禁用上架按钮');
assert.doesNotMatch(html, /财务核算|ERP/, '未确认的复杂财务或 ERP 功能不得进入日常后台');
assert.doesNotMatch(source, />仅[BC]端</, '普通用户页面不得显示 B 端或 C 端缩写');
assert.match(fullSource, /advancedRequested\(\)/, '统一登录入口只在明确请求时停留高级设置');
assert.match(fullSource, /if \(advancedRequested\(\)\) return false;[\s\S]*?location\.replace\('simple\.html'\)/, '普通登录成功后必须默认进入日常运营后台');
assert.doesNotMatch(html, /服务端|初始化脚本|初始化令牌/, '普通运营页面不得暴露技术实现术语');

const loginHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
assert.doesNotMatch(loginHtml.slice(0, loginHtml.indexOf('<main class="admin-shell')), /服务端规则|初始化脚本|初始化令牌/, '统一登录页必须使用普通员工能理解的语言');
assert.match(loginHtml, /name="minOrderQuantity"/, '高级 SKU 表单必须支持起订量');
assert.match(loginHtml, /name="orderMultiple"/, '高级 SKU 表单必须支持购买倍数');
assert.match(loginHtml, /name="quantityTiers"/, '高级价格表单必须支持数量阶梯');
assert.match(loginHtml, /AI 测试草案/, '高级价格表单必须明确 AI 测试草案来源');
assert.match(fullSource, /function parseQuantityTiers\(value\)/, '高级后台必须解析数量阶梯配置');
assert.match(fullSource, /quantityTiers:\s*parseQuantityTiers\(form\.get\('quantityTiers'\)\)/, '高级后台价格保存必须提交数量阶梯');

console.log('simple admin UI and data-boundary contract: passed');
