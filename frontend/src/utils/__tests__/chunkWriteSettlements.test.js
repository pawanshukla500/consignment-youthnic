import { describe, expect, it } from 'vitest'
import { inspectChunkWriteSettlements } from '../videoQueue'

describe('inspectChunkWriteSettlements', () => {
  it('accepts empty / all-successful settlements', () => {
    expect(inspectChunkWriteSettlements([])).toEqual({
      ok: true,
      failedCount: 0,
      successCount: 0,
      errors: [],
    })
    expect(inspectChunkWriteSettlements([
      { status: 'fulfilled', value: undefined },
      { status: 'fulfilled', value: undefined },
    ]).ok).toBe(true)
  })

  it('detects one failed chunk among successful chunks', () => {
    const result = inspectChunkWriteSettlements([
      { status: 'fulfilled', value: undefined },
      { status: 'rejected', reason: new Error('QuotaExceededError') },
      { status: 'fulfilled', value: undefined },
    ])
    expect(result.ok).toBe(false)
    expect(result.failedCount).toBe(1)
    expect(result.successCount).toBe(2)
    expect(result.errors[0]).toMatch(/QuotaExceededError/)
  })

  it('treats IndexedDB quota exceeded as a failed write set', () => {
    const result = inspectChunkWriteSettlements([
      { status: 'rejected', reason: { name: 'QuotaExceededError', message: 'QuotaExceededError' } },
    ])
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toMatch(/QuotaExceededError/)
  })
})
