/**
 * Smoke-test Cloudflare R2: put → head → get → delete a tiny object.
 * Also verifies signed upload URL generation helpers load.
 *
 * Usage: node scripts/r2-smoke-test.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

async function main() {
  const { getR2Status, requireR2, r2Configured } = require('../config/r2');
  const {
    generateSignedUploadUrl,
    finalizeClientStorageUpload,
    getStorageFileMeta,
    deleteFile,
    checkStorageReachable,
    uploadBuffer,
  } = require('../utils/storage');

  const status = getR2Status();
  console.log('R2 status:', {
    configured: status.configured,
    bucket: status.bucket,
    endpoint: status.endpoint ? '(set)' : null,
    accountId: status.accountId ? '(set)' : null,
  });

  if (!r2Configured) {
    console.error('FAIL: R2 not configured.', status.setupHint);
    process.exit(1);
  }

  const reach = await checkStorageReachable();
  if (!reach.reachable) {
    console.error('FAIL: R2 unreachable:', reach.error);
    process.exit(1);
  }
  console.log('OK: bucket reachable');

  const key = `smoke-tests/r2-smoke-${Date.now()}.txt`;
  const body = Buffer.from(`r2-smoke ${new Date().toISOString()}`, 'utf8');

  await uploadBuffer(body, key, 'text/plain', { consignmentId: 'smoke-test' });
  console.log('OK: put', key);

  const meta = await getStorageFileMeta(key);
  if (!meta || meta.size !== body.length) {
    console.error('FAIL: head mismatch', meta);
    process.exit(1);
  }
  console.log('OK: head size', meta.size);

  const finalized = await finalizeClientStorageUpload(key);
  if (!finalized?.storagePath) {
    console.error('FAIL: finalize');
    process.exit(1);
  }
  console.log('OK: finalize');

  const signed = await generateSignedUploadUrl(`${key}.signed-put`, 'text/plain');
  if (!signed.uploadUrl || !signed.storagePath) {
    console.error('FAIL: signed upload URL');
    process.exit(1);
  }
  console.log('OK: signed upload URL issued (TTL', signed.expiresIn, 's)');

  // Auth gate is enforced by Express routes; here we only confirm helper requires config.
  requireR2();
  console.log('OK: requireR2');

  await deleteFile(key, { throwOnError: true });
  const gone = await getStorageFileMeta(key);
  if (gone) {
    console.error('FAIL: object still present after delete');
    process.exit(1);
  }
  console.log('OK: delete');

  console.log('\nAll R2 smoke checks passed for bucket', status.bucket);
}

main().catch((err) => {
  console.error('R2 smoke test failed:', err.message);
  process.exit(1);
});
