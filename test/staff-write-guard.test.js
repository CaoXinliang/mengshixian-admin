const assert=require('node:assert/strict');
const {createMemoryStore}=require('./support/receipt-flow-fixture.cjs');
const {createStaffWriteGuard}=require('../backend/cloudbase/functions/api/lib/staff-write-guard');
const {sha256}=require('../backend/cloudbase/functions/api/lib/security');
async function main() {
  const store=createMemoryStore(),clock=()=>new Date('2026-09-23T12:00:00Z');
  for(let i=0;i<101;i++) await store.set('admin_users',`user-${String(i).padStart(3,'0')}`,{username:`user${i}`,status:'active',salt:'local-boundary-fixture',passwordHash:'local-boundary-fixture',staffRole:i===100?'super_admin':'operator'});
  await store.set('admin_sessions','session',{adminId:'user-100',tokenHash:sha256('local-token'),status:'active',expiresAt:'2026-09-24T12:00:00Z'});
  const guard=createStaffWriteGuard({store,clock,getAdmin:async()=>({})});
  const payload={adminToken:'local-token'};
  await guard.run(payload,async scoped=>scoped.update('admin_users','user-000',{displayName:'分页测试'}));
  assert.equal((await store.getById('admin_users','user-000')).displayName,'分页测试');
  await assert.rejects(guard.run(payload,async scoped=>scoped.update('admin_users','user-100',{status:'disabled'})),e=>e.code==='STAFF_LAST_SUPER_ADMIN');
  assert.equal((await store.getById('admin_users','user-100')).status,'active');
  const transaction=store.runTransaction;
  store.runTransaction=work=>transaction(tx=>work({
    getById:tx.getById,update:tx.update,
    async set(name,id,data){if(name==='audit_logs') throw Error('local-audit-failure');return tx.set(name,id,data);}
  }));
  await assert.rejects(guard.run(payload,async (scoped,audit)=>{
    await scoped.update('admin_users','user-000',{displayName:'不应保存'});
    await audit({_id:'user-100'},'staff.update','admin_user','user-000');
  }),/local-audit-failure/);
  assert.equal((await store.getById('admin_users','user-000')).displayName,'分页测试');
  assert.equal((await store.list('audit_logs')).total,0);
  store.runTransaction=transaction;
  await assert.rejects(guard.run(payload,async scoped=>{
    await scoped.update('admin_users','user-000',{displayName:'退出后不能保存'});
    await store.update('admin_sessions','session',{status:'revoked'});
  }),e=>e.code==='ADMIN_SESSION_EXPIRED');
  assert.equal((await store.getById('admin_users','user-000')).displayName,'分页测试');
  console.log('Staff guard: page-two super counted, last-super denial, atomic audit rollback, session reread; document-only transaction');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
