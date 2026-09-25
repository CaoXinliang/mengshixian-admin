const assert=require('node:assert/strict');
const {createReceiptFixture}=require('./support/receipt-flow-fixture.cjs');
async function main(){
  const f=await createReceiptFixture();
  const input={username:'business-operator',displayName:'日常运营测试',phone:'13800138000',role:'operator',password:'local-business-password'};
  const staff=await f.call('admin.staff.create',input);
  const {token}=await f.call('admin.login',{username:input.username,password:input.password});
  const operator=(action,payload={})=>f.call(action,{...payload,adminToken:token});
  const readiness=await operator('admin.readiness');
  assert.equal(typeof readiness.counts.activeWarehouses,'number','运营应能查看只读开店检查，但不能借此修改配置');
  const category=await operator('admin.categories.upsert',{name:'本地权限测试分类',status:'draft'});
  const product=await operator('admin.products.upsert',{name:'本地权限测试商品',categoryId:category._id,spuCode:'LOCAL-STAFF-TEST',status:'draft'});
  assert.equal(product.status,'draft');
  await assert.rejects(operator('admin.products.upsert',{id:product._id,name:product.name,categoryId:category._id,status:'on_sale'}),e=>e.code==='CATALOG_REVIEW_REQUIRED');
  const media=await operator('admin.media.upsert',{name:'本地权限测试素材',type:'image',fileId:'cloud://local-memory/permission.png',source:'demo',temporary:true,enabled:false});
  assert.ok((await operator('admin.media.list',{pageSize:100})).rows.some(r=>r._id===media._id));
  const revisedMedia=await operator('admin.media.updateMetadata',{id:media._id,metadataRevision:media.metadataRevision,name:'本地权限测试素材（已核对）',source:'demo',temporary:true,targetPlatforms:['miniapp']});
  assert.equal(revisedMedia.fileId,media.fileId,'运营改资料不得更换文件');
  assert.equal(revisedMedia.enabled,false,'运营改资料不得暗中启用素材');
  assert.ok((await operator('admin.orders.list')).rows.some(r=>r._id===f.order._id));
  const receipt={orderId:f.order._id,amountCent:3000,receivedAt:'2026-09-23T11:00:00+08:00',method:'bank_transfer',note:'仅本地权限测试',idempotencyKey:'operator-receipt-30'};
  const first=await operator('admin.orders.receipts.record',receipt);
  assert.equal(first.receivedAmountCent,3000);
  assert.equal(first.outstandingAmountCent,7000);
  assert.equal((await operator('admin.orders.receipts.record',receipt)).idempotent,true);
  await operator('admin.orders.transition',{id:f.order._id,status:'picking'});
  const after=await operator('admin.orders.receipts.list',{orderId:f.order._id});
  assert.equal(after.orderStatus,'picking');
  assert.equal(after.receivedAmountCent,3000);
  assert.equal(after.rows.length,1);
  for(const action of ['admin.refunds.review','admin.staff.create','admin.staff.update','admin.staff.resetPassword','admin.roles.upsert','admin.adminUsers.upsert','admin.warehouses.upsert','admin.deliveryAreas.upsert']) {
    await assert.rejects(operator(action,{id:staff.id,role:'super_admin',decision:'approved'}),e=>e.code==='ADMIN_FORBIDDEN',action);
  }
  const logs=(await f.call('admin.audit.list',{pageSize:100})).rows;
  const receiptLogs=logs.filter(r=>r.action==='orders.receipt.record'&&r.actorId===staff.id);
  assert.equal(receiptLogs.length,1);
  assert.equal(receiptLogs[0].targetId,f.order._id);
  assert.ok(receiptLogs[0].createdAt);
  assert.ok(logs.some(r=>r.action==='media.upsert'&&r.actorId===staff.id&&r.targetId===media._id));
  console.log('Operator actual API: product draft, publication guard, media registration, order picking, partial receipt/idempotency/audit; refund/staff/delivery writes denied');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
