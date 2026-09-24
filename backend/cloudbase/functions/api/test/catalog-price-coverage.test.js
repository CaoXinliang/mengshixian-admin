const assert = require('node:assert/strict');
const { personalMiniappPrice } = require('../lib/catalog-price-coverage');
const now = new Date('2026-09-23T00:00:00Z');
const base = { status: 'active', amountCent: 1200, scopeType: 'public', channel: 'all' };
assert.equal(personalMiniappPrice(base, now), true);
assert.equal(personalMiniappPrice({ ...base, scopeType: 'customer_type', scopeId: 'c', channel: 'miniapp' }, now), true);
for (const patch of [
  { scopeType: 'customer_type', scopeId: 'b' }, { scopeType: 'user', scopeId: 'customer' },
  { scopeType: 'organization' }, { scopeType: 'level' }, { channel: 'web' },
  { status: 'disabled' }, { amountCent: 0 }, { amountCent: 12.5 },
  { validFrom: '2026-09-24' }, { validTo: '2026-09-22' }, { validFrom: 'invalid' }
]) assert.equal(personalMiniappPrice({ ...base, ...patch }, now), false, JSON.stringify(patch));
console.log('Personal miniapp price coverage boundary tests passed');
