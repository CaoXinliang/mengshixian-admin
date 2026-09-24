const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.resolve(__dirname, '../api-client.js'), 'utf8');
const calls = [];
let mode = 'new';
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
    const result = data.action === 'admin.media.beginUpload' ? (mode === 'complete' ? { completed: true, fileId: 'cloud://test/large.mp4' } : { uploadId: 'media_test', chunkSize: 1024 * 1024, chunkCount: 5, uploadedParts: mode === 'resume' ? [0, 1] : [], resumed: mode === 'resume' })
      : data.action === 'admin.media.finishUpload' ? { fileId: 'cloud://test/large.mp4', mimeType: 'video/mp4', sizeBytes: 4 * 1024 * 1024 + 1 }
        : { uploaded: true };
    return { result: { ok: true, data: result } };
  }
}) };
const window = { MENGSHIXIAN_ADMIN_CONFIG: { provider: 'cloudbase', envId: 'test-env', functionName: 'api' }, cloudbase, crypto: crypto.webcrypto,
  localStorage: { getItem: () => '', setItem: () => {}, removeItem: () => {} },
  sessionStorage: { getItem: () => 'session-only', setItem: () => {}, removeItem: () => {} } };
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
  console.log('large media client uses authenticated chunk API: passed');
}
test().catch((error) => { console.error(error); process.exitCode = 1; });
