const crypto = require('crypto');
const { fail } = require('./response');
const { randomId } = require('./security');

const CHUNK_SIZE = 1024 * 1024;
const MAX_SIZE = 24 * CHUNK_SIZE;
const MIME_TYPES = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov'
};

function createAdminMediaChunks({ store, getAdmin, audit, clock, storageUploader, storageDownloader, storageDeleter }) {
  async function requireReady(payload) {
    const { admin } = await getAdmin(payload, 'media.write');
    if (!storageUploader || !storageDownloader) fail('MEDIA_UPLOAD_UNAVAILABLE', '分段素材上传服务尚未配置。');
    return admin;
  }
  function requireId(value) {
    const id = String(value || '');
    if (!/^media_[a-f0-9]{36}$/.test(id)) fail('MEDIA_UPLOAD_INVALID', '上传任务编号不正确。');
    return id;
  }
  async function ownedJob(id, admin) {
    const job = await store.findOne('admin_media_uploads', { _id: id });
    if (!job || job.adminId !== admin._id) fail('MEDIA_UPLOAD_NOT_FOUND', '上传任务不存在或无权访问。');
    if (clock().getTime() - new Date(job.createdAt).getTime() > 60 * 60 * 1000) fail('MEDIA_UPLOAD_EXPIRED', '上传任务已过期，请重新选择文件。');
    return job;
  }
  async function begin(payload) {
    const admin = await requireReady(payload);
    const type = payload.type;
    const mimeType = String(payload.mimeType || '').toLowerCase();
    if (!['image', 'video'].includes(type) || !MIME_TYPES[mimeType] || (type === 'image') !== mimeType.startsWith('image/')) fail('MEDIA_MIME_INVALID', '素材格式不受支持。');
    const fileName = String(payload.fileName || '').trim().slice(0, 160);
    if (!fileName) fail('MEDIA_UPLOAD_INVALID', '文件名不能为空。');
    const sizeBytes = Number(payload.sizeBytes);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 4 * CHUNK_SIZE || sizeBytes > MAX_SIZE) fail('MEDIA_SIZE_INVALID', '分段上传支持大于 4 MB 且不超过 24 MB 的文件。');
    const checksum = String(payload.sha256 || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(checksum)) fail('MEDIA_UPLOAD_INVALID', '文件校验值不正确。');
    const active = await store.list('admin_media_uploads', { where: { adminId: admin._id, status: 'pending' }, page: 1, pageSize: 100 });
    const recent = active.rows.filter((job) => clock().getTime() - new Date(job.createdAt).getTime() < 60 * 60 * 1000);
    const same = recent.find((job) => job.checksum === checksum && job.sizeBytes === sizeBytes && job.mimeType === mimeType);
    if (same) return { uploadId: same._id, chunkSize: CHUNK_SIZE, chunkCount: same.chunkCount, uploadedParts: Object.keys(same.parts || {}).map(Number), resumed: true };
    const complete = await store.list('admin_media_uploads', { where: { adminId: admin._id, status: 'complete' }, page: 1, pageSize: 100 });
    const reused = complete.rows.find((job) => job.checksum === checksum && job.sizeBytes === sizeBytes && job.mimeType === mimeType && job.fileId);
    if (reused) return { completed: true, fileId: reused.fileId, chunkSize: CHUNK_SIZE, chunkCount: reused.chunkCount };
    if (recent.length >= 5) fail('MEDIA_UPLOAD_LIMIT', '正在上传的任务过多，请稍后重试。');
    const id = randomId('media');
    await store.create('admin_media_uploads', {
      _id: id, adminId: admin._id, fileName, type, mimeType, sizeBytes, checksum,
      chunkCount: Math.ceil(sizeBytes / CHUNK_SIZE), parts: {}, status: 'pending',
      createdAt: clock().toISOString(), updatedAt: clock().toISOString()
    });
    return { uploadId: id, chunkSize: CHUNK_SIZE, chunkCount: Math.ceil(sizeBytes / CHUNK_SIZE) };
  }
  async function uploadPart(payload) {
    const admin = await requireReady(payload);
    const job = await ownedJob(requireId(payload.uploadId), admin);
    if (job.status !== 'pending') fail('MEDIA_UPLOAD_FINISHED', '上传任务已结束。');
    const index = Number(payload.index);
    if (!Number.isInteger(index) || index < 0 || index >= job.chunkCount) fail('MEDIA_UPLOAD_INVALID', '分段序号不正确。');
    if (job.parts && job.parts[index]) return { index, uploaded: true, alreadyUploaded: true };
    const base64 = String(payload.contentBase64 || '');
    if (!base64 || base64.length > 1500000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) fail('MEDIA_CONTENT_INVALID', '上传分段格式不正确。');
    const expected = Math.min(CHUNK_SIZE, job.sizeBytes - index * CHUNK_SIZE);
    const actual = Buffer.byteLength(base64, 'base64');
    if (actual !== expected) fail('MEDIA_SIZE_INVALID', `第 ${index + 1} 段大小不正确。`);
    const fileId = await storageUploader({ cloudPath: `mengshixian/media/upload-parts/${job._id}/${index}.part`, contentBase64: base64, mimeType: 'application/octet-stream', sizeBytes: actual });
    if (!fileId) fail('MEDIA_UPLOAD_FAILED', '分段上传未返回文件地址。');
    await store.update('admin_media_uploads', job._id, { parts: { ...job.parts, [index]: fileId }, updatedAt: clock().toISOString() });
    return { index, uploaded: true, alreadyUploaded: false };
  }
  async function finish(payload) {
    const admin = await requireReady(payload);
    const job = await ownedJob(requireId(payload.uploadId), admin);
    if (job.status === 'complete') return { fileId: job.fileId, mimeType: job.mimeType, sizeBytes: job.sizeBytes, alreadyUploaded: true };
    if (job.status !== 'pending') fail('MEDIA_UPLOAD_INVALID', '上传任务状态不正确。');
    const parts = [];
    for (let index = 0; index < job.chunkCount; index += 1) {
      const partId = job.parts && job.parts[index];
      if (!partId) fail('MEDIA_UPLOAD_INCOMPLETE', `第 ${index + 1} 段尚未上传。`);
      const bytes = await storageDownloader(partId);
      const expected = Math.min(CHUNK_SIZE, job.sizeBytes - index * CHUNK_SIZE);
      if (!Buffer.isBuffer(bytes) || bytes.length !== expected) fail('MEDIA_UPLOAD_INCOMPLETE', `第 ${index + 1} 段读取失败。`);
      parts.push(bytes);
    }
    const fileContent = Buffer.concat(parts);
    if (crypto.createHash('sha256').update(fileContent).digest('hex') !== job.checksum) {
      await store.update('admin_media_uploads', job._id, { status: 'failed', updatedAt: clock().toISOString() });
      if (storageDeleter) { try { await storageDeleter(Object.values(job.parts)); } catch (_) { /* A failed temporary-file cleanup must not prevent a fresh retry. */ } }
      fail('MEDIA_CONTENT_INVALID', '文件校验失败，本次上传已作废；请选择原文件重新上传。');
    }
    const safeName = job.fileName.replace(/[^0-9A-Za-z_\-.\u4e00-\u9fff]/g, '_').replace(/\.[^.]+$/, '') || 'media';
    const cloudPath = `mengshixian/media/uploads/${clock().toISOString().slice(0, 10)}/${randomId()}-${safeName}${MIME_TYPES[job.mimeType]}`;
    const fileId = await storageUploader({ cloudPath, fileContent, mimeType: job.mimeType, sizeBytes: job.sizeBytes });
    if (!fileId) fail('MEDIA_UPLOAD_FAILED', '完整文件上传未返回地址。');
    await store.update('admin_media_uploads', job._id, { status: 'complete', fileId, updatedAt: clock().toISOString() });
    await audit(admin, 'media.upload.large', 'media_asset_file', fileId, { mimeType: job.mimeType, sizeBytes: job.sizeBytes, cloudPath });
    if (storageDeleter) {
      try { await storageDeleter(Object.values(job.parts)); } catch (_) { /* 上传成功不因临时文件清理失败而回滚 */ }
    }
    return { fileId, mimeType: job.mimeType, sizeBytes: job.sizeBytes, alreadyUploaded: false };
  }
  return { begin, uploadPart, finish };
}

module.exports = { createAdminMediaChunks, CHUNK_SIZE, MAX_SIZE };
