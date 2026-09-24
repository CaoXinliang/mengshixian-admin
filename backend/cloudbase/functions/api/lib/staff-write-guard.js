const {fail} = require('./response');
const {collectPermissions,hasPermission} = require('./permissions');
const {randomId,sha256} = require('./security');

// Uses an existing security collection, but a reserved ID distinct from login limiters.
const GUARD_COLLECTION = 'admin_login_limits';
const GUARD_ID = 'staff_security_v1';
async function readAll(store, collection) {
  const records = [];
  for (let page=1; page<=100; page++) {
    const result = await store.list(collection,{page,pageSize:100,orderBy:[{field:'_id',direction:'asc'}]});
    records.push(...result.rows);
    if (records.length >= result.total) return records;
    if (!result.rows.length) break;
  }
  fail('STAFF_DIRECTORY_LIMIT','账号目录未完整读取，已停止修改，请联系管理员检查。');
}
function stagingStore(users,roles) {
  const tables = {admin_users:new Map(users.map(r=>[r._id,{...r}])),admin_roles:new Map(roles.map(r=>[r._id,{...r}])),audit_logs:new Map()};
  const writes = [];
  const table = name => {
    if (!tables[name]) fail('STAFF_WRITE_SCOPE','账号事务不允许修改此类资料。');
    return tables[name];
  };
  const scoped = {
    async list(name,{where={},page=1,pageSize=20}={}) {
      const rows=[...table(name).values()].filter(r=>Object.entries(where).every(([k,v])=>r[k]===v));
      return {rows:rows.slice((page-1)*pageSize,page*pageSize),total:rows.length,page,pageSize};
    },
    async findOne(name,where) {return (await scoped.list(name,{where,pageSize:1})).rows[0]||null;},
    async getById(name,id) {return table(name).get(id)||null;},
    async set(name,id,data) {
      const row={...data,_id:id}; table(name).set(id,row); writes.push({method:'set',name,id,data});return row;
    },
    async update(name,id,data) {
      if (!table(name).has(id)) fail('ADMIN_USER_NOT_FOUND','账号或角色不存在。');
      const row={...table(name).get(id),...data,_id:id};table(name).set(id,row);writes.push({method:'update',name,id,data});return row;
    },
    async create(name,data) {return scoped.set(name,randomId(name),data);},
    async runTransaction(work) {return work(scoped);}
  };
  return {scoped,writes,tables};
}
function createStaffWriteGuard({store,clock,getAdmin}) {
  async function run(payload,work,{bootstrap=false,permission='*'}={}) {
    if (!bootstrap) await getAdmin(payload,permission);
    for (let attempt=0;attempt<4;attempt++) {
      const guard=await store.getById(GUARD_COLLECTION,GUARD_ID);
      const revision=guard?.revision||0;
      const [users,roles]=await Promise.all([readAll(store,'admin_users'),readAll(store,'admin_roles')]);
      const session=bootstrap?null:await store.findOne('admin_sessions',{tokenHash:sha256(payload.adminToken),status:'active'});
      const stage=stagingStore(users,roles);
      const audit=(admin,action,targetType,targetId,details={})=>stage.scoped.create('audit_logs',{
        actorType:admin?'admin':'system',actorId:admin?admin._id:'',action,targetType,targetId,details,createdAt:clock().toISOString()
      });
      const result=await work(stage.scoped,audit);
      const finalRoles=[...stage.tables.admin_roles.values()];
      const activeSupers=[...stage.tables.admin_users.values()].filter(u=>u.status==='active'&&u.username&&u.passwordHash&&u.salt&&collectPermissions(u,finalRoles).includes('*'));
      if (!activeSupers.length) fail('STAFF_LAST_SUPER_ADMIN','必须保留至少一位可用的超级管理员。');
      try {
        await store.runTransaction(async tx=>{
          const current=await tx.getById(GUARD_COLLECTION,GUARD_ID);
          if ((current?.revision||0)!==revision) fail('STAFF_RETRY','账号资料已变化，请重新检查。');
          if (!bootstrap) {
            const liveSession=session&&await tx.getById('admin_sessions',session._id);
            if (!liveSession||liveSession.status!=='active'||new Date(liveSession.expiresAt).getTime()<=clock().getTime()) fail('ADMIN_SESSION_EXPIRED','登录已失效，请重新登录。');
            const actor=await tx.getById('admin_users',liveSession.adminId);
            if (!actor||actor.status!=='active'||(permission&&!hasPermission(collectPermissions(actor,roles),permission))) fail('ADMIN_FORBIDDEN','当前账号不能执行此操作。');
            if ((liveSession.authVersion||0)!==(actor.authVersion||0)) fail('ADMIN_SESSION_EXPIRED','密码或账号已变更，请重新登录。');
          }
          for (const write of stage.writes) await tx[write.method](write.name,write.id,write.data);
          await tx.set(GUARD_COLLECTION,GUARD_ID,{revision:revision+1,updatedAt:clock().toISOString()});
        });
        return result;
      } catch(error) {
        if (error.code!=='STAFF_RETRY') throw error;
      }
    }
    fail('STAFF_CONFLICT','其他管理员正在修改账号，请刷新后重试。');
  }
  return {run};
}
module.exports={createStaffWriteGuard};
