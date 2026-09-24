const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const context = { window: {} };
vm.runInNewContext(read('admin-page-registry.js'), context);
const registry = context.window.MengshixianAdminPages;

assert.deepEqual(Array.from(registry.groups, (group) => group.label), [
  '工作台', '商品中心', '订单中心', '库存配送', '客户中心', '内容运营', '营销中心', '系统管理'
]);
assert.equal(Object.keys(registry.pages).length, 22, '22 个真实业务页面必须继续独立存在');

for (const page of Object.values(registry.pages)) {
  const html = read(page.href);
  assert.match(html, new RegExp(`<script>window.PAGE_NAME = '${page.id}';</script>`), `${page.href} 必须声明页面身份`);
  assert.match(html, /id="adminSidebar"/, `${page.href} 必须使用共享侧栏`);
  assert.match(html, /id="adminHeader"/, `${page.href} 必须使用共享页头`);
  if (page.id === 'productReview') {
    assert.match(html, /admin-page-registry\.js[\s\S]*admin-shell\.js[\s\S]*admin-product-review\.js/, `${page.href} 必须加载独立核对模块`);
  } else if (page.id === 'productWorkflow') {
    assert.match(html, /admin-page-registry\.js[\s\S]*admin-shell\.js[\s\S]*admin-product-data\.js[\s\S]*admin-product-workflow\.js/, `${page.href} 必须按顺序加载商品业务模块`);
  } else {
    assert.match(html, /admin-page-registry\.js[\s\S]*admin-forms\.js[\s\S]*admin-shell\.js[\s\S]*admin-tables\.js[\s\S]*admin-page-summary\.js[\s\S]*app\.js/, `${page.href} 必须按顺序加载共享模块`);
  }
  assert.equal((html.match(/<nav id="mainNav"/g) || []).length, 0, `${page.href} 不得重复维护侧栏导航`);
  if (page.id === 'access') {
    assert.match(html, /id="staffPage"[\s\S]*admin-staff-page\.js[\s\S]*app\.js/, '账号页应使用独立工作人员模块');
    assert.doesNotMatch(html, /id="adminUserForm"|name="roleIds"/, '账号页不得恢复旧角色编号表单');
  } else if (!['productWorkflow', 'productReview'].includes(page.id)) {
    assert.match(html, /<div class="hidden-forms"><\/div>/, `${page.href} 必须从共享模块装载通用编辑表单`);
  }
}

assert.match(read('admin-shell.js'), /aria-current="page"/, '当前页面必须被标记');
assert.match(read('admin-overview.js'), /href="\$\{task\.href\}"/, '工作台待办必须进入真实业务页面');
assert.match(read('styles.css'), /button:focus-visible/, '键盘操作必须保留可见焦点');
console.log('admin multi-page navigation contract: passed');
