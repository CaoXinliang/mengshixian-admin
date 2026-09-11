const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const api = fs.readFileSync(path.join(root, 'api-client.js'), 'utf8');
const config = fs.readFileSync(path.join(root, 'config.js'), 'utf8');

assert.match(config, /cloud1-d8gp843lt5454ada7/, '后台必须指向当前 CloudBase 环境');
assert.match(html, /name="uploadFile"\s+type="file"/, '素材表单必须提供人工选择文件入口');
assert.match(html, /上传并登记素材/, '素材表单必须明确人工上传动作');
assert.match(api, /async function uploadMediaFile/, '后台 API 客户端必须提供受控上传调用');
assert.match(api, /admin\.media\.upload/, '后台上传必须走管理员云函数动作');
assert.match(app, /api\.uploadMediaFile\(selectedFile, type\)/, '提交素材时必须先通过后台上传文件');
assert.match(app, /admin\.media\.createVersion|admin\.media\.upsert/, '上传成功后必须登记媒体记录');
assert.match(html, /id="productMediaForm"/, '后台必须提供商品媒体人工关联表单');
assert.match(html, /保存商品媒体关联/, '商品媒体表单必须明确关联保存动作');
assert.match(app, /admin\.productMedia\.upsert/, '商品媒体关联必须走后台云函数动作');
assert.match(app, /admin\.productMedia\.list/, '后台必须加载商品媒体关联列表');
console.log('admin media upload UI contract: passed');
