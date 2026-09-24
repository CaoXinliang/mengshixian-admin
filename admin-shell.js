(function mountAdminShell(global, document) {
  const registry = global.MengshixianAdminPages;
  const page = registry && registry.pages[global.PAGE_NAME || 'overview'];
  const sidebar = document.getElementById('adminSidebar');
  const header = document.getElementById('adminHeader');
  if (!page || !sidebar || !header) return;
  const icons = {
    overview: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    catalog: '<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="M3 7v10l9 5 9-5V7M12 12v10"/>',
    trade: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 3.5h6M9 9h6M9 13h6M9 17h4"/>',
    fulfillment: '<path d="M3 9 12 3l9 6v12H3V9Z"/><path d="M3 10h18M8 21v-8h8v8"/>',
    customers: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M17 6a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 5"/>',
    content: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m3 17 5-5 3 3 3-4 7 7"/>',
    marketing: '<path d="M3 10V4h7l11 11-6 6L3 10Z"/><circle cx="7.5" cy="7.5" r="1"/>',
    system: '<circle cx="12" cy="12" r="3"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'
  };
  const icon = (id) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[id]}</svg>`;

  const advancedPageIds = new Set(['categories', 'pricing', 'warehouses', 'banners', 'sections', 'businesses', 'users', 'groups', 'access', 'audit']);
  const primaryGroups = registry.groups.map((group) => ({ ...group, pages: group.pages.filter(([id]) => !advancedPageIds.has(id)) })).filter((group) => group.pages.length);
  const advancedGroups = registry.groups.map((group) => ({ ...group, pages: group.pages.filter(([id]) => advancedPageIds.has(id)) })).filter((group) => group.pages.length);
  const navGroup = (group, section) => {
    const active = group.pages.some(([id]) => id === page.id);
    const first = group.pages[0];
    const children = group.pages.length > 1 ? `<div class="nav-children" id="nav-${section}-${group.id}">${group.pages.map(([id, title, href]) => `<a href="${href}"${id === page.id ? ' class="is-active" aria-current="page"' : ''}>${title}</a>`).join('')}</div>` : '';
    return `<div class="nav-group${active ? ' is-open' : ''}"><a class="nav-parent${active ? ' is-active' : ''}" href="${first[2]}"${active && group.pages.length === 1 ? ' aria-current="page"' : ''}><span class="module-mark" aria-hidden="true">${icon(group.id)}</span><strong>${group.label}</strong>${children ? '<span class="arrow" aria-hidden="true">›</span>' : ''}</a>${children}</div>`;
  };
  const primaryNav = primaryGroups.map((group) => navGroup(group, 'daily')).join('');
  const advancedNav = advancedGroups.length ? `<details class="sidebar-advanced"${advancedPageIds.has(page.id) ? ' open' : ''}><summary>高级管理</summary><div class="sidebar-advanced-list">${advancedGroups.map((group) => navGroup(group, 'advanced')).join('')}</div></details>` : '';
  const nav = primaryNav + advancedNav;

  sidebar.innerHTML = `<a class="brand" href="index.html"><img src="assets/logo.png" alt="" class="brand-logo"><span><strong>梦食鲜</strong><small>经营管理后台</small></span></a><p class="nav-caption">经营中枢</p><nav id="mainNav" aria-label="后台业务模块">${nav}</nav><div class="sidebar-footer"><button class="logout" id="logoutButton" type="button">退出登录</button></div>`;
  header.innerHTML = `<div class="header-title"><p class="eyebrow" id="moduleEyebrow"></p><h2 id="panelTitle"></h2></div><div class="workspace-actions"><label class="header-search"><span class="sr-only">搜索后台页面</span><input id="adminPageSearch" list="adminPageOptions" placeholder="搜索后台页面" autocomplete="off"></label><datalist id="adminPageOptions">${Object.values(registry.pages).map((item) => `<option value="${item.title}"></option>`).join('')}</datalist><span class="service-state" id="adminConnectionState"><i></i>连接中</span><span class="admin-user" id="adminUser" aria-live="polite">身份待验证</span><button class="admin-account-logout" id="adminAccountLogout" type="button">退出登录</button></div>`;
  if (page.id !== 'overview') {
    const sectionGroups = advancedPageIds.has(page.id) ? advancedGroups : primaryGroups;
    const siblings = sectionGroups.find((group) => group.pages.some(([id]) => id === page.id)).pages;
    const links = siblings.length > 1 ? `<nav aria-label="${page.groupLabel}页面" class="page-links">${siblings.map(([id, title, href]) => `<a href="${href}"${id === page.id ? ' aria-current="page"' : ''}>${title}</a>`).join('')}</nav>` : '';
    document.getElementById('globalMessage').insertAdjacentHTML('afterend', `<div class="page-intro"><div><p class="eyebrow">${page.groupLabel}</p><h1>${page.title}</h1><p>${page.description}</p></div>${links}</div>`);
  }
  const search = document.getElementById('adminPageSearch');
  search.addEventListener('change', () => {
    const target = Object.values(registry.pages).find((item) => item.title === search.value.trim());
    if (target) global.location.assign(target.href);
  });
  function setAdmin(admin) {
    const node = document.getElementById('adminUser');
    if (!node) return;
    if (!admin) { node.textContent = '身份待验证'; return; }
    const name = admin.displayName || admin.username || '当前账号';
    const role = { super_admin: '超级管理员', operator: '运营', legacy: '历史账号' }[admin.role] || '角色待核对';
    const phone = admin.phoneMasked || '手机号未登记';
    const verified = admin.phoneVerificationStatus === 'verified' ? '手机号已验证' : '手机号未验证';
    node.textContent = `${name} · ${role} · ${phone} · ${verified}`;
  }
  let logoutOptions;
  let logoutBound = false;
  let logoutBusy = false;
  function logoutButtons() {
    return [document.getElementById('adminAccountLogout'), document.getElementById('logoutButton')].filter(Boolean);
  }
  function bindLogout(options) {
    if (!options || typeof options.call !== 'function' || typeof options.clearSession !== 'function') throw new TypeError('退出入口需要请求与清理会话方法。');
    logoutOptions = options;
    if (logoutBound) return;
    logoutBound = true;
    const report = (text, error) => {
      if (typeof logoutOptions.message === 'function') logoutOptions.message(text, error);
      else {
        const node = document.getElementById('globalMessage');
        if (node) node.textContent = text;
      }
    };
    const onLogout = async (event) => {
      event.preventDefault();
      // Old pages may still have a direct footer listener; the shared handler owns both buttons.
      event.stopImmediatePropagation();
      if (logoutBusy) return;
      logoutBusy = true;
      logoutButtons().forEach((button) => { button.disabled = true; });
      try {
        await logoutOptions.call('admin.logout', {});
        logoutOptions.clearSession();
        global.location.replace('login.html');
      } catch (error) {
        if (error && ['ADMIN_SESSION_EXPIRED', 'ADMIN_UNAUTHORIZED'].includes(error.code)) {
          logoutOptions.clearSession();
          global.location.replace('login.html');
        } else report('退出未完成，当前登录状态可能仍有效。请检查连接后重试。', true);
      } finally {
        logoutBusy = false;
        logoutButtons().forEach((button) => { button.disabled = false; });
      }
    };
    logoutButtons().forEach((button) => button.addEventListener('click', onLogout, { capture: true }));
  }
  global.MengshixianAdminAccount = { setAdmin, bindLogout };
}(window, document));
