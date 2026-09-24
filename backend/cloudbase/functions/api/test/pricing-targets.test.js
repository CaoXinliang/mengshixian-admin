const assert = require('node:assert/strict');
const { createPricingTargets } = require('../lib/pricing-targets');
const records = {
  customer_organizations: [{ _id: 'org-a', name: '甲方门店', unifiedCode: 'BUSINESS-001', status: 'active', secret: 'must-not-return' }, { _id: 'org-off', name: '停用企业', status: 'disabled' }],
  users: [{ _id: 'user-a', status: 'active', phoneMasked: '138****1234', phoneEncrypted: 'must-not-return', openid: 'must-not-return', priceLevel: '标准客户' }, { _id: 'user-off', status: 'disabled', priceLevel: '停用等级' }]
};
const matches = (row, where = {}) => Object.entries(where).every(([key, value]) => row[key] === value);
const store = {
  list: async (name, options = {}) => { const rows = records[name].filter((row) => matches(row, options.where)); return { rows, total: rows.length }; },
  findOne: async (name, where) => records[name].find((row) => matches(row, where)) || null
};
(async () => {
  const targets = createPricingTargets(store);
  const companies = await targets.list({ scopeType: 'organization' });
  assert.deepEqual(companies.rows, [{ _id: 'org-a', label: '甲方门店 · BUSINESS-001' }]);
  const customers = await targets.list({ scopeType: 'user' });
  assert.equal(customers.rows.length, 1);
  assert.match(customers.rows[0].label, /138\*\*\*\*1234.*客户号 KH-/);
  assert.doesNotMatch(JSON.stringify(customers), /must-not-return|phoneEncrypted|openid/);
  assert.deepEqual((await targets.list({ scopeType: 'level' })).rows, [{ _id: '标准客户', label: '价格等级：标准客户' }]);
  for (const [scope, id] of [['customer_type', 'b'], ['customer_type', 'c'], ['organization', 'org-a'], ['user', 'user-a'], ['level', '标准客户'], ['public', '']]) await targets.validate(scope, id);
  for (const [scope, id] of [['customer_type', 'invalid'], ['organization', 'org-off'], ['user', 'user-off'], ['user', 'missing'], ['level', '停用等级'], ['public', 'org-a']]) await assert.rejects(() => targets.validate(scope, id));
  console.log('Pricing targets: readable selection, minimal data and invalid-target rejection passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
