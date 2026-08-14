const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { generateId, now, addAuditLog, firestoreHelpers } = require('../utils/helpers');
const {
  getStoragePath,
  resolveStoragePath,
  resolveVideoStoragePath,
  resolvePublicUrl,
  buildPublicObjectUrl,
  enrichFileRecord,
  finalizeClientStorageUpload,
  verifyStorageObject,
  getStorageFileMeta,
  createStorageReadStream,
  deleteFile,
  generateSignedUploadUrl,
  getSignedReadUrl,
  createMultipartUpload,
  generateSignedPartUrls,
  completeMultipartUpload,
  abortMultipartUpload,
  listMultipartParts,
  uploadPartBuffer,
  uploadBuffer,
} = require('../utils/storage');
const { requestUserHasPermission, requirePermission, requireAnyPermission, DELETE_VIDEOS } = require('../utils/permissions');
const { isStoragePathForConsignment } = require('../utils/storagePathValidation');
const { checkConsignmentVideos } = require('../utils/videoHealthCheck');
const { buildDurableShareUrl, verifyShareToken, getPublicApiBase } = require('../utils/shareLinks');

function wantsBrowserHtmlPage(req) {
  const accept = String(req.headers.accept || '');
  return accept.includes('text/html');
}

function isDownloadRequest(req) {
  const raw = String(req.query.download || '');
  return raw === '1' || raw.toLowerCase() === 'true';
}

function buildSharePagePath(token) {
  return `/share/video/${encodeURIComponent(token)}`;
}

function buildAppBaseUrl(req) {
  const configured = String(process.env.APP_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  return getPublicApiBase(req);
}

function buildStreamPath(fileId, type = 'video') {
  return `/api/uploads/stream/${encodeURIComponent(fileId)}?type=${encodeURIComponent(type)}`;
}

async function streamFileRecord(req, res, record, fileType, options = {}) {
  const storagePath = await resolveRecordStoragePath(record, fileType);
  if (!storagePath) {
    return res.status(404).json({ error: 'File is not available in storage.' });
  }

  const collectionName = fileType === 'video' || record.type === 'video' ? 'videos' : 'documents';
  if (record.id) {
    await maybeBackfillStoragePath(collectionName, record.id, record, storagePath);
  }

  const fileMeta = await getStorageFileMeta(storagePath);
  if (!fileMeta) {
    return res.status(404).json({ error: 'File is not available in storage.' });
  }

  const contentType = fileMeta.metadata.contentType || record.mimeType || 'application/octet-stream';
  const fileSize = fileMeta.size;
  const rangeHeader = req.headers.range;
  const publicShare = options.publicShare === true;
  const forceDownload = options.download === true
    || String(req.query.download || '') === '1'
    || String(req.query.download || '').toLowerCase() === 'true';
  const etag = fileMeta.metadata?.etag || fileMeta.metadata?.ETag || null;
  const safeName = String(record.originalName || 'video').replace(/[^\w.\-]+/g, '_');

  res.setHeader('Accept-Ranges', 'bytes');
  // Never allow Chrome/CDN to pin packing videos for a full day — revalidate on each play.
  res.setHeader('Cache-Control', publicShare ? 'public, max-age=0, must-revalidate' : 'private, no-store');
  if (etag) res.setHeader('ETag', etag);
  res.setHeader('Content-Type', contentType);
  res.setHeader(
    'Content-Disposition',
    `${forceDownload ? 'attachment' : 'inline'}; filename="${safeName}"`
  );

  if (etag && req.headers['if-none-match'] && req.headers['if-none-match'] === etag && !rangeHeader) {
    return res.status(304).end();
  }
  if (rangeHeader && fileSize) {
    const parts = rangeHeader.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= fileSize) {
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      return res.status(416).json({ error: 'Invalid range.' });
    }
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Content-Length': chunkSize,
    });
    await pipeStorageStream(res, storagePath, { start, end });
    return;
  }

  if (fileSize) res.setHeader('Content-Length', fileSize);
  await pipeStorageStream(res, storagePath, null);
}

async function resolveRecordStoragePath(record, type) {
  if (!record) return null;
  if (type === 'video' || record.type === 'video') {
    return resolveVideoStoragePath(record);
  }
  const path = resolveStoragePath(record);
  if (!path) return null;
  const meta = await getStorageFileMeta(path);
  return meta ? path : null;
}

async function maybeBackfillStoragePath(collectionName, fileId, record, storagePath) {
  if (!storagePath || resolveStoragePath(record) === storagePath) return;
  try {
    await firestoreHelpers.setDocument(collectionName, fileId, {
      ...record,
      storagePath,
      firebasePath: storagePath,
      updatedAt: now(),
    });
  } catch (e) {
    console.warn('[Upload] Failed to backfill storagePath:', fileId, e.message);
  }
}

async function pipeStorageStream(res, storagePath, range) {
  const stream = await createStorageReadStream(storagePath, range);
  stream.on('error', (err) => {
    console.error('[Upload] Stream read error:', storagePath, err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to read file from storage.' });
    } else {
      res.end();
    }
  });
  res.on('close', () => {
    if (!stream.destroyed) stream.destroy();
  });
  stream.pipe(res);
}

function buildFileRecord(fields) {
  const storagePath = fields.storagePath || '';
  const storageUrl = fields.storageUrl || '';
  return {
    id: fields.id,
    consignmentId: fields.consignmentId || '',
    boxNo: fields.boxNo || '',
    type: fields.type || 'document',
    originalName: fields.originalName || 'unnamed',
    mimeType: fields.mimeType || '',
    size: parseInt(fields.size) || 0,
    description: fields.description || '',
    storagePath,
    storageUrl,
    storageProvider: fields.storageProvider || 'r2',
    // Legacy aliases for backward compatibility with older DB rows
    firebasePath: storagePath,
    firebaseUrl: storageUrl,
    uploadedAt: fields.uploadedAt || now(),
    uploadedBy: fields.uploadedBy,
    uploadedByName: fields.uploadedByName || '',
    clientUploadId: fields.clientUploadId || '',
    uploadQueueId: fields.uploadQueueId || fields.clientUploadId || ''
  };
}

// Helper to ensure 1 box has exactly 1 video. Deactivates/deletes old DB rows first;
// storage object deletion happens only after DB removal succeeds (safe replacement order).
async function ensureSingleVideoPerBox(consignmentId, boxNo, skipId = null) {
  if (!consignmentId || !boxNo) return;
  const existingVideos = await firestoreHelpers.queryCollection('videos', 'consignmentId', '==', consignmentId);
  const matchBoxNo = String(boxNo);
  const videosToDelete = existingVideos.filter(
    (v) => String(v.boxNo) === matchBoxNo
      && v.id !== skipId
      && v.active !== false
      && v.type !== 'removal_video'
      && v.purpose !== 'quantity_removal'
  );
  if (videosToDelete.length === 0) return;

  const storagePathsToDelete = [];

  for (const oldVideo of videosToDelete) {
    // 1) Mark inactive / remove DB record first (source of truth)
    await firestoreHelpers.setDocument('videos', oldVideo.id, {
      active: false,
      replacedAt: now(),
      updatedAt: now(),
    });
    await firestoreHelpers.deleteDocument('videos', oldVideo.id);

    const consignment = await firestoreHelpers.getDocument('consignments', consignmentId);
    if (consignment?.videoIds) {
      const filteredVideoIds = (consignment.videoIds || []).filter((id) => id !== oldVideo.id);
      await firestoreHelpers.setDocument('consignments', consignmentId, {
        videoIds: filteredVideoIds,
        updatedAt: now(),
      });
    }

    const path = resolveStoragePath(oldVideo);
    if (path) {
      const pathStillUsed = existingVideos.some(
        (v) => v.id !== oldVideo.id && v.id !== skipId && resolveStoragePath(v) === path
      );
      if (!pathStillUsed) storagePathsToDelete.push(path);
    }
  }

  // 2) Delete old storage objects after DB commit (best-effort, non-blocking for client)
  for (const path of storagePathsToDelete) {
    try {
      await deleteFile(path, { allowMissing: true, throwOnError: false });
      console.log(`[Upload] Deleted replaced storage video: ${path}`);
    } catch (error) {
      console.warn('[Upload] Storage cleanup after video replace failed:', error.message);
    }
  }
}

// Count active packing videos already on a box (excludes removal-evidence videos and,
// optionally, one video id) — used to number additional-qty videos as part 2, 3, ...
// when a previously-packed box is reopened instead of evicting the earlier video(s).
async function countActiveBoxVideos(consignmentId, boxNo, excludeId = null) {
  if (!consignmentId || !boxNo) return 0;
  const existingVideos = await firestoreHelpers.queryCollection('videos', 'consignmentId', '==', consignmentId);
  const matchBoxNo = String(boxNo);
  return existingVideos.filter(
    (v) => String(v.boxNo) === matchBoxNo
      && v.id !== excludeId
      && v.active !== false
      && v.type !== 'removal_video'
      && v.purpose !== 'quantity_removal'
  ).length;
}

function buildBoxVideoLabel(boxNo, part) {
  return part > 1 ? `BOX${boxNo}_${part}` : `BOX${boxNo}`;
}

async function findExistingVideoMetadata(consignmentId, boxNo, storagePath, clientUploadId) {
  if (!consignmentId || !boxNo) return null;
  const existingVideos = await firestoreHelpers.queryCollection('videos', 'consignmentId', '==', consignmentId);
  const normalizedBoxNo = String(boxNo);
  const normalizedPath = storagePath ? String(storagePath) : '';
  const normalizedClientUploadId = clientUploadId ? String(clientUploadId) : '';
  return existingVideos.find((video) => {
    if (String(video.boxNo) !== normalizedBoxNo) return false;
    if (normalizedClientUploadId && String(video.clientUploadId || video.uploadQueueId || '') === normalizedClientUploadId) return true;
    if (normalizedPath && resolveStoragePath(video) === normalizedPath) return true;
    return false;
  }) || null;
}

// Generate R2 (S3) presigned upload URL for direct-to-cloud file uploads
router.post('/generate-signed-url', authenticateToken, requirePermission('packing', 'register uploads'), async (req, res) => {
  try {
    const { storagePath, mimeType, consignmentId } = req.body;
    if (!storagePath || !mimeType || !consignmentId) {
      return res.status(400).json({ error: 'storagePath, mimeType, and consignmentId are required.' });
    }

    if (!isStoragePathForConsignment(storagePath, consignmentId)) {
      return res.status(403).json({
        error: 'Storage path does not belong to this consignment.',
        code: 'STORAGE_PATH_MISMATCH',
      });
    }

    const result = await generateSignedUploadUrl(storagePath, mimeType);
    res.json(result);
  } catch (error) {
    console.error('Error generating signed upload URL:', error);
    res.status(500).json({ error: 'Failed to generate signed upload URL.', message: error.message });
  }
});

/** Start multipart upload — used for large packing videos so parts can upload in parallel. */
router.post('/multipart/create', authenticateToken, requirePermission('packing', 'register uploads'), async (req, res) => {
  try {
    const { storagePath, mimeType, consignmentId } = req.body;
    if (!storagePath || !mimeType || !consignmentId) {
      return res.status(400).json({ error: 'storagePath, mimeType, and consignmentId are required.' });
    }
    if (!isStoragePathForConsignment(storagePath, consignmentId)) {
      return res.status(403).json({
        error: 'Storage path does not belong to this consignment.',
        code: 'STORAGE_PATH_MISMATCH',
      });
    }
    const result = await createMultipartUpload(storagePath, mimeType);
    res.json(result);
  } catch (error) {
    console.error('Error creating multipart upload:', error);
    res.status(500).json({ error: 'Failed to create multipart upload.', message: error.message });
  }
});

/** Batch-sign UploadPart URLs so the browser can PUT chunks in parallel. */
router.post('/multipart/sign-parts', authenticateToken, requirePermission('packing', 'register uploads'), async (req, res) => {
  try {
    const { storagePath, uploadId, consignmentId, partNumbers } = req.body;
    if (!storagePath || !uploadId || !consignmentId) {
      return res.status(400).json({ error: 'storagePath, uploadId, and consignmentId are required.' });
    }
    if (!isStoragePathForConsignment(storagePath, consignmentId)) {
      return res.status(403).json({
        error: 'Storage path does not belong to this consignment.',
        code: 'STORAGE_PATH_MISMATCH',
      });
    }
    const result = await generateSignedPartUrls(storagePath, uploadId, partNumbers);
    res.json(result);
  } catch (error) {
    console.error('Error signing multipart parts:', error);
    res.status(500).json({ error: 'Failed to sign multipart parts.', message: error.message });
  }
});

router.post('/multipart/complete', authenticateToken, requirePermission('packing', 'register uploads'), async (req, res) => {
  try {
    const { storagePath, uploadId, consignmentId, parts } = req.body;
    if (!storagePath || !uploadId || !consignmentId) {
      return res.status(400).json({ error: 'storagePath, uploadId, and consignmentId are required.' });
    }
    if (!isStoragePathForConsignment(storagePath, consignmentId)) {
      return res.status(403).json({
        error: 'Storage path does not belong to this consignment.',
        code: 'STORAGE_PATH_MISMATCH',
      });
    }
    const result = await completeMultipartUpload(storagePath, uploadId, parts);
    res.json(result);
  } catch (error) {
    console.error('Error completing multipart upload:', error);
    res.status(500).json({ error: 'Failed to complete multipart upload.', message: error.message });
  }
});

router.post('/multipart/abort', authenticateToken, requirePermission('packing', 'register uploads'), async (req, res) => {
  try {
    const { storagePath, uploadId, consignmentId } = req.body;
    if (!storagePath || !uploadId || !consignmentId) {
      return res.status(400).json({ error: 'storagePath, uploadId, and consignmentId are required.' });
    }
    if (!isStoragePathForConsignment(storagePath, consignmentId)) {
      return res.status(403).json({
        error: 'Storage path does not belong to this consignment.',
        code: 'STORAGE_PATH_MISMATCH',
      });
    }
    const result = await abortMultipartUpload(storagePath, uploadId);
    res.json(result);
  } catch (error) {
    console.error('Error aborting multipart upload:', error);
    res.status(500).json({ error: 'Failed to abort multipart upload.', message: error.message });
  }
});

/** List uploaded parts so a restarted browser can resume multipart without re-uploading. */
router.post('/multipart/list-parts', authenticateToken, requirePermission('packing', 'register uploads'), async (req, res) => {
  try {
    const { storagePath, uploadId, consignmentId } = req.body;
    if (!storagePath || !uploadId || !consignmentId) {
      return res.status(400).json({ error: 'storagePath, uploadId, and consignmentId are required.' });
    }
    if (!isStoragePathForConsignment(storagePath, consignmentId)) {
      return res.status(403).json({
        error: 'Storage path does not belong to this consignment.',
        code: 'STORAGE_PATH_MISMATCH',
      });
    }
    const result = await listMultipartParts(storagePath, uploadId);
    if (!result.ok) {
      return res.status(404).json({
        ok: false,
        code: result.code || 'NoSuchUpload',
        error: result.message || 'Multipart upload not found',
        storagePath,
        uploadId,
        parts: [],
      });
    }
    res.json(result);
  } catch (error) {
    console.error('Error listing multipart parts:', error);
    res.status(500).json({
      ok: false,
      code: error.code || 'LIST_PARTS_FAILED',
      error: 'Failed to list multipart parts.',
      message: error.message,
    });
  }
});

/** HeadObject probe for crash recovery after multipart complete / missing upload id. */
router.post('/object-head', authenticateToken, requirePermission('packing', 'register uploads'), async (req, res) => {
  try {
    const { storagePath, consignmentId, expectedSize, mimeType } = req.body || {};
    if (!storagePath || !consignmentId) {
      return res.status(400).json({ error: 'storagePath and consignmentId are required.' });
    }
    if (!isStoragePathForConsignment(storagePath, consignmentId)) {
      return res.status(403).json({
        error: 'Storage path does not belong to this consignment.',
        code: 'STORAGE_PATH_MISMATCH',
      });
    }
    const result = await verifyStorageObject(storagePath, {
      expectedSize,
      expectedMime: mimeType,
      expectedKey: storagePath,
      requireVideoMime: true,
    });
    if (!result.ok) {
      return res.status(result.code === 'STORAGE_OBJECT_MISSING' ? 404 : 400).json(result);
    }
    res.json(result);
  } catch (error) {
    console.error('Error probing object head:', error);
    res.status(500).json({
      ok: false,
      code: error.code || 'HEAD_OBJECT_FAILED',
      error: error.message || 'HeadObject failed',
    });
  }
});

/**
 * Same-origin multipart part upload (no browser→R2 CORS required).
 * Body: raw octets. Query: storagePath, uploadId, partNumber, consignmentId
 */
router.put(
  '/multipart/proxy-part',
  authenticateToken,
  requirePermission('packing', 'register uploads'),
  express.raw({ type: '*/*', limit: '16mb' }),
  async (req, res) => {
    try {
      const storagePath = String(req.query.storagePath || '');
      const uploadId = String(req.query.uploadId || '');
      const consignmentId = String(req.query.consignmentId || '');
      const partNumber = Number(req.query.partNumber);
      if (!storagePath || !uploadId || !consignmentId || !Number.isInteger(partNumber)) {
        return res.status(400).json({ error: 'storagePath, uploadId, consignmentId, and partNumber are required.' });
      }
      if (!isStoragePathForConsignment(storagePath, consignmentId)) {
        return res.status(403).json({
          error: 'Storage path does not belong to this consignment.',
          code: 'STORAGE_PATH_MISMATCH',
        });
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'Empty part body.' });
      }
      const result = await uploadPartBuffer(storagePath, uploadId, partNumber, req.body);
      res.json(result);
    } catch (error) {
      console.error('Error proxying multipart part:', error);
      res.status(500).json({ error: 'Failed to upload part via proxy.', message: error.message });
    }
  }
);

/**
 * Same-origin single-object PutObject for smaller clips when R2 CORS blocks signed PUT.
 * Body: raw octets. Query: storagePath, consignmentId, mimeType
 */
router.put(
  '/proxy-object',
  authenticateToken,
  requirePermission('packing', 'register uploads'),
  express.raw({ type: '*/*', limit: '32mb' }),
  async (req, res) => {
    try {
      const storagePath = String(req.query.storagePath || '');
      const consignmentId = String(req.query.consignmentId || '');
      const mimeType = String(req.query.mimeType || req.headers['content-type'] || 'application/octet-stream');
      const boxNo = String(req.query.boxNo || '');
      if (!storagePath || !consignmentId) {
        return res.status(400).json({ error: 'storagePath and consignmentId are required.' });
      }
      if (!isStoragePathForConsignment(storagePath, consignmentId)) {
        return res.status(403).json({
          error: 'Storage path does not belong to this consignment.',
          code: 'STORAGE_PATH_MISMATCH',
        });
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'Empty object body.' });
      }
      await uploadBuffer(req.body, storagePath, mimeType, { consignmentId, boxNo });
      res.json({ storagePath, size: req.body.length, storageProvider: 'r2' });
    } catch (error) {
      console.error('Error proxying object upload:', error);
      res.status(500).json({ error: 'Failed to upload object via proxy.', message: error.message });
    }
  }
);

// Save file metadata after a direct client upload to Cloudflare R2
router.post('/metadata', authenticateToken, requireAnyPermission(['packing', 'consignments'], 'register uploads'), async (req, res) => {
  try {
    const {
      consignmentId,
      type,
      originalName,
      firebaseUrl,
      firebasePath,
      storageUrl,
      storagePath,
      size,
      mimeType,
      boxNo,
      description,
      clientUploadId,
      uploadQueueId,
      adjustmentId,
      purpose,
      preserveExisting,
    } = req.body;

    const url = storageUrl || firebaseUrl;
    const path = storagePath || firebasePath;
    const fileType = type || 'document';
    const isRemovalVideo = fileType === 'removal_video' || purpose === 'quantity_removal';
    // Box was already packed and the operator reopened it to add more qty — keep the
    // earlier video(s) instead of evicting them; this upload becomes an additional part.
    const keepExistingVideo = Boolean(preserveExisting) && fileType === 'video' && !isRemovalVideo;

    if (!consignmentId || !url) {
      return res.status(400).json({ error: 'consignmentId and storage URL are required.' });
    }
    if ((fileType === 'video' || isRemovalVideo) && !boxNo) {
      return res.status(400).json({ error: 'boxNo is required for video uploads (one video per box).' });
    }
    if ((fileType === 'video' || isRemovalVideo) && !path) {
      return res.status(400).json({ error: 'storagePath is required for video metadata.' });
    }
    if (isRemovalVideo && !adjustmentId) {
      return res.status(400).json({ error: 'adjustmentId is required for removal videos.' });
    }
    if (path && !isStoragePathForConsignment(path, consignmentId)) {
      return res.status(403).json({
        error: 'Storage path does not belong to this consignment.',
        code: 'STORAGE_PATH_MISMATCH',
      });
    }

    const consignment = await firestoreHelpers.getDocument('consignments', consignmentId);
    if (!consignment) {
      return res.status(404).json({ error: 'Consignment not found.' });
    }

    let resolvedUrl = url;
    let resolvedPath = path || '';
    let verification = null;
    if (path) {
      try {
        const finalized = await finalizeClientStorageUpload(path, {
          expectedSize: size != null ? Number(size) : null,
          expectedMime: mimeType,
          expectedKey: path,
          requireVideoMime: fileType === 'video' || isRemovalVideo,
        });
        if (!finalized) {
          return res.status(400).json({
            error: 'Uploaded file was not found in storage. Please retry the upload.',
            code: 'STORAGE_OBJECT_MISSING',
            verified: false,
          });
        }
        resolvedUrl = finalized.storageUrl;
        resolvedPath = finalized.storagePath;
        verification = finalized.verification || null;
      } catch (verifyErr) {
        return res.status(verifyErr.statusCode || 400).json({
          error: verifyErr.message || 'Storage verification failed.',
          code: verifyErr.code || 'STORAGE_VERIFY_FAILED',
          verified: false,
          verification: verifyErr.verification || null,
        });
      }
    }

    if ((fileType === 'video' || isRemovalVideo) && boxNo) {
      const existing = await findExistingVideoMetadata(consignmentId, boxNo, resolvedPath, clientUploadId || uploadQueueId);
      if (existing) {
        // Same queue item/path retry: refresh stamps so clients bust stale Chrome caches.
        const refreshed = {
          ...existing,
          originalName: originalName || existing.originalName,
          size: size != null ? size : existing.size,
          mimeType: mimeType || existing.mimeType,
          storageUrl: resolvedUrl || existing.storageUrl || existing.url,
          storagePath: resolvedPath || existing.storagePath,
          firebasePath: resolvedPath || existing.firebasePath,
          clientUploadId: clientUploadId || uploadQueueId || existing.clientUploadId || '',
          uploadQueueId: uploadQueueId || clientUploadId || existing.uploadQueueId || '',
          uploadedAt: now(),
          updatedAt: now(),
          storageVerified: true,
          storageVerifiedAt: now(),
          active: true,
        };
        await firestoreHelpers.setDocument('videos', existing.id, refreshed);
        if (fileType === 'video' && !isRemovalVideo && !keepExistingVideo) {
          try {
            await ensureSingleVideoPerBox(consignmentId, boxNo, existing.id);
          } catch (replaceError) {
            console.warn('[Upload] Old video cleanup failed for box', boxNo, replaceError.message);
          }
        }
        const enrichedExisting = await enrichFileRecord(refreshed);
        return res.status(200).json({
          file: enrichedExisting,
          deduped: true,
          refreshed: true,
          verified: true,
          verification: verification || {
            actualSize: Number(enrichedExisting.size) || null,
            expectedSize: size != null ? Number(size) : null,
            contentType: enrichedExisting.mimeType || null,
            verifiedAt: now(),
          },
        });
      }
    }

    // Additional-qty videos are numbered by how many active videos the box already has —
    // part 1 is the original pack, part 2+ are reopens. Only matters when boxNo is set.
    const videoPart = (fileType === 'video' && !isRemovalVideo && boxNo)
      ? (await countActiveBoxVideos(consignmentId, boxNo)) + 1
      : 1;

    const fileId = generateId();
    const fileRecord = buildFileRecord({
      id: fileId,
      consignmentId,
      boxNo,
      type: isRemovalVideo ? 'removal_video' : (type || 'document'),
      originalName,
      storageUrl: resolvedUrl,
      storagePath: resolvedPath,
      storageProvider: 'r2',
      mimeType,
      size,
      description: isRemovalVideo
        ? (description || `Box ${boxNo} quantity removal video`)
        : (fileType === 'video'
          ? (videoPart > 1 ? `Box ${boxNo} packing video (part ${videoPart})` : `Box ${boxNo} packing video`)
          : (description || '')),
      clientUploadId: clientUploadId || uploadQueueId || '',
      uploadQueueId: uploadQueueId || clientUploadId || '',
      uploadedBy: req.user.id,
      uploadedByName: req.user.name || req.user.email
    });
    if (isRemovalVideo) {
      fileRecord.purpose = 'quantity_removal';
      fileRecord.adjustmentId = adjustmentId;
      fileRecord.active = true;
    } else if (fileType === 'video') {
      fileRecord.active = true;
      fileRecord.part = videoPart;
      fileRecord.boxLabel = buildBoxVideoLabel(boxNo, videoPart);
    } else if (purpose) {
      fileRecord.purpose = String(purpose).trim().toLowerCase();
    }
    if (fileType === 'video' || isRemovalVideo) {
      fileRecord.storageVerified = Boolean(verification);
      fileRecord.storageVerifiedAt = verification ? now() : null;
    }

    const collectionName = (fileType === 'video' || isRemovalVideo) ? 'videos' : 'documents';
    // Use fileType (not raw type) so videoIds vs documentIds stay consistent
    await firestoreHelpers.setDocument(collectionName, fileId, fileRecord);

    if (consignment) {
      const idField = (fileType === 'video' || isRemovalVideo) ? 'videoIds' : 'documentIds';
      const ids = new Set(consignment[idField] || []);
      ids.add(fileId);
      const consignmentPatch = {
        [idField]: Array.from(ids),
        updatedAt: now(),
      };
      const docPurpose = fileRecord.purpose || '';
      if (docPurpose === 'invoice') {
        consignmentPatch.invoiceDocumentId = fileId;
        consignmentPatch.invoiceUploadedAt = now();
      } else if (docPurpose === 'docket') {
        consignmentPatch.docketDocumentId = fileId;
      }
      await firestoreHelpers.setDocument('consignments', consignmentId, consignmentPatch);
    }

    if (fileType === 'video' && !isRemovalVideo && boxNo) {
      try {
        if (!keepExistingVideo) {
          await ensureSingleVideoPerBox(consignmentId, boxNo, fileId);
        }
        const boxId = `${consignmentId}_box_${boxNo}`;
        await firestoreHelpers.setDocument('boxes', boxId, {
          videoStatus: 'metadata_saved',
          videoId: fileId,
          videoUpdatedAt: now(),
        });
        await firestoreHelpers.setDocument('consignments', consignmentId, {
          boxVideoStatuses: {
            ...(consignment?.boxVideoStatuses || {}),
            [String(boxNo)]: {
              status: 'metadata_saved',
              videoId: fileId,
              updatedAt: now(),
            },
          },
          updatedAt: now(),
        });
      } catch (replaceError) {
        console.warn('[Upload] Old video cleanup failed for box', boxNo, replaceError.message);
      }
    }

    await addAuditLog('upload', type || 'file', fileId, req.user.id, {
      consignmentId,
      boxNo,
      originalName
    });

    const enriched = await enrichFileRecord(fileRecord);
    const isVideoLike = fileType === 'video' || isRemovalVideo;
    res.status(201).json({
      file: enriched,
      verified: isVideoLike ? Boolean(verification) : true,
      verification: verification || null,
    });
  } catch (error) {
    console.error('Error saving file metadata:', error);
    res.status(error.statusCode || 500).json({
      error: error.message || 'Failed to save file metadata.',
      verified: false,
      code: error.code || undefined,
      verification: error.verification || null,
    });
  }
});

router.post('/video-status', authenticateToken, requirePermission('packing', 'update video status'), async (req, res) => {
  try {
    const { consignmentId, boxNo, status, queueId, error } = req.body || {};
    const allowed = new Set([
      'recording',
      'queued',
      'uploading',
      'multipart_uploading',
      'multipart_completing',
      'object_uploaded',
      'retrying',
      'verifying',
      'uploaded',
      'metadata_saved',
      'completed',
      'failed',
      'storage_failed',
      'superseded',
    ]);
    if (!consignmentId || !boxNo || !allowed.has(status)) {
      return res.status(400).json({ error: 'consignmentId, boxNo, and a valid status are required.' });
    }

    const timestamp = now();
    const normalizedBoxNo = String(boxNo);
    const consignment = await firestoreHelpers.getDocument('consignments', consignmentId);
    if (!consignment) return res.status(404).json({ error: 'Consignment not found.' });

    const statusRecord = {
      status,
      queueId: queueId || null,
      error: error ? String(error).slice(0, 500) : null,
      updatedAt: timestamp,
      updatedBy: req.user.id,
    };

    await firestoreHelpers.setDocument('consignments', consignmentId, {
      boxVideoStatuses: {
        ...(consignment.boxVideoStatuses || {}),
        [normalizedBoxNo]: statusRecord,
      },
      updatedAt: timestamp,
    });

    const boxId = `${consignmentId}_box_${normalizedBoxNo}`;
    const existingBox = await firestoreHelpers.getDocument('boxes', boxId);
    if (existingBox) {
      await firestoreHelpers.setDocument('boxes', boxId, {
        videoStatus: status,
        videoQueueId: queueId || existingBox.videoQueueId || null,
        videoError: status === 'failed' ? statusRecord.error : null,
        videoUpdatedAt: timestamp,
      });
    }

    res.json({ ok: true, status: statusRecord });
  } catch (error) {
    console.error('Error updating video status:', error);
    res.status(error.statusCode || 500).json({ error: error.message || 'Failed to update video status.' });
  }
});


router.get('/share/:fileId', authenticateToken, requireAnyPermission(['consignments', 'packing'], 'share uploads'), async (req, res) => {
  try {
    const { fileId } = req.params;
    const { type } = req.query;
    const fileType = type || 'video';
    const collectionName = fileType === 'video' ? 'videos' : 'documents';
    const record = await firestoreHelpers.getDocument(collectionName, fileId);
    if (!record) {
      return res.status(404).json({ error: 'File not found.' });
    }

    const durable = buildDurableShareUrl(req, fileId, fileType || record.type || 'document');
    const version = record.uploadedAt || record.updatedAt || record.size || Date.now();
    const shareUrl = `${durable.shareUrl}${durable.shareUrl.includes('?') ? '&' : '?'}v=${encodeURIComponent(String(version))}`;
    const streamUrl = `${durable.streamUrl}${durable.streamUrl.includes('?') ? '&' : '?'}v=${encodeURIComponent(String(version))}`;
    const downloadUrl = `${streamUrl}${streamUrl.includes('?') ? '&' : '?'}download=1`;
    const storagePath = await resolveRecordStoragePath(record, fileType);
    const [publicUrl, r2SignedUrl, fileMeta] = await Promise.all([
      Promise.resolve(storagePath ? (buildPublicObjectUrl(storagePath) || resolvePublicUrl({ ...record, storagePath })) : null),
      storagePath ? getSignedReadUrl(storagePath) : Promise.resolve(null),
      storagePath ? getStorageFileMeta(storagePath) : Promise.resolve(null),
    ]);

    res.json({
      shareUrl,
      url: shareUrl,
      playUrl: shareUrl,
      streamUrl,
      downloadUrl,
      pageUrl: shareUrl,
      path: `${durable.path}?v=${encodeURIComponent(String(version))}`,
      requiresAuth: false,
      expires: null,
      permanent: true,
      storageProvider: 'cloudflare-r2',
      purpose: 'dispute-share',
      consignmentId: record.consignmentId,
      boxNo: record.boxNo || null,
      type: record.type || fileType || 'document',
      originalName: record.originalName,
      mimeType: record.mimeType || fileMeta?.metadata?.contentType || null,
      size: record.size || fileMeta?.size || null,
      storagePath: storagePath || null,
      publicUrl: publicUrl || null,
      // Never fall back to auth/proxy stream URLs for the copyable "R2 link".
      r2Url: r2SignedUrl || publicUrl || null,
      r2SignedUrl: r2SignedUrl || null,
      uploadedAt: record.uploadedAt || null,
      updatedAt: record.updatedAt || null,
    });
  } catch (error) {
    console.error('Error generating share link:', error);
    res.status(error.statusCode || 500).json({ error: 'Failed to generate share link.', message: error.message });
  }
});

/** Public metadata for dispute share page (no login). */
router.get('/s/:token/meta', async (req, res) => {
  try {
    let parsed;
    try {
      parsed = verifyShareToken(req.params.token);
    } catch (error) {
      return res.status(error.statusCode || 503).json({ error: error.message || 'Share links are not configured.' });
    }
    if (!parsed) {
      return res.status(403).json({ error: 'Invalid share link.' });
    }

    const collectionName = parsed.type === 'video' ? 'videos' : 'documents';
    const record = await firestoreHelpers.getDocument(collectionName, parsed.fileId);
    if (!record || record.active === false) {
      return res.status(404).json({ error: 'File not found.' });
    }

    const storagePath = await resolveRecordStoragePath(record, parsed.type);
    const [publicUrl, r2SignedUrl, fileMeta] = await Promise.all([
      Promise.resolve(storagePath ? (buildPublicObjectUrl(storagePath) || resolvePublicUrl({ ...record, storagePath })) : null),
      storagePath ? getSignedReadUrl(storagePath) : Promise.resolve(null),
      storagePath ? getStorageFileMeta(storagePath) : Promise.resolve(null),
    ]);
    const streamPath = `/api/uploads/s/${encodeURIComponent(req.params.token)}`;
    const downloadPath = `${streamPath}?download=1`;
    const previewUrl = r2SignedUrl || publicUrl || streamPath;
    const safeName = String(record.originalName || 'video').replace(/[^\w.\-]+/g, '_');
    const attachmentUrl = storagePath
      ? await getSignedReadUrl(storagePath, undefined, {
        responseContentDisposition: `attachment; filename="${safeName}"`,
        responseContentType: record.mimeType || fileMeta?.metadata?.contentType || undefined,
      })
      : null;
    const downloadUrl = attachmentUrl || r2SignedUrl || downloadPath;

    res.json({
      ok: true,
      type: parsed.type,
      consignmentId: record.consignmentId || null,
      boxNo: record.boxNo || null,
      originalName: record.originalName || null,
      mimeType: record.mimeType || fileMeta?.metadata?.contentType || null,
      size: record.size || fileMeta?.size || null,
      uploadedAt: record.uploadedAt || null,
      updatedAt: record.updatedAt || null,
      storageProvider: 'cloudflare-r2',
      storagePath: storagePath || null,
      publicUrl: publicUrl || null,
      r2SignedUrl: r2SignedUrl || null,
      r2Url: r2SignedUrl || publicUrl || null,
      streamPath,
      downloadPath,
      previewUrl,
      downloadUrl,
      pagePath: buildSharePagePath(req.params.token),
    });
  } catch (error) {
    console.error('Error reading share meta:', error);
    res.status(500).json({ error: 'Failed to read share metadata.', message: error.message });
  }
});

/** Durable public share playback — HMAC token, no login, no expiry (file delete → 404). */
router.get('/s/:token', async (req, res) => {
  try {
    let parsed;
    try {
      parsed = verifyShareToken(req.params.token);
    } catch (error) {
      return res.status(error.statusCode || 503).json({ error: error.message || 'Share links are not configured.' });
    }
    if (!parsed) {
      return res.status(403).json({ error: 'Invalid share link.' });
    }

    const forceDownload = isDownloadRequest(req);
    const hasRange = Boolean(req.headers.range);

    // Opening this URL in a browser tab should show the dispute details page,
    // not dump raw bytes through Cloud Run (which often 500s on large videos).
    if (wantsBrowserHtmlPage(req) && !forceDownload && !hasRange) {
      return res.redirect(302, `${buildAppBaseUrl(req)}${buildSharePagePath(req.params.token)}`);
    }

    const collectionName = parsed.type === 'video' ? 'videos' : 'documents';
    const record = await firestoreHelpers.getDocument(collectionName, parsed.fileId);
    if (!record || record.active === false) {
      return res.status(404).json({ error: 'File not found.' });
    }

    const storagePath = await resolveRecordStoragePath(record, parsed.type);
    if (!storagePath) {
      return res.status(404).json({ error: 'File is not available in storage.' });
    }

    // Prefer a short-lived signed R2 URL so playback/download does not proxy through Cloud Run.
    const safeName = String(record.originalName || 'video').replace(/[^\w.\-]+/g, '_');
    const signed = await getSignedReadUrl(storagePath, undefined, {
      responseContentDisposition: `${forceDownload ? 'attachment' : 'inline'}; filename="${safeName}"`,
      responseContentType: record.mimeType || undefined,
    });
    if (signed) {
      return res.redirect(302, signed);
    }

    await streamFileRecord(req, res, { ...record, id: parsed.fileId }, parsed.type, {
      publicShare: true,
      download: forceDownload,
    });
  } catch (error) {
    console.error('Error streaming shared file:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to stream shared file.', message: error.message });
    }
  }
});

/** Fresh play / download URLs backed by Cloudflare R2 (no in-app preview required). */
router.get('/play/:fileId', authenticateToken, requireAnyPermission(['consignments', 'packing'], 'play uploads'), async (req, res) => {
  try {
    const { fileId } = req.params;
    const { type } = req.query;
    const fileType = type || 'video';
    const collectionName = fileType === 'video' ? 'videos' : 'documents';
    const record = await firestoreHelpers.getDocument(collectionName, fileId);
    if (!record) {
      return res.status(404).json({ error: 'File not found.' });
    }

    const storagePath = await resolveRecordStoragePath(record, fileType);
    if (!storagePath) {
      return res.status(404).json({ error: 'File is not available in storage.' });
    }

    const streamPath = buildStreamPath(fileId, fileType);
    const downloadPath = `${streamPath}${streamPath.includes('?') ? '&' : '?'}download=1`;
    const [publicUrl, r2SignedUrl, fileMeta] = await Promise.all([
      Promise.resolve(buildPublicObjectUrl(storagePath) || resolvePublicUrl({ ...record, storagePath })),
      getSignedReadUrl(storagePath),
      getStorageFileMeta(storagePath),
    ]);
    const durable = buildDurableShareUrl(req, fileId, fileType);

    res.json({
      url: streamPath,
      playUrl: streamPath,
      streamUrl: streamPath,
      downloadUrl: downloadPath,
      shareUrl: durable.shareUrl,
      pageUrl: durable.shareUrl,
      publicStreamUrl: durable.streamUrl,
      storageProvider: 'cloudflare-r2',
      storagePath,
      publicUrl: publicUrl || null,
      r2Url: r2SignedUrl || publicUrl || null,
      r2SignedUrl: r2SignedUrl || null,
      mimeType: record.mimeType || fileMeta?.metadata?.contentType || null,
      size: record.size || fileMeta?.size || null,
      originalName: record.originalName || null,
      boxNo: record.boxNo || null,
      consignmentId: record.consignmentId || null,
      uploadedAt: record.uploadedAt || null,
      updatedAt: record.updatedAt || null,
    });
  } catch (error) {
    console.error('Error resolving play URL:', error);
    res.status(500).json({ error: 'Failed to resolve play URL.', message: error.message });
  }
});

/** Authenticated video/file stream — pipes from Cloudflare R2. */
router.get('/stream/:fileId', authenticateToken, requireAnyPermission(['consignments', 'packing'], 'stream uploads'), async (req, res) => {
  try {
    const { fileId } = req.params;
    const { type } = req.query;
    const fileType = type || 'video';
    const collectionName = fileType === 'video' ? 'videos' : 'documents';
    const record = await firestoreHelpers.getDocument(collectionName, fileId);
    if (!record) {
      return res.status(404).json({ error: 'File not found.' });
    }

    await streamFileRecord(req, res, { ...record, id: fileId }, fileType);
  } catch (error) {
    console.error('Error streaming file:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to stream file.', message: error.message });
    }
  }
});

router.get('/health/:consignmentId', authenticateToken, requireAnyPermission(['consignments', 'packing'], 'check upload health'), async (req, res) => {
  try {
    const result = await checkConsignmentVideos(req.params.consignmentId);
    const allOk = result.missing.length === 0 && result.orphaned.length === 0;
    res.status(allOk ? 200 : 207).json({ healthy: allOk, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:consignmentId', authenticateToken, requireAnyPermission(['consignments', 'packing'], 'list uploads'), async (req, res) => {
  try {
    const { consignmentId } = req.params;
    const { type } = req.query;

    let files = [];

    if (type === 'video' || !type) {
      const videos = await firestoreHelpers.queryCollection('videos', 'consignmentId', '==', consignmentId);
      const enrichedVideos = await Promise.all(
        videos.map((v) => enrichFileRecord({ ...v, type: 'video' }))
      );
      files = files.concat(enrichedVideos);
    }

    if (type === 'document' || !type) {
      const docs = await firestoreHelpers.queryCollection('documents', 'consignmentId', '==', consignmentId);
      const enrichedDocs = await Promise.all(
        docs.map((d) => enrichFileRecord({ ...d, type: 'document' }))
      );
      files = files.concat(enrichedDocs);
    }

    files.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    res.json({ files });
  } catch (error) {
    console.error('Error fetching files:', error);
    res.status(500).json({ error: 'Failed to fetch files.', message: error.message });
  }
});

router.delete('/:fileId', authenticateToken, async (req, res) => {
  try {
    const { fileId } = req.params;
    const { type } = req.query;

    const collectionName = type === 'video' ? 'videos' : 'documents';
    const fileRecord = await firestoreHelpers.getDocument(collectionName, fileId);

    if (!fileRecord) {
      return res.status(404).json({ error: 'File not found.' });
    }

    const isVideo = collectionName === 'videos' || fileRecord.type === 'video';
    if (isVideo) {
      if (!(await requestUserHasPermission(req, DELETE_VIDEOS))) {
        return res.status(403).json({ error: 'You do not have permission to delete videos.' });
      }
    } else if (!(await requestUserHasPermission(req, 'consignments'))) {
      return res.status(403).json({ error: 'You do not have permission to delete documents.' });
    }

    const storagePath = resolveStoragePath(fileRecord);
    if (storagePath) {
      await deleteFile(storagePath, { allowMissing: true, throwOnError: true });
    } else if (isVideo && resolvePublicUrl(fileRecord)) {
      return res.status(409).json({
        error: 'Video storage path is missing. Refusing to delete the database record until storage can be verified.',
      });
    }

    if (fileRecord.consignmentId) {
      const consignment = await firestoreHelpers.getDocument('consignments', fileRecord.consignmentId);
      if (consignment) {
        const idField = type === 'video' ? 'videoIds' : 'documentIds';
        await firestoreHelpers.setDocument('consignments', fileRecord.consignmentId, {
          ...consignment,
          [idField]: (consignment[idField] || []).filter(id => id !== fileId),
          updatedAt: now()
        });
      }
    }

    await firestoreHelpers.deleteDocument(collectionName, fileId);
    await addAuditLog('delete', type || 'file', fileId, req.user.id, { consignmentId: fileRecord.consignmentId });

    res.json({ message: 'File deleted successfully.' });
  } catch (error) {
    console.error('Error deleting file:', error);
    res.status(500).json({ error: 'Failed to delete file.', message: error.message });
  }
});


module.exports = router;
