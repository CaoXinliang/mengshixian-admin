(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MengshixianAdminMoney = api;
}(typeof window !== 'undefined' ? window : null, function () {
  function toCents(value, label = '金额') {
    const raw = String(value == null ? '' : value).trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) throw new Error(`${label}请填写非负的元金额，最多两位小数。`);
    const [whole, decimals = ''] = raw.split('.');
    const cents = Number(whole) * 100 + Number(decimals.padEnd(2, '0'));
    if (!Number.isSafeInteger(cents)) throw new Error(`${label}过大。`);
    return cents;
  }
  function toYuan(cents) {
    if (!Number.isSafeInteger(Number(cents)) || Number(cents) < 0) throw new Error('已有金额不合法。');
    return (Number(cents) / 100).toFixed(2);
  }
  return { toCents, toYuan };
}));
