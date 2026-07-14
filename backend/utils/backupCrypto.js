/**
 * Shared AES-256-GCM helpers for encrypted Postgres backups.
 */
const crypto = require('crypto');
const fs = require('fs');

function deriveBackupKey(secret) {
  const key = String(secret || '');
  if (!key || key.length < 32) {
    throw new Error('BACKUP_ENCRYPTION_KEY must be set to a secret of at least 32 characters.');
  }
  return crypto.createHash('sha256').update(key).digest();
}

function encryptBuffer(plain, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
}

function decryptBuffer(blob, key) {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const data = blob.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function encryptFile(plainPath, encPath, key) {
  const input = fs.readFileSync(plainPath);
  fs.writeFileSync(encPath, encryptBuffer(input, key));
}

function decryptFile(encPath, plainPath, key) {
  const blob = fs.readFileSync(encPath);
  fs.writeFileSync(plainPath, decryptBuffer(blob, key));
}

module.exports = {
  deriveBackupKey,
  encryptBuffer,
  decryptBuffer,
  encryptFile,
  decryptFile,
};
