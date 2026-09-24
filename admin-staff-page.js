(function (global, document) {
  const owners = new WeakMap();
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const roleName = role => role === 'super_admin' ? '超级管理员' : role === 'operator' ? '运营' : '历史账号';
  const verified = user => user.phoneVerificationStatus === 'verified' && user.phoneVerifiedAt ? '已验证' : '未验证（尚未接入真实手机验证）';
  const isOwner = admin => admin && (admin.role === 'super_admin' || (admin.permissions || []).includes('*'));
  const option = (value, label, selected) => `<option value="${value}"${selected ? ' selected' : ''}>${label}</option>`;

  async function mount({call, admin, message}) {
    const host = document.getElementById('staffPage');
    if (!host) return;
    const owner = {};
    owners.set(host, owner);
    const state = {call, admin, message: typeof message === 'function' ? message : () => {}, users: [], selectedId: admin.id, mode: 'detail', pending: null, draft: null, busy: false, error: ''};
    const current = () => owners.get(host) === owner;
    const selected = () => state.users.find(user => user.id === state.selectedId) || admin;
    const notify = (value, error = false) => { state.error = error ? value : ''; state.message(value, error); };

    function detail(user) {
      return `<div class="card staff-detail"><h3>${escape(user.displayName || user.username || '我的账号')}</h3><dl>
        <div><dt>账号 ID（只读）</dt><dd><code>${escape(user.id)}</code></dd></div>
        <div><dt>登录账号</dt><dd>${escape(user.username)}</dd></div>
        <div><dt>角色</dt><dd>${escape(roleName(user.role))}</dd></div>
        <div><dt>状态</dt><dd>${user.status === 'disabled' ? '已停用' : '启用'}</dd></div>
        <div><dt>手机号</dt><dd>${escape(user.phoneMasked || '未登记')}</dd></div>
        <div><dt>手机验证</dt><dd>${escape(verified(user))}</dd></div>
      </dl>${user.role === 'legacy' ? `<p class="staff-warning">历史账号保留原有权限；只有明确选择新角色并保存，才转换为固定角色。</p><p class="staff-muted">历史权限：${escape((user.permissions || []).join('、') || '无')}</p>` : ''}
      ${isOwner(admin) ? `<div class="staff-actions"><button type="button" data-staff-action="edit">编辑资料</button><button type="button" data-staff-action="reset">重置密码</button></div>` : ''}</div>`;
    }
    function editForm(user, creating) {
      const kind = creating ? 'create' : 'update';
      const draft = state.draft && state.draft.kind === kind ? state.draft : {};
      return `<form class="card staff-form" data-staff-form="${creating ? 'create' : 'update'}"><h3>${creating ? '新增工作人员' : `编辑 ${escape(user.displayName || user.username)}`}</h3>
        ${creating ? '' : `<p>账号 ID（只读）：<code>${escape(user.id)}</code></p>`}
        <label>登录账号<input name="username" maxlength="40" required ${creating ? '' : 'readonly'} value="${escape(creating ? draft.username || '' : user.username)}"></label>
        <label>姓名<input name="displayName" maxlength="40" required value="${escape(draft.displayName === undefined ? creating ? '' : user.displayName : draft.displayName)}"></label>
        <label>手机号<input name="phone" inputmode="tel" pattern="1[0-9]{10}" maxlength="11" ${creating ? 'required' : ''} value="${escape(draft.phone || '')}" placeholder="${creating ? '11 位手机号' : '留空保持原手机号'}"></label>
        <p class="staff-muted">当前：${escape(creating ? '未登记' : user.phoneMasked || '未登记')}；${escape(creating ? '保存后保持未验证' : verified(user))}。更换号码后自动变为未验证。</p>
        <label>角色<select name="role" ${creating ? 'required' : ''}>${creating ? option('', '请选择角色', !draft.role) : option('', user.role === 'legacy' ? '保留历史角色（不转换）' : '保持当前角色', !draft.role)}${option('super_admin', '超级管理员', draft.role === 'super_admin')}${option('operator', '运营', draft.role === 'operator')}</select></label>
        ${creating ? '<label>初始密码<input name="password" type="password" autocomplete="new-password" minlength="12" required></label>' : ''}
        <label>状态<select name="status">${option('active','启用',draft.status ? draft.status === 'active' : creating || user.status !== 'disabled')}${option('disabled','停用',draft.status ? draft.status === 'disabled' : !creating && user.status === 'disabled')}</select></label>
        <div class="staff-actions"><button type="submit" class="primary">${creating ? '创建工作人员' : '保存修改'}</button><button type="button" data-staff-action="detail">取消</button></div></form>`;
    }
    function passwordForm(own) {
      const user = selected();
      return `<form class="card staff-form" data-staff-form="${own ? 'own-password' : 'reset-password'}"><h3>${own ? '修改我的密码' : `重置 ${escape(user.displayName || user.username)} 的密码`}</h3>
        ${own ? '<label>当前密码<input name="currentPassword" type="password" autocomplete="current-password" required></label>' : `<p>账号 ID（只读）：<code>${escape(user.id)}</code></p><p class="staff-warning">请核对账号对象。重置后其全部旧会话将失效。</p>`}
        <label>新密码<input name="newPassword" type="password" autocomplete="new-password" minlength="12" required></label>
        <label>确认新密码<input name="confirmPassword" type="password" autocomplete="new-password" minlength="12" required></label>
        <div class="staff-actions"><button type="submit" class="primary">${own ? '修改密码' : '重置密码'}</button><button type="button" data-staff-action="detail">取消</button></div></form>`;
    }
    function render() {
      if (!current()) return;
      const ownerMode = isOwner(admin);
      const user = selected();
      host.innerHTML = `<div class="staff-page"><div class="staff-head"><div><h2>账号与权限</h2><p>${ownerMode ? '按姓名或登录账号选择工作人员；新账号仅提供两种固定角色。' : '只可查看自己的账号资料和修改本人密码。'}</p></div><div class="staff-actions">${ownerMode ? '<button type="button" data-staff-action="create">新增工作人员</button>' : ''}<button type="button" data-staff-action="own-password">修改我的密码</button></div></div>
        ${state.error ? `<p class="staff-error" role="alert">${escape(state.error)}</p>` : ''}
        <div class="staff-grid${ownerMode ? '' : ' staff-grid-self'}">${ownerMode ? `<div class="card"><h3>工作人员</h3><div class="staff-list">${state.users.map(item => `<button type="button" data-staff-select="${escape(item.id)}" aria-current="${item.id === state.selectedId}"><span>${escape(item.displayName || item.username)}<small> · ${escape(item.username)}</small></span><span>${escape(roleName(item.role))}</span></button>`).join('')}</div></div>` : ''}<div>
        ${state.pending ? `<div class="staff-confirm" role="alertdialog"><strong>确认${escape(state.pending.label)}？</strong><p>${escape(state.pending.summary)}</p><div class="staff-actions"><button type="button" data-staff-action="confirm">确认执行</button><button type="button" data-staff-action="cancel-confirm">返回修改</button></div></div>` : state.mode === 'create' ? editForm({}, true) : state.mode === 'edit' ? editForm(user, false) : state.mode === 'reset' ? passwordForm(false) : state.mode === 'own-password' ? passwordForm(true) : detail(user)}
        </div></div></div>`;
    }
    async function refresh() {
      if (!isOwner(admin)) { state.users = [admin]; state.selectedId = admin.id; render(); return; }
      const rows = [];
      for (let page = 1; page <= 100; page++) {
        const result = await call('admin.adminUsers.list', {page, pageSize: 100});
        rows.push(...(result.rows || []));
        if (rows.length >= result.total) break;
        if (!(result.rows || []).length) throw new Error('工作人员目录未完整读取，请刷新重试。');
        if (page === 100) throw new Error('工作人员目录过大，无法完整展示。');
      }
      if (!current()) return;
      state.users = rows;
      if (!rows.some(user => user.id === state.selectedId)) state.selectedId = rows[0] && rows[0].id;
      render();
    }
    async function runPending() {
      if (!state.pending || state.busy) return;
      const pending = state.pending;
      state.busy = true;
      render();
      try {
        await call(pending.action, pending.payload);
        if (!current()) return;
        state.pending = null;
        state.draft = null;
        state.mode = 'detail';
        if (pending.action === 'admin.password.change') {
          if (global.MengshixianAdminApi) global.MengshixianAdminApi.setToken('');
          if (global.location && global.location.replace) global.location.replace('login.html');
          else render();
          return;
        }
        try {
          await refresh();
          notify(`${pending.label}成功。`);
        } catch (_) {
          notify(`${pending.label}已保存，但工作人员列表刷新失败。请刷新页面核对，不要重复提交。`, true);
          render();
        }
      } catch (error) {
        if (!current()) return;
        notify(`${error && error.message || '操作未确认。'} 请先核对账号状态；如确实未生效，可重试或返回修改。`, true);
        render();
      } finally { state.busy = false; }
    }
    host.addEventListener('click', event => {
      if (!current() || state.busy) return;
      const selection = event.target.closest('[data-staff-select]');
      if (selection && isOwner(admin)) { state.selectedId = selection.getAttribute('data-staff-select'); state.mode = 'detail'; state.pending = null; state.draft = null; state.error = ''; render(); return; }
      const button = event.target.closest('[data-staff-action]');
      if (!button) return;
      const action = button.getAttribute('data-staff-action');
      if (action === 'confirm') { runPending(); return; }
      if (action === 'cancel-confirm') { state.pending = null; render(); return; }
      if (['create','edit','reset'].includes(action) && !isOwner(admin)) return;
      state.mode = action === 'detail' ? 'detail' : action;
      state.pending = null; state.draft = null; state.error = ''; render();
    });
    host.addEventListener('submit', event => {
      const form = event.target.closest('[data-staff-form]');
      if (!form || !current() || state.busy) return;
      event.preventDefault();
      const kind = form.getAttribute('data-staff-form');
      if (kind !== 'own-password' && !isOwner(admin)) return;
      const values = new FormData(form);
      const user = selected();
      if (kind === 'create' || kind === 'update') state.draft = {kind, username: values.get('username'), displayName: values.get('displayName'), phone: values.get('phone'), role: values.get('role'), status: values.get('status')};
      let action, payload, label, summary;
      if (kind === 'create' || kind === 'update') {
        action = kind === 'create' ? 'admin.staff.create' : 'admin.staff.update';
        payload = {displayName: values.get('displayName'), status: values.get('status')};
        if (kind === 'create') Object.assign(payload, {username: values.get('username'), phone: values.get('phone'), password: values.get('password'), role: values.get('role')});
        else { payload.id = user.id; if (values.get('phone')) payload.phone = values.get('phone'); if (values.get('role')) payload.role = values.get('role'); }
        label = kind === 'create' ? '创建工作人员' : '修改工作人员';
        summary = `${kind === 'create' ? values.get('displayName') : user.displayName}（${kind === 'create' ? values.get('username') : user.username}），${roleName(values.get('role') || user.role)}，${values.get('status') === 'disabled' ? '停用' : '启用'}。`;
      } else {
        if (values.get('newPassword') !== values.get('confirmPassword')) { notify('两次输入的新密码不一致。', true); render(); return; }
        action = kind === 'own-password' ? 'admin.password.change' : 'admin.staff.resetPassword';
        payload = kind === 'own-password' ? {currentPassword: values.get('currentPassword'), newPassword: values.get('newPassword')} : {id: user.id, newPassword: values.get('newPassword')};
        label = kind === 'own-password' ? '修改本人密码' : '重置工作人员密码';
        summary = kind === 'own-password' ? '修改后所有设备需重新登录。' : `${user.displayName || user.username}（${user.username}），账号 ID ${user.id}；全部旧会话将失效。`;
      }
      state.pending = {action, payload, label, summary};
      state.error = ''; render();
    });
    try { await refresh(); } catch (error) { if (current()) { notify(error && error.message || '工作人员资料加载失败。', true); render(); } }
  }
  global.MengshixianStaffPage = {mount};
})(window, document);
