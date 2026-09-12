const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const scriptPath = path.resolve(__dirname, '../../../../scripts/ensure-demo-collections.ps1');
const script = fs.readFileSync(scriptPath, 'utf8');
const requiredMarketingCollections = [
  'bundles',
  'coupon_templates',
  'coupon_counters',
  'user_coupons',
  'points_accounts',
  'points_ledger',
  'membership_levels',
  'favorites',
  'reviews',
  'invoice_titles',
  'invoices',
  'stored_value_accounts',
  'stored_value_ledger',
  'stored_value_topup_intents'
];

for (const collection of requiredMarketingCollections) {
  assert.match(script, new RegExp(`['\"]${collection}['\"]`), `初始化脚本必须包含 ${collection}`);
}

assert.equal(new Set(requiredMarketingCollections).size, requiredMarketingCollections.length, '集合契约不得重复');
console.log('demo marketing collections contract test: passed');
