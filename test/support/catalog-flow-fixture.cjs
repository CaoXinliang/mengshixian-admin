const { createApplication } = require('../../backend/cloudbase/functions/api/app');
const { createMemoryStore } = require('./receipt-flow-fixture.cjs');

async function createCatalogFixture() {
  const store = createMemoryStore();
  const files = new Map();
  const mediaUrl = fileId => files.get(fileId) || '';
  const bootstrapToken = 'catalog-flow-bootstrap-local-only';
  const password = 'catalog-flow-password-local-only';
  const app = createApplication({
    store,
    getIdentity: () => ({ OPENID: 'catalog-flow-local-openid' }),
    bootstrapToken,
    piiEncryptionKey: 'catalog-flow-local-encryption-key',
    storageUploader: async ({ contentBase64, mimeType }) => {
      const fileId = `cloud://local-memory/catalog-file-${files.size + 1}`;
      files.set(fileId, `data:${mimeType};base64,${contentBase64}`);
      return fileId;
    },
    mediaUrlResolver: async fileIds => Object.fromEntries(fileIds.map(id => [id, mediaUrl(id)])),
    clock: () => new Date('2026-09-23T12:00:00.000Z')
  });
  let adminToken = '';
  async function call(action, payload = {}) {
    const request = action.startsWith('admin.') && !['admin.bootstrap', 'admin.login'].includes(action)
      ? { adminToken, ...payload }
      : { ...payload };
    const result = await app.dispatch({ action, payload: request, requestId: `catalog-flow-${action}` });
    if (!result.ok) {
      const error = new Error(result.error?.message || `Action ${action} failed`);
      error.code = result.error?.code || 'UNKNOWN_ERROR';
      throw error;
    }
    return result.data;
  }
  await call('admin.bootstrap', { bootstrapToken, username: 'catalog-owner', displayName: '本地商品测试管理员', password });
  adminToken = (await call('admin.login', { username: 'catalog-owner', password })).token;
  const customers = new Map();
  async function customerCall(openid, action, payload = {}) {
    if (!customers.has(openid)) customers.set(openid, createApplication({
      store, getIdentity: () => openid ? { OPENID: openid } : {},
      piiEncryptionKey: 'catalog-flow-local-encryption-key',
      mediaUrlResolver: async ids => Object.fromEntries(ids.map(id => [id, mediaUrl(id)])),
      clock: () => new Date('2026-09-23T12:00:00.000Z')
    }));
    const result = await customers.get(openid).dispatch({action, payload});
    if (!result.ok) throw Object.assign(new Error(result.error.message), {code:result.error.code});
    return result.data;
  }
  return { app, call, adminToken, mediaUrl, customerCall };
}

module.exports = { createCatalogFixture };
