/**
 * Durable video queue for packing-station CCTV recordings.
 *
 * Architecture:
 *  - recordingChunks store: incremental 1s MediaRecorder slices persisted during recording
 *    (crash-safe — survives tab close mid-box)
 *  - videoQueue store: finalized per-box blobs awaiting cloud upload
 *  - Local blobs are deleted only after server metadata + R2 HeadObject verification
 */
import { VIDEO_STATUS, VIDEO_UPLOAD_CONFIG } from './videoUploadConfig'
import {
  isOutstandingStatus,
  isUploadReady,
  normalizeQueueStatus,
  nextRetryState,
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

// ── Recording sessions (incremental chunk persistence) ───────────────────────

export async function startRecordingSession(metadata) {
  const sessionId = `${metadata.consignmentId}_box_${metadata.boxNo}_${Date.now()}`
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNK_STORE, 'readwrite')
    const store = tx.objectStore(CHUNK_STORE)
    const req = store.add({
      sessionId,
      chunkIndex: -1,
      isMeta: true,
      metadata: { ...metadata, sessionId },
      createdAt: Date.now(),
    })
    req.onsuccess = () => resolve(sessionId)
    req.onerror = () => reject(req.error)
  })
}

export async function appendRecordingChunk(sessionId, chunkIndex, blob) {
  if (!blob?.size) return
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNK_STORE, 'readwrite')
    const store = tx.objectStore(CHUNK_STORE)
    const req = store.add({ sessionId, chunkIndex, blob, createdAt: Date.now() })
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

/** Mark a recording session as locally failed (quota / IndexedDB write error). Keeps chunks for recovery. */
export async function markRecordingSessionStorageFailed(sessionId, reason = 'storage_failed') {
  if (!sessionId) return null
  const rows = await getSessionChunks(sessionId)
  const metaRow = rows.find((r) => r.isMeta)
  if (!metaRow) return null
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNK_STORE, 'readwrite')
    const store = tx.objectStore(CHUNK_STORE)
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
    const req = store.put(next)
    req.onsuccess = () => resolve(next)
    req.onerror = () => reject(req.error)
  })
}

export async function getRecordingSessionMeta(sessionId) {
  const rows = await getSessionChunks(sessionId)
  return rows.find((r) => r.isMeta) || null
}

/**
 * Inspect Promise.allSettled results for MediaRecorder chunk writes.
 * Returns { ok, failedCount, errors } — caller must not finalize when ok is false.
 */
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
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNK_STORE, 'readonly')
    const store = tx.objectStore(CHUNK_STORE)
    const idx = store.index('sessionId')
    const req = idx.getAll(sessionId)
    req.onsuccess = () => resolve(req.result || [])
    req.onerror = () => reject(req.error)
  })
}

async function deleteSessionChunks(sessionId) {
  const db = await openDB()
  const rows = await getSessionChunks(sessionId)
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNK_STORE, 'readwrite')
    const store = tx.objectStore(CHUNK_STORE)
    for (const row of rows) store.delete(row.id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** Merge persisted chunks into a single blob and enqueue for upload. */
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
    // Keep empty/incomplete sessions for orphan recovery instead of silent wipe.
    return null
  }

  const blob = new Blob(chunks.map((c) => c.blob), { type: metadata.mimeType || 'video/webm' })
  if (blob.size < 1000) {
    // Too small to be a valid recording — keep chunks for recovery / diagnosis.
    const err = new Error('Recording too short or empty — keep recording longer before saving the box.')
    err.code = 'VIDEO_TOO_SMALL'
    throw err
  }

  // Enqueue first; only delete chunks after the queue write succeeds (no data loss).
  const queueId = await saveVideoToQueue(blob, metadata)
  await deleteSessionChunks(sessionId)
  return { queueId, blob, metadata, size: blob.size }
}

/** Recover recordings that were interrupted before finalize (tab crash / power loss). */
export async function recoverOrphanedRecordings() {
  const db = await openDB()
  const sessionIds = await new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNK_STORE, 'readonly')
    const store = tx.objectStore(CHUNK_STORE)
    const req = store.getAll()
    req.onsuccess = () => {
      const ids = [...new Set((req.result || []).map((r) => r.sessionId).filter(Boolean))]
      resolve(ids)
    }
    req.onerror = () => reject(req.error)
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

export async function countOpenRecordingSessions() {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNK_STORE, 'readonly')
    const store = tx.objectStore(CHUNK_STORE)
    const req = store.getAll()
    req.onsuccess = () => {
      const ids = new Set((req.result || []).map((r) => r.sessionId).filter(Boolean))
      resolve(ids.size)
    }
    req.onerror = () => reject(req.error)
  })
}

// ── Upload queue ────────────────────────────────────────────────────────────

async function getAllQueueRows() {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const req = store.getAll()
    req.onsuccess = () => resolve(req.result || [])
    req.onerror = () => reject(req.error)
  })
}

export async function patchVideoQueueEntry(id, patch = {}) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const getReq = store.get(id)
    getReq.onsuccess = () => {
      const data = getReq.result
      if (!data) {
        resolve(null)
        return
      }
      Object.assign(data, patch, { updatedAt: Date.now() })
      store.put(data)
      resolve(data)
    }
    getReq.onerror = () => reject(getReq.error)
  })
}

/** Persist multipart uploadId + completed part ETags for resumable retries. */
export async function saveMultipartProgress(id, multipart) {
  const patch = { multipart: multipart || null }
  // Do not clear a completed object path while multipart is still in progress
  if (multipart?.storagePath) patch.resumeStoragePath = multipart.storagePath
  return patchVideoQueueEntry(id, patch)
}

export async function saveVideoToQueue(blob, metadata) {
  // New recording for a box replaces any stuck pending/failed clips for that box.
  await clearVideosForBox(metadata?.consignmentId, metadata?.boxNo)

  const outstanding = await getOutstandingVideos()
  const outstandingBytes = outstanding.reduce((sum, v) => sum + (v.blob?.size || 0), 0) + (blob?.size || 0)
  const warnings = queueCapWarning(outstanding.length + 1, outstandingBytes)
  if (warnings.length) {
    console.warn('[VideoQueue]', warnings.join(' '))
  }

  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
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
    const req = store.add(entry)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Videos ready for an upload attempt (queued/retrying, backoff elapsed). */
export async function getPendingVideos() {
  const all = await getAllQueueRows()
  const now = Date.now()
  return all.filter((v) => isUploadReady(v, now))
}

/** All unfinished queue rows for a consignment (any outstanding status). */
export async function getOutstandingVideos(consignmentId = null) {
  const all = await getAllQueueRows()
  return all.filter((v) => {
    if (!v || !isOutstandingStatus(v.status)) return false
    if (!consignmentId) return true
    return String(v.metadata?.consignmentId || '') === String(consignmentId)
  })
}

/** Lightweight per-box status snapshot for the packing UI (no blob payloads). */
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
  }))
}

export async function getFailedVideos() {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    if (store.indexNames.contains('status')) {
      const idx = store.index('status')
      const req = idx.getAll(IDBKeyRange.only('failed'))
      req.onsuccess = () => resolve(req.result || [])
      req.onerror = () => reject(req.error)
    } else {
      const req = store.getAll()
      req.onsuccess = () => resolve((req.result || []).filter((v) => v.status === 'failed'))
      req.onerror = () => reject(req.error)
    }
  })
}

/**
 * Delete local video only after server confirms metadata + R2 verification.
 * Callers must pass { verified: true } from a successful /uploads/metadata response.
 */
export async function markVideoUploaded(id, { verified = false } = {}) {
  if (!verified) {
    const err = new Error('Refusing to delete local video before server+R2 verification')
    err.code = 'VERIFY_REQUIRED'
    throw err
  }
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const req = store.delete(id)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

export async function saveUploadedFileInfo(id, storageUrl, storagePath) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const getReq = store.get(id)
    getReq.onsuccess = () => {
      const data = getReq.result
      if (data) {
        data.storageUrl = storageUrl
        data.storagePath = storagePath
        store.put(data)
      }
      resolve()
    }
    getReq.onerror = () => reject(getReq.error)
  })
}

export async function incrementRetry(id, nextAttemptAt = null, lastError = null) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const getReq = store.get(id)
    getReq.onsuccess = () => {
      const data = getReq.result
      if (data) {
        const next = nextRetryState(data, lastError, {
          now: Date.now(),
          maxRetries: MAX_UPLOAD_RETRIES,
        })
        if (next.status !== VIDEO_STATUS.FAILED && nextAttemptAt != null) {
          next.nextAttemptAt = nextAttemptAt
        }
        Object.assign(data, next)
        store.put(data)
      }
      resolve(data?.status === VIDEO_STATUS.FAILED)
    }
    getReq.onerror = () => reject(getReq.error)
  })
}

/** Reset failed / stuck in-flight uploads after browser or worker restart. */
export async function resetFailedToPending() {
  const all = await getAllQueueRows()
  const wake = all.filter((entry) => {
    const status = normalizeQueueStatus(entry.status)
    return (
      status === VIDEO_STATUS.FAILED
      || status === VIDEO_STATUS.UPLOADING
      || status === VIDEO_STATUS.VERIFYING
      || status === 'pending'
    )
  })
  if (!wake.length) return 0
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    for (const entry of wake) {
      const wasFailed = normalizeQueueStatus(entry.status) === VIDEO_STATUS.FAILED
      entry.status = wasFailed ? VIDEO_STATUS.QUEUED : VIDEO_STATUS.RETRYING
      if (wasFailed) entry.retries = 0
      entry.nextAttemptAt = null
      store.put(entry)
    }
    tx.oncomplete = () => resolve(wake.length)
    tx.onerror = () => reject(tx.error)
  })
}

function boxKey(entry) {
  return `${entry?.metadata?.consignmentId || ''}::${entry?.metadata?.boxNo || ''}`
}

/** Remove every unfinished video for one consign+box. */
export async function clearVideosForBox(consignmentId, boxNo) {
  if (!consignmentId || boxNo == null || boxNo === '') return 0
  const outstanding = await getOutstandingVideos(consignmentId)
  const sameBox = outstanding.filter((v) => String(v.metadata?.boxNo) === String(boxNo))
  if (!sameBox.length) return 0
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    for (const entry of sameBox) store.delete(entry.id)
    tx.oncomplete = () => resolve(sameBox.length)
    tx.onerror = () => reject(tx.error)
  })
}

/** Delete older pending/failed videos for the same consign+box, keep newest. */
export async function pruneOlderVideosForBox(consignmentId, boxNo, keepId = null) {
  if (!consignmentId || boxNo == null || boxNo === '') return 0
  const outstanding = await getOutstandingVideos(consignmentId)
  const sameBox = outstanding
    .filter((v) => String(v.metadata?.boxNo) === String(boxNo))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  if (sameBox.length <= 1) return 0

  const keep = keepId != null
    ? sameBox.find((v) => v.id === keepId) || sameBox[0]
    : sameBox[0]
  const toDelete = sameBox.filter((v) => v.id !== keep?.id)
  if (!toDelete.length) return 0

  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    for (const entry of toDelete) store.delete(entry.id)
    tx.oncomplete = () => resolve(toDelete.length)
    tx.onerror = () => reject(tx.error)
  })
}

/** Keep only the newest outstanding video per consignment+box. */
export async function pruneDuplicateBoxVideos() {
  const outstanding = await getOutstandingVideos()
  const newestByBox = new Map()
  for (const entry of outstanding) {
    const key = boxKey(entry)
    const prev = newestByBox.get(key)
    if (!prev || (entry.createdAt || 0) > (prev.createdAt || 0)) {
      newestByBox.set(key, entry)
    }
  }
  const keepIds = new Set([...newestByBox.values()].map((v) => v.id))
  const toDelete = outstanding.filter((v) => !keepIds.has(v.id))
  if (!toDelete.length) return 0

  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    for (const entry of toDelete) store.delete(entry.id)
    tx.oncomplete = () => resolve(toDelete.length)
    tx.onerror = () => reject(tx.error)
  })
}

/** Permanently discard failed video uploads from this browser. */
export async function clearFailedVideos() {
  const failed = await getFailedVideos()
  if (!failed.length) return 0
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    for (const entry of failed) store.delete(entry.id)
    tx.oncomplete = () => resolve(failed.length)
    tx.onerror = () => reject(tx.error)
  })
}

/**
 * Clear packing video IndexedDB cache.
 * mode: 'failed' | 'all' | 'duplicates'
 */
export async function clearLocalVideoCache(mode = 'failed') {
  if (mode === 'duplicates') return pruneDuplicateBoxVideos()
  if (mode === 'failed') return clearFailedVideos()

  const outstanding = await getOutstandingVideos()
  if (!outstanding.length) return 0
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    for (const entry of outstanding) store.delete(entry.id)
    tx.oncomplete = () => resolve(outstanding.length)
    tx.onerror = () => reject(tx.error)
  })
}

/** Make every unfinished queue item eligible for an immediate upload attempt. */
export async function unlockOutstandingForImmediateRetry() {
  const outstanding = await getOutstandingVideos()
  // Wake queued/retrying items. Failed stays failed until resetFailedToPending().
  const wake = outstanding.filter((entry) => {
    const status = normalizeQueueStatus(entry.status)
    return status === VIDEO_STATUS.QUEUED || status === VIDEO_STATUS.RETRYING || status === 'pending'
  })
  if (!wake.length) return 0
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    for (const entry of wake) {
      entry.status = VIDEO_STATUS.QUEUED
      entry.nextAttemptAt = null
      store.put(entry)
    }
    tx.oncomplete = () => resolve(wake.length)
    tx.onerror = () => reject(tx.error)
  })
}

export async function getQueueCount() {
  const outstanding = await getOutstandingVideos()
  return outstanding.filter((v) => {
    const status = normalizeQueueStatus(v.status)
    return status !== VIDEO_STATUS.FAILED && status !== VIDEO_STATUS.STORAGE_FAILED
  }).length
}

export async function getFailedCount() {
  const failed = await getFailedVideos()
  return failed.length
}
