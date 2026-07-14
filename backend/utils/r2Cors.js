/**
 * Cloudflare R2 bucket CORS — required for browser direct signed PUTs.
 * Without this, packing video uploads fail with XHR "Network error".
 */
const { PutBucketCorsCommand, GetBucketCorsCommand } = require('@aws-sdk/client-s3');
const { requireR2, r2Configured, bucketName } = require('../config/r2');

const DEFAULT_ORIGINS = [
  'https://consignment.youthnic.shop',
  'https://consignment.youthnic-studio.shop',
  'https://consignment-packing-app.web.app',
  'https://consignment-packing-app.firebaseapp.com',
  'http://localhost:5173',
  'http://localhost:5000',
];

function collectAllowedOrigins() {
  const fromEnv = String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const appUrl = String(process.env.APP_URL || '').trim();
  const merged = [...fromEnv, appUrl, ...DEFAULT_ORIGINS]
    .map((o) => o.replace(/\/$/, ''))
    .filter((o) => o && !o.includes('*') && /^https?:\/\//i.test(o));
  return [...new Set(merged)];
}

function buildR2CorsRules(origins = collectAllowedOrigins()) {
  const allowed = origins.length ? origins : DEFAULT_ORIGINS;
  return [
    {
      AllowedOrigins: allowed,
      AllowedMethods: ['GET', 'PUT', 'HEAD'],
      AllowedHeaders: ['*'],
      ExposeHeaders: ['ETag', 'etag', 'Content-Length', 'Content-Type', 'Accept-Ranges', 'Content-Range'],
      MaxAgeSeconds: 86400,
    },
  ];
}

/**
 * Apply (or refresh) the R2 bucket CORS policy so browser signed PUTs work.
 * Safe to call on every Cloud Run boot — idempotent.
 */
async function ensureR2Cors() {
  if (!r2Configured) {
    return { ok: false, skipped: true, reason: 'r2_not_configured' };
  }

  const CorsRules = buildR2CorsRules();
  try {
    const { client, bucket } = requireR2();
    await client.send(new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: { CORSRules: CorsRules },
    }));

    let verified = null;
    try {
      const current = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
      verified = current.CORSRules || null;
    } catch (_) {
      // read-back is best-effort
    }

    return {
      ok: true,
      bucket: bucket || bucketName,
      origins: CorsRules[0].AllowedOrigins,
      verifiedOrigins: verified?.[0]?.AllowedOrigins || null,
    };
  } catch (error) {
    return {
      ok: false,
      bucket: bucketName || null,
      error: error.message,
      origins: CorsRules[0].AllowedOrigins,
    };
  }
}

module.exports = {
  collectAllowedOrigins,
  buildR2CorsRules,
  ensureR2Cors,
};
