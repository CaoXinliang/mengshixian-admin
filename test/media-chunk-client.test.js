const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.resolve(__dirname, '../api-client.js'), 'utf8');
const calls = [];
const directRequests = [];
let mode = 'new';
let directFinishCalls = 0;
class MockReader {
  readAsDataURL(blob) {
    blob.arrayBuffer().then((bytes) => {
      this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`;
      this.onload();
    }, (error) => this.onerror(error));
  }
}
const cloudbase = { init: () => ({
  auth: { signInAnonymously: async () => ({ error: null }) },
  callFunction: async ({ data }) => {
    calls.push(data);
    if (data.action === 'admin.media.finishDirectUpload' && mode === 'direct-resume' && directFinishCalls++ === 0) {
      return { result: { ok: false, error: { code: 'MEDIA_UPLOAD_INCOMPLETE', message: '云端尚无完整文件' } } };
    }
    const result = data.action === 'admin.media.beginDirectUpload'
      ? (mode === 'direct-complete' ? { completed: true, fileId: 'cloud://test/direct.mp4' } : { uploadId: 'media_direct', resumed: mode === 'direct-resume', ticket: { url: 'https://upload.example.test/object', token: 'temporary-token', authorization: 'signed-object', cosFileId: 'meta', cloudPath: 'mengshixian/media/direct/one.mp4', fileId: 'cloud://test/direct.mp4' } })
      : data.action === 'admin.media.finishDirectUpload' ? { fileId: 'cloud://test/direct.mp4', mimeType: 'video/mp4', sizeBytes: 30 * 1024 * 1024 }
      : data.action === 'admin.media.beginUpload' ? (mode === 'complete' ? { completed: true, fileId: 'cloud://test/large.mp4' } : { uploadId: 'media_test', chunkSize: 1024 * 1024, chunkCount: 5, uploadedParts: mode === 'resume' ? [0, 1] : [], resumed: mode === 'resume' })
      : data.action === 'admin.media.finishUpload' ? { fileId: 'cloud://test/large.mp4', mimeType: 'video/mp4', sizeBytes: 4 * 1024 * 1024 + 1 }
        : { uploaded: true };
    return { result: { ok: true, data: result } };
  }
}) };
const window = { MENGSHIXIAN_ADMIN_CONFIG: { provider: 'cloudbase', envId: 'test-env', functionName: 'api' }, cloudbase, crypto: crypto.webcrypto,
  localStorage: { getItem: () => '', setItem: () => {}, removeItem: () => {} },
  sessionStorage: { getItem: () => 'session-only', setItem: () => {}, removeItem: () => {} } };
window.FormData = FormData;
window.XMLHttpRequest = class {
  constructor() { this.upload = {}; }
  open(method, url) { this.method = method; this.url = url; }
  send(form) {
    directRequests.push({ method: this.method, url: this.url, form });
    this.upload.onprogress({ lengthComputable: true, loaded: form.get('file').size, total: form.get('file').size });
    this.status = 204; this.onload();
  }
};
vm.runInNewContext(source, { window, FileReader: MockReader, Promise, Date, Math, Error, JSON, Uint8Array });

async function test() {
  const file = new File([Buffer.alloc(4 * 1024 * 1024 + 1, 9)], 'large.mp4', { type: 'video/mp4' });
  const uploaded = await window.MengshixianAdminApi.uploadMediaFile(file, 'video');
  assert.equal(uploaded.fileId, 'cloud://test/large.mp4');
  assert.deepEqual(calls.map((item) => item.action), ['admin.media.beginUpload', ...Array(5).fill('admin.media.uploadPart'), 'admin.media.finishUpload']);
  assert.ok(calls.every((item) => item.payload.adminToken === 'session-only'));
  assert.equal(calls[1].payload.index, 0);
  assert.equal(Buffer.from(calls[5].payload.contentBase64, 'base64').length, 1);
  calls.length = 0; mode = 'resume';
  const progress = [];
  await window.MengshixianAdminApi.uploadMediaFile(file, 'video', (update) => progress.push(update));
  assert.deepEqual(calls.filter((item) => item.action === 'admin.media.uploadPart').map((item) => item.payload.index), [2, 3, 4], 'Resume must not resend bytes for successful parts');
  assert.equal(progress.at(-1).percent, 100);
  calls.length = 0; mode = 'complete';
  assert.equal((await window.MengshixianAdminApi.uploadMediaFile(file, 'video')).fileId, 'cloud://test/large.mp4');
  assert.deepEqual(calls.map((item) => item.action), ['admin.media.beginUpload'], 'Completed upload must not send or merge again');
  calls.length = 0; mode = 'direct';
  const bigger = new File([Buffer.alloc(30 * 1024 * 1024, 3)], 'direct.mp4', { type: 'video/mp4' });
  window.MengshixianAdminApi.config.largeVideoUploadEnabled = false;
  await assert.rejects(() => window.MengshixianAdminApi.uploadMediaFile(bigger, 'video'), /尚未启用/,
    '未验证部署前不可让运营人员走一个云端还没有接通的大视频入口');
  assert.equal(calls.length, 0);
  window.MengshixianAdminApi.config.largeVideoUploadEnabled = true;
  const directProgress = [];
  const direct = await window.MengshixianAdminApi.uploadMediaFile(bigger, 'video', (update) => directProgress.push(update));
  assert.equal(direct.fileId, 'cloud://test/direct.mp4');
  assert.deepEqual(calls.map((item) => item.action), ['admin.media.beginDirectUpload', 'admin.media.finishDirectUpload']);
  assert.equal(directRequests.length, 1);
  assert.equal(directRequests[0].method, 'POST');
  assert.equal(directRequests[0].form.get('key'), 'mengshixian/media/direct/one.mp4');
  assert.equal(directRequests[0].form.get('Signature'), 'signed-object');
  assert.equal(directRequests[0].form.get('file').size, bigger.size);
  assert.equal(directProgress.at(-1).phase, 'complete');
  calls.length = 0; mode = 'direct-complete';
  assert.equal((await window.MengshixianAdminApi.uploadMediaFile(bigger, 'video')).fileId, 'cloud://test/direct.mp4');
  assert.deepEqual(calls.map((item) => item.action), ['admin.media.beginDirectUpload']);
  assert.equal(directRequests.length, 1, 'Already verified video should not upload again');
  calls.length = 0; directRequests.length = 0; directFinishCalls = 0; mode = 'direct-resume';
  await window.MengshixianAdminApi.uploadMediaFile(bigger, 'video');
  assert.deepEqual(calls.map((item) => item.action), ['admin.media.beginDirectUpload', 'admin.media.finishDirectUpload', 'admin.media.finishDirectUpload'],
    'Retry must first check whether cloud already received the video');
  assert.equal(directRequests.length, 1, 'Only incomplete cloud upload should be sent again');
  console.log('large media client uses authenticated chunk API: passed');
}
test().catch((error) => { console.error(error); process.exitCode = 1; });
