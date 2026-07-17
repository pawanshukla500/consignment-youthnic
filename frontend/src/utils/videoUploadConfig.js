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
  /**
   * Controlled stop margin before max — finalize current recording so it remains uploadable.
   * (Multi-segment continuation requires an approved schema change — see docs.)
   */
  softStopBytes: 190 * 1024 * 1024,
  /** How many box videos may upload at once from one browser. */
  maxConcurrentUploads: 2,
  /** Max unfinished active (non-superseded) videos in IndexedDB. */
  maxQueuedVideos: 40,
  /** Approx local blob budget hard cap (MB) including superseded evidence. */
  maxQueuedBytesMb: 2500,
  /** Attempts per queue item before status=failed. */
  maxUploadRetries: 20,
  /** Attempts per multipart part within one upload session. */
  maxPartAttempts: 4,
  /** Worker poll interval while idle. */
  queuePollMs: 2500,
  /** Metadata finalize retries after bytes land in R2. */
  metadataRetries: 6,
  /** Minimum free browser storage (MB) before starting a long recording. */
  minFreeStorageMb: 250,
  /**
   * Reserve factor when checking free space before recording:
   * expectedMax * (chunkAssembly + queueBlob + safety) ≈ 2.5x max video.
   */
  recordingReserveFactor: 2.5,
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
  MULTIPART_UPLOADING: 'multipart_uploading',
  MULTIPART_COMPLETING: 'multipart_completing',
  OBJECT_UPLOADED: 'object_uploaded',
  RETRYING: 'retrying',
  VERIFYING: 'verifying',
  COMPLETED: 'completed',
  FAILED: 'failed',
  /** Replaced by a newer local recording for the same box — blob retained until replacement verified. */
  SUPERSEDED: 'superseded',
})

export const APPROVED_VIDEO_MIME_TYPES = Object.freeze([
  'video/webm',
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/webm;codecs=vp8',
  'video/webm;codecs=vp9',
  'video/mp4;codecs=avc1.42E01E',
])

export function isApprovedVideoMime(mimeType = '') {
  const base = String(mimeType || '').split(';')[0].trim().toLowerCase()
  if (!base) return false
  return APPROVED_VIDEO_MIME_TYPES.some((allowed) => {
    const allowedBase = allowed.split(';')[0].trim().toLowerCase()
    return allowedBase === base
  })
}

export function backoffMs(retries) {
  return Math.min(30_000, 500 * Math.pow(1.6, Math.max(0, retries || 0)))
}

export function uploadTimeoutForBytes(byteLength = 0) {
  const mb = Math.max(0, Number(byteLength) || 0) / (1024 * 1024)
  // ~90s base + 3s/MB, capped at 25 minutes for ~200 MB on slow links
  const ms = Math.round(90_000 + mb * 3_000)
  return Math.min(25 * 60 * 1000, Math.max(90_000, ms))
}

/** Bytes that must be free before starting a new max-sized recording. */
export function recordingReserveBytes(config = VIDEO_UPLOAD_CONFIG) {
  return Math.ceil(config.maxVideoBytes * config.recordingReserveFactor)
}
