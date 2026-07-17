import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDrainResult,
  createDrainWaiterRegistry,
  isTerminalSuccess,
} from '../videoDrainWaiter'

afterEach(() => {
  vi.useRealTimers()
})

describe('videoDrainWaiter', () => {
  it('empty queue / successful drain resolves once with structured ids', async () => {
    const registry = createDrainWaiterRegistry()
    const promise = new Promise((resolve, reject) => {
      registry.register({ resolve, reject, timeoutMs: 5000, requestId: 'drain_ok' })
    })

    const settled = registry.settle('drain_ok', createDrainResult({
      ok: true,
      requestId: 'drain_ok',
      uploadedIds: ['1', '2'],
      failedIds: [],
      pendingIds: [],
    }))

    expect(settled).toBe(true)
    await expect(promise).resolves.toMatchObject({
      ok: true,
      done: true,
      uploadedIds: ['1', '2'],
      failedIds: [],
      pendingIds: [],
    })
    // Duplicate QUEUE_DRAINED must not double-settle
    expect(registry.settle('drain_ok', createDrainResult({ ok: true }))).toBe(false)
    expect(registry.size()).toBe(0)
  })

  it('failed upload rejects with failedIds', async () => {
    const registry = createDrainWaiterRegistry()
    const promise = new Promise((resolve, reject) => {
      registry.register({ resolve, reject, timeoutMs: 5000, requestId: 'drain_fail' })
    })

    registry.settle('drain_fail', createDrainResult({
      ok: false,
      requestId: 'drain_fail',
      uploadedIds: [],
      failedIds: ['vid-9'],
      pendingIds: [],
      error: { code: 'UPLOAD_FAILED', message: '1 video upload(s) failed', retryable: true },
    }))

    await expect(promise).rejects.toMatchObject({
      code: 'UPLOAD_FAILED',
      result: { failedIds: ['vid-9'] },
    })
  })

  it('pending videos reject (finish must not succeed)', async () => {
    const registry = createDrainWaiterRegistry()
    const promise = new Promise((resolve, reject) => {
      registry.register({ resolve, reject, timeoutMs: 5000, requestId: 'drain_pending' })
    })

    registry.settle('drain_pending', createDrainResult({
      ok: false,
      pendingIds: ['vid-pending'],
      error: { code: 'UPLOAD_PENDING', message: 'still uploading', retryable: true },
    }))

    await expect(promise).rejects.toMatchObject({
      result: { pendingIds: ['vid-pending'] },
    })
    expect(isTerminalSuccess({ ok: true, pendingIds: ['x'] })).toBe(false)
  })

  it('worker exception rejects all waiters', async () => {
    const registry = createDrainWaiterRegistry()
    const p1 = new Promise((resolve, reject) => {
      registry.register({ resolve, reject, timeoutMs: 5000, requestId: 'a' })
    })
    const p2 = new Promise((resolve, reject) => {
      registry.register({ resolve, reject, timeoutMs: 5000, requestId: 'b' })
    })

    registry.rejectAll({ code: 'WORKER_EXCEPTION', message: 'boom' })

    await expect(p1).rejects.toMatchObject({ code: 'WORKER_EXCEPTION' })
    await expect(p2).rejects.toMatchObject({ code: 'WORKER_EXCEPTION' })
    expect(registry.size()).toBe(0)
  })

  it('timeout rejects and clears map entry', async () => {
    vi.useFakeTimers()
    const registry = createDrainWaiterRegistry()
    const promise = new Promise((resolve, reject) => {
      registry.register({ resolve, reject, timeoutMs: 1000, requestId: 'drain_timeout' })
    })

    vi.advanceTimersByTime(1000)
    await expect(promise).rejects.toMatchObject({
      code: 'DRAIN_TIMEOUT',
      result: { timedOut: true },
    })
    expect(registry.size()).toBe(0)
  })

  it('worker restart rejects in-flight drains then allows a new waiter', async () => {
    const registry = createDrainWaiterRegistry()
    const first = new Promise((resolve, reject) => {
      registry.register({ resolve, reject, timeoutMs: 5000, requestId: 'old' })
    })
    registry.rejectAll({ code: 'WORKER_TERMINATED', message: 'terminated' })
    await expect(first).rejects.toMatchObject({ code: 'WORKER_TERMINATED' })

    const second = new Promise((resolve, reject) => {
      registry.register({ resolve, reject, timeoutMs: 5000, requestId: 'new' })
    })
    registry.settle('new', createDrainResult({ ok: true, uploadedIds: ['ok'] }))
    await expect(second).resolves.toMatchObject({ ok: true, uploadedIds: ['ok'] })
  })

  it('finish clicked while uploading: pendingIds is not terminal success', () => {
    const midUpload = createDrainResult({
      ok: false,
      uploadedIds: [],
      failedIds: [],
      pendingIds: ['uploading-1'],
      error: { code: 'UPLOAD_PENDING', message: 'still uploading', retryable: true },
    })
    expect(isTerminalSuccess(midUpload)).toBe(false)
    expect(midUpload.done).toBe(false)
  })
})
