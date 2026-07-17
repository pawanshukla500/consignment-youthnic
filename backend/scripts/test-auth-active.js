/**
 * M1 auth gate unit checks (token version helper).
 * Run: node scripts/test-auth-active.js
 */
require('./ensureTestEnv');
const assert = require('assert');
const { currentTokenVersion } = require('../middleware/auth');

assert.strictEqual(currentTokenVersion({}), 1);
assert.strictEqual(currentTokenVersion({ tokenVersion: 3 }), 3);
assert.strictEqual(currentTokenVersion({ tokenVersion: '2' }), 2);
assert.strictEqual(currentTokenVersion({ tokenVersion: 0 }), 1);

console.log('M1 auth tokenVersion helper tests passed.');
