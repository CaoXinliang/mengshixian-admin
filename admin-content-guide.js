(function (root, factory) {
  const guide = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = guide;
  if (root) root.MengshixianContentGuide = guide;
}(typeof window !== 'undefined' ? window : null, function (root) {
  function toLocalInput(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16);
  }
  function populateSchedule(form, item) {
    form.elements.startAt.value = toLocalInput(item.startAt);
    form.elements.endAt.value = toLocalInput(item.endAt);
    const platforms = Array.isArray(item.targetPlatforms) && item.targetPlatforms.length ? item.targetPlatforms : ['miniapp', 'web'];
    form.querySelectorAll('[name="targetPlatforms"]').forEach((input) => { input.checked = platforms.includes(input.value); });
  }
  function readSchedule(form) {
    const platforms = [...form.querySelectorAll('[name="targetPlatforms"]:checked')].map((input) => input.value);
    if (!platforms.length) throw new Error('请至少选择一个适用端。');
    const convert = (value) => value ? new Date(`${value}${value.length === 16 ? ':00' : ''}+08:00`).toISOString() : '';
    const startAt = convert(form.elements.startAt.value);
    const endAt = convert(form.elements.endAt.value);
    if (startAt && endAt && startAt > endAt) throw new Error('结束展示时间不能早于开始时间。');
    return { startAt, endAt, targetPlatforms: platforms };
  }
  function describe(form, state) {
    const field = (name) => form.elements[name] && form.elements[name].value || '';
    const asset = state.media.find((row) => row._id === field('mediaAssetId'));
    const type = field('jumpType');
    const collection = type === 'product' ? state.products : type === 'category' ? state.categories : [];
    const target = collection.find((row) => row._id === field('jumpTarget'));
    const destination = type === 'none' ? '不跳转' : type === 'url' ? `网页链接：${field('jumpTarget') || '未填写'}` : `${type === 'product' ? '商品' : '分类'}：${target ? target.name : '未选择'}`;
    const platforms = [...form.querySelectorAll('[name="targetPlatforms"]:checked')].map((input) => input.value === 'miniapp' ? '小程序' : '网页端').join('、') || '未选择';
    const schedule = `${field('startAt') || '不限定开始时间'}至${field('endAt') || '不限定结束时间'}（北京时间）`;
    return `保存前核对：${field('title') || '未填写标题'}；素材：${asset ? asset.name : '未选择'}；点击后：${destination}；适用端：${platforms}；展示时间：${schedule}；${form.elements.enabled.checked ? '保存后立即启用' : '仅保存草稿，不对顾客展示'}。`;
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
  function searchableMedia(select, entries) {
    const document = select.ownerDocument;
    let search = select.parentElement.querySelector('[data-content-media-search]');
    if (!search) {
      search = document.createElement('input');
      search.type = 'search';
      search.placeholder = '输入素材名称查找';
      search.setAttribute('aria-label', '按素材名称查找');
      search.setAttribute('data-content-media-search', '');
      select.before(search);
    }
    search.value = '';
    search.oninput = () => {
      const selected = select.value;
      const keyword = search.value.trim().toLocaleLowerCase();
      const matches = entries.filter((item) => !keyword || String(item.name || '').toLocaleLowerCase().includes(keyword) || item._id === selected);
      select.replaceChildren(option(document, '', '请选择素材（可留空，先存草稿）'), ...matches.map((item) => option(document, item._id, item.name)));
      select.value = selected;
    };
  }
  function ensureMediaPreview(form, state) {
    const document = form.ownerDocument;
    let button = form.querySelector('[data-content-preview-media]');
    let preview = form.querySelector('[data-content-media-preview]');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.textContent = '预览所选素材';
      button.setAttribute('data-content-preview-media', '');
      preview = document.createElement('div');
      preview.className = 'content-media-preview';
      preview.setAttribute('data-content-media-preview', '');
      preview.setAttribute('role', 'status');
      preview.setAttribute('aria-live', 'polite');
      form.elements.mediaAssetId.parentElement.after(button, preview);
    }
    form.__contentPreviewRequest = (form.__contentPreviewRequest || 0) + 1;
    preview.replaceChildren();
    button.onclick = async () => {
      const asset = state.media.find((item) => item._id === form.elements.mediaAssetId.value);
      const request = ++form.__contentPreviewRequest;
      if (!asset || !asset.fileId) { preview.textContent = '所选素材没有可预览的文件，请从素材库重新选择。'; return; }
      preview.textContent = '正在获取素材预览…';
      try {
        if (!root || !root.cloudbase) throw new Error('当前浏览器无法连接素材预览服务。');
        const cloud = root.cloudbase.init({ env: root.MENGSHIXIAN_ADMIN_CONFIG.envId, region: 'ap-shanghai' });
        const result = await cloud.getTempFileURL({ fileList: [asset.fileId] });
        if (request !== form.__contentPreviewRequest) return;
        const url = result.fileList && result.fileList[0] && result.fileList[0].tempFileURL;
        if (!url) throw new Error('当前文件没有可用的预览地址。');
        const media = document.createElement(asset.type === 'video' ? 'video' : 'img');
        media.src = url;
        if (asset.type === 'video') { media.controls = true; media.preload = 'metadata'; }
        else media.alt = asset.name || '所选素材';
        media.addEventListener('error', () => { if (request === form.__contentPreviewRequest) preview.textContent = '素材加载失败，请到素材库核对文件。'; }, { once: true });
        preview.replaceChildren(media);
      } catch (error) { if (request === form.__contentPreviewRequest) preview.textContent = error.message || '预览失败，请稍后重试。'; }
    };
  }
  function showError(form, text) {
    const box = form.querySelector('[data-content-form-error]');
    if (box) box.textContent = text || '';
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
    const mediaSelect = ensureSelect(asset, items, '请选择素材（可留空，先存草稿）');
    mediaSelect.setAttribute('aria-label', '选择首页展示素材');
    searchableMedia(mediaSelect, items);
    ensureMediaPreview(form, state);
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
    let error = form.querySelector('[data-content-form-error]');
    if (!error) {
      error = form.ownerDocument.createElement('p');
      error.className = 'form-message';
      error.setAttribute('data-content-form-error', '');
      error.setAttribute('role', 'alert');
      form.querySelector('button[type="submit"], button.primary').before(error);
    }
    showError(form, '');
    if (!form.__contentPreviewBound) {
      form.addEventListener('input', () => { preview.textContent = describe(form, state); });
      form.addEventListener('change', (event) => {
        if (event.target.name === 'mediaAssetId') {
          form.__contentPreviewRequest++;
          form.querySelector('[data-content-media-preview]').replaceChildren();
        }
        if (event.target.name === 'jumpType') {
          form.elements.jumpTarget.value = '';
          onOpen(form, state);
        }
        preview.textContent = describe(form, state);
      });
      form.__contentPreviewBound = true;
    }
  }
  return { describe, onOpen, populateSchedule, readSchedule, showError };
}));
