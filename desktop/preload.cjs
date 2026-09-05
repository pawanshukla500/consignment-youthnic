const { contextBridge, ipcRenderer } = require('electron');

function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload);
}

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('youthnicDesktop', {
  app: {
    apiUrl: (() => {
      const devUrl = process.env.YOUTHNIC_PACKING_DEV_URL || process.env.ELECTRON_START_URL;
      if (devUrl) {
        const configured = process.env.YOUTHNIC_PACKING_API_URL || process.env.VITE_API_URL || '';
        if (!configured) return '';
        return configured.endsWith('/api') ? configured : `${configured.replace(/\/$/, '')}/api`;
      }
      const configured = 'app://youthnic/api';
      return configured.endsWith('/api') ? configured : `${configured.replace(/\/$/, '')}/api`;
    })(),
    info: () => invoke('desktop:app-info'),
  },
  auth: {
    getSession: () => invoke('desktop:auth-get-session'),
    setSession: (payload) => invoke('desktop:auth-set-session', payload),
    clearSession: () => invoke('desktop:auth-clear-session'),
  },
  station: {
    get: () => invoke('desktop:station-get'),
    update: (payload) => invoke('desktop:station-update', payload),
  },
  storage: {
    health: () => invoke('desktop:storage-health'),
  },
  packing: {
    checkBackend: () => invoke('desktop:packing-check-backend'),
    saveSnapshot: (payload) => invoke('desktop:packing-save-snapshot', payload),
    getSnapshot: (consignmentId) => invoke('desktop:packing-get-snapshot', { consignmentId }),
    listCachedConsignments: () => invoke('desktop:packing-list-cached'),
    openBox: (payload) => invoke('desktop:packing-open-box', payload),
    recordScan: (payload) => invoke('desktop:packing-record-scan', payload),
    undoScan: (payload) => invoke('desktop:packing-undo-scan', payload),
    discardEmptyBox: (payload) => invoke('desktop:packing-discard-empty', payload),
    closeBox: (payload) => invoke('desktop:packing-close-box', payload),
    status: (consignmentId) => invoke('desktop:packing-status', { consignmentId }),
    finishReadiness: (consignmentId) => invoke('desktop:packing-finish-readiness', { consignmentId }),
    claimLease: (payload) => invoke('desktop:packing-claim-lease', payload),
    releaseLease: (payload) => invoke('desktop:packing-release-lease', payload),
  },
  video: {
    start: (payload) => invoke('desktop:video-start', payload),
    appendChunk: (payload) => invoke('desktop:video-append-chunk', payload),
    finalize: (payload) => invoke('desktop:video-finalize', payload),
    recover: () => invoke('desktop:video-recover'),
  },
  files: {
    writeProof: (payload) => invoke('desktop:file-write-proof', payload),
  },
  sync: {
    start: () => invoke('desktop:sync-start'),
    stop: () => invoke('desktop:sync-stop'),
    retry: () => invoke('desktop:sync-retry'),
    status: () => invoke('desktop:sync-status'),
    onStatus: (callback) => subscribe('desktop-sync-status', callback),
  },
});
