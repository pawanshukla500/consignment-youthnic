/**
 * Global packing sync — drains scan + save-box queues outside Packing Station.
 * Ensures queued work completes after navigation, refresh, or brief disconnects.
 */
import {
  drainPackingSyncQueue,
  getPendingSyncJobCount,
  getFailedSyncJobCount,
  resetFailedSyncJobs,
} from '../utils/packingSyncQueue'
import { processVideoUploadQueue } from './videoUploadService'
import { processSaveBoxJob } from '../utils/saveBoxSyncHelper'

let intervalId = null
let running = false
const listeners = new Set()

let pendingJobs = 0
let failedJobs = 0

function notify() {
  const payload = {
    pendingJobs,
    failedJobs,
    running,
  }
  listeners.forEach((fn) => fn(payload))
}

export function subscribePackingSyncStatus(fn) {
  listeners.add(fn)
  fn({ pendingJobs, failedJobs, running })
  return () => listeners.delete(fn)
}

async function refreshCounts() {
  ;[pendingJobs, failedJobs] = await Promise.all([
    getPendingSyncJobCount(),
    getFailedSyncJobCount(),
  ])
  notify()
}

export async function processPackingSyncQueues() {
  if (running) return
  running = true
  notify()

  try {
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

let handleOnline = null
let handleVis = null

export async function initPackingSyncService() {
  if (intervalId) return

  try {
    const { pruneDuplicateBoxVideos } = await import('../utils/videoQueue')
    const pruned = await pruneDuplicateBoxVideos().catch(() => 0)
    if (pruned > 0) console.log(`[PackingSync] Pruned ${pruned} duplicate local video(s)`)
    
    const [jobs] = await Promise.all([
      resetFailedSyncJobs(),
    ])
    if (jobs > 0) {
      console.log(`[PackingSync] Reset ${jobs} failed save-box job(s)`)
    }
  } catch (e) {
    console.warn('[PackingSync] Init recovery error:', e)
  }

  await refreshCounts()
  processPackingSyncQueues()

  intervalId = setInterval(() => processPackingSyncQueues(), 8_000)
  
  handleOnline = () => processPackingSyncQueues()
  handleVis = () => { if (!document.hidden) processPackingSyncQueues() }
  
  window.addEventListener('online', handleOnline)
  document.addEventListener('visibilitychange', handleVis)
}

export function stopPackingSyncService() {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
  }
  if (handleOnline) {
    window.removeEventListener('online', handleOnline)
    handleOnline = null
  }
  if (handleVis) {
    document.removeEventListener('visibilitychange', handleVis)
    handleVis = null
  }
}

export async function getOutboundPendingCount() {
  const jobs = await getPendingSyncJobCount()
  return jobs
}
