/**
 * Unit tests for login-path helpers and session-validation cache contracts.
 * Run: node scripts/test-login-path.js
 */
const assert = require('assert');
const {
  shouldCheckRevoked,
  buildSessionUserFromAuth,
  summarizeLoginTimings,
} = require('../utils/loginPath');

assert.strictEqual(shouldCheckRevoked({}), false);
assert.strictEqual(shouldCheckRevoked({ AUTH_CHECK_REVOKED: 'true' }), true);
assert.strictEqual(shouldCheckRevoked({ AUTH_CHECK_REVOKED: '1' }), true);
assert.strictEqual(shouldCheckRevoked({ AUTH_CHECK_REVOKED: 'false' }), false);

const session = buildSessionUserFromAuth(
  {
    id: 'u1',
    email: 'a@b.com',
    name: 'A',
    role: 'packer',
    permissions: { packing: true },
    warehouseId: 'w1',
  },
  { uid: 'fb-1' },
  () => '2026-01-01T00:00:00.000Z'
);

assert.strictEqual(session.firebaseUid, 'fb-1');
assert.strictEqual(session.lastLoginAt, '2026-01-01T00:00:00.000Z');
assert.strictEqual(session.warehouseId, 'w1');
assert.strictEqual(session.isActive, true);

const summary = summarizeLoginTimings({ verifyIdTokenMs: 120, userLookupMs: 40, issueTokenMs: 5 });
assert.strictEqual(summary.totalMs, 165);
assert.strictEqual(summary.stages.verifyIdTokenMs, 120);

// Source-level contract: firebase-login must not force revocation checks by default.
const fs = require('fs');
const path = require('path');
const authSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
assert.ok(authSrc.includes('shouldCheckRevoked'), 'auth.js should use shouldCheckRevoked()');
assert.ok(!/verifyIdToken\(\s*idToken\s*,\s*true\s*\)/.test(authSrc), 'auth.js must not hard-code checkRevoked=true');
assert.ok(authSrc.includes('loadDefaultAdminForSession'), 'auth.js should use loadDefaultAdminForSession');
assert.ok(authSrc.includes('setImmediate'), 'auth.js should defer non-critical login writes');

const frontendAuth = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', 'context', 'AuthContext.jsx'),
  'utf8'
);
assert.ok(frontendAuth.includes('queueLiveSyncRefresh'), 'AuthContext should queue live sync in background');
assert.ok(frontendAuth.includes('markSessionValidated'), 'AuthContext should mark session validated after login');
assert.ok(!/await refreshLiveSyncToken\(\)/.test(frontendAuth), 'AuthContext must not await live sync on the login critical path');

console.log('Login path optimization tests passed.');
