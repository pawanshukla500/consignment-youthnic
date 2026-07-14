/* eslint-env worker */
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

/** Fast early retries; cap at 12s so Pending Sync does not stall for minutes. */
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

function putBlob(uploadUrl, blob, {
  contentType = null,
  timeoutMs,
  onProgress,
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

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total)
    }

    xhr.onload = () => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = xhr.getResponseHeader('ETag') || xhr.getResponseHeader('etag') || ''
        resolve({ etag, status: xhr.status })
      } else {
        reject(new Error(`R2 upload failed with status ${xhr.status}`))
      }
    }

    xhr.onerror = () => {
      clearTimeout(timer)
      // status 0 / network often = CORS or blocked direct R2 PUT
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

async function uploadSinglePut(file, metadata, entryId, timeoutMs) {
  const storagePath = buildVideoStoragePath(metadata, file.name, entryId)
  let lastUploadError = null
  let uploadPath = null

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const storagePathReq = await apiFetch('/uploads/generate-signed-url', {
        method: 'POST',
        body: JSON.stringify({
          storagePath,
          mimeType: file.type,
          consignmentId: metadata.consignmentId,
        }),
      })
      if (!storagePathReq.uploadUrl) {
        throw new Error('Failed to obtain upload authorization from server.')
      }
      uploadPath = storagePathReq.storagePath || storagePath

      await putBlob(storagePathReq.uploadUrl, file, {
        contentType: file.type,
        timeoutMs,
        onProgress: (loaded, total) => {
          const percent = Math.round((loaded / total) * 100)
          postMessage({ type: 'ITEM_PROGRESS', payload: { id: entryId, progress: percent } })
        },
      })
      lastUploadError = null
      break
    } catch (err) {
      lastUploadError = err
      uploadPath = null
      const retryable = /network|timeout|status 5\d\d|authorization|cors/i.test(err.message || '')
      if (!retryable || attempt === 2) break
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)))
    }
  }

  if (lastUploadError) throw lastUploadError
  return uploadPath
}

async function uploadMultipart(file, metadata, entryId, timeoutMs) {
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

  let signed
  try {
    signed = await apiFetch('/uploads/multipart/sign-parts', {
      method: 'POST',
      body: JSON.stringify({
        storagePath: finalPath,
        uploadId,
        consignmentId: metadata.consignmentId,
        partNumbers,
      }),
    })
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

  const urlByPart = new Map((signed.parts || []).map((p) => [Number(p.partNumber), p.uploadUrl]))
  const loadedByPart = new Array(partCount).fill(0)
  const reportProgress = () => {
    const loaded = loadedByPart.reduce((sum, n) => sum + n, 0)
    const percent = Math.max(0, Math.min(99, Math.round((loaded / file.size) * 100)))
    postMessage({ type: 'ITEM_PROGRESS', payload: { id: entryId, progress: percent } })
  }

  try {
    const completed = await mapPool(partNumbers, PARALLEL_PARTS, async (partNumber) => {
      const uploadUrl = urlByPart.get(partNumber)
      if (!uploadUrl) throw new Error(`Missing signed URL for part ${partNumber}`)
      const start = (partNumber - 1) * PART_SIZE
      const end = Math.min(file.size, start + PART_SIZE)
      const blob = file.slice(start, end)
      const partTimeout = Math.max(45_000, Math.round(timeoutMs * (blob.size / file.size) * PARALLEL_PARTS))

      let lastErr = null
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const result = await putBlob(uploadUrl, blob, {
            timeoutMs: partTimeout,
            onProgress: (loaded) => {
              loadedByPart[partNumber - 1] = loaded
              reportProgress()
            },
          })
          const etag = String(result.etag || '').replace(/"/g, '')
          if (!etag) throw new Error(`Missing ETag for part ${partNumber} (R2 CORS must expose ETag)`)
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

async function uploadOneVideo(entry) {
  const { blob, metadata } = entry
  const file = new File([blob], metadata.fileName, { type: metadata.mimeType || 'video/webm' })
  const fileMb = file.size / (1024 * 1024)
  const timeoutMs = uploadTimeoutForBytes(file.size)

  let uploadPath = entry.storagePath

  if (!uploadPath) {
    console.log(`[Worker] Uploading Box #${metadata.boxNo} (${fileMb.toFixed(1)} MB) via ${file.size >= MULTIPART_THRESHOLD ? 'multipart' : 'single PUT'}`)
    if (file.size >= MULTIPART_THRESHOLD) {
      try {
        uploadPath = await uploadMultipart(file, metadata, entry.id, timeoutMs)
      } catch (err) {
        // Missing ExposeHeaders ETag / CORS often breaks multipart — fall back to one PUT.
        console.warn('[Worker] Multipart failed, falling back to single PUT:', err.message)
        uploadPath = await uploadSinglePut(file, metadata, entry.id, timeoutMs)
      }
    } else {
      uploadPath = await uploadSinglePut(file, metadata, entry.id, timeoutMs)
    }

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

async function processVideoQueue(opts = {}) {
  if (running) {
    queuedProcessOpts = {
      ...(queuedProcessOpts || {}),
      ...opts,
      retryFailed: Boolean(opts.retryFailed || queuedProcessOpts?.retryFailed),
      forceNow: Boolean(opts.forceNow || queuedProcessOpts?.forceNow),
    }
    return
  }
  running = true
  await notify()

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

      // Always clear short backoffs so Pending Sync drains promptly.
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

          postMessage({ type: 'ITEM_DONE', payload: { id: video.id, metadata: video.metadata } })
          postMessage({ type: 'CURRENT_UPLOAD', payload: null })
          await notify()
        } catch (e) {
          const nextAttemptAt = Date.now() + backoffMs(video.retries || 0)
          const isFailed = await incrementRetry(video.id, nextAttemptAt, e.message)

          postMessage({ type: 'ITEM_ERROR', payload: { id: video.id, error: e.message, isFailed } })
          postMessage({ type: 'CURRENT_UPLOAD', payload: null })
          await notify()
          // Do not sleep here — continue other videos; poller retries soon.
        }
      }
    } while (queuedProcessOpts)
  } finally {
    running = false
    const status = await notify()
    return status
  }
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
      try {
        const result = await finalizeRecordingSession(payload.sessionId)
        postMessage({ type: 'FINALIZE_DONE', payload: { requestId, ok: true, result } })
        await notify()
        await processVideoQueue({ forceNow: true })
      } catch (err) {
        console.error('[Worker] Finalize error:', err)
        postMessage({
          type: 'FINALIZE_DONE',
          payload: { requestId, ok: false, error: err.message || 'Finalize failed' },
        })
      }
      break
    }

    case 'PROCESS_QUEUE': {
      const requestId = payload?.requestId
      const status = await processVideoQueue({
        retryFailed: payload?.retryFailed,
        forceNow: true,
      })
      if (requestId) {
        postMessage({
          type: 'QUEUE_DRAINED',
          payload: { requestId, pending: status?.pending ?? 0, failed: status?.failed ?? 0 },
        })
      }
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
