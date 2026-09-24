(function inventoryGuide(global, document) {
  const byId = (id) => document.getElementById(id);
  function buildEntries(inventory, warehouses, skus, products) {
    const warehouseById = new Map(warehouses.map((item) => [item._id, item]));
    const skuById = new Map(skus.map((item) => [item._id, item]));
    const productById = new Map(products.map((item) => [item._id, item]));
    return inventory.map((item) => {
      const warehouse = warehouseById.get(item.warehouseId);
      const sku = skuById.get(item.skuId);
      const product = sku && productById.get(sku.productId);
      return {
        warehouseId: item.warehouseId,
        skuId: item.skuId,
        warehouseName: warehouse ? warehouse.name : '仓库名称未找到',
        productName: product ? product.name : '商品名称未找到',
        specName: sku ? sku.specName : '规格名称未找到',
        packageUnit: sku ? sku.packageUnit || '' : '',
        onHand: item.onHand,
        reserved: item.reserved,
        available: item.available,
        canAdjust: Boolean(warehouse && warehouse.status === 'active' && sku && product)
      };
    });
  }

  function filterEntries(entries, value) {
    const query = String(value || '').trim().toLocaleLowerCase();
    if (!query) return [];
    return entries.filter((entry) => [entry.productName, entry.specName, entry.packageUnit, entry.warehouseName]
      .some((part) => String(part || '').toLocaleLowerCase().includes(query)));
  }

  function changeDescription(value) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number === 0 || Math.abs(number) > 1000000) return '';
    return number > 0 ? `增加 ${number}` : `减少 ${Math.abs(number)}`;
  }

  global.MengshixianAdminInventoryGuide = Object.freeze({ buildEntries, filterEntries, changeDescription });
  const form = byId('inventoryForm');
  const keyword = byId('inventoryKeyword');
  if (!form || !keyword) return;

  const status = byId('inventoryGuideStatus');
  const originalTable = byId('inventoryOriginalTable');
  const matches = byId('inventoryMatches');
  const matchRows = byId('inventoryMatchRows');
  const nativeWarehouse = form.querySelector('input[name="warehouseId"]');
  const nativeSku = form.querySelector('input[name="skuId"]');
  const amount = form.querySelector('input[name="change"]');
  const reason = form.querySelector('input[name="reason"]');
  const submitButton = form.querySelector('button[type="submit"], button.primary');
  const api = global.MengshixianAdminApi;
  const paging = global.MengshixianAdminPaging;
  let data = null;
  let submitting = false;

  function makeSelector(title, id) {
    const label = document.createElement('label');
    label.className = 'inventory-guide-field';
    label.textContent = title;
    const select = document.createElement('select');
    select.id = id;
    select.required = true;
    label.appendChild(select);
    return { label, select };
  }

  const warehouseField = makeSelector('选择仓库', 'inventoryWarehouseChoice');
  const skuField = makeSelector('选择商品与规格', 'inventorySkuChoice');
  [nativeWarehouse, nativeSku].forEach((input) => {
    input.type = 'hidden';
    input.closest('label').classList.add('inventory-native-field');
  });
  nativeWarehouse.closest('label').insertAdjacentElement('beforebegin', warehouseField.label);
  nativeSku.closest('label').insertAdjacentElement('beforebegin', skuField.label);
  const oldHint = form.querySelector('.muted');
  if (oldHint) oldHint.textContent = '按名称选择仓库和商品规格，再填写增加或减少的数量。';
  amount.closest('label').firstChild.textContent = '调整数量（增加填正数，减少填负数）';
  reason.closest('label').firstChild.textContent = '调整原因';
  const reminder = document.createElement('p');
  reminder.className = 'inventory-guide-reminder';
  reminder.id = 'inventoryGuideReminder';
  reminder.setAttribute('aria-live', 'polite');
  submitButton.insertAdjacentElement('beforebegin', reminder);

  function setOptions(select, rows, labelFor, placeholder) {
    select.replaceChildren();
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = placeholder;
    select.appendChild(blank);
    rows.forEach((row) => {
      const option = document.createElement('option');
      option.value = row._id;
      option.textContent = labelFor(row);
      select.appendChild(option);
    });
  }

  function selectedEntry() {
    return data && data.entries.find((entry) => entry.warehouseId === warehouseField.select.value && entry.skuId === skuField.select.value);
  }

  function updateReminder() {
    nativeWarehouse.value = warehouseField.select.value;
    nativeSku.value = skuField.select.value;
    const warehouse = data && data.warehouses.find((item) => item._id === nativeWarehouse.value);
    const sku = data && data.skus.find((item) => item._id === nativeSku.value);
    const product = sku && data.products.find((item) => item._id === sku.productId);
    const change = changeDescription(amount.value);
    if (!warehouse || !sku || !product || !change) {
      reminder.textContent = '提交前请核对仓库、商品规格、数量和原因。提交后会立即改动库存。';
      return;
    }
    const current = selectedEntry();
    const existing = current
      ? `列表参考：现有 ${current.onHand}，已留给订单 ${current.reserved}，可卖 ${current.available}。`
      : '列表中暂无这组仓库和规格的库存记录。';
    reminder.textContent = `${warehouse.name} · ${product.name} · ${sku.specName}：${change}。${existing}提交后会立即改动库存，实际结果由系统核对。`;
  }

  function appendCell(row, value) {
    const cell = document.createElement('td');
    cell.textContent = String(value ?? '—');
    row.appendChild(cell);
    return cell;
  }

  function renderSearch() {
    const query = keyword.value.trim();
    originalTable.classList.toggle('is-filtered', Boolean(data));
    matches.hidden = !data;
    matchRows.replaceChildren();
    if (!data) return;
    const found = query ? filterEntries(data.entries, query) : data.entries;
    status.textContent = found.length
      ? `${query ? '找到' : '共有'} ${found.length} 条库存记录${found.length > 50 ? '，先显示前 50 条；输入名称可查找其余记录' : ''}。`
      : query ? '没有找到对应库存；请换个商品名称、规格或仓库名称。' : '暂无库存记录，可点击上方“库存调整”选择仓库和商品。';
    found.slice(0, 50).forEach((entry) => {
      const row = document.createElement('tr');
      appendCell(row, `${entry.productName} · ${entry.specName}${entry.packageUnit ? ` · ${entry.packageUnit}` : ''}`);
      appendCell(row, entry.warehouseName);
      appendCell(row, entry.onHand);
      appendCell(row, entry.reserved);
      appendCell(row, entry.available);
      const action = appendCell(row, '');
      if (entry.canAdjust) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = '调整这条库存';
        button.dataset.warehouseId = entry.warehouseId;
        button.dataset.skuId = entry.skuId;
        action.appendChild(button);
      } else {
        action.textContent = '请先核对商品或仓库资料';
      }
      matchRows.appendChild(row);
    });
  }

  async function loadData() {
    status.textContent = '正在准备商品查询…';
    try {
      const actions = ['admin.inventory.list', 'admin.warehouses.list', 'admin.skus.list', 'admin.products.list'];
      const results = await Promise.all(actions.map((action) => paging.listAll(api.call, action)));
      const [inventory, warehouses, skus, products] = results.map((result) => result.rows);
      data = { warehouses, skus, products, entries: buildEntries(inventory, warehouses, skus, products) };
      const productById = new Map(products.map((item) => [item._id, item]));
      setOptions(warehouseField.select, warehouses.filter((item) => item.status === 'active'),
        (item) => `${item.name}${item.address ? ` · ${item.address}` : ''}`, '请选择仓库');
      setOptions(skuField.select, skus.filter((item) => productById.has(item.productId)),
        (item) => `${productById.get(item.productId).name} · ${item.specName}${item.packageUnit ? ` · ${item.packageUnit}` : ''}`,
        '请选择商品与规格');
      updateReminder();
      renderSearch();
    } catch (_) {
      data = null;
      originalTable.classList.remove('is-filtered');
      matches.hidden = true;
      status.textContent = '商品查询暂时不可用，请刷新页面后再试。';
      reminder.textContent = '商品和仓库资料尚未加载，请先刷新页面，暂不能提交库存调整。';
    }
  }

  keyword.addEventListener('input', renderSearch);
  [warehouseField.select, skuField.select, amount].forEach((control) => control.addEventListener('input', updateReminder));
  form.addEventListener('reset', () => global.setTimeout(updateReminder, 0));
  const globalMessage = byId('globalMessage');
  if (global.MutationObserver && globalMessage) {
    const observer = new global.MutationObserver(() => {
      if (!submitting) return;
      submitting = false;
      submitButton.disabled = false;
      if (globalMessage.textContent.includes('库存已调整并写入流水')) loadData();
    });
    observer.observe(globalMessage, { childList: true, characterData: true, subtree: true });
  }
  matchRows.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-warehouse-id][data-sku-id]');
    if (!button || !data) return;
    const open = document.querySelector('[data-add-form="#inventoryForm"]');
    if (!open) {
      status.textContent = '页面还在加载，请稍后再试。';
      return;
    }
    open.click();
    warehouseField.select.value = button.dataset.warehouseId;
    skuField.select.value = button.dataset.skuId;
    updateReminder();
  });
  form.addEventListener('submit', (event) => {
    if (submitting) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    updateReminder();
    const warehouse = data && data.warehouses.find((item) => item._id === nativeWarehouse.value && item.status === 'active');
    const sku = data && data.skus.find((item) => item._id === nativeSku.value);
    const product = sku && data.products.find((item) => item._id === sku.productId);
    const change = changeDescription(amount.value);
    if (!warehouse || !product || !change || !reason.value.trim()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      reminder.textContent = '请完整选择仓库和商品规格，填写不超过 100 万的非零整数数量及调整原因。';
      return;
    }
    const message = `请再次确认：${warehouse.name}，${product.name} · ${sku.specName}，${change}。\n原因：${reason.value.trim()}\n确认后会立即改动真实库存并留下记录。`;
    if (!global.confirm(message)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    submitting = true;
    submitButton.disabled = true;
    reminder.textContent = '正在提交，请勿重复点击。';
  }, true);

  updateReminder();
  loadData();
}(window, document));
