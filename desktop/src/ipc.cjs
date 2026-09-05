const crypto = require('node:crypto');
const { BackendClient } = require('./backendClient.cjs');

function requiredText(value, name, max = 256) {
  const text = String(value || '').trim();
  if (!text || text.length > max) throw new Error(`${name} is required`);
  return text;
}

function registerIpc({ ipcMain, app, database, files, sync, logger, persistToken, sessionPath }) {
  // Every exposed operation is restricted to the app's main frame. A remote
  // navigation must never inherit the local database or filesystem bridge.
  const rawHandle = ipcMain.handle.bind(ipcMain);
  ipcMain = { handle(channel, handler) {
    rawHandle(channel, async (event, payload = {}) => {
      const target = new URL(event.senderFrame?.url || 'about:blank');
      const trusted = new URL(process.env.YOUTHNIC_PACKING_DEV_URL || process.env.ELECTRON_START_URL || 'app://youthnic');
      if (event.senderFrame !== event.sender.mainFrame || target.protocol !== trusted.protocol || target.host !== trusted.host) throw new Error('Untrusted desktop request');
      if (!channel.startsWith('desktop:auth-') && channel !== 'desktop:app-info') {
        if (!sync.client.token || !sync.user?.id) throw new Error('Sign in to use this station');
        if (!['admin', 'organization_head'].includes(sync.user.role) && sync.user.permissions?.packing !== true) throw new Error('Packing permission is required');
        const cid = payload.consignmentId || payload.consignment_id;
        if (cid) {
          const snapshot = database.getSnapshot(cid);
          if (snapshot?.localSnapshotUserId && snapshot.localSnapshotUserId !== sync.user.id) throw new Error('This consignment has local work belonging to a different operator');
        }
      }
      return handler(event, payload);
    });
  } };
  ipcMain.handle('desktop:app-info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    userData: app.getPath('userData'),
  }));

  ipcMain.handle('desktop:auth-set-session', async (_event, payload = {}) => {
    const token = requiredText(payload.token, 'token', 8192);
    // Cache only the backend-verified identity, never a renderer-supplied role.
    const verifier = new BackendClient({ baseUrl: sync.client.baseUrl });
    verifier.setToken(token);
    const { user } = await verifier.request('/auth/me');
    if (!user?.id) throw new Error('Application identity could not be verified');
    persistToken(token, user);
    await sync.setSession({ token, userId: user.id, user });
    sync.start();
    return { ok: true };
  });
  ipcMain.handle('desktop:auth-get-session', () => ({
    token: sync.client?.token || null,
    userId: database.getSetting('sessionUserId') || null,
    user: sync.user || null,
  }));
  ipcMain.handle('desktop:auth-clear-session', async () => {
    sync.stop();
    sync.setToken(null);
    sync.user = null;
    persistToken(null);
    database.setSetting('sessionUserId', null);
    await sync.notify();
    return { ok: true };
  });

  ipcMain.handle('desktop:station-get', () => database.ensureStation());
  ipcMain.handle('desktop:station-update', (_event, payload = {}) => database.updateStation({
    stationName: payload.stationName,
    warehouse: payload.warehouse,
  }));
  ipcMain.handle('desktop:storage-health', () => files.diskHealth());

  ipcMain.handle('desktop:packing-save-snapshot', (_event, payload = {}) => {
    const snapshot = payload.snapshot || payload;
    const cid = snapshot.consignment_id || snapshot.id || snapshot.consignmentId;
    const lease = database.getSetting(`lease:${cid}`);
    if (!lease || lease.stationId !== database.ensureStation().station_id) throw new Error('Claim this consignment online before downloading it for offline use');
    const existing = database.getSnapshot(cid);
    if (existing?.localSnapshotUserId && existing.localSnapshotUserId !== sync.user.id) throw new Error('This consignment belongs to another operator');
    return database.saveSnapshot(snapshot, { userId: sync.user.id });
  });
  ipcMain.handle('desktop:packing-get-snapshot', (_event, payload = {}) => database.getSnapshot(requiredText(payload.consignmentId, 'consignmentId')));
  ipcMain.handle('desktop:packing-list-cached', () => database.listCachedConsignments().filter((item) => database.getSnapshot(item.consignmentId)?.localSnapshotUserId === sync.user.id));
  ipcMain.handle('desktop:packing-undo-scan', (_event, payload = {}) => database.undoScan({ consignmentId: requiredText(payload.consignmentId, 'consignmentId'), boxNo: requiredText(payload.boxNo, 'boxNo'), skuId: requiredText(payload.skuId, 'skuId'), eventId: requiredText(payload.eventId, 'eventId') }));
  ipcMain.handle('desktop:packing-discard-empty', (_event, payload = {}) => database.discardEmptyBox(payload));
  ipcMain.handle('desktop:packing-open-box', (_event, payload = {}) => database.openBox({
    consignmentId: requiredText(payload.consignmentId, 'consignmentId'),
    boxNo: requiredText(payload.boxNo, 'boxNo', 32),
  }));
  ipcMain.handle('desktop:packing-record-scan', (_event, payload = {}) => database.recordScan({
    consignmentId: requiredText(payload.consignmentId, 'consignmentId'),
    boxNo: requiredText(payload.boxNo, 'boxNo', 32),
    scanId: requiredText(payload.scanId || crypto.randomUUID(), 'scanId', 128),
    barcode: requiredText(payload.barcode, 'barcode', 256),
    qty: payload.qty,
    capturedAt: payload.capturedAt,
    sequenceNo: payload.sequenceNo,
  }));
  ipcMain.handle('desktop:packing-close-box', async (_event, payload = {}) => {
    await files.validateEvidence(payload.video, payload.consignmentId, payload.boxNo, 'video');
    if (payload.weightProof) await files.validateEvidence(payload.weightProof, payload.consignmentId, payload.boxNo, 'proof');
    return database.closeBox({
    consignmentId: requiredText(payload.consignmentId, 'consignmentId'),
    boxNo: requiredText(payload.boxNo, 'boxNo', 32),
    operationId: requiredText(payload.operationId || `${database.ensureStation().station_id}:${payload.consignmentId}:${payload.boxNo}:${crypto.randomUUID()}`, 'operationId', 256),
    items: Array.isArray(payload.items) ? payload.items : [],
    weight: payload.weight,
    weightUnit: payload.weightUnit,
    weightProof: payload.weightProof || null,
    video: payload.video || null,
    });
  });
  ipcMain.handle('desktop:packing-status', (_event, payload = {}) => database.getStatus(payload.consignmentId || null, sync.user.id));
  ipcMain.handle('desktop:packing-finish-readiness', (_event, payload = {}) => database.getFinishReadiness(requiredText(payload.consignmentId, 'consignmentId')));
  ipcMain.handle('desktop:packing-claim-lease', async (_event, payload = {}) => {
    const station = database.ensureStation();
    return sync.claimLease({
      consignment_id: requiredText(payload.consignmentId, 'consignmentId'),
      station_id: station.station_id,
      station_name: station.station_name,
      warehouse: station.warehouse,
    });
  });
  ipcMain.handle('desktop:packing-check-backend', async () => {
    try { return { ok: true, ...(await sync.client.checkCompatibility()) }; }
    catch (error) { return { ok: false, code: error.code, status: error.status, message: error.message }; }
  });
  ipcMain.handle('desktop:packing-release-lease', (_event, payload = {}) => sync.releaseLease(payload));

  ipcMain.handle('desktop:video-start', (_event, payload = {}) => files.startVideo({
    videoId: payload.videoId || crypto.randomUUID(),
    consignmentId: requiredText(payload.consignmentId, 'consignmentId'),
    boxNo: requiredText(payload.boxNo, 'boxNo', 32),
    fileName: payload.fileName,
  }));
  ipcMain.handle('desktop:video-append-chunk', (_event, payload = {}) => {
    if (!payload.data || (payload.data.byteLength || payload.data.length || 0) > 16 * 1024 * 1024) throw new Error('Video chunk is missing or too large');
    return files.appendVideoChunk({ videoId: requiredText(payload.videoId, 'videoId', 128), data: payload.data });
  });
  ipcMain.handle('desktop:video-finalize', (_event, payload = {}) => files.finalizeVideo({
    videoId: requiredText(payload.videoId, 'videoId', 128),
    consignmentId: requiredText(payload.consignmentId, 'consignmentId'),
    boxNo: requiredText(payload.boxNo, 'boxNo', 32),
    mimeType: payload.mimeType,
  }));
  ipcMain.handle('desktop:video-recover', () => files.recoverIncompleteRecordings());
  ipcMain.handle('desktop:file-write-proof', (_event, payload = {}) => {
    if (!payload.data || (payload.data.byteLength || payload.data.length || 0) > 16 * 1024 * 1024) throw new Error('Proof file is missing or too large');
    return files.writeProof({
      proofId: payload.proofId || crypto.randomUUID(),
      consignmentId: requiredText(payload.consignmentId, 'consignmentId'),
      boxNo: requiredText(payload.boxNo, 'boxNo', 32),
      fileName: payload.fileName,
      data: payload.data,
    });
  });

  ipcMain.handle('desktop:sync-start', () => { sync.start(); return sync.notify(); });
  ipcMain.handle('desktop:sync-stop', () => { sync.stop(); return { ok: true }; });
  ipcMain.handle('desktop:sync-retry', () => sync.retry());
  ipcMain.handle('desktop:sync-status', () => ({ ...database.getStatus(null, sync.user.id), online: sync.online, lastError: sync.lastError || null, lastSyncAt: sync.lastSyncAt }));

  logger?.info('station.ipc_ready', { sessionPath });
}

module.exports = { registerIpc };
