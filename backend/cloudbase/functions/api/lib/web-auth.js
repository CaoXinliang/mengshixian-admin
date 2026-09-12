const { fail } = require('./response');
const { randomId, sha256, hashPassword, verifyPassword } = require('./security');
const { stableDocumentId } = require('./transaction-ids');

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const LOCK_MS = 30 * 60 * 1000;

function normalizeLoginId(value) {
  const loginId = String(value || '').trim().toLowerCase();
  if (!loginId || loginId.length > 80 || !/^[a-z0-9_.@+-一-鿿]+$/i.test(loginId)) fail('VALIDATION_ERROR', '网页登录标识不合法。');
  return loginId;
}
function accountId(loginId) { return stableDocumentId('web_login', [normalizeLoginId(loginId)]); }
function maskedLoginId(loginId) { const value = String(loginId || ''); if (/^1\d{10}$/.test(value)) return `${value.slice(0, 3)}****${value.slice(-4)}`; if (value.length <= 3) return `${value[0] || ''}**`; return `${value.slice(0, 2)}***${value.slice(-1)}`; }
function safeAccount(account) { return { _id: account._id, userId: account.userId, loginIdMasked: account.loginIdMasked, status: account.status, failedAttempts: Number(account.failedAttempts || 0), lockedUntil: account.lockedUntil || '', lastLoginAt: account.lastLoginAt || '', createdAt: account.createdAt, updatedAt: account.updatedAt }; }

async function resolveSession({ store, sessionToken, now }) {
  const token = String(sessionToken || '').trim();
  if (!token || token.length > 256) fail('AUTH_SESSION_EXPIRED', '网页会话已失效，请重新登录。');
  const session = await store.findOne('web_user_sessions', { tokenHash: sha256(token), status: 'active' });
  if (!session || new Date(session.expiresAt).getTime() <= now.getTime()) fail('AUTH_SESSION_EXPIRED', '网页会话已失效，请重新登录。');
  const account = await store.getById('web_login_accounts', session.accountId);
  const user = account && await store.getById('users', account.userId);
  if (!account || !user) fail('AUTH_SESSION_EXPIRED', '网页会话已失效，请重新登录。');
  if (account.status !== 'active' || user.status !== 'active') fail('AUTH_ACCOUNT_DISABLED', '网页账号或用户已停用。');
  if (Number(session.passwordVersion || 0) !== Number(account.passwordVersion || 0) || account.sessionsRevokedAt && new Date(session.createdAt).getTime() <= new Date(account.sessionsRevokedAt).getTime()) fail('AUTH_SESSION_EXPIRED', '网页会话已失效，请重新登录。');
  return { user, account, session };
}

async function login({ store, payload, now }) {
  if (typeof store.runTransaction !== 'function') fail('TRANSACTION_NOT_AVAILABLE', '当前环境不支持登录事务。');
  const loginId = normalizeLoginId(payload.loginId || payload.username || payload.phone);
  const password = String(payload.password || '');
  if (password.length < 10 || password.length > 128) fail('AUTH_INVALID_CREDENTIALS', '登录标识或密码错误。');
  const token = randomId('wus'); const timestamp = now.toISOString();
  const result = await store.runTransaction(async (tx) => {
    const account = await tx.getById('web_login_accounts', accountId(loginId));
    if (!account) fail('AUTH_INVALID_CREDENTIALS', '登录标识或密码错误。');
    if (account.status !== 'active') fail('AUTH_ACCOUNT_DISABLED', '网页账号已停用。');
    if (account.lockedUntil && new Date(account.lockedUntil).getTime() > now.getTime()) fail('AUTH_ACCOUNT_LOCKED', '登录失败次数过多，请稍后再试。');
    const windowActive = account.failureWindowStartedAt && now.getTime() - new Date(account.failureWindowStartedAt).getTime() < LOGIN_WINDOW_MS;
    if (!verifyPassword(password, account)) {
      const failedAttempts = (windowActive ? Number(account.failedAttempts || 0) : 0) + 1;
      const patch = { failedAttempts, failureWindowStartedAt: windowActive ? account.failureWindowStartedAt : timestamp, updatedAt: timestamp };
      if (failedAttempts >= LOGIN_MAX_FAILURES) patch.lockedUntil = new Date(now.getTime() + LOCK_MS).toISOString();
      await tx.update('web_login_accounts', account._id, patch);
      return { errorCode: failedAttempts >= LOGIN_MAX_FAILURES ? 'AUTH_ACCOUNT_LOCKED' : 'AUTH_INVALID_CREDENTIALS' };
    }
    const user = await tx.getById('users', account.userId);
    if (!user || user.status !== 'active') fail('AUTH_ACCOUNT_DISABLED', '用户已停用。');
    const session = { _id: stableDocumentId('web_session', [sha256(token)]), accountId: account._id, userId: user._id, tokenHash: sha256(token), passwordVersion: Number(account.passwordVersion || 1), status: 'active', createdAt: timestamp, expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(), updatedAt: timestamp };
    await tx.set('web_user_sessions', session._id, session);
    await tx.update('web_login_accounts', account._id, { failedAttempts: 0, failureWindowStartedAt: '', lockedUntil: '', lastLoginAt: timestamp, updatedAt: timestamp });
    return { sessionToken: token, expiresAt: session.expiresAt, user, account: { ...account, lastLoginAt: timestamp } };
  });
  if (result.errorCode) fail(result.errorCode, result.errorCode === 'AUTH_ACCOUNT_LOCKED' ? '登录失败次数过多，请稍后再试。' : '登录标识或密码错误。');
  return result;
}

async function logout({ store, sessionToken, now }) { const context = await resolveSession({ store, sessionToken, now }); await store.update('web_user_sessions', context.session._id, { status: 'revoked', revokedAt: now.toISOString(), updatedAt: now.toISOString() }); return { loggedOut: true }; }

async function changePassword({ store, sessionToken, payload, now }) {
  const context = await resolveSession({ store, sessionToken, now }); const currentPassword = String(payload.currentPassword || ''); const newPassword = String(payload.newPassword || '');
  if (!verifyPassword(currentPassword, context.account)) fail('AUTH_INVALID_CREDENTIALS', '当前密码错误。'); if (newPassword.length < 10 || newPassword.length > 128) fail('VALIDATION_ERROR', '新密码必须为 10 到 128 个字符。');
  const password = hashPassword(newPassword); const passwordVersion = Number(context.account.passwordVersion || 1) + 1; const timestamp = now.toISOString(); await store.update('web_login_accounts', context.account._id, { ...password, passwordVersion, sessionsRevokedAt: timestamp, updatedAt: timestamp }); return { passwordChanged: true, reloginRequired: true };
}

async function upsertAccount({ store, admin, payload, now }) {
  const userId = String(payload.userId || '').trim(); const loginId = normalizeLoginId(payload.loginId || payload.username || payload.phone); const id = accountId(loginId); const existing = await store.getById('web_login_accounts', id); const user = await store.getById('users', userId);
  if (!user) fail('USER_NOT_FOUND', '用户不存在。'); if (existing && existing.userId !== userId) fail('WEB_LOGIN_ID_TAKEN', '该网页登录标识已被使用。');
  const passwordText = String(payload.password || ''); if (!existing && (passwordText.length < 10 || passwordText.length > 128)) fail('VALIDATION_ERROR', '创建网页账号时必须设置 10 到 128 个字符的初始密码。');
  const timestamp = now.toISOString(); const password = passwordText ? hashPassword(passwordText) : { salt: existing.salt, passwordHash: existing.passwordHash };
  const row = { _id: id, userId, loginIdNormalized: loginId, loginIdMasked: maskedLoginId(loginId), ...password, passwordVersion: Number(existing && existing.passwordVersion || 0) + (passwordText ? 1 : 0), sessionsRevokedAt: passwordText && existing ? timestamp : existing && existing.sessionsRevokedAt || '', status: payload.status === 'disabled' ? 'disabled' : (payload.status === 'active' ? 'active' : existing && existing.status || 'active'), failedAttempts: 0, failureWindowStartedAt: '', lockedUntil: '', createdBy: existing && existing.createdBy || admin._id, updatedBy: admin._id, createdAt: existing && existing.createdAt || timestamp, updatedAt: timestamp };
  await store.set('web_login_accounts', id, row); return safeAccount(row);
}

async function setStatus({ store, admin, payload, now }) { const id = String(payload.id || '').trim(); const status = ['active', 'disabled'].includes(payload.status) ? payload.status : ''; if (!id || !status) fail('VALIDATION_ERROR', '网页账号状态参数不合法。'); const account = await store.getById('web_login_accounts', id); if (!account) fail('WEB_ACCOUNT_NOT_FOUND', '网页账号不存在。'); const timestamp = now.toISOString(); const patch = { status, updatedBy: admin._id, updatedAt: timestamp, sessionsRevokedAt: status === 'disabled' ? timestamp : account.sessionsRevokedAt || '' }; await store.update('web_login_accounts', id, patch); return safeAccount({ ...account, ...patch }); }

async function resetPassword({ store, admin, payload, now }) { const id = String(payload.id || '').trim(); const passwordText = String(payload.newPassword || ''); if (!id || passwordText.length < 10 || passwordText.length > 128) fail('VALIDATION_ERROR', '账号 ID 或新密码不合法。'); const account = await store.getById('web_login_accounts', id); if (!account) fail('WEB_ACCOUNT_NOT_FOUND', '网页账号不存在。'); const timestamp = now.toISOString(); const patch = { ...hashPassword(passwordText), passwordVersion: Number(account.passwordVersion || 1) + 1, sessionsRevokedAt: timestamp, failedAttempts: 0, failureWindowStartedAt: '', lockedUntil: '', updatedBy: admin._id, updatedAt: timestamp }; await store.update('web_login_accounts', id, patch); return safeAccount({ ...account, ...patch }); }

module.exports = { SESSION_TTL_MS, normalizeLoginId, safeAccount, resolveSession, login, logout, changePassword, upsertAccount, setStatus, resetPassword };
