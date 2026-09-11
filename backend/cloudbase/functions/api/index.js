const cloud = require('wx-server-sdk');
const { createApplication } = require('./app');
const { createCloudStore } = require('./lib/cloud-store');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const app = createApplication({
  store: createCloudStore(db),
  getIdentity: () => cloud.getWXContext(),
  bootstrapToken: process.env.MENGSHIXIAN_ADMIN_BOOTSTRAP_TOKEN || '',
  piiEncryptionKey: process.env.MENGSHIXIAN_PII_ENCRYPTION_KEY || '',
  demoMode: process.env.MENGSHIXIAN_DEMO_MODE === 'true',
  mediaUrlResolver: async (fileIds) => {
    if (!fileIds.length || typeof cloud.getTempFileURL !== 'function') return {};
    const result = await cloud.getTempFileURL({ fileList: fileIds });
    return (result.fileList || []).reduce((map, item) => {
      if (item.fileID && item.tempFileURL) map[item.fileID] = item.tempFileURL;
      return map;
    }, {});
  },
  storageUploader: async ({ cloudPath, contentBase64 }) => {
    if (typeof cloud.uploadFile !== 'function') throw new Error('CloudBase 云函数不支持文件上传。');
    const result = await cloud.uploadFile({ cloudPath, fileContent: Buffer.from(contentBase64, 'base64') });
    return result && (result.fileID || result.fileId);
  }
});

exports.main = async (event = {}) => app.dispatch(event);
