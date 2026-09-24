(function (global, document) {
  'use strict';
  function onOpen(form, state) {
    if (form.getAttribute('id') !== 'userPricingForm') return;
    const user = state.users.find((row) => row._id === form.dataset.editingId);
    if (!user) throw new Error('请先从客户列表选择要调整的客户。');
    form.elements.id.type = 'hidden';
    form.elements.id.parentElement.hidden = true;
    let summary = form.querySelector('[data-customer-summary]');
    if (!summary) { summary = document.createElement('p'); summary.dataset.customerSummary = ''; form.querySelector('h3').after(summary); }
    summary.textContent = `当前客户：${user.displayName || '未提供客户名称'}。调整身份与企业归属会影响可见商品及价格，请核对后保存。`;
    const old = form.elements.organizationId;
    const select = old.tagName === 'SELECT' ? old : document.createElement('select');
    select.name = 'organizationId';
    old.parentElement.firstChild.textContent = '所属企业';
    select.replaceChildren(new Option('请选择已审核通过的企业', ''), ...state.organizations.map((row) => new Option(row.label, row._id)));
    select.value = state.organizations.some((row) => row._id === user.organizationId) ? user.organizationId : '';
    if (old !== select) old.replaceWith(select);
    form.elements.priceLevel.placeholder = '填写业务约定的等级名称；无等级可留空';
    const update = () => {
      const enterprise = form.elements.userType.value === 'b';
      select.required = enterprise; select.disabled = !enterprise;
      if (!enterprise) select.value = '';
    };
    form.elements.userType.onchange = update;
    update();
  }
  function confirm(form, state) {
    const user = state.users.find((row) => row._id === form.dataset.editingId);
    if (!user) throw new Error('客户记录已失效，请刷新后重新选择。');
    const enterprise = form.elements.userType.value === 'b';
    const organization = state.organizations.find((row) => row._id === form.elements.organizationId.value);
    if (enterprise && !organization) throw new Error('请先选择有效企业。');
    return global.confirm(`确认调整「${user.displayName || '当前客户'}」？\n身份：${enterprise ? '企业顾客' : '个人顾客'}\n所属企业：${enterprise ? organization.label : '不归属企业'}\n价格等级：${form.elements.priceLevel.value.trim() || '无'}\n保存后会影响该客户的商品可见性与价格。`);
  }
  global.MengshixianCustomerGuide = { onOpen, confirm };
}(window, document));
