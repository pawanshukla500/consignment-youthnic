/**
 * Global video upload service — runs app-wide (not tied to Packing Station mount).
 * Uses a Web Worker for blob merge + background upload so the packing UI stays responsive.
 * Operators can pack the next box while prior videos upload/verify in the background.
 */
import { finalizeRecordingSession } from '../utils/videoQueue'
import { VIDEO_UPLOAD_CONFIG } from '../utils/videoUploadConfig'
import {
  createDrainResult,
  createDrainWaiterRegistry,
  isTerminalSuccess,
} from './videoDrainWaiter'

let worker = null
const listeners = new Set()
let onlineHandler = null
let visibilityHandler = null
let authTokenHandler = null

const pendingFinalize = new Map()
const drainWaiters = createDrainWaiterRegistry()

let state = {
  pending: 0,
  failed: 0,
  uploading: false,
  current: null,
  /** Per-queue-item statuses for packing UI: [{ id, boxNo, status, progress, ... }] */
  items: [],
  activeCount: 0,
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
  if (!pending || pending.settled) return
  pending.settled = true
  pendingFinalize.delete(requestId)
  if (pending.timer) clearTimeout(pending.timer)
  if (result?.ok === false) {
    const err = new Error(result.error?.message || result.error || 'Finalize failed')
    err.code = result.error?.code || 'FINALIZE_FAILED'
    err.retryable = Boolean(result.error?.retryable)
    pending.reject(err)
  } else {
    pending.resolve(result?.result || null)
  }
}

function settleDrain(requestId, result) {
  return drainWaiters.settle(requestId, result)
}

/** Kick the upload worker (or no-op) and optionally wait until the queue drain finishes. */
export async function processVideoUploadQueue(opts = {}) {
  const {
    retryFailed = false,
    wait = false,
    forceNow = false,
    /** Bypass nextAttemptAt once — only for user Retry, online, finish, or recovery. */
    immediateRetry = false,
    timeoutMs = VIDEO_UPLOAD_CONFIG.drainSliceTimeoutMs,
  } = opts

  if (!worker) {
    return createDrainResult({
      ok: true,
      uploadedIds: [],
      failedIds: [],
      pendingIds: [],
      missingIds: [],
    })
  }

  if (!wait) {
    worker.postMessage({
      type: 'PROCESS_QUEUE',
      payload: { retryFailed, forceNow, immediateRetry },
    })
    return createDrainResult({ ok: true, done: true })
  }

  return new Promise((resolve, reject) => {
    const requestId = drainWaiters.register({ resolve, reject, timeoutMs })
    worker.postMessage({
      type: 'PROCESS_QUEUE',
      payload: {
        retryFailed,
        forceNow: true,
        immediateRetry: Boolean(immediateRetry || retryFailed),
        requestId,
      },
    })
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
      settleFinalize(requestId, {
        ok: false,
        error: { code: 'FINALIZE_TIMEOUT', message: 'Video finalize timed out', retryable: true },
      })
    }, 120000)
    pendingFinalize.set(requestId, {
      resolve,
      reject,
      timer,
      createdAt: Date.now(),
      settled: false,
    })
    worker.postMessage({ type: 'FINALIZE_SESSION', payload: { sessionId, requestId } })
  })
}

function upsertItem(detail) {
  if (!detail?.id) return state.items
  const next = [...(state.items || [])]
  const idx = next.findIndex((item) => item.id === detail.id)
  const row = {
    ...(idx >= 0 ? next[idx] : {}),
    ...detail,
  }
  if (idx >= 0) next[idx] = row
  else next.push(row)
  // Drop completed items from the live strip after a short retention window on next STATUS
  return next.filter((item) => item.status !== 'completed')
}

function handleWorkerMessage(e) {
  const { type, payload } = e.data || {}
  switch (type) {
    case 'STATUS':
      state = {
        ...state,
        pending: payload.pending,
        failed: payload.failed,
        uploading: payload.uploading,
        activeCount: payload.activeCount || 0,
        items: Array.isArray(payload.items) ? payload.items : state.items,
      }
      notify()
      break
    case 'CURRENT_UPLOAD':
      state = {
        ...state,
        current: payload
          ? {
              ...payload,
              progress: state.current?.id === payload.id ? state.current.progress : (payload.progress || 0),
            }
          : null,
      }
      notify()
      break
    case 'ITEM_STATUS':
      state = { ...state, items: upsertItem(payload) }
      notify()
      window.dispatchEvent(new CustomEvent('video-upload-status', { detail: payload }))
      break
    case 'ITEM_PROGRESS':
      if (state.current && state.current.id === payload.id) {
        state.current = {
          ...state.current,
          progress: payload.progress,
          status: payload.status || state.current.status,
        }
      }
      state = {
        ...state,
        items: upsertItem({
          id: payload.id,
          progress: payload.progress,
          status: payload.status || 'uploading',
        }),
      }
      notify()
      window.dispatchEvent(new CustomEvent('video-upload-progress', { detail: payload }))
      break
    case 'ITEM_DONE':
      state = {
        ...state,
        items: upsertItem({
          id: payload.id,
          boxNo: payload.metadata?.boxNo,
          status: 'completed',
          progress: 100,
        }),
      }
      notify()
      window.dispatchEvent(new CustomEvent('video-upload-done', { detail: payload }))
      break
    case 'ITEM_ERROR':
      state = {
        ...state,
        items: upsertItem({
          id: payload.id,
          boxNo: payload.boxNo,
          status: payload.status || (payload.isFailed ? 'failed' : 'retrying'),
          lastError: payload.error,
        }),
      }
      notify()
      window.dispatchEvent(new CustomEvent('video-upload-error', { detail: payload }))
      break
    case 'FINALIZE_DONE':
      settleFinalize(payload.requestId, payload)
      break
    case 'QUEUE_DRAINED':
      settleDrain(payload.requestId, createDrainResult({
        ok: payload.ok !== false
          && !(payload.failedIds || []).length
          && !(payload.pendingIds || []).length,
        requestId: payload.requestId,
        uploadedIds: payload.uploadedIds || [],
        failedIds: payload.failedIds || [],
        pendingIds: payload.pendingIds || [],
        missingIds: payload.missingIds || [],
        pending: payload.pending,
        failed: payload.failed,
        error: payload.error || null,
      }))
      break
    default:
      break
  }
}

export function initVideoUploadService() {
  if (worker) return

  worker = new Worker(new URL('../workers/videoUpload.worker.js', import.meta.url), { type: 'module' })

  const token = sessionStorage.getItem('token') || localStorage.getItem('token') || ''
  const apiUrl = (import.meta.env.VITE_API_URL || '') + '/api'

  worker.postMessage({ type: 'INIT', payload: { token, apiUrl } })

  worker.onmessage = handleWorkerMessage
  worker.onerror = (err) => {
    console.error('[VideoUpload] Worker error:', err)
    drainWaiters.rejectAll({
      code: 'WORKER_EXCEPTION',
      message: err?.message || 'Video upload worker exception',
    })
  }
  worker.onmessageerror = () => {
    drainWaiters.rejectAll({
      code: 'WORKER_MESSAGE_ERROR',
      message: 'Video upload worker message error',
    })
  }

  onlineHandler = () => processVideoUploadQueue({
    wait: false,
    forceNow: true,
    immediateRetry: true,
  })
  visibilityHandler = () => {
    // Visibility alone is not an immediate-retry event — respect backoff
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
    try {
      worker.postMessage({ type: 'STOP' })
    } catch { /* ignore */ }
    drainWaiters.rejectAll({
      code: 'WORKER_TERMINATED',
      message: 'Video upload worker terminated',
    })
    for (const [requestId, pending] of pendingFinalize.entries()) {
      settleFinalize(requestId, {
        ok: false,
        error: { code: 'WORKER_TERMINATED', message: 'Video upload worker terminated', retryable: true },
      })
      void pending
    }
    worker.terminate()
    worker = null
  }
}

export function getVideoQueueSnapshot() {
  return state
}

export { createDrainResult, isTerminalSuccess, drainWaiters as __drainWaitersForTests }
