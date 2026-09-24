const { collectPageMatches } = require('./collection-read');

async function reviewStock(store, skus) {
  const warehouses = await collectPageMatches(store, 'warehouses', {}, () => true);
  const rows = [];
  const issues = [];
  for (const sku of skus.filter((item) => item.status !== 'off_sale')) {
    const inventory = await collectPageMatches(store, 'inventory', { where: { skuId: sku._id } }, () => true);
    const locations = inventory.map((item) => {
      const warehouse = warehouses.find((entry) => entry._id === item.warehouseId);
      const valid = Number.isSafeInteger(item.available) && item.available >= 0;
      return { warehouseId: item.warehouseId, warehouseName: warehouse?.name || '仓库不存在',
        warehouseActive: warehouse?.status === 'active', available: valid ? item.available : null,
        usable: valid && item.available > 0 && warehouse?.status === 'active' };
    });
    const ready = locations.some((item) => item.usable);
    if (!ready) issues.push(`规格「${sku.specName || sku.skuCode || '未命名规格'}」缺少启用仓库中的可售库存，请按实际补货资料登记`);
    rows.push({ skuCode: sku.skuCode || '', specName: sku.specName || '', ready, locations });
  }
  return { rows, issues };
}

module.exports = { reviewStock };
