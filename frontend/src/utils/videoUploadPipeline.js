/**
 * Pure helpers for packing-station video upload reliability.
 * Used by the worker and by stress/recovery simulations (no IndexedDB/R2 I/O).
 */
import {
  VIDEO_STATUS,
  VIDEO_UPLOAD_CONFIG,
  backoffMs,
  recordingReserveBytes,
} from './videoUploadConfig'

/** Normalize legacy `pending` rows to the production status vocabulary. */
export function normalizeQueueStatus(status) {
  if (!status || status === 'pending') return VIDEO_STATUS.QUEUED
  return status
}

export function isSupersededStatus(status) {
  return normalizeQueueStatus(status) === VIDEO_STATUS.SUPERSEDED
}

/** Any local evidence still retained (including superseded). */
export function isOutstandingStatus(status) {
  const s = normalizeQueueStatus(status)
  return (
    s === VIDEO_STATUS.QUEUED
    || s === VIDEO_STATUS.UPLOADING
    || s === VIDEO_STATUS.MULTIPART_UPLOADING
    || s === VIDEO_STATUS.MULTIPART_COMPLETING
    || s === VIDEO_STATUS.OBJECT_UPLOADED
    || s === VIDEO_STATUS.RETRYING
    || s === VIDEO_STATUS.VERIFYING
    || s === VIDEO_STATUS.FAILED
    || s === VIDEO_STATUS.STORAGE_FAILED
    || s === VIDEO_STATUS.SUPERSEDED
  )
}

/** Active (non-superseded) unfinished rows that block finish / count toward queue caps. */
export function isActiveOutstandingStatus(status) {
  return isOutstandingStatus(status) && !isSupersededStatus(status)
}

export function isUploadReady(entry, now = Date.now()) {
  const status = normalizeQueueStatus(entry?.status)
  if (isSupersededStatus(status)) return false
  if (status === VIDEO_STATUS.FAILED || status === VIDEO_STATUS.STORAGE_FAILED) return false
  if (
    status === VIDEO_STATUS.UPLOADING
    || status === VIDEO_STATUS.MULTIPART_UPLOADING
    || status === VIDEO_STATUS.MULTIPART_COMPLETING
    || status === VIDEO_STATUS.OBJECT_UPLOADED
    || status === VIDEO_STATUS.VERIFYING
  ) {
    return false
  }
  if (status !== VIDEO_STATUS.QUEUED && status !== VIDEO_STATUS.RETRYING) return false
  if (entry?.nextAttemptAt && entry.nextAttemptAt > now) return false
  return true
}

/**
 * Local Blob may be deleted only when the server returns verified === true.
 * fileRecord.id alone is never sufficient.
 */
export function canDeleteLocalVideo({ verified } = {}) {
  return verified === true
}

/**
 * Mark older same-box entries as superseded (pure). Never deletes blobs.
 * Returns { keep, superseded[] }.
 */
export function planSupersedeForBox(entries, keepId = null) {
  const sameBox = [...(entries || [])].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  if (sameBox.length <= 1) {
    return { keep: sameBox[0] || null, superseded: [] }
  }
  const keep = keepId != null
    ? sameBox.find((v) => v.id === keepId) || sameBox[0]
    : sameBox[0]
  const superseded = sameBox.filter((v) => v.id !== keep?.id && !isSupersededStatus(v.status))
  return { keep, superseded }
}

/**
 * Multipart crash-recovery decision after ListParts / HeadObject probes.
 * listResult: { ok, code, parts } | null
 * headResult: { ok, size, contentType, etag } | null
 */
export function decideMultipartRecovery({
  expectedSize,
  expectedMime,
  expectedPath,
  listResult,
  headResult,
} = {}) {
  if (listResult?.ok) {
    return {
      action: 'resume_parts',
      completedParts: listResult.parts || [],
      reason: 'active_multipart',
    }
  }

  const code = String(listResult?.code || '')
  const message = String(listResult?.message || '')
  const noSuchUpload = /nosuchupload|expired|aborted/i.test(`${code} ${message}`)

  if (listResult && !listResult.ok && !noSuchUpload) {
    return {
      action: 'retry_list',
      reason: 'list_parts_error',
      error: listResult.message || code || 'ListParts failed',
    }
  }

  // Upload ID gone — check if object already assembled
  if (headResult?.ok) {
    const sizeOk = Number(headResult.size) === Number(expectedSize) && Number(expectedSize) > 0
    const mimeBase = String(headResult.contentType || '').split(';')[0].trim().toLowerCase()
    const expectedBase = String(expectedMime || '').split(';')[0].trim().toLowerCase()
    const mimeOk = !expectedBase || mimeBase === expectedBase || mimeBase.startsWith('video/')
    const pathOk = !expectedPath || headResult.storagePath === expectedPath
    if (sizeOk && mimeOk && pathOk) {
      return {
        action: 'finalize_metadata',
        reason: 'object_already_complete',
        storagePath: headResult.storagePath || expectedPath,
        etag: headResult.etag || null,
      }
    }
    return {
      action: 'restart_multipart',
      reason: 'object_invalid',
      clearMultipart: true,
      preserveBlob: true,
    }
  }

  return {
    action: 'restart_multipart',
    reason: noSuchUpload ? 'upload_gone' : 'object_missing',
    clearMultipart: true,
    preserveBlob: true,
  }
}

/**
 * Hard backpressure before starting a recording. Never deletes evidence to make room.
 */
export function evaluateRecordingBackpressure({
  queueCount = 0,
  queueBytes = 0,
  freeMb = null,
  quotaSupported = true,
  config = VIDEO_UPLOAD_CONFIG,
} = {}) {
  const reserveBytes = recordingReserveBytes(config)
  const reserveMb = reserveBytes / (1024 * 1024)
  const maxBytes = config.maxQueuedBytesMb * 1024 * 1024
  const blockers = []
  const actions = []

  if (queueCount >= config.maxQueuedVideos) {
    blockers.push(
      `Local video queue has ${queueCount} active videos (limit ${config.maxQueuedVideos}).`
    )
    actions.push('Wait for uploads to finish, or use Retry / stay online until the queue drains.')
    actions.push('Do not discard videos unless an administrator explicitly confirms discard.')
  }

  if (queueBytes + reserveBytes > maxBytes) {
    blockers.push(
      `Local video cache is ~${(queueBytes / (1024 * 1024)).toFixed(0)} MB; `
      + `need ~${reserveMb.toFixed(0)} MB free within the ${config.maxQueuedBytesMb} MB budget.`
    )
    actions.push('Finish uploading queued videos to free browser storage before recording again.')
  }

  if (quotaSupported && freeMb != null && freeMb < reserveMb) {
    blockers.push(
      `Browser reports only ~${Number(freeMb).toFixed(0)} MB free; `
      + `need ~${reserveMb.toFixed(0)} MB reserved for a full box video.`
    )
    actions.push('Free disk space on this computer, close other tabs, then retry.')
    actions.push('Keep this packing tab open so uploads can finish and free IndexedDB space.')
  }

  if (!quotaSupported) {
    // Cannot measure — still enforce queue count/bytes; warn operator
    actions.push('Browser storage estimate unavailable — queue limits still apply.')
  }

  return {
    allowed: blockers.length === 0,
    blockers,
    actions: [...new Set(actions)],
    reserveBytes,
    reserveMb,
  }
}

export function buildClientUploadId(metadata, entryId) {
  return String(metadata?.sessionId || entryId || '')
}

export function planMultipartParts(fileSize, partSizeBytes = VIDEO_UPLOAD_CONFIG.partSizeBytes) {
  const size = Math.max(0, Number(fileSize) || 0)
  const partSize = Math.max(5 * 1024 * 1024, Number(partSizeBytes) || VIDEO_UPLOAD_CONFIG.partSizeBytes)
  if (size <= 0) return []
  const count = Math.ceil(size / partSize)
  return Array.from({ length: count }, (_, i) => {
    const partNumber = i + 1
    const start = i * partSize
    const end = Math.min(size, start + partSize)
    return { partNumber, start, end, byteLength: end - start }
  })
}

/**
 * Given previously completed parts, return only parts still needing upload.
 * completedParts: [{ partNumber, etag }]
 */
export function missingMultipartParts(fileSize, completedParts = [], partSizeBytes = VIDEO_UPLOAD_CONFIG.partSizeBytes) {
  const planned = planMultipartParts(fileSize, partSizeBytes)
  const done = new Set(
    (completedParts || [])
      .filter((p) => p?.partNumber && p?.etag)
      .map((p) => Number(p.partNumber))
  )
  return planned.filter((p) => !done.has(p.partNumber))
}

export function mergeCompletedParts(existing = [], next = []) {
  const byPart = new Map()
  for (const part of [...existing, ...next]) {
    const partNumber = Number(part?.partNumber ?? part?.PartNumber)
    const etag = String(part?.etag || part?.ETag || '').replace(/"/g, '')
    if (!partNumber || !etag) continue
    byPart.set(partNumber, { partNumber, etag })
  }
  return [...byPart.values()].sort((a, b) => a.partNumber - b.partNumber)
}

export function shouldUseMultipart(fileSize, threshold = VIDEO_UPLOAD_CONFIG.multipartThresholdBytes) {
  return Number(fileSize) >= Number(threshold)
}

export function assertVideoSizeAllowed(fileSize, maxBytes = VIDEO_UPLOAD_CONFIG.maxVideoBytes) {
  const size = Number(fileSize) || 0
  if (size > maxBytes) {
    const err = new Error(
      `Video is ${(size / (1024 * 1024)).toFixed(0)} MB — maximum allowed is ${(maxBytes / (1024 * 1024)).toFixed(0)} MB.`
    )
    err.code = 'VIDEO_TOO_LARGE'
    err.retryable = false
    throw err
  }
  return size
}

export function nextRetryState(entry, errorMessage, {
  now = Date.now(),
  maxRetries = VIDEO_UPLOAD_CONFIG.maxUploadRetries,
} = {}) {
  const retries = (Number(entry?.retries) || 0) + 1
  if (retries >= maxRetries) {
    return {
      status: VIDEO_STATUS.FAILED,
      retries,
      nextAttemptAt: null,
      lastError: String(errorMessage || 'upload failed').slice(0, 300),
      multipart: entry?.multipart || null,
    }
  }
  return {
    status: VIDEO_STATUS.RETRYING,
    retries,
    nextAttemptAt: now + backoffMs(retries - 1),
    lastError: String(errorMessage || 'upload failed').slice(0, 300),
    // Keep multipart progress for resumable retry
    multipart: entry?.multipart || null,
  }
}

export function queueCapWarning(outstandingCount, outstandingBytes, config = VIDEO_UPLOAD_CONFIG) {
  const warnings = []
  if (outstandingCount >= config.maxQueuedVideos) {
    warnings.push(`Local video queue has ${outstandingCount} unfinished videos (limit ${config.maxQueuedVideos}).`)
  }
  const mb = outstandingBytes / (1024 * 1024)
  if (mb >= config.maxQueuedBytesMb) {
    warnings.push(`Local video cache is ~${mb.toFixed(0)} MB (limit ${config.maxQueuedBytesMb} MB).`)
  }
  return warnings
}

/**
 * Concurrent upload scheduler for stress tests and worker planning.
 * Returns waves of entry ids (size <= concurrency).
 */
export function scheduleUploadWaves(readyIds, concurrency = VIDEO_UPLOAD_CONFIG.maxConcurrentUploads) {
  const limit = Math.max(1, Number(concurrency) || 1)
  const waves = []
  for (let i = 0; i < readyIds.length; i += limit) {
    waves.push(readyIds.slice(i, i + limit))
  }
  return waves
}

/**
 * Simulate continuous packing of N boxes with flaky network / resume / verify gates.
 * Returns a structured report — used by stress tests. Does not touch real storage.
 */
export function simulateContinuousPackingUpload({
  boxCount = 100,
  minMb = 10,
  maxMb = 200,
  concurrency = VIDEO_UPLOAD_CONFIG.maxConcurrentUploads,
  partFailEvery = 17,
  disconnectBoxes = [12, 45, 88],
  browserRestartAfterBox = 50,
  workerRestartAfterBox = 70,
  storageQuotaFailAtBox = null,
  maxRetries = VIDEO_UPLOAD_CONFIG.maxUploadRetries,
  partSizeMb = 8,
} = {}) {
  const partSizeBytes = partSizeMb * 1024 * 1024
  const disconnectSet = new Set(disconnectBoxes.map(Number))
  const serverVideos = new Map() // key: consign::box -> { clientUploadId, size, verified }
  const localQueue = []
  const events = []
  let partAttempts = 0
  let duplicateBlocked = 0
  let localDeletes = 0
  let prematureDeletes = 0
  let resumedMultipart = 0
  let maxInFlight = 0

  const sizeForBox = (boxNo) => {
    // Deterministic spread from 10–200 MB
    const t = (boxNo - 1) / Math.max(1, boxCount - 1)
    return Math.round((minMb + (maxMb - minMb) * t) * 1024 * 1024)
  }

  const enqueue = (boxNo) => {
    if (storageQuotaFailAtBox != null && boxNo === storageQuotaFailAtBox) {
      events.push({ type: 'storage_failed', boxNo })
      localQueue.push({
        id: `q_${boxNo}`,
        boxNo,
        status: VIDEO_STATUS.STORAGE_FAILED,
        size: sizeForBox(boxNo),
        retries: 0,
        clientUploadId: `sess_${boxNo}`,
        multipart: null,
        metadataSaved: false,
        storageVerified: false,
      })
      return
    }
    localQueue.push({
      id: `q_${boxNo}`,
      boxNo,
      status: VIDEO_STATUS.QUEUED,
      size: sizeForBox(boxNo),
      retries: 0,
      clientUploadId: `sess_${boxNo}`,
      multipart: null,
      metadataSaved: false,
      storageVerified: false,
      completedParts: [],
    })
    events.push({ type: 'queued', boxNo })
  }

  const tryUploadOne = (entry, { forceDisconnect = false } = {}) => {
    entry.status = VIDEO_STATUS.UPLOADING
    let completed = mergeCompletedParts(entry.completedParts || [])

    if (entry.multipart?.uploadId && completed.length) {
      resumedMultipart += 1
      events.push({ type: 'multipart_resume', boxNo: entry.boxNo, completed: completed.length })
    } else {
      entry.multipart = { uploadId: `mp_${entry.boxNo}_${entry.retries}`, storagePath: `path/${entry.boxNo}` }
    }

    const missing = missingMultipartParts(entry.size, completed, partSizeBytes)
    for (const part of missing) {
      partAttempts += 1
      if (forceDisconnect) {
        entry.completedParts = completed
        const next = nextRetryState(entry, 'network disconnect', { maxRetries })
        Object.assign(entry, next)
        events.push({ type: 'disconnect', boxNo: entry.boxNo })
        return false
      }
      if (partFailEvery > 0 && partAttempts % partFailEvery === 0) {
        // Persist completed parts so the next attempt resumes
        entry.completedParts = completed
        const next = nextRetryState(entry, `part ${part.partNumber} failed`, { maxRetries })
        Object.assign(entry, next)
        events.push({ type: 'part_fail', boxNo: entry.boxNo, part: part.partNumber })
        return false
      }
      completed = mergeCompletedParts(completed, [{ partNumber: part.partNumber, etag: `etag_${part.partNumber}` }])
      entry.completedParts = completed
    }

    // All parts uploaded — verifying (HeadObject + metadata)
    entry.status = VIDEO_STATUS.VERIFYING
    events.push({ type: 'verifying', boxNo: entry.boxNo })

    const key = `c1::${entry.boxNo}`
    const existing = serverVideos.get(key)
    if (existing && existing.clientUploadId === entry.clientUploadId) {
      duplicateBlocked += 1
      entry.metadataSaved = true
      entry.storageVerified = true
    } else if (existing && existing.clientUploadId !== entry.clientUploadId) {
      // New recording for same box replaces — still one DB record
      serverVideos.set(key, {
        clientUploadId: entry.clientUploadId,
        size: entry.size,
        verified: true,
      })
      entry.metadataSaved = true
      entry.storageVerified = true
    } else {
      serverVideos.set(key, {
        clientUploadId: entry.clientUploadId,
        size: entry.size,
        verified: true,
      })
      entry.metadataSaved = true
      entry.storageVerified = true
    }

    if (!canDeleteLocalVideo({ verified: entry.storageVerified === true && entry.metadataSaved === true })) {
      prematureDeletes += 1
      return false
    }

    entry.status = VIDEO_STATUS.COMPLETED
    localDeletes += 1
    events.push({ type: 'completed', boxNo: entry.boxNo })
    return true
  }

  // Pack boxes back-to-back; uploads run concurrently in the background.
  // Operators enqueue several boxes before each upload wave (non-blocking next box).
  const PACK_AHEAD = Math.max(concurrency * 2, 4)
  let nextBox = 1
  let inFlight = []

  const pump = () => {
    while (inFlight.length < concurrency) {
      const ready = localQueue.find((e) => isUploadReady(e) && !inFlight.includes(e.id))
      if (!ready) break
      inFlight.push(ready.id)
    }
    maxInFlight = Math.max(maxInFlight, inFlight.length)
  }

  const applyRestart = (kind, afterBox) => {
    for (const entry of localQueue) {
      if (entry.status === VIDEO_STATUS.UPLOADING || entry.status === VIDEO_STATUS.VERIFYING) {
        entry.status = VIDEO_STATUS.RETRYING
        entry.nextAttemptAt = null
      }
    }
    inFlight = []
    events.push({ type: kind, afterBox })
  }

  while (nextBox <= boxCount || inFlight.length || localQueue.some((e) => isUploadReady(e) || e.status === VIDEO_STATUS.RETRYING)) {
    // Operator starts several next boxes without waiting for uploads
    let packedThisTick = 0
    while (nextBox <= boxCount && packedThisTick < PACK_AHEAD) {
      enqueue(nextBox)
      if (browserRestartAfterBox != null && nextBox === browserRestartAfterBox) {
        applyRestart('browser_restart', nextBox)
      }
      if (workerRestartAfterBox != null && nextBox === workerRestartAfterBox) {
        applyRestart('worker_restart', nextBox)
      }
      nextBox += 1
      packedThisTick += 1
    }

    // Wake backoff items for simulation
    for (const entry of localQueue) {
      if (entry.status === VIDEO_STATUS.RETRYING) {
        entry.nextAttemptAt = null
      }
    }

    pump()
    if (!inFlight.length) {
      if (nextBox > boxCount) break
      continue
    }

    const wave = inFlight.splice(0, concurrency)
    for (const id of wave) {
      const entry = localQueue.find((e) => e.id === id)
      if (!entry || entry.status === VIDEO_STATUS.COMPLETED) continue
      const disconnect = disconnectSet.has(entry.boxNo) && entry.retries === 0
      const ok = tryUploadOne(entry, { forceDisconnect: disconnect })
      if (ok) {
        // Remove from local queue (delete after verify)
        const idx = localQueue.indexOf(entry)
        if (idx >= 0) localQueue.splice(idx, 1)
      }
    }
  }

  // Retry storage_failed / remaining failed until max or success for report
  for (const entry of [...localQueue]) {
    if (entry.status === VIDEO_STATUS.STORAGE_FAILED) continue
    let guard = 0
    while (entry.status !== VIDEO_STATUS.COMPLETED && entry.status !== VIDEO_STATUS.FAILED && guard < maxRetries + 2) {
      entry.nextAttemptAt = null
      if (entry.status === VIDEO_STATUS.RETRYING || entry.status === VIDEO_STATUS.QUEUED) {
        const ok = tryUploadOne(entry, { forceDisconnect: false })
        if (ok) {
          const idx = localQueue.indexOf(entry)
          if (idx >= 0) localQueue.splice(idx, 1)
          break
        }
      } else {
        break
      }
      guard += 1
    }
  }

  const completedBoxes = serverVideos.size
  const remaining = localQueue.filter((e) => e.status !== VIDEO_STATUS.COMPLETED)
  const failed = remaining.filter((e) => e.status === VIDEO_STATUS.FAILED || e.status === VIDEO_STATUS.STORAGE_FAILED)
  const finishBlocked = remaining.length > 0

  // Finish gate: every non-storage-failed box must be verified on server
  const expectedVerified = storageQuotaFailAtBox != null ? boxCount - 1 : boxCount
  const allVerified = completedBoxes >= expectedVerified && !finishBlocked

  return {
    boxCount,
    completedBoxes,
    verifiedOnServer: completedBoxes,
    remainingLocal: remaining.length,
    failedCount: failed.length,
    duplicateBlocked,
    localDeletes,
    prematureDeletes,
    resumedMultipart,
    maxInFlight,
    partAttempts,
    finishBlocked,
    allVerified,
    events,
    ok: prematureDeletes === 0
      && duplicateBlocked >= 0
      && maxInFlight <= concurrency
      && allVerified
      && (storageQuotaFailAtBox == null || failed.some((e) => e.boxNo === storageQuotaFailAtBox)),
  }
}
