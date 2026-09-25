const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { createCloudMediaStorage } = require('../lib/cloud-media-storage');

async function main() {
  const bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.from('本地模拟视频内容')]);
  const paths = [];
  const storage = createCloudMediaStorage({
    nodeSdk: { init: () => ({ getUploadMetadata: async ({ cloudPath }) => {
      paths.push(cloudPath);
      return { data: { url: 'https://upload.example.test/one-object', token: 'short-lived', authorization: 'signed-one-object',
        cosFileId: 'cos-meta', fileId: `cloud://local-env/${cloudPath}` } };
    } }) },
    cloud: { getTempFileURL: async ({ fileList }) => ({ fileList: [{ fileID: fileList[0], tempFileURL: 'https://storage.example.test/video' }] }) },
    openReadable: async () => Readable.from([bytes.subarray(0, 5), bytes.subarray(5)])
  });
  const ticket = await storage.issueTicket('mengshixian/media/direct/test.mp4');
  assert.deepEqual(paths, ['mengshixian/media/direct/test.mp4']);
  assert.equal(ticket.fileId, 'cloud://local-env/mengshixian/media/direct/test.mp4');
  assert.equal(ticket.url, 'https://upload.example.test/one-object');
  const verified = await storage.verify(ticket.fileId, bytes.length);
  assert.equal(verified.sizeBytes, bytes.length);
  assert.equal(verified.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(verified.container, 'iso-bmff', '应识别真实文件头而非只相信扩展名');
  console.log('CloudBase direct storage adapter streaming verification: passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
