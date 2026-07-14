/**
 * Unit tests for packing durability / draft slim / rollback contracts.
 * Run: node scripts/test-packing-stability.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const packingSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'packing.js'), 'utf8');
const draftSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'packingDraft.js'), 'utf8');
const packingStationSrc = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', 'PackingStation.jsx'),
  'utf8'
);
const workerSrc = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', 'workers', 'videoUpload.worker.js'),
  'utf8'
);
const videoServiceSrc = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', 'services', 'videoUploadService.js'),
  'utf8'
);

assert.ok(packingSrc.includes('prevSkuPacked'), 'accepted scan must snapshot pre-mutation state');
assert.ok(packingSrc.includes('session.boxes[box_no] = prevBoxItems'), 'persist failure must roll back box items');
assert.ok(!/void emitPackingProgress\(consignment_id, session, 'packing_scan'\)/.test(packingSrc),
  'must not emit packing_scan progress on every increment');
assert.ok(!draftSrc.includes('scanResults: session.scanResults'), 'drafts must not persist full scanResults');
assert.ok(packingStationSrc.includes('start(1000)'), 'MediaRecorder must use 1s timeslice');
assert.ok(packingStationSrc.includes('pagehide'), 'must flush recording on pagehide');
assert.ok(packingStationSrc.includes('getPendingVideos'), 'finish must wait for local video queue');
assert.ok(workerSrc.includes('/boxes/box_'), 'worker must use canonical boxes/box_ path');
assert.ok(!workerSrc.includes('/videos/${metadata.boxNo}/'), 'worker must not use legacy videos/{boxNo} path');
assert.ok(videoServiceSrc.includes('removeEventListener'), 'video service must remove listeners on stop');

const { rebuildSessionSkuTotalsFromBoxes } = require('../utils/packingQuantities');

// Simulate persist-failure rollback semantics
const session = {
  skus: [{ id: 's1', packed: 0, required: 10, remaining: 10, status: 'pending' }],
  boxes: {},
};
const sku = session.skus[0];
const boxNo = '1';
const qty = 1;
const prevSkuPacked = sku.packed;
const prevSkuRemaining = sku.remaining;
const prevSkuStatus = sku.status;
const prevBoxItems = (session.boxes[boxNo] || []).map((i) => ({ ...i }));

sku.packed += qty;
sku.remaining = sku.required - sku.packed;
session.boxes[boxNo] = [{ skuId: 's1', qty: 1 }];
rebuildSessionSkuTotalsFromBoxes(session);
assert.strictEqual(sku.packed, 1);

// rollback (as catch path does)
sku.packed = prevSkuPacked;
sku.remaining = prevSkuRemaining;
sku.status = prevSkuStatus;
session.boxes[boxNo] = prevBoxItems;
rebuildSessionSkuTotalsFromBoxes(session);
assert.strictEqual(sku.packed, 0);
assert.deepStrictEqual(session.boxes[boxNo], []);

console.log('Packing stability contract tests passed.');
