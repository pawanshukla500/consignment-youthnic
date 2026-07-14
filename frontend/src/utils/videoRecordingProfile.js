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
 * Bitrate caps (bits/sec). At ~1.15 Mbps / 720p ≈ 8.6 MB per minute.
 * Keeps packing evidence clear while finishing R2 uploads quickly on factory links.
 */
export function pickRecordingBitrate(width = 1280, height = 720) {
  const pixels = Number(width) * Number(height)
  if (pixels >= 1800 * 900) return 1_600_000 // soft 1080p max
  if (pixels >= 1100 * 600) return 1_150_000 // 720p target (~7–12 MB/min)
  return 750_000
}

/** Dynamic XHR timeout: base 90s + 2.5s per MB, clamped 1–20 min */
export function uploadTimeoutForBytes(byteLength = 0) {
  const mb = Math.max(0, Number(byteLength) || 0) / (1024 * 1024)
  const ms = Math.round(90_000 + mb * 2_500)
  return Math.min(20 * 60 * 1000, Math.max(60_000, ms))
}

export function formatMb(bytes) {
  return `${((Number(bytes) || 0) / (1024 * 1024)).toFixed(1)} MB`
}
