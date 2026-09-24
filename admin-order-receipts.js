(function attachOrderReceipts(global, document) {
  if (global.PAGE_NAME !== 'orders') return;

  const money = global.MengshixianAdminMoney;
  let mounted = false;

  function mount({ call, getAdmin, onSaved }) {
    if (mounted) return;
    mounted = true;
    const dialog = document.createElement('dialog');
    dialog.className = 'admin-receipt-dialog';
    dialog.innerHTML = `<div class="admin-receipt-panel">
      <header><h3>线下收款登记</h3><button type="button" data-receipt-action="close" aria-label="关闭收款面板">×</button></header>
      <p class="admin-receipt-warning">仅在核实实际到账后登记。这里不会发起转账或扣款。</p>
      <p data-receipt-state role="status" aria-live="polite"></p>
      <p data-receipt-error role="alert"></p>
      <div data-receipt-summary></div>
      <div data-receipt-history></div>
      <div data-receipt-pending hidden><p>上次登记结果尚未确认。请先读取记录核对，或按原内容重试；此时不能改金额再登记。</p><button type="button" data-receipt-action="reload">重新读取记录</button><button type="button" data-receipt-action="retry">原内容重试</button></div>
      <form data-receipt-form>
        <label>实际收到金额（元）<input name="amountYuan" inputmode="decimal" autocomplete="off" required></label>
        <label>实际到账时间（北京时间）<input name="receivedLocal" type="datetime-local" required></label>
        <label>收款方式<select name="method" required><option value="bank_transfer">银行转账</option><option value="wechat_transfer">微信转账</option><option value="alipay_transfer">支付宝转账</option><option value="cash">现金</option><option value="other">其他</option></select></label>
        <label>备注<input name="note" maxlength="500" placeholder="其他收款方式请填写说明"></label>
        <button type="submit" data-receipt-action="record">核对并登记</button>
      </form>
    </div>`;
    document.body.appendChild(dialog);
    let orderId = '';
    let summary = null;
    let summaryOrderId = '';
    let readVersion = 0;
    let pendingPayload = null;
    const pendingKey = () => {
      const id = (getAdmin() || {}).id;
      if (!id) throw new Error('无法确认当前操作账号，请重新登录后登记。');
      return `friend-receipt-pending:${id}`;
    };
    let busy = false;
    if (typeof global.addEventListener === 'function') global.addEventListener('beforeunload', (event) => {
      if (!pendingPayload) return;
      event.preventDefault();
      event.returnValue = '';
    });
    const can = (permission) => {
      const permissions = (getAdmin() || {}).permissions || [];
      return permissions.includes('*') || permissions.includes(permission) || permissions.includes('receipts.*');
    };

    const select = (name) => dialog.querySelector(`[data-receipt-${name}]`);
    const formatTime = (value) => {
      const time = new Date(value);
      return Number.isFinite(time.getTime()) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(time) : '时间待核对';
    };
    const methods = { bank_transfer: '银行转账', wechat_transfer: '微信转账', alipay_transfer: '支付宝转账', cash: '现金', other: '其他' };
    const collectionLabels = { unpaid: '未收款', partial: '部分收款', paid: '已收齐', unknown: '历史收款待核实' };
    const orderLabels = { pending_payment: '待支付', pending_confirmation: '待确认', picking: '拣货中', shipping: '运输中', delivered: '已送达', completed: '已完成', cancelled: '已取消', closed: '已关闭' };
    function renderHistory(rows) {
      const target = select('history');
      const heading = document.createElement('h4');
      heading.textContent = '已登记收款记录';
      const list = document.createElement('ol');
      (rows || []).forEach((row) => {
        const item = document.createElement('li');
        item.textContent = `¥${money.toYuan(row.amountCent)} · ${formatTime(row.receivedAt)}（北京时间） · ${methods[row.method] || '其他方式'} · ${row.operatorName || '操作人待核对'}${row.note ? ` · ${row.note}` : ''}`;
        list.appendChild(item);
      });
      if (!rows || !rows.length) {
        const empty = document.createElement('li');
        empty.textContent = '暂无已登记的收款记录。';
        list.appendChild(empty);
      }
      target.replaceChildren(heading, list);
    }
    function showPending() {
      select('pending').hidden = !pendingPayload;
      select('form').hidden = Boolean(pendingPayload) || select('form').hidden;
    }
    async function load() {
      const targetOrderId = orderId;
      const version = ++readVersion;
      summary = null;
      summaryOrderId = '';
      dialog.querySelector('[data-receipt-state]').textContent = '正在读取收款记录…';
      dialog.querySelector('[data-receipt-error]').textContent = '';
      select('form').hidden = true;
      select('summary').textContent = '';
      select('history').replaceChildren();
      try {
        const result = await call('admin.orders.receipts.list', { orderId: targetOrderId });
        if (version !== readVersion || orderId !== targetOrderId) return false;
        summary = result;
        summaryOrderId = targetOrderId;
        const unknown = result.collectionStatus === 'unknown' || result.receivedAmountCent == null || result.outstandingAmountCent == null;
        const balance = unknown ? '历史收款待核实，不能推定未收款。' : `已收 ¥${money.toYuan(result.receivedAmountCent)}，待收 ¥${money.toYuan(result.outstandingAmountCent)}。`;
        const collectionLabel = unknown ? collectionLabels.unknown : collectionLabels[result.collectionStatus] || '状态待核对';
        select('summary').textContent = `订单 ${result.orderNo}：${collectionLabel}。总额 ¥${money.toYuan(result.totalAmountCent)}，${balance} 履约：${orderLabels[result.orderStatus] || '状态待核对'}。`;
        renderHistory(result.rows);
        const blocked = result.registrationBlockedReason || (unknown ? '历史收款待核实' : '') || (['cancelled', 'closed'].includes(result.orderStatus) ? '订单已取消或关闭' : '') || (result.outstandingAmountCent === 0 ? '该订单已收齐' : '') || (!can('receipts.write') ? '当前账号没有登记收款的权限' : '');
        select('form').hidden = Boolean(blocked || pendingPayload);
        if (blocked) dialog.querySelector('[data-receipt-state]').textContent = `${blocked}，不能新增收款登记。`;
        else dialog.querySelector('[data-receipt-state]').textContent = pendingPayload ? '上次登记结果待核对，可原内容重试。' : '';
        showPending();
        return true;
      } catch (error) {
        if (version !== readVersion || orderId !== targetOrderId) return false;
        summary = null;
        summaryOrderId = '';
        dialog.querySelector('[data-receipt-state]').textContent = '收款记录读取失败，当前金额不可用。';
        dialog.querySelector('[data-receipt-error]').textContent = error.message || '请稍后重试。';
        showPending();
        return false;
      }
    }

    async function open(id) {
      if (!id || busy) return;
      if (!dialog.open) dialog.showModal();
      let restoredAnotherOrder = false;
      try {
        if (!pendingPayload && can('receipts.read')) {
          const saved = global.sessionStorage.getItem(pendingKey());
          if (saved) {
            const recovered = JSON.parse(saved);
            if (!recovered.orderId || !recovered.idempotencyKey || !Number.isSafeInteger(recovered.amountCent)) throw new Error('上次登记记录无法识别，请先核实，暂不能新增收款。');
            pendingPayload = Object.freeze(recovered);
            restoredAnotherOrder = id !== recovered.orderId;
            id = recovered.orderId;
          }
        }
      } catch (error) {
        select('form').hidden = true;
        select('state').textContent = error.message || '无法读取待核对登记，暂不能新增收款。';
        return;
      }
      if (pendingPayload && id !== pendingPayload.orderId) {
        select('state').textContent = '上一笔登记结果待核对，请先处理原订单。';
        return;
      }
      orderId = id;
      if (!can('receipts.read')) {
        ++readVersion;
        summary = null;
        summaryOrderId = '';
        select('form').hidden = true;
        select('summary').textContent = '';
        select('history').replaceChildren();
        select('state').textContent = '当前账号没有查看收款记录的权限。';
        return;
      }
      await load();
      if (restoredAnotherOrder) select('state').textContent = `请先处理上次登记的原订单，当前显示的是恢复的收款记录，不是刚选择的新订单。 ${select('state').textContent}`;
    }

    async function record(payload) {
      if (busy || !payload) return;
      busy = true;
      dialog.querySelector('[data-receipt-action="record"]').disabled = true;
      select('state').textContent = '正在保存收款登记…';
      try {
        const result = await call('admin.orders.receipts.record', payload);
        if (!result || !result.receipt || !result.receipt._id) throw new Error('登记响应未确认收款记录，请先核对流水。');
      } catch (error) {
        select('form').hidden = true;
        showPending();
        select('state').textContent = '登记结果尚未确认。请先读取记录核对，或按原内容重试。';
        select('error').textContent = error.message || '请求结果不明，请勿另建一笔登记。';
        busy = false;
        dialog.querySelector('[data-receipt-action="record"]').disabled = false;
        return;
      }
      try { global.sessionStorage.removeItem(pendingKey()); }
      catch (_) {
        select('state').textContent = '收款已登记，但本机待核对记录清理失败；请勿另建一笔，可原内容重试确认。';
        showPending(); busy = false;
        dialog.querySelector('[data-receipt-action="record"]').disabled = false;
        return;
      }
      pendingPayload = null;
      select('pending').hidden = true;
      select('form').reset();
      const loaded = await load();
      select('state').textContent = loaded ? '收款登记已成功，已重新读取记录。' : '收款登记已成功，但收款记录刷新失败；请重新读取核对。';
      try { await onSaved(); }
      catch (error) { select('state').textContent += ' 订单列表刷新失败，请稍后刷新页面。'; }
      busy = false;
      dialog.querySelector('[data-receipt-action="record"]').disabled = false;
    }

    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-open-receipts]');
      if (button) return open(button.dataset.openReceipts);
      if (event.target.closest('[data-receipt-action="close"]')) {
        dialog.close();
        return;
      }
      if (event.target.closest('[data-receipt-action="reload"]')) {
        if (dialog.open && orderId && !busy && can('receipts.read')) return load();
        return;
      }
      if (event.target.closest('[data-receipt-action="retry"]')) {
        if (dialog.open && pendingPayload && !busy && can('receipts.write')) return record(pendingPayload);
      }
    });

    document.addEventListener('submit', async (event) => {
      if (!event.target.closest('[data-receipt-form]')) return;
      event.preventDefault();
      if (busy || pendingPayload || !summary || summaryOrderId !== orderId || select('form').hidden || !can('receipts.write')) return;
      const read = (name) => dialog.querySelector(`[name="${name}"]`).value;
      try {
        const amountCent = money.toCents(read('amountYuan'), '实收金额');
        if (amountCent <= 0 || amountCent > summary.outstandingAmountCent) throw new Error('实收金额须大于零且不能超过待收金额。');
        const local = read('receivedLocal');
        const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
        if (!match) throw new Error('请填写实际到账的北京时间。');
        const [, year, month, day, hour, minute] = match.map(Number);
        const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
        if (year < 1 || month < 1 || month > 12 || day < 1 || day > maxDay || hour > 23 || minute > 59) throw new Error('到账时间不是有效的北京时间。');
        const receivedAt = `${local}:00+08:00`;
        if (new Date(receivedAt).getTime() > Date.now()) throw new Error('实际到账时间不能晚于现在。');
        const method = read('method');
        if (!methods[method]) throw new Error('请选择收款方式。');
        const note = read('note').trim();
        if (note.length > 500) throw new Error('备注最多填写500字。');
        if (method === 'other' && !note) throw new Error('选择其他收款方式时请填写备注。');
        const prompt = `请先确认款项已实际到账。\n订单：${summary.orderNo}\n本次实收：¥${money.toYuan(amountCent)}\n到账时间（北京时间）：${local.replace('T', ' ')}\n方式：${methods[method]}\n备注：${note || '无'}\n\n确认登记？`;
        if (!global.confirm(prompt)) return;
        const nextPayload = { orderId, amountCent, receivedAt, method, note, idempotencyKey: global.crypto && global.crypto.randomUUID ? global.crypto.randomUUID() : `receipt-${Date.now()}-${Math.random().toString(36).slice(2)}` };
        global.sessionStorage.setItem(pendingKey(), JSON.stringify(nextPayload));
        pendingPayload = Object.freeze(nextPayload);
        await record(pendingPayload);
      } catch (error) {
        dialog.querySelector('[data-receipt-error]').textContent = error.message || '请核对填写内容。';
      }
    });
  }

  global.MengshixianAdminOrderReceipts = Object.freeze({ mount });
}(window, document));
