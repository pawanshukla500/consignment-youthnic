import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearAllSyncJobs,
  drainPackingSyncQueue,
  enqueueSaveBoxJob,
  getPendingSyncJobs,
} from '../packingSyncQueue'

describe('durable save-box queue', () => {
  beforeEach(async () => {
    await clearAllSyncJobs()
  })

  it('commits an immutable final-items snapshot before reporting local save success', async () => {
    const items = [{ skuId: 'sku-1', barcode: 'ABC-1', qty: 1 }]
    await enqueueSaveBoxJob({
      consignmentId: 'C1',
      boxNo: '3',
      items: items.map((item) => ({ ...item })),
    })
    items[0].qty = 99

    const [job] = await getPendingSyncJobs()
    expect(job).toMatchObject({ consignmentId: 'C1', boxNo: '3' })
    expect(job.items).toEqual([{ skuId: 'sku-1', barcode: 'ABC-1', qty: 1 }])
  })

  it('defers once without a busy loop when accepted scans are still pending', async () => {
    await enqueueSaveBoxJob({
      consignmentId: 'C1',
      boxNo: '3',
      items: [{ skuId: 'sku-1', qty: 1 }],
    })
    let attempts = 0
    const result = await drainPackingSyncQueue(async () => {
      attempts += 1
      const error = new Error('PENDING_SCANS')
      error.code = 'PENDING_SCANS'
      throw error
    })
    expect(result).toEqual({ done: false, deferred: true })
    expect(attempts).toBe(1)
    expect(await getPendingSyncJobs()).toHaveLength(1)
  })
})
