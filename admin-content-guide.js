(function (root, factory) {
  const guide = factory();
  if (typeof module === 'object' && module.exports) module.exports = guide;
  if (root) root.MengshixianContentGuide = guide;
}(typeof window !== 'undefined' ? window : null, function () {
  function describe(form, state) {
    const field = (name) => form.elements[name] && form.elements[name].value || '';
    const asset = state.media.find((row) => row._id === field('mediaAssetId'));
    const type = field('jumpType');
    const collection = type === 'product' ? state.products : type === 'category' ? state.categories : [];
    const target = collection.find((row) => row._id === field('jumpTarget'));
    const destination = type === 'none' ? '不跳转' : type === 'url' ? `网页链接：${field('jumpTarget') || '未填写'}` : `${type === 'product' ? '商品' : '分类'}：${target ? target.name : '未选择'}`;
    return `保存前核对：${field('title') || '未填写标题'}；素材：${asset ? asset.name : '未选择'}；点击后：${destination}；${form.elements.enabled.checked ? '保存后立即启用' : '仅保存草稿，不对顾客展示'}。`;
  }

  function option(document, value, label) {
    const node = document.createElement('option'); node.value = value; node.textContent = label; return node;
  }
  function ensureSelect(input, entries, blank) {
    const document = input.ownerDocument;
    const old = input.value;
    const select = input.tagName === 'SELECT' ? input : document.createElement('select');
    select.name = input.name;
    select.replaceChildren(option(document, '', blank), ...entries.map((item) => option(document, item._id, item.name)));
    select.value = old;
    if (!select.value && old) select.appendChild(option(document, old, '原选择已不可用，请重新选择'));
    select.value = old;
    if (input !== select) input.replaceWith(select);
    return select;
  }
  function ensureInput(select) {
    if (select.tagName === 'INPUT') return select;
    const input = select.ownerDocument.createElement('input');
    input.name = select.name; input.maxLength = 200; input.value = select.value;
    select.replaceWith(input); return input;
  }
  function onOpen(form, state) {
    const formId = form.getAttribute('id');
    if (!['bannerForm', 'sectionForm'].includes(formId)) return;
    if (!form.dataset.editingId) form.elements.enabled.checked = false;
    const asset = form.elements.mediaAssetId;
    asset.parentElement.firstChild.textContent = '素材（按名称选择）';
    const items = formId === 'bannerForm' ? state.media.filter((row) => row.type === 'image' && row.enabled !== false) : state.media.filter((row) => row.enabled !== false);
    ensureSelect(asset, items, '请选择素材（可留空，先存草稿）');
    const targetInput = form.elements.jumpTarget;
    targetInput.parentElement.firstChild.textContent = '跳转目标';
    const type = form.elements.jumpType.value;
    if (type === 'product' || type === 'category') {
      const entries = type === 'product' ? state.products.filter((row) => row.status === 'on_sale') : state.categories.filter((row) => row.status === 'enabled');
      ensureSelect(targetInput, entries, `请选择${type === 'product' ? '商品' : '分类'}`);
    } else ensureInput(targetInput);
    let preview = form.querySelector('.content-save-preview');
    if (!preview) { preview = form.ownerDocument.createElement('p'); preview.className = 'content-save-preview'; form.querySelector('button[type="submit"], button.primary').before(preview); }
    preview.textContent = describe(form, state);
    if (!form.__contentPreviewBound) {
      form.addEventListener('input', () => { preview.textContent = describe(form, state); });
      form.addEventListener('change', (event) => {
        if (event.target.name === 'jumpType') {
          form.elements.jumpTarget.value = '';
          onOpen(form, state);
        }
        preview.textContent = describe(form, state);
      });
      form.__contentPreviewBound = true;
    }
  }
  return { describe, onOpen };
}));
