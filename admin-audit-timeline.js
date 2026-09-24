(function attachAdminAuditTimeline(global, document) {
  const PAGE_SIZE = 20;
  const ACTIONS = Object.freeze({
    'admin.bootstrap': '初始化后台管理员',
    'admin.login': '登录后台',
    'admin.logout': '退出后台',
    'admin.password.change': '修改本人密码',
    'staff.create': '创建工作人员账号',
    'staff.update': '修改工作人员账号',
    'staff.password.reset': '重置工作人员密码',
    'catalog.category.upsert': '保存商品分类',
    'catalog.product.upsert': '保存商品资料',
    'catalog.product.publish_reviewed': '核对并上架商品',
    'catalog.sku.upsert': '保存销售规格',
    'catalog.product_media.upsert': '调整商品素材关联',
    'pricing.upsert': '保存价格规则',
    'media.upsert': '登记素材',
    'media.metadata.update': '修改素材资料',
    'media.create_version': '新建素材版本',
    'media.upload': '上传素材文件',
    'media.upload.large': '上传大文件素材',
    'media.upload.direct': '上传素材文件',
    'inventory.warehouse.upsert': '保存仓库资料',
    'inventory.adjust': '调整库存',
    'delivery.area.upsert': '保存配送区域',
    'delivery.freight.upsert': '保存运费规则',
    'delivery.slot.upsert': '保存配送时段',
    'orders.fulfillment_contact.read': '查看订单配送联系方式',
    'orders.receipt.record': '登记订单收款',
    'orders.reservations.expire': '处理过期库存预占',
    'refunds.confirm': '确认退款结果',
    'payments.wechat.confirm': '确认微信支付结果',
    'imports.stage': '保存商品导入草稿',
    'imports.approve': '审核商品导入草稿',
    'users.pricing_profile.set': '修改顾客价格身份',
    'organizations.application.approve': '通过企业申请',
    'organizations.application.reject': '驳回企业申请',
    'marketing.group_campaign.upsert': '保存拼团活动',
    'demo.commerce.seed': '写入演示资料',
    'groups.expire': '处理过期拼团',
    'system.maintenance.tick': '执行定时维护',
    'banners.upsert': '保存首页轮播图',
    'home_sections.upsert': '保存首页内容模块'
  });
  const ROLES = Object.freeze({ super_admin: '超级管理员', operator: '运营', legacy: '原有角色', system: '系统', unknown: '原角色不可查' });
  const ORDER_STATES = Object.freeze({ pending_confirmation: '待确认', picking: '拣货中', shipping: '配送中', delivered: '已送达', cancelled: '已取消', completed: '已完成' });

  function actionTitle(row) {
    if (row.action === 'orders.transition') return `将订单履约状态改为${ORDER_STATES[row.details?.to] || '新状态'}`;
    if (row.action === 'catalog.product.status') return row.details?.to === 'on_sale' ? '上架商品' : row.details?.to === 'off_sale' ? '下架商品' : '修改商品状态';
    if (row.action === 'catalog.sku.status') return row.details?.to === 'on_sale' ? '上架销售规格' : row.details?.to === 'off_sale' ? '下架销售规格' : '修改销售规格状态';
    if (row.action === 'refunds.review') return row.details?.decision === 'approved' ? '通过退款申请' : row.details?.decision === 'rejected' ? '驳回退款申请' : '核对退款申请';
    return ACTIONS[row.action] || '其他后台操作（说明待补充）';
  }

  function node(tag, className, content) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content !== undefined) element.textContent = content;
    return element;
  }

  function renderRow(row, sequence) {
    const item = node('li', 'audit-event');
    const number = node('span', 'audit-event-number', String(sequence));
    number.setAttribute('aria-label', `第 ${sequence} 条`);
    item.append(number);
    const body = node('div', 'audit-event-body');
    const time = node('time', 'audit-event-time');
    const parsed = new Date(row.createdAt);
    time.textContent = Number.isNaN(parsed.getTime()) ? '时间未记录' : parsed.toLocaleString('zh-CN', { hour12: false });
    if (!Number.isNaN(parsed.getTime())) time.dateTime = parsed.toISOString();
    body.append(time, node('h4', 'audit-event-title', actionTitle(row)));
    const object = node('p', 'audit-event-object', `操作对象：${row.targetTypeName || '其他记录'}${row.targetName ? `「${row.targetName}」` : ''}`);
    const role = ROLES[row.actorRole] || '原角色不可查';
    const actor = node('p', 'audit-event-actor', `操作人：${row.actorName || '原工作人员（账号已不可用）'} · ${row.actorRole === 'system' ? role : `当前角色：${role}`}`);
    body.append(object, actor);
    const detail = node('details', 'audit-event-detail');
    detail.append(node('summary', '', '查看排查信息'));
    const technical = node('p', '', `操作代码：${row.action || '无'} · 对象编号：${row.targetId || '无'} · 操作人编号：${row.actorId || '无'}`);
    detail.append(technical);
    body.append(detail);
    item.append(body);
    return item;
  }

  async function mount({ call }) {
    const timeline = document.getElementById('auditTimeline');
    const feedback = document.getElementById('auditFeedback');
    const count = document.getElementById('auditCount');
    const more = document.getElementById('auditLoadMore');
    if (!timeline || !feedback || !count || !more) return;
    let page = 1;
    let busy = false;
    let total = 0;
    async function load() {
      if (busy) return;
      busy = true;
      more.disabled = true;
      feedback.hidden = false;
      feedback.classList.remove('is-error');
      feedback.textContent = page === 1 ? '正在读取操作记录…' : '正在读取更早记录…';
      try {
        const result = await call('admin.audit.list', { page, pageSize: PAGE_SIZE });
        const rows = Array.isArray(result.rows) ? result.rows : [];
        total = Number(result.total) || 0;
        const start = timeline.children.length;
        for (const [index, row] of rows.entries()) timeline.append(renderRow(row, start + index + 1));
        count.textContent = `共 ${total} 条真实记录`;
        feedback.hidden = Boolean(timeline.children.length);
        if (!timeline.children.length) feedback.textContent = '目前没有操作记录。';
        more.hidden = timeline.children.length >= total || rows.length < PAGE_SIZE;
        more.textContent = '查看更早记录';
        page += 1;
      } catch (error) {
        count.textContent = timeline.children.length ? `已显示 ${timeline.children.length} 条` : '暂不可用';
        feedback.hidden = false;
        feedback.classList.add('is-error');
        feedback.textContent = `记录读取失败：${error?.message || '请稍后重试。'} 未加载的记录不会被当作空记录。`;
        more.hidden = false;
        more.textContent = '重试读取';
      } finally {
        busy = false;
        more.disabled = false;
      }
    }
    more.addEventListener('click', load);
    await load();
  }

  global.MengshixianAdminAuditTimeline = Object.freeze({ mount });
}(window, document));
