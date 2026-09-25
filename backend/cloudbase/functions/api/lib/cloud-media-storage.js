const crypto = require('node:crypto');
const https = require('node:https');

function openHttpsReadable(address) {
  return new Promise((resolve, reject) => {
    const url = new URL(address);
    if (url.protocol !== 'https:') { reject(new Error('云存储预览地址必须使用 HTTPS。')); return; }
    const request = https.get(url, (response) => {
      if (response.statusCode === 404) { response.resume(); resolve(null); return; }
      if (response.statusCode !== 200) {
        response.resume(); reject(new Error(`云存储文件读取失败：HTTP ${response.statusCode}`)); return;
      }
      resolve(response);
    });
    request.setTimeout(15000, () => request.destroy(new Error('云存储读取超时。')));
    request.on('error', reject);
  });
}

function createCloudMediaStorage({ cloud, nodeSdk, openReadable = openHttpsReadable }) {
  const storage = nodeSdk.init();
  async function issueTicket(cloudPath) {
    const result = await storage.getUploadMetadata({ cloudPath });
    const data = result && result.data;
    if (result.code || !data || !data.url || !data.token || !data.authorization || !data.cosFileId || !data.fileId) {
      throw new Error('CloudBase 未返回完整的文件直传凭据。');
    }
    return { url: data.url, token: data.token, authorization: data.authorization, cosFileId: data.cosFileId, fileId: data.fileId };
  }
  async function verify(fileId, expectedSize) {
    const result = await cloud.getTempFileURL({ fileList: [fileId] });
    const file = result && result.fileList && result.fileList.find((item) => item.fileID === fileId);
    if (!file || !file.tempFileURL) return null;
    const stream = await openReadable(file.tempFileURL);
    if (!stream) return null;
    const hash = crypto.createHash('sha256');
    let sizeBytes = 0;
    const headerChunks = [];
    let headerLength = 0;
    const timer = setTimeout(() => stream.destroy(new Error('云存储校验超时。')), 15000);
    try {
      for await (const chunk of stream) {
        sizeBytes += chunk.length;
        if (sizeBytes > expectedSize) return { sizeBytes, sha256: '' };
        if (headerLength < 16) {
          const prefix = chunk.subarray(0, 16 - headerLength);
          headerChunks.push(prefix); headerLength += prefix.length;
        }
        hash.update(chunk);
      }
      const header = Buffer.concat(headerChunks);
      const container = header.length >= 8 && header.toString('ascii', 4, 8) === 'ftyp' ? 'iso-bmff'
        : header.length >= 4 && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) ? 'webm' : 'unknown';
      return { sizeBytes, sha256: hash.digest('hex'), container };
    } finally { clearTimeout(timer); }
  }
  return { issueTicket, verify };
}

module.exports = { createCloudMediaStorage };
