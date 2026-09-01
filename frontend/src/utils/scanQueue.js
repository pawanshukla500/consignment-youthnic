/**
 * Durable barcode outbox.
 *
 * Inventory rule: the scan identity and box context are created by the physical
 * event handler, before this module does any asynchronous work. Each capture
 * starts independently; only the server drain is serialized.
 */
const DB_NAME = 'PackingScanDB'
// Keep the existing database version so a frontend rollback can still open the
// outbox. The reliability changes only add fields to stored records; IndexedDB
// records are schema-less and do not require a version upgrade.
const DB_VERSION = 1
const STORE = 'scanQueue'
const MAX_RETRIES = 20
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const STATION_SESSION_KEY = 'packing.stationSessionId'
const STATION_SEQUENCE_PREFIX = 'packing.stationSequence.'
const IMMUTABLE_SCAN_FIELDS = [
  'id',
  'stationSessionId',
  'sequenceNo',
  'barcode',
  'qty',
  'consignmentId',
  'boxNo',
  'capturedAt',
  'scannerReceivedAt',
  'scanEnvelopeCreatedAt',
]

export const SCAN_STATUS = Object.freeze({
  LOCAL_CAPTURED: 'local_captured',
  SERVER_PENDING: 'server_pending',
  SERVER_CONFIRMED: 'server_confirmed',
  SERVER_REJECTED: 'server_rejected',
  LOCAL_FAILED: 'local_failed',
})

const OUTSTANDING_STATUSES = new Set([
  'pending',
  SCAN_STATUS.LOCAL_CAPTURED,
  SCAN_STATUS.SERVER_PENDING,
])
const TERMINAL_STATUSES = new Set([
  SCAN_STATUS.SERVER_CONFIRMED,
  SCAN_STATUS.SERVER_REJECTED,
])

let dbPromise = null
let draining = false
let drainAgain = false
let activeDrain = null
let fallbackStationSessionId = null
let fallbackSequenceNo = 0

const diagnosticListeners = new Set()
const diagnosticState = {
  physicalScanCount: 0,
  localDurableCount: 0,
  serverPendingCount: 0,
  serverConfirmedCount: 0,
  serverRejectedCount: 0,
  localFailedCount: 0,
  rejectedBeforePersistCount: 0,
  captureInFlight: 0,
  maximumCaptureBacklog: 0,
  localCaptureLatencies: [],
  serverAcknowledgementLatencies: [],
}

function percentile(values, value) {
  if (!values.length) return 0
  const ordered = [...values].sort((a, b) => a - b)
  const index = Math.min(ordered.length - 1, Math.ceil((value / 100) * ordered.length) - 1)
  return Number(ordered[index].toFixed(2))
}

function diagnosticSnapshot() {
  return {
    physicalScanCount: diagnosticState.physicalScanCount,
    localDurableCount: diagnosticState.localDurableCount,
    serverPendingCount: diagnosticState.serverPendingCount,
    serverConfirmedCount: diagnosticState.serverConfirmedCount,
    serverRejectedCount: diagnosticState.serverRejectedCount,
    localFailedCount: diagnosticState.localFailedCount,
    rejectedBeforePersistCount: diagnosticState.rejectedBeforePersistCount,
    captureInFlight: diagnosticState.captureInFlight,
    maximumCaptureBacklog: diagnosticState.maximumCaptureBacklog,
    captureLatencyMs: {
      p50: percentile(diagnosticState.localCaptureLatencies, 50),
      p95: percentile(diagnosticState.localCaptureLatencies, 95),
      p99: percentile(diagnosticState.localCaptureLatencies, 99),
    },
    serverAcknowledgementLatencyMs: {
      p50: percentile(diagnosticState.serverAcknowledgementLatencies, 50),
      p95: percentile(diagnosticState.serverAcknowledgementLatencies, 95),
      p99: percentile(diagnosticState.serverAcknowledgementLatencies, 99),
    },
  }
}

function notifyDiagnostics() {
  const snapshot = diagnosticSnapshot()
  diagnosticListeners.forEach((listener) => listener(snapshot))
}

function rememberLatency(target, latencyMs) {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) return
  target.push(latencyMs)
  if (target.length > 2000) target.splice(0, target.length - 2000)
}

export function subscribeScanDiagnostics(listener) {
  diagnosticListeners.add(listener)
  listener(diagnosticSnapshot())
  return () => diagnosticListeners.delete(listener)
}

export function getScanDiagnostics() {
  return diagnosticSnapshot()
}

/** Format current and legacy outbox timestamps without making old rows undrainable. */
export function getScannerReceivedAtIso(scan) {
  const candidates = [
    scan?.scannerReceivedAt,
    scan?.createdAt,
    scan?.capturedAt,
    scan?.scanEnvelopeCreatedAt,
  ]
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === '') continue
    const parsed = new Date(candidate)
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString()
  }
  return new Date().toISOString()
}

export function notePhysicalScan() {
  diagnosticState.physicalScanCount += 1
  notifyDiagnostics()
}

export function noteRejectedBeforePersist() {
  diagnosticState.rejectedBeforePersistCount += 1
  notifyDiagnostics()
}

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onerror = () => {
        dbPromise = null
        reject(req.error)
      }
      req.onsuccess = () => resolve(req.result)
      req.onupgradeneeded = (event) => {
        const db = event.target.result
        const store = db.objectStoreNames.contains(STORE)
          ? event.target.transaction.objectStore(STORE)
          : db.createObjectStore(STORE, { keyPath: 'id' })
        if (!store.indexNames.contains('status')) {
          store.createIndex('status', 'status', { unique: false })
        }
        if (!store.indexNames.contains('createdAt')) {
          store.createIndex('createdAt', 'createdAt', { unique: false })
        }
      }
    })
  }
  return dbPromise
}

/** Open IndexedDB before Zone 3 so the first physical event starts a transaction immediately. */
export function warmScanQueueDb() {
  return openDB().catch(() => null)
}

function randomId(prefix) {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return uuid
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

function getSessionStorage() {
  try {
    return globalThis.sessionStorage || null
  } catch {
    return null
  }
}

export function getOrCreateStationSessionId() {
  const storage = getSessionStorage()
  const existing = storage?.getItem(STATION_SESSION_KEY)
  if (existing) return existing
  if (!fallbackStationSessionId) fallbackStationSessionId = randomId('station')
  const id = fallbackStationSessionId
  try {
    storage?.setItem(STATION_SESSION_KEY, id)
  } catch {
    // A unique in-memory session still preserves scan identity if storage is blocked.
  }
  return id
}

function nextStationSequenceNo(stationSessionId) {
  const storage = getSessionStorage()
  const key = `${STATION_SEQUENCE_PREFIX}${stationSessionId}`
  if (storage) {
    try {
      const next = (Number(storage.getItem(key)) || 0) + 1
      storage.setItem(key, String(next))
      return next
    } catch {
      // Fall through to the process-local counter.
    }
  }
  fallbackSequenceNo += 1
  return fallbackSequenceNo
}

/** Create the immutable identity at physical-event time, before any Promise or IndexedDB work. */
export function createScanEnvelope({
  barcode,
  consignmentId,
  boxNo,
  qty = 1,
  id,
  stationSessionId,
  sequenceNo,
  capturedAt,
  scannerReceivedAt,
  skuId = null,
  marketplaceSku = null,
  internalSku = null,
}) {
  const createdAt = Date.now()
  const sessionId = stationSessionId || getOrCreateStationSessionId()
  const envelope = {
    id: id || randomId('scan'),
    stationSessionId: sessionId,
    sequenceNo: Number(sequenceNo) || nextStationSequenceNo(sessionId),
    barcode: String(barcode || '').trim(),
    qty: Number(qty) || 1,
    consignmentId: String(consignmentId || '').trim(),
    boxNo: String(boxNo || '').trim(),
    capturedAt: capturedAt || new Date(createdAt).toISOString(),
    scannerReceivedAt: Number(scannerReceivedAt) || createdAt,
    scanEnvelopeCreatedAt: createdAt,
    skuId,
    marketplaceSku,
    internalSku,
  }
  return Object.freeze(envelope)
}

function validateEnvelope(envelope) {
  if (!envelope?.id) throw new Error('ScanEnvelope.id must be created before durable capture')
  if (!envelope.stationSessionId) throw new Error('ScanEnvelope.stationSessionId is required')
  if (!Number.isInteger(envelope.sequenceNo) || envelope.sequenceNo <= 0) {
    throw new Error('ScanEnvelope.sequenceNo must be a positive integer')
  }
  if (!envelope.barcode || !envelope.consignmentId || !envelope.boxNo) {
    throw new Error('ScanEnvelope barcode, consignmentId, and boxNo are required')
  }
  if (!Object.isFrozen(envelope)) {
    throw new Error('ScanEnvelope must be immutable before durable capture')
  }
}

function mergeLifecycleFields(scan, fields) {
  const next = { ...scan, ...fields }
  IMMUTABLE_SCAN_FIELDS.forEach((field) => { next[field] = scan[field] })
  return next
}

function runTransaction(db, mode, operation) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    let result
    tx.oncomplete = () => resolve(result)
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'))
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'))
    result = operation(tx.objectStore(STORE), tx)
  })
}

/**
 * Persist one already-created envelope. Calls are intentionally not serialized
 * in JavaScript; IndexedDB owns transaction scheduling.
 */
export async function captureScan(scanEnvelope, options = {}) {
  validateEnvelope(scanEnvelope)
  diagnosticState.captureInFlight += 1
  diagnosticState.maximumCaptureBacklog = Math.max(
    diagnosticState.maximumCaptureBacklog,
    diagnosticState.captureInFlight
  )
  notifyDiagnostics()

  try {
    const db = await openDB()
    if (typeof options.beforeTransaction === 'function') {
      await options.beforeTransaction(scanEnvelope)
    }
    const indexedDbStartAt = Date.now()
    const entry = {
      ...scanEnvelope,
      status: SCAN_STATUS.LOCAL_CAPTURED,
      readyForSync: false,
      retries: 0,
      createdAt: scanEnvelope.scanEnvelopeCreatedAt,
      indexedDbStartAt,
      updatedAt: indexedDbStartAt,
    }
    await runTransaction(db, 'readwrite', (store) => store.add(entry))
    const indexedDbCommittedAt = Date.now()
    diagnosticState.localDurableCount += 1
    rememberLatency(
      diagnosticState.localCaptureLatencies,
      indexedDbCommittedAt - scanEnvelope.scannerReceivedAt
    )
    return { ...entry, indexedDbCommittedAt }
  } catch (error) {
    diagnosticState.localFailedCount += 1
    throw error
  } finally {
    diagnosticState.captureInFlight = Math.max(0, diagnosticState.captureInFlight - 1)
    notifyDiagnostics()
  }
}

/** Compatibility name; callers must pass an already-created ScanEnvelope. */
export function enqueueScan(scanEnvelope, options) {
  return captureScan(scanEnvelope, options)
}

async function getAllScans() {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).getAll()
    req.onsuccess = () => resolve(req.result || [])
    req.onerror = () => reject(req.error)
  })
}

export async function getScanHistory() {
  return (await getAllScans()).sort(compareScans)
}

function compareScans(a, b) {
  const createdDiff = (Number(a.scanEnvelopeCreatedAt || a.createdAt) || 0)
    - (Number(b.scanEnvelopeCreatedAt || b.createdAt) || 0)
  if (createdDiff) return createdDiff
  const sequenceDiff = (Number(a.sequenceNo) || 0) - (Number(b.sequenceNo) || 0)
  if (sequenceDiff) return sequenceDiff
  return String(a.id).localeCompare(String(b.id))
}

export async function getOutstandingScans() {
  return (await getAllScans())
    .filter((scan) => OUTSTANDING_STATUSES.has(scan.status))
    .sort(compareScans)
}

/** Only admitted scans are eligible for server mutation. */
export async function getPendingScans() {
  return (await getOutstandingScans()).filter((scan) => scan.readyForSync !== false)
}

async function getScan(id) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(id)
    req.onsuccess = () => resolve(req.result || null)
    req.onerror = () => reject(req.error)
  })
}

async function updateScan(entry, options = {}) {
  const db = await openDB()
  if (typeof options.beforeTransaction === 'function') {
    await options.beforeTransaction(entry)
  }
  await runTransaction(db, 'readwrite', (store) => store.put(entry))
  return entry
}

export async function markScanReadyForSync(id, fields = {}, options = {}) {
  const scan = await getScan(id)
  if (!scan || TERMINAL_STATUSES.has(scan.status)) return scan
  return updateScan(mergeLifecycleFields(scan, {
    ...fields,
    status: SCAN_STATUS.LOCAL_CAPTURED,
    readyForSync: true,
    updatedAt: Date.now(),
  }), options)
}

export async function markScanRejectedLocally(id, rejection = {}) {
  const scan = await getScan(id)
  if (!scan) return null
  const terminalAt = Date.now()
  const next = {
    ...scan,
    status: SCAN_STATUS.SERVER_REJECTED,
    readyForSync: false,
    terminalAt,
    updatedAt: terminalAt,
    rejection: {
      source: 'local',
      reason: rejection.reason || 'rejected',
      message: rejection.message || 'Scan rejected',
    },
  }
  await updateScan(next)
  diagnosticState.serverRejectedCount += 1
  notifyDiagnostics()
  return next
}

/**
 * If the page refreshed after the first durable commit but before UI admission,
 * let the idempotent server make the authoritative decision using the same ID.
 */
export async function recoverUnadmittedScans() {
  const scans = (await getOutstandingScans()).filter((scan) => scan.readyForSync === false)
  await Promise.all(scans.map((scan) => recoverUnadmittedScan(scan.id)))
  return scans.length
}

/** Recover exactly one durable row without admitting newer in-flight scans. */
export async function recoverUnadmittedScan(id, fields = {}) {
  const scan = await getScan(id)
  if (!scan || TERMINAL_STATUSES.has(scan.status) || scan.readyForSync !== false) return scan
  return updateScan(mergeLifecycleFields(scan, {
    ...fields,
    status: SCAN_STATUS.LOCAL_CAPTURED,
    readyForSync: true,
    recoveredAfterRefresh: true,
    updatedAt: Date.now(),
  }))
}

function backoffMs(retries) {
  return Math.min(8000, 400 * Math.pow(1.6, retries))
}

function isTerminalRejection(result) {
  return Boolean(result?.not_found || result?.over_limit || result?.locked || result?.error)
}

async function markServerTerminal(scan, status, fields = {}) {
  const terminalAt = Date.now()
  const next = {
    ...scan,
    ...fields,
    status,
    readyForSync: false,
    terminalAt,
    updatedAt: terminalAt,
  }
  await updateScan(next)
  if (scan.apiStartedAt) {
    rememberLatency(diagnosticState.serverAcknowledgementLatencies, terminalAt - scan.apiStartedAt)
  }
  return next
}

async function processOneScan(scan, sendScan, onResult) {
  const apiStartedAt = Date.now()
  const sending = await updateScan({
    ...scan,
    status: SCAN_STATUS.SERVER_PENDING,
    readyForSync: true,
    apiStartedAt,
    updatedAt: apiStartedAt,
  })
  diagnosticState.serverPendingCount += 1
  notifyDiagnostics()

  try {
    const result = await sendScan(sending)
    if (result?.retry) {
      throw Object.assign(new Error(result.error || 'Scan persist failed'), { retry: true })
    }
    if (isTerminalRejection(result)) {
      const rejected = await markServerTerminal(sending, SCAN_STATUS.SERVER_REJECTED, {
        apiConfirmedAt: Date.now(),
        rejection: {
          source: 'server',
          reason: result.not_found ? 'not_found' : result.locked ? 'locked' : result.over_limit ? 'over_limit' : 'error',
          message: result.message || result.error || 'Scan rejected',
        },
      })
      diagnosticState.serverRejectedCount += 1
      onResult?.(rejected, result, null)
      return { ok: false, offline: false, terminal: true }
    }
    const confirmed = await markServerTerminal(sending, SCAN_STATUS.SERVER_CONFIRMED, {
      apiConfirmedAt: Date.now(),
      serverResult: result || {},
    })
    diagnosticState.serverConfirmedCount += 1
    onResult?.(confirmed, result, null)
    return { ok: true, offline: false, terminal: true }
  } catch (error) {
    const responseStatus = Number(error?.response?.status) || 0
    const responseData = error?.response?.data
    if (responseStatus >= 400 && responseStatus < 500 && ![408, 429].includes(responseStatus) && !responseData?.retry) {
      const result = responseData || { error: error.message || 'Scan rejected' }
      const rejected = await markServerTerminal(sending, SCAN_STATUS.SERVER_REJECTED, {
        apiConfirmedAt: Date.now(),
        rejection: {
          source: 'server',
          reason: result.code || 'request_rejected',
          message: result.error || result.message || error.message,
        },
      })
      diagnosticState.serverRejectedCount += 1
      onResult?.(rejected, result, null)
      return { ok: false, offline: false, terminal: true }
    }

    const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false
    const isNetwork = isOffline || /network error|timeout|failed to fetch/i.test(error?.message || '')
    const retries = isNetwork ? (sending.retries || 0) : (sending.retries || 0) + 1
    if (retries >= MAX_RETRIES) {
      const failed = await updateScan({
        ...sending,
        status: SCAN_STATUS.LOCAL_FAILED,
        readyForSync: false,
        retries,
        lastError: error?.message || 'Scan sync failed',
        updatedAt: Date.now(),
      })
      diagnosticState.localFailedCount += 1
      onResult?.(failed, null, error)
      return { ok: false, offline: false, terminal: false }
    }

    await updateScan({
      ...sending,
      status: SCAN_STATUS.LOCAL_CAPTURED,
      readyForSync: true,
      retries,
      lastError: error?.message || null,
      updatedAt: Date.now(),
    })
    if (isOffline) return { ok: false, offline: true, terminal: false }
    if (!isNetwork) await new Promise((resolve) => setTimeout(resolve, backoffMs(retries)))
    return { ok: false, offline: isNetwork, terminal: false }
  } finally {
    diagnosticState.serverPendingCount = Math.max(0, diagnosticState.serverPendingCount - 1)
    notifyDiagnostics()
  }
}

/** Serialized, idempotent server drain. It never blocks captureScan(). */
export async function drainScanQueue(sendScan, onResult) {
  if (draining) {
    drainAgain = true
    return activeDrain
  }

  draining = true
  activeDrain = (async () => {
    try {
      do {
        drainAgain = false
        let pending = await getPendingScans()
        let brokeOffline = false
        while (pending.length > 0) {
          for (const scan of pending) {
            const { offline } = await processOneScan(scan, sendScan, onResult) || {}
            if (offline) {
              brokeOffline = true
              break
            }
          }
          if (brokeOffline) break
          pending = await getPendingScans()
        }
        if (brokeOffline) break
      } while (drainAgain)
    } finally {
      draining = false
      activeDrain = null
    }
    return { done: true }
  })()

  return activeDrain
}

export function kickScanDrain(sendScan, onResult) {
  void drainScanQueue(sendScan, onResult)
}

export async function getPendingScanCountForConsignment(consignmentId) {
  if (!consignmentId) return 0
  return (await getOutstandingScans()).filter((scan) => scan.consignmentId === consignmentId).length
}

export async function getPendingScanCount() {
  return (await getOutstandingScans()).length
}

export async function getFailedScanCount() {
  return (await getAllScans()).filter(
    (scan) => scan.status === 'failed' || scan.status === SCAN_STATUS.LOCAL_FAILED
  ).length
}

export async function resetFailedScans() {
  const failed = (await getAllScans()).filter(
    (scan) => scan.status === 'failed' || scan.status === SCAN_STATUS.LOCAL_FAILED
  )
  await Promise.all(failed.map((scan) => updateScan({
    ...scan,
    status: SCAN_STATUS.LOCAL_CAPTURED,
    readyForSync: true,
    retries: 0,
    updatedAt: Date.now(),
  })))
  return failed.length
}

export async function clearFailedScans() {
  const failed = (await getAllScans()).filter(
    (scan) => scan.status === 'failed' || scan.status === SCAN_STATUS.LOCAL_FAILED
  )
  const db = await openDB()
  await runTransaction(db, 'readwrite', (store) => {
    failed.forEach((scan) => store.delete(scan.id))
  })
  return failed.length
}

export async function pruneTerminalScans({ olderThanMs = TERMINAL_RETENTION_MS, maxTerminal = 10000 } = {}) {
  const cutoff = Date.now() - olderThanMs
  const terminal = (await getAllScans())
    .filter((scan) => TERMINAL_STATUSES.has(scan.status))
    .sort(compareScans)
  const overflow = Math.max(0, terminal.length - maxTerminal)
  const victims = terminal.filter((scan, index) => index < overflow || (Number(scan.terminalAt) || 0) < cutoff)
  if (!victims.length) return 0
  const db = await openDB()
  await runTransaction(db, 'readwrite', (store) => {
    victims.forEach((scan) => store.delete(scan.id))
  })
  return victims.length
}

export async function clearAllScans() {
  const db = await openDB()
  await runTransaction(db, 'readwrite', (store) => store.clear())
  return true
}

/** Test-only runtime reset; persistent rows are intentionally left untouched. */
export function resetScanDiagnosticsForTests() {
  Object.assign(diagnosticState, {
    physicalScanCount: 0,
    localDurableCount: 0,
    serverPendingCount: 0,
    serverConfirmedCount: 0,
    serverRejectedCount: 0,
    localFailedCount: 0,
    rejectedBeforePersistCount: 0,
    captureInFlight: 0,
    maximumCaptureBacklog: 0,
    localCaptureLatencies: [],
    serverAcknowledgementLatencies: [],
  })
  notifyDiagnostics()
}
