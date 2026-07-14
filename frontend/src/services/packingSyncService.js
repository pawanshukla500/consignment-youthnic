/**
 * Global packing sync — drains scan + save-box queues outside Packing Station.
 * Ensures queued work completes after navigation, refresh, or brief disconnects.
 */
import {
  drainScanQueue,
  getPendingScanCount,
  getFailedScanCount,
  resetFailedScans,
} from '../utils/scanQueue'
import {
  drainPackingSyncQueue,
  getPendingSyncJobCount,
  getFailedSyncJobCount,
  resetFailedSyncJobs,
} from '../utils/packingSyncQueue'
import { processVideoUploadQueue } from './videoUploadService'
import { packingAPI } from './api'
import { processSaveBoxJob, isMissingPackingSession, ensurePackingSession } from '../utils/saveBoxSyncHelper'

let intervalId = null
let running = false
const listeners = new Set()

let pendingScans = 0
let pendingJobs = 0
let failedScans = 0
let failedJobs = 0

function notify() {
  const payload = {
    pendingScans,
    pendingJobs,
    failedScans,
    failedJobs,
    running,
  }
  listeners.forEach((fn) => fn(payload))
}

export function subscribePackingSyncStatus(fn) {
  listeners.add(fn)
  fn({ pendingScans, pendingJobs, failedScans, failedJobs, running })
  return () => listeners.delete(fn)
}

async function refreshCounts() {
  ;[pendingScans, pendingJobs, failedScans, failedJobs] = await Promise.all([
    getPendingScanCount(),
    getPendingSyncJobCount(),
    getFailedScanCount(),
    getFailedSyncJobCount(),
  ])
  notify()
}

async function sendQueuedScan(scan) {
  try {
    const response = await packingAPI.increment({
      consignment_id: scan.consignmentId,
      barcode: scan.barcode,
      box_no: scan.boxNo,
      qty: scan.qty,
      scan_id: scan.id,
    })
    return response.data
  } catch (error) {
    if (!isMissingPackingSession(error)) throw error
    await ensurePackingSession(scan.consignmentId)
    const retry = await packingAPI.increment({
      consignment_id: scan.consignmentId,
      barcode: scan.barcode,
      box_no: scan.boxNo,
      qty: scan.qty,
      scan_id: scan.id,
    })
    return retry.data
  }
}

export async function processPackingSyncQueues() {
  if (running) return { skipped: true }
  running = true
  notify()

  try {
    await drainScanQueue(sendQueuedScan, (scan, _result, err) => {
      if (err) console.warn('[PackingSync] Scan retry:', scan.barcode, err?.message)
    })
    await drainPackingSyncQueue(processSaveBoxJob, (job, _result, err) => {
      if (err) console.warn('[PackingSync] Save-box retry:', job.boxNo, err?.message)
    })
    await processVideoUploadQueue()
  } finally {
    running = false
    await refreshCounts()
  }

  return { done: true }
}

export async function initPackingSyncService() {
  if (intervalId) return

  try {
    const { pruneDuplicateBoxVideos } = await import('../utils/videoQueue')
    const pruned = await pruneDuplicateBoxVideos().catch(() => 0)
    if (pruned > 0) console.log(`[PackingSync] Pruned ${pruned} duplicate local video(s)`)
    const [scans, jobs] = await Promise.all([resetFailedScans(), resetFailedSyncJobs()])
    if (scans + jobs > 0) {
      console.log(`[PackingSync] Reset ${scans} failed scan(s), ${jobs} failed save-box job(s)`)
    }
  } catch (e) {
    console.warn('[PackingSync] Init recovery error:', e)
  }

  await refreshCounts()
  processPackingSyncQueues()

  intervalId = setInterval(() => processPackingSyncQueues(), 8_000)
  window.addEventListener('online', () => processPackingSyncQueues())
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) processPackingSyncQueues()
  })
}

export function stopPackingSyncService() {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
  }
}

export async function getOutboundPendingCount() {
  const [scans, jobs] = await Promise.all([getPendingScanCount(), getPendingSyncJobCount()])
  return scans + jobs
}
