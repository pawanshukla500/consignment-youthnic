/**
 * Apply CORS to the configured Cloudflare R2 bucket (S3 PutBucketCors),
 * or print the policy JSON when credentials are missing.
 *
 * Usage: node scripts/apply-cors.js
 * Requires: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { S3Client, PutBucketCorsCommand, GetBucketCorsCommand } = require('@aws-sdk/client-s3');

const accountId = (process.env.R2_ACCOUNT_ID || '').trim();
const accessKeyId = (process.env.R2_ACCESS_KEY_ID || '').trim();
const secretAccessKey = (process.env.R2_SECRET_ACCESS_KEY || '').trim();
const bucket = (process.env.R2_BUCKET || '').trim();
const endpoint =
  (process.env.R2_ENDPOINT || '').trim() ||
  (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '');

const origins = (process.env.ALLOWED_ORIGINS
  || 'https://consignment.youthnic.shop,https://consignment-youthnic-git-*.europe-west1.run.app,http://localhost:5173,http://localhost:5000')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

// R2 CORS does not support wildcard in the middle of a host; expand common production origins.
const expandedOrigins = [...new Set([
  ...origins,
  'https://consignment.youthnic.shop',
  'http://localhost:5173',
  'http://localhost:5000',
].filter((o) => o && !o.includes('*')))];

const CORSRules = [
  {
    AllowedOrigins: expandedOrigins.length ? expandedOrigins : ['https://consignment.youthnic.shop'],
    AllowedMethods: ['GET', 'PUT', 'HEAD'],
    AllowedHeaders: ['*'],
    ExposeHeaders: ['ETag', 'Content-Length', 'Content-Type', 'Accept-Ranges', 'Content-Range'],
    MaxAgeSeconds: 3600,
  },
];

async function main() {
  console.log('R2 CORS policy for bucket uploads (videos / images / documents):\n');
  console.log(JSON.stringify({ CORSRules }, null, 2));
  console.log('\nBucket:', bucket || '(set R2_BUCKET)');
  console.log('Account:', accountId || '(set R2_ACCOUNT_ID)');
  console.log('Endpoint:', endpoint || '(derived from R2_ACCOUNT_ID)');

  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    console.log('\nCredentials incomplete — apply the JSON above in:');
    console.log('Cloudflare Dashboard → R2 → consigmentapp → Settings → CORS policy');
    process.exit(0);
  }

  const client = new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });

  await client.send(new PutBucketCorsCommand({
    Bucket: bucket,
    CORSConfiguration: { CORSRules },
  }));
  console.log('\nCORS applied successfully.');

  try {
    const current = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
    console.log('Verified CORSRules:', JSON.stringify(current.CORSRules, null, 2));
  } catch (e) {
    console.warn('Could not read back CORS (apply may still have succeeded):', e.message);
  }
}

main().catch((err) => {
  console.error('Failed to apply R2 CORS:', err.message);
  process.exit(1);
});
