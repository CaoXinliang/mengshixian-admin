const STAFF_PERMISSIONS = Object.freeze({
  super_admin: Object.freeze(['*']),
  operator: Object.freeze([
    'catalog.read', 'catalog.write', 'imports.read', 'imports.write',
    'media.read', 'media.write', 'pricing.read', 'pricing.write',
    'orders.read', 'orders.write', 'receipts.read', 'receipts.write',
    'inventory.read', 'inventory.write', 'delivery.read',
    'content.read', 'content.write', 'refunds.read'
  ])
});
function staffPermissions(role) { return Object.hasOwn(STAFF_PERMISSIONS, role) ? [...STAFF_PERMISSIONS[role]] : []; }
module.exports = { STAFF_PERMISSIONS, staffPermissions };
