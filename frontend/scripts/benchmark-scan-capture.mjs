import 'fake-indexeddb/auto'
import {
  captureScan,
  clearAllScans,
  createScanEnvelope,
  drainScanQueue,
  getScanDiagnostics,
  getScanHistory,
  markScanReadyForSync,
  notePhysicalScan,
  resetScanDiagnosticsForTests,
} from '../src/utils/scanQueue.js'

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { onLine: true },
})

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function runCase({ count, intervalMs = 0, indexedDbDelayMs = 0 }) {
  await clearAllScans()
  resetScanDiagnosticsForTests()
  let uiCount = 0
  let serverCount = 0
  const captures = []
  const prefix = `${count}-${intervalMs}-${indexedDbDelayMs}`

  for (let index = 0; index < count; index += 1) {
    const scannerReceivedAt = Date.now()
    notePhysicalScan()
    const envelope = createScanEnvelope({
      id: `${prefix}-${index + 1}`,
      stationSessionId: 'benchmark-station',
      sequenceNo: index + 1,
      barcode: `SKU-${index % 2}`,
      qty: 1,
      consignmentId: 'benchmark-consignment',
      boxNo: '3',
      scannerReceivedAt,
    })
    captures.push(captureScan(envelope, {
      beforeTransaction: indexedDbDelayMs
        ? async () => wait(indexedDbDelayMs)
        : undefined,
    }).then(async (durable) => {
      uiCount += 1
      await markScanReadyForSync(durable.id, {
        uiApplied: true,
        uiCommittedAt: Date.now(),
      })
    }))
    if (intervalMs) await wait(intervalMs)
  }

  const inFlightAfterDispatch = getScanDiagnostics().captureInFlight
  await Promise.all(captures)
  await drainScanQueue(async () => {
    serverCount += 1
    return { packed: serverCount, required: count }
  })
  const rows = await getScanHistory()
  const metrics = getScanDiagnostics()
  const result = {
    count,
    intervalMs,
    indexedDbDelayMs,
    physical: metrics.physicalScanCount,
    durable: metrics.localDurableCount,
    ui: uiCount,
    server: serverCount,
    terminalRows: rows.length,
    inFlightAfterDispatch,
    maxCaptureInFlight: metrics.maximumCaptureBacklog,
    captureP50Ms: metrics.captureLatencyMs.p50,
    captureP95Ms: metrics.captureLatencyMs.p95,
    captureP99Ms: metrics.captureLatencyMs.p99,
    serverAckP95Ms: metrics.serverAcknowledgementLatencyMs.p95,
  }
  console.log(Object.values(result).join(','))
}

console.log('count,intervalMs,indexedDbDelayMs,physical,durable,ui,server,terminalRows,inFlightAfterDispatch,maxCaptureInFlight,captureP50Ms,captureP95Ms,captureP99Ms,serverAckP95Ms')
const requestedCase = process.argv[2]?.split(',').map(Number)
if (requestedCase?.length === 3 && requestedCase.every(Number.isFinite)) {
  await runCase({
    count: requestedCase[0],
    intervalMs: requestedCase[1],
    indexedDbDelayMs: requestedCase[2],
  })
} else {
  for (const count of [10, 50, 100, 500]) {
    await runCase({ count })
  }
  for (const intervalMs of [5, 10, 20, 30, 50, 100]) {
    await runCase({ count: 100, intervalMs })
  }
  await runCase({ count: 100, indexedDbDelayMs: 100 })
}
