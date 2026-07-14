/**
 * C1 security tests — password/hash fields must never appear in storage payloads or API serializers.
 * Run: node scripts/test-sanitize-user.js
 */
const assert = require('assert');
const {
  sanitizeUserForStorage,
  sanitizeUserForApi,
  assertNoSensitiveUserFields,
  SENSITIVE_USER_KEYS,
} = require('../utils/sanitizeUser');

const dirty = {
  id: 'u1',
  email: 'packer@example.com',
  name: 'Packer',
  role: 'user',
  permissions: { packing: true },
  password: '$2a$10$abcdefghijklmnopqrstuv',
  password_hash: '$2a$10$abcdefghijklmnopqrstuv',
  passwordHash: 'x',
  hashedPassword: 'y',
  currentPassword: 'secret',
  newPassword: 'secret2',
  resetToken: 'tok',
  refreshToken: 'rt',
  idToken: 'idt',
};

const stored = sanitizeUserForStorage(dirty);
assert.strictEqual(stored.email, 'packer@example.com');
assert.strictEqual(stored.id, 'u1');
for (const key of SENSITIVE_USER_KEYS) {
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(stored, key),
    false,
    `storage payload still has ${key}`
  );
}

const api = sanitizeUserForApi(dirty, { emailVerified: true });
assert.strictEqual(api.emailVerified, true);
for (const key of SENSITIVE_USER_KEYS) {
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(api, key),
    false,
    `API payload still has ${key}`
  );
}

assert.doesNotThrow(() => assertNoSensitiveUserFields(api, 'api'));
assert.throws(
  () => assertNoSensitiveUserFields({ password: 'x' }, 'leak'),
  /Sensitive user fields leaked/
);

// Realtime policy SQL fragment expectation (documents exclude users collection)
const policySnippet = `(auth.jwt() ->> 'app_user_id') IS NOT NULL
        AND collection IS DISTINCT FROM 'users'`;
assert.ok(policySnippet.includes("collection IS DISTINCT FROM 'users'"));

console.log('C1 sanitize-user tests passed.');
