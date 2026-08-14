/**
 * Phase 0.5 video reliability tests:
 * - superseded evidence (no auto-delete)
 * - IndexedDB transaction commit semantics
 * - multipart crash recovery decisions
 * - retry backoff (no unlock storm)
 * - hard backpressure
 * - verify-before-delete
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { isIdbWriteCommitted, withIdbTransaction, idbRequest } from '../idbWrite'
import {
  VIDEO_STATUS,
  VIDEO_UPLOAD_CONFIG,
  backoffMs,
} from '../videoUploadConfig'
import {
  canDeleteLocalVideo,
  decideMultipartRecovery,
  evaluateRecordingBackpressure,
  isUploadReady,
  planSupersedeForBox,
} from '../videoUploadPipeline'
import {
  saveVideoToQueue,
  getOutstandingVideos,
  getActiveOutstandingVideos,
  pruneDuplicateBoxVideos,
  markVideoUploaded,
  clearFailedVideos,
  unlockOutstandingForImmediateRetry,
  incrementRetry,
  patchVideoQueueEntry,
  canStartRecordingSafely,
  __openDBForTests,
  __STORE_NAME,
} from '../videoQueue'

describe('issue1: never auto-delete unverified evidence', () => {
  beforeEach(async () => {
    const db = await __openDBForTests()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(__STORE_NAME, 'readwrite')
      tx.objectStore(__STORE_NAME).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  })

  it('replacement marks prior video superseded and keeps Blob', async () => {
    const blob1 = new Blob([new Uint8Array(2048)], { type: 'video/webm' })
    const blob2 = new Blob([new Uint8Array(4096)], { type: 'video/webm' })
    const id1 = await saveVideoToQueue(blob1, {
      consignmentId: 'c1',
      boxNo: '1',
      fileName: 'a.webm',
      mimeType: 'video/webm',
      sessionId: 'sess_a',
    })
    const id2 = await saveVideoToQueue(blob2, {
      consignmentId: 'c1',
      boxNo: '1',
      fileName: 'b.webm',
      mimeType: 'video/webm',
      sessionId: 'sess_b',
    })

    const all = await getOutstandingVideos('c1')
    expect(all).toHaveLength(2)
    const old = all.find((v) => v.id === id1)
    const neu = all.find((v) => v.id === id2)
    expect(old.status).toBe(VIDEO_STATUS.SUPERSEDED)
    expect(old.blob.size).toBe(2048)
    expect(neu.status).toBe(VIDEO_STATUS.QUEUED)
    expect(neu.blob.size).toBe(4096)

    const active = await getActiveOutstandingVideos('c1')
    expect(active.map((v) => v.id)).toEqual([id2])
  })

  it('pruneDuplicateBoxVideos does not destroy Blob data', async () => {
    const b1 = new Blob([new Uint8Array(1500)], { type: 'video/webm' })
    const b2 = new Blob([new Uint8Array(2500)], { type: 'video/webm' })
    // Manually insert two active rows for same box (simulate race)
    const db = await __openDBForTests()
    await withIdbTransaction(db, __STORE_NAME, 'readwrite', async (stores) => {
      await idbRequest(stores[__STORE_NAME].add({
        blob: b1,
        metadata: { consignmentId: 'c1', boxNo: '2', fileName: '1.webm' },
        status: VIDEO_STATUS.QUEUED,
        createdAt: 1,
        retries: 0,
      }))
      await idbRequest(stores[__STORE_NAME].add({
        blob: b2,
        metadata: { consignmentId: 'c1', boxNo: '2', fileName: '2.webm' },
        status: VIDEO_STATUS.QUEUED,
        createdAt: 2,
        retries: 0,
      }))
    })

    const pruned = await pruneDuplicateBoxVideos()
    expect(pruned).toBeGreaterThanOrEqual(1)
    const all = await getOutstandingVideos('c1')
    expect(all.every((v) => v.blob?.size > 0)).toBe(true)
    expect(all.some((v) => v.status === VIDEO_STATUS.SUPERSEDED)).toBe(true)
  })

  it('pruneDuplicateBoxVideos never supersedes a reopen video against the original', async () => {
    // One normal (first-time pack) recording and one isReopen (box reopened to add
    // more qty) recording for the same box, both still outstanding at the same time.
    const original = new Blob([new Uint8Array(1500)], { type: 'video/webm' })
    const additional = new Blob([new Uint8Array(2500)], { type: 'video/webm' })
    const db = await __openDBForTests()
    await withIdbTransaction(db, __STORE_NAME, 'readwrite', async (stores) => {
      await idbRequest(stores[__STORE_NAME].add({
        blob: original,
        metadata: { consignmentId: 'c1', boxNo: '4', fileName: 'box4.webm' },
        status: VIDEO_STATUS.QUEUED,
        createdAt: 1,
        retries: 0,
      }))
      await idbRequest(stores[__STORE_NAME].add({
        blob: additional,
        metadata: { consignmentId: 'c1', boxNo: '4', fileName: 'box4_2.webm', isReopen: true },
        status: VIDEO_STATUS.QUEUED,
        createdAt: 2,
        retries: 0,
      }))
    })

    await pruneDuplicateBoxVideos()

    const all = await getOutstandingVideos('c1')
    expect(all).toHaveLength(2)
    expect(all.every((v) => v.status !== VIDEO_STATUS.SUPERSEDED)).toBe(true)
  })

  it('verified replacement cleans superseded; unverified refuse delete', async () => {
    const blob1 = new Blob([new Uint8Array(1800)], { type: 'video/webm' })
    const blob2 = new Blob([new Uint8Array(2800)], { type: 'video/webm' })
    const id1 = await saveVideoToQueue(blob1, {
      consignmentId: 'c1', boxNo: '3', fileName: 'a.webm', mimeType: 'video/webm', sessionId: 's1',
    })
    const id2 = await saveVideoToQueue(blob2, {
      consignmentId: 'c1', boxNo: '3', fileName: 'b.webm', mimeType: 'video/webm', sessionId: 's2',
    })

    await expect(markVideoUploaded(id2, { verified: false })).rejects.toMatchObject({
      code: 'VERIFY_REQUIRED',
    })
    expect((await getOutstandingVideos('c1')).length).toBe(2)

    await markVideoUploaded(id2, { verified: true })
    const left = await getOutstandingVideos('c1')
    expect(left.find((v) => v.id === id1)).toBeUndefined()
    expect(left.find((v) => v.id === id2)).toBeUndefined()
  })

  it('explicit discard requires confirmation', async () => {
    await expect(clearFailedVideos()).rejects.toMatchObject({ code: 'DISCARD_CONFIRM_REQUIRED' })
  })

  it('planSupersedeForBox never lists keep id for deletion', () => {
    const { keep, superseded } = planSupersedeForBox([
      { id: 1, createdAt: 1, status: 'queued' },
      { id: 2, createdAt: 2, status: 'queued' },
    ], 2)
    expect(keep.id).toBe(2)
    expect(superseded.map((s) => s.id)).toEqual([1])
  })
})

describe('issue2: IndexedDB writes await transaction.oncomplete', () => {
  it('isIdbWriteCommitted only accepts complete', () => {
    expect(isIdbWriteCommitted('success')).toBe(false)
    expect(isIdbWriteCommitted('complete')).toBe(true)
    expect(isIdbWriteCommitted('abort')).toBe(false)
  })

  it('withIdbTransaction resolves after commit and rejects on abort', async () => {
    const db = await __openDBForTests()
    const id = await withIdbTransaction(db, __STORE_NAME, 'readwrite', async (stores) => {
      return idbRequest(stores[__STORE_NAME].add({
        blob: new Blob([new Uint8Array(1200)]),
        metadata: { consignmentId: 'tx', boxNo: '1' },
        status: VIDEO_STATUS.QUEUED,
        createdAt: Date.now(),
        retries: 0,
      }))
    })
    expect(id).toBeTruthy()

    await expect(
      withIdbTransaction(db, __STORE_NAME, 'readwrite', async (stores, tx) => {
        await idbRequest(stores[__STORE_NAME].put({
          id,
          blob: new Blob([new Uint8Array(1200)]),
          metadata: { consignmentId: 'tx', boxNo: '1' },
          status: 'queued',
        }))
        tx.abort()
      })
    ).rejects.toBeTruthy()
  })

  it('patchVideoQueueEntry preserves Blob when patch omits blob', async () => {
    const blob = new Blob([new Uint8Array(2200)], { type: 'video/webm' })
    const id = await saveVideoToQueue(blob, {
      consignmentId: 'c2', boxNo: '9', fileName: 'x.webm', mimeType: 'video/webm', sessionId: 'sx',
    })
    await patchVideoQueueEntry(id, { progress: 42, status: VIDEO_STATUS.UPLOADING })
    const row = (await getOutstandingVideos('c2')).find((v) => v.id === id)
    expect(row.blob.size).toBe(2200)
    expect(row.progress).toBe(42)
  })
})

describe('issue3: multipart crash recovery decisions', () => {
  const base = {
    expectedSize: 16 * 1024 * 1024,
    expectedMime: 'video/webm',
    expectedPath: 'consignments/c1/boxes/box_1/video_1.webm',
  }

  it('resumes when ListParts ok', () => {
    const d = decideMultipartRecovery({
      ...base,
      listResult: { ok: true, parts: [{ partNumber: 1, etag: 'a' }] },
      headResult: null,
    })
    expect(d.action).toBe('resume_parts')
  })

  it('retries on ListParts error (not empty parts)', () => {
    const d = decideMultipartRecovery({
      ...base,
      listResult: { ok: false, code: 'LIST_PARTS_FAILED', message: 'timeout' },
      headResult: null,
    })
    expect(d.action).toBe('retry_list')
  })

  it('finalizes metadata when upload gone but HeadObject matches', () => {
    const d = decideMultipartRecovery({
      ...base,
      listResult: { ok: false, code: 'NoSuchUpload', message: 'gone' },
      headResult: {
        ok: true,
        size: base.expectedSize,
        contentType: 'video/webm',
        storagePath: base.expectedPath,
        etag: 'e',
      },
    })
    expect(d.action).toBe('finalize_metadata')
  })

  it('restarts multipart when object missing after NoSuchUpload', () => {
    const d = decideMultipartRecovery({
      ...base,
      listResult: { ok: false, code: 'NoSuchUpload', message: 'gone' },
      headResult: { ok: false },
    })
    expect(d.action).toBe('restart_multipart')
    expect(d.preserveBlob).toBe(true)
  })

  it('restarts when object size mismatches', () => {
    const d = decideMultipartRecovery({
      ...base,
      listResult: { ok: false, code: 'NoSuchUpload', message: 'gone' },
      headResult: {
        ok: true,
        size: 100,
        contentType: 'video/webm',
        storagePath: base.expectedPath,
      },
    })
    expect(d.action).toBe('restart_multipart')
  })
})

describe('issue4: verified flag semantics', () => {
  it('fileRecord.id is not enough to delete local blob', () => {
    expect(canDeleteLocalVideo({ verified: true })).toBe(true)
    expect(canDeleteLocalVideo({ verified: false })).toBe(false)
    expect(canDeleteLocalVideo({ metadataSaved: true, storageVerified: true })).toBe(false)
    expect(canDeleteLocalVideo({})).toBe(false)
  })
})

describe('issue5: retry backoff preserved on normal polls', () => {
  beforeEach(async () => {
    const db = await __openDBForTests()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(__STORE_NAME, 'readwrite')
      tx.objectStore(__STORE_NAME).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  })

  it('repeated polls respect nextAttemptAt; manual unlock bypasses once', async () => {
    const blob = new Blob([new Uint8Array(1600)], { type: 'video/webm' })
    const id = await saveVideoToQueue(blob, {
      consignmentId: 'c3', boxNo: '1', fileName: 'r.webm', mimeType: 'video/webm', sessionId: 'sr',
    })
    const now = Date.now()
    const nextAttemptAt = now + 120_000
    await incrementRetry(id, nextAttemptAt, 'network blip')

    // Simulate many normal poll ticks (2.5s) without unlock — still before nextAttemptAt
    for (let i = 1; i <= 20; i += 1) {
      const pollNow = now + (i * VIDEO_UPLOAD_CONFIG.queuePollMs)
      expect(pollNow).toBeLessThan(nextAttemptAt)
      const ready = (await getOutstandingVideos('c3')).filter((v) => isUploadReady(v, pollNow))
      expect(ready).toHaveLength(0)
    }

    // Immediate retry (user / online / finish) clears backoff once
    await unlockOutstandingForImmediateRetry()
    const ready = (await getOutstandingVideos('c3')).filter((v) => isUploadReady(v, now))
    expect(ready).toHaveLength(1)
    expect(ready[0].id).toBe(id)
    expect(backoffMs(1)).toBeGreaterThan(backoffMs(0))
  })
})

describe('issue6: hard queue/storage backpressure', () => {
  it('blocks when queue nearly full or two 200MB videos queued', () => {
    const twoHundred = 200 * 1024 * 1024
    const blocked = evaluateRecordingBackpressure({
      queueCount: 2,
      queueBytes: twoHundred * 2,
      freeMb: 100,
      quotaSupported: true,
    })
    expect(blocked.allowed).toBe(false)
    expect(blocked.actions.length).toBeGreaterThan(0)
  })

  it('blocks on low quota; allows when quota API unavailable if queue ok', () => {
    const low = evaluateRecordingBackpressure({
      queueCount: 0,
      queueBytes: 0,
      freeMb: 10,
      quotaSupported: true,
    })
    expect(low.allowed).toBe(false)

    const unknown = evaluateRecordingBackpressure({
      queueCount: 0,
      queueBytes: 0,
      freeMb: null,
      quotaSupported: false,
    })
    expect(unknown.allowed).toBe(true)
  })

  it('canStartRecordingSafely integrates queue totals', async () => {
    const db = await __openDBForTests()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(__STORE_NAME, 'readwrite')
      tx.objectStore(__STORE_NAME).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    const ok = await canStartRecordingSafely({ supported: true, freeMb: 2000 })
    expect(ok.allowed).toBe(true)
  })
})
