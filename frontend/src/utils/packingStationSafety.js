/** Recorder stop must not hang the packing UI forever. */
export const STOP_RECORDING_TIMEOUT_MS = 15000

/**
 * Settle a promise within `ms` or reject with a packing-safe timeout error.
 * Late resolution is ignored so a hung MediaRecorder.onstop cannot unstick twice.
 */
export function withTimeout(promise, ms, message) {
  const timeoutMs = Number(ms) || 0
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      const err = new Error(message || 'Timed out')
      err.code = 'TIMEOUT'
      reject(err)
    }, timeoutMs)

    Promise.resolve(promise).then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

export function boxCloseAlreadyInProgressMessage() {
  return 'This box is already saving. Wait a moment, then tap SAVE BOX or NEXT BOX again.'
}

export function boxSaveCancelledMessage() {
  return 'Box not saved. You can scan more items, then tap SAVE BOX or NEXT BOX.'
}
