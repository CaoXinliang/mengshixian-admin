const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { shouldClearSession } = require('../session-policy');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'simple.js'), 'utf8');

const sessionCases = [
  ['ADMIN_SESSION_EXPIRED', true],
  ['ADMIN_UNAUTHORIZED', true],
  ['ADMIN_FORBIDDEN', false],
  ['REQUEST_TIMEOUT', false],
  ['NETWORK_ERROR', false],
  [undefined, false]
];
for (const [code, expected] of sessionCases) {
  assert.equal(shouldClearSession(code ? { code } : null), expected, `${code || 'unknown'} session cleanup policy mismatch`);
}

const optionalCoreActions = [
  'admin.products.list',
  'admin.skus.list',
  'admin.prices.list',
  'admin.categories.list',
  'admin.media.list',
  'admin.warehouses.list',
  'admin.inventory.list',
  'admin.orders.list',
  'admin.refunds.list'
];
for (const action of optionalCoreActions) {
  assert.match(
    source,
    new RegExp(`optionalList\\('${action.replace(/\./g, '\\.')}\'\\)`),
    `${action} must degrade to a module error state instead of aborting startup`
  );
}

assert.match(source, /if \(sessionPolicy\.shouldClearSession\(error\)\) \{[\s\S]{0,180}api\.clearSession\(\)[\s\S]{0,180}redirectToFullLogin\('session_expired'\)/, 'only the session-error branch may clear and redirect');
assert.match(source, /function showBootFailure\(error\) \{[\s\S]{0,500}后台暂时无法进入[\s\S]{0,220}登录状态已保留[\s\S]{0,220}id="bootRetry"[\s\S]{0,260}boot\(\)/, 'non-session startup failures must preserve the session and expose a working retry before showing the app');
assert.match(source, /async function boot\(\) \{[\s\S]{0,240}await api\.call\('admin\.me'\)[\s\S]{0,160}await api\.call\('health'\);[\s\S]{0,100}await reloadAll\(\);[\s\S]{0,100}enterApp\(\);/, 'startup must validate admin identity and health, load all modules, then enter the app');

assert.match(source, /const dashboardDependencies = \['admin\.orders\.list', 'admin\.refunds\.list', 'admin\.inventory\.list', 'admin\.businessApplications\.list'\][\s\S]{0,320}id="dashboardLoadRetry"/, 'dashboard must surface failures from every metric dependency and expose retry');
assert.match(source, /const productError = state\.loadErrors\['admin\.products\.list'\] \|\| state\.loadErrors\['admin\.skus\.list'\] \|\| state\.loadErrors\['admin\.prices\.list'\] \|\| state\.loadErrors\['admin\.categories\.list'\] \|\| state\.loadErrors\['admin\.media\.list'\][\s\S]{0,360}id="productLoadRetry"/, 'products must surface failures from every display dependency and expose retry');
assert.match(source, /const inventoryError = state\.loadErrors\['admin\.inventory\.list'\] \|\| state\.loadErrors\['admin\.products\.list'\] \|\| state\.loadErrors\['admin\.skus\.list'\] \|\| state\.loadErrors\['admin\.warehouses\.list'\][\s\S]{0,360}id="inventoryLoadRetry"/, 'inventory must surface failures from every display dependency and expose retry');
assert.match(source, /dashboardError[\s\S]{0,220}不能把未读取的数据当作 0/, 'dashboard dependency failures must not be rendered as zero-valued metrics');
assert.match(source, /state\.loadErrors\['admin\.businessApplications\.list'\][\s\S]{0,260}id="customerLoadRetry"/, 'customer applications failure must remain retryable without clearing the session');

const moduleErrorStates = [
  ['admin.orders.list', 'orderLoadRetry'],
  ['admin.products.list', 'productLoadRetry'],
  ['admin.refunds.list', 'refundLoadRetry'],
  ['admin.inventory.list', 'inventoryLoadRetry'],
  ['admin.deliveryAreas.list', 'deliveryLoadRetry'],
  ['admin.groupCampaigns.list', 'campaignLoadRetry']
];
for (const [action, retryId] of moduleErrorStates) {
  assert.match(source, new RegExp(`loadErrors\\['${action.replace(/\./g, '\\.')}\'\\]`), `${action} must render a permission/failure state`);
  assert.match(source, new RegExp(`id="${retryId}"`), `${action} failure state must expose retry control ${retryId}`);
}

console.log(`admin startup and permission state contract: passed (${sessionCases.length} session cases, ${optionalCoreActions.length} startup actions)`);
