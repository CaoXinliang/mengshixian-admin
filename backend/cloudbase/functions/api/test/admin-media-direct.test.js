const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApplication } = require('../app');
const { createMemoryStore } = require('../../../../../test/support/receipt-flow-fixture.cjs');

async function main() {
  const store = createMemoryStore();
  const issuedPaths = [];
  const uploadedFiles = new Map();
  let unsafeTicket = false;
  let ticketUnavailable = false;
  const app = createApplication({
    store,
    bootstrapToken: 'direct-upload-local-bootstrap',
    clock: () => new Date('2026-09-24T08:00:00Z'),
    storageTicketIssuer: async (cloudPath) => {
      if (ticketUnavailable) throw new Error('storage-gateway-timeout');
      issuedPaths.push(cloudPath);
      return { url: unsafeTicket ? 'http://upload.example.test/object' : 'https://upload.example.test/object', token: 'temporary-upload-token', authorization: 'object-only-signature',
        cosFileId: 'cos-meta', fileId: `cloud://local-env/${cloudPath}` };
    },
    storageVerifier: async (fileId) => {
      const bytes = uploadedFiles.get(fileId);
      return bytes ? { sizeBytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        container: bytes.toString('ascii', 4, 8) === 'ftyp' ? 'iso-bmff' : 'unknown' } : null;
    },
    storageDeleter: async (fileIds) => fileIds.forEach((fileId) => uploadedFiles.delete(fileId))
  });
  const dispatch = async (action, payload = {}) => app.dispatch({ action, payload, requestId: `direct-test-${action}` });
  await dispatch('admin.bootstrap', { bootstrapToken: 'direct-upload-local-bootstrap', username: 'owner', displayName: '本地管理员', password: 'local-password-12345' });
  const login = await dispatch('admin.login', { username: 'owner', password: 'local-password-12345' });
  const adminToken = login.data.token;
  const bytes = Buffer.alloc(30 * 1024 * 1024, 7);
  bytes.write('ftyp', 4, 'ascii');
  const video = { type: 'video', fileName: '客户视频.mp4', mimeType: 'video/mp4', sizeBytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), cloudPath: 'untrusted/overwrite.mp4' };
  assert.equal((await dispatch('admin.media.beginDirectUpload', { ...video, adminToken: 'wrong' })).error.code, 'ADMIN_SESSION_EXPIRED', '无效会话不能获取上传凭据');
  const begun = await dispatch('admin.media.beginDirectUpload', { ...video, adminToken });
  assert.equal(begun.ok, true, JSON.stringify(begun.error));
  assert.match(begun.data.uploadId, /^media_[a-f0-9]{36}$/);
  assert.equal(begun.data.ticket.fileId, `cloud://local-env/${issuedPaths[0]}`);
  assert.equal(begun.data.ticket.cloudPath, issuedPaths[0]);
  assert.match(issuedPaths[0], /^mengshixian\/media\/direct\//);
  assert.notEqual(issuedPaths[0], video.cloudPath, '上传路径必须由服务端生成，不能由浏览器指定');
  assert.equal(issuedPaths.length, 1);
  const retried = await dispatch('admin.media.beginDirectUpload', { ...video, adminToken });
  assert.equal(retried.data.uploadId, begun.data.uploadId, '同一文件中断后应沿用原任务和路径');
  assert.equal(retried.data.ticket.cloudPath, begun.data.ticket.cloudPath);
  const assetInput = { adminToken, name: '客户详情视频', type: 'video', source: 'client', targetPlatforms: ['miniapp'],
    fileId: begun.data.ticket.fileId, mimeType: video.mimeType, sizeBytes: video.sizeBytes, checksum: video.sha256 };
  assert.equal((await dispatch('admin.media.upsert', assetInput)).error.code, 'MEDIA_UPLOAD_INCOMPLETE',
    '大视频未校验前即使知道文件 ID 也不得提前登记素材');
  assert.equal((await dispatch('admin.media.finishDirectUpload', { adminToken, uploadId: begun.data.uploadId })).error.code,
    'MEDIA_UPLOAD_INCOMPLETE', '未真正上传时不能登记完成');
  uploadedFiles.set(begun.data.ticket.fileId, bytes);
  const finished = await dispatch('admin.media.finishDirectUpload', { adminToken, uploadId: begun.data.uploadId });
  assert.equal(finished.ok, true, JSON.stringify(finished.error));
  assert.equal(finished.data.fileId, begun.data.ticket.fileId);
  assert.equal((await dispatch('admin.media.list', { adminToken })).data.rows.length, 0, '上传完成不等于登记或发布素材');
  assert.equal((await dispatch('admin.media.finishDirectUpload', { adminToken, uploadId: begun.data.uploadId })).data.alreadyUploaded, true);
  const reused = await dispatch('admin.media.beginDirectUpload', { ...video, adminToken });
  assert.equal(reused.data.completed, true, '已校验文件再次选择时不应重新上传');
  assert.equal(reused.data.fileId, begun.data.ticket.fileId);
  assert.equal((await dispatch('admin.media.upsert', assetInput)).ok, true, '文件校验通过后才允许登记素材');
  const otherBytes = Buffer.alloc(bytes.length, 8);
  const otherVideo = { ...video, sha256: crypto.createHash('sha256').update(otherBytes).digest('hex') };
  const wrong = await dispatch('admin.media.beginDirectUpload', { ...otherVideo, adminToken });
  uploadedFiles.set(wrong.data.ticket.fileId, bytes);
  assert.equal((await dispatch('admin.media.finishDirectUpload', { adminToken, uploadId: wrong.data.uploadId })).error.code,
    'MEDIA_CONTENT_INVALID', '文件内容与申请时不同不得进入素材库');
  assert.equal(uploadedFiles.has(wrong.data.ticket.fileId), false, '错误文件应清理且不能覆盖已完成视频');
  assert.equal(uploadedFiles.has(begun.data.ticket.fileId), true);
  assert.notEqual((await dispatch('admin.media.beginDirectUpload', { ...otherVideo, adminToken })).data.uploadId,
    wrong.data.uploadId, '文件校验失败后应能开始新的上传任务');
  const disguisedBytes = Buffer.alloc(bytes.length, 3);
  const disguisedVideo = { ...video, sha256: crypto.createHash('sha256').update(disguisedBytes).digest('hex') };
  const disguised = await dispatch('admin.media.beginDirectUpload', { ...disguisedVideo, adminToken });
  uploadedFiles.set(disguised.data.ticket.fileId, disguisedBytes);
  assert.equal((await dispatch('admin.media.finishDirectUpload', { adminToken, uploadId: disguised.data.uploadId })).error.code,
    'MEDIA_MIME_INVALID', '仅修改扩展名的非视频不能登记为视频');
  unsafeTicket = true;
  assert.equal((await dispatch('admin.media.beginDirectUpload', { ...video, sha256: '1'.repeat(64), adminToken })).error.code,
    'MEDIA_UPLOAD_UNAVAILABLE', '不得通过未加密地址发送临时上传凭据');
  unsafeTicket = false; ticketUnavailable = true;
  const unavailable = await dispatch('admin.media.beginDirectUpload', { ...video, sha256: '2'.repeat(64), adminToken });
  assert.equal(unavailable.error.code, 'MEDIA_UPLOAD_UNAVAILABLE', '云存储发凭据失败时应提示可重试，不能露出内部错误');
  console.log('admin direct media ticket: passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
