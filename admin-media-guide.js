(function mediaGuide(global, document) {
  'use strict';
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  function mount({ api, call, refresh, message, closeModal, assets }) {
    const uploadedFiles = new Map();
    const form = document.getElementById('mediaForm');
    if (!form) return;
    const submit = form.querySelector('button[type="submit"], button.primary');
    const status = document.createElement('p');
    status.id = 'mediaUploadStatus';
    status.setAttribute('aria-live', 'polite');
    const progress = document.createElement('progress');
    progress.id = 'mediaUploadProgress'; progress.max = 100; progress.value = 0; progress.hidden = true;
    submit.before(status, progress);
    form.elements.uploadFile.addEventListener('change', () => {
      const file = form.elements.uploadFile.files && form.elements.uploadFile.files[0];
      if (file && !form.elements.name.value.trim()) form.elements.name.value = file.name.replace(/\.[^.]+$/, '').slice(0, 100);
      if (file) status.textContent = `已选择 ${file.name}；上传前不会写入友方云。`;
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      const fields = new FormData(form);
      const file = fields.get('uploadFile');
      const type = fields.get('type');
      const replacing = fields.get('replacesMediaAssetId');
      let uploadStarted = false;
      let fileUploaded = false;
      try {
        if (!file || !file.size) throw new Error('请先从电脑选择图片或视频。');
        const allowed = type === 'image' ? ['image/jpeg', 'image/png', 'image/webp'] : ['video/mp4', 'video/webm', 'video/quicktime'];
        if (!allowed.includes(file.type)) throw new Error('选择的文件与素材类型不一致或格式不支持，请改选正确类型。');
        if (type === 'image' && file.size > 24 * 1024 * 1024) throw new Error('图片超过 24 MB，请压缩后再选择。');
        if (type === 'video' && file.size > 24 * 1024 * 1024 && !api.config.largeVideoUploadEnabled) {
          throw new Error('当前环境的大视频直传尚未启用；请先压缩到 24 MB 内。');
        }
        if (type === 'video' && file.size > 100 * 1024 * 1024) throw new Error('视频超过 100 MB，请压缩后再选择。');
        submit.disabled = true;
        progress.hidden = false; progress.value = 0;
        status.textContent = '正在检查文件是否已上传…';
        if (!global.crypto || !global.crypto.subtle) throw new Error('当前页面不支持文件校验，请使用最新版 Edge 并从正式后台入口打开。');
        const checksum = [...new Uint8Array(await global.crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        const duplicate = assets().find((item) => item.checksum === checksum && item.type === type && item.enabled !== false);
        if (duplicate && !replacing) {
          status.textContent = `素材库已有相同内容「${duplicate.name}」，无需再次上传，请在商品核对页选择它。`;
          message(status.textContent); return;
        }
        if (replacing && assets().some((item) => item._id === replacing && item.checksum === checksum)) throw new Error('新版本与旧版本内容相同，请选择修改后的文件。');
        const cacheKey = `${type}:${checksum}`;
        uploadStarted = true;
        const uploaded = uploadedFiles.get(cacheKey) || await api.uploadMediaFile(file, type, (update) => {
          progress.value = update.percent;
          status.textContent = update.phase === 'checking' ? '正在核对文件内容…'
            : update.phase === 'finishing' ? '已上传全部分段，正在合并与校验…'
              : update.phase === 'verifying' ? '视频已传到云端，后台正在核对文件…'
              : update.phase === 'complete' ? '文件上传完成，正在登记素材…'
                : `${update.resumed ? '继续上传' : '上传中'}：${update.percent}%`;
        });
        uploadedFiles.set(cacheKey, uploaded);
        fileUploaded = true;
        status.textContent = '文件已上传，正在登记素材；登记失败后可在当前页面直接重试。';
        const payload = { name: fields.get('name'), type, source: fields.get('source'), temporary: fields.get('temporary') === 'on',
          targetPlatforms: fields.getAll('targetPlatforms'), startAt: fields.get('startAt'), endAt: fields.get('endAt'),
          fileId: uploaded.fileId, mimeType: uploaded.mimeType, sizeBytes: uploaded.sizeBytes, checksum };
        const typeLabel = type === 'image' ? '图片' : '视频';
        const previous = replacing ? assets().find((item) => item._id === replacing) : null;
        const confirmText = replacing
          ? `请核对新建版本：\n素材名称：${payload.name || '未命名'}\n类型：${typeLabel}\n替换对象：${previous ? previous.name || replacing : replacing}\n\n新版本会影响既有引用：所有使用旧素材的位置（商品图、轮播图等）将改用新文件，旧文件保留但不再展示。\n确认提交？`
          : `请核对素材登记：\n素材名称：${payload.name || '未命名'}\n类型：${typeLabel}\n\n确认提交？登记后素材进入素材库，关联商品后才会在小程序展示。`;
        if (!global.confirm(confirmText)) { status.textContent = '已取消登记；文件已上传，重新提交会直接复用，不会重复上传。'; return; }
        await call(replacing ? 'admin.media.createVersion' : 'admin.media.upsert', { ...payload, replacesMediaAssetId: replacing });
        closeModal(); form.reset(); await refresh();
        status.textContent = replacing ? '新版本已登记，旧素材文件与记录保留。' : '文件已上传并登记到素材库；还需按商品编码关联后才能展示。';
        message(status.textContent);
      } catch (error) {
        const retry = fileUploaded ? '文件已上传，重新提交会复用已上传文件，不会重复上传。'
          : uploadStarted && file.size > 24 * 1024 * 1024
            ? '重新选择同一文件可重试；后台会先检查云端是否已收齐，否则从头上传。'
            : uploadStarted ? '重新选择同一文件后可重试；若上传任务仍有效，分段会继续未完成部分。' : '';
        status.textContent = `${error.message || '上传失败。'}${retry}`;
        message(status.textContent, true);
      } finally { submit.disabled = false; }
    });
    const dialog = document.getElementById('mediaPreviewDialog');
    let previewRequest = 0;
    document.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-preview-media]');
      if (!button || !dialog) return;
      const asset = assets().find((item) => item._id === button.dataset.previewMedia);
      if (!asset || !asset.fileId) { message('这条素材没有可预览的文件。', true); return; }
      const content = dialog.querySelector('[data-preview-content]');
      const request = ++previewRequest;
      content.textContent = '正在获取素材预览…';
      dialog.showModal();
      try {
        if (!global.cloudbase) throw new Error('当前浏览器无法连接素材预览服务。');
        const cloud = global.cloudbase.init({ env: api.config.envId, region: 'ap-shanghai' });
        const result = await cloud.getTempFileURL({ fileList: [asset.fileId] });
        const url = result.fileList && result.fileList[0] && result.fileList[0].tempFileURL;
        if (request !== previewRequest) return;
        if (!url) throw new Error('当前文件没有可用的预览地址。');
        const source = ({ client: '甲方提供', ai_generated: 'AI 生成', demo: '演示素材', admin_upload: '后台上传' })[asset.source] || '来源未登记，请核对';
        const platforms = Array.isArray(asset.targetPlatforms) && asset.targetPlatforms.length
          ? asset.targetPlatforms.map((item) => ({ miniapp: '小程序', web: '网页端' })[item] || '适用端待核对').join('、')
          : '适用端未登记，请核对';
        const version = Number.isSafeInteger(Number(asset.version)) && Number(asset.version) > 0 ? asset.version : '未登记';
        content.innerHTML = `<h3>${esc(asset.name)}</h3><div class="media-preview-meta"><span>类型：${asset.type === 'video' ? '视频' : '图片'}</span><span>来源：${esc(source)}</span><span>版本：${esc(version)}</span><span>适用端：${esc(platforms)}</span></div>${asset.type === 'video' ? `<video controls preload="metadata" src="${esc(url)}" style="max-width:min(80vw,700px);max-height:65vh"></video>` : `<img src="${esc(url)}" alt="${esc(asset.name)}" style="max-width:min(80vw,700px);max-height:65vh;object-fit:contain">`}`;
        content.querySelector('img,video').addEventListener('error', () => { if (request === previewRequest) content.textContent = '文件加载失败，尚未完成预览。请关闭后重新点“预览”；仍失败时请检查或重新上传素材。'; }, { once: true });
      } catch (error) { if (request === previewRequest) content.textContent = error.message || '预览失败，请稍后重试。'; }
    });
    dialog && dialog.querySelector('[data-preview-close]').addEventListener('click', () => dialog.close());
    dialog && dialog.addEventListener('close', () => { previewRequest++; dialog.querySelector('[data-preview-content]').replaceChildren(); });
  }
  global.MengshixianMediaGuide = Object.freeze({ mount });
}(window, document));
