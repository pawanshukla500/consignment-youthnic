/**
 * Awaitable video-upload queue drain waiters.
 * Each request stores { resolve, reject, timer, createdAt } and settles once.
 */

export function createDrainResult({
  ok = true,
  requestId = null,
  uploadedIds = [],
  failedIds = [],
  pendingIds = [],
  missingIds = [],
  timedOut = false,
  error = null,
  pending = 0,
  failed = 0,
} = {}) {
  return {
    ok: Boolean(ok),
    requestId,
    uploadedIds: [...uploadedIds],
    failedIds: [...failedIds],
    pendingIds: [...pendingIds],
    missingIds: [...missingIds],
    timedOut: Boolean(timedOut),
    error: error || null,
    pending: Number(pending) || pendingIds.length,
    failed: Number(failed) || failedIds.length,
    done: Boolean(ok) && !timedOut && failedIds.length === 0 && pendingIds.length === 0,
  }
}

export function isTerminalSuccess(result) {
  if (!result || result.ok === false || result.timedOut) return false
  if ((result.failedIds || []).length > 0) return false
  if ((result.pendingIds || []).length > 0) return false
  if ((result.missingIds || []).length > 0) return false
  return true
}

export function createDrainWaiterRegistry() {
  const pendingDrain = new Map()

  function settle(requestId, result, { forceReject = false } = {}) {
    const entry = pendingDrain.get(requestId)
    if (!entry || entry.settled) return false

    entry.settled = true
    pendingDrain.delete(requestId)
    if (entry.timer) clearTimeout(entry.timer)

    const normalized = createDrainResult({
      ...result,
      requestId: result?.requestId ?? requestId,
    })
    const shouldReject = forceReject || !isTerminalSuccess(normalized)

    if (shouldReject) {
      const err = new Error(
        normalized.error?.message
          || (normalized.timedOut ? 'Video upload queue drain timed out' : 'Video upload queue drain failed')
      )
      err.code = normalized.error?.code || (normalized.timedOut ? 'DRAIN_TIMEOUT' : 'DRAIN_FAILED')
      err.retryable = Boolean(normalized.error?.retryable ?? normalized.timedOut)
      err.result = normalized
      entry.reject(err)
    } else {
      entry.resolve(normalized)
    }
    return true
  }

  function register({ resolve, reject, timeoutMs = 5 * 60 * 1000, requestId } = {}) {
    const id = requestId || `drain_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    if (pendingDrain.has(id)) {
      throw new Error(`Drain waiter already registered for ${id}`)
    }

    const timer = setTimeout(() => {
      settle(id, createDrainResult({
        ok: false,
        requestId: id,
        timedOut: true,
        error: {
          code: 'DRAIN_TIMEOUT',
          message: 'Video upload queue drain timed out',
          retryable: true,
        },
      }), { forceReject: true })
    }, timeoutMs)

    pendingDrain.set(id, {
      resolve,
      reject,
      timer,
      createdAt: Date.now(),
      settled: false,
    })
    return id
  }

  function rejectAll(error) {
    const message = error?.message || 'Video upload worker terminated unexpectedly'
    const ids = [...pendingDrain.keys()]
    for (const id of ids) {
      settle(id, createDrainResult({
        ok: false,
        requestId: id,
        error: {
          code: error?.code || 'WORKER_TERMINATED',
          message,
          retryable: true,
        },
      }), { forceReject: true })
    }
    return ids.length
  }

  function size() {
    return pendingDrain.size
  }

  function has(requestId) {
    return pendingDrain.has(requestId)
  }

  return {
    register,
    settle,
    rejectAll,
    size,
    has,
    /** @internal test helper */
    _map: pendingDrain,
  }
}
