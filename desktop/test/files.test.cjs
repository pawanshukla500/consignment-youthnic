const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');
const { LocalFiles } = require('../src/files.cjs');

test('desktop storage layout is created automatically at the app data root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youthnic-files-layout-'));
  const files = new LocalFiles(path.join(root, 'YouthnicPacking'));
  await files.ensureRoot();
  await assert.doesNotReject(() => fs.stat(path.join(root, 'YouthnicPacking', 'database')));
  await assert.doesNotReject(() => fs.stat(path.join(root, 'YouthnicPacking', 'consignments')));
  await fs.rm(root, { recursive: true, force: true });
});

test('video chunks are written to a local file and finalized without a blob aggregate', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youthnic-files-'));
  const files = new LocalFiles(root);
  const started = await files.startVideo({ videoId: 'video-1', consignmentId: 'c-1', boxNo: '1', fileName: 'box.webm' });
  await files.appendVideoChunk({ videoId: started.videoId, data: new Uint8Array([1, 2, 3]) });
  await files.appendVideoChunk({ videoId: started.videoId, data: new Uint8Array([4, 5]) });
  const finalized = await files.finalizeVideo({ videoId: started.videoId, consignmentId: 'c-1', boxNo: '1' });
  assert.equal(finalized.sizeBytes, 5);
  assert.equal((await fs.readFile(finalized.localPath)).length, 5);
  await assert.rejects(() => fs.stat(started.recoveryPath));
  await fs.rm(root, { recursive: true, force: true });
});

test('restart preserves interrupted evidence and rejects appending a new video container', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youthnic-files-recovery-'));
  const first = new LocalFiles(root);
  const started = await first.startVideo({ videoId: 'recover-1', consignmentId: 'c-1', boxNo: '1' });
  await first.appendVideoChunk({ videoId: started.videoId, data: new Uint8Array([9, 8, 7]) });
  await first.handles.get(started.videoId).close();
  first.handles.delete(started.videoId);
  first.writeChains.delete(started.videoId);

  const second = new LocalFiles(root);
  const recovered = await second.recoverIncompleteRecordings();
  assert.equal(recovered[0].videoId, 'recover-1');
  assert.equal(recovered[0].sizeBytes, 3);
  assert.equal(recovered[0].requiresReview, true);
  await assert.rejects(() => second.startVideo({ videoId: 'recover-1', consignmentId: 'c-1', boxNo: '1' }));
  assert.deepEqual([...await fs.readFile(started.recoveryPath)], [9, 8, 7]);
  await fs.rm(root, { recursive: true, force: true });
});

test('critical disk and unsafe identifiers block new recordings', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youthnic-disk-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = new LocalFiles(root);
  files.diskHealth = async () => ({ critical: true });
  await assert.rejects(() => files.startVideo({ consignmentId: 'c-1', boxNo: '1' }), /disk space/);
  await assert.rejects(() => files.ensureConsignmentDirs('..'), /identifier/);
  await assert.rejects(() => files.ensureConsignmentDirs('../outside'), /identifier/);
});

test('failed chunk remains a finalization blocker even after its promise settles', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youthnic-write-error-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = new LocalFiles(root);
  const session = await files.startVideo({ videoId: 'broken', consignmentId: 'c-1', boxNo: '1' });
  const handle = files.handles.get(session.videoId);
  await handle.close();
  await assert.rejects(() => files.appendVideoChunk({ videoId: session.videoId, data: Buffer.from('evidence') }));
  await assert.rejects(() => files.finalizeVideo({ videoId: session.videoId, consignmentId: 'c-1', boxNo: '1' }), /chunk was not saved/);
  await assert.doesNotReject(() => fs.stat(session.recoveryPath));
});
