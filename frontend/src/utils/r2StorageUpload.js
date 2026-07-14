/**
 * Direct browser upload to Cloudflare R2 via backend-issued presigned PUT URL.
 * Includes progress callbacks, request timeout, and a single network retry.
 */
import api from '../services/api'
import { buildStoragePath } from './storagePaths'
import { uploadTimeoutForBytes } from './videoRecordingProfile'

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

function putWithProgress(uploadUrl, file, { onProgress, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    let settled = false

    const fail = (err) => {
      if (settled) return
      settled = true
      try { xhr.abort() } catch (_) { /* ignore */ }
      reject(err)
    }

    const timer = setTimeout(() => {
      fail(new Error(`R2 upload timed out after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)

    xhr.open('PUT', uploadUrl, true)
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')

    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100))
        }
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
      fail(new Error('Network error during file upload.'))
    }

    xhr.onabort = () => {
      clearTimeout(timer)
      fail(new Error('Upload aborted.'))
    }

    xhr.send(file)
  })
}

export async function uploadFileToStorageDirect(file, consignmentId, type = 'document', boxNo = '', onProgress, options = {}) {
  if (!file || !consignmentId) return null
  if ((type === 'video' || type === 'removal_video') && !boxNo) throw new Error('Box number is required for video uploads')

  const storagePath = buildStoragePath(consignmentId, type, file.name, boxNo, options)

  const response = await api.post('/uploads/generate-signed-url', {
    storagePath,
    mimeType: file.type || 'application/octet-stream',
    consignmentId,
  })

  const { uploadUrl } = response.data
  if (!uploadUrl) {
    throw new Error('Failed to obtain upload authorization from server.')
  }

  let lastError = null
  const timeoutMs = uploadTimeoutForBytes(file.size)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await putWithProgress(uploadUrl, file, { onProgress, timeoutMs })
      lastError = null
      break
    } catch (err) {
      lastError = err
      const retryable = /network|timeout|aborted|status 5\d\d/i.test(err.message || '')
      if (!retryable || attempt === 2) break
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
    }
  }
  if (lastError) throw lastError

  return {
    url: `/api/uploads/stream/temp?path=${encodeURIComponent(storagePath)}`,
    path: storagePath,
    name: file.name,
    size: file.size,
    type: file.type,
    boxNo: boxNo ? String(boxNo) : '',
  }
}
