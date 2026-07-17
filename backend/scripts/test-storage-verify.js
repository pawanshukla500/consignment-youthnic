/**
 * Unit tests for strict R2 object verification (pure evaluator — no live R2).
 * Run: node scripts/test-storage-verify.js
 */
const assert = require('assert');
const { evaluateStorageObjectIntegrity } = require('../utils/storage');

function meta(size, contentType = 'video/webm', etag = '"abc"') {
  return {
    size,
    metadata: { contentType, etag, versionId: 'v1' },
  };
}

const key = 'consignments/c1/boxes/box_1/video.webm';

// Correct object
let result = evaluateStorageObjectIntegrity(key, meta(12345), {
  expectedSize: 12345,
  expectedMime: 'video/webm',
  expectedKey: key,
});
assert.strictEqual(result.ok, true);
assert.strictEqual(result.verified, true);
assert.strictEqual(result.verification.actualSize, 12345);

// Missing object
result = evaluateStorageObjectIntegrity(key, null, {
  expectedSize: 10,
  expectedMime: 'video/webm',
  expectedKey: key,
});
assert.strictEqual(result.code, 'STORAGE_OBJECT_MISSING');

// Zero-byte
result = evaluateStorageObjectIntegrity(key, meta(0), {
  expectedSize: 0,
  expectedMime: 'video/webm',
  expectedKey: key,
});
assert.strictEqual(result.code, 'STORAGE_OBJECT_EMPTY');

// Truncated
result = evaluateStorageObjectIntegrity(key, meta(50), {
  expectedSize: 100,
  expectedMime: 'video/webm',
  expectedKey: key,
});
assert.strictEqual(result.code, 'STORAGE_OBJECT_TRUNCATED');

// Oversized
result = evaluateStorageObjectIntegrity(key, meta(200), {
  expectedSize: 100,
  expectedMime: 'video/webm',
  expectedKey: key,
});
assert.strictEqual(result.code, 'STORAGE_OBJECT_OVERSIZED');

// Wrong MIME
result = evaluateStorageObjectIntegrity(key, meta(100, 'application/pdf'), {
  expectedSize: 100,
  expectedMime: 'video/webm',
  expectedKey: key,
});
assert.strictEqual(result.code, 'STORAGE_MIME_MISMATCH');

// Wrong path
result = evaluateStorageObjectIntegrity('consignments/other/boxes/box_1/video.webm', meta(100), {
  expectedSize: 100,
  expectedMime: 'video/webm',
  expectedKey: key,
});
assert.strictEqual(result.code, 'STORAGE_PATH_MISMATCH');

// Duplicate metadata request shape (same correct object twice)
result = evaluateStorageObjectIntegrity(key, meta(12345), {
  expectedSize: 12345,
  expectedMime: 'video/webm',
  expectedKey: key,
});
const again = evaluateStorageObjectIntegrity(key, meta(12345), {
  expectedSize: 12345,
  expectedMime: 'video/webm',
  expectedKey: key,
});
assert.strictEqual(result.ok, true);
assert.strictEqual(again.ok, true);

console.log('Storage verification tests passed.');
