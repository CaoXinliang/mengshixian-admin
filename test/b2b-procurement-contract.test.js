const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'simple.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'simple.js'), 'utf8');

assert.equal([...html.matchAll(/<button data-view="(dashboard|orders|products|inventory|refunds|customers|delivery|marketing|settings)"[^>]*>/g)].length, 9, 'B2B operations must stay inside the existing nine primary entries');
for (const id of ['creditAccountList', 'receivableList', 'statementList', 'adminInquiryList']) assert(html.includes(`id="${id}"`), `admin B2B workbench missing ${id}`);
for (const action of ['admin.creditAccounts.list', 'admin.receivables.list', 'admin.statements.list', 'admin.inquiries.list', 'admin.inquiries.get']) assert(source.includes(`'${action}'`), `admin B2B loader missing ${action}`);
assert.match(source, /api\.call\('admin\.creditAccounts\.upsert',[\s\S]*creditLimitCent:[\s\S]*source, temporary, status/, 'credit editor must submit amount, provenance, temporary flag and status');
assert.match(source, /status === 'active' && \(temporary \|\| source !== 'client'\)/, 'AI or temporary credit must not be activated');
assert.match(source, /确认启用[\s\S]*企业授信额度/, 'formal credit activation must require confirmation');
assert.match(source, /影响企业下单可用额度[\s\S]*不会因后续停用自动撤销/, 'credit activation confirmation must explain durable order and receivable impact');
assert.match(source, /api\.call\('admin\.inquiries\.quote',[\s\S]*validUntil:[\s\S]*source, temporary/, 'quote versions must include items, validity and provenance');
assert.match(source, /releaseMode === 'active' && \(temporary \|\| source !== 'client'\)/, 'AI or temporary quotes must not be formally published');
assert.match(source, /确认发布正式报价/, 'formal quote publication must require confirmation');
assert.match(source, /quotes\.map\(quote =>[\s\S]*quote\.version/, 'inquiry details must display all quote versions');
assert.match(source, /api\.call\('admin\.inquiries\.transition',[\s\S]*idempotencyKey:/, 'inquiry status changes must be explicit and idempotent');
assert.match(source, /api\.call\('admin\.receivables\.settle', \{ statementId:[\s\S]*amountCent, idempotencyKey:[\s\S]*note:/, 'partial settlement must pin statement, amount, idempotency key and note');
assert.match(source, /确认登记回款[\s\S]*写入应收流水/, 'receivable settlement must require a dangerous-action confirmation');
assert.match(source, /loadErrors\['admin\.creditAccounts\.list'\]/, 'permission or loading errors must be visible in the finance workbench');

console.log('admin B2B procurement contract: passed');
