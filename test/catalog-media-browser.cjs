const assert = require('node:assert/strict');

module.exports = async function catalogMediaBrowser({ fixture, send, evaluate, pause, waitFor, productCode }) {
  const imageName = '仅本地演示主图';
  const videoName = '仅本地演示详情视频';
  const products = (await fixture.call('admin.products.list', { pageSize: 100 })).rows;
  const product = products.find((row) => row.spuCode === productCode);
  assert.ok(product, '必须沿交付表已生成的商品草稿继续');
  assert.equal(product.status, 'draft');
  const jobs = (await fixture.call('admin.imports.list', { pageSize: 100 })).rows;
  assert.ok(jobs.some((job) => job.parsedPayload?.skuCode === 'TEST-S-0001' && job.parsedPayload.productCode === productCode && job.status === 'imported'), '商品草稿须来自交付演示表首条规格');
  assert.equal((await fixture.call('admin.media.list')).rows.length, 0, '本链路从空素材库开始');

  await send('Page.navigate', { url: 'http://127.0.0.1:8765/media.html' });
  await waitFor("Boolean(document.querySelector('[data-add-form=\"#mediaForm\"]') && document.querySelector('#mediaForm') && window.MengshixianAdminApi.uploadMediaFile)");

  async function upload(name, type, fileExpression) {
    await evaluate(`document.querySelector('[data-add-form="#mediaForm"]').click()`);
    await waitFor("Boolean(document.querySelector('#mediaForm')?.elements.uploadFile && document.querySelector('#mediaUploadStatus'))");
    await evaluate(`(async () => {
      const file = await (${fileExpression})();
      if (!file.size || file.type !== ${JSON.stringify(type === 'image' ? 'image/png' : 'video/webm')}) throw new Error('本地测试文件无效');
      const form = document.querySelector('#mediaForm');
      form.elements.name.value = ${JSON.stringify(name)};
      form.elements.type.value = ${JSON.stringify(type)};
      form.elements.source.value = 'demo';
      form.elements.temporary.checked = true;
      const transfer = new DataTransfer(); transfer.items.add(file);
      form.elements.uploadFile.files = transfer.files;
      form.elements.uploadFile.dispatchEvent(new Event('change'));
      window.confirm = () => true;
      form.requestSubmit();
    })()`);
    await waitFor("document.querySelector('#mediaUploadStatus')?.textContent.includes('文件已上传并登记到素材库')");
    const matches = (await fixture.call('admin.media.list', { pageSize: 100 })).rows.filter((row) => row.name === name);
    assert.equal(matches.length, 1, `${name}必须经实际上传与登记接口生成一条素材`);
    assert.equal(matches[0].type, type);
    assert.equal(matches[0].source, 'demo');
    assert.equal(matches[0].temporary, true);
    assert.ok(matches[0].fileId);
    return matches[0];
  }

  const image = await upload(imageName, 'image', `async () => {
    const response = await fetch('/assets/logo.png');
    if (!response.ok) throw new Error('本地 PNG 不可读取');
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    if (!bitmap.width || !bitmap.height) throw new Error('本地 PNG 无法解码');
    bitmap.close();
    return new File([blob], '仅本地演示主图.png', { type: 'image/png' });
  }`);

  const video = await upload(videoName, 'video', `async () => {
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
    const context = canvas.getContext('2d');
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks = [];
    recorder.ondataavailable = event => chunks.push(event.data);
    const stopped = new Promise(resolve => recorder.onstop = resolve);
    recorder.start();
    for (let frame = 0; frame < 8; frame++) {
      context.fillStyle = frame % 2 ? '#1565c0' : '#ffffff';
      context.fillRect(0, 0, 64, 64);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    recorder.stop(); await stopped; stream.getTracks().forEach(track => track.stop());
    const file = new File(chunks, '仅本地演示详情视频.webm', { type: 'video/webm' });
    if (!file.size) throw new Error('WebM 录制结果为空');
    return file;
  }`);

  const reviewUrl = `http://127.0.0.1:8765/product-review.html?code=${encodeURIComponent(productCode)}`;
  await send('Page.navigate', { url: reviewUrl });
  await waitFor(`Boolean(document.querySelector('#linkMediaAsset') && document.querySelector('#reviewDetail')?.textContent.includes(${JSON.stringify(productCode)}))`);
  assert.equal(await evaluate("document.querySelector('#publishReviewed')?.disabled"), true, '素材关联前仍不能发布');

  const chooseByName = (name, type, role) => evaluate(`(() => {
    const typeSelect = document.querySelector('#linkMediaType');
    typeSelect.value = ${JSON.stringify(type)};
    typeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    const assetSelect = document.querySelector('#linkMediaAsset');
    const matching = [...assetSelect.options].filter(option => option.textContent.includes(${JSON.stringify(name)}));
    if (matching.length !== 1) throw new Error('素材名称不是唯一可选项：' + ${JSON.stringify(name)});
    assetSelect.selectedIndex = matching[0].index;
    document.querySelector('#linkMediaRole').value = ${JSON.stringify(role)};
    document.querySelector('#linkSkuCode').value = '';
    document.querySelector('#linkMedia').click();
  })()`);

  await waitFor(`Array.from(document.querySelector('#linkMediaAsset')?.options || []).some(option => option.textContent.includes(${JSON.stringify(imageName)}))`);
  await chooseByName(imageName, 'image', 'cover');
  await waitFor(`Boolean(document.querySelector('#reviewDetail img[alt="商品主图"]')?.naturalWidth > 0 && document.querySelector('#reviewDetail')?.textContent.includes(${JSON.stringify(imageName)}))`);
  assert.equal(await evaluate("document.querySelector('#reviewDetail img[alt=\"商品主图\"]').currentSrc.startsWith('data:image/png;base64,')"), true, '主图必须从本地上传的实际 PNG 解码显示');

  await chooseByName(videoName, 'video', 'detail');
  await waitFor(`Boolean(document.querySelector('#reviewDetail video')?.readyState >= 1 && document.querySelector('#reviewDetail')?.textContent.includes(${JSON.stringify(videoName)}))`);
  assert.equal(await evaluate("document.querySelector('#reviewDetail video').currentSrc.startsWith('data:video/webm;base64,')"), true, '视频必须指向本地上传的实际 WebM');
  await evaluate("(async () => { const video = document.querySelector('#reviewDetail video'); video.muted = true; await video.play(); })()");
  await waitFor("document.querySelector('#reviewDetail video')?.currentTime > 0.1");
  await evaluate("document.querySelector('#reviewDetail video').pause()");

  const associations = (await fixture.call('admin.productMedia.list', { productId: product._id, pageSize: 100 })).rows;
  assert.equal(associations.length, 2, '商品须恰有主图和详情视频两条实际 API 关联');
  assert.ok(associations.some((row) => row.mediaAssetId === image._id && row.mediaType === 'image' && row.role === 'cover' && row.enabled));
  assert.ok(associations.some((row) => row.mediaAssetId === video._id && row.mediaType === 'video' && row.role === 'detail' && row.enabled));
  const review = await fixture.call('admin.products.review', { id: product._id });
  assert.equal(review.cover?.fileId, image.fileId);
  assert.ok(review.videos.some((row) => row.fileId === video.fileId));
  assert.equal(review.ready, false, '尚未补价格不得满足发布条件');
  assert.ok(review.issues.some((issue) => issue.includes('价格')), '真实 API 须说明缺价格');
  assert.equal(await evaluate("document.querySelector('#publishReviewed')?.disabled"), true, '视频可播仍不能绕过缺价格保护');
  await assert.rejects(
    fixture.call('admin.products.publishReviewed', { id: product._id, reviewToken: review.reviewToken }),
    (error) => error.code === 'PRODUCT_NOT_READY',
    '实际 API 也必须拒绝缺价格商品的发布'
  );
  assert.equal((await fixture.call('admin.products.list')).rows.find((row) => row._id === product._id).status, 'draft');
  console.log('Same delivered product: real PNG/WebM upload and registration -> name-based cover/video links -> image loaded/video played; missing price blocks publish');
};
