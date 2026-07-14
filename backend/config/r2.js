/**
 * Cloudflare R2 (S3-compatible) client for videos, images, and documents.
 * Firebase is Auth-only; all app media goes through R2.
 */
const { S3Client } = require('@aws-sdk/client-s3');

const accountId = (process.env.R2_ACCOUNT_ID || '').trim();
const accessKeyId = (process.env.R2_ACCESS_KEY_ID || '').trim();
const secretAccessKey = (process.env.R2_SECRET_ACCESS_KEY || '').trim();
const bucketName = (process.env.R2_BUCKET || process.env.R2_BUCKET_NAME || '').trim();
const endpoint =
  (process.env.R2_ENDPOINT || '').trim() ||
  (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '');

const r2Configured = Boolean(endpoint && accessKeyId && secretAccessKey && bucketName);

let r2Client = null;
let initError = null;

if (r2Configured) {
  try {
    r2Client = new S3Client({
      region: 'auto',
      endpoint,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
      forcePathStyle: false,
    });
    console.log('[R2] Configured bucket:', bucketName);
  } catch (error) {
    initError = error.message;
    r2Client = null;
    console.error('[R2] Failed to create client:', error.message);
  }
} else {
  console.warn(
    '[R2] Not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET in backend/.env'
  );
}

function getR2Status() {
  return {
    configured: r2Configured && Boolean(r2Client),
    bucket: bucketName || null,
    endpoint: endpoint || null,
    accountId: accountId || null,
    initError,
    setupHint:
      r2Configured && r2Client
        ? null
        : 'Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET in backend/.env',
  };
}

function requireR2() {
  if (!r2Client || !bucketName) {
    throw new Error('Cloudflare R2 is not configured. Set R2_* environment variables.');
  }
  return { client: r2Client, bucket: bucketName };
}

module.exports = {
  r2Client,
  bucketName,
  endpoint,
  r2Configured: r2Configured && Boolean(r2Client),
  getR2Status,
  requireR2,
};
