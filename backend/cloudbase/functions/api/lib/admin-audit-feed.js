const { collectPermissions } = require('./permissions');

const TARGETS = Object.freeze({
  admin_user: ['admin_users', '工作人员', ['displayName', 'username']],
  product: ['products', '商品', ['name']],
  product_sku: ['product_skus', '销售规格', ['specName']],
  category: ['categories', '商品分类', ['name']],
  media_asset: ['media_assets', '素材', ['name']],
  product_media: ['product_media', '商品素材关联', []],
  price: ['prices', '价格规则', []],
  warehouse: ['warehouses', '仓库', ['name']],
  inventory: ['inventory', '库存记录', []],
  delivery_area: ['delivery_areas', '配送区域', ['name']],
  freight_rule: ['freight_rules', '运费规则', []],
  delivery_slot: ['delivery_slots', '配送时段', ['name']],
  order: ['orders', '订单', ['orderNo']],
  refund: ['refunds', '退款申请', ['refundNo']],
  business_application: ['business_applications', '企业申请', ['companyName', 'storeName']],
  user: ['users', '顾客', []],
  group_campaign: ['group_campaigns', '拼团活动', ['title', 'name']],
  banner: ['banners', '轮播图', ['title']],
  banners: ['banners', '轮播图', ['title']],
  home_sections: ['home_sections', '首页模块', ['title']],
  import_job: ['import_jobs', '导入任务', ['sourceFile']],
  admin_session: [null, '后台会话', []],
  media_asset_file: [null, '上传文件', []],
  inventory_reservation: [null, '库存预占', []],
  maintenance: [null, '系统维护', []],
  payment: [null, '支付记录', []],
  group: [null, '拼团', []]
});

const firstText = (source, keys) => keys.map((key) => source && source[key]).find((value) => typeof value === 'string' && value.trim()) || '';

async function enrichAuditRows(store, rows) {
  const recordCache = new Map();
  const lookup = (collection, id) => {
    if (!collection || !id) return Promise.resolve(null);
    const key = `${collection}\u0000${id}`;
    if (!recordCache.has(key)) recordCache.set(key, store.getById(collection, id));
    return recordCache.get(key);
  };
  const roles = (await store.list('admin_roles', { page: 1, pageSize: 100 })).rows;
  return Promise.all(rows.map(async (row) => {
    const target = TARGETS[row.targetType] || [null, '其他记录', []];
    const [actor, record] = await Promise.all([
      row.actorId ? lookup('admin_users', row.actorId) : null,
      lookup(target[0], row.targetId)
    ]);
    const snapshotName = firstText(row.details, ['name', 'title', 'specName']);
    const targetName = snapshotName || firstText(record, target[2]);
    const actorRole = actor && (actor.staffRole || (collectPermissions(actor, roles).includes('*') ? 'super_admin' : 'legacy'));
    return {
      ...row,
      actorName: row.actorType === 'system' ? '系统自动执行' : actor ? firstText(actor, ['displayName', 'username']) || '未设置姓名的工作人员' : '原工作人员（账号已不可用）',
      actorRole: row.actorType === 'system' ? 'system' : actorRole || 'unknown',
      targetTypeName: target[1],
      targetName: targetName || (row.targetId ? '原记录（当前名称不可用）' : '')
    };
  }));
}

module.exports = { enrichAuditRows };
