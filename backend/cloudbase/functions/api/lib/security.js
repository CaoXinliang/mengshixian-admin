const crypto = require('crypto');

function randomId(prefix) {
  return `${prefix || 'id'}_${crypto.randomBytes(18).toString('hex')}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function hashPassword(password, salt) {
  const actualSalt = salt || crypto.randomBytes(16).toString('hex');
  return { salt: actualSalt, passwordHash: crypto.scryptSync(String(password), actualSalt, 64).toString('hex') };
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyPassword(password, record) {
  if (!record || !record.salt || !record.passwordHash) return false;
  return safeEqual(hashPassword(password, record.salt).passwordHash, record.passwordHash);
}

function encryptText(value, secret) {
  if (!secret || String(secret).length < 16) throw new Error('PII_ENCRYPTION_KEY_MISSING');
  const key = crypto.createHash('sha256').update(String(secret)).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

function decryptText(value, secret) {
  if (!secret || String(secret).length < 16) throw new Error('PII_ENCRYPTION_KEY_MISSING');
  const [version, ivValue, tagValue, ciphertextValue] = String(value || '').split('.');
  if (version !== 'v1' || !ivValue || !tagValue || !ciphertextValue) throw new Error('PII_CIPHERTEXT_INVALID');
  const key = crypto.createHash('sha256').update(String(secret)).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextValue, 'base64url')), decipher.final()]).toString('utf8');
}

module.exports = { randomId, sha256, hashPassword, safeEqual, verifyPassword, encryptText, decryptText };
