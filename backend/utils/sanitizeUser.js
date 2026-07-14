/**
 * User record sanitization — never persist or expose authentication secrets.
 * Passwords live only in Firebase Authentication.
 */

const SENSITIVE_USER_KEYS = [
  'password',
  'password_hash',
  'passwordHash',
  'hashedPassword',
  'hash',
  'currentPassword',
  'newPassword',
  'plainPassword',
  'tempPassword',
  'resetToken',
  'reset_token',
  'refreshToken',
  'refresh_token',
  'idToken',
  'id_token',
];

function stripSensitiveKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const out = { ...value };
  for (const key of SENSITIVE_USER_KEYS) {
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      delete out[key];
    }
  }
  return out;
}

/** Profile safe to write to documents / users.source_document. */
function sanitizeUserForStorage(user = {}) {
  return stripSensitiveKeys(user);
}

/** Profile safe to return from APIs / include in JWT payloads / audit details. */
function sanitizeUserForApi(user = {}, extras = {}) {
  const safe = stripSensitiveKeys(user);
  return {
    ...safe,
    ...extras,
  };
}

function assertNoSensitiveUserFields(payload, context = 'payload') {
  if (!payload || typeof payload !== 'object') return;
  const found = SENSITIVE_USER_KEYS.filter((key) =>
    Object.prototype.hasOwnProperty.call(payload, key) && payload[key] != null && payload[key] !== ''
  );
  if (found.length) {
    throw new Error(`[SECURITY] Sensitive user fields leaked in ${context}: ${found.join(', ')}`);
  }
}

module.exports = {
  SENSITIVE_USER_KEYS,
  stripSensitiveKeys,
  sanitizeUserForStorage,
  sanitizeUserForApi,
  assertNoSensitiveUserFields,
};
