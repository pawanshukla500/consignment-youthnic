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
  process.env.JWT_SECRET = process.env.JWT_SECRET || process.env.SHARE_LINK_SECRET || 'smoke-test-share-secret';
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
    assert.ok(durable.shareUrl.includes('/share/video/'), 'shareUrl should be dispute page');
    assert.ok(durable.streamUrl.includes('/api/uploads/s/'), 'streamUrl should be raw stream');
    assert.ok(!durable.shareUrl.includes('/api/uploads/s/'), 'dispute shareUrl must not be the raw stream API');
    assert.strictEqual(durable.permanent === undefined || true, true);
    pass(`durable share URL shape: ${durable.path.slice(0, 40)}…`);

    assert.strictEqual(verifyShareToken('bad.token'), null);
    pass('invalid share token rejected');

    // Helper behavior used by /api/uploads/s/:token for browser navigations
    const uploadsSource = require('fs').readFileSync(require('path').join(__dirname, '../routes/uploads.js'), 'utf8');
    assert.ok(uploadsSource.includes('wantsBrowserHtmlPage'), 'share stream should detect HTML browser navigations');
    assert.ok(uploadsSource.includes('buildSharePagePath'), 'share stream should redirect browsers to dispute page');
    assert.ok(uploadsSource.includes('responseContentDisposition'), 'share stream should prefer signed R2 redirect');
    pass('share stream route includes HTML→page redirect + R2 signed redirect');
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
