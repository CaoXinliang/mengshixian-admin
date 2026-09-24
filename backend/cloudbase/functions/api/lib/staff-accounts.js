const { fail } = require('./response');
const { hashPassword, sha256, encryptText, randomId, safeEqual, verifyPassword } = require('./security');
const { string, maskedPhone, cleanAdmin, nowIso } = require('./api-values');
const { STAFF_PERMISSIONS, staffPermissions } = require('./staff-policy');
const {collectPermissions,ROLE_PERMISSIONS}=require('./permissions');

function createStaffAccounts({store:baseStore, getAdmin, clock, piiEncryptionKey,bootstrapToken=''}) {
  async function create(payload, store=baseStore) {
    const {admin} = await getAdmin(payload, '*');
    if (payload.permissions !== undefined || payload.roleIds !== undefined) fail('STAFF_PERMISSIONS_FORBIDDEN', '请选择工作人员角色，不能直接指定权限。');
    if (payload.phoneVerified === true || payload.phoneVerifiedAt || (payload.phoneVerificationStatus && payload.phoneVerificationStatus !== 'unverified')) {
      fail('STAFF_VERIFICATION_FORBIDDEN', '手机号尚未经过真实验证，不能设为已验证。');
    }
    const username = string(payload.username, '登录账号', {required:true,max:40});
    const displayName = string(payload.displayName, '工作人员名称', {required:true,max:40});
    const phone = string(payload.phone, '手机号', {required:true,max:20});
    if (!/^1\d{10}$/.test(phone)) fail('VALIDATION_ERROR', '请填写11位手机号。');
    const role = string(payload.role, '工作人员角色', {required:true,max:30});
    if (!Object.hasOwn(STAFF_PERMISSIONS, role)) fail('VALIDATION_ERROR', '工作人员角色只支持超级管理员和运营。');
    const password = string(payload.password, '初始密码', {required:true,max:128});
    if (password.length < 12) fail('VALIDATION_ERROR', '初始密码至少需要12位。');
    const status = payload.status || 'active';
    if (!['active','disabled'].includes(status)) fail('VALIDATION_ERROR', '账号状态不正确。');
    if (!piiEncryptionKey || String(piiEncryptionKey).length < 16) fail('STAFF_PHONE_STORAGE_UNAVAILABLE', '手机号安全存储尚未配置，暂不能创建工作人员。');
    if (await store.findOne('admin_users', {username})) fail('STAFF_USERNAME_EXISTS', '登录账号已存在，请使用其他账号。');
    const timestamp = clock().toISOString();
    const id = `staff_${sha256(username).slice(0,40)}`;
    const record = {
      username, displayName, staffRole:role, roleIds:[], status,
      phoneCiphertext:encryptText(phone, piiEncryptionKey), phoneMasked:maskedPhone(phone),
      phoneVerificationStatus:'unverified', phoneVerifiedAt:null,
      ...hashPassword(password), createdAt:timestamp, updatedAt:timestamp, createdBy:admin._id
    };
    await store.runTransaction(async tx => {
      if (await tx.getById('admin_users', id)) fail('STAFF_USERNAME_EXISTS', '登录账号已存在，请使用其他账号。');
      await tx.set('admin_users', id, record);
      await tx.set('audit_logs', randomId('audit'), {
        actorType:'admin', actorId:admin._id, action:'staff.create', targetType:'admin_user', targetId:id,
        details:{role,status,phoneVerificationStatus:'unverified'}, createdAt:timestamp
      });
    });
    return cleanAdmin({...record,_id:id}, staffPermissions(role));
  }
  async function update(payload,store=baseStore) {
    const {admin}=await getAdmin(payload,'*');
    if (payload.permissions!==undefined||payload.roleIds!==undefined) fail('STAFF_PERMISSIONS_FORBIDDEN','请选择工作人员角色，不能直接指定权限。');
    if (payload.phoneVerified!==undefined||payload.phoneVerifiedAt!==undefined||payload.phoneVerificationStatus!==undefined) fail('STAFF_VERIFICATION_FORBIDDEN','验证状态只能由真实验证流程维护。');
    const id=string(payload.id,'工作人员账号',{required:true,max:80});
    const existing=await store.getById('admin_users',id);
    if (!existing) fail('ADMIN_USER_NOT_FOUND','工作人员账号不存在。');
    const roles=(await store.list('admin_roles',{pageSize:10000})).rows;
    const beforeRole=existing.staffRole||(collectPermissions(existing,roles).includes('*')?'super_admin':'legacy');
    const patch={updatedAt:clock().toISOString()};
    if (payload.username!==undefined && payload.username!==existing.username) fail('STAFF_USERNAME_IMMUTABLE','登录账号不能直接修改。');
    if (payload.role!==undefined) {
      if (!Object.hasOwn(STAFF_PERMISSIONS,payload.role)) fail('VALIDATION_ERROR','只支持超级管理员和运营。');
      // Only explicit role selection converts a legacy account; name/phone edits do not.
      Object.assign(patch,{staffRole:payload.role,roleIds:[],permissions:[]});
    }
    if (payload.status!==undefined) {
      if (!['active','disabled'].includes(payload.status)) fail('VALIDATION_ERROR','账号状态不正确。');
      patch.status=payload.status;
      if (payload.status==='disabled') patch.authVersion=(existing.authVersion||0)+1;
    }
    if (payload.displayName!==undefined) patch.displayName=string(payload.displayName,'工作人员名称',{required:true,max:40});
    if (payload.phone!==undefined) {
      const phone=string(payload.phone,'手机号',{required:true,max:20});
      if (!/^1\d{10}$/.test(phone)) fail('VALIDATION_ERROR','请填写11位手机号。');
      if (!piiEncryptionKey||String(piiEncryptionKey).length<16) fail('STAFF_PHONE_STORAGE_UNAVAILABLE','手机号安全存储尚未配置。');
      Object.assign(patch,{phoneCiphertext:encryptText(phone,piiEncryptionKey),phoneMasked:maskedPhone(phone),phoneVerificationStatus:'unverified',phoneVerifiedAt:null});
    }
    // Password reset requires separate session invalidation and is not silently supported here.
    if (payload.password!==undefined) fail('STAFF_PASSWORD_RESET_UNAVAILABLE','请使用现有修改本人密码功能；管理员重置密码尚未开放。');
    await store.update('admin_users',id,patch);
    await store.create('audit_logs',{actorType:'admin',actorId:admin._id,action:'staff.update',targetType:'admin_user',targetId:id,
      details:{before:{role:beforeRole,status:existing.status,roleIds:existing.roleIds||[]},after:{role:patch.staffRole||beforeRole,status:patch.status||existing.status},phoneChanged:payload.phone!==undefined},createdAt:patch.updatedAt});
    const updated={...existing,...patch};
    return cleanAdmin(updated,collectPermissions(updated,roles));
  }
  async function resetPassword(payload,store=baseStore) {
    const {admin}=await getAdmin(payload,'*');
    const id=string(payload.id,'工作人员账号',{required:true,max:80});
    const existing=await store.getById('admin_users',id);
    if (!existing) fail('ADMIN_USER_NOT_FOUND','工作人员账号不存在。');
    const password=string(payload.newPassword,'新密码',{required:true,max:128});
    if (password.length<12) fail('VALIDATION_ERROR','新密码至少需要12位。');
    const timestamp=clock().toISOString();
    await store.update('admin_users',id,{...hashPassword(password),authVersion:(existing.authVersion||0)+1,passwordChangedAt:timestamp,updatedAt:timestamp});
    await store.create('audit_logs',{actorType:'admin',actorId:admin._id,action:'staff.password.reset',targetType:'admin_user',targetId:id,details:{sessionsInvalidated:true},createdAt:timestamp});
    return {id,passwordChanged:true,reLoginRequired:true};
  }
  async function bootstrap(payload, store, audit) {
    if (!bootstrapToken || !safeEqual(payload.bootstrapToken, bootstrapToken)) fail('BOOTSTRAP_FORBIDDEN', '初始化令牌无效。');
    const existing = await store.list('admin_users', { page: 1, pageSize: 1 });
    if (existing.total) fail('BOOTSTRAP_ALREADY_COMPLETED', '已有管理员账号，禁止重复初始化。');
    const username = string(payload.username, '管理员账号', { required: true, max: 40 });
    const password = string(payload.password, '管理员密码', { required: true, max: 128 });
    if (password.length < 12) fail('VALIDATION_ERROR', '管理员密码至少需要 12 位。');
    const timestamp = nowIso(clock);
    const role = await store.create('admin_roles', { code: 'super_admin', name: '超级管理员', permissions: ROLE_PERMISSIONS.super_admin, status: 'active', createdAt: timestamp, updatedAt: timestamp });
    const secret = hashPassword(password);
    const admin = await store.create('admin_users', { username, displayName: string(payload.displayName || username, '管理员显示名', { max: 40 }), roleIds: [role._id], status: 'active', ...secret, createdAt: timestamp, updatedAt: timestamp });
    await audit(admin, 'admin.bootstrap', 'admin_user', admin._id, { username });
    return { admin: cleanAdmin(admin, ROLE_PERMISSIONS.super_admin) };
  }

  async function changeOwnPassword(payload, store, audit) {
    const { admin } = await getAdmin(payload);
    const currentPassword = string(payload.currentPassword, '当前密码', { required: true, max: 128 });
    const newPassword = string(payload.newPassword, '新密码', { required: true, max: 128 });
    if (newPassword.length < 12) fail('VALIDATION_ERROR', '新密码至少需要 12 位。');
    if (!verifyPassword(currentPassword, admin)) fail('ADMIN_PASSWORD_INVALID', '当前密码不正确。');
    if (verifyPassword(newPassword, admin)) fail('VALIDATION_ERROR', '新密码不能与当前密码相同。');
    // Versioned sessions invalidate every device, not just the first page of sessions.
    const timestamp = nowIso(clock);
    await store.update('admin_users', admin._id, { ...hashPassword(newPassword), authVersion:(admin.authVersion||0)+1, passwordChangedAt: timestamp, updatedAt: timestamp });
    await audit(admin, 'admin.password.change', 'admin_user', admin._id, {});
    return { passwordChanged: true, reLoginRequired: true };
  }

  return {create,update,resetPassword,bootstrap,changeOwnPassword};
}
module.exports = {createStaffAccounts};
