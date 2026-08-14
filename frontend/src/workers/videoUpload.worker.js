import {
  getPendingVideos,
  markVideoUploaded,
  incrementRetry,
  resetFailedToPending,
  recoverOrphanedRecordings,
  getQueueCount,
  getFailedCount,
  saveUploadedFileInfo,
  finalizeRecordingSession,
  unlockOutstandingForImmediateRetry,
  pruneDuplicateBoxVideos,
  patchVideoQueueEntry,
  saveMultipartProgress,
  getVideoQueueStatusSnapshot,
  getOutstandingVideos,
  listPendingMultipartAborts,
  clearPendingMultipartAbort,
} from '../utils/videoQueue'
import { VIDEO_STATUS, VIDEO_UPLOAD_CONFIG, backoffMs, uploadTimeoutForBytes } from '../utils/videoUploadConfig'
import {
  assertVideoSizeAllowed,
  buildClientUploadId,
  canDeleteLocalVideo,
  decideMultipartRecovery,
  mergeCompletedParts,
  missingMultipartParts,
  shouldUseMultipart,
} from '../utils/videoUploadPipeline'

const PART_SIZE = VIDEO_UPLOAD_CONFIG.partSizeBytes
const PARALLEL_PARTS = VIDEO_UPLOAD_CONFIG.parallelParts
const MULTIPART_THRESHOLD = VIDEO_UPLOAD_CONFIG.multipartThresholdBytes
const QUEUE_POLL_MS = VIDEO_UPLOAD_CONFIG.queuePollMs
const MAX_CONCURRENT = VIDEO_UPLOAD_CONFIG.maxConcurrentUploads
const MAX_PART_ATTEMPTS = VIDEO_UPLOAD_CONFIG.maxPartAttempts
const METADATA_RETRIES = VIDEO_UPLOAD_CONFIG.metadataRetries

let config = {
  apiUrl: '',
  token: '',
}

let intervalId = null
let running = false
let queuedProcessOpts = null
/** Drain requestIds waiting for the in-flight processVideoQueue to finish. */
const pendingDrainRequestIds = new Set()
/** After a CORS/network failure, prefer same-origin proxy for the rest of the session. */
let preferProxyUpload = false
/** In-flight entry ids for concurrency control within one process cycle. */
const activeUploadIds = new Set()

async function notify() {
  const pending = await getQueueCount()
  const failed = await getFailedCount()
  let items = []
  try {
    items = await getVideoQueueStatusSnapshot()
  } catch { /* ignore */ }
  postMessage({
    type: 'STATUS',
    payload: {
      pending,
      failed,
      uploading: running || activeUploadIds.size > 0,
      activeCount: activeUploadIds.size,
      items,
    },
  })
  return { pending, failed, items }
}

function emitItemStatus(entry, status, extra = {}) {
  postMessage({
    type: 'ITEM_STATUS',
    payload: {
      id: entry.id,
      boxNo: entry.metadata?.boxNo,
      consignmentId: entry.metadata?.consignmentId,
      fileName: entry.metadata?.fileName,
      status,
      progress: Number(extra.progress ?? entry.progress) || 0,
      retries: Number(entry.retries) || 0,
      lastError: extra.lastError || entry.lastError || null,
      ...extra,
    },
  })
}

async function apiFetch(endpoint, options = {}) {
  const url = `${config.apiUrl}${endpoint}`
  const headers = {
    'Content-Type': 'application/json',
    ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
    ...options.headers,
  }

  const res = await fetch(url, { ...options, headers })
  if (!res.ok) {
    let errorMsg = `HTTP error ${res.status}`
    try {
      const errBody = await res.json()
      errorMsg = errBody.error || errorMsg
    } catch {
      // ignore
    }
    throw new Error(errorMsg)
  }
  return res.json()
}

function buildVideoStoragePath(metadata, fileName, entryId) {
  const safeCid = String(metadata.consignmentId || '').replace(/[^\w.-]/g, '_')
  const box = String(metadata.boxNo || '').replace(/[^\w.-]/g, '_')
  const extMatch = String(fileName || '').match(/\.(webm|mp4|mov|avi)$/i)
  const ext = extMatch ? extMatch[0].toLowerCase() : '.webm'
  const rev = String(entryId || metadata.clientUploadId || Date.now()).replace(/[^\w.-]/g, '_')
  return `consignments/${safeCid}/boxes/box_${box}/video_${rev}${ext}`
}

function isCorsOrNetworkError(err) {
  return /network error|cors|failed to fetch|load failed|upload aborted/i.test(err?.message || '')
}

function putBlob(uploadUrl, blob, {
  contentType = null,
  auth = false,
  timeoutMs,
  onProgress,
  expectJson = false,
} = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    let settled = false

    const fail = (err) => {
      if (settled) return
      settled = true
      try { xhr.abort() } catch { /* ignore */ }
      reject(err)
    }

    const timer = setTimeout(() => {
      fail(new Error(`R2 upload timed out after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)

    xhr.open('PUT', uploadUrl, true)
    if (contentType) xhr.setRequestHeader('Content-Type', contentType)
    if (auth && config.token) {
      xhr.setRequestHeader('Authorization', `Bearer ${config.token}`)
    }

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total)
    }

    xhr.onload = () => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = xhr.getResponseHeader('ETag') || xhr.getResponseHeader('etag') || ''
        let json = null
        if (expectJson) {
          try { json = JSON.parse(xhr.responseText || '{}') } catch { json = null }
        }
        resolve({ etag: etag || json?.etag || '', status: xhr.status, json })
      } else {
        let detail = `Upload failed with status ${xhr.status}`
        try {
          const body = JSON.parse(xhr.responseText || '{}')
          if (body.error) detail = body.error
        } catch { /* ignore */ }
        reject(new Error(detail))
      }
    }

    xhr.onerror = () => {
      clearTimeout(timer)
      fail(new Error('Network error during file upload. Check R2 CORS allows this site origin for PUT.'))
    }

    xhr.onabort = () => {
      clearTimeout(timer)
      fail(new Error('Upload aborted.'))
    }

    xhr.send(blob)
  })
}

async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

async function uploadSingleDirect(file, metadata, entryId, timeoutMs) {
  const storagePath = buildVideoStoragePath(metadata, file.name, entryId)
  const signed = await apiFetch('/uploads/generate-signed-url', {
    method: 'POST',
    body: JSON.stringify({
      storagePath,
      mimeType: file.type,
      consignmentId: metadata.consignmentId,
    }),
  })
  if (!signed.uploadUrl) throw new Error('Failed to obtain upload authorization from server.')

  await putBlob(signed.uploadUrl, file, {
    contentType: file.type,
    timeoutMs,
    onProgress: (loaded, total) => {
      const progress = Math.round((loaded / total) * 100)
      void patchVideoQueueEntry(entryId, { progress })
      postMessage({
        type: 'ITEM_PROGRESS',
        payload: { id: entryId, progress, status: VIDEO_STATUS.UPLOADING },
      })
    },
  })
  return signed.storagePath || storagePath
}

async function uploadSingleProxy(file, metadata, entryId, timeoutMs) {
  const storagePath = buildVideoStoragePath(metadata, file.name, entryId)
  const qs = new URLSearchParams({
    storagePath,
    consignmentId: String(metadata.consignmentId),
    mimeType: file.type || 'video/webm',
    boxNo: String(metadata.boxNo || ''),
  })
  const url = `${config.apiUrl}/uploads/proxy-object?${qs.toString()}`
  await putBlob(url, file, {
    contentType: file.type || 'application/octet-stream',
    auth: true,
    timeoutMs,
    expectJson: true,
    onProgress: (loaded, total) => {
      const progress = Math.round((loaded / total) * 100)
      void patchVideoQueueEntry(entryId, { progress })
      postMessage({
        type: 'ITEM_PROGRESS',
        payload: { id: entryId, progress, status: VIDEO_STATUS.UPLOADING },
      })
    },
  })
  return storagePath
}

async function listRemoteCompletedParts(storagePath, uploadId, consignmentId) {
  const url = `${config.apiUrl}/uploads/multipart/list-parts`
  const headers = {
    'Content-Type': 'application/json',
    ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
  }
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ storagePath, uploadId, consignmentId }),
  })
  const body = await res.json().catch(() => null)
  if (res.ok && body?.ok !== false) {
    return {
      ok: true,
      parts: mergeCompletedParts([], body.parts || []),
      code: null,
      message: null,
    }
  }
  return {
    ok: false,
    parts: [],
    code: body?.code || (res.status === 404 ? 'NoSuchUpload' : 'LIST_PARTS_FAILED'),
    message: body?.error || body?.message || `ListParts HTTP ${res.status}`,
  }
}

async function headRemoteObject(storagePath, consignmentId, expectedSize, mimeType) {
  const url = `${config.apiUrl}/uploads/object-head`
  const headers = {
    'Content-Type': 'application/json',
    ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
  }
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ storagePath, consignmentId, expectedSize, mimeType }),
  })
  const body = await res.json().catch(() => null)
  if (res.ok && body?.ok) {
    return {
      ok: true,
      size: body.verification?.actualSize,
      contentType: body.verification?.contentType,
      etag: body.verification?.etag,
      storagePath: body.storagePath || storagePath,
    }
  }
  return {
    ok: false,
    code: body?.code || 'HEAD_OBJECT_FAILED',
    message: body?.error || body?.message || `HeadObject HTTP ${res.status}`,
  }
}

async function abortOrphanedMultipartUploads() {
  try {
    const jobs = await listPendingMultipartAborts()
    for (const job of jobs) {
      try {
        await apiFetch('/uploads/multipart/abort', {
          method: 'POST',
          body: JSON.stringify({
            storagePath: job.storagePath,
            uploadId: job.uploadId,
            consignmentId: job.consignmentId,
          }),
        })
      } catch (err) {
        console.warn('[Worker] Multipart abort deferred:', err.message)
        continue
      }
      await clearPendingMultipartAbort(job.id)
    }
  } catch (err) {
    console.warn('[Worker] Pending multipart abort scan failed:', err.message)
  }
}

async function uploadMultipartCore(file, metadata, entryId, timeoutMs, { useProxy, resume = null }) {
  const storagePath = resume?.storagePath || buildVideoStoragePath(metadata, file.name, entryId)
  let uploadId = resume?.uploadId || null
  let finalPath = storagePath
  let completedParts = mergeCompletedParts(resume?.completedParts || [])

  if (uploadId) {
    const listed = await listRemoteCompletedParts(finalPath, uploadId, metadata.consignmentId)
    if (listed.ok) {
      completedParts = mergeCompletedParts(completedParts, listed.parts)
    } else {
      const head = await headRemoteObject(finalPath, metadata.consignmentId, file.size, file.type)
      const decision = decideMultipartRecovery({
        expectedSize: file.size,
        expectedMime: file.type,
        expectedPath: finalPath,
        listResult: listed,
        headResult: head,
      })
      if (decision.action === 'retry_list') {
        throw new Error(decision.error || 'ListParts failed — will retry without clearing local Blob')
      }
      if (decision.action === 'finalize_metadata') {
        await saveUploadedFileInfo(entryId, 'r2://uploaded', decision.storagePath || finalPath)
        await patchVideoQueueEntry(entryId, {
          status: VIDEO_STATUS.OBJECT_UPLOADED,
          multipart: null,
          progress: 100,
        })
        return decision.storagePath || finalPath
      }
      // restart_multipart — clear stale session, keep Blob
      uploadId = null
      completedParts = []
      await saveMultipartProgress(entryId, null)
    }
  }

  if (!uploadId) {
    const created = await apiFetch('/uploads/multipart/create', {
      method: 'POST',
      body: JSON.stringify({
        storagePath,
        mimeType: file.type,
        consignmentId: metadata.consignmentId,
      }),
    })
    uploadId = created.uploadId
    finalPath = created.storagePath || storagePath
    if (!uploadId) throw new Error('Failed to start multipart upload')
  }

  await saveMultipartProgress(entryId, {
    uploadId,
    storagePath: finalPath,
    useProxy: Boolean(useProxy),
    completedParts,
  }, VIDEO_STATUS.MULTIPART_UPLOADING)

  const missing = missingMultipartParts(file.size, completedParts, PART_SIZE)
  const partNumbers = missing.map((p) => p.partNumber)
  let urlByPart = new Map()

  if (!useProxy && partNumbers.length) {
    const signed = await apiFetch('/uploads/multipart/sign-parts', {
      method: 'POST',
      body: JSON.stringify({
        storagePath: finalPath,
        uploadId,
        consignmentId: metadata.consignmentId,
        partNumbers,
      }),
    })
    urlByPart = new Map((signed.parts || []).map((p) => [Number(p.partNumber), p.uploadUrl]))
  }

  const partCount = Math.ceil(file.size / PART_SIZE)
  const loadedByPart = new Array(partCount).fill(0)
  for (const part of completedParts) {
    const start = (part.partNumber - 1) * PART_SIZE
    const end = Math.min(file.size, start + PART_SIZE)
    loadedByPart[part.partNumber - 1] = end - start
  }

  const reportProgress = async () => {
    const loaded = loadedByPart.reduce((sum, n) => sum + n, 0)
    const percent = Math.max(0, Math.min(99, Math.round((loaded / file.size) * 100)))
    await patchVideoQueueEntry(entryId, { progress: percent })
    postMessage({
      type: 'ITEM_PROGRESS',
      payload: { id: entryId, progress: percent, status: VIDEO_STATUS.UPLOADING },
    })
  }
  await reportProgress()

  try {
    const newlyCompleted = await mapPool(missing, PARALLEL_PARTS, async (partPlan) => {
      const partNumber = partPlan.partNumber
      const blob = file.slice(partPlan.start, partPlan.end)
      const partTimeout = Math.max(45_000, Math.round(timeoutMs * (blob.size / file.size) * PARALLEL_PARTS))

      let lastErr = null
      for (let attempt = 0; attempt < MAX_PART_ATTEMPTS; attempt++) {
        try {
          let result
          if (useProxy) {
            const qs = new URLSearchParams({
              storagePath: finalPath,
              uploadId,
              consignmentId: String(metadata.consignmentId),
              partNumber: String(partNumber),
            })
            const url = `${config.apiUrl}/uploads/multipart/proxy-part?${qs.toString()}`
            result = await putBlob(url, blob, {
              contentType: 'application/octet-stream',
              auth: true,
              timeoutMs: partTimeout,
              expectJson: true,
              onProgress: (loaded) => {
                loadedByPart[partNumber - 1] = loaded
                void reportProgress()
              },
            })
          } else {
            const uploadUrl = urlByPart.get(partNumber)
            if (!uploadUrl) throw new Error(`Missing signed URL for part ${partNumber}`)
            result = await putBlob(uploadUrl, blob, {
              timeoutMs: partTimeout,
              onProgress: (loaded) => {
                loadedByPart[partNumber - 1] = loaded
                void reportProgress()
              },
            })
          }

          const etag = String(result.json?.etag || result.etag || '').replace(/"/g, '')
          if (!etag) throw new Error(`Missing ETag for part ${partNumber}`)
          loadedByPart[partNumber - 1] = blob.size
          const merged = mergeCompletedParts(completedParts, [{ partNumber, etag }])
          completedParts = merged
          await saveMultipartProgress(entryId, {
            uploadId,
            storagePath: finalPath,
            useProxy: Boolean(useProxy),
            completedParts: merged,
          })
          await reportProgress()
          return { partNumber, etag }
        } catch (err) {
          lastErr = err
          loadedByPart[partNumber - 1] = 0
          await reportProgress()
          if (attempt < MAX_PART_ATTEMPTS - 1) {
            await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
          }
        }
      }
      throw lastErr || new Error(`Part ${partNumber} failed`)
    })

    completedParts = mergeCompletedParts(completedParts, newlyCompleted)

    await patchVideoQueueEntry(entryId, {
      status: VIDEO_STATUS.MULTIPART_COMPLETING,
      multipart: {
        uploadId,
        storagePath: finalPath,
        useProxy: Boolean(useProxy),
        completedParts,
      },
    })

    await apiFetch('/uploads/multipart/complete', {
      method: 'POST',
      body: JSON.stringify({
        storagePath: finalPath,
        uploadId,
        consignmentId: metadata.consignmentId,
        parts: completedParts,
      }),
    })

    // Object assembled in R2 — persist before metadata so crash recovery can HeadObject
    await patchVideoQueueEntry(entryId, {
      multipart: null,
      storagePath: finalPath,
      storageUrl: 'r2://uploaded',
      progress: 100,
      status: VIDEO_STATUS.OBJECT_UPLOADED,
    })

    postMessage({
      type: 'ITEM_PROGRESS',
      payload: { id: entryId, progress: 100, status: VIDEO_STATUS.OBJECT_UPLOADED },
    })
    return finalPath
  } catch (err) {
    // Keep multipart progress for resume — do NOT abort on transient failures
    await saveMultipartProgress(entryId, {
      uploadId,
      storagePath: finalPath,
      useProxy: Boolean(useProxy),
      completedParts,
    }, VIDEO_STATUS.RETRYING)
    throw err
  }
}

async function uploadBytesToR2(file, metadata, entryId, timeoutMs, resume = null) {
  const useMultipart = shouldUseMultipart(file.size, MULTIPART_THRESHOLD)
  const useProxy = preferProxyUpload || Boolean(resume?.useProxy)

  if (useProxy) {
    console.log(`[Worker] Using same-origin proxy upload for Box #${metadata.boxNo}`)
    return useMultipart
      ? uploadMultipartCore(file, metadata, entryId, timeoutMs, { useProxy: true, resume })
      : uploadSingleProxy(file, metadata, entryId, timeoutMs)
  }

  try {
    if (useMultipart) {
      return await uploadMultipartCore(file, metadata, entryId, timeoutMs, { useProxy: false, resume })
    }
    return await uploadSingleDirect(file, metadata, entryId, timeoutMs)
  } catch (err) {
    if (!isCorsOrNetworkError(err)) {
      if (!/etag|cors|network/i.test(err.message || '')) throw err
    }
    preferProxyUpload = true
    console.warn('[Worker] Direct R2 PUT blocked — switching to same-origin proxy:', err.message)
    return useMultipart
      ? uploadMultipartCore(file, metadata, entryId, timeoutMs, {
          useProxy: true,
          resume: resume || null,
        })
      : uploadSingleProxy(file, metadata, entryId, timeoutMs)
  }
}

async function uploadOneVideo(entry) {
  const { blob, metadata } = entry
  assertVideoSizeAllowed(blob?.size || 0)

  const file = new File([blob], metadata.fileName, { type: metadata.mimeType || 'video/webm' })
  const fileMb = file.size / (1024 * 1024)
  const timeoutMs = uploadTimeoutForBytes(file.size)
  const clientUploadId = buildClientUploadId(metadata, entry.id)

  await patchVideoQueueEntry(entry.id, { status: VIDEO_STATUS.UPLOADING, progress: entry.progress || 0 })
  emitItemStatus(entry, VIDEO_STATUS.UPLOADING)
  postMessage({
    type: 'CURRENT_UPLOAD',
    payload: {
      id: entry.id,
      boxNo: metadata?.boxNo,
      fileName: metadata?.fileName,
      status: VIDEO_STATUS.UPLOADING,
      progress: entry.progress || 0,
    },
  })

  let uploadPath = entry.storagePath

  if (!uploadPath) {
    console.log(`[Worker] Uploading Box #${metadata.boxNo} (${fileMb.toFixed(1)} MB)`)
    uploadPath = await uploadBytesToR2(
      file,
      metadata,
      entry.id,
      timeoutMs,
      entry.multipart || null,
    )
    await saveUploadedFileInfo(entry.id, 'r2://uploaded', uploadPath)
  }

  // Bytes are in R2 — verify via metadata finalize (server HeadObject)
  await patchVideoQueueEntry(entry.id, {
    status: VIDEO_STATUS.VERIFYING,
    progress: 100,
    multipart: null,
  })
  emitItemStatus(entry, VIDEO_STATUS.VERIFYING, { progress: 100 })
  postMessage({
    type: 'CURRENT_UPLOAD',
    payload: {
      id: entry.id,
      boxNo: metadata?.boxNo,
      fileName: metadata?.fileName,
      status: VIDEO_STATUS.VERIFYING,
      progress: 100,
    },
  })

  const uploadUrl = entry.storageUrl || 'r2://uploaded'
  let lastMetaError = null
  for (let attempt = 0; attempt < METADATA_RETRIES; attempt++) {
    try {
      const response = await apiFetch('/uploads/metadata', {
        method: 'POST',
        body: JSON.stringify({
          consignmentId: metadata.consignmentId,
          type: 'video',
          originalName: metadata.fileName,
          storageUrl: uploadUrl,
          storagePath: uploadPath,
          size: file.size,
          mimeType: file.type,
          boxNo: String(metadata.boxNo),
          description: metadata.description || `Box ${metadata.boxNo} packing video`,
          clientUploadId,
          uploadQueueId: String(entry.id),
          // Box reopened to add more qty — server must keep the earlier video(s) for this
          // box instead of evicting them, and label this one as an additional part.
          preserveExisting: metadata?.isReopen === true,
        }),
      })

      const fileRecord = response.file || {}
      // fileRecord.id alone is NEVER proof of R2 verification
      if (!canDeleteLocalVideo({ verified: response.verified === true })) {
        throw new Error(
          response.error
          || 'Server did not return verified:true after R2 integrity check'
        )
      }

      await patchVideoQueueEntry(entry.id, { status: VIDEO_STATUS.VERIFYING, progress: 100 })
      // Only delete IndexedDB when response.verified === true
      await markVideoUploaded(entry.id, { verified: true })
      emitItemStatus(entry, VIDEO_STATUS.COMPLETED, { progress: 100 })
      void abortOrphanedMultipartUploads()
      return fileRecord
    } catch (e) {
      lastMetaError = e
      if (attempt < METADATA_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
      }
    }
  }
  throw lastMetaError
}

function buildWorkerResponse({
  ok,
  requestId = null,
  uploadedIds = [],
  failedIds = [],
  pendingIds = [],
  missingIds = [],
  error = null,
  pending = 0,
  failed = 0,
  result = undefined,
} = {}) {
  const payload = {
    ok: Boolean(ok),
    requestId,
    uploadedIds: [...uploadedIds],
    failedIds: [...failedIds],
    pendingIds: [...pendingIds],
    missingIds: [...missingIds],
    pending: Number(pending) || pendingIds.length,
    failed: Number(failed) || failedIds.length,
  }
  if (error) {
    payload.error = {
      code: error.code || 'WORKER_ERROR',
      message: error.message || String(error),
      retryable: Boolean(error.retryable),
    }
  }
  if (result !== undefined) payload.result = result
  return payload
}

function emitQueueDrained(requestId, status) {
  if (!requestId) return
  postMessage({
    type: 'QUEUE_DRAINED',
    payload: {
      ...status,
      requestId,
    },
  })
}

async function processVideoQueue(opts = {}) {
  const requestId = opts.requestId || null
  if (requestId) pendingDrainRequestIds.add(requestId)

  if (running) {
    queuedProcessOpts = {
      ...(queuedProcessOpts || {}),
      ...opts,
      retryFailed: Boolean(opts.retryFailed || queuedProcessOpts?.retryFailed),
      immediateRetry: Boolean(opts.immediateRetry || queuedProcessOpts?.immediateRetry || opts.retryFailed || queuedProcessOpts?.retryFailed),
      forceNow: Boolean(opts.forceNow || queuedProcessOpts?.forceNow),
    }
    return null
  }

  running = true
  await notify()

  const uploadedIds = []
  const failedIds = []
  let result

  try {
    do {
      const runOpts = queuedProcessOpts || opts
      queuedProcessOpts = null

      try {
        const pruned = await pruneDuplicateBoxVideos()
        if (pruned > 0) {
          console.log(`[Worker] Pruned ${pruned} duplicate box video(s) from local queue`)
        }
      } catch (err) {
        console.warn('[Worker] Duplicate prune skipped:', err?.message || err)
      }

      if (runOpts.retryFailed) {
        await resetFailedToPending()
      }

      // Immediate unlock ONLY for explicit retry / online / finish — never every poll
      if (runOpts.immediateRetry || runOpts.retryFailed) {
        await unlockOutstandingForImmediateRetry()
      }

      const pending = await getPendingVideos()
      await notify()
      void abortOrphanedMultipartUploads()

      // Concurrent uploads (default 2) so next boxes keep packing while videos drain
      await mapPool(pending, MAX_CONCURRENT, async (video) => {
        if (activeUploadIds.has(video.id)) return
        activeUploadIds.add(video.id)
        try {
          await uploadOneVideo(video)
          uploadedIds.push(String(video.id))
          postMessage({
            type: 'ITEM_DONE',
            payload: {
              id: video.id,
              metadata: video.metadata,
              status: VIDEO_STATUS.COMPLETED,
            },
          })
          await notify()
        } catch (e) {
          const nextAttemptAt = Date.now() + backoffMs(video.retries || 0)
          const isFailed = await incrementRetry(video.id, nextAttemptAt, e.message)
          if (isFailed) {
            failedIds.push(String(video.id))
            emitItemStatus(video, VIDEO_STATUS.FAILED, { lastError: e.message })
          } else {
            emitItemStatus(video, VIDEO_STATUS.RETRYING, { lastError: e.message })
          }

          postMessage({
            type: 'ITEM_ERROR',
            payload: {
              id: video.id,
              error: e.message,
              isFailed,
              status: isFailed ? VIDEO_STATUS.FAILED : VIDEO_STATUS.RETRYING,
              boxNo: video.metadata?.boxNo,
            },
          })
          await notify()
        } finally {
          activeUploadIds.delete(video.id)
          postMessage({ type: 'CURRENT_UPLOAD', payload: null })
        }
      })
    } while (queuedProcessOpts)

    const status = await notify()
    const pendingIds = []
    try {
      const stillOutstanding = await getOutstandingVideos()
      for (const v of stillOutstanding) {
        if (v.status !== VIDEO_STATUS.FAILED && v.status !== VIDEO_STATUS.STORAGE_FAILED) {
          pendingIds.push(String(v.id))
        }
      }
    } catch { /* ignore */ }

    result = buildWorkerResponse({
      ok: failedIds.length === 0 && pendingIds.length === 0,
      uploadedIds,
      failedIds,
      pendingIds,
      pending: status.pending,
      failed: status.failed,
      error: failedIds.length || pendingIds.length
        ? {
            code: failedIds.length ? 'UPLOAD_FAILED' : 'UPLOAD_PENDING',
            message: failedIds.length
              ? `${failedIds.length} video upload(s) failed`
              : `${pendingIds.length} video upload(s) still pending`,
            retryable: true,
          }
        : null,
    })
  } catch (error) {
    const status = await notify().catch(() => ({ pending: 0, failed: 0 }))
    result = buildWorkerResponse({
      ok: false,
      uploadedIds,
      failedIds,
      pendingIds: [],
      pending: status.pending,
      failed: status.failed,
      error: {
        code: 'QUEUE_PROCESS_ERROR',
        message: error?.message || 'Queue processing failed',
        retryable: true,
      },
    })
  } finally {
    running = false
    await notify().catch(() => {})
    const drainIds = [...pendingDrainRequestIds]
    pendingDrainRequestIds.clear()
    for (const id of drainIds) {
      emitQueueDrained(id, result || buildWorkerResponse({
        ok: false,
        error: { code: 'QUEUE_PROCESS_ERROR', message: 'Queue processing failed', retryable: true },
      }))
    }
  }

  return result
}

self.onmessage = async (e) => {
  const { type, payload } = e.data

  switch (type) {
    case 'INIT':
      config.apiUrl = payload.apiUrl
      config.token = payload.token

      try {
        const recovered = await recoverOrphanedRecordings()
        if (recovered.length) console.log(`[Worker] Recovered ${recovered.length} interrupted recordings`)
        const pruned = await pruneDuplicateBoxVideos()
        if (pruned > 0) console.log(`[Worker] Pruned ${pruned} duplicate box video(s) on init`)
        await resetFailedToPending()
      } catch (err) {
        console.warn('[Worker] Init recovery error:', err)
      }

      await notify()
      await processVideoQueue({ forceNow: true })

      if (!intervalId) {
        intervalId = setInterval(() => { void processVideoQueue({ forceNow: true }) }, QUEUE_POLL_MS)
      }
      break

    case 'UPDATE_TOKEN':
      config.token = payload.token
      break

    case 'FINALIZE_SESSION': {
      const requestId = payload?.requestId
      let finalizeResult
      try {
        finalizeResult = await finalizeRecordingSession(payload.sessionId)
        if (finalizeResult?.queueId != null) {
          emitItemStatus(
            { id: finalizeResult.queueId, metadata: finalizeResult.metadata, retries: 0 },
            VIDEO_STATUS.QUEUED,
          )
        }
        postMessage({
          type: 'FINALIZE_DONE',
          payload: buildWorkerResponse({
            ok: true,
            requestId,
            uploadedIds: [],
            failedIds: [],
            pendingIds: finalizeResult?.queueId != null ? [String(finalizeResult.queueId)] : [],
            result: finalizeResult,
          }),
        })
        await notify()
        // Do not await full drain — packing next box must not block on upload
        void processVideoQueue({ forceNow: true })
      } catch (err) {
        console.error('[Worker] Finalize error:', err)
        postMessage({
          type: 'FINALIZE_DONE',
          payload: buildWorkerResponse({
            ok: false,
            requestId,
            error: {
              code: err.code || 'FINALIZE_FAILED',
              message: err.message || 'Finalize failed',
              retryable: Boolean(err.retryable),
            },
          }),
        })
      }
      break
    }

    case 'PROCESS_QUEUE': {
      await processVideoQueue({
        retryFailed: payload?.retryFailed,
        immediateRetry: Boolean(payload?.immediateRetry || payload?.retryFailed),
        forceNow: true,
        requestId: payload?.requestId || null,
      })
      break
    }

    case 'STOP':
      if (intervalId) {
        clearInterval(intervalId)
        intervalId = null
      }
      break

    default:
      break
  }
}
