const { fail } = require('./response');
const { sha256 } = require('./security');
const { collectPageMatches } = require('./collection-read');
function customerLabel(row) {
  return `${row.nickname || row.name || (row.userType === 'b' ? '企业顾客' : '个人顾客')}${row.phoneMasked ? ` · ${row.phoneMasked}` : ''} · 客户号 KH-${sha256(row._id).slice(0, 8).toUpperCase()}`;
}

function createPricingTargets(store) {
  async function list(payload = {}) {
    const scope = payload.scopeType || 'customer_type';
    const page = Math.max(1, Number(payload.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(payload.pageSize) || 20));
    if (scope === 'customer_type') return { rows: [{ _id: 'c', label: '个人顾客（C 端）' }, { _id: 'b', label: '企业顾客（B 端）' }], total: 2 };
    if (!['organization', 'user', 'level'].includes(scope)) fail('VALIDATION_ERROR', '请选择有效的价格适用范围。');
    if (scope === 'level') {
      const users = await collectPageMatches(store, 'users', {}, (row) => row.status === 'active' && row.priceLevel);
      const levels = [...new Set(users.map((row) => row.priceLevel))].sort();
      return { rows: levels.slice((page - 1) * pageSize, page * pageSize).map((level) => ({ _id: level, label: `价格等级：${level}` })), total: levels.length };
    }
    const result = await store.list(scope === 'organization' ? 'customer_organizations' : 'users', { where: { status: 'active' }, page, pageSize });
    return { ...result, rows: result.rows.map((row) => ({ _id: row._id, label: scope === 'organization'
      ? `${row.name || '未命名企业'}${row.unifiedCode ? ` · ${row.unifiedCode}` : ''}`
      : customerLabel(row) })) };
  }
  async function validate(scope, id) {
    if (scope === 'public') { if (id) fail('VALIDATION_ERROR', '公开价格不应指定单独客户。'); return; }
    if (scope === 'customer_type') { if (!['b', 'c'].includes(id)) fail('VALIDATION_ERROR', '请选择个人顾客或企业顾客。'); return; }
    if (scope === 'level') {
      if (!await store.findOne('users', { priceLevel: id, status: 'active' })) fail('PRICE_TARGET_NOT_FOUND', '该价格等级没有有效客户，请先核对客户等级。');
      return;
    }
    const collection = scope === 'organization' ? 'customer_organizations' : scope === 'user' ? 'users' : '';
    if (!collection || !await store.findOne(collection, { _id: id, status: 'active' })) fail('PRICE_TARGET_NOT_FOUND', '所选价格对象已不存在或停用，请重新选择。');
  }
  return { list, validate };
}
module.exports = { createPricingTargets, customerLabel };
