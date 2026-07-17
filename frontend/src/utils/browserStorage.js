/**
 * Browser storage helpers for packing video durability.
 */

export async function requestPersistentStorage() {
  try {
    if (!navigator?.storage?.persist) {
      return { supported: false, persisted: false }
    }
    const already = await navigator.storage.persisted?.()
    if (already) return { supported: true, persisted: true }
    const persisted = await navigator.storage.persist()
    return { supported: true, persisted: Boolean(persisted) }
  } catch (error) {
    return { supported: true, persisted: false, error: error?.message || String(error) }
  }
}

export async function estimateBrowserStorage() {
  try {
    if (!navigator?.storage?.estimate) {
      return { supported: false }
    }
    const estimate = await navigator.storage.estimate()
    const usage = Number(estimate.usage) || 0
    const quota = Number(estimate.quota) || 0
    const free = Math.max(0, quota - usage)
    return {
      supported: true,
      usage,
      quota,
      free,
      usageMb: usage / (1024 * 1024),
      quotaMb: quota / (1024 * 1024),
      freeMb: free / (1024 * 1024),
    }
  } catch (error) {
    return { supported: true, error: error?.message || String(error) }
  }
}

/** Warn when free space is below this many MB before a long recording. */
export const MIN_RECOMMENDED_FREE_MB = 200

export function isStorageInsufficient(estimate, minFreeMb = MIN_RECOMMENDED_FREE_MB) {
  if (!estimate?.supported || estimate.freeMb == null) return false
  return estimate.freeMb < minFreeMb
}

export function formatStorageMessage(estimate) {
  if (!estimate?.supported) return 'Browser storage estimate unavailable.'
  if (estimate.error) return `Storage estimate failed: ${estimate.error}`
  return `Browser storage: ~${estimate.freeMb.toFixed(0)} MB free of ~${estimate.quotaMb.toFixed(0)} MB.`
}
