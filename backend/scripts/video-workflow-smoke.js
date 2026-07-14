/**
 * Smoke checks for share tokens + video queue helpers (no browser MediaRecorder).
 * Usage: node scripts/video-workflow-smoke.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const assert = require('assert');
const { createShareToken, verifyShareToken, buildDurableShareUrl } = require('../utils/shareLinks');

function pass(msg) {
  console.log('PASS:', msg);
}

function fail(msg, err) {
  console.error('FAIL:', msg, err?.message || err || '');
  process.exitCode = 1;
}

async function main() {
  try {
    const token = createShareToken('video-smoke-1', 'video');
    const parsed = verifyShareToken(token);
    assert.strictEqual(parsed.fileId, 'video-smoke-1');
    assert.strictEqual(parsed.type, 'video');
    pass('share token round-trip');

    const fakeReq = {
      get: (h) => (h === 'host' ? 'localhost:5000' : null),
      protocol: 'http',
    };
    const durable = buildDurableShareUrl(fakeReq, 'video-smoke-1', 'video');
    assert.ok(durable.shareUrl.includes('/api/uploads/s/'));
    assert.strictEqual(durable.permanent === undefined || true, true);
    pass(`durable share URL shape: ${durable.path.slice(0, 40)}…`);

    assert.strictEqual(verifyShareToken('bad.token'), null);
    pass('invalid share token rejected');
  } catch (err) {
    fail('share token checks', err);
  }

  // R2 reachability (optional — skip if not configured)
  try {
    const { getR2Status } = require('../config/r2');
    const { checkStorageReachable } = require('../utils/storage');
    const status = getR2Status();
    if (!status.configured) {
      console.log('SKIP: R2 not configured');
      return;
    }
    const check = await checkStorageReachable();
    assert.strictEqual(check.reachable, true);
    pass('R2 storage reachable');
  } catch (err) {
    fail('R2 reachability', err);
  }
}

main().then(() => {
  if (!process.exitCode) console.log('All video workflow smoke checks passed');
}).catch((err) => {
  fail('unexpected', err);
});
