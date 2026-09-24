(function attachProductData(global) {
  'use strict';
  function create(api, paging) {
    const list = async (action, payload) => {
      if (payload) {
        const result = await api.call(action, payload);
        return result.rows || [];
      }
      return (await paging.listAll((name, options) => api.call(name, options), action)).rows;
    };
    async function load(productId) {
      const [products, categories, skus, prices, media] = await Promise.all([
        list('admin.products.list'), list('admin.categories.list'), list('admin.skus.list'),
        list('admin.prices.list'), list('admin.media.list')
      ]);
      const product = products.find((row) => row._id === productId) || null;
      const associations = product ? await list('admin.productMedia.list', { productId }) : [];
      return { product, products, categories, skus: skus.filter((row) => row.productId === productId), prices, media, associations };
    }
    async function saveProduct(existing, fields) {
      const source = existing || {};
      const payload = {
        spuCode: fields.spuCode || source.spuCode || '', name: fields.name, subtitle: source.subtitle || '',
        categoryId: fields.categoryId, brand: source.brand || '', origin: source.origin || '',
        storageType: source.storageType || 'frozen', frozenTemperature: source.frozenTemperature || '-18℃',
        shelfLifeDays: source.shelfLifeDays || 0, description: source.description || '',
        coverMediaId: fields.coverMediaId !== undefined ? fields.coverMediaId : (source.coverMediaId || ''),
        audienceType: fields.audienceType || source.audienceType || 'all', sort: source.sort || 0
      };
      if (source._id) payload.id = source._id;
      else payload.status = 'draft';
      return api.call('admin.products.upsert', payload);
    }
    async function saveSku(productId, existing, fields) {
      const source = existing || {};
      const payload = {
        productId, skuCode: fields.skuCode || source.skuCode || '', specName: fields.specName,
        netWeight: fields.netWeight || '', weightUnit: source.weightUnit || '',
        piecesPerCase: source.piecesPerCase || 0, packageUnit: fields.packageUnit || '',
        barcode: source.barcode || '', mediaIds: Array.isArray(source.mediaIds) ? source.mediaIds : [],
        sort: source.sort || 0, status: source.status || 'draft'
      };
      if (source._id) payload.id = source._id;
      return api.call('admin.skus.upsert', payload);
    }
    function publicPrice(prices, skuId) {
      const matches = prices.filter((row) => row.skuId === skuId && row.scopeType === 'public' && row.status === 'active');
      return matches.find((row) => !row.channel || row.channel === 'all') || matches[0] || null;
    }
    async function savePublicPrice(prices, skuId, cents) {
      if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('价格须为非负金额。');
      const rules = prices.filter((row) => row.skuId === skuId && row.scopeType === 'public');
      const preferred = rules.find((row) => !row.channel || row.channel === 'all');
      await api.call('admin.prices.upsert', {
        ...(preferred ? { id: preferred._id } : {}), skuId, scopeType: 'public', scopeId: '',
        channel: 'all', amountCent: cents, priority: preferred ? preferred.priority || 0 : 0,
        validFrom: preferred ? preferred.validFrom || '' : '', validTo: preferred ? preferred.validTo || '' : '', status: 'active'
      });
      for (const rule of rules) {
        if (rule === preferred || rule.status !== 'active' || !['miniapp', 'web'].includes(rule.channel)) continue;
        await api.call('admin.prices.upsert', {
          id: rule._id, skuId, scopeType: 'public', scopeId: rule.scopeId || '', channel: rule.channel,
          amountCent: rule.amountCent, priority: rule.priority || 0,
          validFrom: rule.validFrom || '', validTo: rule.validTo || '', status: 'disabled'
        });
      }
    }
    async function upload(file, type) {
      const uploaded = await api.uploadMediaFile(file, type);
      return api.call('admin.media.upsert', {
        name: (file.name || (type === 'image' ? '商品图' : '详情视频')).replace(/\.[^.]+$/, '').slice(0, 80),
        type, source: 'admin_upload', temporary: false, targetPlatforms: ['miniapp', 'web'],
        fileId: uploaded.fileId, mimeType: uploaded.mimeType, sizeBytes: uploaded.sizeBytes
      });
    }
    const setStatus = (id, status) => api.call('admin.products.setStatus', { id, status });
    const setSkuStatus = (id, status) => api.call('admin.skus.setStatus', { id, status });
    const linkVideo = (productId, mediaAssetId, enabled) => api.call('admin.productMedia.upsert', {
      productId, mediaAssetId, mediaType: 'video', role: 'detail', enabled
    });
    return { load, saveProduct, saveSku, publicPrice, savePublicPrice, upload, setStatus, setSkuStatus, linkVideo };
  }
  global.MengshixianProductData = Object.freeze({ create });
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
}(typeof window !== 'undefined' ? window : globalThis));
