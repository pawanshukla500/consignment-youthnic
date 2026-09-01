const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-packing-scan-secret';
process.env.NODE_ENV = 'test';

const relationalEvents = new Map();
const documents = new Map();

const fakeClient = {
  async query(sql, params = []) {
    const normalized = String(sql).replace(/\s+/g, ' ').trim();
    if (normalized.startsWith('INSERT INTO scan_events')) {
      const id = params[0];
      if (relationalEvents.has(id)) return { rowCount: 0, rows: [] };
      relationalEvents.set(id, {
        id,
        consignmentId: params[1],
        boxNo: params[2],
        barcode: params[4],
        qtyDelta: params[7],
        sequenceNo: params[12],
        scannerReceivedAt: params[13],
        payload: JSON.parse(params[14]),
      });
      return { rowCount: 1, rows: [{ id }] };
    }
    if (normalized.startsWith('INSERT INTO documents')) {
      const key = `${params[0]}::${params[1]}`;
      const incoming = JSON.parse(params[2]);
      const saved = { ...(documents.get(key) || {}), ...incoming };
      documents.set(key, saved);
      return { rowCount: 1, rows: [{ data: saved }] };
    }
    if (normalized.startsWith('SELECT data FROM documents') && normalized.includes('id = ANY')) {
      const ids = new Set(params[1] || []);
      const rows = [...documents.entries()]
        .filter(([key]) => key.startsWith(`${params[0]}::`))
        .map(([, data]) => data)
        .filter((data) => ids.has(data.id))
        .map((data) => ({ data }));
      return { rowCount: rows.length, rows };
    }
    if (normalized.startsWith('SELECT data FROM documents') && normalized.includes('data->>$2 = $3')) {
      const rows = [...documents.entries()]
        .filter(([key]) => key.startsWith(`${params[0]}::`))
        .map(([, data]) => data)
        .filter((data) => String(data[params[1]]) === String(params[2]))
        .map((data) => ({ data }));
      return { rowCount: rows.length, rows };
    }
    if (normalized.startsWith('SELECT data FROM documents')) {
      const saved = documents.get(`${params[0]}::${params[1]}`);
      return { rowCount: saved ? 1 : 0, rows: saved ? [{ data: saved }] : [] };
    }
    if (normalized.includes('FROM scan_events WHERE id = $1')) {
      const saved = relationalEvents.get(params[0]);
      return {
        rowCount: saved ? 1 : 0,
        rows: saved ? [{
          id: saved.id,
          consignment_id: saved.consignmentId,
          box_no: saved.boxNo,
          barcode: saved.barcode,
          qty_delta: saved.qtyDelta,
          payload: saved.payload,
        }] : [],
      };
    }
    throw new Error(`Unexpected fake SQL: ${normalized.slice(0, 80)}`);
  },
};

const databasePath = require.resolve('../config/database');
require.cache[databasePath] = {
  id: databasePath,
  filename: databasePath,
  loaded: true,
  exports: {
    pgEnabled: () => true,
    getPool: () => ({ query: (...args) => fakeClient.query(...args) }),
  },
};

const packingRouter = require('../routes/packing');
const {
  acquireIncrementLock,
  assertDurableScanLedgerAvailable,
  assertStoredScanMatches,
  getStoredScanPayload,
  getIdempotentReplayPayload,
  resolvePackingMutationKey,
  restorePackingSession,
  snapshotPackingSession,
  synchronizeSessionFromDurableDraft,
  writeScanEvent,
} = packingRouter.__packingScanTest;

const request = {
  body: {
    station_id: 'station-test',
    client_created_at: new Date().toISOString(),
    sequence_no: 7,
    scanner_received_at: '2026-09-01T12:00:00.000Z',
  },
  headers: {},
  user: { id: 'user-test' },
};
const sku = {
  id: 'sku-1',
  marketplaceBarcode: 'SKU-1',
  marketplaceSku: 'SKU-1',
  internalSku: 'SKU-1',
};

function clearDurableLedger() {
  relationalEvents.clear();
  documents.clear();
}

function createProcessor(initialQuantity = 0) {
  let quantity = initialQuantity;
  return {
    get quantity() { return quantity; },
    async process({ scanId, required, qty = 1 }) {
      const release = await acquireIncrementLock('consignment-1');
      try {
        const stored = await getStoredScanPayload(scanId, { client: fakeClient });
        if (stored) return stored;

        const previous = quantity;
        let payload;
        if (qty > 0 && quantity + qty > required) {
          payload = { scan_id: scanId, over_limit: true, accepted: false, packed: quantity, required };
        } else if (qty < 0 && quantity + qty < 0) {
          payload = { scan_id: scanId, error: 'Nothing remains to remove', accepted: false, packed: quantity, required };
        } else {
          quantity += qty;
          payload = { scan_id: scanId, accepted: true, packed: quantity, required };
        }

        try {
          await writeScanEvent({
            consignmentId: 'consignment-1',
            boxNo: '3',
            sku,
            barcode: 'SKU-1',
            qty,
            result: payload.accepted ? (qty < 0 ? 'decrement' : 'accepted') : 'over_limit',
            req: request,
            scanId,
            payload,
            client: fakeClient,
          });
        } catch (error) {
          quantity = previous;
          if (error.code === 'SCAN_ALREADY_PROCESSED') {
            return getStoredScanPayload(scanId, { client: fakeClient });
          }
          throw error;
        }
        return payload;
      } finally {
        release();
      }
    },
  };
}

async function main() {
  let unsafeMutations = 0;
  const withoutLedger = await Promise.allSettled(Array.from({ length: 10 }, async () => {
    assertDurableScanLedgerAvailable('same-id', false);
    unsafeMutations += 1;
  }));
  assert.strictEqual(unsafeMutations, 0, 'no quantity mutation may run without PostgreSQL idempotency');
  assert.ok(withoutLedger.every((result) => (
    result.status === 'rejected'
    && result.reason.code === 'DURABLE_SCAN_LEDGER_UNAVAILABLE'
    && result.reason.retryable === true
  )));
  assert.throws(
    () => assertDurableScanLedgerAvailable('', true),
    (error) => error.code === 'SCAN_ID_REQUIRED'
  );

  clearDurableLedger();
  documents.set('scan_events::document-only', {
    id: 'document-only',
    consignmentId: 'consignment-1',
    boxNo: '3',
    qtyDelta: 1,
    payload: { scan_id: 'document-only', packed: 99 },
  });
  assert.strictEqual(
    await getStoredScanPayload('document-only', { client: fakeClient }),
    null,
    'a document-only mirror row must not authorize idempotent replay'
  );
  documents.delete('scan_events::document-only');

  const duplicateProcessor = createProcessor(0);
  const duplicateResults = await Promise.all(
    Array.from({ length: 10 }, () => duplicateProcessor.process({ scanId: 'same-id', required: 10 }))
  );
  assert.strictEqual(duplicateProcessor.quantity, 1, 'same scan_id must mutate quantity once');
  assert.strictEqual(relationalEvents.size, 1, 'database primary key must store one scan event');
  assert.ok(duplicateResults.every((result) => result.packed === 1));
  assert.strictEqual(relationalEvents.get('same-id').sequenceNo, 7);
  assert.strictEqual(
    relationalEvents.get('same-id').scannerReceivedAt,
    '2026-09-01T12:00:00.000Z',
    'normalized scan ledger must retain scanner timing metadata'
  );

  // Simulated backend restart: the process cache is gone, but the durable event remains.
  const restartedProcessor = createProcessor(1);
  const afterRestart = await restartedProcessor.process({ scanId: 'same-id', required: 10 });
  assert.strictEqual(restartedProcessor.quantity, 1, 'retry after restart must not mutate quantity');
  assert.strictEqual(afterRestart.scan_id, 'same-id');

  const duplicateRequest = {
    ...request,
    body: { ...request.body, barcode: 'SKU-1' },
  };
  await assert.rejects(
    () => writeScanEvent({
      consignmentId: 'consignment-1',
      boxNo: '3',
      sku,
      barcode: 'SKU-1',
      qty: 1,
      result: 'accepted',
      req: duplicateRequest,
      scanId: 'same-id',
      payload: { scan_id: 'same-id', packed: 999 },
      client: fakeClient,
    }),
    (error) => (
      error.code === 'SCAN_ALREADY_PROCESSED'
      && error.storedPayload?.scan_id === 'same-id'
      && error.storedPayload?.packed === 1
    )
  );
  assert.throws(
    () => assertStoredScanMatches(
      { consignmentId: 'consignment-1', boxNo: '3', qtyDelta: 1, receivedBarcode: 'SKU-1' },
      { consignmentId: 'other-consignment', boxNo: '3', qtyDelta: 1, receivedBarcode: 'SKU-1' }
    ),
    (error) => error.code === 'SCAN_ID_PAYLOAD_MISMATCH'
  );
  const replay = await getIdempotentReplayPayload('same-id', {
    consignmentId: 'consignment-1',
    boxNo: '3',
    qtyDelta: 1,
    receivedBarcode: 'SKU-1',
  }, { client: fakeClient });
  assert.strictEqual(replay.packed, 1, 'final conflict must return the first durable payload');

  clearDurableLedger();
  const exactProcessor = createProcessor(0);
  const exact = await Promise.all(
    Array.from({ length: 50 }, (_, index) => exactProcessor.process({ scanId: `exact-${index}`, required: 50 }))
  );
  assert.strictEqual(exactProcessor.quantity, 50);
  assert.strictEqual(exact.filter((result) => result.accepted).length, 50);

  clearDurableLedger();
  const cappedProcessor = createProcessor(0);
  const capped = await Promise.all(
    Array.from({ length: 50 }, (_, index) => cappedProcessor.process({ scanId: `cap-${index}`, required: 40 }))
  );
  assert.strictEqual(cappedProcessor.quantity, 40, '41st quantity must never be accepted');
  assert.strictEqual(capped.filter((result) => result.accepted).length, 40);
  assert.strictEqual(capped.filter((result) => result.over_limit).length, 10);
  assert.strictEqual(relationalEvents.size, 50, 'accepted and rejected outcomes must both be durable');

  clearDurableLedger();
  const removalProcessor = createProcessor(10);
  await Promise.all(
    Array.from({ length: 10 }, () => removalProcessor.process({ scanId: 'remove-once', required: 10, qty: -1 }))
  );
  assert.strictEqual(removalProcessor.quantity, 9, 'duplicate removal must remove exactly once');

  const canonicalResolver = async (identifier) => ({
    id: identifier === 'SHIPMENT-ALIAS' ? 'consignment-1' : identifier,
  });
  const [aliasKey, canonicalKey] = await Promise.all([
    resolvePackingMutationKey('SHIPMENT-ALIAS', canonicalResolver),
    resolvePackingMutationKey('consignment-1', canonicalResolver),
  ]);
  assert.strictEqual(aliasKey, canonicalKey,
    'alias and canonical requests must serialize on the same lock key');

  const rollbackSession = {
    boxes: { 3: [{ skuId: 'sku-1', qty: 1 }] },
    skus: [{ ...sku, required: 10, packed: 1, remaining: 9, status: 'pending' }],
    processedScanIds: ['before'],
    scanResults: { before: { packed: 1 } },
    skuMap: {},
    status: 'active',
    currentBox: '3',
  };
  const rollbackSnapshot = snapshotPackingSession(rollbackSession);
  rollbackSession.boxes['3'][0].qty = 2;
  rollbackSession.skus[0].packed = 2;
  rollbackSession.processedScanIds.push('uncommitted');
  restorePackingSession(rollbackSession, rollbackSnapshot);
  assert.strictEqual(rollbackSession.boxes['3'][0].qty, 1,
    'database rollback must also restore the in-memory box');
  assert.strictEqual(rollbackSession.skus[0].packed, 1,
    'database rollback must also restore in-memory SKU totals');
  assert.deepStrictEqual(rollbackSession.processedScanIds, ['before'],
    'an uncommitted scan ID must not remain cached after rollback');

  documents.set('consignments::consignment-1', {
    id: 'consignment-1',
    skuIds: ['sku-1'],
  });
  documents.set('skus::sku-1', {
    id: 'sku-1',
    marketplaceBarcode: 'SKU-1',
    marketplaceSku: 'SKU-1',
    internalSku: 'SKU-1',
    requiredQty: 5,
    packedQty: 0,
  });
  documents.set('packing_drafts::consignment-1', {
    id: 'consignment-1',
    consignmentId: 'consignment-1',
    boxes: { 3: [{ skuId: 'sku-1', qty: 2 }] },
    processedScanIds: ['draft-scan'],
    status: 'active',
    currentBox: '3',
  });
  const synchronized = await synchronizeSessionFromDurableDraft('consignment-1', fakeClient);
  assert.strictEqual(synchronized.skus[0].required, 5,
    'locked refresh must reload current SKU requirements from durable documents');
  assert.strictEqual(synchronized.skus[0].packed, 2,
    'locked refresh must rebuild quantities from the latest durable draft');
  assert.deepStrictEqual(synchronized.processedScanIds, ['draft-scan']);
  assert.strictEqual(synchronized.currentBox, '3');

  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'packing.js'), 'utf8');
  assert.ok(source.includes('acquireTxSerializationLock(client, `packing:${consignmentId}`)'),
    'cross-instance transaction lock must wrap scan processing');
  assert.ok(source.indexOf("await client.query('COMMIT')") < source.indexOf('return res.status(deferred.statusCode).json'),
    'HTTP success must only be sent after database commit');
  assert.ok(source.includes('ON CONFLICT (id) DO NOTHING'),
    'scan_events primary key must be the final duplicate gate');
  assert.ok(source.includes('synchronizeSessionFromDurableDraft'),
    'each locked mutation must refresh the latest durable draft');
  assert.ok(source.includes('restorePackingSession(session, sessionSnapshot)'),
    'database rollback must restore volatile session state');
  assert.ok(source.includes('req.body.consignment_id = consignmentId'),
    'handlers must mutate the canonical consignment session protected by the lock');

  const migration = fs.readFileSync(
    path.join(__dirname, '..', '..', 'supabase', 'migrations', '20260901124619_add_scan_event_capture_metadata.sql'),
    'utf8'
  );
  assert.ok(migration.includes('sequence_no BIGINT'));
  assert.ok(migration.includes('scanner_received_at TIMESTAMPTZ'));

  const dataConnectSchema = fs.readFileSync(
    path.join(__dirname, '..', '..', 'dataconnect', 'schema', 'schema.gql'),
    'utf8'
  );
  assert.ok(dataConnectSchema.includes('sequenceNo: Int64'));
  assert.ok(dataConnectSchema.includes('scannerReceivedAt: Timestamp'));

  console.log('Packing scan idempotency/concurrency tests passed.');
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
