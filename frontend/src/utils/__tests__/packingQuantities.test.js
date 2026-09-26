import { describe, it, expect } from 'vitest'
import { resolveBoxCount } from '../packingQuantities'

describe('resolveBoxCount', () => {
  it('reports boxes packed after load even when the server count was zero', () => {
    // A station that claims a shipment with no server-side boxes caches
    // boxCount: 0, and that value is never refreshed while packing offline.
    const boxes = {
      1: [{ skuId: 'a', qty: 18 }],
      2: [{ skuId: 'b', qty: 74 }],
      3: [{ skuId: 'c', qty: 48 }],
      4: [{ skuId: 'd', qty: 18 }],
      5: [{ skuId: 'e', qty: 60 }],
    }
    expect(resolveBoxCount(boxes, 0)).toBe(5)
  })

  it('never drops below the count the server already confirmed', () => {
    expect(resolveBoxCount({ 1: [{ skuId: 'a', qty: 1 }] }, 4)).toBe(4)
  })

  it('ignores boxes that were opened but hold no items', () => {
    expect(resolveBoxCount({ 1: [{ skuId: 'a', qty: 1 }], 2: [] }, 0)).toBe(1)
  })

  it('treats missing and malformed inputs as zero rather than throwing', () => {
    expect(resolveBoxCount()).toBe(0)
    expect(resolveBoxCount({}, 0)).toBe(0)
    expect(resolveBoxCount({}, undefined)).toBe(0)
    expect(resolveBoxCount({}, 'not-a-number')).toBe(0)
    expect(resolveBoxCount({}, -3)).toBe(0)
    expect(resolveBoxCount({ 1: null }, 0)).toBe(0)
  })
})
