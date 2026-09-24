(function categoryGuide(global, document) {
  'use strict';
  function onOpen(form, state) {
    if (form.getAttribute('id') !== 'categoryForm') return;
    const current = form.elements.imageMediaId;
    const previous = current.value;
    const select = current.tagName === 'SELECT' ? current : document.createElement('select');
    select.name = 'imageMediaId';
    const option = (value, label) => {
      const item = document.createElement('option');
      item.value = value;
      item.textContent = label;
      return item;
    };
    const images = state.media.filter((item) => item.type === 'image' && item.enabled !== false);
    select.replaceChildren(
      option('', '暂不设置图片'),
      ...images.map((item) => option(item._id, `${item.name || '未命名图片'}${item.version ? ` · 第 ${item.version} 版` : ''}`))
    );
    if (previous && !images.some((item) => item._id === previous)) {
      select.appendChild(option(previous, '原图片暂不可用，保持原关联；请核对后更换'));
    }
    select.value = previous;
    if (current !== select) current.replaceWith(select);
    select.parentElement.firstChild.textContent = '分类图片（按素材名称选择）';
    let hint = form.querySelector('.category-image-hint');
    if (!hint) {
      hint = document.createElement('p');
      hint.className = 'category-image-hint muted';
      select.parentElement.after(hint);
    }
    hint.textContent = state.loadStates.media === 'failed'
      ? '素材库读取失败，已有图片关联会保留；请刷新页面后再更换。'
      : '先在素材库上传图片，再按名称选择；也可暂不设置，稍后补齐。';
    select.disabled = false;
  }
  global.MengshixianCategoryGuide = Object.freeze({onOpen});
}(window, document));
