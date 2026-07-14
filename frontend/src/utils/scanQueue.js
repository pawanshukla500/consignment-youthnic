/**
 * Durable scan queue — serializes barcode scans with retry and idempotency.
 * Survives network failures; never drops a scan silently.
 */
const DB_NAME = 'PackingScanDB'
const DB_VERSION = 1
const STORE = 'scanQueue'
const MAX_RETRIES = 20

let dbPromise = null
let draining = false
let drainAgain = false
let activeDrain = null

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onerror = () => {
        dbPromise = null
        reject(req.error)
      }
      req.onsuccess = () => resolve(req.result)
      req.onupgradeneeded = (e) => {
        const db = e.target.result
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE, { keyPath: 'id' })
          s.createIndex('status', 'status', { unique: false })
        }
      }
    })
  }
  return dbPromise
}

/** Open IndexedDB early so the first scan in Zone 3 does not pay open latency. */
export function warmScanQueueDb() {
  return openDB().catch(() => null)
}

function newScanId() {
  return crypto.randomUUID?.() || `scan_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

export async function enqueueScan({ barcode, consignmentId, boxNo, qty = 1 }) {
  const db = await openDB()
  const entry = {
    id: newScanId(),
    barcode,
    consignmentId,
    boxNo,
    qty,
    status: 'pending',
    retries: 0,
    createdAt: Date.now(),
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const req = tx.objectStore(STORE).add(entry)
    req.onsuccess = () => resolve(entry)
    req.onerror = () => reject(req.error)
  })
}

export async function getPendingScans() {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const idx = tx.objectStore(STORE).index('status')
    const req = idx.getAll(IDBKeyRange.only('pending'))
    req.onsuccess = () => resolve((req.result || []).sort((a, b) => a.createdAt - b.createdAt))
    req.onerror = () => reject(req.error)
  })
}

async function updateScan(entry) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const req = tx.objectStore(STORE).put(entry)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

async function deleteScan(id) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const req = tx.objectStore(STORE).delete(id)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

function backoffMs(retries) {
  return Math.min(8000, 400 * Math.pow(1.6, retries))
}

async function processOneScan(scan, sendScan, onResult) {
  try {
    const result = await sendScan(scan)
    if (result?.not_found || result?.over_limit || result?.locked || result?.error) {
      await deleteScan(scan.id)
      onResult?.(scan, result, null)
      return
    }
    if (result?.retry) {
      scan.retries += 1
      if (scan.retries >= MAX_RETRIES) {
        scan.status = 'failed'
        await updateScan(scan)
        onResult?.(scan, null, new Error(result.error || 'Scan persist failed'))
      } else {
        scan.status = 'pending'
        await updateScan(scan)
        await new Promise((r) => setTimeout(r, backoffMs(scan.retries)))
      }
      return
    }
    await deleteScan(scan.id)
    onResult?.(scan, result, null)
  } catch (err) {
    scan.retries += 1
    if (scan.retries >= MAX_RETRIES) {
      scan.status = 'failed'
      await updateScan(scan)
      onResult?.(scan, null, err)
    } else {
      scan.status = 'pending'
      await updateScan(scan)
      await new Promise((r) => setTimeout(r, backoffMs(scan.retries)))
    }
  }
}

/**
 * Process pending scans one at a time (serialized).
 * Re-drains until the queue is empty so rapid scans are never skipped.
 */
export async function drainScanQueue(sendScan, onResult) {
  if (draining) {
    drainAgain = true
    return activeDrain
  }

  draining = true
  activeDrain = (async () => {
    try {
      do {
        drainAgain = false
        let pending = await getPendingScans()
        while (pending.length > 0) {
          for (const scan of pending) {
            await processOneScan(scan, sendScan, onResult)
          }
          pending = await getPendingScans()
        }
      } while (drainAgain)
    } finally {
      draining = false
      activeDrain = null
    }
    return { done: true }
  })()

  return activeDrain
}

/** Fire-and-forget drain — safe to call on every scan. */
export function kickScanDrain(sendScan, onResult) {
  void drainScanQueue(sendScan, onResult)
}

export async function getPendingScanCountForConsignment(consignmentId) {
  if (!consignmentId) return 0
  const pending = await getPendingScans()
  return pending.filter((scan) => scan.consignmentId === consignmentId).length
}

export async function getPendingScanCount() {
  const pending = await getPendingScans()
  return pending.length
}

export async function getFailedScanCount() {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const store = tx.objectStore(STORE)
    if (store.indexNames.contains('status')) {
      const idx = store.index('status')
      const req = idx.count(IDBKeyRange.only('failed'))
      req.onsuccess = () => resolve(req.result || 0)
      req.onerror = () => reject(req.error)
    } else {
      const req = store.getAll()
      req.onsuccess = () => resolve((req.result || []).filter((s) => s.status === 'failed').length)
      req.onerror = () => reject(req.error)
    }
  })
}

export async function resetFailedScans() {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const req = store.getAll()
    req.onsuccess = async () => {
      const failed = (req.result || []).filter((s) => s.status === 'failed')
      for (const s of failed) {
        s.status = 'pending'
        s.retries = 0
        store.put(s)
      }
      resolve(failed.length)
    }
    req.onerror = () => reject(req.error)
  })
}
