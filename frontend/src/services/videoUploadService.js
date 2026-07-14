/**
 * Global video upload service — runs app-wide (not tied to Packing Station mount).
 * Uses a Web Worker for blob merge + background upload so the packing UI stays responsive.
 */
import { finalizeRecordingSession } from '../utils/videoQueue'

let worker = null
const listeners = new Set()
let onlineHandler = null
let visibilityHandler = null
let authTokenHandler = null

const pendingFinalize = new Map()
const pendingDrain = new Map()

let state = {
  pending: 0,
  failed: 0,
  uploading: false,
  current: null,
}

function notify() {
  listeners.forEach((fn) => fn(state))
}

export function subscribeVideoUploadStatus(fn) {
  listeners.add(fn)
  fn(state)
  return () => listeners.delete(fn)
}

function settleFinalize(requestId, result) {
  const pending = pendingFinalize.get(requestId)
  if (!pending) return
  pendingFinalize.delete(requestId)
  if (result?.ok === false) pending.reject(new Error(result.error || 'Finalize failed'))
  else pending.resolve(result?.result || null)
}

function settleDrain(requestId, result) {
  const pending = pendingDrain.get(requestId)
  if (!pending) return
  pendingDrain.delete(requestId)
  pending.resolve(result || { done: true })
}

/** Kick the upload worker (or no-op) and optionally wait until the queue drain finishes. */
export async function processVideoUploadQueue(opts = {}) {
  const {
    retryFailed = false,
    wait = false,
    forceNow = false,
    timeoutMs = 5 * 60 * 1000,
  } = opts

  if (!worker) {
    return { done: true, skipped: true }
  }

  if (!wait) {
    worker.postMessage({ type: 'PROCESS_QUEUE', payload: { retryFailed, forceNow } })
    return { done: true }
  }

  const requestId = `drain_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      settleDrain(requestId, { done: false, timedOut: true })
    }, timeoutMs)
    pendingDrain.set(requestId, (result) => {
      clearTimeout(timer)
      resolve(result)
    })
    worker.postMessage({ type: 'PROCESS_QUEUE', payload: { retryFailed, forceNow: true, requestId } })
  })
}

/** Finalize a recording session into the IndexedDB upload queue (awaitable). */
export async function finalizeRecordingSessionInWorker(sessionId) {
  if (!sessionId) return null

  if (!worker) {
    return finalizeRecordingSession(sessionId)
  }

  const requestId = `fin_${sessionId}_${Date.now()}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingFinalize.has(requestId)) {
        pendingFinalize.delete(requestId)
        reject(new Error('Video finalize timed out'))
      }
    }, 120000)
    pendingFinalize.set(requestId, {
      resolve: (value) => { clearTimeout(timer); resolve(value) },
      reject: (err) => { clearTimeout(timer); reject(err) },
    })
    worker.postMessage({ type: 'FINALIZE_SESSION', payload: { sessionId, requestId } })
  })
}

export function initVideoUploadService() {
  if (worker) return

  worker = new Worker(new URL('../workers/videoUpload.worker.js', import.meta.url), { type: 'module' })

  const token = sessionStorage.getItem('token') || localStorage.getItem('token') || ''
  const apiUrl = (import.meta.env.VITE_API_URL || '') + '/api'

  worker.postMessage({ type: 'INIT', payload: { token, apiUrl } })

  worker.onmessage = (e) => {
    const { type, payload } = e.data
    switch (type) {
      case 'STATUS':
        state = { ...state, pending: payload.pending, failed: payload.failed, uploading: payload.uploading }
        notify()
        break
      case 'CURRENT_UPLOAD':
        state = { ...state, current: payload ? { ...payload, progress: state.current?.id === payload.id ? state.current.progress : 0 } : null }
        notify()
        break
      case 'ITEM_PROGRESS':
        if (state.current && state.current.id === payload.id) {
          state.current = { ...state.current, progress: payload.progress }
          notify()
        }
        window.dispatchEvent(new CustomEvent('video-upload-progress', { detail: payload }))
        break
      case 'ITEM_DONE':
        window.dispatchEvent(new CustomEvent('video-upload-done', { detail: payload }))
        break
      case 'ITEM_ERROR':
        window.dispatchEvent(new CustomEvent('video-upload-error', { detail: payload }))
        break
      case 'FINALIZE_DONE':
        settleFinalize(payload.requestId, payload)
        break
      case 'QUEUE_DRAINED':
        settleDrain(payload.requestId, { done: true, pending: payload.pending, failed: payload.failed })
        break
      default:
        break
    }
  }

  onlineHandler = () => processVideoUploadQueue({ wait: false, forceNow: true })
  visibilityHandler = () => {
    if (!document.hidden) processVideoUploadQueue({ wait: false, forceNow: true })
  }
  authTokenHandler = (e) => {
    if (worker) {
      worker.postMessage({ type: 'UPDATE_TOKEN', payload: { token: e.detail.token } })
    }
  }

  window.addEventListener('online', onlineHandler)
  document.addEventListener('visibilitychange', visibilityHandler)
  window.addEventListener('auth-token-changed', authTokenHandler)
}

export function stopVideoUploadService() {
  if (onlineHandler) {
    window.removeEventListener('online', onlineHandler)
    onlineHandler = null
  }
  if (visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler)
    visibilityHandler = null
  }
  if (authTokenHandler) {
    window.removeEventListener('auth-token-changed', authTokenHandler)
    authTokenHandler = null
  }
  if (worker) {
    worker.postMessage({ type: 'STOP' })
    worker.terminate()
    worker = null
  }
}

export function getVideoQueueSnapshot() {
  return state
}
