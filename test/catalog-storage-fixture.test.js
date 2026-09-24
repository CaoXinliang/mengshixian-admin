const assert = require('node:assert/strict');
const { createCatalogFixture } = require('./support/catalog-flow-fixture.cjs');
async function main() {
  const fixture = await createCatalogFixture();
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6WAAAAABJRU5ErkJggg==';
  const payload = { type: 'image', mimeType: 'image/png', fileName: '本地测试.png', contentBase64: png, sizeBytes: Buffer.from(png, 'base64').length };
  const first = await fixture.call('admin.media.upload', payload);
  const second = await fixture.call('admin.media.upload', payload);
  assert.notEqual(first.fileId, second.fileId, '再次上传不覆盖历史文件');
  assert.equal(fixture.mediaUrl(first.fileId), `data:image/png;base64,${png}`);
  assert.equal((await fixture.call('admin.media.list')).rows.length, 0, '上传文件不自动登记素材');
  await fixture.call('admin.media.upsert', { ...first, name: '本地演示图', source: 'demo', temporary: true, targetPlatforms: ['miniapp'] });
  const media = (await fixture.call('admin.media.list')).rows;
  assert.equal(media.length, 1);
  assert.equal(media[0].temporary, true);
  assert.equal((await fixture.call('admin.products.list')).rows.length, 0, '登记不生成/发布商品');
  console.log('Local storage boundary keeps upload, registration and publication separate');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
