const ROLE_PERMISSIONS = {
  super_admin: ['*'],
  admin_manager: ['admin.read', 'admin.write'],
  product_manager: ['catalog.read', 'catalog.write', 'imports.read', 'imports.write'],
  price_manager: ['pricing.read', 'pricing.write'],
  customer_manager: ['users.read', 'users.write', 'organizations.read', 'organizations.write'],
  marketing_manager: ['marketing.read', 'marketing.write', 'reviews.read', 'reviews.write', 'points.read', 'points.write'],
  content_manager: ['content.read', 'content.write', 'media.read', 'media.write'],
  order_manager: ['orders.read', 'orders.write'],
  finance_manager: ['payments.read', 'refunds.read', 'refunds.write', 'credit.read', 'credit.write', 'receivables.read', 'receivables.write', 'invoices.read', 'invoices.write', 'storedValue.read'],
  procurement_manager: ['inquiries.read', 'inquiries.write'],
  warehouse_manager: ['inventory.read', 'inventory.write', 'delivery.read', 'delivery.write'],
  auditor: ['audit.read']
};

// 后台自定义角色可分配的权限点全集（不含通配符 '*'，通配权限只属于内置 super_admin）。
const KNOWN_PERMISSIONS = [...new Set(Object.values(ROLE_PERMISSIONS).flat().filter((item) => item !== '*'))];

function hasPermission(permissions, required) {
  const set = new Set(permissions || []);
  return set.has('*') || set.has(required) || set.has(`${String(required).split('.')[0]}.*`);
}

function collectPermissions(admin, roles) {
  const direct = Array.isArray(admin.permissions) ? admin.permissions : [];
  const roleIds = new Set(admin.roleIds || []);
  const rolePermissions = (roles || [])
    .filter((role) => roleIds.has(role._id) && role.status !== 'disabled')
    .flatMap((role) => Array.isArray(role.permissions) ? role.permissions : ROLE_PERMISSIONS[role.code] || []);
  return [...new Set([...direct, ...rolePermissions])];
}

module.exports = { ROLE_PERMISSIONS, KNOWN_PERMISSIONS, hasPermission, collectPermissions };
