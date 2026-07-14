/**
 * Durable packing sync jobs for actions that must not be silently lost.
 * Save-box jobs are replayed after pending scans and before video metadata.
 */
const DB_NAME = 'PackingSyncDB'
const DB_VERSION = 1
const STORE = 'packingSyncJobs'
const MAX_RETRIES = 20

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve(req.result)
    req.onupgradeneeded = (e) => {
      const db = e.target.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex('status', 'status', { unique: false })
        store.createIndex('createdAt', 'createdAt', { unique: false })
      }
    }
  })
}

function backoffMs(retries) {
  return Math.min(8000, 400 * Math.pow(1.6, retries))
}

async function getAllJobs() {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).getAll()
    req.onsuccess = () => resolve(req.result || [])
    req.onerror = () => reject(req.error)
  })
}

async function putJob(job) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const req = tx.objectStore(STORE).put(job)
    req.onsuccess = () => resolve(job)
    req.onerror = () => reject(req.error)
  })
}

async function deleteJob(id) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const req = tx.objectStore(STORE).delete(id)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

export async function enqueueSaveBoxJob({ consignmentId, boxNo, weight, weightUnit, weightImageId, weightImageBlob, items }) {
  const id = `save_box_${consignmentId}_${boxNo}`
  const existing = (await getAllJobs()).find((job) => job.id === id)
  const job = {
    ...(existing || {}),
    id,
    type: 'save_box',
    consignmentId,
    boxNo: String(boxNo),
    weight: weight ? Number(weight) : (existing?.weight ?? null),
    weightUnit: weightUnit || existing?.weightUnit || 'KG',
    weightImageId: weightImageId || existing?.weightImageId || null,
    weightImageBlob: weightImageBlob || existing?.weightImageBlob || null,
    items: Array.isArray(items) && items.length ? items : (existing?.items || []),
    status: 'pending',
    retries: existing?.retries || 0,
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
  }
  return putJob(job)
}

export async function getPendingSyncJobs() {
  const jobs = await getAllJobs()
  return jobs
    .filter((job) => job.status === 'pending')
    .sort((a, b) => a.createdAt - b.createdAt)
}

export async function getPendingSyncJobCount() {
  return (await getPendingSyncJobs()).length
}

export async function getFailedSyncJobCount() {
  const jobs = await getAllJobs()
  return jobs.filter((job) => job.status === 'failed').length
}

/** Reset failed save-box jobs back to pending for another attempt. */
export async function resetFailedSyncJobs() {
  const jobs = await getAllJobs()
  const failed = jobs.filter((job) => job.status === 'failed')
  for (const job of failed) {
    await putJob({
      ...job,
      status: 'pending',
      retries: 0,
      updatedAt: Date.now(),
    })
  }
  return failed.length
}

/** Permanently discard failed save-box jobs from this browser. */
export async function clearFailedSyncJobs() {
  const jobs = await getAllJobs()
  const failed = jobs.filter((job) => job.status === 'failed')
  await Promise.all(failed.map((job) => deleteJob(job.id)))
  return failed.length
}

/** Clear every local packing sync job (pending + failed). */
export async function clearAllSyncJobs() {
  const jobs = await getAllJobs()
  await Promise.all(jobs.map((job) => deleteJob(job.id)))
  return jobs.length
}

let draining = false
let drainAgain = false

export async function drainPackingSyncQueue(sendJob, onResult) {
  if (draining) {
    drainAgain = true
    return { skipped: true }
  }
  draining = true
  try {
    do {
      drainAgain = false
      const pending = await getPendingSyncJobs()
      for (const job of pending) {
        try {
          const result = await sendJob(job)
          await deleteJob(job.id)
          onResult?.(job, result, null)
        } catch (err) {
          if (err?.code === 'PENDING_SCANS') {
            drainAgain = true
            break
          }
          const next = {
            ...job,
            retries: (job.retries || 0) + 1,
            updatedAt: Date.now(),
          }
          if (next.retries >= MAX_RETRIES) {
            next.status = 'failed'
            await putJob(next)
            onResult?.(job, null, err)
          } else {
            next.status = 'pending'
            await putJob(next)
            await new Promise((resolve) => setTimeout(resolve, backoffMs(next.retries)))
          }
        }
      }
    } while (drainAgain)
  } finally {
    draining = false
  }
  return { done: true }
}
