const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../src/database.cjs');
const { LocalFiles } = require('../src/files.cjs');
const { SyncEngine } = require('../src/syncEngine.cjs');
const { BackendError } = require('../src/backendClient.cjs');

function setup(t, qty = 2) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packing-workflow-'));
  const file = path.join(root, 'packing.sqlite');
  let db = openDatabase(file);
  db.saveSnapshot({ consignment_id: 'c1', skus: [{ id: 's1', barcode: 'SKU001', required: qty, packed: 0 }], boxes: {} }, { userId: 'operator' });
  db.setSetting('sessionUserId', 'operator');
  const localFiles = new LocalFiles(root);
  const engines = [];
  t.after(() => { engines.forEach((engine) => engine.stop()); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return {
    get db() { return db; }, root, localFiles,
    reopen() { db.close(); db = openDatabase(file); return db; },
    box(number = '1') {
      db.openBox({ consignmentId: 'c1', boxNo: number });
      assert.equal(db.recordScan({ consignmentId: 'c1', boxNo: number, scanId: `scan-${number}`, barcode: 'sku001' }).ok, true);
      const videoPath = path.join(root, `video-${number}.webm`);
      fs.writeFileSync(videoPath, Buffer.from('recorded video evidence'));
      const payload = { consignmentId: 'c1', boxNo: number, operationId: `operation-${number}`, items: [{ skuId: 's1', qty: 1 }], video: { videoId: `video-${number}`, localPath: videoPath, sizeBytes: fs.statSync(videoPath).size, mimeType: 'video/webm' } };
      db.closeBox(payload);
      return payload;
    },
    engine(client) { const engine = new SyncEngine({ database: db, files: localFiles, client }); engines.push(engine); return engine; },
  };
}

function backend(overrides = {}) {
  return {
    token: 'test-only', setToken(token) { this.token = token; },
    async claimLease({ consignment_id }) { return { lease: { consignmentId: consignment_id, stationId: 'station', leaseId: 'lease' } }; },
    async renewLease() { return {}; }, async saveBox() { return {}; },
    async createMultipart({ storagePath }) { return { uploadId: 'upload-1', storagePath }; },
    async signParts({ partNumbers }) { return { parts: partNumbers.map((partNumber) => ({ partNumber, uploadUrl: 'https://storage.invalid/part' })) }; },
    async listParts() { return { parts: [] }; },
    async completeMultipart() { return {}; }, async saveMetadata() { return { verified: true }; },
    ...overrides,
  };
}

test('closed box cannot reopen or accept late scans; identical close replay is immutable', (t) => {
  const f = setup(t); const payload = f.box();
  assert.equal(f.db.closeBox(payload).idempotentReplay, true);
  assert.throws(() => f.db.closeBox({ ...payload, weight: 9 }), /changed box/);
  assert.throws(() => f.db.openBox({ consignmentId: 'c1', boxNo: '1' }), /closed/);
  assert.throws(() => f.db.recordScan({ consignmentId: 'c1', boxNo: '1', scanId: 'late', barcode: 'SKU001' }), /closed/);
  assert.equal(f.db.getSnapshot('c1').skus[0].packed, 1);
});

test('undo is durable and idempotent, and stale close cannot erase a scan', (t) => {
  const f = setup(t);
  f.db.openBox({ consignmentId: 'c1', boxNo: '1' });
  for (let i = 0; i < 2; i++) f.db.recordScan({ consignmentId: 'c1', boxNo: '1', scanId: `s${i}`, barcode: 'SKU001' });
  assert.throws(() => f.db.closeBox({ consignmentId: 'c1', boxNo: '1', operationId: 'stale', items: [{ skuId: 's1', qty: 1 }] }), /changed while saving/);
  const undo = { consignmentId: 'c1', boxNo: '1', skuId: 's1', eventId: 'undo' };
  f.db.undoScan(undo); f.db.undoScan(undo);
  assert.equal(f.reopen().getSnapshot('c1').skus[0].packed, 1);
  assert.equal(f.db.getSnapshot('c1').boxes['1'][0].qty, 1);
});

test('cloud refresh cannot replace a pending local snapshot or its owner', (t) => {
  const f = setup(t); f.box();
  f.db.saveSnapshot({ consignment_id: 'c1', skus: [{ id: 's1', barcode: 'SKU001', required: 99, packed: 0 }], boxes: {} }, { userId: 'other' });
  const snapshot = f.db.getSnapshot('c1');
  assert.equal(snapshot.skus[0].packed, 1); assert.equal(snapshot.skus[0].required, 2); assert.equal(snapshot.localSnapshotUserId, 'operator');
});

test('restart retries interrupted jobs; delayed data blocks video and subsequent boxes', (t) => {
  const f = setup(t); f.box('1'); f.box('2');
  const job = f.db.claimNextOutbox(); assert.equal(job.kind, 'box_commit');
  assert.equal(f.db.claimNextOutbox(), null);
  const reopened = f.reopen();
  const retry = reopened.claimNextOutbox(); assert.equal(retry.job_id, job.job_id);
  reopened.markOutboxRetry(retry.job_id, 'offline', 60_000);
  assert.equal(reopened.claimNextOutbox(), null);
  reopened.markOutboxDone(retry.job_id);
  assert.equal(reopened.claimNextOutbox().kind, 'video_upload');
});

test('two boxes survive restart and sync in box-data/video order with verified finish gate', async (t) => {
  const f = setup(t); f.box('1'); f.box('2'); f.reopen();
  const order = [];
  t.mock.method(global, 'fetch', async () => new Response('', { status: 200, headers: { etag: 'part-etag' } }));
  const engine = f.engine(backend({ async saveBox(payload) { order.push(`box-${payload.box_no}`); }, async saveMetadata(payload) { order.push(`video-${payload.boxNo}`); return { verified: true }; } }));
  assert.equal(f.db.getFinishReadiness('c1').ready, false);
  assert.equal((await engine.process()).processed, 4);
  assert.deepEqual(order, ['box-1', 'video-1', 'box-2', 'video-2']);
  assert.equal(f.db.getStatus('c1').cloudSynced, 2);
  assert.equal(f.db.getFinishReadiness('c1').ready, true);
});

test('storage network failure automatically retries without deleting local evidence', async (t) => {
  const f = setup(t, 1); const payload = f.box();
  let offline = true;
  t.mock.method(global, 'fetch', async () => { if (offline) throw new TypeError('network down'); return new Response('', { headers: { etag: 'part' } }); });
  const engine = f.engine(backend());
  await engine.process();
  assert.equal(f.db.getStatus('c1').failedJobs, 0);
  assert.equal(f.db.getStatus('c1').pendingJobs, 1);
  assert.ok(fs.existsSync(payload.video.localPath));
  offline = false;
  await engine.retry();
  assert.equal(f.db.getFinishReadiness('c1').ready, true);
});

test('metadata failure after multipart completion resumes verification without reupload', async (t) => {
  const f = setup(t, 1); f.box();
  let completions = 0; let puts = 0; let metadata = 0;
  t.mock.method(global, 'fetch', async () => { puts++; return new Response('', { headers: { etag: 'part' } }); });
  const engine = f.engine(backend({ async completeMultipart() { completions++; }, async saveMetadata() { if (++metadata === 1) throw new BackendError('response lost'); return { verified: true }; } }));
  await engine.process(); await engine.retry();
  assert.equal(completions, 1); assert.equal(puts, 1); assert.equal(metadata, 2);
  assert.equal(f.db.getFinishReadiness('c1').ready, true);
});

test('different operator cannot sync previous operator work and incomplete quantities block finish', async (t) => {
  const f = setup(t); f.box(); f.db.setSetting('sessionUserId', 'other');
  let requests = 0;
  const engine = f.engine(backend({ async saveBox() { requests++; } }));
  await engine.process(); assert.equal(requests, 0); assert.equal(f.db.getStatus('c1').failedJobs, 1);
  assert.equal(f.db.getFinishReadiness('c1').incompleteSkus, 1);
  assert.equal(f.db.getFinishReadiness('unknown').ready, false);
});

test('ambiguous barcode and reused scan identity are explicitly rejected', (t) => {
  const f = setup(t);
  f.db.saveSnapshot({ consignment_id: 'c1', skus: [{ id: 's1', barcode: 'SAME', required: 1 }, { id: 's2', barcode: 'SAME', required: 1 }], boxes: {} });
  assert.equal(f.db.recordScan({ consignmentId: 'c1', boxNo: '1', scanId: 'ambiguous', barcode: 'SAME' }).result, 'ambiguous');
  assert.throws(() => f.db.recordScan({ consignmentId: 'c1', boxNo: '2', scanId: 'ambiguous', barcode: 'SAME' }), /different event/);
});

test('synced cloud refresh removes stale mirror rows but preserves scan audit and files', async (t) => {
  const f = setup(t, 1); const old = f.box();
  t.mock.method(global, 'fetch', async () => new Response('', { headers: { etag: 'part' } }));
  await f.engine(backend()).process();
  f.db.saveSnapshot({ consignment_id: 'c1', skus: [{ id: 'new-sku', barcode: 'NEW', required: 1 }], boxes: {} }, { userId: 'operator' });
  assert.equal(f.db.getSnapshot('c1').skus.length, 1);
  assert.equal(f.db.getSnapshot('c1').skus[0].id, 'new-sku');
  assert.deepEqual(f.db.getSnapshot('c1').boxes, {});
  assert.ok(fs.existsSync(old.video.localPath));
  assert.equal(f.db.db.prepare('SELECT count(*) AS count FROM local_scan_events').get().count, 1);
});

test('expired multipart is restarted only after the server confirms the object is missing', async (t) => {
  const f = setup(t, 1); f.box();
  let failPut = true; let creates = 0; let probes = 0;
  t.mock.method(global, 'fetch', async () => { if (failPut) throw new TypeError('offline'); return new Response('', { headers: { etag: 'part' } }); });
  const engine = f.engine(backend({
    async createMultipart() { return { uploadId: `upload-${++creates}` }; },
    async listParts() { throw new BackendError('expired', { status: 404, code: 'NoSuchUpload' }); },
    async headObject() { probes++; throw new BackendError('missing', { status: 404, code: 'STORAGE_OBJECT_MISSING' }); },
  }));
  await engine.process(); failPut = false; await engine.retry();
  assert.equal(probes, 1); assert.equal(creates, 2);
  assert.equal(f.db.getFinishReadiness('c1').ready, true);
});

test('lost complete acknowledgement is recovered by verifying the existing object', async (t) => {
  const f = setup(t, 1); f.box();
  let puts = 0; let completeCalls = 0;
  t.mock.method(global, 'fetch', async () => { puts++; return new Response('', { headers: { etag: 'part' } }); });
  const engine = f.engine(backend({
    async completeMultipart() { completeCalls++; throw new BackendError('response lost'); },
    async listParts() { throw new BackendError('completed', { status: 404, code: 'NoSuchUpload' }); },
    async headObject() { return { verified: true }; },
  }));
  await engine.process(); await engine.retry();
  assert.equal(puts, 1); assert.equal(completeCalls, 1);
  assert.equal(f.db.getFinishReadiness('c1').ready, true);
});

test('250 repeated physical barcodes are independently durable with no debounce', (t) => {
  const f = setup(t, 250);
  f.db.openBox({ consignmentId: 'c1', boxNo: '1' });
  const timings = [];
  for (let i = 0; i < 250; i++) {
    const start = performance.now();
    assert.equal(f.db.recordScan({ consignmentId: 'c1', boxNo: '1', scanId: `burst-${i}`, barcode: 'SKU001' }).ok, true);
    timings.push(performance.now() - start);
  }
  assert.equal(f.reopen().getSnapshot('c1').skus[0].packed, 250);
  timings.sort((a, b) => a - b);
  t.diagnostic(`Synthetic SQLite capture ms: p50=${timings[124].toFixed(2)} p95=${timings[237].toFixed(2)} p99=${timings[247].toFixed(2)}. Not a hardware scanner measurement.`);
});
