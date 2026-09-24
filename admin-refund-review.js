(function attachRefundReview(global, document) {
  'use strict';
  const dialog = document.getElementById('refundReviewDialog');
  if (!dialog) return;
  const status = document.getElementById('refundReviewStatus');
  const content = document.getElementById('refundReviewDetail');
  const confirmed = document.getElementById('refundReviewConfirmed');
  const decisions = [...dialog.querySelectorAll('[data-refund-decision]')];
  const money = (amount) => `¥${(Number(amount || 0) / 100).toFixed(2)}`;
  const paymentLabels = { paid: '已收款', pending: '待支付', offline_pending: '线下待收款' };
  let dependencies;
  let current;
  let generation = 0;
  let busy = false;

  function hasReviewPermission() {
    const permissions = dependencies.getAdmin()?.permissions || [];
    return permissions.includes('*') || permissions.includes('refunds.write');
  }

  function canDecide() {
    const detail = current;
    return !busy && confirmed.checked && hasReviewPermission() && detail?.refund?.status === 'requested'
      && detail.order?.paymentStatus === 'paid' && Array.isArray(detail.order.items) && detail.order.items.length > 0
      && Number(detail.refund.amountCent) > 0 && Number(detail.refund.amountCent) <= Number(detail.order.availableRefundCent)
      && Boolean(detail.reviewToken);
  }

  function updateDecisions() {
    for (const button of decisions) button.disabled = !canDecide();
  }

  function line(label, value) {
    const row = document.createElement('p');
    const term = document.createElement('strong');
    term.textContent = `${label}：`;
    row.append(term, document.createTextNode(String(value || '待核对')));
    content.appendChild(row);
  }

  function render(detail) {
    content.replaceChildren();
    const { refund, order } = detail;
    line('原订单', order.orderNo || '订单号暂不可用');
    line('原订单状态', order.status || '待核对');
    line('收款状态', paymentLabels[order.paymentStatus] || order.paymentStatus || '待核对');
    line('原订单实付', money(order.totalAmountCent));
    line('此前已退款', money(order.refundedAmountCent));
    line('当前剩余可退', money(order.availableRefundCent));
    const heading = document.createElement('strong');
    heading.textContent = '原订单商品：';
    content.appendChild(heading);
    const items = document.createElement('ul');
    for (const item of order.items || []) {
      const row = document.createElement('li');
      row.textContent = `${item.productNameSnapshot || '原商品名称缺失'} · ${item.specSnapshot || '规格未记录'} · ${item.quantity || 0}${item.packageUnitSnapshot || '件'} · 小计 ${money(item.subtotalCent)}`;
      items.appendChild(row);
    }
    if (!items.children.length) {
      const row = document.createElement('li');
      row.textContent = '原订单商品明细暂不可用，不能审核。';
      items.appendChild(row);
    }
    content.appendChild(items);
    line('退款单号', refund.refundNo || '未编号');
    line('本次申请金额', money(refund.amountCent));
    line('申请原因', refund.reason || '未填写');
  }

  async function open(record) {
    if (!record?._id) throw new Error('找不到退款申请，请刷新列表后重试。');
    const request = ++generation;
    current = null;
    busy = false;
    confirmed.checked = false;
    content.replaceChildren();
    status.textContent = '正在读取申请与原订单…';
    updateDecisions();
    if (!dialog.open) dialog.showModal();
    try {
      const detail = await dependencies.call('admin.refunds.reviewDetail', { id: record._id });
      if (request !== generation || !dialog.open) return;
      current = detail;
      render(detail);
      status.textContent = !hasReviewPermission() ? '当前账号可查看，但无退款审核权限。'
        : detail.refund.status !== 'requested' ? '该退款申请已处理，当前仅能查看。'
          : detail.order.paymentStatus !== 'paid' || !detail.order.items?.length ? '原订单收款或商品明细无法核对，当前不能审核。'
            : Number(detail.refund.amountCent) > Number(detail.order.availableRefundCent) ? '申请金额超过当前剩余可退金额，当前不能审核。'
            : '请核对原订单、申请金额和原因，确认后再选择审核结果。';
      updateDecisions();
    } catch (error) {
      if (request !== generation) return;
      status.textContent = `读取失败：${error.message || '请稍后重试。'}`;
      updateDecisions();
    }
  }

  async function submit(decision) {
    if (!canDecide() || !['approved', 'rejected'].includes(decision)) return;
    const detail = current;
    const confirmType = decision === 'approved' ? 'refundApprove' : 'refundReject';
    if (!global.MengshixianAdminOperationsConfirm.ask(confirmType, detail.refund)) return;
    busy = true;
    updateDecisions();
    try {
      await dependencies.call('admin.refunds.review', { id: detail.refund._id, decision, reviewToken: detail.reviewToken });
      dialog.close();
      await dependencies.refresh();
      dependencies.message(decision === 'approved' ? '退款审核已通过，当前仅为处理中；请等待真实退款结果。' : '退款申请已驳回。');
    } catch (error) {
      if (['REFUND_REVIEW_CHANGED', 'REFUND_ORDER_CHANGED', 'REFUND_NOT_FOUND'].includes(error.code)) {
        current = null;
        confirmed.checked = false;
        status.textContent = '退款申请或原订单已变化，请关闭后重新打开核对。';
        try { await dependencies.refresh(); } catch (_) { /* Keep the review conflict visible. */ }
      } else {
        status.textContent = `审核未保存：${error.message || '请稍后重试。'}`;
      }
      dependencies.message(error.message || '审核未保存。', true);
    } finally {
      busy = false;
      updateDecisions();
    }
  }

  function mount(options) {
    dependencies = options;
    document.getElementById('refundReviewClose').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { generation += 1; current = null; confirmed.checked = false; updateDecisions(); });
    confirmed.addEventListener('change', updateDecisions);
    for (const button of decisions) button.addEventListener('click', () => { void submit(button.dataset.refundDecision); });
  }

  global.MengshixianRefundReview = Object.freeze({ mount, open });
}(window, document));
