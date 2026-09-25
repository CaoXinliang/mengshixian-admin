const { fail } = require('./response');
const { randomId } = require('./security');

const MIN_SIZE = 24 * 1024 * 1024;
const MAX_SIZE = 100 * 1024 * 1024;
const VIDEO_EXTENSIONS = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov' };

function createAdminMediaDirect({ store, getAdmin, audit, clock, storageTicketIssuer, storageVerifier, storageDeleter }) {
  function checkedTicket(ticket, cloudPath, expectedFileId = '') {
    let secure = false;
    try { secure = new URL(ticket && ticket.url).protocol === 'https:'; } catch (_) { /* malformed URL */ }
    if (!secure || !ticket.token || !ticket.authorization || !ticket.cosFileId || !ticket.fileId
      || (expectedFileId && ticket.fileId !== expectedFileId)) {
      fail('MEDIA_UPLOAD_UNAVAILABLE', '云存储没有返回安全且完整的大视频上传凭据。');
    }
    return { ...ticket, cloudPath };
  }
  async function issueTicket(cloudPath, expectedFileId = '') {
    let ticket;
    try { ticket = await storageTicketIssuer(cloudPath); }
    catch (_) { fail('MEDIA_UPLOAD_UNAVAILABLE', '暂时无法取得大视频上传凭据，请稍后重试。'); }
    return checkedTicket(ticket, cloudPath, expectedFileId);
  }
  async function discard(job) {
    await store.update('admin_media_uploads', job._id, { status: 'failed', updatedAt: clock().toISOString() });
    if (storageDeleter) { try { await storageDeleter([job.fileId]); } catch (_) { /* 不让清理失败遮蔽校验错误 */ } }
  }
  async function begin(payload) {
    const { admin } = await getAdmin(payload, 'media.write');
    if (typeof storageTicketIssuer !== 'function' || typeof storageVerifier !== 'function') {
      fail('MEDIA_UPLOAD_UNAVAILABLE', '大视频直传服务尚未配置。');
    }
    const mimeType = String(payload.mimeType || '').toLowerCase();
    if (payload.type !== 'video' || !VIDEO_EXTENSIONS[mimeType]) fail('MEDIA_MIME_INVALID', '大文件直传仅支持 MP4、WebM 或 MOV 视频。');
    const fileName = String(payload.fileName || '').trim().slice(0, 160);
    if (!fileName) fail('MEDIA_UPLOAD_INVALID', '文件名不能为空。');
    const sizeBytes = Number(payload.sizeBytes);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= MIN_SIZE || sizeBytes > MAX_SIZE) {
      fail('MEDIA_SIZE_INVALID', '大视频直传支持超过 24 MB 且不超过 100 MB 的文件。');
    }
    const checksum = String(payload.sha256 || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(checksum)) fail('MEDIA_UPLOAD_INVALID', '文件校验值不正确。');
    const identity = { adminId: admin._id, mode: 'direct', checksum, sizeBytes, mimeType };
    const completed = await store.findOne('admin_media_uploads', { ...identity, status: 'complete' });
    if (completed && completed.fileId) return { completed: true, fileId: completed.fileId, mimeType, sizeBytes };
    const pending = await store.findOne('admin_media_uploads', { ...identity, status: 'pending' });
    if (pending && clock().getTime() - new Date(pending.createdAt).getTime() < 3 * 60 * 60 * 1000) {
      const ticket = await issueTicket(pending.cloudPath, pending.fileId);
      return { uploadId: pending._id, resumed: true, ticket };
    }
    const id = randomId('media');
    const cloudPath = `mengshixian/media/direct/${clock().toISOString().slice(0, 10)}/${id}${VIDEO_EXTENSIONS[mimeType]}`;
    const ticket = await issueTicket(cloudPath);
    await store.create('admin_media_uploads', {
      _id: id, adminId: admin._id, mode: 'direct', status: 'pending', fileName, type: 'video', mimeType,
      sizeBytes, checksum, cloudPath, fileId: ticket.fileId, createdAt: clock().toISOString(), updatedAt: clock().toISOString()
    });
    return { uploadId: id, ticket };
  }

  async function finish(payload) {
    const { admin } = await getAdmin(payload, 'media.write');
    if (typeof storageVerifier !== 'function') fail('MEDIA_UPLOAD_UNAVAILABLE', '大视频校验服务尚未配置。');
    const uploadId = String(payload.uploadId || '');
    if (!/^media_[a-f0-9]{36}$/.test(uploadId)) fail('MEDIA_UPLOAD_INVALID', '上传任务编号不正确。');
    const job = await store.findOne('admin_media_uploads', { _id: uploadId, adminId: admin._id, mode: 'direct' });
    if (!job) fail('MEDIA_UPLOAD_NOT_FOUND', '上传任务不存在或无权访问。');
    if (job.status === 'complete') return { fileId: job.fileId, mimeType: job.mimeType, sizeBytes: job.sizeBytes, alreadyUploaded: true };
    if (job.status !== 'pending') fail('MEDIA_UPLOAD_INVALID', '上传任务状态不正确，请重新选择文件。');
    if (clock().getTime() - new Date(job.createdAt).getTime() > 3 * 60 * 60 * 1000) fail('MEDIA_UPLOAD_EXPIRED', '上传任务已过期，请重新选择文件。');
    let verified;
    try { verified = await storageVerifier(job.fileId, job.sizeBytes); }
    catch (_) { fail('MEDIA_VERIFY_UNAVAILABLE', '暂时无法核对云端文件，请稍后重试。'); }
    if (!verified) fail('MEDIA_UPLOAD_INCOMPLETE', '尚未发现已上传的视频，请确认上传完成后重试。');
    if (verified.sizeBytes !== job.sizeBytes || verified.sha256 !== job.checksum) {
      await discard(job);
      fail('MEDIA_CONTENT_INVALID', '云端视频与选择的文件不一致，本次上传已作废，请重新选择原文件。');
    }
    const expectedContainer = job.mimeType === 'video/webm' ? 'webm' : 'iso-bmff';
    if (verified.container !== expectedContainer) {
      await discard(job);
      fail('MEDIA_MIME_INVALID', '云端文件不是所选视频格式，请选择正确的视频文件重新上传。');
    }
    await store.update('admin_media_uploads', uploadId, { status: 'complete', updatedAt: clock().toISOString() });
    await audit(admin, 'media.upload.direct', 'media_asset_file', job.fileId, { mimeType: job.mimeType, sizeBytes: job.sizeBytes, cloudPath: job.cloudPath });
    return { fileId: job.fileId, mimeType: job.mimeType, sizeBytes: job.sizeBytes, alreadyUploaded: false };
  }

  return { begin, finish };
}

module.exports = { createAdminMediaDirect, MIN_SIZE, MAX_SIZE };
