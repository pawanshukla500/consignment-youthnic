/**
 * File storage — Cloudflare R2 (S3-compatible).
 * Path layout:
 *   Videos:    consignments/{shipmentId}/boxes/box_{boxNo}/video.{ext}  (one video per box)
 *   Documents: consignments/{shipmentId}/documents/{id}_{filename}
 */
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { v4: uuidv4 } = require('uuid');
const {
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { requireR2, r2Configured, bucketName, getR2Status } = require('../config/r2');

const SAFE_EXTENSIONS = new Set([
  '.webm', '.mp4', '.mov', '.avi',
  '.png', '.jpg', '.jpeg', '.webp', '.gif',
  '.pdf', '.xls', '.xlsx', '.doc', '.docx',
  '.csv', '.txt'
]);

const UPLOAD_URL_TTL_SECONDS = Math.max(
  60,
  // Default 1h so 50–100MB box videos can finish on slower links
  parseInt(process.env.R2_SIGNED_UPLOAD_TTL_SECONDS || '3600', 10) || 3600
);
const READ_URL_TTL_SECONDS = Math.max(
  60,
  parseInt(process.env.R2_SIGNED_READ_TTL_SECONDS || '3600', 10) || 3600
);

function sanitizeBoxNo(boxNo) {
  return String(boxNo || 'unassigned').replace(/[^\w.-]/g, '_');
}

function getStoragePath(consignmentId, type, originalName, boxNo) {
  const ext = path.extname(originalName || '').toLowerCase();
  const safeExt = SAFE_EXTENSIONS.has(ext) ? ext : (type === 'video' ? '.webm' : '');
  const safeCid = String(consignmentId || '').replace(/[^\w.-]/g, '_');

  if (type === 'video') {
    const box = sanitizeBoxNo(boxNo);
    return `consignments/${safeCid}/boxes/box_${box}/video${safeExt}`;
  }

  const safeName = path.basename(originalName || 'file').replace(/[^\w.\-() ]/g, '_');
  return `consignments/${safeCid}/documents/${uuidv4().slice(0, 8)}_${safeName}`;
}

function buildPublicObjectUrl(storagePath) {
  const publicBase = (process.env.R2_PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (publicBase && storagePath) {
    return `${publicBase}/${storagePath.split('/').map(encodeURIComponent).join('/')}`;
  }
  return null;
}

/** Ensure client-uploaded files exist in the R2 bucket. */
async function finalizeClientStorageUpload(storagePath) {
  if (!r2Configured || !storagePath) return null;

  try {
    const meta = await getStorageFileMeta(storagePath);
    if (!meta) {
      console.warn('[Storage] Client uploaded file does not exist in R2:', storagePath);
      return null;
    }

    const signed = await getSignedReadUrl(storagePath, READ_URL_TTL_SECONDS * 1000);
    return {
      storagePath,
      storageUrl: signed || buildPublicObjectUrl(storagePath) || storagePath,
      storageProvider: 'r2',
      downloadToken: null,
    };
  } catch (error) {
    console.error('[Storage] finalizeClientStorageUpload failed:', error.message);
    return null;
  }
}

async function getStorageFileMeta(storagePath) {
  if (!r2Configured || !storagePath) return null;
  try {
    const { client, bucket } = requireR2();
    const result = await client.send(new HeadObjectCommand({
      Bucket: bucket,
      Key: storagePath,
    }));
    return {
      metadata: {
        contentType: result.ContentType || 'application/octet-stream',
        size: result.ContentLength,
        etag: result.ETag,
        ...result.Metadata,
      },
      size: Number(result.ContentLength || 0),
    };
  } catch (error) {
    if (isNotFoundStorageError(error)) return null;
    console.warn('[Storage] HeadObject failed:', storagePath, error.message);
    return null;
  }
}

async function createStorageReadStream(storagePath, range) {
  const { client, bucket } = requireR2();
  const input = {
    Bucket: bucket,
    Key: storagePath,
  };
  if (range && Number.isFinite(range.start) && Number.isFinite(range.end)) {
    input.Range = `bytes=${range.start}-${range.end}`;
  }
  const result = await client.send(new GetObjectCommand(input));
  if (!result.Body) {
    throw new Error('Empty object body from R2');
  }
  if (typeof result.Body.pipe === 'function') {
    return result.Body;
  }
  return Readable.fromWeb(result.Body);
}

function extractStoragePathFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    if (url.includes('/o/')) {
      const match = url.match(/\/o\/([^?]+)/);
      if (match?.[1]) return decodeURIComponent(match[1]);
    }
    if (url.includes('storage.googleapis.com')) {
      const parts = url.split('storage.googleapis.com/');
      if (parts[1]) {
        const subparts = parts[1].split('/');
        subparts.shift();
        return decodeURIComponent(subparts.join('/').split('?')[0]);
      }
    }
    const publicBase = (process.env.R2_PUBLIC_BASE_URL || '').replace(/\/$/, '');
    if (publicBase && url.startsWith(publicBase + '/')) {
      return decodeURIComponent(url.slice(publicBase.length + 1).split('?')[0]);
    }
    if (url.includes('.r2.cloudflarestorage.com/')) {
      const after = url.split('.r2.cloudflarestorage.com/')[1] || '';
      const withoutBucket = after.split('/').slice(1).join('/');
      return decodeURIComponent(withoutBucket.split('?')[0]);
    }
    return null;
  } catch (e) {
    console.warn('[Storage] extractStoragePathFromUrl failed:', e.message);
    return null;
  }
}

function resolveStoragePath(record) {
  if (!record) return null;
  const explicit = record.storagePath || record.firebasePath || null;
  if (explicit) return explicit;
  return extractStoragePathFromUrl(resolvePublicUrl(record));
}

/** Locate the object in R2 when stored path is missing or stale. */
async function resolveVideoStoragePath(record) {
  const candidates = [];
  const addCandidate = (p) => {
    if (p && !candidates.includes(p)) candidates.push(p);
  };

  addCandidate(record?.storagePath);
  addCandidate(record?.firebasePath);
  addCandidate(extractStoragePathFromUrl(record?.storageUrl));
  addCandidate(extractStoragePathFromUrl(record?.firebaseUrl));
  addCandidate(extractStoragePathFromUrl(record?.url));

  for (const candidate of candidates) {
    const meta = await getStorageFileMeta(candidate);
    if (meta) return candidate;
  }

  const { consignmentId, boxNo } = record || {};
  if (!r2Configured || !consignmentId || !boxNo) return null;

  const safeCid = String(consignmentId).replace(/[^\w.-]/g, '_');
  const box = sanitizeBoxNo(boxNo);
  const prefixes = [
    `consignments/${safeCid}/boxes/box_${box}/`,
    `consignments/${safeCid}/videos/${box}/`,
  ];

  const { client, bucket } = requireR2();
  for (const prefix of prefixes) {
    try {
      const listed = await client.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: 20,
      }));
      const videoFile = (listed.Contents || []).find((obj) =>
        /\/(video[^/]*|[^\s/]+_box_[^\s/]+)\.(webm|mp4|mov|avi)$/i.test(obj.Key || '')
      );
      if (videoFile?.Key) return videoFile.Key;
    } catch (e) {
      console.warn('[Storage] resolveVideoStoragePath list failed:', prefix, e.message);
    }
  }
  return null;
}

function resolvePublicUrl(record) {
  return record?.storageUrl || record?.firebaseUrl || record?.url || null;
}

async function uploadFromLocal(localPath, storagePath, mimeType, metadata = {}) {
  const buffer = fs.readFileSync(localPath);
  return uploadBuffer(buffer, storagePath, mimeType, metadata);
}

async function uploadBuffer(buffer, storagePath, mimeType, metadata = {}) {
  const { client, bucket } = requireR2();
  const meta = {};
  if (metadata.consignmentId) meta.consignmentid = String(metadata.consignmentId);
  if (metadata.boxNo) meta.boxno = String(metadata.boxNo);

  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: storagePath,
    Body: buffer,
    ContentType: mimeType,
    Metadata: meta,
  }));

  const signed = await getSignedReadUrl(storagePath, READ_URL_TTL_SECONDS * 1000);
  return {
    storagePath,
    storageUrl: signed || buildPublicObjectUrl(storagePath) || storagePath,
    storageProvider: 'r2',
    downloadToken: null,
  };
}

function isNotFoundStorageError(error) {
  const code = error?.name || error?.Code || error?.code || '';
  const status = error?.$metadata?.httpStatusCode;
  return (
    status === 404 ||
    code === 'NotFound' ||
    code === 'NoSuchKey' ||
    code === 404 ||
    /not found|nosuchkey/i.test(error?.message || '')
  );
}

async function deleteFile(storagePath, options = {}) {
  const { allowMissing = false, throwOnError = false } = options;
  if (!storagePath) {
    const error = new Error('Storage path is missing.');
    if (throwOnError) throw error;
    return false;
  }
  if (!r2Configured) {
    const error = new Error('Cloudflare R2 is not configured.');
    if (throwOnError) throw error;
    return false;
  }
  try {
    const { client, bucket } = requireR2();
    await client.send(new DeleteObjectCommand({
      Bucket: bucket,
      Key: storagePath,
    }));
    return true;
  } catch (e) {
    if (allowMissing && isNotFoundStorageError(e)) {
      return true;
    }
    console.warn('[Storage] R2 delete failed:', e.message);
    if (throwOnError) throw e;
    return false;
  }
}

async function checkStorageReachable() {
  if (!r2Configured) {
    return { reachable: false, error: getR2Status().setupHint || 'R2 not configured' };
  }
  try {
    const { client, bucket } = requireR2();
    await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      MaxKeys: 1,
    }));
    return { reachable: true, bucket };
  } catch (e) {
    return { reachable: false, error: e.message };
  }
}

async function getSignedReadUrl(storagePath, expiresMs = READ_URL_TTL_SECONDS * 1000) {
  if (!r2Configured || !storagePath) return null;
  try {
    const meta = await getStorageFileMeta(storagePath);
    if (!meta) {
      console.warn('[Storage] File not found for signed URL:', storagePath);
      return null;
    }
    const { client, bucket } = requireR2();
    const expiresIn = Math.max(60, Math.floor(expiresMs / 1000));
    return getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: bucket, Key: storagePath }),
      { expiresIn }
    );
  } catch (e) {
    console.warn('[Storage] getSignedReadUrl failed:', storagePath, e.message);
    return null;
  }
}

async function generateSignedUploadUrl(storagePath, mimeType) {
  const { client, bucket } = requireR2();
  const uploadUrl = await getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: bucket,
      Key: storagePath,
      ContentType: mimeType,
    }),
    { expiresIn: UPLOAD_URL_TTL_SECONDS }
  );

  return {
    uploadUrl,
    storagePath,
    storageProvider: 'r2',
    expiresIn: UPLOAD_URL_TTL_SECONDS,
  };
}

async function resolveReadableUrl(record, options = {}) {
  const storagePath = resolveStoragePath(record);
  if (storagePath) {
    const signed = await getSignedReadUrl(storagePath, options.expiresMs);
    if (signed) return signed;
  }
  return resolvePublicUrl(record);
}

async function enrichFileRecord(record, options = {}) {
  if (!record) return record;
  const fileType = record.type || options.type || 'document';
  let playUrl = null;
  if (record.id && (fileType === 'video' || fileType === 'document' || fileType === 'weight_image')) {
    playUrl = `/api/uploads/stream/${encodeURIComponent(record.id)}?type=${encodeURIComponent(fileType === 'weight_image' ? 'document' : fileType)}`;
  } else {
    playUrl = await resolveReadableUrl(record, options);
  }
  return {
    ...record,
    storageProvider: record.storageProvider || 'r2',
    playUrl,
    url: playUrl || resolvePublicUrl(record),
  };
}

module.exports = {
  getStoragePath,
  extractStoragePathFromUrl,
  resolveStoragePath,
  resolveVideoStoragePath,
  resolvePublicUrl,
  getSignedReadUrl,
  resolveReadableUrl,
  enrichFileRecord,
  finalizeClientStorageUpload,
  getStorageFileMeta,
  createStorageReadStream,
  uploadFromLocal,
  uploadBuffer,
  deleteFile,
  checkStorageReachable,
  generateSignedUploadUrl,
  bucketName,
  r2Configured,
};
