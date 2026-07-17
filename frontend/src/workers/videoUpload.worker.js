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
} from '../utils/videoQueue'

const PART_SIZE = 8 * 1024 * 1024 // 8 MiB — R2/S3 min part is 5 MiB (except last)
const PARALLEL_PARTS = 4
const MULTIPART_THRESHOLD = 8 * 1024 * 1024
const QUEUE_POLL_MS = 2500

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

async function notify() {
  const pending = await getQueueCount()
  const failed = await getFailedCount()
  postMessage({ type: 'STATUS', payload: { pending, failed, uploading: running } })
  return { pending, failed }
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

function backoffMs(retries) {
  return Math.min(12_000, 400 * Math.pow(1.55, Math.max(0, retries)))
}

function uploadTimeoutForBytes(byteLength = 0) {
  const mb = Math.max(0, Number(byteLength) || 0) / (1024 * 1024)
  const ms = Math.round(90_000 + mb * 2_500)
  return Math.min(20 * 60 * 1000, Math.max(60_000, ms))
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
      postMessage({
        type: 'ITEM_PROGRESS',
        payload: { id: entryId, progress: Math.round((loaded / total) * 100) },
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
      postMessage({
        type: 'ITEM_PROGRESS',
        payload: { id: entryId, progress: Math.round((loaded / total) * 100) },
      })
    },
  })
  return storagePath
}

async function uploadMultipartCore(file, metadata, entryId, timeoutMs, { useProxy }) {
  const storagePath = buildVideoStoragePath(metadata, file.name, entryId)
  const created = await apiFetch('/uploads/multipart/create', {
    method: 'POST',
    body: JSON.stringify({
      storagePath,
      mimeType: file.type,
      consignmentId: metadata.consignmentId,
    }),
  })
  const uploadId = created.uploadId
  const finalPath = created.storagePath || storagePath
  if (!uploadId) throw new Error('Failed to start multipart upload')

  const partCount = Math.ceil(file.size / PART_SIZE)
  const partNumbers = Array.from({ length: partCount }, (_, i) => i + 1)
  let urlByPart = new Map()

  if (!useProxy) {
    try {
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
    } catch (err) {
      try {
        await apiFetch('/uploads/multipart/abort', {
          method: 'POST',
          body: JSON.stringify({
            storagePath: finalPath,
            uploadId,
            consignmentId: metadata.consignmentId,
          }),
        })
      } catch { /* ignore */ }
      throw err
    }
  }

  const loadedByPart = new Array(partCount).fill(0)
  const reportProgress = () => {
    const loaded = loadedByPart.reduce((sum, n) => sum + n, 0)
    const percent = Math.max(0, Math.min(99, Math.round((loaded / file.size) * 100)))
    postMessage({ type: 'ITEM_PROGRESS', payload: { id: entryId, progress: percent } })
  }

  try {
    const completed = await mapPool(partNumbers, PARALLEL_PARTS, async (partNumber) => {
      const start = (partNumber - 1) * PART_SIZE
      const end = Math.min(file.size, start + PART_SIZE)
      const blob = file.slice(start, end)
      const partTimeout = Math.max(45_000, Math.round(timeoutMs * (blob.size / file.size) * PARALLEL_PARTS))

      let lastErr = null
      for (let attempt = 0; attempt < 3; attempt++) {
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
                reportProgress()
              },
            })
          } else {
            const uploadUrl = urlByPart.get(partNumber)
            if (!uploadUrl) throw new Error(`Missing signed URL for part ${partNumber}`)
            result = await putBlob(uploadUrl, blob, {
              timeoutMs: partTimeout,
              onProgress: (loaded) => {
                loadedByPart[partNumber - 1] = loaded
                reportProgress()
              },
            })
          }

          const etag = String(result.json?.etag || result.etag || '').replace(/"/g, '')
          if (!etag) throw new Error(`Missing ETag for part ${partNumber}`)
          loadedByPart[partNumber - 1] = blob.size
          reportProgress()
          return { partNumber, etag }
        } catch (err) {
          lastErr = err
          loadedByPart[partNumber - 1] = 0
          reportProgress()
          if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
        }
      }
      throw lastErr || new Error(`Part ${partNumber} failed`)
    })

    await apiFetch('/uploads/multipart/complete', {
      method: 'POST',
      body: JSON.stringify({
        storagePath: finalPath,
        uploadId,
        consignmentId: metadata.consignmentId,
        parts: completed,
      }),
    })

    postMessage({ type: 'ITEM_PROGRESS', payload: { id: entryId, progress: 100 } })
    return finalPath
  } catch (err) {
    try {
      await apiFetch('/uploads/multipart/abort', {
        method: 'POST',
        body: JSON.stringify({
          storagePath: finalPath,
          uploadId,
          consignmentId: metadata.consignmentId,
        }),
      })
    } catch { /* ignore */ }
    throw err
  }
}

async function uploadBytesToR2(file, metadata, entryId, timeoutMs) {
  const useMultipart = file.size >= MULTIPART_THRESHOLD

  if (preferProxyUpload) {
    console.log(`[Worker] Using same-origin proxy upload for Box #${metadata.boxNo}`)
    return useMultipart
      ? uploadMultipartCore(file, metadata, entryId, timeoutMs, { useProxy: true })
      : uploadSingleProxy(file, metadata, entryId, timeoutMs)
  }

  try {
    if (useMultipart) {
      return await uploadMultipartCore(file, metadata, entryId, timeoutMs, { useProxy: false })
    }
    return await uploadSingleDirect(file, metadata, entryId, timeoutMs)
  } catch (err) {
    if (!isCorsOrNetworkError(err)) {
      // Multipart may fail for missing ETag expose — still try proxy.
      if (!/etag|cors|network/i.test(err.message || '')) throw err
    }
    preferProxyUpload = true
    console.warn('[Worker] Direct R2 PUT blocked — switching to same-origin proxy:', err.message)
    return useMultipart
      ? uploadMultipartCore(file, metadata, entryId, timeoutMs, { useProxy: true })
      : uploadSingleProxy(file, metadata, entryId, timeoutMs)
  }
}

async function uploadOneVideo(entry) {
  const { blob, metadata } = entry
  const file = new File([blob], metadata.fileName, { type: metadata.mimeType || 'video/webm' })
  const fileMb = file.size / (1024 * 1024)
  const timeoutMs = uploadTimeoutForBytes(file.size)

  let uploadPath = entry.storagePath

  if (!uploadPath) {
    console.log(`[Worker] Uploading Box #${metadata.boxNo} (${fileMb.toFixed(1)} MB)`)
    uploadPath = await uploadBytesToR2(file, metadata, entry.id, timeoutMs)
    await saveUploadedFileInfo(entry.id, 'r2://uploaded', uploadPath)
  }

  const uploadUrl = entry.storageUrl || 'r2://uploaded'
  postMessage({ type: 'ITEM_PROGRESS', payload: { id: entry.id, progress: 100 } })

  let lastMetaError = null
  for (let attempt = 0; attempt < 5; attempt++) {
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
          clientUploadId: String(metadata.sessionId || entry.id),
          uploadQueueId: String(entry.id),
        }),
      })
      return response.file
    } catch (e) {
      lastMetaError = e
      if (attempt < 4) {
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
      forceNow: Boolean(opts.forceNow || queuedProcessOpts?.forceNow),
    }
    // Drain response will be emitted when the in-flight run completes.
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

      await unlockOutstandingForImmediateRetry()

      const pending = await getPendingVideos()
      await notify()

      for (const video of pending) {
        try {
          postMessage({
            type: 'CURRENT_UPLOAD',
            payload: { id: video.id, boxNo: video.metadata?.boxNo, fileName: video.metadata?.fileName },
          })

          await uploadOneVideo(video)
          await markVideoUploaded(video.id)
          uploadedIds.push(String(video.id))

          postMessage({ type: 'ITEM_DONE', payload: { id: video.id, metadata: video.metadata } })
          postMessage({ type: 'CURRENT_UPLOAD', payload: null })
          await notify()
        } catch (e) {
          const nextAttemptAt = Date.now() + backoffMs(video.retries || 0)
          const isFailed = await incrementRetry(video.id, nextAttemptAt, e.message)
          if (isFailed) failedIds.push(String(video.id))

          postMessage({ type: 'ITEM_ERROR', payload: { id: video.id, error: e.message, isFailed } })
          postMessage({ type: 'CURRENT_UPLOAD', payload: null })
          await notify()
        }
      }
    } while (queuedProcessOpts)

    const status = await notify()
    const pendingIds = []
    try {
      const stillPending = await getPendingVideos()
      for (const v of stillPending) pendingIds.push(String(v.id))
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
    // Do not rethrow — callers need a structured status; reportFailure is via result.error
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
        await processVideoQueue({ forceNow: true })
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
