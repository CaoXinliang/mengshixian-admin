const { collectPageMatches } = require('./collection-read');
const { resolveFreight, resolveDeliverySlot } = require('./commerce');

// Reuse checkout's matching rules; this verifies configuration, not a customer's final quote.
async function reviewDelivery(store, stockRows, audienceType, now) {
  const areas = await collectPageMatches(store, 'delivery_areas', { where: { status: 'active' } }, () => true);
  const slots = await collectPageMatches(store, 'delivery_slots', { where: { status: 'active' } }, () => true);
  const warehouseRoutes = new Map();
  const user = { userType: audienceType === 'b' ? 'b' : 'c' };
  for (const location of stockRows.flatMap((sku) => sku.locations).filter((item) => item.usable)) {
    if (warehouseRoutes.has(location.warehouseId)) continue;
    const routes = [];
    for (const area of areas) {
      if ((area.warehouseIds || []).length && !area.warehouseIds.includes(location.warehouseId)) continue;
      for (const regionCode of area.regionCodes || []) {
        let freight;
        try { freight = await resolveFreight(store, user, location.warehouseId, regionCode, 0, now); }
        catch (error) {
          if (['OUT_OF_DELIVERY_RANGE', 'FREIGHT_RULE_NOT_AVAILABLE', 'VALIDATION_ERROR'].includes(error.code)) continue;
          throw error;
        }
        for (const slot of slots) {
          let selected;
          try { selected = await resolveDeliverySlot(store, slot._id, freight, now); }
          catch (error) { if (error.code === 'DELIVERY_SLOT_NOT_AVAILABLE') continue; throw error; }
          const matchedArea = areas.find((item) => item._id === freight.areaId);
          routes.push({ warehouseName: location.warehouseName, areaName: matchedArea?.name || '未命名区域',
            regionCode, slotName: selected.name, startTime: selected.startTime, endTime: selected.endTime,
            freight });
        }
      }
    }
    warehouseRoutes.set(location.warehouseId, routes);
  }
  const rows = stockRows.map((sku) => ({ skuCode: sku.skuCode, specName: sku.specName,
    routes: sku.locations.filter((item) => item.usable).flatMap((item) => warehouseRoutes.get(item.warehouseId) || []) }));
  return { rows, issues: rows.filter((row) => !row.routes.length).map((row) => `规格「${row.specName || row.skuCode}」尚无配套的有货仓库、配送区域、运费和配送时段，请核对配送设置`) };
}

module.exports = { reviewDelivery };
