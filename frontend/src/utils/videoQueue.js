/**
 * Durable video queue for packing-station CCTV recordings.
 *
 * Architecture:
 *  - recordingChunks store: incremental 1s MediaRecorder slices persisted during recording
 *  - videoQueue store: finalized per-box blobs awaiting cloud upload
 *  - Unverified local blobs are never automatically deleted
 *  - Replacement recordings mark prior rows `superseded` (blob retained) until verified
 *  - IndexedDB writes resolve only after transaction.oncomplete
 */
import { VIDEO_STATUS, VIDEO_UPLOAD_CONFIG } from './videoUploadConfig'
import { idbRequest, withIdbTransaction } from './idbWrite'
import {
  evaluateRecordingBackpressure,
  isActiveOutstandingStatus,
  isOutstandingStatus,
  isSupersededStatus,
  isUploadReady,
  normalizeQueueStatus,
  nextRetryState,
  planSupersedeForBox,
  queueCapWarning,
} from './videoUploadPipeline'

const DB_NAME = 'PackingStationDB'
const DB_VERSION = 2
const STORE_NAME = 'videoQueue'
const CHUNK_STORE = 'recordingChunks'
export const MAX_UPLOAD_RETRIES = VIDEO_UPLOAD_CONFIG.maxUploadRetries
export { VIDEO_STATUS }

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve(req.result)
    req.onupgradeneeded = (e) => {
      const db = e.target.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true })
        store.createIndex('status', 'status', { unique: false })
      } else {
        const tx = e.target.transaction
        const store = tx.objectStore(STORE_NAME)
        if (!store.indexNames.contains('status')) {
          store.createIndex('status', 'status', { unique: false })
        }
      }
      if (!db.objectStoreNames.contains(CHUNK_STORE)) {
        const chunkStore = db.createObjectStore(CHUNK_STORE, { keyPath: 'id', autoIncrement: true })
        chunkStore.createIndex('sessionId', 'sessionId', { unique: false })
      }
    }
  })
}

// ── Recording sessions ───────────────────────────────────────────────────────

export async function startRecordingSession(metadata) {
  const sessionId = `${metadata.consignmentId}_box_${metadata.boxNo}_${Date.now()}`
  const db = await openDB()
  return withIdbTransaction(db, CHUNK_STORE, 'readwrite', async (stores) => {
    await idbRequest(stores[CHUNK_STORE].add({
      sessionId,
      chunkIndex: -1,
      isMeta: true,
      metadata: { ...metadata, sessionId },
      createdAt: Date.now(),
    }))
    return sessionId
  })
}

export async function appendRecordingChunk(sessionId, chunkIndex, blob) {
  if (!blob?.size) return
  const db = await openDB()
  return withIdbTransaction(db, CHUNK_STORE, 'readwrite', async (stores) => {
    await idbRequest(stores[CHUNK_STORE].add({
      sessionId,
      chunkIndex,
      blob,
      createdAt: Date.now(),
    }))
  })
}

export async function markRecordingSessionStorageFailed(sessionId, reason = 'storage_failed') {
  if (!sessionId) return null
  const rows = await getSessionChunks(sessionId)
  const metaRow = rows.find((r) => r.isMeta)
  if (!metaRow) return null
  const db = await openDB()
  return withIdbTransaction(db, CHUNK_STORE, 'readwrite', async (stores) => {
    const next = {
      ...metaRow,
      status: 'storage_failed',
      lastError: String(reason || 'storage_failed'),
      failedAt: Date.now(),
      metadata: {
        ...(metaRow.metadata || {}),
        sessionId,
        recordingStatus: 'storage_failed',
        lastError: String(reason || 'storage_failed'),
      },
    }
    await idbRequest(stores[CHUNK_STORE].put(next))
    return next
  })
}

export async function getRecordingSessionMeta(sessionId) {
  const rows = await getSessionChunks(sessionId)
  return rows.find((r) => r.isMeta) || null
}

export function inspectChunkWriteSettlements(settlements = []) {
  const errors = []
  for (const item of settlements) {
    if (item.status === 'rejected') {
      errors.push(item.reason?.message || String(item.reason || 'chunk write failed'))
    }
  }
  return {
    ok: errors.length === 0,
    failedCount: errors.length,
    successCount: settlements.filter((s) => s.status === 'fulfilled').length,
    errors,
  }
}

async function getSessionChunks(sessionId) {
  const db = await openDB()
  return withIdbTransaction(db, CHUNK_STORE, 'readonly', async (stores) => {
    const idx = stores[CHUNK_STORE].index('sessionId')
    return idbRequest(idx.getAll(sessionId))
  }).then((rows) => rows || [])
}

async function deleteSessionChunks(sessionId) {
  const db = await openDB()
  const rows = await getSessionChunks(sessionId)
  if (!rows.length) return
  return withIdbTransaction(db, CHUNK_STORE, 'readwrite', async (stores) => {
    for (const row of rows) {
      await idbRequest(stores[CHUNK_STORE].delete(row.id))
    }
  })
}

export async function finalizeRecordingSession(sessionId) {
  const rows = await getSessionChunks(sessionId)
  if (!rows.length) return null

  const metaRow = rows.find((r) => r.isMeta)
  const metadata = metaRow?.metadata
  if (metaRow?.status === 'storage_failed' || metadata?.recordingStatus === 'storage_failed') {
    const err = new Error(
      metaRow?.lastError
        || 'Local video storage failed — free disk/browser space and retry recording this box.'
    )
    err.code = 'STORAGE_FAILED'
    err.retryable = true
    throw err
  }

  const chunks = rows
    .filter((r) => !r.isMeta && r.blob)
    .sort((a, b) => a.chunkIndex - b.chunkIndex)

  if (!metadata || chunks.length === 0) {
    return null
  }

  const blob = new Blob(chunks.map((c) => c.blob), { type: metadata.mimeType || 'video/webm' })
  if (blob.size < 1000) {
    const err = new Error('Recording too short or empty — keep recording longer before saving the box.')
    err.code = 'VIDEO_TOO_SMALL'
    throw err
  }

  const queueId = await saveVideoToQueue(blob, metadata)
  await deleteSessionChunks(sessionId)
  return { queueId, blob, metadata, size: blob.size }
}

export async function recoverOrphanedRecordings() {
  const db = await openDB()
  const sessionIds = await withIdbTransaction(db, CHUNK_STORE, 'readonly', async (stores) => {
    const all = await idbRequest(stores[CHUNK_STORE].getAll())
    return [...new Set((all || []).map((r) => r.sessionId).filter(Boolean))]
  })

  const recovered = []
  for (const sessionId of sessionIds) {
    const rows = await getSessionChunks(sessionId)
    const hasData = rows.some((r) => !r.isMeta && r.blob?.size > 0)
    if (!hasData) {
      await deleteSessionChunks(sessionId)
      continue
    }
    try {
      const result = await finalizeRecordingSession(sessionId)
      if (result) recovered.push(result)
    } catch (err) {
      console.warn('[VideoQueue] Orphan finalize skipped:', sessionId, err.message)
    }
  }
  return recovered
}

/** Count open recording sessions, optionally filtered by consignment. */
export async function countOpenRecordingSessions(consignmentId = null) {
  const db = await openDB()
  return withIdbTransaction(db, CHUNK_STORE, 'readonly', async (stores) => {
    const all = await idbRequest(stores[CHUNK_STORE].getAll())
    const metaRows = (all || []).filter((r) => r.isMeta)
    const filtered = consignmentId
      ? metaRows.filter((r) => String(r.metadata?.consignmentId || '') === String(consignmentId))
      : metaRows
    return new Set(filtered.map((r) => r.sessionId).filter(Boolean)).size
  })
}

// ── Upload queue ─────────────────────────────────────────────────────────────

async function getAllQueueRows() {
  const db = await openDB()
  return withIdbTransaction(db, STORE_NAME, 'readonly', async (stores) => {
    const all = await idbRequest(stores[STORE_NAME].getAll())
    return all || []
  })
}

export async function patchVideoQueueEntry(id, patch = {}) {
  const db = await openDB()
  return withIdbTransaction(db, STORE_NAME, 'readwrite', async (stores) => {
    const data = await idbRequest(stores[STORE_NAME].get(id))
    if (!data) return null
    const next = { ...data, ...patch, updatedAt: Date.now() }
    // Never drop the Blob unless explicitly requested
    if (!Object.prototype.hasOwnProperty.call(patch, 'blob')) {
      next.blob = data.blob
    }
    await idbRequest(stores[STORE_NAME].put(next))
    return next
  })
}

export async function saveMultipartProgress(id, multipart, uploadPhase = null) {
  const patch = { multipart: multipart || null }
  if (multipart?.storagePath) patch.resumeStoragePath = multipart.storagePath
  if (uploadPhase) patch.status = uploadPhase
  return patchVideoQueueEntry(id, patch)
}

/**
 * Mark prior active videos for this box as superseded (retain blobs).
 * Returns ids that were superseded.
 */
export async function supersedeVideosForBox(consignmentId, boxNo, keepId = null) {
  if (!consignmentId || boxNo == null || boxNo === '') return []
  const outstanding = await getOutstandingVideos(consignmentId)
  const sameBox = outstanding.filter((v) => String(v.metadata?.boxNo) === String(boxNo))
  const { superseded } = planSupersedeForBox(sameBox, keepId)
  if (!superseded.length) return []

  const db = await openDB()
  const ids = []
  await withIdbTransaction(db, STORE_NAME, 'readwrite', async (stores) => {
    for (const entry of superseded) {
      const data = await idbRequest(stores[STORE_NAME].get(entry.id))
      if (!data || isSupersededStatus(data.status)) continue
      const multipartToAbort = data.multipart?.uploadId
        ? {
            uploadId: data.multipart.uploadId,
            storagePath: data.multipart.storagePath || data.resumeStoragePath || data.storagePath,
            consignmentId,
          }
        : null
      const next = {
        ...data,
        status: VIDEO_STATUS.SUPERSEDED,
        supersededAt: Date.now(),
        supersededBy: keepId,
        pendingMultipartAbort: multipartToAbort,
        // Keep blob + prior fields
      }
      await idbRequest(stores[STORE_NAME].put(next))
      ids.push(entry.id)
    }
  })
  return ids
}

export async function saveVideoToQueue(blob, metadata) {
  const outstanding = await getActiveOutstandingVideos()
  const allIncludingSuperseded = await getOutstandingVideos()
  const outstandingBytes = allIncludingSuperseded.reduce((sum, v) => sum + (v.blob?.size || 0), 0) + (blob?.size || 0)
  const warnings = queueCapWarning(outstanding.length + 1, outstandingBytes)
  if (warnings.length) {
    console.warn('[VideoQueue]', warnings.join(' '))
  }

  const db = await openDB()
  const queueId = await withIdbTransaction(db, STORE_NAME, 'readwrite', async (stores) => {
    const entry = {
      blob,
      metadata,
      status: VIDEO_STATUS.QUEUED,
      retries: 0,
      createdAt: Date.now(),
      lastError: null,
      multipart: null,
      progress: 0,
      queueWarnings: warnings,
    }
    return idbRequest(stores[STORE_NAME].add(entry))
  })

  // Mark prior same-box evidence superseded (retain blobs until this replacement is verified)
  if (metadata?.consignmentId != null && metadata?.boxNo != null) {
    await supersedeVideosForBox(metadata.consignmentId, metadata.boxNo, queueId)
  }

  return queueId
}

export async function getPendingVideos() {
  const all = await getAllQueueRows()
  const now = Date.now()
  return all.filter((v) => isUploadReady(v, now))
}

export async function getOutstandingVideos(consignmentId = null) {
  const all = await getAllQueueRows()
  return all.filter((v) => {
    if (!v || !isOutstandingStatus(v.status)) return false
    if (!consignmentId) return true
    return String(v.metadata?.consignmentId || '') === String(consignmentId)
  })
}

export async function getActiveOutstandingVideos(consignmentId = null) {
  const all = await getOutstandingVideos(consignmentId)
  return all.filter((v) => isActiveOutstandingStatus(v.status))
}

export async function getVideoQueueStatusSnapshot(consignmentId = null) {
  const outstanding = await getOutstandingVideos(consignmentId)
  return outstanding.map((v) => ({
    id: v.id,
    boxNo: v.metadata?.boxNo,
    consignmentId: v.metadata?.consignmentId,
    fileName: v.metadata?.fileName,
    status: normalizeQueueStatus(v.status),
    progress: Number(v.progress) || 0,
    retries: Number(v.retries) || 0,
    lastError: v.lastError || null,
    size: v.blob?.size || 0,
    nextAttemptAt: v.nextAttemptAt || null,
    hasMultipartResume: Boolean(v.multipart?.uploadId && (v.multipart?.completedParts || []).length),
    superseded: isSupersededStatus(v.status),
  }))
}

export async function getFailedVideos() {
  const all = await getAllQueueRows()
  return all.filter((v) => normalizeQueueStatus(v.status) === VIDEO_STATUS.FAILED)
}

/**
 * Delete local video only when server returned verified === true.
 */
export async function markVideoUploaded(id, { verified = false } = {}) {
  if (verified !== true) {
    const err = new Error('Refusing to delete local video before server verified === true')
    err.code = 'VERIFY_REQUIRED'
    throw err
  }
  const row = (await getAllQueueRows()).find((v) => v.id === id)
  const db = await openDB()
  await withIdbTransaction(db, STORE_NAME, 'readwrite', async (stores) => {
    await idbRequest(stores[STORE_NAME].delete(id))
  })

  // After verified replacement, clean superseded evidence for the same box
  if (row?.metadata?.consignmentId != null && row?.metadata?.boxNo != null) {
    await cleanupSupersededForBox(row.metadata.consignmentId, row.metadata.boxNo, id)
  }
}

/** Remove superseded rows for a box after the replacement has been verified. */
export async function cleanupSupersededForBox(consignmentId, boxNo, verifiedReplacementId = null) {
  const outstanding = await getOutstandingVideos(consignmentId)
  const superseded = outstanding.filter(
    (v) => String(v.metadata?.boxNo) === String(boxNo) && isSupersededStatus(v.status)
  )
  if (!superseded.length) return { deleted: 0, abortJobs: [] }

  const abortJobs = []
  const db = await openDB()
  await withIdbTransaction(db, STORE_NAME, 'readwrite', async (stores) => {
    for (const entry of superseded) {
      if (entry.pendingMultipartAbort) abortJobs.push(entry.pendingMultipartAbort)
      await idbRequest(stores[STORE_NAME].delete(entry.id))
    }
  })
  return { deleted: superseded.length, abortJobs, verifiedReplacementId }
}

export async function listPendingMultipartAborts() {
  const all = await getAllQueueRows()
  return all
    .filter((v) => v.pendingMultipartAbort?.uploadId)
    .map((v) => ({ id: v.id, ...v.pendingMultipartAbort }))
}

export async function clearPendingMultipartAbort(id) {
  return patchVideoQueueEntry(id, { pendingMultipartAbort: null })
}

export async function saveUploadedFileInfo(id, storageUrl, storagePath) {
  return patchVideoQueueEntry(id, {
    storageUrl,
    storagePath,
    status: VIDEO_STATUS.OBJECT_UPLOADED,
    multipart: null,
    progress: 100,
  })
}

export async function incrementRetry(id, nextAttemptAt = null, lastError = null) {
  const db = await openDB()
  return withIdbTransaction(db, STORE_NAME, 'readwrite', async (stores) => {
    const data = await idbRequest(stores[STORE_NAME].get(id))
    if (!data) return false
    const next = nextRetryState(data, lastError, {
      now: Date.now(),
      maxRetries: MAX_UPLOAD_RETRIES,
    })
    if (next.status !== VIDEO_STATUS.FAILED && nextAttemptAt != null) {
      next.nextAttemptAt = nextAttemptAt
    }
    const updated = { ...data, ...next, blob: data.blob }
    await idbRequest(stores[STORE_NAME].put(updated))
    return updated.status === VIDEO_STATUS.FAILED
  })
}

/** Reset failed / stuck in-flight uploads after browser or worker restart (keeps backoff cleared once). */
export async function resetFailedToPending() {
  const all = await getAllQueueRows()
  const wake = all.filter((entry) => {
    const status = normalizeQueueStatus(entry.status)
    return (
      status === VIDEO_STATUS.FAILED
      || status === VIDEO_STATUS.UPLOADING
      || status === VIDEO_STATUS.MULTIPART_UPLOADING
      || status === VIDEO_STATUS.MULTIPART_COMPLETING
      || status === VIDEO_STATUS.OBJECT_UPLOADED
      || status === VIDEO_STATUS.VERIFYING
      || status === 'pending'
    )
  })
  if (!wake.length) return 0
  const db = await openDB()
  return withIdbTransaction(db, STORE_NAME, 'readwrite', async (stores) => {
    for (const entry of wake) {
      const data = await idbRequest(stores[STORE_NAME].get(entry.id))
      if (!data || isSupersededStatus(data.status)) continue
      const wasFailed = normalizeQueueStatus(data.status) === VIDEO_STATUS.FAILED
      data.status = wasFailed ? VIDEO_STATUS.QUEUED : VIDEO_STATUS.RETRYING
      if (wasFailed) data.retries = 0
      data.nextAttemptAt = null
      await idbRequest(stores[STORE_NAME].put(data))
    }
    return wake.length
  })
}

function boxKey(entry) {
  return `${entry?.metadata?.consignmentId || ''}::${entry?.metadata?.boxNo || ''}`
}

/**
 * @deprecated Destructive clear — use supersedeVideosForBox. Kept only for explicit discard paths.
 */
export async function clearVideosForBox(consignmentId, boxNo, { confirmDestructive = false } = {}) {
  if (!confirmDestructive) {
    return supersedeVideosForBox(consignmentId, boxNo, null)
  }
  if (!consignmentId || boxNo == null || boxNo === '') return 0
  const outstanding = await getOutstandingVideos(consignmentId)
  const sameBox = outstanding.filter((v) => String(v.metadata?.boxNo) === String(boxNo))
  if (!sameBox.length) return 0
  const db = await openDB()
  return withIdbTransaction(db, STORE_NAME, 'readwrite', async (stores) => {
    for (const entry of sameBox) {
      await idbRequest(stores[STORE_NAME].delete(entry.id))
    }
    return sameBox.length
  })
}

/** Mark older same-box videos superseded (never deletes Blob data). */
export async function pruneOlderVideosForBox(consignmentId, boxNo, keepId = null) {
  return supersedeVideosForBox(consignmentId, boxNo, keepId)
}

/** Mark older duplicates superseded — never destroys Blob data. */
export async function pruneDuplicateBoxVideos() {
  const outstanding = await getActiveOutstandingVideos()
  const newestByBox = new Map()
  for (const entry of outstanding) {
    const key = boxKey(entry)
    const prev = newestByBox.get(key)
    if (!prev || (entry.createdAt || 0) > (prev.createdAt || 0)) {
      newestByBox.set(key, entry)
    }
  }
  let count = 0
  for (const [key, keep] of newestByBox.entries()) {
    const [consignmentId, boxNo] = key.split('::')
    const ids = await supersedeVideosForBox(consignmentId, boxNo, keep.id)
    count += ids.length
  }
  return count
}

/**
 * Explicit operator discard of failed videos.
 * Requires confirmDestructive: true — shows warning at call site.
 */
export async function clearFailedVideos({ confirmDestructive = false } = {}) {
  if (!confirmDestructive) {
    const err = new Error('Discarding failed videos requires explicit confirmation')
    err.code = 'DISCARD_CONFIRM_REQUIRED'
    throw err
  }
  const failed = await getFailedVideos()
  if (!failed.length) return 0
  const db = await openDB()
  return withIdbTransaction(db, STORE_NAME, 'readwrite', async (stores) => {
    for (const entry of failed) {
      await idbRequest(stores[STORE_NAME].delete(entry.id))
    }
    return failed.length
  })
}

export async function clearLocalVideoCache(mode = 'failed', { confirmDestructive = false } = {}) {
  if (mode === 'duplicates') return pruneDuplicateBoxVideos()
  if (mode === 'failed') return clearFailedVideos({ confirmDestructive })

  if (!confirmDestructive) {
    const err = new Error('Clearing local video cache requires explicit confirmation')
    err.code = 'DISCARD_CONFIRM_REQUIRED'
    throw err
  }

  const outstanding = await getOutstandingVideos()
  if (!outstanding.length) return 0
  const db = await openDB()
  return withIdbTransaction(db, STORE_NAME, 'readwrite', async (stores) => {
    for (const entry of outstanding) {
      await idbRequest(stores[STORE_NAME].delete(entry.id))
    }
    return outstanding.length
  })
}

/**
 * Clear nextAttemptAt for immediate retry.
 * ONLY for: user Retry, online event, finish drain, or documented recovery — never every poll.
 */
export async function unlockOutstandingForImmediateRetry() {
  const outstanding = await getActiveOutstandingVideos()
  const wake = outstanding.filter((entry) => {
    const status = normalizeQueueStatus(entry.status)
    return status === VIDEO_STATUS.QUEUED || status === VIDEO_STATUS.RETRYING || status === 'pending'
  })
  if (!wake.length) return 0
  const db = await openDB()
  return withIdbTransaction(db, STORE_NAME, 'readwrite', async (stores) => {
    for (const entry of wake) {
      const data = await idbRequest(stores[STORE_NAME].get(entry.id))
      if (!data) continue
      data.status = VIDEO_STATUS.QUEUED
      data.nextAttemptAt = null
      await idbRequest(stores[STORE_NAME].put(data))
    }
    return wake.length
  })
}

export async function getQueueCount() {
  const outstanding = await getActiveOutstandingVideos()
  return outstanding.filter((v) => {
    const status = normalizeQueueStatus(v.status)
    return status !== VIDEO_STATUS.FAILED && status !== VIDEO_STATUS.STORAGE_FAILED
  }).length
}

export async function getFailedCount() {
  const failed = await getFailedVideos()
  return failed.length
}

export async function getQueueByteTotals() {
  const all = await getOutstandingVideos()
  const active = all.filter((v) => isActiveOutstandingStatus(v.status))
  const bytes = all.reduce((sum, v) => sum + (Number(v.blob?.size) || 0), 0)
  return {
    count: active.length,
    totalCount: all.length,
    bytes,
    bytesMb: bytes / (1024 * 1024),
  }
}

/** Hard backpressure gate before starting a new recording. */
export async function canStartRecordingSafely(storageEstimate = null) {
  const totals = await getQueueByteTotals()
  return evaluateRecordingBackpressure({
    queueCount: totals.count,
    queueBytes: totals.bytes,
    freeMb: storageEstimate?.freeMb ?? null,
    quotaSupported: Boolean(storageEstimate?.supported),
  })
}

/** @internal test seam */
export { openDB as __openDBForTests, STORE_NAME as __STORE_NAME, CHUNK_STORE as __CHUNK_STORE }
