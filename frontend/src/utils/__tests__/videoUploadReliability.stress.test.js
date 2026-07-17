/**
 * Stress / recovery / integrity simulations for continuous packing video uploads.
 * These do not hit real R2 or IndexedDB — they validate the production state machine.
 */
import { describe, expect, it } from 'vitest'
import { VIDEO_STATUS, VIDEO_UPLOAD_CONFIG, backoffMs, uploadTimeoutForBytes } from '../videoUploadConfig'
import {
  assertVideoSizeAllowed,
  canDeleteLocalVideo,
  mergeCompletedParts,
  missingMultipartParts,
  nextRetryState,
  planMultipartParts,
  queueCapWarning,
  scheduleUploadWaves,
  shouldUseMultipart,
  simulateContinuousPackingUpload,
} from '../videoUploadPipeline'

describe('video upload config (production limits)', () => {
  it('supports 10–200 MB videos with multipart + concurrency caps', () => {
    expect(VIDEO_UPLOAD_CONFIG.maxVideoBytes).toBe(200 * 1024 * 1024)
    expect(VIDEO_UPLOAD_CONFIG.maxConcurrentUploads).toBeGreaterThanOrEqual(2)
    expect(VIDEO_UPLOAD_CONFIG.partSizeBytes).toBeGreaterThanOrEqual(5 * 1024 * 1024)
    expect(VIDEO_UPLOAD_CONFIG.maxUploadRetries).toBeGreaterThanOrEqual(10)
    expect(VIDEO_UPLOAD_CONFIG.maxQueuedVideos).toBeGreaterThanOrEqual(40)
    expect(uploadTimeoutForBytes(200 * 1024 * 1024)).toBeGreaterThanOrEqual(10 * 60 * 1000)
    expect(backoffMs(0)).toBeLessThan(backoffMs(5))
  })

  it('rejects oversized videos', () => {
    expect(() => assertVideoSizeAllowed(201 * 1024 * 1024)).toThrow(/maximum allowed/i)
    expect(assertVideoSizeAllowed(10 * 1024 * 1024)).toBe(10 * 1024 * 1024)
  })
})

describe('multipart resume planning', () => {
  it('plans parts for a 200 MB video', () => {
    const parts = planMultipartParts(200 * 1024 * 1024, 8 * 1024 * 1024)
    expect(parts.length).toBe(25)
    expect(parts[0].partNumber).toBe(1)
    expect(parts[parts.length - 1].byteLength).toBeLessThanOrEqual(8 * 1024 * 1024)
  })

  it('skips already-completed parts on resume', () => {
    const completed = [
      { partNumber: 1, etag: 'a' },
      { partNumber: 2, etag: 'b' },
    ]
    const missing = missingMultipartParts(24 * 1024 * 1024, completed, 8 * 1024 * 1024)
    expect(missing.map((p) => p.partNumber)).toEqual([3])
  })

  it('merges part etags without duplicates', () => {
    const merged = mergeCompletedParts(
      [{ partNumber: 1, etag: 'old' }],
      [{ partNumber: 1, etag: 'new' }, { partNumber: 2, etag: 'x' }],
    )
    expect(merged).toEqual([
      { partNumber: 1, etag: 'new' },
      { partNumber: 2, etag: 'x' },
    ])
  })

  it('uses multipart above threshold', () => {
    expect(shouldUseMultipart(8 * 1024 * 1024)).toBe(true)
    expect(shouldUseMultipart(7 * 1024 * 1024)).toBe(false)
  })
})

describe('verify-before-delete + retry state', () => {
  it('only allows local delete after metadata + R2 verify', () => {
    expect(canDeleteLocalVideo({ metadataSaved: true, storageVerified: false })).toBe(false)
    expect(canDeleteLocalVideo({ metadataSaved: false, storageVerified: true })).toBe(false)
    expect(canDeleteLocalVideo({ metadataSaved: true, storageVerified: true })).toBe(true)
  })

  it('keeps multipart progress when retrying', () => {
    const next = nextRetryState(
      { retries: 0, multipart: { uploadId: 'u1', completedParts: [{ partNumber: 1, etag: 'e' }] } },
      'part 2 failed',
    )
    expect(next.status).toBe(VIDEO_STATUS.RETRYING)
    expect(next.multipart.uploadId).toBe('u1')
    expect(next.multipart.completedParts).toHaveLength(1)
  })

  it('marks failed after max retries', () => {
    const next = nextRetryState({ retries: VIDEO_UPLOAD_CONFIG.maxUploadRetries - 1 }, 'boom')
    expect(next.status).toBe(VIDEO_STATUS.FAILED)
  })
})

describe('concurrency + queue caps', () => {
  it('schedules upload waves at max concurrency', () => {
    const waves = scheduleUploadWaves(['a', 'b', 'c', 'd', 'e'], 2)
    expect(waves).toEqual([['a', 'b'], ['c', 'd'], ['e']])
  })

  it('warns when queue/storage caps exceeded', () => {
    const warnings = queueCapWarning(50, 3000 * 1024 * 1024)
    expect(warnings.length).toBe(2)
  })
})

describe('continuous packing stress simulation (100 boxes, 10–200 MB)', () => {
  it('completes 100 boxes with disconnects, part failures, browser/worker restart', () => {
    const report = simulateContinuousPackingUpload({
      boxCount: 100,
      minMb: 10,
      maxMb: 200,
      concurrency: VIDEO_UPLOAD_CONFIG.maxConcurrentUploads,
      partFailEvery: 17,
      disconnectBoxes: [12, 45, 88],
      browserRestartAfterBox: 50,
      workerRestartAfterBox: 70,
      storageQuotaFailAtBox: null,
    })

    expect(report.prematureDeletes).toBe(0)
    expect(report.maxInFlight).toBeLessThanOrEqual(VIDEO_UPLOAD_CONFIG.maxConcurrentUploads)
    expect(report.resumedMultipart).toBeGreaterThan(0)
    expect(report.verifiedOnServer).toBe(100)
    expect(report.remainingLocal).toBe(0)
    expect(report.finishBlocked).toBe(false)
    expect(report.allVerified).toBe(true)
    expect(report.ok).toBe(true)
  })

  it('blocks finish when a video is still local / unverified', () => {
    // Force permanent failure by max retries = 0 style: storage quota fail leaves one unfinished
    const report = simulateContinuousPackingUpload({
      boxCount: 20,
      minMb: 10,
      maxMb: 40,
      concurrency: 2,
      partFailEvery: 0,
      disconnectBoxes: [],
      browserRestartAfterBox: null,
      workerRestartAfterBox: null,
      storageQuotaFailAtBox: 7,
    })

    expect(report.failedCount).toBeGreaterThanOrEqual(1)
    expect(report.finishBlocked).toBe(true)
    expect(report.verifiedOnServer).toBe(19)
    expect(report.prematureDeletes).toBe(0)
  })

  it('recovers from slow-link style part failures without duplicate DB records', () => {
    const report = simulateContinuousPackingUpload({
      boxCount: 40,
      minMb: 20,
      maxMb: 120,
      concurrency: 2,
      partFailEvery: 5,
      disconnectBoxes: [3, 19],
      browserRestartAfterBox: 15,
      workerRestartAfterBox: 25,
    })

    expect(report.ok).toBe(true)
    expect(report.verifiedOnServer).toBe(40)
    // Each box maps to exactly one server video key
    expect(report.completedBoxes).toBe(40)
  })

  it('does not block packing the next box on prior uploads (operator enqueue ahead of drain)', () => {
    const report = simulateContinuousPackingUpload({
      boxCount: 30,
      minMb: 10,
      maxMb: 80,
      concurrency: 2,
      partFailEvery: 0,
      disconnectBoxes: [],
    })
    // Queued events happen for every box before all uploads complete
    const queued = report.events.filter((e) => e.type === 'queued').length
    expect(queued).toBe(30)
    // Operator packs ahead while up to `concurrency` uploads run in parallel
    expect(report.maxInFlight).toBe(VIDEO_UPLOAD_CONFIG.maxConcurrentUploads)
    expect(report.ok).toBe(true)
  })
})
