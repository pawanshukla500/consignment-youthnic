/** Read app JWT used for authenticated media streams. */
export function getAppAuthToken() {
  return sessionStorage.getItem('token') || localStorage.getItem('token')
}

/** Build an authenticated same-origin stream URL for <video src> (token in query — browsers cannot set Authorization on video). */
export function buildUploadStreamUrl(fileId, type = 'video', cacheBust = null) {
  if (!fileId) return null
  const token = getAppAuthToken()
  if (!token) return null
  const base = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
  const params = new URLSearchParams({ type, token })
  if (cacheBust != null && cacheBust !== '') {
    params.set('v', String(cacheBust))
  }
  return `${base}/api/uploads/stream/${encodeURIComponent(fileId)}?${params.toString()}`
}

/** Verify the stream endpoint is reachable before binding it to a video element. */
export async function verifyUploadStream(fileId, type = 'video') {
  const streamUrl = buildUploadStreamUrl(fileId, type)
  if (!streamUrl) {
    return { ok: false, streamUrl: null, error: 'Not signed in' }
  }

  const token = getAppAuthToken()
  try {
    const response = await fetch(streamUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Range: 'bytes=0-1',
      },
    })

    if (response.status === 206 || response.status === 200) {
      return { ok: true, streamUrl, error: null }
    }

    let message = `Stream unavailable (${response.status})`
    try {
      const payload = await response.json()
      if (payload?.error) message = payload.error
    } catch {
      // ignore non-json bodies
    }
    return { ok: false, streamUrl, error: message }
  } catch (err) {
    return { ok: false, streamUrl, error: err.message || 'Network error' }
  }
}

/** Fetch stream with Authorization header (for download / fallback checks). */
export async function fetchAuthenticatedStream(fileId, type = 'video') {
  const streamUrl = buildUploadStreamUrl(fileId, type)
  if (!streamUrl) throw new Error('Not signed in')
  const token = getAppAuthToken()
  const response = await fetch(streamUrl, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!response.ok) {
    let message = `Download failed (${response.status})`
    try {
      const payload = await response.json()
      if (payload?.error) message = payload.error
    } catch {
      // ignore
    }
    throw new Error(message)
  }
  return response
}
