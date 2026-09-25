const assert = require('node:assert/strict');
const { createApplication } = require('../app');
const { createMemoryStore } = require('../../../../../test/support/receipt-flow-fixture.cjs');

async function main() {
  const store = createMemoryStore();
  let rejectAudit = false;
  const guardedStore = {
    ...store,
    create: (collection, item) => rejectAudit && collection === 'audit_logs' ? Promise.reject(new Error('本地模拟审计写入失败')) : store.create(collection, item),
    runTransaction: (work) => store.runTransaction((tx) => work({ ...tx,
      set: (collection, id, item) => rejectAudit && collection === 'audit_logs' ? Promise.reject(new Error('本地模拟审计写入失败')) : tx.set(collection, id, item)
    }))
  };
  const app = createApplication({
    store: guardedStore,
    bootstrapToken: 'media-metadata-local-bootstrap',
    clock: () => new Date('2026-09-24T08:00:00.000Z')
  });
  const dispatch = (action, payload = {}) => app.dispatch({ action, payload, requestId: `media-metadata-${action}` });
  await dispatch('admin.bootstrap', { bootstrapToken: 'media-metadata-local-bootstrap', username: 'metadata-owner', displayName: '本地核查员', password: 'local-password-12345' });
  const login = await dispatch('admin.login', { username: 'metadata-owner', password: 'local-password-12345' });
  const adminToken = login.data.token;
  const call = (action, payload = {}) => dispatch(action, { adminToken, ...payload });

  const asset = await call('admin.media.upsert', {
    name: '演示图片', type: 'image', source: 'demo', temporary: true,
    fileId: 'cloud://local-only/demo.png', mimeType: 'image/png', sizeBytes: 123
  });
  assert.equal(asset.ok, true, JSON.stringify(asset.error));
  const invalid = await call('admin.media.updateMetadata', {
    id: asset.data._id, name: '正式图片', source: 'demo', temporary: false,
    targetPlatforms: ['miniapp'], startAt: '', endAt: ''
  });
  assert.equal(invalid.error?.code, 'VALIDATION_ERROR', '演示素材不能通过改资料被标记成正式素材');
  const listed = await call('admin.media.list');
  assert.equal(listed.data.rows.find((row) => row._id === asset.data._id).temporary, true, '拒绝后原临时标记不变');
  const firstEdit = await call('admin.media.updateMetadata', {
    id: asset.data._id, metadataRevision: 0, name: '演示图片 A', source: 'demo', temporary: true,
    targetPlatforms: ['miniapp'], startAt: '', endAt: ''
  });
  assert.equal(firstEdit.ok, true, JSON.stringify(firstEdit.error));
  const legacyOverwrite = await call('admin.media.upsert', {
    id: asset.data._id, name: '旧入口不应覆盖', type: 'image', source: 'demo', temporary: true,
    fileId: asset.data.fileId, mimeType: 'image/png', sizeBytes: 123
  });
  assert.equal(legacyOverwrite.error?.code, 'MEDIA_METADATA_UPDATE_REQUIRED', '旧素材更新入口不能绕过资料版本核对');
  const afterLegacy = await call('admin.media.list');
  assert.equal(afterLegacy.data.rows.find((row) => row._id === asset.data._id).name, '演示图片 A', '旧入口被拒后保留新资料');
  const staleEdit = await call('admin.media.updateMetadata', {
    id: asset.data._id, metadataRevision: 0, name: '演示图片 B', source: 'demo', temporary: true,
    targetPlatforms: ['web'], startAt: '', endAt: ''
  });
  assert.equal(staleEdit.error?.code, 'MEDIA_METADATA_CONFLICT', '过期页面不能覆盖同事刚保存的素材资料');
  const afterStale = await call('admin.media.list');
  assert.equal(afterStale.data.rows.find((row) => row._id === asset.data._id).name, '演示图片 A');
  rejectAudit = true;
  const failedAuditEdit = await call('admin.media.updateMetadata', {
    id: asset.data._id, metadataRevision: 1, name: '不应留下的图片名', source: 'demo', temporary: true,
    targetPlatforms: ['web'], startAt: '', endAt: ''
  });
  assert.equal(failedAuditEdit.ok, false, '操作记录写入失败时不能报告资料保存成功');
  rejectAudit = false;
  const afterAuditFailure = await call('admin.media.list');
  assert.equal(afterAuditFailure.data.rows.find((row) => row._id === asset.data._id).name, '演示图片 A', '日志失败时资料也必须回滚');
  console.log('media-metadata: 来源与临时标记校验通过');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
