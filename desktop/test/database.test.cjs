const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../src/database.cjs');

function fixtureSnapshot() {
  return {
    consignment_id: 'c-1',
    internalShipmentNo: 'SHIP-1',
    marketplace: 'Amazon',
    skus: [{ id: 'sku-1', barcode: '8900001', marketplaceSku: 'MKT-1', internalSku: 'INT-1', required: 2, packed: 0, status: 'pending' }],
    boxes: {},
  };
}

test('snapshot, scan, and box close survive database reopen', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youthnic-packing-'));
  const dbPath = path.join(root, 'database', 'packing.sqlite');
  let db = openDatabase(dbPath, { stationName: 'Test Station' });
  db.saveSnapshot(fixtureSnapshot(), { userId: 'u-1' });
  assert.equal(db.getSnapshot('SHIP-1').consignment_id, 'c-1');
  db.openBox({ consignmentId: 'c-1', boxNo: '1' });
  const first = db.recordScan({ consignmentId: 'c-1', boxNo: '1', scanId: 'scan-1', barcode: '8900001', capturedAt: new Date().toISOString(), sequenceNo: 1 });
  assert.equal(first.ok, true);
  const replay = db.recordScan({ consignmentId: 'c-1', boxNo: '1', scanId: 'scan-1', barcode: '8900001' });
  assert.equal(replay.idempotentReplay, true);
  const closed = db.closeBox({
    consignmentId: 'c-1',
    boxNo: '1',
    operationId: 'station:c-1:1:op-1',
    items: [{ skuId: 'sku-1', barcode: '8900001', marketplaceSku: 'MKT-1', internalSku: 'INT-1', qty: 1 }],
    video: { videoId: 'video-1', localPath: path.join(root, 'video-1.webm'), sizeBytes: 10, sha256: 'hash', mimeType: 'video/webm' },
  });
  assert.equal(closed.localSafe, true);
  assert.equal(db.getFinishReadiness('c-1').ready, false);
  assert.equal(db.getStatus('c-1').pendingJobs, 2);
  db.close();

  db = openDatabase(dbPath, { stationName: 'Ignored Existing Station' });
  const snapshot = db.getSnapshot('c-1');
  assert.equal(snapshot.skus[0].packed, 1);
  assert.equal(snapshot.boxes['1'][0].qty, 1);
  assert.equal(db.getStatus('c-1').boxes[0].state, 'QUEUED');
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('invalid and over-limit scans are rejected locally without changing quantity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youthnic-packing-'));
  const db = openDatabase(path.join(root, 'packing.sqlite'));
  db.saveSnapshot({ ...fixtureSnapshot(), skus: [{ ...fixtureSnapshot().skus[0], required: 1 }] });
  db.openBox({ consignmentId: 'c-1', boxNo: '1' });
  assert.equal(db.recordScan({ consignmentId: 'c-1', boxNo: '1', scanId: 'bad', barcode: 'wrong' }).result, 'not_found');
  assert.equal(db.recordScan({ consignmentId: 'c-1', boxNo: '1', scanId: 'ok', barcode: '8900001' }).ok, true);
  assert.equal(db.recordScan({ consignmentId: 'c-1', boxNo: '1', scanId: 'too-many', barcode: '8900001' }).result, 'locked');
  assert.throws(
    () => db.closeBox({ consignmentId: 'c-1', boxNo: '1', operationId: 'over-limit-close', items: [{ skuId: 'sku-1', qty: 2 }] }),
    (error) => error.code === 'LOCAL_BOX_OVER_LIMIT',
  );
  assert.equal(db.getSnapshot('c-1').skus[0].packed, 1);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
