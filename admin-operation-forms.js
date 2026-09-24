(function (root, factory) {
  const api = factory(root && root.MengshixianAdminMoney || (typeof require === 'function' ? require('./admin-money.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MengshixianOperationForms = api;
}(typeof window !== 'undefined' ? window : null, function (money) {
  const fields = {
    priceForm: ['amountCent'],
    groupCampaignForm: ['groupPriceCent'],
    freightForm: ['baseFeeCent', 'additionalFeeCent', 'freeThresholdCent']
  };
  const labels = { amountCent: '价格', groupPriceCent: '拼团单价', baseFeeCent: '基础运费', additionalFeeCent: '附加运费', freeThresholdCent: '免运门槛' };
  function toBeijingInput(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16);
  }
  function populateValidity(form, item) {
    form.elements.validFrom.value = toBeijingInput(item.validFrom);
    form.elements.validTo.value = toBeijingInput(item.validTo);
  }
  function validity(form) {
    const convert = (value) => value ? new Date(`${value}${value.length === 16 ? ':00' : ''}+08:00`).toISOString() : '';
    const validFrom = convert(form.elements.validFrom.value);
    const validTo = convert(form.elements.validTo.value);
    if (validFrom && validTo && validFrom > validTo) throw new Error('结束生效时间不能早于开始时间。');
    return { validFrom, validTo };
  }
  function freightPolicy(form) {
    const customerType = form.elements.customerType.value;
    if (!['', 'c', 'b'].includes(customerType)) throw new Error('请选择有效的适用顾客。');
    const priority = Number(form.elements.priority.value);
    if (!Number.isSafeInteger(priority)) throw new Error('匹配优先级必须是整数。');
    return { customerType, priority, ...validity(form) };
  }
  function populateFreight(form, item) {
    const audience = form.elements.customerType;
    audience.querySelector('[data-legacy]')?.remove();
    if (item.customerType && !['c', 'b'].includes(item.customerType)) {
      const warning = option(form.ownerDocument, item.customerType, '原适用顾客已不可用，请重新选择');
      warning.dataset.legacy = 'true';
      audience.append(warning);
    }
    audience.value = item.customerType || '';
    form.elements.priority.value = Number.isSafeInteger(Number(item.priority || 0)) ? Number(item.priority || 0) : 0;
    populateValidity(form, item);
  }
  function populateSlot(form, item) {
    form.elements.sort.value = Number.isSafeInteger(Number(item.sort || 0)) ? Number(item.sort || 0) : 0;
    populateValidity(form, item);
  }
  function slotPolicy(form) {
    const sort = Number(form.elements.sort.value);
    if (!Number.isSafeInteger(sort)) throw new Error('显示顺序必须是整数。');
    return { sort, ...validity(form) };
  }
  function option(document, value, label) { const item = document.createElement('option'); item.value = value; item.textContent = label; return item; }
  function nameSelect(form, name, entries, blank) {
    const input = form.elements[name];
    if (!input) return;
    const document = input.ownerDocument;
    const value = input.value;
    const readableLabels = { skuId: '商品与销售规格', deliveryAreaId: '配送区域', warehouseId: '仓库' };
    if (readableLabels[name]) input.parentElement.firstChild.textContent = readableLabels[name];
    const select = input.tagName === 'SELECT' ? input : document.createElement('select');
    select.name = name;
    select.required = input.required;
    select.replaceChildren(option(document, '', blank), ...entries.map((row) => option(document, row._id, row.label)));
    if (value && !entries.some((row) => row._id === value)) select.appendChild(option(document, value, '原选择已不可用，请重新选择'));
    select.value = value;
    if (input !== select) input.replaceWith(select);
  }
  function warehouseChoices(form, warehouses) {
    const textarea = form.elements.warehouseIds;
    const selected = new Set(String(textarea.value || '').split(/\r?\n/).map((id) => id.trim()).filter(Boolean));
    textarea.hidden = true; textarea.required = false;
    textarea.parentElement.firstChild.textContent = '可配送仓库（不勾选表示全部仓库）';
    let choices = form.querySelector('.warehouse-name-choices');
    if (!choices) { choices = form.ownerDocument.createElement('div'); choices.className = 'warehouse-name-choices'; textarea.after(choices); }
    choices.replaceChildren();
    const known = new Set();
    warehouses.forEach((warehouse) => {
      known.add(warehouse._id);
      const label = form.ownerDocument.createElement('label');
      const input = form.ownerDocument.createElement('input');
      input.type = 'checkbox'; input.value = warehouse._id; input.checked = selected.has(warehouse._id);
      label.append(input, form.ownerDocument.createTextNode(warehouse.name || '未命名仓库'));
      choices.appendChild(label);
    });
    for (const id of selected) if (!known.has(id)) {
      const label = form.ownerDocument.createElement('label');
      const input = form.ownerDocument.createElement('input');
      input.type = 'checkbox'; input.value = id; input.checked = true;
      label.append(input, form.ownerDocument.createTextNode('原仓库已不可用，请取消勾选'));
      choices.appendChild(label);
    }
    if (!form.__warehouseGuideBound) {
      choices.addEventListener('change', () => { textarea.value = [...choices.querySelectorAll('input:checked')].map((item) => item.value).join('\n'); });
      form.__warehouseGuideBound = true;
    }
  }
  function onOpen(form, state) {
    const formId = form.getAttribute('id');
    if (['deliveryAreaForm', 'deliverySlotForm'].includes(formId) && !form.dataset.editingId && !form.elements.id.value) form.elements.status.value = 'disabled';
    const productNames = new Map(state.products.map((row) => [row._id, row.name]));
    const skus = state.skus.map((row) => ({ _id: row._id, label: `${productNames.get(row.productId) || '商品'} · ${row.specName || '未命名规格'}` }));
    const areas = state.deliveryAreas.map((row) => ({ _id: row._id, label: row.name || '未命名区域' }));
    const warehouses = state.warehouses.map((row) => ({ _id: row._id, label: row.name || '未命名仓库' }));
    if (formId === 'priceForm' || formId === 'groupCampaignForm') nameSelect(form, 'skuId', skus, '请选择商品规格');
    if (formId === 'freightForm' || formId === 'deliverySlotForm') {
      nameSelect(form, 'deliveryAreaId', areas, '请选择配送区域');
      nameSelect(form, 'warehouseId', warehouses, '不指定仓库');
    }
    if (formId === 'deliveryAreaForm') warehouseChoices(form, state.warehouses);
    if (!fields[formId]) return;
    for (const name of fields[formId]) {
      const input = form.elements[name];
      input.value = money.toYuan(Number(input.value || 0));
      input.type = 'text'; input.inputMode = 'decimal';
      input.placeholder = '例如：25.00';
      input.parentElement.firstChild.textContent = `${labels[name]}（元）`;
    }
    let preview = form.querySelector('.money-save-preview');
    if (!preview) { preview = form.ownerDocument.createElement('p'); preview.className = 'money-save-preview'; form.querySelector('button.primary').before(preview); }
    const update = () => {
      const parts = fields[formId].map((name) => `${labels[name]}：¥${form.elements[name].value || '未填写'}`);
      if (['priceForm', 'freightForm'].includes(formId)) parts.push(`生效区间：${form.elements.validFrom.value || '不限定开始'} 至 ${form.elements.validTo.value || '不限定结束'}（北京时间）`);
      if (formId === 'freightForm') parts.push(`适用顾客：${form.elements.customerType.selectedOptions[0]?.textContent || '未选择'}`, `匹配优先级：${form.elements.priority.value}`);
      const active = form.elements.status.value === 'active';
      const from = ['priceForm', 'freightForm'].includes(formId) && form.elements.validFrom.value;
      const future = from && new Date(`${from}${from.length === 16 ? ':00' : ''}+08:00`).getTime() > Date.now();
      const to = ['priceForm', 'freightForm'].includes(formId) && form.elements.validTo.value;
      const expired = to && new Date(`${to}${to.length === 16 ? ':00' : ''}+08:00`).getTime() < Date.now();
      preview.textContent = `保存前核对：${parts.join('；')}；${!active ? '暂不生效' : future ? '到设定时间后生效' : expired ? '结束时间已过，当前不会生效' : '保存后立即生效'}。`;
    };
    if (!form.__moneyGuideBound) { form.addEventListener('input', update); form.addEventListener('change', update); form.__moneyGuideBound = true; }
    update();
  }
  function values(form) {
    const data = new FormData(form);
    return Object.fromEntries((fields[form.getAttribute('id')] || []).map((name) => [name, money.toCents(data.get(name), labels[name])]));
  }
  function ask(form, state, confirmFn = (typeof window !== 'undefined' ? window.confirm : null)) {
    const delivery = deliverySummary(form, state);
    if (delivery) return Boolean(confirmFn && confirmFn(`确认保存以下配送设置？\n${delivery}\n只影响后续配送匹配，不修改历史订单快照。`));
    const numbers = values(form);
    const id = form.getAttribute('id');
    const sku = state.skus.find((row) => row._id === (form.elements.skuId && form.elements.skuId.value));
    const subject = sku ? `规格「${sku.specName}」` : id === 'freightForm' ? `运费规则「${form.elements.name.value || '未命名'}」` : '当前规则';
    const amounts = Object.entries(numbers).map(([name, cents]) => `${labels[name]} ¥${money.toYuan(cents)}`).join('，');
    const area = id === 'freightForm' && state.deliveryAreas.find((row) => row._id === form.elements.deliveryAreaId.value);
    const warehouse = id === 'freightForm' && state.warehouses.find((row) => row._id === form.elements.warehouseId.value);
    const target = id === 'priceForm' ? `\n适用对象：${form.elements.scopeType.value === 'public' ? '所有登录顾客' : form.elements.scopeId.selectedOptions?.[0]?.textContent || '未选择'}` : id === 'freightForm' ? `\n配送区域：${area?.name || '未选择'}；仓库：${form.elements.warehouseId.value ? warehouse?.name || '原仓库已不可用' : '全部仓库'}\n适用顾客：${form.elements.customerType.selectedOptions[0]?.textContent || '未选择'}；匹配优先级：${form.elements.priority.value}` : '';
    const windowText = ['priceForm', 'freightForm'].includes(id) ? `\n生效区间：${form.elements.validFrom.value || '不限定开始'} 至 ${form.elements.validTo.value || '不限定结束'}（北京时间）` : '';
    const range = ['priceForm', 'freightForm'].includes(id) ? validity(form) : { validFrom: '', validTo: '' };
    const now = new Date().toISOString();
    const activation = form.elements.status.value !== 'active' ? '保存后暂不生效。' : range.validFrom && range.validFrom > now ? '保存后将在设定开始时间生效。' : range.validTo && range.validTo < now ? '结束时间已过，当前不会生效。' : '保存后立即生效。';
    return Boolean(confirmFn && confirmFn(`确认保存${subject}？\n${amounts}${target}${windowText}\n${activation}`));
  }
  function deliverySummary(form, state) {
    const id = form.getAttribute('id');
    if (!['deliveryAreaForm', 'deliverySlotForm'].includes(id)) return '';
    const value = (name) => form.elements[name]?.value || '';
    const status = value('status') === 'active' ? '保存后启用' : '保存后停用';
    if (id === 'deliveryAreaForm') {
      const ids = value('warehouseIds').split(/\r?\n/).filter(Boolean);
      const warehouses = ids.length ? ids.map((key) => state.warehouses.find((row) => row._id === key)?.name || '原仓库已不可用').join('、') : '全部仓库';
      const regions = value('regionNames').split(/\r?\n/).filter(Boolean);
      return `配送区域：${value('name')}\n覆盖：${regions.length ? regions.join('、') : '区域名称未齐，请核对所选区域'}\n仓库：${warehouses}\n${status}；影响上述区域内顾客的配送可用范围。`;
    }
    const area = state.deliveryAreas.find((row) => row._id === value('deliveryAreaId'));
    const warehouse = state.warehouses.find((row) => row._id === value('warehouseId'));
    const range = validity(form);
    const now = new Date().toISOString();
    const scheduleStatus = value('status') !== 'active' ? '保存后暂不启用' : range.validFrom && range.validFrom > now ? '到设定开始时间后启用' : range.validTo && range.validTo < now ? '结束时间已过，当前不可选' : '保存后启用';
    return `配送时段：${value('name')}\n区域：${area?.name || '未选择'}\n仓库：${value('warehouseId') ? warehouse?.name || '原仓库已不可用' : '不限定仓库'}\n每天时间：${value('startTime')}–${value('endTime')}\n有效日期：${value('validFrom') || '不限定开始'} 至 ${value('validTo') || '不限定结束'}（北京时间）\n显示顺序：${value('sort')}\n${scheduleStatus}；影响匹配区域与仓库的顾客可选时段。人数容量尚未接入真实限单。`;
  }
  return { onOpen, values, ask, deliverySummary, populateValidity, validity, freightPolicy, populateFreight, populateSlot, slotPolicy };
}));
