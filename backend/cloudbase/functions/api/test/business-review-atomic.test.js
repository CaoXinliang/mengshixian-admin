const assert = require('node:assert/strict');
const { createApplication } = require('../app');
const { createMemoryStore } = require('../../../../../test/support/receipt-flow-fixture.cjs');

async function main() {
  const base = createMemoryStore();
  let rejectAudit = false;
  let customerOpenId = 'business-review-local-user';
  const store = {
    ...base,
    create: (collection, item) => rejectAudit && collection === 'audit_logs' ? Promise.reject(new Error('本地模拟操作记录失败')) : base.create(collection, item),
    runTransaction: (work) => base.runTransaction((tx) => work({ ...tx,
      set: (collection, id, item) => rejectAudit && collection === 'audit_logs' ? Promise.reject(new Error('本地模拟操作记录失败')) : tx.set(collection, id, item)
    }))
  };
  const app = createApplication({ store, getIdentity: () => ({ OPENID: customerOpenId }),
    bootstrapToken: 'business-review-local-bootstrap', piiEncryptionKey: 'business-review-local-encryption-key',
    mediaUrlResolver: async (ids) => Object.fromEntries(ids.map((fileId, index) => [fileId, `https://local-preview.test/document-${index + 1}.png`])) });
  const dispatch = (action, payload = {}) => app.dispatch({ action, payload, requestId: `business-review-${action}` });
  await dispatch('admin.bootstrap', { bootstrapToken: 'business-review-local-bootstrap', username: 'business-owner', displayName: '本地审核员', password: 'local-password-12345' });
  const login = await dispatch('admin.login', { username: 'business-owner', password: 'local-password-12345' });
  const adminToken = login.data.token;
  const call = (action, payload = {}) => dispatch(action, { adminToken, ...payload });
  const applied = await dispatch('auth.applyBusiness', { companyName: '本地审核企业', storeName: '本地门店', storeAddress: '仅本地测试',
    mainBusinessType: 'restaurant', unifiedCode: '123456789012345678', storefrontMediaId: 'local://review/store',
    businessLicenseMediaId: 'local://review/license', contactName: '本地联系人', contactPhone: '13900139000' });
  assert.equal(applied.ok, true, JSON.stringify(applied.error));
  const id = applied.data.application._id;
  const firstView = (await call('admin.businessApplications.list')).data.rows.find((row) => row._id === id);
  assert.equal((await dispatch('admin.businessApplications.reviewDetail', { id })).ok, false, '未登录不能预览企业证照');
  const staff = await call('admin.staff.create', { username: 'business-review-operator', displayName: '本地运营', phone: '13800138007', role: 'operator', password: 'local-operator-password' });
  assert.equal(staff.ok, true, JSON.stringify(staff.error));
  const operatorLogin = await dispatch('admin.login', { username: 'business-review-operator', password: 'local-operator-password' });
  const operatorDetail = await dispatch('admin.businessApplications.reviewDetail', { id, adminToken: operatorLogin.data.token });
  assert.equal(operatorDetail.error?.code, 'ADMIN_FORBIDDEN', '没有企业审核权限的运营不能读取门头与营业执照');
  const detail = await call('admin.businessApplications.reviewDetail', { id });
  assert.equal(detail.ok, true, JSON.stringify(detail.error));
  assert.equal(detail.data.reviewToken, firstView.reviewToken);
  assert.equal(detail.data.storefrontPreviewUrl, 'https://local-preview.test/document-1.png');
  assert.equal(detail.data.licensePreviewUrl, 'https://local-preview.test/document-2.png');
  assert.equal(Object.hasOwn(detail.data, 'businessLicenseMediaId'), false, '页面无需收到证照云文件编号');
  assert.equal(firstView.storeName, '本地门店');
  assert.equal(firstView.storeAddress, '仅本地测试');
  assert.equal(Object.hasOwn(firstView, 'contactPhoneCiphertext'), false, '审核列表不能泄露联系人电话密文');
  assert.equal((await call('admin.businessApplications.review', { id, decision: 'approved' })).ok, false, '缺核对凭据不能审核');
  const changed = await dispatch('auth.applyBusiness', { companyName: '本地审核企业（资料已更新）', storeName: '更新后门店', storeAddress: '仅本地更新',
    mainBusinessType: 'restaurant', unifiedCode: '123456789012345678', storefrontMediaId: 'local://review/store-new',
    businessLicenseMediaId: 'local://review/license-new', contactName: '更新后联系人', contactPhone: '13900139000' });
  assert.equal(changed.ok, true, JSON.stringify(changed.error));
  const staleReview = await call('admin.businessApplications.review', { id, decision: 'approved', reviewToken: firstView.reviewToken });
  assert.equal(staleReview.error?.code, 'BUSINESS_APPLICATION_CHANGED', '旧页面不能批准申请人更新后的资料');
  assert.equal((await dispatch('auth.me')).data.user.userType, 'c', '过期核对被拒后客户仍是个人');
  const currentView = (await call('admin.businessApplications.list')).data.rows.find((row) => row._id === id);
  assert.ok(currentView.reviewToken && currentView.reviewToken !== firstView.reviewToken, '资料变化后应提供新的核对凭据');

  rejectAudit = true;
  const failed = await call('admin.businessApplications.review', { id, decision: 'approved', priceLevel: 'b_standard', reviewToken: currentView.reviewToken });
  assert.equal(failed.ok, false, '操作记录写入失败时审核不得报告成功');
  const afterFailure = await call('admin.businessApplications.list');
  assert.equal(afterFailure.data.rows.find((row) => row._id === id).status, 'pending', '审核失败后申请仍须待审核');
  const customerAfterFailure = await dispatch('auth.me');
  assert.equal(customerAfterFailure.data.user.userType, 'c', '审核失败后顾客不能提前变成企业身份');
  const organizationsAfterFailure = await call('admin.users.organizations');
  assert.equal(organizationsAfterFailure.data.rows.length, 0, '审核失败后不能留下孤立企业资料');

  rejectAudit = false;
  const approved = await call('admin.businessApplications.review', { id, decision: 'approved', priceLevel: 'b_standard', reviewToken: currentView.reviewToken });
  assert.equal(approved.ok, true, JSON.stringify(approved.error));
  assert.equal((await dispatch('auth.me')).data.user.userType, 'b');
  assert.equal((await call('admin.businessApplications.list')).data.rows.find((row) => row._id === id).status, 'approved');
  assert.equal((await call('admin.businessApplications.review', { id, decision: 'approved', reviewToken: currentView.reviewToken })).error?.code,
    'BUSINESS_APPLICATION_REVIEWED', '同一份申请不能重复批准');

  customerOpenId = 'business-review-local-existing-organization';
  const sameCompany = await dispatch('auth.applyBusiness', { companyName: '本地审核企业', storeName: '第二门店', storeAddress: '仅本地测试',
    mainBusinessType: 'restaurant', unifiedCode: '123456789012345678', storefrontMediaId: 'local://review/store-3',
    businessLicenseMediaId: 'local://review/license-3', contactName: '第二联系人', contactPhone: '13900139002' });
  assert.equal(sameCompany.ok, true, JSON.stringify(sameCompany.error));
  const sameToken = (await call('admin.businessApplications.list')).data.rows.find((row) => row._id === sameCompany.data.application._id).reviewToken;
  const reused = await call('admin.businessApplications.review', { id: sameCompany.data.application._id, decision: 'approved', reviewToken: sameToken });
  assert.equal(reused.ok, true, JSON.stringify(reused.error));
  assert.equal(reused.data.organization._id, approved.data.organization._id, '同一企业再次审核须沿用原企业资料');
  assert.equal((await call('admin.users.organizations')).data.rows.length, 1, '不得建立重复企业档案');

  customerOpenId = 'business-review-local-user-rejected';
  const second = await dispatch('auth.applyBusiness', { companyName: '本地驳回企业', storeName: '另一门店', storeAddress: '仅本地测试',
    mainBusinessType: 'restaurant', unifiedCode: '876543210987654321', storefrontMediaId: 'local://review/store-2',
    businessLicenseMediaId: 'local://review/license-2', contactName: '另一联系人', contactPhone: '13900139001' });
  assert.equal(second.ok, true, JSON.stringify(second.error));
  const rejectedId = second.data.application._id;
  const rejectedToken = (await call('admin.businessApplications.list')).data.rows.find((row) => row._id === rejectedId).reviewToken;
  rejectAudit = true;
  assert.equal((await call('admin.businessApplications.review', { id: rejectedId, decision: 'rejected', reviewToken: rejectedToken })).ok, false);
  assert.equal((await call('admin.businessApplications.list')).data.rows.find((row) => row._id === rejectedId).status,
    'pending', '驳回操作记录失败时申请须仍待审核');
  assert.equal((await dispatch('auth.me')).data.user.businessStatus, 'pending', '驳回失败不能提前改变顾客状态');
  rejectAudit = false;
  assert.equal((await call('admin.businessApplications.review', { id: rejectedId, decision: 'rejected', reviewToken: rejectedToken })).ok, true);
  assert.equal((await dispatch('auth.me')).data.user.businessStatus, 'rejected');
  console.log('Business approval/rejection roll back on audit failure; successful retry and duplicate guard passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
