// Exercises the installed renderer/IPC against a loopback fixture, never production.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { consignmentDirName } = require('../src/files.cjs');

const desktopRoot = path.resolve(__dirname, '..');
// Operators enter free text ("Offline Test 1"), so the fixture must not use a
// conveniently filesystem-safe ID: that is what hid the local-storage failure.
const smokeCid = 'Smoke Test 1';
const smokeCidJs = JSON.stringify(smokeCid);
const executable = process.argv[2] || path.join(desktopRoot, 'release', 'win-unpacked', 'Youthnic Packing Station.exe');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'youthnic-packaged-smoke-'));
const user = { id: 'smoke-operator', name: 'Test Operator', role: 'packer', permissions: { packing: true } };
const requests = [];
let offline = false;
let desktopReady = true;
let child;
let socket;
let nextId = 0;
const pending = new Map();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const serverEvents = [];
const fixtureParts = new Map();
const rendererConsole = [];
let fixtureUploadSeq = 0;

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks);
  requests.push({ method: req.method, path: req.url, station: Boolean(req.headers['x-station-id']) });
  if (offline) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Fixture outage' })); return; }
  // Loopback stand-in for Cloudflare R2 signed URLs. The small artificial
  // delay widens the reconnect drain so the test closes another box mid-drain —
  // the exact overlap that wedged NEXT BOX in the field.
  if (req.method === 'PUT' && req.url.startsWith('/fixture-storage/')) {
    const query = new URL(req.url, 'http://fixture').searchParams;
    const uploadId = query.get('uploadId') || 'single';
    const partNumber = query.get('partNumber') || '1';
    await delay(200);
    fixtureParts.set(`${uploadId}:${partNumber}`, rawBody.length);
    res.writeHead(200, { 'content-type': 'application/json', etag: `"fx-etag-${uploadId}-${partNumber}"` });
    res.end('{}');
    return;
  }
  const body = JSON.parse(rawBody.toString() || '{}');
  res.setHeader('content-type', 'application/json');
  const storageUrl = (storagePath, uploadId, partNumber) =>
    `http://127.0.0.1:${server.address().port}/fixture-storage/${encodeURIComponent(storagePath || 'object')}?uploadId=${uploadId}&partNumber=${partNumber}`;
  if (req.url === '/api/health') res.end(JSON.stringify({ ok: true }));
  else if (req.url === '/api/desktop/status') {
    if (!desktopReady) { res.writeHead(404); res.end(JSON.stringify({ code: 'API_ROUTE_NOT_FOUND' })); }
    else res.end(JSON.stringify({ ready: true, protocolVersion: 1, capabilities: { stationLeases: true, boxIdempotency: true, multipartRecovery: true } }));
  }
  else if (req.url === '/api/auth/firebase-login') { res.writeHead(400); res.end(JSON.stringify({ error: 'Fixture token rejected' })); }
  else if (req.url === '/api/auth/me') res.end(JSON.stringify({ user }));
  else if (req.url.startsWith('/api/consignments')) res.end(JSON.stringify({ consignments: [] }));
  else if (req.url === '/api/packing/lease/claim') res.end(JSON.stringify({ lease: { consignmentId: body.consignment_id, stationId: body.station_id, leaseId: 'smoke-lease' } }));
  else if (req.url === '/api/packing/lease/renew') res.end('{}');
  else if (req.url === '/api/packing/save-box') {
    serverEvents.push({ type: 'save-box', boxNo: String(body.boxNo ?? body.box_no ?? '') });
    res.end(JSON.stringify({ ok: true }));
  }
  else if (req.url === '/api/uploads/generate-signed-url') res.end(JSON.stringify({ uploadUrl: storageUrl(body.storagePath, `proof-${++fixtureUploadSeq}`, 1), storagePath: body.storagePath }));
  else if (req.url === '/api/uploads/multipart/create') res.end(JSON.stringify({ uploadId: `fx-upload-${++fixtureUploadSeq}`, storagePath: body.storagePath }));
  else if (req.url === '/api/uploads/multipart/sign-parts') res.end(JSON.stringify({ parts: (body.partNumbers || []).map((partNumber) => ({ partNumber, uploadUrl: storageUrl(body.storagePath, body.uploadId, partNumber) })) }));
  else if (req.url === '/api/uploads/multipart/list-parts') {
    const parts = [...fixtureParts.keys()]
      .filter((key) => key.startsWith(`${body.uploadId}:`))
      .map((key) => ({ partNumber: Number(key.split(':').pop()), etag: `fx-etag-${body.uploadId}-${key.split(':').pop()}` }));
    res.end(JSON.stringify({ parts }));
  }
  else if (req.url === '/api/uploads/multipart/complete') res.end(JSON.stringify({ ok: true }));
  else if (req.url === '/api/uploads/object-head') res.end(JSON.stringify({ verified: true }));
  else if (req.url === '/api/uploads/metadata') {
    if (body.type === 'video') serverEvents.push({ type: 'video-metadata', boxNo: String(body.boxNo ?? '') });
    res.end(JSON.stringify({ verified: true, file: { id: `fx-file-${++fixtureUploadSeq}` } }));
  }
  else { res.writeHead(404); res.end(JSON.stringify({ error: 'Unknown fixture route' })); }
});

async function connect() {
  const portServer = http.createServer();
  portServer.listen(0, '127.0.0.1'); await once(portServer, 'listening');
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  const env = { ...process.env, YOUTHNIC_PACKING_DATA_DIR: fixtureRoot, YOUTHNIC_PACKING_API_URL: `http://127.0.0.1:${server.address().port}` };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.YOUTHNIC_PACKING_DEV_URL;
  delete env.ELECTRON_START_URL;
  child = spawn(executable, [`--remote-debugging-port=${port}`, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], { env, windowsHide: true, stdio: 'ignore' });
  child.on('error', (error) => console.error('Fixture launch failed:', error.message));
  let page;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((item) => item.type === 'page'); } catch (_) {}
    if (page) break;
    await delay(100);
  }
  assert.ok(page, 'Packaged app exposes its test debugging target');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await once(socket, 'open');
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) {
      if (message.method === 'Runtime.consoleAPICalled') {
        const text = (message.params.args || []).map((arg) => arg.value ?? arg.description ?? '').join(' ');
        rendererConsole.push(`[${message.params.type}] ${text}`.slice(0, 300));
      } else if (message.method === 'Runtime.exceptionThrown') {
        rendererConsole.push(`[exception] ${message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text}`.slice(0, 300));
      }
      return;
    }
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id); clearTimeout(task.timer);
    if (message.error) task.reject(new Error(message.error.message)); else task.resolve(message.result);
  });
  await command('Runtime.enable');
  await until('Boolean(window.youthnicDesktop)', true);
  assert.equal((await evaluate('window.youthnicDesktop.app.info()')).userData, fixtureRoot);
}

function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result?.value;
}
async function until(expression, expected, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(expression);
    if (last === expected) return;
    await delay(150);
  }
  assert.equal(last, expected, expression);
}
async function closeApp() {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  void command('Browser.close').catch(() => {});
  await Promise.race([exited, delay(5000)]);
  if (child.exitCode === null) child.kill();
  socket?.close();
}

(async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  await connect();
  await until("document.body.innerText.includes('Sign in')", true);
  const assets = path.join(desktopRoot, 'renderer', 'assets');
  const apiAsset = fs.readdirSync(assets).find((file) => file.endsWith('.js') && fs.readFileSync(path.join(assets, file), 'utf8').includes('.interceptors.request.use'));
  assert.ok(apiAsset, 'Bundled Axios API module exists');
  const transport = await evaluate(`(async () => {
    const exports = await import('app://youthnic/assets/${apiAsset}');
    const api = Object.values(exports).find(value => value?.interceptors && value?.defaults);
    if (!api) throw new Error('Bundled API export missing');
    const health = (await api.get('/health')).data;
    let exchangeStatus, oldSchemeError;
    try { await api.post('/auth/firebase-login', { idToken: 'fixture-not-a-real-token' }); } catch (error) { exchangeStatus = error.response?.status; }
    try { await api.get('app://youthnic/api/health'); } catch (error) { oldSchemeError = error.message; }
    return { health, exchangeStatus, oldSchemeError };
  })()`);
  assert.equal(transport.health.ok, true);
  assert.equal(transport.exchangeStatus, 400, 'Login request reached API with its JSON body');
  assert.match(transport.oldSchemeError, /Unsupported protocol app/);
  assert.ok(requests.some((req) => req.path === '/api/health' && req.station));
  console.log('PASS actual bundled Axios GET/POST; old absolute app:// failure reproduced');
  await evaluate(`window.youthnicDesktop.auth.setSession({ token: 'fixture-session-not-a-production-token' })`);
  desktopReady = false;
  const incompatible = await evaluate('window.youthnicDesktop.packing.checkBackend()');
  assert.equal(incompatible.ok, false);
  assert.equal(incompatible.code, 'DESKTOP_SERVER_UPGRADE_REQUIRED');
  const claimsBefore = requests.filter((request) => request.path === '/api/packing/lease/claim').length;
  await assert.rejects(evaluate(`window.youthnicDesktop.packing.claimLease({ consignmentId: ${smokeCidJs} })`), /server needs the desktop packing update/);
  assert.equal(requests.filter((request) => request.path === '/api/packing/lease/claim').length, claimsBefore);
  desktopReady = true;
  console.log('PASS outdated backend is explicitly blocked before station claim; no local-data or ownership bypass');
  await evaluate(`(async () => {
    const desktop = window.youthnicDesktop;
    await desktop.sync.stop();
    await desktop.packing.claimLease({ consignmentId: ${smokeCidJs} });
    await desktop.packing.saveSnapshot({ consignment_id: ${smokeCidJs}, internalShipmentNo: 'Offline test consignment', skus: [{ id: 's1', barcode: 'REPEAT', required: 3, packed: 0 }, { id: 's2', barcode: 'SECOND', required: 2, packed: 0 }], boxes: {} });
    await desktop.packing.openBox({ consignmentId: ${smokeCidJs}, boxNo: '1' });
    for (let index = 0; index < 2; index++) {
      const result = await desktop.packing.recordScan({ consignmentId: ${smokeCidJs}, boxNo: '1', scanId: 'smoke-scan-' + index, barcode: 'REPEAT' });
      if (!result.ok) throw new Error('Scan failed');
    }
    await desktop.video.start({ consignmentId: ${smokeCidJs}, boxNo: '1', videoId: 'smoke-video' });
    await desktop.video.appendChunk({ videoId: 'smoke-video', data: new Uint8Array([1,2,3,4]).buffer });
    const video = await desktop.video.finalize({ consignmentId: ${smokeCidJs}, boxNo: '1', videoId: 'smoke-video' });
    await desktop.packing.closeBox({ consignmentId: ${smokeCidJs}, boxNo: '1', operationId: 'smoke-close-1', items: [{ skuId: 's1', qty: 2 }], video });
    // Leave Box 2 open across the restart: the packer must land back inside it,
    // not behind a "Resume and close Box 2 first" wall.
    await desktop.packing.openBox({ consignmentId: ${smokeCidJs}, boxNo: '2' });
  })()`);
  const encrypted = fs.readFileSync(path.join(fixtureRoot, 'YouthnicPacking', 'session.bin'));
  assert.equal(encrypted.includes(Buffer.from('fixture-session')), false);
  await closeApp();
  offline = true;
  await connect();
  await until("document.body.innerText.includes('Ready offline')", true);
  const restored = await evaluate(`(async () => ({
    user: (await window.youthnicDesktop.auth.getSession()).user?.id,
    snapshot: await window.youthnicDesktop.packing.getSnapshot(${smokeCidJs}),
    status: await window.youthnicDesktop.sync.status()
  }))()`);
  assert.equal(restored.user, user.id);
  assert.equal(restored.snapshot.skus[0].packed, 2);
  assert.equal(restored.snapshot.boxes['1'][0].qty, 2);
  assert.equal(restored.snapshot.localBoxes.find((box) => box.box_no === '2')?.state, 'OPEN');
  assert.equal(restored.status.pendingJobs, 2);
  console.log('PASS encrypted session survives restart during API outage; duplicate physical barcodes count twice; box/video queue preserved');
  await evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.includes('Sync center')).click()`);
  await until("document.body.innerText.includes('Safe locally')", true);
  const screenshot = await command('Page.captureScreenshot', { format: 'png' });
  const output = path.join(desktopRoot, 'release', 'smoke-offline-sync.png');
  fs.writeFileSync(output, Buffer.from(screenshot.data, 'base64'));
  console.log('Screenshot:', output);
  // A downloaded consignment must remain packable if the network returns but
  // the server is still on the older desktop contract. It must only queue
  // locally; it cannot claim, upload, or silently appear cloud-synced.
  offline = false;
  desktopReady = false;
  await evaluate("location.hash = '#/packing'");
  await until("Boolean(document.querySelector('input[placeholder^=\"ID / Shipment\"]'))", true);
  await evaluate(`(() => { const input = document.querySelector('input[placeholder^="ID / Shipment"]'); input.value = ${smokeCidJs}; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await until("document.body.innerText.includes('Server update pending')", true);
  // The box left open before the restart must come back as the active box —
  // this exercises the resume path instead of a fresh box entry.
  await until("document.body.innerText.includes('Resumed Box 2')", true);
  await until("Boolean(Array.from(document.querySelectorAll('video')).find(video => video.srcObject && video.readyState >= 2))", true);
  const videosDir = path.join(fixtureRoot, 'YouthnicPacking', 'consignments', consignmentDirName(smokeCid), 'videos');
  {
    // CCTV is mandatory: the resumed box must restart evidence capture on its own.
    const deadline = Date.now() + 25000;
    let recordingRestarted = false;
    while (Date.now() < deadline && !recordingRestarted) {
      const recoveryDir = path.join(videosDir, 'recovery');
      recordingRestarted = fs.existsSync(recoveryDir) && fs.readdirSync(recoveryDir).some((file) => file.endsWith('.part') && fs.statSync(path.join(recoveryDir, file)).size > 1000);
      if (!recordingRestarted) await delay(150);
    }
    assert.ok(recordingRestarted, 'Recording restarts automatically for the resumed open box (non-empty chunks flowing)');
  }
  await evaluate(`(() => { const input = document.querySelector('#z3 input'); input.value = 'REPEAT'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await until(`window.youthnicDesktop.packing.getSnapshot(${smokeCidJs}).then(snapshot => snapshot.skus[0].packed)`, 3);
  await delay(1600);
  await evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.includes('NEXT BOX')).click()`);
  await until("document.body.innerText.includes('Box Weight Capture')", true);
  await evaluate(`(() => { const input = document.querySelector('input[placeholder="0.00"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '1.5'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate(`document.querySelector('input[placeholder="0.00"]').form.requestSubmit()`);
  await until(`window.youthnicDesktop.packing.getSnapshot(${smokeCidJs}).then(snapshot => snapshot.localBoxes.find(box => box.box_no === '2')?.state)`, 'QUEUED', 60000);
  const recordings = fs.readdirSync(videosDir).filter((file) => /\.(webm|mp4)$/.test(file) && file !== 'smoke-video.webm');
  assert.equal(recordings.length, 1);
  const actualVideo = fs.readFileSync(path.join(videosDir, recordings[0]));
  assert.ok(actualVideo.length > 1000, 'Simulated-camera recording contains video frames');
  if (recordings[0].endsWith('.webm')) assert.equal(actualVideo.subarray(0, 4).toString('hex'), '1a45dfa3', 'Finalized recording is a WebM container');
  else assert.equal(actualVideo.subarray(4, 8).toString(), 'ftyp', 'Finalized recording is an MP4 container');
  {
    // The resumed box must start exactly ONE recording session — a double start
    // produced two empty recordings and made the box unclosable in the field.
    const stationLog = fs.readFileSync(path.join(fixtureRoot, 'YouthnicPacking', 'logs', 'packing-station.log'), 'utf8');
    const box2Starts = stationLog.split('\n').filter((line) => line.includes('"video.started"') && line.includes('"boxNo":"2"')).length;
    assert.equal(box2Starts, 1, 'Resumed box starts exactly one recording session');
  }
  console.log('PASS real Packing screen: open box resumed after restart with recording auto-restarted, cached load during server-version mismatch, barcode capture, weight confirmation, local video finalization and next box');

  // ── Phase 5: the field-reported failure. Keep packing while OFFLINE, then
  // bring the network back mid-packing: the outbox must drain in order (box
  // data before its video) while a new box closes through the real UI during
  // the drain, and the packer sees internet lost/back/caught-up toasts.
  const seenTexts = new Set();
  const sample = async () => {
    try {
      const text = await evaluate('document.body.innerText');
      for (const needle of ['Internet lost', 'Internet back', 'All caught up', 'Could not save']) {
        if (text.includes(needle)) seenTexts.add(needle);
      }
    } catch (_) { /* transient navigation */ }
  };
  // Toasts expire in 4-7s, so sample continuously for the whole phase instead
  // of checking at one instant — the 15s sync timer decides when the offline
  // transition surfaces, not the test.
  const sampler = setInterval(() => { void sample(); }, 400);
  sampler.unref(); // diagnostics only — must never keep the process alive
  offline = true;
  desktopReady = true;
  // The engine backs off between retries, so a short offline window can pass
  // without any attempt hitting the dead fixture. Force one attempt now so the
  // app observes the outage (online=false → 'Internet lost' toast) before we
  // close the next box.
  await evaluate('void window.youthnicDesktop.sync.retry()');
  await until('window.youthnicDesktop.sync.status().then(status => status.online === false)', true);
  await evaluate(`(() => { const input = document.querySelector('input[placeholder^="Box no"]'); input.value = '3'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await until("document.body.innerText.includes('Box 3 active')", true);
  await evaluate(`(() => { const input = document.querySelector('#z3 input'); input.value = 'SECOND'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await until(`window.youthnicDesktop.packing.getSnapshot(${smokeCidJs}).then(snapshot => snapshot.skus.find(s => s.id === 's2')?.packed)`, 1);
  await delay(1600);
  await evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.includes('NEXT BOX')).click()`);
  await until("document.body.innerText.includes('Box Weight Capture')", true);
  await evaluate(`(() => { const input = document.querySelector('input[placeholder="0.00"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '2.5'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate(`document.querySelector('input[placeholder="0.00"]').form.requestSubmit()`);
  await until(`window.youthnicDesktop.packing.getSnapshot(${smokeCidJs}).then(snapshot => snapshot.localBoxes.find(box => box.box_no === '3')?.state)`, 'QUEUED', 60000);
  const offlineStatus = await evaluate('window.youthnicDesktop.sync.status()');
  assert.equal(offlineStatus.pendingJobs, 6, 'Three closed boxes queue six ordered sync jobs while offline');
  await sample();
  console.log('PASS box packed and closed entirely offline — weight modal, local video finalize and outbox queue all work with the network down');

  // Internet returns mid-packing. Fire the drain, then immediately close yet
  // another box through the UI — the overlap that used to spin forever.
  offline = false;
  await evaluate('void window.youthnicDesktop.sync.retry()');
  await evaluate(`(() => { const input = document.querySelector('input[placeholder^="Box no"]'); input.value = '4'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await until("document.body.innerText.includes('Box 4 active')", true);
  await evaluate(`(() => { const input = document.querySelector('#z3 input'); input.value = 'SECOND'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await until(`window.youthnicDesktop.packing.getSnapshot(${smokeCidJs}).then(snapshot => snapshot.skus.find(s => s.id === 's2')?.packed)`, 2);
  await sample();
  await delay(1600);
  await evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.includes('NEXT BOX')).click()`);
  await until("document.body.innerText.includes('Box Weight Capture')", true);
  await evaluate(`(() => { const input = document.querySelector('input[placeholder="0.00"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '3.5'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate(`document.querySelector('input[placeholder="0.00"]').form.requestSubmit()`);
  // The drain is already running, so box 4 can fly through QUEUED → SYNCED
  // between polls; accept either — the full-drain assertions below verify the
  // terminal state.
  await until(`window.youthnicDesktop.packing.getSnapshot(${smokeCidJs}).then(snapshot => ['QUEUED', 'SYNCED'].includes(snapshot.localBoxes.find(box => box.box_no === '4')?.state))`, true, 60000);
  await sample();

  const drainDeadline = Date.now() + 90000;
  let drained = null;
  while (Date.now() < drainDeadline) {
    drained = await evaluate('window.youthnicDesktop.sync.status()');
    await sample();
    if (drained.pendingJobs === 0) break;
    await delay(250);
  }
  clearInterval(sampler);
  assert.equal(drained.pendingJobs, 0, 'Outbox drains fully after reconnect');
  // The packing snapshot's localBoxes omits video_state; sync status exposes
  // the full local_boxes rows.
  const finalBoxes = await evaluate(`window.youthnicDesktop.sync.status().then(status => status.boxes.filter(box => box.consignment_id === ${smokeCidJs}).map(box => ({ no: box.box_no, state: box.state, video: box.video_state })))`);
  for (const no of ['1', '2', '3', '4']) {
    const box = finalBoxes.find((entry) => entry.no === no);
    assert.equal(box?.state, 'SYNCED', `Box ${no} data synced`);
    assert.equal(box?.video, 'SYNCED', `Box ${no} video synced`);
  }
  assert.deepEqual(serverEvents, [
    { type: 'save-box', boxNo: '1' }, { type: 'video-metadata', boxNo: '1' },
    { type: 'save-box', boxNo: '2' }, { type: 'video-metadata', boxNo: '2' },
    { type: 'save-box', boxNo: '3' }, { type: 'video-metadata', boxNo: '3' },
    { type: 'save-box', boxNo: '4' }, { type: 'video-metadata', boxNo: '4' },
  ], 'Every box lands data-first, in box order, exactly once');
  assert.ok(seenTexts.has('Internet lost'), 'Offline toast shown');
  assert.ok(seenTexts.has('Internet back'), 'Reconnect toast shown');
  assert.ok(seenTexts.has('All caught up'), 'Drain-complete toast shown');
  assert.ok(!seenTexts.has('Could not save'), 'Close flow never surfaced a save error');
  await until("document.body.innerText.includes('Synced')", true);
  console.log('PASS reconnect mid-packing: outbox drained in order (box data before video) while Box 4 closed through the UI during the drain; lost/back/caught-up toasts shown');
  console.log('Fixture data retained for inspection:', fixtureRoot);
})().catch(async (error) => {
  console.error(error.message);
  process.exitCode = 1;
  try {
    const visible = await evaluate("JSON.stringify({ url: location.href, ready: document.readyState, text: (document.body?.innerText || '').slice(-1200) })");
    console.error('--- visible UI tail ---\n' + visible);
  } catch (_) { /* app already gone */ }
  console.error('--- renderer console tail ---');
  for (const line of rendererConsole.slice(-25)) console.error(line);
}).finally(async () => {
  await closeApp();
  for (const task of pending.values()) clearTimeout(task.timer);
  server.closeAllConnections();
  server.close();
  // Electron grandchildren (crashpad, GPU) can hold the console pipe after the
  // app quits; exit explicitly so CI/harness wrappers never hang on them.
  process.exit(process.exitCode ?? 0);
});
