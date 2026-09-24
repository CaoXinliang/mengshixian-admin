(function attachAdminOverview(global, document) {
  const escapeHtml = (value) => String(value === undefined || value === null ? '' : value)
    .replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const formatCents = (value) => `¥${(Number(value || 0) / 100).toFixed(2)}`;
  const formatDate = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
  const orderStatuses = {
    pending_confirmation: '待确认', pending_payment: '待付款', pending: '待处理',
    picking: '拣货中', shipping: '配送中', delivered: '已送达', completed: '已完成',
    cancelled: '已取消', closed: '已关闭'
  };
  const tasks = [
    { key: 'orders', title: '待确认订单', href: 'orders.html?status=pending_confirmation', count: (state) => state.orders.filter((item) => item.status === 'pending_confirmation').length },
    { key: 'picking', title: '待拣货订单', href: 'orders.html?status=picking', count: (state) => state.orders.filter((item) => item.status === 'picking').length },
    { key: 'shipping', title: '配送中订单', href: 'orders.html?status=shipping', count: (state) => state.orders.filter((item) => item.status === 'shipping').length },
    { key: 'businesses', title: '企业申请待审核', href: 'businesses.html', count: (state) => state.businessApplications.filter((item) => item.status === 'pending').length },
    { key: 'refunds', title: '售后申请待审核', href: 'refunds.html', count: (state) => state.refunds.filter((item) => item.status === 'requested').length },
    { key: 'products', title: '未上架商品待核对', href: 'product-review.html', count: (state) => state.products.filter((item) => item.status !== 'on_sale').length },
    { key: 'imports', title: '待审核商品表格', href: 'imports.html', count: (state) => state.imports.filter((item) => ['staged', 'reviewing', 'approved'].includes(item.status)).length },
    { key: 'inventory', title: '可售为零库存记录', href: 'inventory.html', count: (state) => state.inventory.filter((item) => Number(item.available) <= 0).length }
  ];
  const sources = { orders: 'orders', picking: 'orders', shipping: 'orders', businesses: 'businessApplications', refunds: 'refunds', products: 'products', imports: 'imports', inventory: 'inventory' };
  const highlights = ['orders', 'products', 'inventory', 'refunds'];
  const availability = (state, key) => state.loadStates?.[key] || 'loading';
  const unavailableText = (state, key) => availability(state, key) === 'failed' ? '暂不可用' : '正在读取';

  function render(state) {
    const taskCards = document.getElementById('taskMetrics');
    if (!taskCards) return;
    taskCards.innerHTML = tasks.filter((task) => highlights.includes(task.key)).map((task) => {
      if (availability(state, sources[task.key]) !== 'ready') return `<a class="task-card" href="${task.href}"><span class="task-label">${task.title}</span><strong>${unavailableText(state, sources[task.key])}</strong><span class="task-action">进入页面核对 →</span></a>`;
      const count = task.count(state);
      return `<a class="task-card${count ? ' is-urgent' : ''}" href="${task.href}"><span class="task-label">${task.title}</span><strong>${count}</strong><span class="task-action">进入处理 <b>→</b></span></a>`;
    }).join('');

    document.getElementById('overviewDate').textContent = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
    document.getElementById('metrics').innerHTML = [
      ['已加载订单', state.orders.length, 'orders'],
      ['已加载商品', state.products.length, 'products'],
      ['在售商品', state.products.filter((item) => item.status === 'on_sale').length, 'products'],
      ['商品规格', state.skus.length, 'skus']
    ].map(([label, count, key]) => `<article class="metric"><span>${label}</span><strong>${availability(state, key) === 'ready' ? count : unavailableText(state, key)}</strong></article>`).join('');

    const recentOrders = [...state.orders].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, 5);
    document.getElementById('overviewOrders').innerHTML = availability(state, 'orders') !== 'ready' ? `<tr><td colspan="5">订单${unavailableText(state, 'orders')}，请进入订单页核对。</td></tr>` : recentOrders.length
      ? recentOrders.map((order) => `<tr><td><code>${escapeHtml(order.orderNo || order._id)}</code></td><td>${escapeHtml((order.addressSnapshot && order.addressSnapshot.name) || '—')}</td><td>${formatCents(order.totalAmountCent)}</td><td>${escapeHtml(orderStatuses[order.status] || order.status || '—')}</td><td>${formatDate(order.createdAt)}</td></tr>`).join('')
      : '<tr class="empty-row"><td colspan="5">当前没有订单记录</td></tr>';

    const missing = tasks.filter((task) => availability(state, sources[task.key]) !== 'ready');
    const actionable = tasks.filter((task) => availability(state, sources[task.key]) === 'ready').map((task) => ({ ...task, value: task.count(state) })).filter((task) => task.value > 0);
    document.getElementById('overviewQueue').innerHTML = actionable.length
      ? actionable.map((task) => `<a href="${task.href}"><span><strong>${task.title}</strong><small>查看并处理相关记录</small></span><b>${task.value}</b><span aria-hidden="true">›</span></a>`).join('')
      : missing.length ? '<p class="overview-empty">待办数据尚未全部读取，当前无法确认是否已处理完毕。</p>' : '<p class="overview-empty">当前加载记录中没有待处理事项。</p>';
    if (missing.length && actionable.length) document.getElementById('overviewQueue').innerHTML += '<p>部分待办尚不可用，请核对上方状态。</p>';
  }

  global.MengshixianAdminOverview = Object.freeze({ render });
}(window, document));
