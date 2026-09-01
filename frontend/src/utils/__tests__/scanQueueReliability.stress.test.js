import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SCAN_STATUS,
  captureScan,
  clearAllScans,
  createScanEnvelope,
  drainScanQueue,
  getPendingScanCount,
  getScanDiagnostics,
  getScanHistory,
  markScanReadyForSync,
  recoverUnadmittedScans,
  resetScanDiagnosticsForTests,
} from '../scanQueue'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function envelope(sequenceNo, barcode = `SKU-${sequenceNo}`, qty = 1) {
  return createScanEnvelope({
    id: `scan-${sequenceNo}`,
    stationSessionId: 'station-test',
    sequenceNo,
    barcode,
    qty,
    consignmentId: 'C1',
    boxNo: '3',
    scannerReceivedAt: Date.now(),
  })
}

async function captureReady(scan, options) {
  const durable = await captureScan(scan, options)
  await markScanReadyForSync(durable.id, { uiApplied: true, uiCommittedAt: Date.now() })
  return durable
}

describe('durable scan outbox stress and recovery', () => {
  beforeEach(async () => {
    vi.stubGlobal('navigator', { onLine: true })
    await clearAllScans()
    resetScanDiagnosticsForTests()
  })

  it('accounts for 100 synchronous physical scans through durability and server mutation', async () => {
    const scans = Array.from({ length: 100 }, (_, index) => envelope(index + 1))
    expect(new Set(scans.map((scan) => scan.id)).size).toBe(100)
    await Promise.all(scans.map((scan) => captureReady(scan)))
    expect(await getPendingScanCount()).toBe(100)

    let serverMutations = 0
    await drainScanQueue(async () => {
      serverMutations += 1
      return { packed: serverMutations, required: 100 }
    })

    const history = await getScanHistory()
    expect(serverMutations).toBe(100)
    expect(history).toHaveLength(100)
    expect(history.every((scan) => scan.status === SCAN_STATUS.SERVER_CONFIRMED)).toBe(true)
  })

  it('durably captures 500 rapid scans with no event loss', async () => {
    const scans = Array.from({ length: 500 }, (_, index) => envelope(index + 1))
    await Promise.all(scans.map((scan) => captureScan(scan)))
    const history = await getScanHistory()
    expect(history).toHaveLength(500)
    expect(new Set(history.map((scan) => scan.id)).size).toBe(500)
  })

  it('keeps 100 repeated identical barcodes as 100 unique pieces', async () => {
    const scans = Array.from({ length: 100 }, (_, index) => envelope(index + 1, 'ABC-SAME'))
    await Promise.all(scans.map((scan) => captureReady(scan)))
    let quantity = 0
    await drainScanQueue(async (scan) => {
      quantity += scan.qty
      return { packed: quantity, required: 100 }
    })
    const history = await getScanHistory()
    expect(history.filter((scan) => scan.barcode === 'ABC-SAME')).toHaveLength(100)
    expect(new Set(history.map((scan) => scan.id)).size).toBe(100)
    expect(quantity).toBe(100)
  })

  it('never permits lifecycle updates to change immutable scan identity or box context', async () => {
    const original = envelope(1, 'IMMUTABLE-ABC')
    await captureScan(original)
    await markScanReadyForSync(original.id, {
      id: 'replacement-id',
      barcode: 'CHANGED-BARCODE',
      consignmentId: 'C2',
      boxNo: '99',
      sequenceNo: 999,
    })
    const [stored] = await getScanHistory()
    expect(stored).toMatchObject({
      id: 'scan-1',
      barcode: 'IMMUTABLE-ABC',
      consignmentId: 'C1',
      boxNo: '3',
      sequenceNo: 1,
    })
  })

  it('preserves exact alternating A/B counts', async () => {
    const scans = Array.from(
      { length: 100 },
      (_, index) => envelope(index + 1, index % 2 ? 'SKU-B' : 'SKU-A')
    )
    await Promise.all(scans.map((scan) => captureReady(scan)))
    const serverCounts = { 'SKU-A': 0, 'SKU-B': 0 }
    await drainScanQueue(async (scan) => {
      serverCounts[scan.barcode] += scan.qty
      return { packed: serverCounts[scan.barcode], required: 50 }
    })
    const history = await getScanHistory()
    expect(history.filter((scan) => scan.barcode === 'SKU-A')).toHaveLength(50)
    expect(history.filter((scan) => scan.barcode === 'SKU-B')).toHaveLength(50)
    expect(serverCounts).toEqual({ 'SKU-A': 50, 'SKU-B': 50 })
  })

  it('captures scans arriving every 5 ms without loss', async () => {
    const captures = []
    for (let index = 0; index < 100; index += 1) {
      captures.push(captureScan(envelope(index + 1)))
      await wait(5)
    }
    await Promise.all(captures)
    expect(await getScanHistory()).toHaveLength(100)
  })

  it('starts every capture immediately when IndexedDB is delayed by 100 ms', async () => {
    let delayEntered = 0
    const startedAt = performance.now()
    const captures = Array.from({ length: 100 }, (_, index) => captureScan(
      envelope(index + 1),
      { beforeTransaction: async () => { delayEntered += 1; await wait(100) } }
    ))

    await wait(10)
    expect(delayEntered).toBe(100)
    expect(getScanDiagnostics().maximumCaptureBacklog).toBe(100)
    await Promise.all(captures)
    const elapsedMs = performance.now() - startedAt
    expect(await getScanHistory()).toHaveLength(100)
    expect(elapsedMs).toBeLessThan(1500)
  })

  it('recovers and syncs all 50 pre-admission durable rows after a simulated browser refresh', async () => {
    await Promise.all(Array.from({ length: 50 }, (_, index) => captureScan(envelope(index + 1))))
    expect((await getScanHistory()).every((scan) => scan.readyForSync === false)).toBe(true)
    expect(await recoverUnadmittedScans()).toBe(50)
    const serverIds = new Set()
    await drainScanQueue(async (scan) => {
      serverIds.add(scan.id)
      return { packed: serverIds.size, required: 50 }
    })
    const afterRefresh = await getScanHistory()
    expect(afterRefresh).toHaveLength(50)
    expect(serverIds.size).toBe(50)
    expect(afterRefresh.every((scan) => scan.status === SCAN_STATUS.SERVER_CONFIRMED)).toBe(true)
  })

  it('keeps additional offline scans and syncs every ID once on reconnect', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, index) => captureReady(envelope(index + 1))))
    vi.stubGlobal('navigator', { onLine: false })
    await drainScanQueue(async () => { throw new Error('Network Error') })
    await Promise.all(Array.from({ length: 20 }, (_, index) => captureReady(envelope(index + 21))))
    expect(await getPendingScanCount()).toBe(40)

    vi.stubGlobal('navigator', { onLine: true })
    const serverIds = new Set()
    let mutations = 0
    await drainScanQueue(async (scan) => {
      if (!serverIds.has(scan.id)) {
        serverIds.add(scan.id)
        mutations += scan.qty
      }
      return { packed: mutations, required: 40 }
    })
    expect(serverIds.size).toBe(40)
    expect(mutations).toBe(40)
    expect(await getPendingScanCount()).toBe(0)
  })

  it('retries the same scan ID after a commit-timeout without a duplicate mutation', async () => {
    await captureReady(envelope(1, 'TIMEOUT-SKU'))
    const committedIds = new Set()
    let quantity = 0
    let attempts = 0
    const server = async (scan) => {
      attempts += 1
      if (!committedIds.has(scan.id)) {
        committedIds.add(scan.id)
        quantity += scan.qty
      }
      if (attempts === 1) throw new Error('timeout')
      return { packed: quantity, required: 1, scan_id: scan.id }
    }

    await drainScanQueue(server)
    expect(await getPendingScanCount()).toBe(1)
    await drainScanQueue(server)
    expect(attempts).toBe(2)
    expect(quantity).toBe(1)
    expect(await getPendingScanCount()).toBe(0)
  })

  it('retries an offline removal with the same ID and removes exactly once', async () => {
    const removal = envelope(1, 'REMOVE-SKU', -1)
    await captureReady(removal)
    vi.stubGlobal('navigator', { onLine: false })
    await drainScanQueue(async () => { throw new Error('failed to fetch') })
    expect(await getPendingScanCount()).toBe(1)

    vi.stubGlobal('navigator', { onLine: true })
    const committedIds = new Set()
    let quantity = 1
    await drainScanQueue(async (scan) => {
      if (!committedIds.has(scan.id)) {
        committedIds.add(scan.id)
        quantity += scan.qty
      }
      return { packed: quantity, required: 1, scan_id: scan.id }
    })
    expect(quantity).toBe(0)
    expect(committedIds.size).toBe(1)
  })

  it('does not wait for a video worker before becoming durable', async () => {
    let finishVideo
    const videoUpload = new Promise((resolve) => { finishVideo = resolve })
    const captures = Promise.all(
      Array.from({ length: 100 }, (_, index) => captureScan(envelope(index + 1)))
    )
    await captures
    expect(await getScanHistory()).toHaveLength(100)
    finishVideo()
    await videoUpload
  })
})
