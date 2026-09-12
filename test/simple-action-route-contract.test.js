const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const adminRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(adminRoot, '..');
const simpleSource = fs.readFileSync(path.join(adminRoot, 'simple.js'), 'utf8');
const backendPath = [
  path.join(projectRoot, 'backend', 'cloudbase', 'functions', 'api', 'app.js'),
  path.join(adminRoot, 'backend', 'cloudbase', 'functions', 'api', 'app.js')
].find((candidate) => fs.existsSync(candidate));
assert.ok(backendPath, '必须能在总项目或独立后台仓库中定位 CloudBase API');
const backendSource = fs.readFileSync(backendPath, 'utf8');

const handlerBlock = backendSource.match(/const handlers = \{([\s\S]*?)\r?\n  \};\r?\n\r?\n  async function dispatch/);
assert.ok(handlerBlock, '必须能定位后端 handlers 路由表');

const backendActions = new Set(
  [...handlerBlock[1].matchAll(/^\s*(?:'([^']+)'|([A-Za-z][A-Za-z0-9]*))\s*:/gm)]
    .map((match) => match[1] || match[2])
);

const calledActions = new Set();
for (const match of simpleSource.matchAll(/\b(?:list|optionalList)\(\s*'([^']+)'/g)) {
  calledActions.add(match[1]);
}
for (const match of simpleSource.matchAll(/\bapi\.call\(([^,\n]+)/g)) {
  for (const literal of match[1].matchAll(/'([^']+)'/g)) calledActions.add(literal[1]);
}

const adminActions = [...calledActions].filter((action) => action === 'health' || action.startsWith('admin.')).sort();
const missingActions = adminActions.filter((action) => !backendActions.has(action));

assert.ok(adminActions.length > 0, '必须识别到日常后台的真实 API 调用');
assert.deepEqual(
  missingActions,
  [],
  `日常后台存在后端未注册的 action：${missingActions.join(', ')}`
);

console.log(`simple admin action route contract: passed (${adminActions.length} actions)`);
