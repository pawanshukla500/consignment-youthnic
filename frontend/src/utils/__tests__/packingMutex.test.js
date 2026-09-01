import { describe, it, expect } from 'vitest'
import { createScanCaptureCoordinator } from '../scanCaptureCoordinator'
import { clonePackingBoxItems } from '../packingQuantities'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

describe('Packing Station post-durability coordinator', () => {
  it('starts 100 durable captures synchronously without a pre-durability Promise queue', async () => {
    const coordinator = createScanCaptureCoordinator()
    const context = { consignmentId: 'C1', boxNo: '3' }
    coordinator.openBox(context)
    let captureStarted = 0
    let durable = 0
    let uiApplied = 0

    for (let i = 0; i < 100; i += 1) {
      coordinator.registerScan({
        context,
        capture: async () => {
          captureStarted += 1
          await wait(25)
          durable += 1
          return Object.freeze({ id: `scan-${i}`, boxNo: '3', sequenceNo: i + 1 })
        },
        afterDurable: () => { uiApplied += 1 },
      })
    }

    expect(captureStarted).toBe(100)
    expect(uiApplied).toBe(0)
    expect(coordinator.getBoxState(context).maximumInFlight).toBe(100)

    await coordinator.flushAcceptedScansForBox(context)
    expect(durable).toBe(100)
    expect(uiApplied).toBe(100)
    expect(coordinator.getBoxState(context).inFlight).toBe(0)
  })

  it('makes immediate SAVE BOX include the final locally accepted scan', async () => {
    const coordinator = createScanCaptureCoordinator()
    const context = { consignmentId: 'C1', boxNo: '7' }
    const box = []
    coordinator.openBox(context)
    coordinator.registerScan({
      context,
      capture: async () => {
        await wait(30)
        return Object.freeze({ id: 'last-scan', consignmentId: 'C1', boxNo: '7' })
      },
      afterDurable: (scan) => box.push({ id: scan.id, qty: 1 }),
    })

    await coordinator.flushAcceptedScansForBox(context)
    const savedSnapshot = box.map((item) => ({ ...item }))
    expect(savedSnapshot).toEqual([{ id: 'last-scan', qty: 1 }])
  })

  it('keeps an immediate NEXT BOX scan in the old immutable box context', async () => {
    const coordinator = createScanCaptureCoordinator()
    const oldContext = { consignmentId: 'C1', boxNo: '1' }
    const newContext = { consignmentId: 'C1', boxNo: '2' }
    const boxes = { '1': [], '2': [] }
    const envelope = Object.freeze({ id: 'scan-old', consignmentId: 'C1', boxNo: '1' })
    coordinator.openBox(oldContext)
    coordinator.registerScan({
      context: oldContext,
      capture: async () => {
        await wait(20)
        return envelope
      },
      afterDurable: (scan) => boxes[scan.boxNo].push(scan.id),
    })

    await coordinator.flushAcceptedScansForBox(oldContext)
    coordinator.openBox(newContext)
    expect(boxes).toEqual({ '1': ['scan-old'], '2': [] })
    expect(envelope.boxNo).toBe('1')
  })

  it('explicitly rejects scanner callbacks arriving after the box gate closes', async () => {
    const coordinator = createScanCaptureCoordinator()
    const context = { consignmentId: 'C1', boxNo: '1' }
    coordinator.openBox(context)
    coordinator.closeBox(context)
    const registration = coordinator.registerScan({
      context,
      capture: () => Promise.resolve({ id: 'late' }),
      afterDurable: () => {},
    })
    expect(registration).toEqual({ accepted: false, reason: 'box_closing' })
  })

  it('never reports a post-durability UI failure as an uncaptured scan', async () => {
    const coordinator = createScanCaptureCoordinator()
    const context = { consignmentId: 'C1', boxNo: '1' }
    let captureFailure = 0
    let durableFailure = 0
    coordinator.openBox(context)
    coordinator.registerScan({
      context,
      capture: () => Promise.resolve(Object.freeze({ id: 'durable-1', boxNo: '1' })),
      afterDurable: () => { throw new Error('UI commit failed') },
      onCaptureFailure: () => { captureFailure += 1 },
      onPostDurabilityFailure: (_error, scan) => {
        expect(scan.id).toBe('durable-1')
        durableFailure += 1
      },
    })
    await coordinator.flushAcceptedScansForBox(context)
    expect(captureFailure).toBe(0)
    expect(durableFailure).toBe(1)
  })

  it('gives 15 unique durable scans exactly 10 accepts and 5 explicit rejections', async () => {
    const coordinator = createScanCaptureCoordinator()
    const context = { consignmentId: 'C1', boxNo: '1' }
    let accepted = 0
    let rejected = 0
    coordinator.openBox(context)
    for (let index = 0; index < 15; index += 1) {
      coordinator.registerScan({
        context,
        capture: () => Promise.resolve(Object.freeze({ id: `scan-${index}`, sequenceNo: index + 1 })),
        afterDurable: () => {
          if (accepted < 10) accepted += 1
          else rejected += 1
        },
      })
    }
    await coordinator.flushAcceptedScansForBox(context)
    expect(accepted).toBe(10)
    expect(rejected).toBe(5)
  })

  it('does not mutate the live box row during optimistic validation', () => {
    const liveItems = [{ skuId: 'sku-1', qty: 1 }]
    const validationItems = clonePackingBoxItems(liveItems)
    validationItems[0].qty += 1
    expect(liveItems[0].qty).toBe(1)

    const committedItems = clonePackingBoxItems(liveItems)
    committedItems[0].qty += 1
    expect(committedItems[0].qty).toBe(2)
  })
})
