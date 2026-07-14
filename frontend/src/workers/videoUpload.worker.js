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
} from '../utils/videoQueue'

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

function backoffMs(retries) {
  return Math.min(60_000, 3000 * Math.pow(1.8, retries))
}

async function uploadOneVideo(entry) {
  const { blob, metadata } = entry
  const file = new File([blob], metadata.fileName, { type: metadata.mimeType || 'video/webm' })
  const fileMb = file.size / (1024 * 1024)
  // Scale timeout with size (50–100MB needs longer than a fixed 10 min on slow links)
  const timeoutMs = Math.min(30 * 60 * 1000, Math.max(10 * 60 * 1000, Math.round(180_000 + fileMb * 3_000)))

  let uploadPath = entry.storagePath

  if (!uploadPath) {
    const storagePathReq = await apiFetch('/uploads/generate-signed-url', {
      method: 'POST',
      body: JSON.stringify({
        storagePath: (() => {
          const safeCid = String(metadata.consignmentId || '').replace(/[^\w.-]/g, '_')
          const box = String(metadata.boxNo || '').replace(/[^\w.-]/g, '_')
          const extMatch = String(file.name || '').match(/\.(webm|mp4|mov|avi)$/i)
          const ext = extMatch ? extMatch[0].toLowerCase() : '.webm'
          return `consignments/${safeCid}/boxes/box_${box}/video${ext}`
        })(),
        mimeType: file.type,
        consignmentId: metadata.consignmentId,
      }),
    })

    if (!storagePathReq.uploadUrl) {
      throw new Error('Failed to obtain upload authorization from server.')
    }

    const uploadUrl = storagePathReq.uploadUrl
    uploadPath = storagePathReq.storagePath

    let lastUploadError = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest()
          let settled = false
          const timer = setTimeout(() => {
            if (settled) return
            settled = true
            try { xhr.abort() } catch { /* ignore */ }
            reject(new Error(`R2 upload timed out after ${Math.round(timeoutMs / 1000)}s (${fileMb.toFixed(1)} MB)`))
          }, timeoutMs)

          xhr.open('PUT', uploadUrl, true)
          xhr.setRequestHeader('Content-Type', file.type)

          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              const percent = Math.round((e.loaded / e.total) * 100)
              postMessage({ type: 'ITEM_PROGRESS', payload: { id: entry.id, progress: percent } })
            }
          }

          xhr.onload = () => {
            clearTimeout(timer)
            if (settled) return
            settled = true
            if (xhr.status >= 200 && xhr.status < 300) resolve()
            else reject(new Error(`R2 upload failed with status ${xhr.status}`))
          }
          xhr.onerror = () => {
            clearTimeout(timer)
            if (settled) return
            settled = true
            reject(new Error('Network error during file upload.'))
          }
          xhr.send(file)
        })
        lastUploadError = null
        break
      } catch (err) {
        lastUploadError = err
        const retryable = /network|timeout|status 5\d\d/i.test(err.message || '')
        if (!retryable || attempt === 2) break
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
      }
    }
    if (lastUploadError) throw lastUploadError

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
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
      }
    }
  }
  throw lastMetaError
}

async function processVideoQueue(opts = {}) {
  if (running) {
    queuedProcessOpts = { ...(queuedProcessOpts || {}), ...opts, retryFailed: Boolean(opts.retryFailed || queuedProcessOpts?.retryFailed) }
    return
  }
  running = true
  await notify()

  try {
    do {
      const runOpts = queuedProcessOpts || opts
      queuedProcessOpts = null

      if (runOpts.retryFailed) {
        await resetFailedToPending()
      }

      if (runOpts.forceNow) {
        await unlockOutstandingForImmediateRetry()
      }

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
          const nextAttemptAt = Date.now() + backoffMs(video.retries)
          const isFailed = await incrementRetry(video.id, nextAttemptAt)

          postMessage({ type: 'ITEM_ERROR', payload: { id: video.id, error: e.message, isFailed } })
          postMessage({ type: 'CURRENT_UPLOAD', payload: null })
          await notify()

          if (!isFailed) {
            await new Promise((r) => setTimeout(r, Math.min(5000, backoffMs(video.retries))))
          }
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
        await resetFailedToPending()
      } catch (err) {
        console.warn('[Worker] Init recovery error:', err)
      }

      await notify()
      await processVideoQueue()

      if (!intervalId) {
        intervalId = setInterval(() => { void processVideoQueue() }, 12_000)
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
        await processVideoQueue()
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
        forceNow: payload?.forceNow,
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
