/**
 * Apply CORS to the configured Cloudflare R2 bucket (S3 PutBucketCors),
 * or print the policy JSON when credentials are missing.
 *
 * Usage: node scripts/apply-cors.js
 * Requires: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { buildR2CorsRules, ensureR2Cors, collectAllowedOrigins } = require('../utils/r2Cors');
const { r2Configured, bucketName, endpoint } = require('../config/r2');

async function main() {
  const CorsRules = buildR2CorsRules();
  console.log('R2 CORS policy for bucket uploads (videos / images / documents):\n');
  console.log(JSON.stringify({ CORSRules: CorsRules }, null, 2));
  console.log('\nBucket:', bucketName || '(set R2_BUCKET)');
  console.log('Endpoint:', endpoint || '(derived from R2_ACCOUNT_ID)');
  console.log('Origins:', collectAllowedOrigins().join(', '));

  if (!r2Configured) {
    console.log('\nCredentials incomplete — apply the JSON above in:');
    console.log('Cloudflare Dashboard → R2 → consigmentapp → Settings → CORS policy');
    process.exit(0);
  }

  const result = await ensureR2Cors();
  if (!result.ok) {
    console.error('\nFailed to apply R2 CORS:', result.error || result.reason);
    process.exit(1);
  }

  console.log('\nCORS applied successfully to bucket:', result.bucket);
  console.log('Allowed origins:', (result.origins || []).join(', '));
  if (result.verifiedOrigins) {
    console.log('Verified origins:', result.verifiedOrigins.join(', '));
  }
}

main().catch((err) => {
  console.error('Failed to apply R2 CORS:', err.message);
  process.exit(1);
});
