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
assert.ok(
  packingStationSrc.includes('processVideoUploadQueue')
    && packingStationSrc.includes('requireUploaded: true')
    && packingStationSrc.includes('getOutstandingVideos'),
  'finish must await upload drain + outstanding local videos'
);
assert.ok(
  videoServiceSrc.includes('createDrainWaiterRegistry')
    || videoServiceSrc.includes('drainWaiters')
    || videoServiceSrc.includes('settleDrain'),
  'video service must use structured drain waiters'
);
assert.ok(videoServiceSrc.includes('resolve'), 'drain waiter must store resolve');
assert.ok(videoServiceSrc.includes('reject'), 'drain waiter must store reject');
assert.ok(!/pendingDrain\.set\([^,]+,\s*\(/.test(videoServiceSrc), 'must not store drain waiter as bare callback');
assert.ok(workerSrc.includes('/boxes/box_'), 'worker must use canonical boxes/box_ path');
assert.ok(!workerSrc.includes('/videos/${metadata.boxNo}/'), 'worker must not use legacy videos/{boxNo} path');
assert.ok(!/finally\s*\{[\s\S]*return\s+status/.test(workerSrc), 'worker must not return from finally');
assert.ok(workerSrc.includes('uploadedIds'), 'worker drain response must include uploadedIds');
assert.ok(packingStationSrc.includes('inspectChunkWriteSettlements'), 'must inspect IndexedDB chunk write settlements');
assert.ok(packingStationSrc.includes('storage_failed') || packingStationSrc.includes('STORAGE_FAILED'), 'must surface storage_failed');
assert.ok(videoServiceSrc.includes('removeEventListener'), 'video service must remove listeners on stop');

// Continuous packing / large-video reliability contracts
const videoConfigSrc = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', 'utils', 'videoUploadConfig.js'),
  'utf8'
);
const videoQueueSrc = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', 'utils', 'videoQueue.js'),
  'utf8'
);
const uploadsSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'uploads.js'), 'utf8');
const storageSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'storage.js'), 'utf8');

assert.ok(videoConfigSrc.includes('maxConcurrentUploads'), 'must configure concurrent video uploads');
assert.ok(videoConfigSrc.includes('maxVideoBytes'), 'must configure 200MB video ceiling');
assert.ok(workerSrc.includes('VIDEO_UPLOAD_CONFIG') || workerSrc.includes('maxConcurrentUploads'), 'worker must use upload config');
assert.ok(workerSrc.includes('list-parts') || workerSrc.includes('saveMultipartProgress'), 'worker must support multipart resume');
assert.ok(workerSrc.includes('verifying') || workerSrc.includes('VERIFYING'), 'worker must emit verifying status');
assert.ok(workerSrc.includes('markVideoUploaded(entry.id, { verified: true })')
  || workerSrc.includes('verified: true'), 'local delete only after verification');
assert.ok(videoQueueSrc.includes('verified') && videoQueueSrc.includes('VERIFY_REQUIRED'), 'queue must refuse unverified deletes');
assert.ok(packingStationSrc.includes('requireUploaded: false'), 'next box must not wait on cloud upload');
assert.ok(packingStationSrc.includes('requireUploaded: true'), 'finish must wait for uploads');
assert.ok(packingStationSrc.includes('boxVideoStatuses') || packingStationSrc.includes('Box videos'), 'UI must show per-box upload statuses');
assert.ok(uploadsSrc.includes('list-parts') || uploadsSrc.includes('listMultipartParts'), 'API must list multipart parts for resume');
assert.ok(storageSrc.includes('ListPartsCommand') || storageSrc.includes('listMultipartParts'), 'storage must implement ListParts');
assert.ok(uploadsSrc.includes('verifying'), 'video-status API must accept verifying');
assert.ok(videoQueueSrc.includes('SUPERSEDED') || videoQueueSrc.includes('superseded'), 'must supersede not auto-delete prior box videos');
assert.ok(videoQueueSrc.includes('withIdbTransaction') || videoQueueSrc.includes('oncomplete'), 'IDB writes must await transaction commit');
assert.ok(workerSrc.includes('immediateRetry'), 'worker must gate immediate retry separately from polling');
assert.ok(!/await unlockOutstandingForImmediateRetry\(\)\s*\n\s*const pending/.test(workerSrc)
  || workerSrc.includes('if (runOpts.immediateRetry'), 'normal poll must not always unlock backoff');
assert.ok(workerSrc.includes('response.verified === true') || workerSrc.includes('verified: response.verified === true'), 'worker must require verified===true');
assert.ok(workerSrc.includes('decideMultipartRecovery') || workerSrc.includes('object-head'), 'worker must recover after multipart complete crash');
assert.ok(storageSrc.includes('evaluateStorageObjectIntegrity') || storageSrc.includes('STORAGE_OBJECT_TRUNCATED'), 'storage must verify size/MIME');
assert.ok(packingStationSrc.includes('getActiveOutstandingVideos') || packingStationSrc.includes('countOpenRecordingSessions(cid)'), 'finish must check consignment open sessions');
assert.ok(packingStationSrc.includes('canStartRecordingSafely') || packingStationSrc.includes('backpressure'), 'recording must enforce storage backpressure');
assert.ok(fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'deploy.yml'), 'utf8').includes('pull_request'), 'quality gates must run on PRs');

// Reopening an already-packed box to add more qty must ADD a video, never replace one.
assert.ok(packingStationSrc.includes('isReopen: reopen'), 'startRecording must tag reopen recordings');
assert.ok(packingStationSrc.includes("_setBox(v, { reopen: true })"), "'Continue Packing' must mark the recording as a reopen");
assert.ok(workerSrc.includes('preserveExisting'), 'worker must tell the server this is an additional-qty video');
assert.ok(
  videoQueueSrc.includes('metadata?.isReopen') && videoQueueSrc.includes('!metadata?.isReopen'),
  'local queue must skip superseding prior videos for reopen recordings'
);
assert.ok(
  /if \(entry\?\.metadata\?\.isReopen\) continue/.test(videoQueueSrc),
  'duplicate-video pruning must never treat a reopen video as a duplicate of another box video'
);
assert.ok(uploadsSrc.includes('preserveExisting') && uploadsSrc.includes('keepExistingVideo'), 'metadata API must accept preserveExisting');
assert.ok(uploadsSrc.includes('countActiveBoxVideos') && uploadsSrc.includes('buildBoxVideoLabel'), 'server must number additional videos as parts (BOX{n}_{part})');
assert.ok(
  (uploadsSrc.match(/if \(!keepExistingVideo\)/g) || []).length >= 1
    && (uploadsSrc.match(/&& !keepExistingVideo\)/g) || []).length >= 1,
  'both eviction call sites must be gated on !keepExistingVideo'
);

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
