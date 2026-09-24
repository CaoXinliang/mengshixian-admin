(function (global, document) {
  'use strict';
  let generation = 0;
  function onOpen(form) {
    if (form.getAttribute('id') !== 'priceForm') return;
    const old = form.elements.scopeId;
    if (old.tagName !== 'SELECT') {
      const select = document.createElement('select');
      select.name = 'scopeId';
      select.dataset.savedValue = old.value;
      old.parentElement.firstChild.textContent = '适用对象';
      old.replaceWith(select);
    }
    const select = form.elements.scopeId;
    const saved = select.dataset.savedValue || select.value;
    delete select.dataset.savedValue;
    if (!form.__targetBound) {
      form.elements.scopeType.addEventListener('change', () => load(form, ''));
      form.__targetBound = true;
    }
    load(form, saved);
  }
  async function load(form, saved) {
    const request = ++generation;
    const select = form.elements.scopeId;
    const scope = form.elements.scopeType.value;
    select.replaceChildren(new Option(scope === 'public' ? '所有登录顾客，无需选择' : '正在加载可选对象…', ''));
    select.required = scope !== 'public';
    select.disabled = scope === 'public';
    if (scope === 'public') return;
    try {
      const result = await global.MengshixianAdminPaging.listAll((action, params) => global.MengshixianAdminApi.call(action, { ...params, scopeType: scope }), 'admin.pricingTargets.list');
      if (request !== generation) return;
      select.replaceChildren(new Option(result.rows.length ? '请选择适用对象' : '暂无可选对象，请先维护客户资料', ''), ...result.rows.map((row) => new Option(row.label, row._id)));
      select.value = result.rows.some((row) => row._id === saved) ? saved : '';
      if (saved && !select.value) select.options[0].textContent = '原对象已不可用，请重新选择';
    } catch (error) {
      if (request !== generation) return;
      select.replaceChildren(new Option(`加载失败：${error.message || '请重新打开表单重试'}`, ''));
    }
  }
  async function loadNames(call, prices) {
    const scopes = [...new Set((prices || []).map((row) => row.scopeType).filter((scope) => scope && scope !== 'public'))];
    const results = await Promise.all(scopes.map(async (scope) => {
      const listed = await global.MengshixianAdminPaging.listAll((action, params) => call(action, {...params, scopeType: scope}), 'admin.pricingTargets.list');
      return [scope, Object.fromEntries(listed.rows.map((row) => [row._id, row.label]))];
    }));
    return Object.fromEntries(results);
  }
  global.MengshixianPricingTargets = { onOpen, loadNames };
}(window, document));
