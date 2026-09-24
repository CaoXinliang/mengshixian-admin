(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MengshixianAccessGuide = api;
}(typeof window !== 'undefined' ? window : null, function () {
  function onOpen(form, state) {
    if (form.getAttribute('id') !== 'adminUserForm') return;
    const textarea = form.elements.roleIds;
    const selected = new Set(String(textarea.value || '').split(/\r?\n/).map((id) => id.trim()).filter(Boolean));
    textarea.hidden = true; textarea.required = false;
    textarea.parentElement.firstChild.textContent = '管理员角色（按名称勾选）';
    let choices = form.querySelector('.role-name-choices');
    if (!choices) { choices = form.ownerDocument.createElement('div'); choices.className = 'role-name-choices'; textarea.after(choices); }
    choices.replaceChildren();
    state.roles.filter((role) => role.status === 'active' || selected.has(role._id)).forEach((role) => {
      const label = form.ownerDocument.createElement('label');
      const input = form.ownerDocument.createElement('input');
      input.type = 'checkbox'; input.value = role._id; input.checked = selected.has(role._id);
      label.appendChild(input); label.appendChild(form.ownerDocument.createTextNode(role.name || role.code || '未命名角色'));
      choices.appendChild(label);
    });
    if (!choices.children.length) choices.textContent = '尚无可选角色，请由有权限的管理员先创建角色。';
    if (!form.__roleGuideBound) {
      choices.addEventListener('change', () => { textarea.value = [...choices.querySelectorAll('input:checked')].map((item) => item.value).join('\n'); });
      form.__roleGuideBound = true;
    }
  }
  return { onOpen };
}));
