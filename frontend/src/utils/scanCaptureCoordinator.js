function contextKey({ consignmentId, boxNo }) {
  return `${String(consignmentId || '')}::${String(boxNo || '')}`
}

/**
 * Coordinates only post-capture application ordering and box-close barriers.
 * capture() is invoked synchronously for every registration, so this class can
 * never become a volatile pre-durability queue.
 */
export function createScanCaptureCoordinator() {
  const boxes = new Map()

  function getState(context) {
    const key = contextKey(context)
    if (!boxes.has(key)) {
      boxes.set(key, {
        closing: false,
        applyTail: Promise.resolve(),
        inFlight: new Set(),
        maximumInFlight: 0,
      })
    }
    return boxes.get(key)
  }

  function openBox(context) {
    getState(context).closing = false
  }

  function closeBox(context) {
    getState(context).closing = true
  }

  function isBoxOpen(context) {
    return !getState(context).closing
  }

  function registerScan({
    context,
    capture,
    afterDurable,
    onCaptureFailure,
    onPostDurabilityFailure,
  }) {
    const state = getState(context)
    if (state.closing) return { accepted: false, reason: 'box_closing' }

    // Critical: start IndexedDB capture now, before touching applyTail.
    let capturePromise
    try {
      capturePromise = Promise.resolve(capture())
    } catch (error) {
      capturePromise = Promise.reject(error)
    }

    const completion = state.applyTail.then(async () => {
      let durableScan
      try {
        durableScan = await capturePromise
      } catch (error) {
        return onCaptureFailure ? onCaptureFailure(error) : Promise.reject(error)
      }
      try {
        return await afterDurable(durableScan)
      } catch (error) {
        return onPostDurabilityFailure
          ? onPostDurabilityFailure(error, durableScan)
          : Promise.reject(error)
      }
    })

    state.applyTail = completion.catch(() => undefined)
    state.inFlight.add(completion)
    state.maximumInFlight = Math.max(state.maximumInFlight, state.inFlight.size)
    void completion.then(
      () => state.inFlight.delete(completion),
      () => state.inFlight.delete(completion)
    )

    return { accepted: true, capturePromise, completion }
  }

  async function flushAcceptedScansForBox(context) {
    const state = getState(context)
    state.closing = true
    await state.applyTail
    if (state.inFlight.size) await Promise.allSettled([...state.inFlight])
    return {
      localDurabilityFlushed: true,
      inFlight: state.inFlight.size,
      maximumInFlight: state.maximumInFlight,
    }
  }

  function getBoxState(context) {
    const state = getState(context)
    return {
      closing: state.closing,
      inFlight: state.inFlight.size,
      maximumInFlight: state.maximumInFlight,
    }
  }

  return {
    openBox,
    closeBox,
    isBoxOpen,
    registerScan,
    flushAcceptedScansForBox,
    getBoxState,
  }
}
