/**
 * Direct browser upload to Cloudflare R2 via backend-issued presigned PUT URL.
 * Falls back to same-origin /api/uploads/proxy-object when R2 CORS blocks the PUT.
 */
import api from '../services/api'
import { buildStoragePath } from './storagePaths'
import { uploadTimeoutForBytes } from './videoRecordingProfile'

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

function putWithProgress(uploadUrl, file, {
  onProgress,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  headers = {},
  expectJson = false,
} = {}) {
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
    const contentType = headers['Content-Type'] || file.type || 'application/octet-stream'
    xhr.setRequestHeader('Content-Type', contentType)
    if (headers.Authorization) xhr.setRequestHeader('Authorization', headers.Authorization)

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
      if (xhr.status >= 200 && xhr.status < 300) {
        if (expectJson) {
          try { resolve(JSON.parse(xhr.responseText || '{}')) } catch { resolve({}) }
        } else resolve()
      } else reject(new Error(`R2 upload failed with status ${xhr.status}`))
    }

    xhr.onerror = () => {
      clearTimeout(timer)
      fail(new Error('Network error during file upload. Check R2 CORS allows this site origin for PUT.'))
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
  const timeoutMs = uploadTimeoutForBytes(file.size)

  try {
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
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await putWithProgress(uploadUrl, file, { onProgress, timeoutMs })
        lastError = null
        break
      } catch (err) {
        lastError = err
        const retryable = /network|timeout|aborted|status 5\d\d|cors/i.test(err.message || '')
        if (!retryable || attempt === 1) break
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)))
      }
    }
    if (lastError) throw lastError
  } catch (err) {
    // Same-origin proxy avoids R2 CORS entirely (auth via API JWT).
    console.warn('[R2] Direct PUT failed, using API proxy:', err.message)
    const token = sessionStorage.getItem('token') || localStorage.getItem('token') || ''
    const apiBase = (import.meta.env.VITE_API_URL || '') + '/api'
    const qs = new URLSearchParams({
      storagePath,
      consignmentId: String(consignmentId),
      mimeType: file.type || 'application/octet-stream',
      boxNo: boxNo ? String(boxNo) : '',
    })
    await putWithProgress(`${apiBase}/uploads/proxy-object?${qs.toString()}`, file, {
      onProgress,
      timeoutMs,
      expectJson: true,
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    })
  }

  return {
    url: `/api/uploads/stream/temp?path=${encodeURIComponent(storagePath)}`,
    path: storagePath,
    name: file.name,
    size: file.size,
    type: file.type,
    boxNo: boxNo ? String(boxNo) : '',
  }
}
