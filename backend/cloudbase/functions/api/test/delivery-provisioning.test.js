const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const appSource = fs.readFileSync(path.resolve(__dirname, '../app.js'), 'utf8');
const ensureSource = fs.readFileSync(path.resolve(__dirname, '../../../../scripts/ensure-demo-collections.ps1'), 'utf8');
const deliveryOptionsBody = appSource.match(/async function publicDeliveryOptions\(\) \{([\s\S]*?)\r?\n  \}\r?\n\r?\n  async function webLogin/);

assert(deliveryOptionsBody, 'publicDeliveryOptions implementation must remain discoverable');
const requiredCollections = [...deliveryOptionsBody[1].matchAll(/collectPageMatches\(store, '([^']+)'/g)].map(match => match[1]);
assert.deepEqual(requiredCollections.sort(), ['delivery_areas', 'delivery_slots', 'pickup_sites', 'warehouses'], 'delivery.options collection dependencies changed unexpectedly');
for (const collection of requiredCollections) {
  assert.match(ensureSource, new RegExp(`'${collection}'`), `CloudBase provisioning must ensure ${collection} before delivery.options is called`);
}

console.log(`delivery provisioning contract test: passed (${requiredCollections.length} collections)`);
