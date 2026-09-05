const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { openDatabase } = require('../src/database.cjs');
const { LocalFiles } = require('../src/files.cjs');
const { registerIpc } = require('../src/ipc.cjs');

test('IPC rejects untrusted frames, unverified roles, unclaimed downloads and foreign operator data', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packing-ipc-'));
  const db = openDatabase(path.join(root, 'packing.sqlite'));
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const handlers = new Map();
  const sync = { client: { token: null, baseUrl: 'https://fixture.invalid/api' }, user: null,
    async setSession({ token, user }) { this.client.token = token; this.user = user; }, start() {}, stop() {}, async notify() {},
  };
  registerIpc({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, app: { getVersion: () => 'test', getPath: () => root }, database: db, files: new LocalFiles(root), sync, persistToken() {} });
  const frame = { url: 'app://youthnic/index.html' };
  const trusted = { senderFrame: frame, sender: { mainFrame: frame } };
  const call = (channel, payload = {}, event = trusted) => handlers.get(`desktop:${channel}`)(event, payload);
  await assert.rejects(call('station-get'), /Sign in/);
  await assert.rejects(call('app-info', {}, { ...trusted, senderFrame: { url: 'https://remote.invalid' } }), /Untrusted/);
  t.mock.method(global, 'fetch', async () => new Response(JSON.stringify({ user: { id: 'operator', role: 'packer', permissions: {} } }), { headers: { 'content-type': 'application/json' } }));
  await call('auth-set-session', { token: 'fixture', user: { id: 'operator', role: 'admin' } });
  assert.equal(sync.user.role, 'packer');
  await assert.rejects(call('station-get'), /permission/);
  sync.user.permissions.packing = true;
  const snapshot = { consignment_id: 'c1', skus: [{ id: 's1', barcode: 'SKU1', required: 1 }], boxes: {} };
  await assert.rejects(call('packing-save-snapshot', { snapshot }), /Claim/);
  db.setSetting('lease:c1', { stationId: db.ensureStation().station_id });
  await call('packing-save-snapshot', { snapshot });
  await call('packing-open-box', { consignmentId: 'c1', boxNo: '1' });
  sync.user.id = 'other';
  await assert.rejects(call('packing-get-snapshot', { consignmentId: 'c1' }), /different operator/);
  assert.equal((await call('packing-list-cached')).length, 0);
  assert.equal((await call('sync-status')).boxes.length, 0);
});
