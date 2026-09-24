(function (global, document) {
  'use strict';
  function choose(form, name, label, rows, value = '') {
    const old = form.elements[name];
    const select = old.tagName === 'SELECT' ? old : document.createElement('select');
    select.name = name; select.required = old.required;
    old.parentElement.firstChild.textContent = label;
    select.replaceChildren(new Option(select.required ? '请选择' : '不指定', ''), ...rows.map((row) => new Option(row.label, row._id)));
    select.value = rows.some((row) => row._id === value) ? value : '';
    if (old !== select) old.replaceWith(select);
    return select;
  }
  function onOpen(form, state) {
    const formId = form.getAttribute('id');
    const sources = { productForm: state.products, skuForm: state.skus, productMediaForm: state.productMedia };
    if (!sources[formId]) return;
    const saved = sources[formId].find((row) => row._id === form.dataset.editingId) || {};
    const products = state.products.map((row) => ({ _id: row._id, label: `${row.name}${row.spuCode ? ` · ${row.spuCode}` : ''}` }));
    const images = state.media.filter((row) => row.type === 'image' && row.enabled !== false).map((row) => ({ _id: row._id, label: row.name }));
    if (formId === 'productForm') {
      choose(form, 'categoryId', '商品分类', state.categories.map((row) => ({ _id: row._id, label: row.name })), saved.categoryId);
      choose(form, 'coverMediaId', '商品主图', images, saved.coverMediaId);
      return;
    }
    choose(form, 'productId', '关联商品', products, saved.productId);
    if (formId === 'skuForm') return;
    form.querySelector('p.muted').textContent = '先到素材库上传文件，再按商品、销售规格及素材名称选择。切换商品会清空规格选择，切换素材类型会清空素材选择。';
    const updateSku = (value = '') => choose(form, 'skuId', '销售规格（不选表示整个商品）', state.skus.filter((row) => row.productId === form.elements.productId.value).map((row) => ({ _id: row._id, label: `${row.specName}${row.skuCode ? ` · ${row.skuCode}` : ''}` })), value);
    const updateAsset = (value = '') => choose(form, 'mediaAssetId', '素材名称', state.media.filter((row) => row.enabled !== false && row.type === form.elements.mediaType.value).map((row) => ({ _id: row._id, label: row.name })), value);
    updateSku(saved.skuId); updateAsset(saved.mediaAssetId);
    form.elements.productId.onchange = () => updateSku();
    form.elements.mediaType.onchange = () => updateAsset();
  }
  global.MengshixianProductFormGuide = { onOpen };
}(window, document));
