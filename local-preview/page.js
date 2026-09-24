(function (global, document) {
  if (!/\/login\.html$/.test(global.location.pathname)) return;
  const form = document.querySelector('#loginForm');
  if (!form) return;
  const entry = document.createElement('section');
  entry.className = 'local-practice-entry';
  entry.setAttribute('aria-label', '本机练习入口');
  const heading = document.createElement('h2');
  heading.textContent = '先进入本机练习';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'primary';
  button.textContent = '一键进入本机练习后台';
  const note = document.createElement('p');
  note.textContent = '原来的云端账号和密码不能用于本机练习。这里的资料也不会同步到友方云端。';
  entry.append(heading, button, note);
  form.before(entry);

  const staffHint = document.createElement('p');
  staffHint.className = 'local-practice-form-intro';
  staffHint.textContent = '练习运营登录？请使用本机管理员在“工作人员”页面创建的账号。';
  form.before(staffHint);
  const username = form.querySelector('input[name="username"]');
  const password = form.querySelector('input[name="password"]');
  if (username) username.closest('label').firstChild.textContent = '本机工作人员账号';
  if (password) password.closest('label').firstChild.textContent = '本机工作人员密码';
  const staffSubmit = form.querySelector('button[type="submit"]');
  staffSubmit.textContent = '使用本机工作人员账号登录';
  staffSubmit.classList.replace('primary', 'local-practice-staff-submit');
  const bootstrapHint = form.nextElementSibling;
  if (bootstrapHint?.classList.contains('muted')) bootstrapHint.hidden = true;
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = '正在进入本机练习后台…';
    try {
      const response = await fetch('/__local/session', { method: 'POST' });
      const result = await response.json();
      if (!response.ok || !result.token) throw new Error(result.error?.message || '本机练习登录失败。');
      global.MengshixianAdminApi.setToken(result.token);
      global.location.assign('index.html');
    } catch (error) {
      const message = document.querySelector('#loginMessage');
      if (message) message.textContent = error.message;
      button.disabled = false;
      button.textContent = '重试进入本机练习后台';
    }
  });
}(window, document));
