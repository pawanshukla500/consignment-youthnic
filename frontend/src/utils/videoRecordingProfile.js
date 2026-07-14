/**
 * Packing-station recording profile — keep evidence clear but upload-friendly.
 * Target: ~10–20 MB per typical box session (not 50–100+ MB).
 */

/** Soft warning / hard attention thresholds while recording */
export const VIDEO_SIZE_WARN_MB = 35
export const VIDEO_SIZE_HIGH_MB = 55

/** Prefer 720p @ 24fps for packing CCTV (enough detail, much smaller files). */
export const CAMERA_CONSTRAINT_PROFILES = [
  {
    label: '720p',
    video: {
      width: { ideal: 1280, max: 1280 },
      height: { ideal: 720, max: 720 },
      frameRate: { ideal: 24, max: 24 },
    },
  },
  {
    label: '720p-30',
    video: {
      width: { ideal: 1280, max: 1280 },
      height: { ideal: 720, max: 720 },
      frameRate: { ideal: 30, max: 30 },
    },
  },
  {
    label: '1080p-capped',
    video: {
      // Last resort if camera cannot do 720p constraints
      width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 },
      frameRate: { ideal: 24, max: 24 },
    },
  },
  {
    label: 'default',
    video: true,
  },
]

/**
 * Bitrate caps (bits/sec). At 1.4 Mbps / 720p ≈ 10.5 MB per minute.
 * A 4-minute box ≈ ~42 MB; previously 5 Mbps 1080p ≈ 37 MB/min → 100MB+ easily.
 */
export function pickRecordingBitrate(width = 1280, height = 720) {
  const pixels = Number(width) * Number(height)
  if (pixels >= 1800 * 900) return 2_000_000 // soft 1080p max
  if (pixels >= 1100 * 600) return 1_400_000 // 720p target
  return 900_000
}

/** Dynamic XHR timeout: base 3 min + 3s per MB, clamped 10–30 min */
export function uploadTimeoutForBytes(byteLength = 0) {
  const mb = Math.max(0, Number(byteLength) || 0) / (1024 * 1024)
  const ms = Math.round(180_000 + mb * 3_000)
  return Math.min(30 * 60 * 1000, Math.max(10 * 60 * 1000, ms))
}

export function formatMb(bytes) {
  return `${((Number(bytes) || 0) / (1024 * 1024)).toFixed(1)} MB`
}
