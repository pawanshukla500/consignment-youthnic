/**
 * M3 CORS allowlist tests.
 * Run: node scripts/test-cors-allowlist.js
 */
const assert = require('assert');
const { isOriginAllowed, parseAllowedOrigins } = require('../utils/corsAllowlist');

const prev = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';

const allowed = [
  'https://consignment.youthnic.shop',
  'https://consignment-packing-app.web.app',
];

assert.strictEqual(isOriginAllowed(undefined, allowed), true);
assert.strictEqual(isOriginAllowed('https://consignment.youthnic.shop', allowed), true);
assert.strictEqual(isOriginAllowed('https://evil-app-xyz.run.app', allowed), false);
assert.strictEqual(isOriginAllowed('https://consignment.youthnic.shop.evil.com', allowed), false);
assert.strictEqual(isOriginAllowed('https://lookalike-youthnic.shop', allowed), false);

process.env.NODE_ENV = 'development';
assert.strictEqual(isOriginAllowed('http://localhost:5173', []), true);

assert.deepStrictEqual(
  parseAllowedOrigins('https://a.example.com, https://b.example.com'),
  ['https://a.example.com', 'https://b.example.com']
);

process.env.NODE_ENV = prev;
console.log('M3 CORS allowlist tests passed.');
