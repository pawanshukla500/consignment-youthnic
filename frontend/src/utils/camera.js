import { CAMERA_CONSTRAINT_PROFILES } from './videoRecordingProfile'

export { CAMERA_CONSTRAINT_PROFILES }

export function isCameraSupported() {
  return typeof navigator !== 'undefined'
    && navigator.mediaDevices
    && typeof navigator.mediaDevices.getUserMedia === 'function'
}

export function describeCameraError(err) {
  const name = err?.name || ''
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'Camera permission denied. Allow camera access in your browser site settings and reload.'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No camera found. Connect a webcam and try again.'
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'Camera is busy. Close other apps using the webcam and try again.'
  }
  if (name === 'OverconstrainedError') {
    return 'Camera settings not supported. Retrying with a compatible profile…'
  }
  if (name === 'SecurityError') {
    return 'Camera requires HTTPS. Open the app over a secure connection.'
  }
  return err?.message || 'Could not start camera'
}

export function stopMediaStream(stream) {
  if (!stream) return
  stream.getTracks().forEach((track) => {
    try { track.stop() } catch { /* ignore */ }
  })
}

/** Prefer compact 720p@24 for packing evidence uploads. */
async function preferPackingProfile(stream) {
  const track = stream?.getVideoTracks?.()[0]
  if (!track?.applyConstraints) return
  try {
    await track.applyConstraints({
      width: { ideal: 1280, max: 1280 },
      height: { ideal: 720, max: 720 },
      frameRate: { ideal: 24, max: 24 },
    })
  } catch {
    try {
      await track.applyConstraints({
        width: { ideal: 1280, max: 1280 },
        height: { ideal: 720, max: 720 },
        frameRate: { ideal: 30, max: 30 },
      })
    } catch {
      // Keep whatever the camera negotiated.
    }
  }
}

export async function requestCameraStream(existingStream = null) {
  if (!isCameraSupported()) {
    throw new Error('Camera is not supported in this browser.')
  }

  stopMediaStream(existingStream)

  let lastError = null
  for (const profile of CAMERA_CONSTRAINT_PROFILES) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: profile.video,
        audio: false,
      })
      await preferPackingProfile(stream)
      return { stream, profile: profile.label }
    } catch (err) {
      lastError = err
      if (['NotAllowedError', 'PermissionDeniedError', 'NotFoundError', 'DevicesNotFoundError', 'NotReadableError', 'TrackStartError', 'SecurityError'].includes(err?.name)) {
        break
      }
    }
  }

  throw lastError || new Error('Could not start camera')
}

export async function attachStreamToVideo(videoEl, stream) {
  if (!videoEl || !stream) {
    throw new Error('Video preview is not ready yet.')
  }

  videoEl.srcObject = stream
  videoEl.muted = true
  videoEl.playsInline = true
  videoEl.autoplay = true

  await new Promise((resolve, reject) => {
    const cleanup = () => {
      videoEl.removeEventListener('loadedmetadata', onReady)
      videoEl.removeEventListener('error', onError)
    }
    const onReady = () => { cleanup(); resolve() }
    const onError = () => { cleanup(); reject(new Error('Video preview failed to load.')) }
    if (videoEl.readyState >= 1) {
      resolve()
      return
    }
    videoEl.addEventListener('loadedmetadata', onReady, { once: true })
    videoEl.addEventListener('error', onError, { once: true })
  })

  try {
    await videoEl.play()
  } catch (err) {
    if (err?.name !== 'AbortError') throw err
  }

  return videoEl
}

export async function startCameraPreview({ videoEl, existingStream = null }) {
  const { stream, profile } = await requestCameraStream(existingStream)
  if (videoEl) {
    await attachStreamToVideo(videoEl, stream)
  }
  const track = stream.getVideoTracks()[0]
  const settings = track?.getSettings?.() || {}
  return {
    stream,
    profile,
    width: settings.width || videoEl?.videoWidth || 0,
    height: settings.height || videoEl?.videoHeight || 0,
    frameRate: settings.frameRate || 24,
  }
}
