const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'simple.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'simple.js'), 'utf8');

assert.equal([...html.matchAll(/<button data-view="(dashboard|orders|products|inventory|refunds|customers|delivery|marketing|settings)"[^>]*>/g)].length, 9, 'commerce extensions must stay inside nine primary entries');
for (const id of ['bundleList', 'groupInstanceList', 'groupRefundTaskList', 'couponTemplateList', 'membershipLevelList', 'reviewAdminList', 'invoiceAdminList', 'storedValueAdminList']) assert.match(html, new RegExp(`id="${id}"`), `${id} secondary panel is required`);
for (const action of ['admin.bundles.list', 'admin.bundles.upsert', 'admin.bundles.setStatus', 'admin.groups.list', 'admin.groups.refundTasks', 'admin.couponTemplates.list', 'admin.couponTemplates.upsert', 'admin.reviews.list', 'admin.reviews.review', 'admin.invoices.list', 'admin.invoices.process', 'admin.points.adjust', 'admin.membershipLevels.list', 'admin.membershipLevels.upsert', 'admin.storedValue.list']) assert(source.includes(`'${action}'`), `${action} adapter usage is required`);
assert.match(source, /status === 'active' && \(temporary \|\| source !== 'client'\)/, 'AI and temporary records must not become active');
assert.match(source, /admin\.points\.adjust'[\s\S]*idempotencyKey: newIdempotencyKey\(\)/, 'points adjustment must be idempotent');
assert.match(source, /admin\.reviews\.review'[\s\S]*idempotencyKey: newIdempotencyKey\(\)/, 'review decision must be idempotent');
assert.match(source, /admin\.invoices\.process'[\s\S]*idempotencyKey: newIdempotencyKey\(\)/, 'invoice processing must be idempotent');
assert.match(source, /action === 'issued' && !row\?\.providerConfigured/, 'unconfigured invoice provider must not expose issued operation');
assert.match(source, /真实充值保持关闭[\s\S]*后台不能手工增加余额|后台不能手工增加余额[\s\S]*真实充值保持关闭/, 'stored value must remain read-only and test-only');
for (const impact of ['确认正式启用套餐', '确认启用优惠券模板', '确认启用会员等级', '确认调整用户积分', '确认执行发票操作']) assert(source.includes(impact), `${impact} confirmation is required`);

console.log('admin commerce operations contract: passed');
