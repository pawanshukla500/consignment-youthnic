/**
 * Production limits for continuous packing-station video uploads.
 * Tuned for 10–200 MB box videos, back-to-back packing, multi-station use.
 */

export const VIDEO_UPLOAD_CONFIG = Object.freeze({
  /** Multipart part size (R2/S3 minimum is 5 MiB except last part). */
  partSizeBytes: 8 * 1024 * 1024,
  /** Parallel part PUTs within one video. */
  parallelParts: 4,
  /** Videos larger than this use multipart. */
  multipartThresholdBytes: 8 * 1024 * 1024,
  /** Hard ceiling for a single packing video. */
  maxVideoBytes: 200 * 1024 * 1024,
  /** Soft warn while recording. */
  warnVideoBytes: 80 * 1024 * 1024,
  /** How many box videos may upload at once from one browser. */
  maxConcurrentUploads: 2,
  /** Max unfinished videos kept in IndexedDB before operator warning. */
  maxQueuedVideos: 40,
  /** Approx local blob budget warning (MB). */
  maxQueuedBytesMb: 2500,
  /** Attempts per queue item before status=failed. */
  maxUploadRetries: 20,
  /** Attempts per multipart part within one upload session. */
  maxPartAttempts: 4,
  /** Worker poll interval while idle. */
  queuePollMs: 2500,
  /** Metadata finalize retries after bytes land in R2. */
  metadataRetries: 6,
  /** Minimum free browser storage (MB) recommended before long recording. */
  minFreeStorageMb: 250,
  /** Finish drain overall deadline. */
  finishDrainTimeoutMs: 10 * 60 * 1000,
  /** Single drain wait slice. */
  drainSliceTimeoutMs: 60 * 1000,
})

export const VIDEO_STATUS = Object.freeze({
  RECORDING: 'recording',
  STORAGE_FAILED: 'storage_failed',
  QUEUED: 'queued',
  UPLOADING: 'uploading',
  RETRYING: 'retrying',
  VERIFYING: 'verifying',
  COMPLETED: 'completed',
  FAILED: 'failed',
})

export function backoffMs(retries) {
  return Math.min(30_000, 500 * Math.pow(1.6, Math.max(0, retries || 0)))
}

export function uploadTimeoutForBytes(byteLength = 0) {
  const mb = Math.max(0, Number(byteLength) || 0) / (1024 * 1024)
  // ~90s base + 3s/MB, capped at 25 minutes for ~200 MB on slow links
  const ms = Math.round(90_000 + mb * 3_000)
  return Math.min(25 * 60 * 1000, Math.max(90_000, ms))
}
