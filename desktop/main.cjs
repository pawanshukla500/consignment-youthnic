const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, Menu, ipcMain, net, protocol, safeStorage } = require('electron');
const { openDatabase } = require('./src/database.cjs');
const { LocalFiles } = require('./src/files.cjs');
const { createLogger } = require('./src/logger.cjs');
const { BackendClient } = require('./src/backendClient.cjs');
const { SyncEngine } = require('./src/syncEngine.cjs');
const { registerIpc } = require('./src/ipc.cjs');

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
}]);

let mainWindow = null;
let database = null;
let files = null;
let sync = null;
let logger = null;
let sessionPath = null;
if (process.env.YOUTHNIC_PACKING_DATA_DIR) {
  const dataDirectory = path.resolve(process.env.YOUTHNIC_PACKING_DATA_DIR);
  fs.mkdirSync(dataDirectory, { recursive: true });
  app.setPath('userData', dataDirectory);
}
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
app.on('second-instance', () => { mainWindow?.show(); mainWindow?.focus(); });

async function registerRendererProtocol() {
  const rendererRoot = path.resolve(__dirname, 'renderer');
  await protocol.handle('app', async (request) => {
    const requestUrl = new URL(request.url);
    if (requestUrl.hostname !== 'youthnic') return new Response('Not found', { status: 404 });
    if (requestUrl.hostname === 'youthnic' && (requestUrl.pathname === '/api' || requestUrl.pathname.startsWith('/api/'))) {
      const apiPath = requestUrl.pathname.slice('/api'.length) || '/';
      const upstreamUrl = `${buildApiUrl()}${apiPath}${requestUrl.search}`;
      const headers = {};
      for (const [name, value] of request.headers.entries()) headers[name] = value;
      headers['x-station-id'] = database?.ensureStation().station_id || '';
      // The main process is the API client. Do not forward the renderer's
      // custom app:// origin to the upstream server, so older deployments
      // without desktop CORS support also continue to work.
      for (const header of ['origin', 'referer', 'host', 'content-length', 'connection']) delete headers[header];
      const hasBody = !['GET', 'HEAD'].includes(request.method);
      try {
        // Buffer avoids Electron/Chromium treating the protocol request body
        // as a one-shot stream when it is handed to net.fetch.
        const body = hasBody ? Buffer.from(await request.arrayBuffer()) : undefined;
        return await net.fetch(upstreamUrl, { method: request.method, headers, body });
      } catch (error) {
        // Do not let an upstream transport error become an opaque renderer
        // failure. The frontend already maps 502 to its retryable service
        // message; this log contains no credentials or request body.
        logger?.warn('api.proxy_failed', {
          method: request.method,
          path: apiPath,
          message: error.message,
          code: error.code || 'unknown',
        });
        return new Response(JSON.stringify({ error: 'Desktop API proxy could not reach the application service.', code: 'DESKTOP_API_PROXY_FAILED' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        });
      }
    }

    let relativePath;
    try {
      relativePath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '') || 'index.html';
    } catch (_) {
      return new Response('Invalid renderer path', { status: 400 });
    }

    const candidate = path.resolve(rendererRoot, relativePath);
    const relative = path.relative(rendererRoot, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(candidate).toString());
  });
}

function restoreToken() {
  if (!sessionPath || !safeStorage.isEncryptionAvailable()) return null;
  try {
    const encrypted = fs.readFileSync(sessionPath);
    const stored = safeStorage.decryptString(encrypted);
    try { return JSON.parse(stored); } catch (_) { return { token: stored, user: null }; }
  } catch (error) {
    logger?.warn('auth.restore_failed', { message: error.message });
    return null;
  }
}

function persistToken(token, user = null) {
  if (!sessionPath) return;
  if (!token) {
    try { fs.rmSync(sessionPath, { force: true }); } catch (error) { logger?.warn('auth.clear_failed', { message: error.message }); }
    return;
  }
  if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
    logger?.warn('auth.not_persisted', { reason: 'electron_safe_storage_unavailable' });
    throw new Error('Secure credential storage is unavailable on this computer');
  }
  try {
    const temporary = `${sessionPath}.tmp`;
    const fd = fs.openSync(temporary, 'w', 0o600);
    try {
      fs.writeFileSync(fd, safeStorage.encryptString(JSON.stringify({ token: String(token), user })));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, sessionPath);
  } catch (error) {
    logger?.warn('auth.persist_failed', { message: error.message });
    throw error;
  }
}

function buildApiUrl() {
  const configured = process.env.YOUTHNIC_PACKING_API_URL || process.env.VITE_API_URL;
  if (!configured) return 'https://consignment.youthnic.shop/api';
  return configured.endsWith('/api') ? configured : `${configured.replace(/\/$/, '')}/api`;
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    show: false,
    backgroundColor: '#f8fafc',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = process.env.YOUTHNIC_PACKING_DEV_URL || process.env.ELECTRON_START_URL || 'app://youthnic';
    const target = new URL(url);
    const trusted = new URL(allowed);
    if (target.protocol !== trusted.protocol || target.host !== trusted.host) event.preventDefault();
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  const devUrl = process.env.YOUTHNIC_PACKING_DEV_URL || process.env.ELECTRON_START_URL;
  if (devUrl) {
    await mainWindow.loadURL(devUrl);
  } else {
    await mainWindow.loadURL('app://youthnic/index.html');
  }
}

async function bootstrap() {
  Menu.setApplicationMenu(null);
  await registerRendererProtocol();
  const userData = app.getPath('userData');
  logger = createLogger(path.join(userData, 'YouthnicPacking', 'logs'));
  database = openDatabase(path.join(userData, 'YouthnicPacking', 'database', 'packing.sqlite'), { logger });
  files = new LocalFiles(path.join(userData, 'YouthnicPacking'), { logger });
  sessionPath = path.join(userData, 'YouthnicPacking', 'session.bin');
  const client = new BackendClient({ baseUrl: buildApiUrl(), logger });
  sync = new SyncEngine({ database, files, client, logger, onStatus: (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop-sync-status', status);
  } });
  const restored = restoreToken();
  sync.setToken(restored?.token || null);
  sync.user = restored?.user || null;
  registerIpc({ ipcMain, app, database, files, sync, logger, persistToken, sessionPath });
  await files.ensureRoot();
  await files.recoverIncompleteRecordings();
  await createWindow();
}

app.whenReady().then(() => { if (ownsInstance) return bootstrap(); }).catch((error) => {
  console.error('[YouthnicPacking] bootstrap failed', error);
  app.quit();
});

app.on('window-all-closed', () => {
  sync?.stop();
  database?.close();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow().catch((error) => console.error(error));
});
