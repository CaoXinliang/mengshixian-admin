(function attachOrderGuide(global, document) {
  const page = global.PAGE_NAME;
  if (page !== 'orders' && page !== 'refunds') return;

  const orderSteps = {
    pending_payment: ['待支付', '付款确认前无需安排拣货。'],
    pending_confirmation: ['待确认', '核对订单后，点击“开始拣货”。'],
    picking: ['拣货中', '实际交运后，点击“标记发货”。'],
    shipping: ['运输中', '确认已送达后，点击“标记送达”。'],
    delivered: ['已送达', '本页暂时没有下一步操作。'],
    completed: ['已完成', '本页无需继续处理。'],
    cancelled: ['已取消', '本页无需继续处理。']
  };
  const refundSteps = {
    requested: ['待审核', '核对申请金额和原因，再选择审核通过或驳回。'],
    reviewing: ['审核中', '等待审核结果，请勿当作已退款。'],
    processing: ['退款处理中', '审核已通过，等待退款渠道确认；当前不能视为到账。'],
    succeeded: ['已退款', '退款渠道已确认成功，本页无需再操作。'],
    rejected: ['已驳回', '本次申请已结束，本页无需再操作。']
  };
  const orderTasks = [
    ['pending_confirmation', '待确认', '核对后开始拣货'],
    ['picking', '拣货中', '实际交运后标记发货'],
    ['shipping', '运输中', '确认送达后更新状态']
  ];
  const refundTasks = [
    ['requested', '待审核', '核对金额与原因'],
    ['processing', '处理中', '等待退款渠道确认'],
    ['succeeded', '已退款', '渠道已确认成功']
  ];
  const byId = (id) => document.getElementById(id);
  const count = (rows, status) => rows.filter((row) => row.status === status).length;
  const knownOrderStatus = (search) => {
    const value = new URLSearchParams(search || '').get('status');
    return orderTasks.some(([status]) => status === value) ? value : '';
  };
  const filterRefunds = (rows, status) => status ? rows.filter((row) => row.status === status) : rows;
  const stepFor = (kind, status) => (kind === 'orders' ? orderSteps : refundSteps)[status] || ['状态待核对', '请核对最新业务状态后再处理。'];

  function renderCards(rows, tasks, target) {
    if (!target) return;
    target.innerHTML = tasks.map(([status, label, next]) =>
      `<button type="button" class="order-guide-card" data-guide-status="${status}"><span>${label}</span><strong>${count(rows, status)}</strong><small>${next}</small></button>`
    ).join('');
  }

  function annotateRows(kind, rows, tbodyId) {
    const tbody = byId(tbodyId);
    if (!tbody) return;
    const key = kind === 'orders' ? 'orderNo' : 'refundNo';
    const lookup = new Map(rows.map((row) => [String(row[key] || ''), row]));
    tbody.querySelectorAll('tr').forEach((tr) => {
      const cells = tr.querySelectorAll('td');
      if (cells.length < (kind === 'orders' ? 8 : 7)) {
        const hint = tr.querySelector('.empty-hint');
        const filtered = kind === 'orders' ? Boolean(global.__orderFilters?.status || global.__orderFilters?.keyword) : Boolean(byId('refundGuideStatus')?.value);
        if (hint && filtered) hint.textContent = '没有符合当前筛选条件的记录，请调整或重置筛选。';
        return;
      }
      const row = lookup.get(cells[1].textContent.trim());
      if (!row) return;
      const [label, next] = stepFor(kind, row.status);
      const statusCell = cells[kind === 'orders' ? 3 : 5];
      const badge = statusCell.querySelector('.badge');
      if (badge) {
        badge.textContent = label;
        if (row.status === 'succeeded' && badge.classList) badge.classList.add('live');
      }
      const note = document.createElement('small');
      note.className = 'order-guide-row-note';
      note.textContent = next;
      cells[cells.length - 1].appendChild(note);
    });
  }

  function renderOrderGuide(rows) {
    renderCards(rows, orderTasks, byId('orderGuideCards'));
    const message = byId('orderGuideMessage');
    if (message) message.textContent = rows.length ? `本次加载 ${rows.length} 条订单。选择上方待办可查看对应订单。` : '当前没有订单记录。';
    const hint = byId('orderGuideFilterHint');
    const filters = global.__orderFilters || {};
    if (hint) hint.textContent = filters.status || filters.keyword
      ? `当前显示${filters.status ? (stepFor('orders', filters.status)[0]) : '全部状态'}${filters.keyword ? '、符合搜索词' : ''}的订单；可点击“重置”查看全部。`
      : '当前显示全部订单。';
    annotateRows('orders', rows, 'ordersTable');
  }

  function renderRefundGuide(rows) {
    renderCards(rows, refundTasks, byId('refundGuideCards'));
    const message = byId('refundGuideMessage');
    if (message) message.textContent = rows.length ? `本次加载 ${rows.length} 条退款申请。审核通过后仍需等待退款渠道确认。` : '当前没有退款申请。';
    const status = byId('refundGuideStatus')?.value || '';
    const hint = byId('refundGuideFilterHint');
    if (hint) hint.textContent = status ? `当前仅显示“${stepFor('refunds', status)[0]}”的申请，共 ${count(rows, status)} 条。` : '当前显示全部退款申请。';
    annotateRows('refunds', filterRefunds(rows, status), 'refundsTable');
  }

  function showLoadFailure() {
    const notice = byId('globalMessage');
    if (!notice || !/后台数据加载失败|服务连接异常/.test(notice.textContent || '')) return;
    const message = byId(page === 'orders' ? 'orderGuideMessage' : 'refundGuideMessage');
    const cards = byId(page === 'orders' ? 'orderGuideCards' : 'refundGuideCards');
    if (message) message.textContent = '数据加载失败，当前数量不能作为处理依据。请刷新页面后重试。';
    if (cards) cards.innerHTML = '';
  }

  const tableModule = global.MengshixianAdminTables;
  if (!tableModule || typeof tableModule.render !== 'function') return;
  const originalRender = tableModule.render;
  let lastState;
  let lastHelpers;
  let initialStatusApplied = false;
  const initialStatus = page === 'orders' ? knownOrderStatus(global.location && global.location.search) : '';
  if (initialStatus) byId('orderFilterStatus').value = initialStatus;

  global.MengshixianAdminTables = Object.freeze({ ...tableModule, render(state, helpers) {
    lastState = state;
    lastHelpers = helpers;
    if (page === 'refunds') {
      const status = byId('refundGuideStatus')?.value || '';
      originalRender({ ...state, refunds: filterRefunds(state.refunds, status) }, helpers);
      renderRefundGuide(state.refunds);
    } else {
      originalRender(state, helpers);
      if (!initialStatusApplied) {
        initialStatusApplied = true;
        if (initialStatus) {
          byId('orderFilterBtn').click();
          return;
        }
      }
      renderOrderGuide(state.orders);
    }
    showLoadFailure();
  } });

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-guide-status]');
    if (!button) return;
    if (page === 'orders') {
      byId('orderFilterStatus').value = button.dataset.guideStatus;
      byId('orderFilterKeyword').value = '';
      byId('orderFilterBtn').click();
    } else {
      byId('refundGuideStatus').value = button.dataset.guideStatus;
      if (lastState) global.MengshixianAdminTables.render(lastState, lastHelpers);
    }
  });
  if (page === 'refunds') byId('refundGuideStatus').addEventListener('change', () => {
    if (lastState) global.MengshixianAdminTables.render(lastState, lastHelpers);
  });
  if (typeof MutationObserver !== 'undefined') {
    const notice = byId('globalMessage');
    if (notice) new MutationObserver(showLoadFailure).observe(notice, { childList: true, characterData: true, subtree: true });
  }

  global.MengshixianAdminOrderGuide = Object.freeze({ knownOrderStatus, filterRefunds, stepFor });
}(window, document));
