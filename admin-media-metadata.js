(function mediaMetadataGuide(global, document) {
  'use strict';
  function beijingInput(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16);
  }
  function asIso(value) {
    return value ? new Date(`${value}${value.length === 16 ? ':00' : ''}+08:00`).toISOString() : '';
  }
  function mount({ call, refresh, message, openModal, closeModal, assets }) {
    const form = document.getElementById('mediaMetadataForm');
    if (!form) return;
    const submit = form.querySelector('button[type="submit"]');
    const errorBox = form.querySelector('#mediaMetadataError');
    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-edit-media-metadata]');
      if (!button) return;
      const asset = assets().find((item) => item._id === button.dataset.editMediaMetadata);
      if (!asset) { message('这条素材已不存在，请刷新列表。', true); return; }
      if ((asset.startAt && !beijingInput(asset.startAt)) || (asset.endAt && !beijingInput(asset.endAt)) || (Array.isArray(asset.targetPlatforms) && !asset.targetPlatforms.length)) {
        message('这条素材原有展示时间或适用端异常，暂不能安全编辑，请先核对数据。', true); return;
      }
      form.reset();
      errorBox.textContent = '';
      form.elements.id.value = asset._id;
      form.dataset.metadataRevision = String(asset.metadataRevision || 0);
      form.elements.name.value = asset.name || '';
      form.elements.source.value = asset.source || '';
      form.elements.temporary.checked = asset.temporary === true;
      form.elements.startAt.value = beijingInput(asset.startAt);
      form.elements.endAt.value = beijingInput(asset.endAt);
      const platforms = asset.targetPlatforms || ['miniapp', 'web'];
      form.querySelectorAll('[name="targetPlatforms"]').forEach((input) => { input.checked = platforms.includes(input.value); });
      form.querySelector('#mediaMetadataIdentity').textContent = `文件类型：${asset.type === 'video' ? '视频' : '图片'}；当前版本：${asset.version || 1}；${asset.enabled === false ? '当前停用' : '当前启用'}。文件和类型不可在这里更换。`;
      openModal(form, '修改素材资料');
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      let saved = false;
      try {
        errorBox.textContent = '';
        const data = new FormData(form);
        const platforms = data.getAll('targetPlatforms');
        if (!platforms.length) throw new Error('请至少选择一个适用端。');
        if (!data.get('source')) throw new Error('请选择真实的素材来源。');
        const startAt = asIso(data.get('startAt'));
        const endAt = asIso(data.get('endAt'));
        if (startAt && endAt && startAt > endAt) throw new Error('结束展示时间不能早于开始时间。');
        const payload = { id: data.get('id'), metadataRevision: Number(form.dataset.metadataRevision), name: String(data.get('name') || '').trim(), source: data.get('source'), temporary: data.get('temporary') === 'on', targetPlatforms: platforms, startAt, endAt };
        const subject = assets().find((item) => item._id === payload.id);
        const scope = platforms.map((item) => item === 'miniapp' ? '小程序' : '网页端').join('、');
        const confirmText = `确认修改素材资料？\n素材：${subject?.name || '原素材'} → ${payload.name}\n来源：${form.elements.source.selectedOptions[0]?.textContent || '未选择'}；${payload.temporary ? '临时素材' : '正式素材'}\n适用端：${scope}\n展示时间：${form.elements.startAt.value || '不限定开始'} 至 ${form.elements.endAt.value || '不限定结束'}（北京时间）\n已引用该素材的商品或首页内容可能受展示范围变化影响。文件、类型和版本不会改变。`;
        if (!global.confirm(confirmText)) return;
        submit.disabled = true;
        await call('admin.media.updateMetadata', payload);
        saved = true;
        closeModal();
        await refresh();
        message('素材资料已保存；文件和版本未改变。');
      } catch (error) {
        const text = saved ? '资料已保存，但列表刷新失败；请刷新页面核对。' : error.message || '保存失败，请重试。';
        errorBox.textContent = text;
        message(text, true);
      } finally { submit.disabled = false; }
    });
  }
  global.MengshixianMediaMetadata = Object.freeze({ mount });
}(window, document));
