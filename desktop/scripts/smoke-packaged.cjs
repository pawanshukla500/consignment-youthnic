// Exercises the installed renderer/IPC against a loopback fixture, never production.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const desktopRoot = path.resolve(__dirname, '..');
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

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  requests.push({ method: req.method, path: req.url, station: Boolean(req.headers['x-station-id']) });
  res.setHeader('content-type', 'application/json');
  if (offline) { res.writeHead(503); res.end(JSON.stringify({ error: 'Fixture outage' })); return; }
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
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id); clearTimeout(task.timer);
    if (message.error) task.reject(new Error(message.error.message)); else task.resolve(message.result);
  });
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
async function until(expression, expected) {
  const deadline = Date.now() + 25000;
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
  await assert.rejects(evaluate("window.youthnicDesktop.packing.claimLease({ consignmentId: 'smoke-c1' })"), /server needs the desktop packing update/);
  assert.equal(requests.filter((request) => request.path === '/api/packing/lease/claim').length, claimsBefore);
  desktopReady = true;
  console.log('PASS outdated backend is explicitly blocked before station claim; no local-data or ownership bypass');
  await evaluate(`(async () => {
    const desktop = window.youthnicDesktop;
    await desktop.sync.stop();
    await desktop.packing.claimLease({ consignmentId: 'smoke-c1' });
    await desktop.packing.saveSnapshot({ consignment_id: 'smoke-c1', internalShipmentNo: 'Offline test consignment', skus: [{ id: 's1', barcode: 'REPEAT', required: 3, packed: 0 }], boxes: {} });
    await desktop.packing.openBox({ consignmentId: 'smoke-c1', boxNo: '1' });
    for (let index = 0; index < 2; index++) {
      const result = await desktop.packing.recordScan({ consignmentId: 'smoke-c1', boxNo: '1', scanId: 'smoke-scan-' + index, barcode: 'REPEAT' });
      if (!result.ok) throw new Error('Scan failed');
    }
    await desktop.video.start({ consignmentId: 'smoke-c1', boxNo: '1', videoId: 'smoke-video' });
    await desktop.video.appendChunk({ videoId: 'smoke-video', data: new Uint8Array([1,2,3,4]).buffer });
    const video = await desktop.video.finalize({ consignmentId: 'smoke-c1', boxNo: '1', videoId: 'smoke-video' });
    await desktop.packing.closeBox({ consignmentId: 'smoke-c1', boxNo: '1', operationId: 'smoke-close-1', items: [{ skuId: 's1', qty: 2 }], video });
  })()`);
  const encrypted = fs.readFileSync(path.join(fixtureRoot, 'YouthnicPacking', 'session.bin'));
  assert.equal(encrypted.includes(Buffer.from('fixture-session')), false);
  await closeApp();
  offline = true;
  await connect();
  await until("document.body.innerText.includes('Ready offline')", true);
  const restored = await evaluate(`(async () => ({
    user: (await window.youthnicDesktop.auth.getSession()).user?.id,
    snapshot: await window.youthnicDesktop.packing.getSnapshot('smoke-c1'),
    status: await window.youthnicDesktop.sync.status()
  }))()`);
  assert.equal(restored.user, user.id);
  assert.equal(restored.snapshot.skus[0].packed, 2);
  assert.equal(restored.snapshot.boxes['1'][0].qty, 2);
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
  await evaluate(`(() => { const input = document.querySelector('input[placeholder^="ID / Shipment"]'); input.value = 'smoke-c1'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await until("document.body.innerText.includes('Server update pending')", true);
  await until("Boolean(Array.from(document.querySelectorAll('video')).find(video => video.srcObject && video.readyState >= 2))", true);
  await evaluate(`(() => { const input = document.querySelector('input[placeholder^="Box no"]'); input.value = '2'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await until("document.body.innerText.includes('Box 2 active')", true);
  await evaluate(`(() => { const input = document.querySelector('#z3 input'); input.value = 'REPEAT'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await until("window.youthnicDesktop.packing.getSnapshot('smoke-c1').then(snapshot => snapshot.skus[0].packed)", 3);
  await delay(1600);
  await evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.includes('NEXT BOX')).click()`);
  await until("document.body.innerText.includes('Box Weight Capture')", true);
  await evaluate(`(() => { const input = document.querySelector('input[placeholder="0.00"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '1.5'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate(`document.querySelector('input[placeholder="0.00"]').form.requestSubmit()`);
  await until("window.youthnicDesktop.packing.getSnapshot('smoke-c1').then(snapshot => snapshot.localBoxes.find(box => box.box_no === '2')?.state)", 'QUEUED');
  const videosDir = path.join(fixtureRoot, 'YouthnicPacking', 'consignments', 'smoke-c1', 'videos');
  const recordings = fs.readdirSync(videosDir).filter((file) => /\.(webm|mp4)$/.test(file) && file !== 'smoke-video.webm');
  assert.equal(recordings.length, 1);
  const actualVideo = fs.readFileSync(path.join(videosDir, recordings[0]));
  assert.ok(actualVideo.length > 1000, 'Simulated-camera recording contains video frames');
  if (recordings[0].endsWith('.webm')) assert.equal(actualVideo.subarray(0, 4).toString('hex'), '1a45dfa3', 'Finalized recording is a WebM container');
  else assert.equal(actualVideo.subarray(4, 8).toString(), 'ftyp', 'Finalized recording is an MP4 container');
  console.log('PASS real Packing screen: cached load during server-version mismatch, fake camera, barcode capture, weight confirmation, local video finalization and next box');
  console.log('Fixture data retained for inspection:', fixtureRoot);
})().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  await closeApp();
  for (const task of pending.values()) clearTimeout(task.timer);
  server.closeAllConnections();
  server.close();
});
