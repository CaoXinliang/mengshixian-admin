const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'simple.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'simple.js'), 'utf8');

assert.match(html, /data-customer-mode="webaccounts"[\s\S]*id="customerWebAccountPane"/, 'web accounts must stay inside customer secondary module');
for (const action of ['admin.webAccounts.list', 'admin.webAccounts.upsert', 'admin.webAccounts.setStatus', 'admin.webAccounts.resetPassword']) assert(source.includes(`'${action}'`), `${action} is required`);
assert.match(source, /type="password"[\s\S]*autocomplete="new-password"/, 'admin password input must remain masked');
assert.match(source, /当前会话将失效[\s\S]*立即无法访问订单、价格与账户数据/, 'disable confirmation must explain impact');
assert.match(source, /所有已有会话失效[\s\S]*不能撤销/, 'password reset requires destructive confirmation');
assert.doesNotMatch(source, /console\.(log|info|warn|error)\([^\n]*(password|newPassword)/i, 'plaintext password must never be logged');
assert.doesNotMatch(source, /temporaryPassword/, 'frontend must not expect or retain returned temporary password');
assert.equal([...html.matchAll(/<button data-view="(dashboard|orders|products|inventory|refunds|customers|delivery|marketing|settings)"[^>]*>/g)].length, 9, 'web account module must not add a primary entry');

console.log('admin web accounts contract: passed');
