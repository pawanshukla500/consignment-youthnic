import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { flushSync } from 'react-dom';
import { useNavigate } from 'react-router';
import { packingAPI, settingsAPI, uploadsAPI } from '../services/api';
import api from '../services/api';
import {
  getQueueCount,
  startRecordingSession,
  appendRecordingChunk,
  markRecordingSessionStorageFailed,
  inspectChunkWriteSettlements,
  canStartRecordingSafely,
} from '../utils/videoQueue';
import {
  processVideoUploadQueue,
  subscribeVideoUploadStatus,
  finalizeRecordingSessionInWorker,
  isTerminalSuccess,
} from '../services/videoUploadService';
import { VIDEO_STATUS, VIDEO_UPLOAD_CONFIG } from '../utils/videoUploadConfig'
import {
  requestPersistentStorage,
  estimateBrowserStorage,
  isStorageInsufficient,
  formatStorageMessage,
  MIN_RECOMMENDED_FREE_MB,
} from '../utils/browserStorage';
import { escapeHtml, openEscapedPrintWindow } from '../utils/printHtml';
import { enqueueScan, drainScanQueue, getPendingScanCount, getFailedScanCount, resetFailedScans, warmScanQueueDb } from '../utils/scanQueue';
import { enqueueSaveBoxJob, drainPackingSyncQueue, getPendingSyncJobCount, getFailedSyncJobCount, resetFailedSyncJobs } from '../utils/packingSyncQueue';
import { processSaveBoxJob } from '../utils/saveBoxSyncHelper';
import { useConsignmentSync } from '../context/ConsignmentSyncContext';
import { getShipmentPriority, sortByPriority, formatAppointmentDate, formatDispatchDate } from '../utils/priority';
import { getCriticalityCardClass, getDisplayLabel } from '../utils/criticalityUi';
import UnitsProgressCell from '../components/UnitsProgressCell';
import QuantityRemovalModal from '../components/QuantityRemovalModal';
import { ArrowLeft, Boxes, Upload, X, Loader2 } from 'lucide-react';
import { describeCameraError, startCameraPreview, stopMediaStream } from '../utils/camera';
import {
  pickRecordingBitrate,
  VIDEO_SIZE_WARN_MB,
  VIDEO_SIZE_HIGH_MB,
} from '../utils/videoRecordingProfile';
import { useStorageUpload } from '../hooks/useStorageUpload';
import { posthog, isPosthogConfigured } from '../utils/posthog';
import {
  isValidBarcode,
  barcodeValidationMessage,
  normalizeBarcodeInput,
  createScannerInputGuard,
  resolveQueueBarcode,
  getMarketplaceBarcode,
  barcodeMatchesSku,
} from '../utils/barcodeInput';
import { recomputeSkuTotals, getShipmentQtySummary } from '../utils/packingQuantities';

function getScanMessage(reason, data = {}) {
  if (data.extra_item || (reason === 'not_found' && data.all_complete)) {
    return 'Extra item — shipment already complete';
  }
  if (reason === 'not_found') return `Not in shipment: ${data.barcode || ''}`.trim();
  if (reason === 'locked') return `Already complete (${data.packed ?? '?'}/${data.required ?? '?'})`;
  if (reason === 'over_limit') return `Cannot exceed required qty (${data.required ?? '?'})`;
  if (reason === 'invalid_barcode') return data.message || 'Invalid barcode';
  return data.message || 'Scan rejected';
}

/* ═══ SOUND ENGINE (reference: packing-sync-sounds) ═══ */
const sfx = (() => {
  let ctx = null;
  function ac() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  }
  function beep(freq, type, dur, vol, sd, fe) {
    const a = ac(), o = a.createOscillator(), g = a.createGain();
    o.connect(g); g.connect(a.destination);
    const t = a.currentTime + sd;
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (fe !== undefined) o.frequency.exponentialRampToValueAtTime(fe, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.start(t); o.stop(t + dur);
  }
  return {
    cid: () => { beep(660, 'sine', .12, .42, 0); beep(990, 'sine', .16, .38, .12); },
    box: () => { beep(440, 'triangle', .1, .48, 0, 500); },
    ok: () => { beep(920, 'sine', .045, .48, 0); beep(1380, 'sine', .065, .42, .05); },
    warn: () => { beep(420, 'square', .055, .52, 0); beep(420, 'square', .055, .52, .075); beep(300, 'sawtooth', .1, .48, .15); },
    err: () => { beep(220, 'sawtooth', .07, .58, 0); beep(160, 'sawtooth', .09, .52, .085); },
  };
})();

function resolveScanSound(reason, data = {}) {
  if (reason === 'ok' || reason === 'success') return 'ok';
  if (reason === 'locked' || reason === 'over_limit' || (reason === 'not_found' && data.extra_item)) return 'warn';
  if (reason === 'not_found' || reason === 'invalid_barcode') return 'err';
  return 'warn';
}

function playScanSound(reason, data = {}) {
  const key = resolveScanSound(reason, data);
  if (typeof sfx[key] === 'function') sfx[key]();
}

function primeScanAudio() {
  try {
    const a = new (window.AudioContext || window.webkitAudioContext)();
    if (a.state === 'suspended') void a.resume();
    a.close();
  } catch (_) {}
}

/* ═══ TOAST ═══ */
function useToasts() {
  const [toasts, setToasts] = useState([]);
  const toast = useCallback((message, type = 'info', dur = 3000) => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), dur);
  }, []);
  const removeToast = useCallback((id) => setToasts(prev => prev.filter(t => t.id !== id)), []);
  return { toasts, toast, removeToast };
}

const ToastContainer = ({ toasts, onRemove }) => (
  <div className="fixed bottom-3 right-3 z-[9999] flex flex-col-reverse gap-[5px] max-w-[320px]">
    {toasts.map(t => (
      <div key={t.id} onClick={() => onRemove(t.id)}
        className={`px-3 py-2 rounded-lg text-[11px] font-medium flex items-center gap-1.5 shadow-lg cursor-pointer animate-[slideIn_.3s] border bg-white
          ${t.type==='success'?'border-l-[3px] border-l-emerald-500':''}
          ${t.type==='error'?'border-l-[3px] border-l-red-500':''}
          ${t.type==='warning'?'border-l-[3px] border-l-amber-500':''}
          ${t.type==='info'?'border-l-[3px] border-l-blue-500':''}`}>
        {t.type==='success'&&'✅'}{t.type==='error'&&'❌'}{t.type==='warning'&&'⚠️'}{t.type==='info'&&'ℹ️'}
        <span>{t.message}</span>
      </div>
    ))}
  </div>
);

/* ═══ MODAL ═══ */
function Modal({ show, title, children, onClose, actions, wide }) {
  if (!show) return null;
  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-4 overflow-y-auto"
      style={{ background: 'rgba(15, 23, 42, 0.35)', backdropFilter: 'blur(8px)' }}
      onMouseDown={onClose}
    >
      <div
        className={`bg-white rounded-2xl shadow-2xl border border-slate-200/80 w-full animate-pop-in overflow-hidden flex flex-col ${wide ? 'max-w-[520px]' : 'max-w-[420px]'}`}
        onMouseDown={e => e.stopPropagation()}
      >
        {/* Top brand accent bar */}
        <div className="h-1 w-full bg-gradient-to-r from-primary-500 via-primary-600 to-primary-700 flex-shrink-0" />

        <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between gap-4">
          <h3 className="text-sm font-extrabold text-slate-900 flex items-center gap-2">
            <span className="w-1 h-4 rounded bg-primary-600 shrink-0" />
            {title}
          </h3>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors border border-slate-200/60 bg-white shadow-sm"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <div className="p-5 text-[12.5px] text-slate-600 leading-relaxed bg-white overflow-y-auto max-h-[60vh]">
          {children}
        </div>
        {actions && (
          <div className="px-5 py-3 border-t border-slate-100 flex flex-wrap gap-2 justify-end bg-slate-50/50">
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}
/* ═══ MAIN COMPONENT ═══ */
export default function PackingStation() {
  const navigate = useNavigate();
  const { toasts, toast, removeToast } = useToasts();
  const { progress: weightUploadProgress, uploading: weightUploading } = useStorageUpload();

  // State
  const [showWeightModal, setShowWeightModal] = useState(false);
  const [weightModalData, setWeightModalData] = useState(null);
  const [S, setS] = useState({ cid: null, intShip: null, box: null, skus: [], boxes: {} });
  const [skuFilter, setSkuFilter] = useState('all');
  const [loading, setLoading] = useState(false);
  const [showMo, setShowMo] = useState(false);
  const [moConfig, setMoConfig] = useState({ title: '', body: '', actions: null, wide: false });
  const [removalModal, setRemovalModal] = useState({ open: false, boxNo: null, stream: null });
  const [showLabelModal, setShowLabelModal] = useState(false);
  const [showResumeModal, setShowResumeModal] = useState(false);
  const [resumeList, setResumeList] = useState([]);
  const [showDashboard, setShowDashboard] = useState(false);
  const [dashData] = useState(null);
  const [syncState, setSyncState] = useState('synced');
  const [recState, setRecState] = useState('STANDBY');
  const [recDuration, setRecDuration] = useState('00:00');
  const [recSize, setRecSize] = useState('0 MB');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [showUpload, setShowUpload] = useState(false);
  const [camRes, setCamRes] = useState('—');
  const [camActive, setCamActive] = useState(false);
  const [cameraStarting, setCameraStarting] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [zone, setZone] = useState(1);
  const [uploading]      = useState(false);
  const [pendingUploads, setPendingUploads]  = useState(0);
  const [currentVideoUpload, setCurrentVideoUpload] = useState(null);
  /** Live per-box upload statuses from the background worker (queued→…→completed/failed). */
  const [boxVideoStatuses, setBoxVideoStatuses] = useState([]);
  const [pendingScanJobs, setPendingScanJobs] = useState(0);
  const [pendingSaveJobs, setPendingSaveJobs] = useState(0);
  const [failedSyncJobs, setFailedSyncJobs] = useState(0);
  const [consignmentList,setConsignmentList] = useState([]);
  const [loadMeta, setLoadMeta] = useState(null);
  const cidRef = useRef(null);
  const stateRef = useRef(S);
  const [uploadLog,      setUploadLog]       = useState([]);   // [{name, status, progress}]
  const [showUploadLog,  setShowUploadLog]   = useState(false);
  const [gridEnabled, setGridEnabled] = useState(true);
  const [floatingCamera, setFloatingCamera] = useState(false);
  const [packingAllowPaste, setPackingAllowPaste] = useState(true);
  const gridEnabledRef = useRef(true);
  const lastInstantOkRef = useRef({ barcode: '', at: 0 });

  useEffect(() => {
    settingsAPI.getPackingConfig()
      .then((res) => setPackingAllowPaste(Boolean(res.data?.packingAllowPaste)))
      .catch(() => setPackingAllowPaste(false));
  }, []);

  useEffect(() => {
    if (zone !== 3) return;
    settingsAPI.getPackingConfig()
      .then((res) => setPackingAllowPaste(Boolean(res.data?.packingAllowPaste)))
      .catch(() => {});
    primeScanAudio();
    void warmScanQueueDb();
  }, [zone]);

  useEffect(() => {
    gridEnabledRef.current = gridEnabled;
  }, [gridEnabled]);

  // Refs
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const recordingSessionIdRef = useRef(null);
  const chunkIndexRef = useRef(0);
  const pendingChunkWritesRef = useRef([]);
  const recordedBytesRef = useRef(0);
  const sizeWarnRef = useRef(null);
  const recTimerRef = useRef(null);
  const recStartRef = useRef(0);
  const _offCanvasRef = useRef(null);
  const composeIntervalRef = useRef(null);
  const animFrameRef = useRef(null);
  const recBoxIdRef = useRef(null);
  const recCidRef = useRef(null);
  const recIntShipRef = useRef(null);
  const inCidRef = useRef(null);
  const inBoxRef = useRef(null);
  const inSkuRef = useRef(null);
  const composeFrameRef = useRef(null);
  const uploadingQueueRef = useRef(false);
  const scannerGuardRef = useRef(createScannerInputGuard());
  const scanSubmitLockRef = useRef(false);
  const pendingScanBarcodeRef = useRef(null);
  const scanToastDedupRef = useRef({ message: '', at: 0 });
  const { pendingChanges } = useConsignmentSync();

  const scanToast = useCallback((message, type = 'info', dur = 3000) => {
    const now = Date.now();
    if (
      scanToastDedupRef.current.message === message
      && now - scanToastDedupRef.current.at < 2000
    ) return;
    scanToastDedupRef.current = { message, at: now };
    toast(message, type, dur);
  }, [toast]);

  const commitPackingState = useCallback((updater, { syncSkus = true, flush = false } = {}) => {
    const applyUpdate = (prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      const synced = syncSkus
        ? { ...next, skus: recomputeSkuTotals(next.skus || [], next.boxes || {}) }
        : next;
      stateRef.current = synced;
      return synced;
    };
    const run = () => {
      if (typeof updater === 'function') {
        setS((prev) => applyUpdate(prev));
      } else {
        setS(applyUpdate(updater));
      }
    };
    if (flush) flushSync(run);
    else run();
  }, []);

  useEffect(() => {
    stateRef.current = S;
  }, [S]);

  const filteredSkus = useMemo(() => {
    let next = S.skus;
    if (skuFilter === 'pending') next = next.filter((s) => s.remaining > 0);
    else if (skuFilter === 'done') next = next.filter((s) => s.remaining === 0);
    else if (skuFilter === 'current' && S.box) {
      const bcs = (S.boxes[S.box] || []).map((i) => i.marketplaceSku);
      next = next.filter((s) => bcs.includes(s.marketplaceSku));
    }
    return [...next].sort((a, b) => {
      const ad = a.packed >= a.required ? 1 : 0;
      const bd = b.packed >= b.required ? 1 : 0;
      if (ad !== bd) return ad - bd;
      return b.remaining - a.remaining;
    });
  }, [S.skus, S.box, S.boxes, skuFilter]);

  // Theme — disabled, uses app standard theme
  useEffect(() => {
    document.body.dataset.theme = 'light';
  }, []);

  // Check resume on mount + start background upload queue
  useEffect(() => {
    checkResume();
    fetchConsignments();
    updatePendingCount();
    const si = setInterval(() => checkSyncStatus(cidRef.current), 8000);
    const unsubVideo = subscribeVideoUploadStatus(({ pending, current, uploading, items }) => {
      setPendingUploads(pending);
      setCurrentVideoUpload(current || null);
      setShowUpload(Boolean(uploading || current || pending > 0));
      setUploadProgress(Number(current?.progress) || 0);
      if (Array.isArray(items)) setBoxVideoStatuses(items);
    });
    const handleOnline = () => runPendingSync(false);
    const handleOffline = () => setSyncState('offline');
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    const onProgress = (e) => {
      setUploadLog(prev => prev.map(l => l.id === e.detail.id ? {
        ...l,
        status: e.detail.status || 'uploading',
        progress: e.detail.progress,
      } : l));
    };
    const onStatus = (e) => {
      setUploadLog((prev) => {
        const idx = prev.findIndex((l) => l.id === e.detail.id)
        const row = {
          id: e.detail.id,
          name: e.detail.fileName || `box_${e.detail.boxNo}.webm`,
          boxNo: e.detail.boxNo,
          status: e.detail.status || 'queued',
          progress: e.detail.progress || 0,
          error: e.detail.lastError || null,
        }
        if (idx < 0) return [...prev, row]
        const next = [...prev]
        next[idx] = { ...next[idx], ...row }
        return next
      })
    };
    const onDone = (e) => {
      setUploadLog(prev => prev.map(l => l.id === e.detail.id ? { ...l, status: 'completed', progress: 100 } : l));
      toast(`Video verified: Box #${e.detail.metadata.boxNo}`, 'success');
    };
    const onError = (e) => {
      setUploadLog(prev => prev.map(l => l.id === e.detail.id ? {
        ...l,
        status: e.detail.isFailed ? 'failed' : 'retrying',
        error: e.detail.error || 'Upload failed',
      } : l));
    };

    window.addEventListener('video-upload-progress', onProgress);
    window.addEventListener('video-upload-status', onStatus);
    window.addEventListener('video-upload-done', onDone);
    window.addEventListener('video-upload-error', onError);

    Promise.all([getPendingScanCount(), getPendingSyncJobCount(), getQueueCount()])
      .then(([scans, saveJobs, videos]) => { if (scans + saveJobs + videos > 0) runPendingSync(false); });
    return () => {
      clearInterval(si);
      unsubVideo();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('video-upload-progress', onProgress);
      window.removeEventListener('video-upload-status', onStatus);
      window.removeEventListener('video-upload-done', onDone);
      window.removeEventListener('video-upload-error', onError);
    };
  }, []);

  useEffect(() => {
    if (syncState !== 'pending' && syncState !== 'failed') return undefined;
    const timer = setInterval(() => { void updatePendingCount(); }, 2000);
    return () => clearInterval(timer);
  }, [syncState]);

  // Refresh consignment picker when statuses change elsewhere — ignore own scan echoes
  useEffect(() => {
    if (!pendingChanges.length) return undefined;
    const relevant = pendingChanges.some((ch) => {
      if (!ch) return false;
      if (ch.realtimeType === 'packing_scan') return false;
      if (S.cid && ch.id === S.cid && zone === 3) return false;
      return true;
    });
    if (relevant) fetchConsignments();
  }, [pendingChanges]);

  const updatePendingCount = async () => {
    try {
      const [{ getFailedCount }, videos, scans, saveJobs, failedScans, failedSaveJobs] = await Promise.all([
        import('../utils/videoQueue'),
        getQueueCount(),
        getPendingScanCount(),
        getPendingSyncJobCount(),
        getFailedScanCount(),
        getFailedSyncJobCount(),
      ]);
      const failedVideos = await getFailedCount();
      setPendingUploads(videos);
      setPendingScanJobs(scans);
      setPendingSaveJobs(saveJobs);
      setFailedSyncJobs(failedScans + failedSaveJobs + failedVideos);
      if (!navigator.onLine) setSyncState('offline');
      else if (failedScans + failedSaveJobs + failedVideos > 0) setSyncState('failed');
      else if (videos + scans + saveJobs > 0) setSyncState('pending');
      else setSyncState('synced');
    } catch (e) {
      console.warn('[Sync] Could not read pending queues:', e.message);
    }
  };

  const processVideoQueue = async (showLog = false) => {
    if (uploadingQueueRef.current) return;
    uploadingQueueRef.current = true;
    try {
      let pending = await getQueueCount();
      if (pending === 0 && !showLog) return;
      setPendingUploads(pending);

      if (showLog) {
        const {
          getOutstandingVideos,
          unlockOutstandingForImmediateRetry,
          pruneDuplicateBoxVideos,
        } = await import('../utils/videoQueue');
        await pruneDuplicateBoxVideos().catch(() => 0);
        await unlockOutstandingForImmediateRetry();
        const videos = await getOutstandingVideos();
        pending = videos.length;
        if (pending === 0) {
          setUploadLog([]);
          setShowUploadLog(false);
          setPendingUploads(0);
          return;
        }
        setPendingUploads(pending);
        setUploadLog(videos.map((v) => ({
          id: v.id,
          name: v.metadata.fileName,
          boxNo: v.metadata.boxNo,
          status: v.status === 'failed' ? 'error' : 'queued',
          progress: 0,
          error: v.lastError || null,
        })));
        setShowUploadLog(true);
      }

      await processVideoUploadQueue({ retryFailed: showLog, wait: showLog, forceNow: showLog });
      await updatePendingCount();
    } finally {
      uploadingQueueRef.current = false;
    }
  };

  const checkSyncStatus = async (consignmentId) => {
    try {
      const r = await packingAPI.syncStatus(consignmentId || undefined);
      setSyncState(navigator.onLine ? r.data.state : 'offline');
      if (consignmentId && r.data.consignment) {
        const c = r.data.consignment;
        setLoadMeta((prev) => ({
          ...prev,
          internalShipmentNo: c.internalShipmentNo || prev?.internalShipmentNo,
          appointmentDate: c.appointmentDate || prev?.appointmentDate,
          requiredDispatchDate: c.requiredDispatchDate || c.scheduledDispatchDate,
          scheduledDispatchDate: c.scheduledDispatchDate,
          transitDays: c.transitDays,
          priorityLevel: c.priorityLevel,
          priorityLabel: c.priorityLabel,
          prioritySublabel: c.prioritySublabel,
          readinessStatus: c.readinessStatus,
          totalPackedQty: r.data.totals?.totalPackedQty ?? c.totalPackedQty,
          totalRequiredQty: r.data.totals?.totalRequiredQty ?? c.totalRequiredQty,
          boxCount: r.data.totals?.boxCount ?? 0,
        }));
        const pendingScans = await getPendingScanCount();
        if (r.data.skus?.length && pendingScans === 0) {
          commitPackingState((prev) => {
            if (prev.cid !== consignmentId) return prev;
            const mergedBoxes = { ...(r.data.boxes || {}), ...prev.boxes };
            return { ...prev, boxes: mergedBoxes };
          });
        }
      }
      await updatePendingCount();
    } catch (e) {
      setSyncState(navigator.onLine ? 'failed' : 'offline');
      await updatePendingCount();
    }
  };

  const checkResume = async () => {
    try {
      const r = await packingAPI.resumeSession();
      if (r.data.available && r.data.consignments?.length) {
        setResumeList(r.data.consignments);
        setShowResumeModal(true);
      }
    } catch (e) {}
  };

  const fetchConsignments = async () => {
    try {
      const { data } = await api.get('/consignments?status=pending,in_progress&sort=dispatch&limit=200');
      setConsignmentList(sortByPriority(data.consignments || []));
    } catch (e) {}
  };

  const sortedConsignmentList = consignmentList;

  const goBack = () => navigate('/consignments');

  const stopComposeLoop = () => {
    if (composeFrameRef.current && videoRef.current?.cancelVideoFrameCallback) {
      videoRef.current.cancelVideoFrameCallback(composeFrameRef.current);
    }
    composeFrameRef.current = null;
    clearInterval(composeIntervalRef.current);
    composeIntervalRef.current = null;
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
  };

  const setZoneState = (n) => {
    setZone(n);
    setTimeout(() => {
      if (n === 1) inCidRef.current?.focus();
      if (n === 2) inBoxRef.current?.focus();
      if (n === 3) inSkuRef.current?.focus();
    }, 100);
  };

  // Pre-warm webcam when the packing station opens so permission is ready before box entry.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!streamRef.current && !cameraStarting) startCamera();
    }, 400);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const flushRecordingOnLeave = () => {
      try {
        if (recTimerRef.current) clearInterval(recTimerRef.current);
        recTimerRef.current = null;
        // Keep camera tracks alive until MediaRecorder emits the final chunk.
        if (mediaRecorderRef.current?.state === 'recording' || recordingSessionIdRef.current) {
          void stopRecording(true).catch((e) => console.warn('[Video] leave finalize failed:', e));
        }
      } catch (e) {
        console.warn('[Video] leave flush failed:', e);
      }
      stopComposeLoop();
    };
    const killCameraOnUnload = () => {
      stopMediaStream(streamRef.current);
      streamRef.current = null;
    };
    window.addEventListener('pagehide', flushRecordingOnLeave);
    window.addEventListener('beforeunload', flushRecordingOnLeave);
    window.addEventListener('unload', killCameraOnUnload);
    return () => {
      window.removeEventListener('pagehide', flushRecordingOnLeave);
      window.removeEventListener('beforeunload', flushRecordingOnLeave);
      window.removeEventListener('unload', killCameraOnUnload);
      flushRecordingOnLeave();
      killCameraOnUnload();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ═══ CAMERA ═══ */
  const startCamera = async () => {
    if (cameraStarting) return;
    setCameraStarting(true);
    setCameraError('');
    try {
      const videoEl = videoRef.current;
      if (!videoEl) {
        throw new Error('Camera preview is not ready yet. Please try again.')
      }

      const { stream, width, height, profile } = await startCameraPreview({
        videoEl,
        existingStream: streamRef.current,
      })

      streamRef.current = stream;
      const native = `${width || videoEl.videoWidth || '?'}×${height || videoEl.videoHeight || '?'}`
      setCamRes(native);
      setCamActive(true);
      toast(`Camera live (${profile}) ${native} — packing profile 720p@24`, 'success');
      startCanvasOverlay();
    } catch (err) {
      const message = describeCameraError(err);
      setCameraError(message);
      setCamActive(false);
      toast('Camera error: ' + message, 'error', 6000);
    } finally {
      setCameraStarting(false);
    }
  };

  const startCanvasOverlay = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const draw = () => {
      const w = 480, h = 270;
      canvas.width = w; canvas.height = h;
      ctx.clearRect(0, 0, w, h);

      const now = new Date();
      const pz = (n) => String(n).padStart(2, '0');
      const ts = `${pz(now.getDate())}-${pz(now.getMonth()+1)}-${now.getFullYear()} ${pz(now.getHours())}:${pz(now.getMinutes())}:${pz(now.getSeconds())}`;

      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(w - 174, 2, 172, 18);
      ctx.font = '500 9px "JetBrains Mono",monospace';
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'right';
      ctx.fillText(ts, w - 5, 15);
      ctx.textAlign = 'left';

      if (mediaRecorderRef.current?.state === 'recording') {
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(5, 4, 46, 16);
        ctx.beginPath();
        ctx.fillStyle = `rgba(220,38,38,${0.6 + 0.4 * Math.sin(Date.now() / 280)})`;
        ctx.arc(17, 12, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ff4444';
        ctx.font = 'bold 8px "JetBrains Mono",monospace';
        ctx.fillText('REC', 24, 16);
      }

      // Draw grid overlay if enabled
      if (gridEnabledRef.current) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        // Vertical grid lines
        ctx.moveTo(w / 3, 0); ctx.lineTo(w / 3, h);
        ctx.moveTo((w / 3) * 2, 0); ctx.lineTo((w / 3) * 2, h);
        // Horizontal grid lines
        ctx.moveTo(0, h / 3); ctx.lineTo(w, h / 3);
        ctx.moveTo(0, (h / 3) * 2); ctx.lineTo(w, (h / 3) * 2);
        ctx.stroke();

        // Central crosshair
        ctx.strokeStyle = 'rgba(16, 185, 129, 0.4)'; // Subtle green
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(w / 2 - 10, h / 2); ctx.lineTo(w / 2 + 10, h / 2);
        ctx.moveTo(w / 2, h / 2 - 10); ctx.lineTo(w / 2, h / 2 + 10);
        ctx.stroke();
      }

      const currentS = stateRef.current;
      if (currentS && currentS.cid) {
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(0, h - 17, w, 17);
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.font = '8px "JetBrains Mono",monospace';
        const labelText = (currentS.intShip || currentS.cid) + (currentS.box ? ' / Box ' + currentS.box : '');
        ctx.fillText(labelText, 7, h - 5);
      }

      animFrameRef.current = requestAnimationFrame(draw);
    };
    draw();
  };

  const startRecording = async (explicitCid, explicitBox, { reopen = false } = {}) => {
    if (!streamRef.current) { toast('Start camera first', 'warning'); return; }
    if (mediaRecorderRef.current?.state === 'recording') return;

    recordedBytesRef.current = 0;
    sizeWarnRef.current = null;
    chunkIndexRef.current = 0;
    pendingChunkWritesRef.current = [];
    recordingSessionIdRef.current = null;

    const cid = explicitCid || S.cid;
    const box = explicitBox || S.box;

    const mimeCandidates = [
      'video/mp4;codecs=avc1.42E01E',
      'video/mp4',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    let mimeType = '';
    for (const m of mimeCandidates) { if (MediaRecorder.isTypeSupported(m)) { mimeType = m; break; } }
    const actualExt = mimeType.includes('mp4') ? 'mp4' : 'webm';

    // Record the live camera track directly (no canvas re-encode) for smooth FPS.
    const camTrack = streamRef.current.getVideoTracks?.()[0] || null;
    const settings = camTrack?.getSettings?.() || {};
    const width = settings.width || videoRef.current?.videoWidth || 1280;
    const height = settings.height || videoRef.current?.videoHeight || 720;
    const fps = Math.round(Number(settings.frameRate) || 24);
    // Compact bitrate — avoids 50–100MB box videos on long packs
    const bitrate = pickRecordingBitrate(width, height);

    recBoxIdRef.current = box;
    recCidRef.current = cid;
    recIntShipRef.current = S.intShip || cid;

    try {
      const persistResult = await requestPersistentStorage();
      const storageEstimate = await estimateBrowserStorage();
      const backpressure = await canStartRecordingSafely(storageEstimate);
      if (!backpressure.allowed) {
        const detail = [
          ...backpressure.blockers,
          '',
          'Actions:',
          ...backpressure.actions.map((a) => `• ${a}`),
        ].join('\n');
        toast(detail, 'error', 12000);
        return;
      }
      if (isStorageInsufficient(storageEstimate, VIDEO_UPLOAD_CONFIG.minFreeStorageMb || MIN_RECOMMENDED_FREE_MB)) {
        toast(
          `Low browser storage — ${formatStorageMessage(storageEstimate)} Free space before a long recording.`,
          'warning',
          8000
        );
      } else if (persistResult.supported && !persistResult.persisted) {
        toast('Browser may clear video cache under storage pressure — keep this tab open while packing.', 'warning', 6000);
      }

      const fileName = `${cid}_box_${box}_${Date.now()}.${actualExt}`;
      const metadata = {
        fileName,
        mimeType: mimeType || 'video/webm',
        consignmentId: cid,
        boxNo: box,
        description: `Box ${box} packing video`,
        width,
        height,
        fps,
        // Reopening an already-packed box to add more qty: this recording is ADDITIONAL
        // evidence, not a redo — never supersede/replace the box's existing video(s).
        isReopen: reopen,
      };
      if (reopen) toast(`Recording additional video for Box ${box} — the earlier video is kept, not replaced`, 'info', 4500);
      recordingSessionIdRef.current = await startRecordingSession(metadata);
      void uploadsAPI.updateVideoStatus({
        consignmentId: cid,
        boxNo: box,
        status: 'recording',
        queueId: recordingSessionIdRef.current,
      }).catch(() => {});
    } catch (e) {
      console.error('[Video] Failed to start recording session:', e);
      toast('Could not start video recording session', 'error');
      return;
    }

    const recorderOpts = { videoBitsPerSecond: bitrate };
    if (mimeType) recorderOpts.mimeType = mimeType;

    try {
      mediaRecorderRef.current = new MediaRecorder(streamRef.current, recorderOpts);
    } catch (err) {
      console.error('[Video] MediaRecorder init failed:', err);
      const failedSession = recordingSessionIdRef.current;
      recordingSessionIdRef.current = null;
      void uploadsAPI.updateVideoStatus({
        consignmentId: cid,
        boxNo: box,
        status: 'failed',
        queueId: failedSession,
      }).catch(() => {});
      toast('Could not start recorder — try another browser/camera', 'error');
      return;
    }

    mediaRecorderRef.current.ondataavailable = async (e) => {
      if (e.data?.size > 0 && recordingSessionIdRef.current) {
        const idx = chunkIndexRef.current++;
        const write = appendRecordingChunk(recordingSessionIdRef.current, idx, e.data)
          .catch((err) => {
            console.error('[Video] Chunk persist failed:', err);
            throw err;
          });
        pendingChunkWritesRef.current.push(write);
        write.finally(() => {
          pendingChunkWritesRef.current = pendingChunkWritesRef.current.filter((p) => p !== write);
        }).catch(() => {});
        recordedBytesRef.current += e.data.size;
        const mb = recordedBytesRef.current / (1024 * 1024);
        setRecSize(mb.toFixed(1) + ' MB');
        if (!sizeWarnRef.current && mb >= VIDEO_SIZE_WARN_MB) {
          sizeWarnRef.current = 'warn';
          toast(`Box video ~${mb.toFixed(0)} MB — consider NEXT BOX soon for faster sync`, 'warning', 5000);
        } else if (sizeWarnRef.current !== 'high' && mb >= VIDEO_SIZE_HIGH_MB) {
          sizeWarnRef.current = 'high';
          toast(`Box video ~${mb.toFixed(0)} MB — finish this box; upload will continue in background`, 'warning', 6000);
        }
        // Controlled stop before hard max so the video remains uploadable (no silent truncate).
        // Multi-segment continuation requires an approved schema change — see docs/VIDEO_SEGMENT_PROPOSAL.md
        if (
          sizeWarnRef.current !== 'soft_stop'
          && recordedBytesRef.current >= VIDEO_UPLOAD_CONFIG.softStopBytes
        ) {
          sizeWarnRef.current = 'soft_stop';
          toast(
            `Box video reached ~${mb.toFixed(0)} MB (near ${(VIDEO_UPLOAD_CONFIG.maxVideoBytes / (1024 * 1024)).toFixed(0)} MB max). `
            + 'Stopping this segment safely — save/NEXT BOX. Evidence is kept; multi-segment support pending approval.',
            'warning',
            10000
          );
          try {
            if (mediaRecorderRef.current?.state === 'recording') {
              mediaRecorderRef.current.stop();
            }
          } catch (stopErr) {
            console.warn('[Video] Soft-stop failed:', stopErr);
          }
        }
      }
    };
    mediaRecorderRef.current.onerror = (e) => {
      console.error('[Video] MediaRecorder error:', e);
      toast('Video recording error — check camera', 'error');
    };

    recStartRef.current = Date.now();
    recTimerRef.current = setInterval(() => {
      const e = Math.floor((Date.now() - recStartRef.current) / 1000);
      setRecDuration(`${String(Math.floor(e/60)).padStart(2,'0')}:${String(e%60).padStart(2,'0')}`);
    }, 1000);

    // 1s timeslice → crash-safe IndexedDB chunks (background upload after stop)
    mediaRecorderRef.current.start(1000);
    setRecState('REC');
    toast(`Recording Box ${box} · ${width}×${height}@${fps || 24}fps · ~${Math.round(bitrate / 1000)}kbps`, 'info');
  };

  const stopRecording = async (silent = false) => {
    if (!mediaRecorderRef.current || mediaRecorderRef.current.state === 'inactive') {
      // Still finalize any open session left behind after a crashy stop.
      const orphanSession = recordingSessionIdRef.current;
      if (orphanSession) {
        recordingSessionIdRef.current = null;
        try {
          await finalizeRecordingSessionInWorker(orphanSession);
          void processVideoUploadQueue({ wait: false });
          return { queued: true, sessionId: orphanSession };
        } catch (err) {
          if (!silent) toast(err.message || 'Video save failed', 'error');
          throw err;
        }
      }
      if (!silent) toast('Nothing is recording', 'warning');
      return null;
    }
    clearInterval(recTimerRef.current);
    stopComposeLoop();

    return new Promise((resolve, reject) => {
      mediaRecorderRef.current.onstop = async () => {
        setRecState('STANDBY');
        setRecDuration('00:00');
        setRecSize('0 MB');

        const cid = recCidRef.current;
        const box = recBoxIdRef.current;
        const sessionId = recordingSessionIdRef.current;
        recordingSessionIdRef.current = null;

        if (!sessionId) {
          if (!silent) toast('Recording stopped (no data saved)', 'warning');
          resolve(null);
          return;
        }

        try {
          const pendingWrites = pendingChunkWritesRef.current || [];
          let settlements = [];
          if (pendingWrites.length) {
            settlements = await Promise.allSettled(pendingWrites);
          }
          const chunkCheck = inspectChunkWriteSettlements(settlements);
          if (!chunkCheck.ok) {
            const storageEstimate = await estimateBrowserStorage();
            const quotaHint = formatStorageMessage(storageEstimate);
            const reason = chunkCheck.errors[0] || 'IndexedDB chunk write failed';
            await markRecordingSessionStorageFailed(sessionId, reason).catch(() => {});
            void uploadsAPI.updateVideoStatus({
              consignmentId: cid,
              boxNo: box,
              status: 'storage_failed',
              queueId: sessionId,
            }).catch(() => {});
            const err = new Error(
              `Local video save failed (${chunkCheck.failedCount} chunk write error(s)). ${quotaHint} Free browser storage, keep this box open, and re-record.`
            );
            err.code = 'STORAGE_FAILED';
            throw err;
          }

          if (!silent) toast('Saving video safely…', 'info');
          const result = await finalizeRecordingSessionInWorker(sessionId);

          void uploadsAPI.updateVideoStatus({
            consignmentId: cid,
            boxNo: box,
            status: 'queued',
            queueId: result?.queueId || sessionId,
          }).catch(() => {});

          setShowUpload(true);
          void processVideoUploadQueue({ wait: false });

          if (!silent) {
            const mb = result?.size ? `${(result.size / 1024 / 1024).toFixed(1)} MB` : '';
            toast(`Video queued for upload${mb ? ` (${mb})` : ''}`, 'success');
          }
          resolve({ queued: true, sessionId, result });
        } catch (dbErr) {
          console.error('[Video] Finalize failed:', dbErr);
          void uploadsAPI.updateVideoStatus({
            consignmentId: cid,
            boxNo: box,
            status: dbErr.code === 'STORAGE_FAILED' ? 'storage_failed' : 'failed',
            queueId: sessionId,
          }).catch(() => {});
          if (!silent) toast(dbErr.message || 'Video save failed — keep the box open and retry', 'error', 7000);
          reject(dbErr);
        }
      };
      try {
        mediaRecorderRef.current.stop();
      } catch (err) {
        reject(err);
      }
    });
  };

  /** Stop+finalize current box video before advancing.
   *  - requireUploaded=false (NEXT BOX / Save): durable IndexedDB finalize only; cloud upload runs in background
   *  - requireUploaded=true (Done/Finish): wait until cloud upload completes (compliance gate) + show progress popup
   */
  const ensureBoxVideoSafe = async ({ requireUploaded = false, silent = false } = {}) => {
    const wasRecording = mediaRecorderRef.current?.state === 'recording' || Boolean(recordingSessionIdRef.current);
    if (wasRecording) {
      await stopRecording(silent);
    }

    // Kick background uploader without blocking the packing UI
    void processVideoUploadQueue({ wait: false, forceNow: true });

    if (!requireUploaded) {
      return true;
    }

    const cid = stateRef.current.cid || S.cid;
    setShowUpload(true);
    // Finish/Done is the only place we block with the upload progress popup.
    try {
      await refreshUploadLogFromQueue();
    } catch (_) {
      setShowUploadLog(true);
    }
    if (!silent) toast('Finishing video upload(s) — keep this tab open…', 'info', 4500);

    const deadline = Date.now() + VIDEO_UPLOAD_CONFIG.finishDrainTimeoutMs;
    while (Date.now() < deadline) {
      let drainOk = false;
      try {
        const drain = await processVideoUploadQueue({
          wait: true,
          retryFailed: true,
          forceNow: true,
          timeoutMs: VIDEO_UPLOAD_CONFIG.drainSliceTimeoutMs,
        });
        drainOk = isTerminalSuccess(drain);
      } catch (drainErr) {
        // Failed/pending/timeout — inspect IndexedDB before giving up
        if (drainErr?.result?.failedIds?.length && Date.now() > deadline - 5000) {
          const err = new Error(
            drainErr.message || 'Video upload failed. Stay online and retry before finishing.'
          );
          err.cause = drainErr
          throw err;
        }
      }

      const {
        getActiveOutstandingVideos,
        countOpenRecordingSessions,
      } = await import('../utils/videoQueue');
      const [outstanding, openSessions] = await Promise.all([
        getActiveOutstandingVideos(cid),
        countOpenRecordingSessions(cid),
      ]);
      if (drainOk && outstanding.length === 0 && openSessions === 0) {
        setShowUpload(false);
        setUploadProgress(0);
        return true;
      }
      if (outstanding.length === 0 && openSessions === 0) {
        setShowUpload(false);
        setUploadProgress(0);
        return true;
      }
      const failed = outstanding.filter((v) => v.status === 'failed' || v.status === 'storage_failed');
      if (failed.length && Date.now() > deadline - 5000) break;
      await new Promise((r) => setTimeout(r, 800));
    }

    const {
      getActiveOutstandingVideos,
      countOpenRecordingSessions,
    } = await import('../utils/videoQueue');
    const [left, openLeft] = await Promise.all([
      getActiveOutstandingVideos(cid),
      countOpenRecordingSessions(cid),
    ]);
    if (openLeft > 0) {
      throw new Error(
        `Recording session still open for this consignment (${openLeft}). `
        + 'Finalize or recover the recording before finishing.'
      );
    }
    if (left.length) {
      const boxes = [...new Set(left.map((v) => v.metadata?.boxNo).filter(Boolean))].join(', ');
      throw new Error(`Video upload incomplete for Box ${boxes || '?'}. Stay online and retry.`);
    }
    return true;
  };

  /* ═══ WORKFLOW ═══ */
  const doLoad = async () => {
    const v = inCidRef.current?.value.trim();
    if (!v) { toast('Enter ID', 'warning'); return; }
    setLoading(true);
    try {
      const r = await packingAPI.load({ consignment_id: v });
      const actualCid = r.data.consignment_id || v;
      sfx.cid();
      const meta = {
        internalShipmentNo: r.data.internalShipmentNo || v,
        shipmentNo: r.data.shipmentNo || '',
        appointmentDate: r.data.appointmentDate || '',
        requiredDispatchDate: r.data.requiredDispatchDate || r.data.scheduledDispatchDate || '',
        scheduledDispatchDate: r.data.scheduledDispatchDate || '',
        transitDays: r.data.transitDays || 0,
        priorityLevel: r.data.priorityLevel,
        priorityLabel: r.data.priorityLabel,
        prioritySublabel: r.data.prioritySublabel,
        readinessStatus: r.data.readinessStatus,
        warehouse: r.data.warehouse || '',
        totalRequiredQty: r.data.totalRequiredQty || 0,
        totalPackedQty: r.data.totalPackedQty || 0,
        boxCount: r.data.boxCount || 0,
      };
      setLoadMeta(meta);
      cidRef.current = actualCid;
      const nextState = { cid: actualCid, intShip: meta.internalShipmentNo, box: null, skus: r.data.skus, boxes: r.data.boxes || {} };
      commitPackingState(nextState);
      toast('Loaded ' + (meta.internalShipmentNo || actualCid) + ' — ' + r.data.total_skus + ' SKUs', 'success');
      setZoneState(2);
      inCidRef.current.value = '';
      // Auto-start camera when consignment loads
      if (!streamRef.current) {
        toast('Starting camera...', 'info');
        await startCamera();
      }
    } catch (e) {
      toast(e.response?.data?.error || 'Error', 'error');
    }
    setLoading(false);
  };

  const queueSaveBoxLocally = async (consignmentId, boxNo, items, message = 'Box saved locally and will sync when online') => {
    await enqueueSaveBoxJob({ consignmentId, boxNo, items: items || [] });
    setSyncState(navigator.onLine ? 'pending' : 'offline');
    await updatePendingCount();
    toast(message, 'warning', 5000);
  };

  const autoSaveCurrentBox = async () => {
    if (!S.cid || !S.box || !S.boxes[S.box]?.length) {
      // Still finalize any open recorder so chunks are not left in a half-open session
      if (mediaRecorderRef.current?.state === 'recording' || recordingSessionIdRef.current) {
        await ensureBoxVideoSafe({ requireUploaded: false, silent: true });
      }
      return;
    }
    const savedBox = S.box;
    try {
      await runScanQueue();
      await packingAPI.saveBox({ consignment_id: S.cid, box_no: savedBox });
      toast('Box ' + savedBox + ' auto-saved', 'success', 3000);
    } catch (e) {
      await queueSaveBoxLocally(S.cid, savedBox, S.boxes[savedBox], `Box ${savedBox} pending sync. It is not confirmed on the server yet.`);
    }
    await ensureBoxVideoSafe({ requireUploaded: false, silent: true });
  };

  const afterBoxSavedGoToZone2 = async () => {
    commitPackingState((prev) => ({ ...prev, box: null }));
    setZoneState(2);
    window.setTimeout(() => inBoxRef.current?.focus(), 50);
    // Next Box must stay non-blocking: queue cloud upload in background only (no popup).
    const count = await getQueueCount();
    const { getFailedCount } = await import('../utils/videoQueue');
    const failed = await getFailedCount();
    if (count > 0 || failed > 0) {
      void processVideoQueue(false);
      if (failed > 0) {
        toast(`${failed} video(s) need retry — packing continues; fix before Done`, 'warning', 4500);
      } else if (count > 0) {
        toast(`${count} video(s) uploading in background`, 'info', 2500);
      }
    }
  };

  /** Box-number field only accepts digits (1, 2, 3…) — strip anything else as it's typed/scanned. */
  const handleBoxNumberInput = (e) => {
    const raw = e.target.value;
    const digitsOnly = raw.replace(/\D+/g, '');
    if (digitsOnly !== raw) {
      sfx.warn();
      toast('Box number must be digits only (1, 2, 3…) — other characters were ignored', 'error', 3000);
    }
    e.target.value = digitsOnly;
  };

  const doBox = async () => {
    const v = inBoxRef.current?.value.trim();
    if (!v) { toast('Enter box no', 'warning'); return; }
    if (!/^\d+$/.test(v)) {
      sfx.warn();
      toast('Box number must contain digits only (e.g. 1, 2, 3)', 'error', 3500);
      return;
    }

    if (S.box && S.box !== v) await autoSaveCurrentBox();

    try {
      const dup = await packingAPI.checkDuplicateBox({ consignment_id: S.cid, box_no: v });
      if (dup.data.duplicate) {
        const totalQty = dup.data.total_qty ?? 0;
        const cidLabel = dup.data.internal_shipment_no || dup.data.consignment_id || S.intShip || S.cid;
        setMoConfig({
          title: 'Box Already Exists',
          wide: true,
          body: (
            <div className="space-y-3">
              <p>
                Box <strong>{v}</strong> already contains <strong>{totalQty}</strong> pieces under Consignment{' '}
                <strong>{cidLabel}</strong>. What would you like to do?
              </p>
              <ul className="text-[11px] text-slate-500 space-y-1 list-disc pl-4">
                <li><strong className="text-slate-700">Continue Packing</strong> — open this box and add more items (original qty stays).</li>
                <li><strong className="text-slate-700">Remove Quantity</strong> — record a post-pack removal with mandatory video.</li>
              </ul>
            </div>
          ),
          actions: (
            <>
              <button
                type="button"
                onClick={() => setShowMo(false)}
                className="px-3 py-1.5 border border-gray-200 rounded-lg text-[11px] font-medium bg-white hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowMo(false);
                  setRemovalModal({ open: true, boxNo: String(v), stream: streamRef.current });
                  if (inBoxRef.current) inBoxRef.current.value = '';
                }}
                className="px-3 py-1.5 border border-amber-300 bg-amber-50 text-amber-900 rounded-lg text-[11px] font-semibold hover:bg-amber-100"
              >
                Remove Quantity
              </button>
              <button
                type="button"
                onClick={() => { setShowMo(false); _setBox(v, { reopen: true }); }}
                className="px-3 py-1.5 bg-primary-600 text-white rounded-lg text-[11px] font-semibold hover:bg-primary-700"
              >
                Continue Packing
              </button>
            </>
          )
        });
        setShowMo(true);
        return;
      }
    } catch (e) {}
    _setBox(v);
  };

  const _setBox = (v, { reopen = false } = {}) => {
    if (!streamRef.current) {
      toast('Camera must be active before packing. Click "Start Camera" or reload consignment.', 'error', 5000);
      setMoConfig({
        title: 'Camera Required',
        body: 'CCTV recording is mandatory for packing. Please start the camera before entering a box number.',
        actions: (
          <button onClick={() => { setShowMo(false); startCamera(); }} className="px-3 py-1.5 bg-primary-600 text-white rounded-lg text-[11px] font-medium">Start Camera</button>
        )
      });
      setShowMo(true);
      return;
    }
    commitPackingState((prev) => ({
      ...prev,
      box: v,
      boxes: { ...prev.boxes, [v]: prev.boxes[v] || [] },
    }));
    sfx.box();
    toast('Box ' + v + ' active', 'success');
    setZoneState(3);
    inBoxRef.current.value = '';
    const activeCid = cidRef.current || stateRef.current.cid;
    if (activeCid) startRecording(activeCid, v, { reopen });
  };

  const syncScanFromServer = (barcode, data, boxNo) => {
    if (!data?.box_items && data?.packed == null) return false;
    const targetBox = boxNo != null ? String(boxNo) : stateRef.current.box;
    commitPackingState((prev) => {
      const next = { ...prev };
      if (data.box_items && targetBox) {
        next.boxes = { ...prev.boxes, [targetBox]: data.box_items };
      } else if (data.packed != null) {
        const matchSku = (s) => barcodeMatchesSku(s, barcode);
        const remaining = data.remaining ?? Math.max(0, (data.required ?? 0) - data.packed);
        next.skus = prev.skus.map((s) => matchSku(s)
          ? {
            ...s,
            packed: data.packed,
            remaining,
            status: remaining <= 0 ? 'completed' : 'pending',
          }
          : s);
      }
      return next;
    });
    return true;
  };

  const refreshPackingSession = async (consignmentId, { preferServerBoxes = false } = {}) => {
    if (!consignmentId) return;
    const response = await packingAPI.load({ consignment_id: consignmentId });
    const actualCid = response.data.consignment_id || consignmentId;
    commitPackingState((prev) => {
      if (prev.cid !== actualCid) return prev;
      const serverBoxes = response.data.boxes || {};
      let boxes;
      if (preferServerBoxes) {
        // After quantity removal/edit: server is source of truth; keep only unsaved local boxes
        boxes = { ...serverBoxes };
        for (const [boxNo, items] of Object.entries(prev.boxes || {})) {
          if (!serverBoxes[boxNo] && items?.length) boxes[boxNo] = items;
        }
      } else {
        // During active packing: keep local unsaved scans, fill gaps from server
        boxes = { ...serverBoxes, ...prev.boxes };
      }
      return {
        ...prev,
        skus: response.data.skus || prev.skus,
        boxes,
      };
    });
  };

  const applyScanResponse = (barcode, data, { silent = false, boxNo } = {}) => {
    if (data.not_found || data.over_limit || data.locked) {
      if (!syncScanFromServer(barcode, data, boxNo) && cidRef.current) {
        void refreshPackingSession(cidRef.current);
      }
      if (silent) return;
      const reason = data.not_found ? 'not_found' : data.locked ? 'locked' : 'over_limit';
      const scanMessage = getScanMessage(reason, { ...data, barcode });
      if (isPosthogConfigured) {
        posthog.capture('barcode_scan_failed', {
          consignmentId: S.cid || cidRef.current,
          boxNo: S.box,
          barcode,
          reason: data.not_found ? 'not_found' : data.over_limit ? 'over_limit' : data.locked ? 'locked' : 'rejected',
          extraItem: !!data.extra_item,
          message: data.message || scanMessage,
        })
      }
      playScanSound(reason, data);
      toast(data.message || scanMessage, 'error', data.locked || data.extra_item ? 5000 : 3000);
      flash('err');
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      return;
    }
    const matchSku = (s) => barcodeMatchesSku(s, barcode);
    if (isPosthogConfigured) {
      posthog.capture('barcode_scan_success', {
        consignmentId: S.cid,
        boxNo: boxNo ?? S.box,
        barcode,
        packedQty: data.packed,
        requiredQty: data.required,
      })
    }
    const targetBox = boxNo != null ? String(boxNo) : stateRef.current.box;
    commitPackingState((prev) => {
      const next = { ...prev };
      if (data.box_items && targetBox) {
        next.boxes = { ...prev.boxes, [targetBox]: data.box_items };
      } else {
        next.skus = prev.skus.map(s => matchSku(s)
          ? { ...s, packed: data.packed, remaining: data.remaining, status: data.remaining <= 0 ? 'completed' : 'pending' }
          : s);
      }
      return next;
    });
    if (!silent) {
      playScanSound('ok');
      if (navigator.vibrate) navigator.vibrate(50);
      toast('✓ ' + (data.internalSku || barcode).substring(0, 20) + ' (' + data.packed + '/' + data.required + ')', 'success');
      flash('ok');
    }
  };

  const reconcileScanFromServer = (barcode, data, boxNo) => {
    if (data?.packed == null && !data?.box_items) return;
    const targetBox = boxNo != null ? String(boxNo) : stateRef.current.box;
    commitPackingState((prev) => {
      const matchSku = (s) => barcodeMatchesSku(s, barcode);
      const currentSku = prev.skus.find(matchSku);
      if (!currentSku) return prev;

      if (data.box_items && targetBox) {
        const currentBoxItems = prev.boxes[targetBox] || [];
        const serverItems = data.box_items || [];
        const sameBox = serverItems.length === currentBoxItems.length
          && serverItems.every((item, idx) => {
            const local = currentBoxItems[idx];
            return local?.skuId === item?.skuId && Number(local?.qty) === Number(item?.qty);
          });
        if (data.packed === currentSku.packed && sameBox) {
          return prev;
        }
        return {
          ...prev,
          boxes: { ...prev.boxes, [targetBox]: data.box_items },
        };
      }

      if (data.packed === currentSku.packed) return prev;
      return {
        ...prev,
        skus: prev.skus.map((s) => matchSku(s)
          ? { ...s, packed: data.packed, remaining: data.remaining, status: data.remaining <= 0 ? 'completed' : 'pending' }
          : s),
      };
    });
  };

  const handleQueuedScanResult = async (scan, result, err) => {
    if (err) {
      sfx.err();
      toast(`Scan failed (${scan.barcode}) — will retry`, 'error');
      if (scan.status === 'failed' && cidRef.current) {
        void refreshPackingSession(cidRef.current);
      }
      await updatePendingCount();
      return;
    }
    if (result?.not_found || result?.over_limit || result?.locked) {
      applyScanResponse(scan.barcode, result, { boxNo: scan.boxNo });
      await updatePendingCount();
      return;
    }
    reconcileScanFromServer(scan.barcode, result, scan.boxNo);
    const matchSku = (s) => barcodeMatchesSku(s, scan.barcode);
    const scannedSku = stateRef.current.skus.find(matchSku);
    // eslint-disable-next-line react-hooks/purity -- event callback timestamp used to suppress duplicate server-confirm beeps
    const alreadyBeepedAt = Date.now();
    const alreadyBeeped = lastInstantOkRef.current.barcode === scan.barcode
      && alreadyBeepedAt - lastInstantOkRef.current.at < 4000;
    if (!alreadyBeeped) {
      playScanSound('ok');
      flash('ok');
      if (navigator.vibrate) navigator.vibrate(50);
    }
    if (scannedSku) {
      if (scannedSku.remaining === 0 && scannedSku.required > 0) {
        toast(`✓ ${scannedSku.internalSku} COMPLETE (${scannedSku.packed}/${scannedSku.required})`, 'success', 3500);
      } else if (!alreadyBeeped) {
        toast(`✓ ${scannedSku.internalSku} (${scannedSku.packed}/${scannedSku.required})`, 'success', 1800);
      }
    } else if (result?.internalSku && !alreadyBeeped) {
      toast(`✓ ${result.internalSku} (${result.packed}/${result.required})`, 'success', 1800);
    }
    await updatePendingCount();
  };

  const applyOptimisticScan = (prev, barcode, qty = 1) => {
    const normalized = normalizeBarcodeInput(barcode);
    const sku = prev.skus.find((s) => barcodeMatchesSku(s, normalized));
    if (!sku) {
      const allComplete = prev.skus.length > 0
        && prev.skus.every((s) => s.status === 'completed' || s.remaining <= 0);
      return {
        ok: false,
        reason: 'not_found',
        extra_item: allComplete,
        barcode: normalized,
        message: allComplete
          ? 'Extra item — all required SKUs are already complete'
          : `Not in shipment: ${normalized}`,
      };
    }
    const required = Number(sku.required) || 0;
    const packed = Number(sku.packed) || 0;
    const remaining = sku.remaining != null ? Number(sku.remaining) : Math.max(0, required - packed);
    if (packed >= required || sku.status === 'completed' || remaining <= 0) {
      return {
        ok: false,
        reason: 'locked',
        extra_item: true,
        message: `Already complete (${packed}/${required})`,
        packed,
        required,
        remaining,
      };
    }
    if (packed + qty > required) {
      return {
        ok: false,
        reason: 'over_limit',
        message: `Cannot exceed required qty (${required}) — ${remaining} remaining`,
        packed,
        required,
        remaining,
      };
    }

    const boxItems = [...(prev.boxes[prev.box] || [])];
    const existing = boxItems.find((i) => i.skuId === sku.id);
    const marketplaceBarcode = getMarketplaceBarcode(sku) || normalized;
    if (existing) {
      existing.qty += qty;
    } else {
      boxItems.push({
        skuId: sku.id,
        marketplaceBarcode,
        barcode: marketplaceBarcode,
        marketplaceSku: sku.marketplaceSku || marketplaceBarcode,
        internalSku: sku.internalSku,
        name: sku.internalSku,
        qty,
      });
    }

    const newPacked = packed + qty;
    const nextRemaining = Math.max(0, required - newPacked);
    const nextSkus = prev.skus.map((s) => (s.id === sku.id
      ? {
        ...s,
        packed: newPacked,
        remaining: nextRemaining,
        overScanned: Math.max(0, newPacked - required),
        status: required > 0 && newPacked >= required ? 'completed' : 'pending',
      }
      : s));
    const updatedSku = nextSkus.find((s) => s.id === sku.id);

    return {
      ok: true,
      next: {
        ...prev,
        boxes: { ...prev.boxes, [prev.box]: boxItems },
        skus: nextSkus,
      },
      scannedSku: updatedSku,
      queueBarcode: resolveQueueBarcode(updatedSku, normalized),
    };
  };

  const isMissingPackingSession = (error) => {
    const message = error?.response?.data?.error || error?.message || '';
    return error?.response?.status === 400 && /No consignment loaded|Invalid session/i.test(message);
  };

  const ensurePackingSession = async (consignmentId) => {
    await refreshPackingSession(consignmentId);
  };

  const sendQueuedScan = async (scan) => {
    const postIncrement = async () => {
      const response = await packingAPI.increment({
        consignment_id: scan.consignmentId,
        barcode: scan.barcode,
        box_no: scan.boxNo,
        qty: scan.qty,
        scan_id: scan.id,
      });
      if (response.data?.retry) {
        const retryErr = new Error(response.data.error || 'Scan persist failed');
        retryErr.retry = true;
        throw retryErr;
      }
      return response.data;
    };
    try {
      return await postIncrement();
    } catch (error) {
      if (error?.response?.status === 503 || error?.retry) {
        const retryErr = new Error(error?.response?.data?.error || error.message || 'Scan persist failed');
        retryErr.retry = true;
        throw retryErr;
      }
      if (!isMissingPackingSession(error)) throw error;
      await ensurePackingSession(scan.consignmentId);
      return postIncrement();
    }
  };

  const runScanQueue = async () => {
    await drainScanQueue(sendQueuedScan, handleQueuedScanResult);
    await updatePendingCount();
  };

  const kickScanQueue = () => {
    void drainScanQueue(sendQueuedScan, handleQueuedScanResult).then(() => updatePendingCount());
  };

  const runPendingSync = async (showLog = false) => {
    await runScanQueue();
    await drainPackingSyncQueue(
      processSaveBoxJob,
      (job, result, err) => {
        if (err) {
          toast(`Box ${job.boxNo} still pending sync`, 'warning', 4000);
          return;
        }
        toast(`Box ${job.boxNo} synced`, 'success', 3000);
      }
    );
    await processVideoQueue(showLog);
    await checkSyncStatus(cidRef.current);
  };

  const retryFailedSync = async () => {
    const { resetFailedToPending, pruneDuplicateBoxVideos } = await import('../utils/videoQueue');
    await pruneDuplicateBoxVideos().catch(() => 0);
    const [scans, saveJobs, videos] = await Promise.all([
      resetFailedScans(),
      resetFailedSyncJobs(),
      resetFailedToPending(),
    ]);
    if (scans + saveJobs + videos === 0) {
      await updatePendingCount();
      return;
    }
    setSyncState('pending');
    toast(`Retrying ${scans + saveJobs + videos} failed sync item(s)`, 'info', 3000);
    await runPendingSync(true);
  };

  const refreshUploadLogFromQueue = async () => {
    const { getOutstandingVideos } = await import('../utils/videoQueue');
    const videos = await getOutstandingVideos();
    if (!videos.length) {
      setUploadLog([]);
      setShowUploadLog(false);
      setPendingUploads(0);
      await updatePendingCount();
      return 0;
    }
    setPendingUploads(videos.length);
    setUploadLog(videos.map((v) => ({
      id: v.id,
      name: v.metadata?.fileName || `box_${v.metadata?.boxNo}.webm`,
      boxNo: v.metadata?.boxNo,
      status: v.status === 'failed' || v.status === 'storage_failed'
        ? 'failed'
        : (v.status === 'pending' ? 'queued' : (v.status || 'queued')),
      progress: Number(v.progress) || 0,
      error: v.lastError || null,
    })));
    setShowUploadLog(true);
    return videos.length;
  };

  const discardFailedVideoUploads = async () => {
    if (!window.confirm(
      'WARNING: Permanently discard all FAILED packing videos cached in this browser?\n\n'
      + 'This deletes local evidence that was never verified in cloud storage.\n'
      + 'Successfully uploaded cloud videos are not deleted.\n\n'
      + 'Only continue if an administrator/operator explicitly authorizes discard.'
    )) {
      return;
    }
    const { clearFailedVideos } = await import('../utils/videoQueue');
    const cleared = await clearFailedVideos({ confirmDestructive: true });
    toast(cleared ? `Discarded ${cleared} failed video(s)` : 'No failed videos to discard', cleared ? 'success' : 'info', 3500);
    await refreshUploadLogFromQueue();
    await updatePendingCount();
  };

  const clearDuplicateVideoUploads = async () => {
    const { pruneDuplicateBoxVideos } = await import('../utils/videoQueue');
    const pruned = await pruneDuplicateBoxVideos();
    toast(pruned ? `Removed ${pruned} older duplicate video(s)` : 'No duplicate videos found', pruned ? 'success' : 'info', 3500);
    await refreshUploadLogFromQueue();
    await updatePendingCount();
  };

  const clearAllLocalVideoCache = async () => {
    if (!window.confirm('Clear ALL pending/failed packing videos from this browser cache? You will need to re-record any unfinished boxes.')) {
      return;
    }
    const { clearLocalVideoCache } = await import('../utils/videoQueue');
    const cleared = await clearLocalVideoCache('all');
    toast(cleared ? `Cleared ${cleared} cached video(s)` : 'Video cache already empty', cleared ? 'success' : 'info', 3500);
    setUploadLog([]);
    setShowUploadLog(false);
    setPendingUploads(0);
    await updatePendingCount();
  };

  const releaseScanLock = () => {
    scanSubmitLockRef.current = false;
    const pending = pendingScanBarcodeRef.current;
    if (pending) {
      pendingScanBarcodeRef.current = null;
      doScan(pending);
    }
  };

  const handleSkuBarcodePaste = (e) => {
    if (!packingAllowPaste) {
      e.preventDefault();
      sfx.warn();
      toast('Paste blocked — use the barcode scanner', 'warning', 2500);
      return;
    }
    e.preventDefault();
    const raw = e.clipboardData?.getData('text') || '';
    const cleaned = normalizeBarcodeInput(raw.replace(/[\r\n\t]+/g, ''));
    if (!inSkuRef.current) return;
    inSkuRef.current.value = cleaned;
    inSkuRef.current.focus();
    try {
      inSkuRef.current.setSelectionRange(0, cleaned.length);
    } catch {
      // setSelectionRange unsupported on some input types
    }
    scannerGuardRef.current.reset();
    scanSubmitLockRef.current = false;
    doScan(cleaned);
  };

  const doScan = (overrideBarcode) => {
    const bc = normalizeBarcodeInput(
      overrideBarcode !== undefined ? overrideBarcode : inSkuRef.current?.value
    );

    if (bc.toUpperCase() === 'CLOSE-BOX' || bc.toUpperCase() === 'FINISH-BOX') {
      if (inSkuRef.current) inSkuRef.current.value = '';
      inSkuRef.current?.focus();
      scannerGuardRef.current.reset();
      doSaveBox();
      return;
    }

    if (bc.toUpperCase() === 'NEW-BOX') {
      if (inSkuRef.current) inSkuRef.current.value = '';
      inSkuRef.current?.focus();
      scannerGuardRef.current.reset();
      doNewBox();
      return;
    }

    if (scanSubmitLockRef.current) {
      if (bc) pendingScanBarcodeRef.current = bc;
      return;
    }

    if (!bc) {
      const { cid, box } = stateRef.current;
      if (!cid || !box) {
        scanToast('Load consignment and set box number before scanning', 'error');
      }
      inSkuRef.current?.focus();
      return;
    }

    const session = stateRef.current;
    if (!session.cid || !session.box) {
      scanToast('Load consignment and set box number before scanning', 'error');
      inSkuRef.current?.focus();
      return;
    }

    if (!isValidBarcode(bc)) {
      const message = barcodeValidationMessage(bc);
      inSkuRef.current.value = '';
      inSkuRef.current?.focus();
      playScanSound('invalid_barcode', { message });
      toast(message, 'error', 2500);
      flash('err');
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      return;
    }

    inSkuRef.current.value = '';
    inSkuRef.current?.focus();
    scannerGuardRef.current.reset();

    const snapshot = stateRef.current;
    const optimistic = applyOptimisticScan(snapshot, bc, 1);

    if (!optimistic?.ok) {
      playScanSound(optimistic.reason, optimistic);
      toast(
        optimistic.message || getScanMessage(optimistic.reason, optimistic),
        'error',
        optimistic.reason === 'locked' || optimistic.extra_item ? 4000 : 2500
      );
      flash('err');
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      return;
    }

    // eslint-disable-next-line react-hooks/purity -- event callback timestamp used to suppress duplicate server-confirm beeps
    const instantOkAt = Date.now();
    lastInstantOkRef.current = { barcode: bc, at: instantOkAt };
    playScanSound('ok');
    flash('ok');
    if (navigator.vibrate) navigator.vibrate(40);

    scanSubmitLockRef.current = true;
    requestAnimationFrame(releaseScanLock);

    commitPackingState(() => optimistic.next, { syncSkus: false, flush: true });

    const scannedSku = optimistic.scannedSku;
    const queueBarcode = optimistic.queueBarcode || resolveQueueBarcode(scannedSku, bc);

    void enqueueScan({ barcode: queueBarcode, consignmentId: session.cid, boxNo: session.box, qty: 1 })
      .then(() => {
        setSyncState('pending');
        kickScanQueue();
      })
      .catch(() => {
        commitPackingState(() => snapshot, { syncSkus: false, flush: true });
        sfx.err();
        toast('Could not queue scan', 'error');
        inSkuRef.current.value = bc;
      });
  };

  const removeItem = async (marketplaceSku) => {
    const session = stateRef.current;
    if (!session.cid || !session.box) return;
    const boxItems = session.boxes[session.box] || [];
    const item = boxItems.find((i) => i.marketplaceSku === marketplaceSku || i.skuId === marketplaceSku);
    const barcode = item?.barcode || item?.marketplaceBarcode || marketplaceSku;
    try {
      await packingAPI.decrement({ consignment_id: session.cid, barcode, box_no: session.box, qty: 1 });
      commitPackingState((prev) => {
        const nextBoxItems = (prev.boxes[prev.box] || [])
          .map((i) => (i.marketplaceSku === marketplaceSku ? { ...i, qty: i.qty - 1 } : i))
          .filter((i) => i.qty > 0);
        const nextBoxes = { ...prev.boxes, [prev.box]: nextBoxItems };
        return {
          ...prev,
          boxes: nextBoxes,
          skus: recomputeSkuTotals(prev.skus, nextBoxes),
        };
      });
      toast('Removed', 'info');
    } catch (e) {}
  };

  const saveBoxWithWeight = async (boxNo, weight, unit, imageFileOrBlob) => {
    const cid = stateRef.current.cid || S.cid;
    if (!cid || !boxNo) return false;

    const afterSave = async () => {
      try {
        // Durable local finalize only — do NOT wait for cloud upload on Next Box.
        // Camera stream stays open; next box can start recording immediately.
        await ensureBoxVideoSafe({ requireUploaded: false, silent: true });
      } catch (err) {
        console.error('[Video] Box video not safe yet:', err);
        toast(err.message || 'Could not save box video locally — retry before continuing', 'error', 8000);
        return false;
      }
      void packingAPI.generateLabel({ consignment_id: cid, box_no: boxNo }).catch(() => {});
      void checkSyncStatus(cid);
      void runScanQueue()
        .catch((err) => console.warn('[Packing] Pending scan drain after save failed:', err.message))
        .then(() => drainPackingSyncQueue(processSaveBoxJob, () => {}))
        .then(() => updatePendingCount())
        .catch((err) => console.warn('[Packing] Save-box queue drain after scans failed:', err.message));
      return true;
    };

    setLoading(true);
    try {
      await queueSaveBoxWithWeightLocally(boxNo, weight, unit, imageFileOrBlob, null);

      if (isPosthogConfigured) {
        posthog.capture('box_saved', {
          consignmentId: cid,
          boxNo,
          weight,
          unit,
          hasWeightImage: !!imageFileOrBlob,
          isOnline: navigator.onLine,
        });
      }

      toast(`Box ${boxNo} saved — video syncing in background`, 'success', 2500);
      const videoOk = await afterSave();
      return videoOk;
    } catch (err) {
      console.error('Local save-box failed:', err);
      toast('Failed to save box to local queue', 'error');
      return false;
    } finally {
      setLoading(false);
    }
  };

  const queueSaveBoxWithWeightLocally = async (boxNo, weight, unit, imageFileOrBlob, imageId) => {
    const cid = stateRef.current.cid || S.cid;
    await enqueueSaveBoxJob({
      consignmentId: cid,
      boxNo,
      weight,
      weightUnit: unit,
      weightImageId: imageId,
      weightImageBlob: imageFileOrBlob || null,
      items: stateRef.current.boxes[boxNo] || [],
    });

    if (isPosthogConfigured) {
      posthog.capture('box_saved', {
        consignmentId: cid,
        boxNo,
        weight,
        unit,
        isOnline: false,
      })
    }

    toast(`Box ${boxNo} saved locally and queued for sync`, 'info', 5000);
  };

  const handleBoxCompletion = (actionAfterSave) => {
    if (!S.cid || !S.box || !S.boxes[S.box]?.length) {
      if (S.box && (mediaRecorderRef.current?.state === 'recording' || recordingSessionIdRef.current)) {
        setLoading(true);
        void ensureBoxVideoSafe({ requireUploaded: false, silent: true })
          .then(() => actionAfterSave())
          .catch((err) => toast(err.message || 'Could not save box video locally', 'error', 7000))
          .finally(() => setLoading(false));
        return;
      }
      actionAfterSave();
      return;
    }
    setWeightModalData({
      boxNo: S.box,
      onSave: async (weight, unit, imageFileOrBlob) => {
        setShowWeightModal(false);
        const ok = await saveBoxWithWeight(S.box, weight, unit, imageFileOrBlob);
        if (ok) actionAfterSave();
      },
      onSkip: async () => {
        setShowWeightModal(false);
        const ok = await saveBoxWithWeight(S.box, null, null, null);
        if (ok) actionAfterSave();
      }
    });
    setShowWeightModal(true);
  };

  const openFinishModal = () => {
    const pending = S.skus.filter(s => s.remaining > 0).sort((a, b) => b.remaining - a.remaining);
    const totalReq = S.skus.reduce((s, k) => s + k.required, 0);
    const totalPkd = S.skus.reduce((s, k) => s + k.packed, 0);
    const boxCount = Object.keys(S.boxes).filter(k => S.boxes[k].length > 0).length;
    const pct = totalReq > 0 ? Math.round(totalPkd / totalReq * 100) : 0;

    setMoConfig({
      title: 'Finish ' + (S.intShip || S.cid) + '?',
      body: (
        <div>
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 mb-2 text-[11px] text-amber-900 leading-relaxed">
            <strong>Keep this tab open.</strong> Done waits until every box video is uploaded and verified.
            Closing early can lose unfinished uploads.
          </div>
          <div className="grid grid-cols-3 gap-1.5 my-2">
            <div className="bg-slate-50 p-2 rounded-md text-center"><div className="text-lg font-extrabold text-emerald-600">{totalPkd}/{totalReq}</div><div className="text-[8px] text-slate-400 uppercase">Packed</div></div>
            <div className="bg-slate-50 p-2 rounded-md text-center"><div className="text-lg font-extrabold text-red-500">{pct}%</div><div className="text-[8px] text-slate-400 uppercase">Complete</div></div>
            <div className="bg-slate-50 p-2 rounded-md text-center"><div className="text-lg font-extrabold">{boxCount}</div><div className="text-[8px] text-slate-400 uppercase">Boxes</div></div>
          </div>
          {pending.length > 0 && (
            <>
              <div className="text-amber-600 font-semibold text-[11px] mb-1.5">⚠️ {pending.length} SKUs still pending</div>
              <div className="max-h-[150px] overflow-y-auto border border-slate-200 rounded-lg">
                <table className="w-full text-[10px]">
                  <thead><tr className="bg-slate-50"><th className="p-1 text-left text-slate-700">Name</th><th className="p-1 text-slate-700">Req</th><th className="p-1 text-slate-700">Pkd</th><th className="p-1 text-red-500">Left</th></tr></thead>
                  <tbody>{pending.map(p => <tr key={p.marketplaceSku} className="border-b border-slate-100"><td className="p-1 truncate max-w-[120px] text-slate-700">{p.internalSku}</td><td className="p-1 text-center text-slate-700">{p.required}</td><td className="p-1 text-center text-slate-700">{p.packed}</td><td className="p-1 text-center text-red-600 font-bold">{p.remaining}</td></tr>)}</tbody>
                </table>
              </div>
            </>
          )}
          {pending.length === 0 && <div className="text-emerald-600 font-semibold my-2">✅ All SKUs fully packed! Consignment complete.</div>}
        </div>
      ),
      actions: (
        <>
          <button onClick={() => setShowMo(false)} className="px-3 py-1.5 border border-gray-200 rounded-lg text-[11px] font-medium">Cancel</button>
          <button onClick={finishPacking} className="px-3 py-1.5 bg-red-600 text-white rounded-lg text-[11px] font-medium">Finish &amp; upload videos</button>
        </>
      )
    });
    setShowMo(true);
  };

  const doSaveBox = async () => {
    if (!S.cid || !S.box || !S.boxes[S.box]?.length) { toast('Box empty', 'warning'); return; }
    handleBoxCompletion(() => afterBoxSavedGoToZone2());
  };

  const doNewBox = async () => {
    if (S.box && S.boxes[S.box]?.length) {
      handleBoxCompletion(() => afterBoxSavedGoToZone2());
    } else {
      try {
        if (S.box && (mediaRecorderRef.current?.state === 'recording' || recordingSessionIdRef.current)) {
          setLoading(true);
          // Local finalize only — keep packing continuous; upload in background
          await ensureBoxVideoSafe({ requireUploaded: false, silent: true });
        }
        await afterBoxSavedGoToZone2();
      } catch (err) {
        toast(err.message || 'Could not save box video locally', 'error', 7000);
      } finally {
        setLoading(false);
      }
    }
  };

  const doFinish = () => {
    if (S.box && S.boxes[S.box]?.length) {
      handleBoxCompletion(() => {
        commitPackingState((prev) => ({ ...prev, box: null }));
        openFinishModal();
      });
      return;
    }
    openFinishModal();
  };

  const finishPacking = async () => {
    setShowMo(false);
    setLoading(true);
    const finishedLabel = S.intShip || S.cid;
    try {
      // Save leftover box + durable-finalize video locally (fast)
      await autoSaveCurrentBox();

      // Compliance gate: show upload popup and wait until all box videos are verified
      try {
        await ensureBoxVideoSafe({ requireUploaded: true, silent: true });
      } catch (err) {
        toast(err.message || 'Upload all box videos before finishing', 'error', 8000);
        try { await refreshUploadLogFromQueue(); } catch (_) { setShowUploadLog(true); }
        return;
      }

      // Ensure save-box jobs flushed before finish API (non-blocking if empty)
      try {
        await drainPackingSyncQueue(processSaveBoxJob, () => {});
      } catch (err) {
        console.warn('[Packing] Sync drain before finish:', err.message);
      }

      const res = await packingAPI.finish({ consignment_id: S.cid });
      const summary = res.data.summary;

      if (isPosthogConfigured) {
        posthog.capture('consignment_finished', {
          consignmentId: S.cid,
          fullyPacked: summary.fully_packed,
          totalRequired: summary.totalRequiredQty,
          totalPacked: summary.totalPackedQty,
        })
      }

      setShowUploadLog(false);
      const leftQty = (summary.totalRequiredQty || 0) - (summary.totalPackedQty || 0);
      setMoConfig({
        title: summary.fully_packed ? 'Packing complete' : 'Packing saved',
        body: (
          <div className="space-y-2 text-left">
            <div className={`rounded-lg px-3 py-2 text-[12px] font-semibold ${summary.fully_packed ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-amber-50 text-amber-900 border border-amber-200'}`}>
              {summary.fully_packed
                ? `${finishedLabel} is complete. Box videos are verified — safe to close this tab.`
                : `${finishedLabel} saved with ${leftQty} item(s) still pending. Videos are verified.`}
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              <div className="bg-slate-50 p-2 rounded-md text-center">
                <div className="text-base font-extrabold text-emerald-600">{summary.totalPackedQty}/{summary.totalRequiredQty}</div>
                <div className="text-[8px] text-slate-400 uppercase">Packed</div>
              </div>
              <div className="bg-slate-50 p-2 rounded-md text-center">
                <div className="text-base font-extrabold text-slate-700">{summary.boxCount ?? '—'}</div>
                <div className="text-[8px] text-slate-400 uppercase">Boxes</div>
              </div>
              <div className="bg-slate-50 p-2 rounded-md text-center">
                <div className="text-base font-extrabold text-emerald-600">OK</div>
                <div className="text-[8px] text-slate-400 uppercase">Videos</div>
              </div>
            </div>
          </div>
        ),
        actions: (
          <button
            type="button"
            onClick={() => { setShowMo(false); resetAll(); }}
            className="px-3 py-1.5 bg-primary-600 text-white rounded-lg text-[11px] font-medium"
          >
            Done
          </button>
        ),
      });
      setShowMo(true);
      if (!summary.fully_packed) {
        toast(finishedLabel + ' saved - still ' + leftQty + ' items pending', 'warning', 5000);
      } else {
        toast(finishedLabel + ' COMPLETE!', 'success', 5000);
      }
    } catch (e) {
      if (e.response?.data?.code === 'VIDEOS_PENDING') {
        const boxes = (e.response.data.missingBoxes || []).join(', ');
        toast(`Upload videos for Box ${boxes} before finishing`, 'error', 7000);
        try { await refreshUploadLogFromQueue(); } catch (_) { setShowUploadLog(true); }
      } else {
        toast(e.response?.data?.error || 'Finish failed', 'error');
      }
    } finally {
      setLoading(false);
    }
  };

  const resetAll = () => {
    const empty = { cid: null, intShip: null, box: null, skus: [], boxes: {} };
    commitPackingState(empty);
    setLoadMeta(null);
    cidRef.current = null;
    inCidRef.current && (inCidRef.current.value = '');
    inBoxRef.current && (inBoxRef.current.value = '');
    inSkuRef.current && (inSkuRef.current.value = '');
    setZoneState(1);
    fetchConsignments();
  };

  const flash = (type) => {
    const el = document.getElementById('z3');
    if (!el) return;
    el.classList.add(type === 'err' ? 'flash-err' : 'flash-ok');
    setTimeout(() => el.classList.remove('flash-ok', 'flash-err'), 500);
  };

  const doDL = () => { if (S.cid) window.open('/api/consignments/' + S.cid + '/labels', '_blank'); };

  const printPendingSkus = () => {
    const pending = S.skus.filter(s => s.remaining > 0).sort((a, b) => b.remaining - a.remaining);
    const totalReq = S.skus.reduce((s, k) => s + k.required, 0);
    const totalPkd = S.skus.reduce((s, k) => s + k.packed, 0);
    const boxCount = Object.keys(S.boxes).filter(k => S.boxes[k].length > 0).length;
    const pct = totalReq > 0 ? Math.round(totalPkd / totalReq * 100) : 0;
    const now = new Date();
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const h = now.getHours(), mi = String(now.getMinutes()).padStart(2, '0'), ampm = h >= 12 ? 'PM' : 'AM', h12 = h % 12 || 12;
    const ts = `${days[now.getDay()]}, ${String(now.getDate()).padStart(2, '0')} ${months[now.getMonth()]} ${now.getFullYear()} — ${String(h12).padStart(2, '0')}:${mi} ${ampm}`;
    const safeCid = escapeHtml(S.cid);
    const safeTs = escapeHtml(ts);
    const rows = pending.map((p, i) => `<tr><td>${i + 1}</td><td style="font-family:monospace;font-size:11px">${escapeHtml(p.marketplaceSku)}</td><td>${escapeHtml(p.internalSku)}</td><td style="text-align:center">${Number(p.required) || 0}</td><td style="text-align:center">${Number(p.packed) || 0}</td><td style="text-align:center;color:#c53030;font-weight:700">${Number(p.remaining) || 0}</td></tr>`).join('');

    openEscapedPrintWindow(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Pending SKUs — ${safeCid}</title><style>
    *{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;padding:24px 28px;color:#1a202c;font-size:13px}
    h1{font-size:17px;font-weight:800;letter-spacing:.5px;margin-bottom:2px}.sub{font-size:12px;color:#718096;margin-bottom:14px}
    .ts{display:inline-block;font-size:11px;color:#2d3748;background:#f7fafc;border:1px solid #cbd5e0;padding:5px 12px;border-radius:6px;margin-bottom:16px;font-weight:600}
    .summary{display:flex;gap:12px;margin-bottom:16px}.sbox{background:#f7fafc;border:1px solid #e2e8f0;padding:10px 18px;border-radius:8px;text-align:center;min-width:80px}
    .sbox .val{font-size:20px;font-weight:800;color:#2d3748}.sbox .lbl{font-size:9px;color:#a0aec0;text-transform:uppercase;margin-top:2px}
    .warn{background:#fff5f5;border-left:4px solid #e53e3e;padding:8px 14px;border-radius:4px;font-size:12px;color:#c53030;margin-bottom:16px;font-weight:600}
    table{width:100%;border-collapse:collapse;font-size:12px}thead tr{background:#2d3748}th{color:#fff;padding:8px 10px;text-align:left;font-size:11px;font-weight:700}
    td{padding:7px 10px;border-bottom:1px solid #e2e8f0}tbody tr:nth-child(even) td{background:#f7fafc}
    .footer{margin-top:22px;font-size:10px;color:#a0aec0;text-align:center;border-top:1px solid #e2e8f0;padding-top:10px}
    @media print{body{padding:12px 14px}button{display:none!important}.footer{position:fixed;bottom:0;left:0;right:0;background:#fff;padding:8px}}
    </style></head><body>
    <h1>Youthnic Packing Station — Pending Report</h1>
    <div class="sub">Consignment: <strong>${safeCid}</strong></div>
    <div class="ts">Printed: ${safeTs}</div>
    <div class="summary">
     <div class="sbox"><div class="val">${totalPkd}/${totalReq}</div><div class="lbl">Packed</div></div>
     <div class="sbox"><div class="val">${pct}%</div><div class="lbl">Complete</div></div>
     <div class="sbox"><div class="val">${boxCount}</div><div class="lbl">Boxes</div></div>
     <div class="sbox"><div class="val" style="color:#c53030">${pending.length}</div><div class="lbl">Pending SKUs</div></div>
    </div>
    <div class="warn">${pending.length} SKU(s) not fully packed — Team Action Required</div>
    <table><thead><tr><th>#</th><th>Barcode</th><th>Name</th><th style="text-align:center">Required</th><th style="text-align:center">Packed</th><th style="text-align:center;color:#fc8181">Remaining</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <div class="footer">Youthnic Consignment Packing Station &nbsp;·&nbsp; ${safeCid} &nbsp;·&nbsp; ${safeTs}</div>
    <script>window.onload=function(){window.print()}</script></body></html>`, { width: 820, height: 640 });
  };

  const currentBoxItems = S.boxes[S.box] || [];
  const qtySummary = getShipmentQtySummary(S.skus);

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-slate-50">
      <style>{`
        @keyframes slideIn { from { transform:translateX(100%); opacity:0; } to { transform:translateX(0); opacity:1; } }
        @keyframes fadeIn { from { opacity:0; transform:translateY(5px); } to { opacity:1; transform:translateY(0); } }
        @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:.3; } }
        @keyframes popIn { 0% { transform:scale(.98); opacity:.6; } 100% { transform:scale(1); opacity:1; } }
        @keyframes fOk { 0% { box-shadow:0 0 0 0 rgba(45,147,108,.4); } 50% { box-shadow:0 0 0 5px rgba(45,147,108,.08); } 100% { box-shadow:none; } }
        @keyframes fErr { 0% { box-shadow:0 0 0 0 rgba(230,57,70,.4); } 50% { box-shadow:0 0 0 5px rgba(230,57,70,.08); } 100% { box-shadow:none; } }
        .flash-ok { animation:fOk .4s; } .flash-err { animation:fErr .4s; }
        .spin { width:14px; height:14px; border:2px solid #e2e8f0; border-top-color:#2563eb; border-radius:50%; animation:sp .7s linear infinite; display:inline-block; }
        @keyframes sp { to { transform:rotate(360deg); } }
      `}</style>

      {/* Header — matching Consignments theme */}
      <div className="sticky top-0 z-[100] flex items-center justify-between px-4 py-2.5 border-b border-slate-200 shadow-sm bg-white">
        <div className="flex items-center gap-3">
          <button onClick={goBack} className="flex items-center gap-1.5 text-slate-500 hover:text-slate-700 text-sm font-medium transition-colors">
            <ArrowLeft className="w-4 h-4" /> Back
          </button>
          <div className="w-px h-5 bg-slate-200" />
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-primary-600 rounded-lg flex items-center justify-center">
              <Boxes className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-sm font-bold text-slate-900">Packing Station</h1>
              <small className="text-[9px] uppercase tracking-[1px] text-slate-400">CCTV System v5.0</small>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div onClick={retryFailedSync} className={`px-2.5 py-1 rounded-full text-[10px] font-semibold flex items-center gap-1.5 cursor-pointer ${syncState==='synced'?'bg-emerald-50 text-emerald-700 border border-emerald-200':syncState==='pending'?'bg-amber-50 text-amber-700 border border-amber-200':'bg-red-50 text-red-700 border border-red-200'}`} title={`${pendingScanJobs} scan(s), ${pendingSaveJobs} save-box job(s), ${pendingUploads} video(s), ${failedSyncJobs} failed`}>
            <span className="w-1.5 h-1.5 rounded-full bg-current animate-[pulse_2s_infinite]" />
            <span>{syncState==='synced'?'Synced':syncState==='pending'?'Pending Sync':syncState==='failed'?'Failed Needs Retry':'Offline'}</span>
          </div>
          <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-[0.8px] border ${recState==='REC'?'bg-red-50 border-red-200 text-red-700':'bg-slate-50 border-slate-200 text-slate-500'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${recState==='REC'?'animate-[pulse_.8s_infinite] bg-red-500':'bg-slate-400'}`} />
            <span>{recState}</span>
          </div>
          {pendingUploads > 0 && (
            <div className="flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-semibold bg-amber-50 border border-amber-200 text-amber-700 animate-[pulse_2s_infinite]" title="Videos queued for upload">
              <span>⬆</span>
              <span>{pendingUploads}</span>
            </div>
          )}
          {currentVideoUpload && (
            <div className="hidden sm:flex items-center gap-2 min-w-[150px] max-w-[220px] px-2.5 py-1 rounded-full text-[10px] font-semibold bg-blue-50 border border-blue-200 text-blue-700" title={`Uploading ${currentVideoUpload.fileName || 'packing video'}`}>
              <span className="shrink-0">Video Box {currentVideoUpload.boxNo}</span>
              <div className="h-1.5 flex-1 rounded-full bg-blue-100 overflow-hidden">
                <div className="h-full rounded-full bg-blue-500 transition-[width] duration-200" style={{ width: `${Math.max(0, Math.min(100, currentVideoUpload.progress || 0))}%` }} />
              </div>
              <span className="tabular-nums">{Math.round(currentVideoUpload.progress || 0)}%</span>
            </div>
          )}
        </div>
      </div>

      {/* Info Bar */}
      <div className="max-w-[1440px] mx-auto mt-2 px-3">
        <div className={`rounded-xl px-4 py-2 flex items-center justify-between flex-wrap gap-2 text-xs bg-white border border-slate-100 shadow-sm ${S.cid?'flex':'hidden'}`}>
          <div className="flex items-center gap-1.5"><span className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">Shipment</span><span className="text-sm font-bold font-mono text-slate-900">{loadMeta?.internalShipmentNo || S.intShip || S.cid || '—'}</span></div>
          {loadMeta && (() => {
            const p = getShipmentPriority(loadMeta);
            return (
              <>
                <div className="flex items-center gap-1.5">
                  <span className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">Priority</span>
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${p.badgeClass}`}>{p.label}</span>
                </div>
                {loadMeta.requiredDispatchDate && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">Dispatch</span>
                    <span className="text-sm font-bold font-mono text-slate-700">{formatDispatchDate(loadMeta.requiredDispatchDate)}</span>
                  </div>
                )}
                {loadMeta.appointmentDate && (
                  <div className="flex items-center gap-1.5"><span className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">Appointment</span><span className="text-sm font-bold font-mono text-slate-700">{formatAppointmentDate(loadMeta.appointmentDate)}</span></div>
                )}
                {loadMeta.readinessStatus && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">Status</span>
                    <span className="text-[10px] font-semibold uppercase text-slate-600">{loadMeta.readinessStatus.replace('_', ' ')}</span>
                  </div>
                )}
              </>
            );
          })()}
          <div className="flex items-center gap-1.5"><span className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">Boxes</span><span className="text-sm font-bold font-mono text-slate-700">{loadMeta?.boxCount ?? Object.keys(S.boxes).filter((k) => S.boxes[k]?.length).length}</span></div>
          <div className="flex items-center gap-1.5"><span className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">SKUs</span><span className="text-sm font-bold font-mono text-slate-700">{S.skus.length}</span></div>
          <div className="flex items-center gap-1.5"><span className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">Required</span><span className="text-sm font-bold font-mono text-slate-700">{qtySummary.required}</span></div>
          <div className="flex items-center gap-1.5"><span className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">Packed</span><span className="text-sm font-bold font-mono text-emerald-600">{qtySummary.packed}</span></div>
          <div className="flex items-center gap-1.5"><span className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">Left</span><span className={`text-sm font-bold font-mono ${qtySummary.remaining > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>{qtySummary.remaining}</span></div>
          {qtySummary.overScanned > 0 && (
            <div className="flex items-center gap-1.5"><span className="text-[9px] font-semibold uppercase tracking-wider text-red-400">Over</span><span className="text-sm font-bold font-mono text-red-600">{qtySummary.overScanned}</span></div>
          )}
          <div className="flex items-center gap-1.5"><span className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">Box</span><span className="text-sm font-bold font-mono text-red-600">{S.box || '—'}</span></div>
        </div>

        {/* Always-visible per-box video upload statuses (non-blocking for next box). */}
        {(boxVideoStatuses.length > 0 || recState === 'REC' || pendingUploads > 0) && S.cid && (
          <div className="mt-2 rounded-xl px-3 py-2 bg-white border border-slate-100 shadow-sm">
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <span className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">Box videos</span>
              <span className="text-[9px] text-slate-400">
                Next box is not blocked by uploads · Finish waits for verified
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {recState === 'REC' && S.box && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-red-50 text-red-700 border border-red-200">
                  Box {S.box}: recording
                </span>
              )}
              {boxVideoStatuses
                .filter((item) => !S.cid || String(item.consignmentId || '') === String(S.cid) || !item.consignmentId)
                .map((item) => {
                  const status = item.status || VIDEO_STATUS.QUEUED
                  const tone =
                    status === VIDEO_STATUS.COMPLETED || status === 'completed' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    : status === VIDEO_STATUS.FAILED || status === VIDEO_STATUS.STORAGE_FAILED ? 'bg-red-50 text-red-700 border-red-200'
                    : status === VIDEO_STATUS.RETRYING ? 'bg-amber-50 text-amber-700 border-amber-200'
                    : status === VIDEO_STATUS.VERIFYING ? 'bg-violet-50 text-violet-700 border-violet-200'
                    : status === VIDEO_STATUS.UPLOADING ? 'bg-blue-50 text-blue-700 border-blue-200'
                    : 'bg-slate-50 text-slate-600 border-slate-200'
                  return (
                    <span
                      key={item.id}
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold border ${tone}`}
                      title={item.lastError || undefined}
                    >
                      Box {item.boxNo || '?'}: {status}
                      {status === VIDEO_STATUS.UPLOADING || status === VIDEO_STATUS.VERIFYING
                        ? ` ${Math.round(item.progress || 0)}%`
                        : ''}
                    </span>
                  )
                })}
              {!boxVideoStatuses.length && pendingUploads > 0 && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">
                  {pendingUploads} queued for upload
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Main Grid */}
      <div className="max-w-[1440px] mx-auto px-3 pt-3 grid gap-3 min-h-[calc(100vh-50px)]" style={{ gridTemplateColumns: '280px 1fr 240px' }}>
        {/* Left Column */}
        <div className="flex flex-col gap-3">
          {/* Zone 1 */}
          <div id="z1" className={`rounded-xl p-3 border-2 relative overflow-hidden transition-all ${zone===1?'border-emerald-500 animate-[popIn_.4s]':'border-slate-200 opacity-40 pointer-events-none'} bg-white shadow-sm`}>
            <div className="flex items-center gap-2 mb-2">
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold transition-colors ${zone===1?'bg-emerald-500 text-white':'bg-slate-100 text-slate-400'}`}>1</div>
              <div className={`text-xs font-semibold ${zone===1?'text-emerald-600':'text-slate-500'}`}>Scan Consignment ID</div>
            </div>
            <div className="flex flex-col gap-2">
              {sortedConsignmentList.length > 0 && (
                <>
                <select
                  className="w-full px-2.5 py-1.5 border rounded-lg outline-none transition-all text-[10px] bg-slate-50 border-slate-200 text-slate-700"
                  onChange={e => { if (e.target.value) { inCidRef.current.value = e.target.value; doLoad(); e.target.value = ''; } }}
                  defaultValue=""
                >
                  <option value="">Select shipment (by priority)…</option>
                  {sortedConsignmentList.map(c => {
                    const p = getShipmentPriority(c);
                    const loadKey = c.internalShipmentNo || c.shipmentNo || c.id;
                    return (
                      <option key={c.id} value={loadKey}>
                        [{getDisplayLabel(p)}] {c.internalShipmentNo || c.id} · {p.packingPercent ?? 0}% · Dispatch {formatDispatchDate(c.requiredDispatchDate || c.scheduledDispatchDate)}
                      </option>
                    );
                  })}
                </select>
                <div className="max-h-28 overflow-y-auto rounded-lg border border-slate-100 bg-slate-50/80 p-1.5 space-y-1">
                  {sortedConsignmentList.slice(0, 6).map(c => {
                    const p = getShipmentPriority(c);
                    const loadKey = c.internalShipmentNo || c.shipmentNo || c.id;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => { inCidRef.current.value = loadKey; doLoad(); }}
                        className={`w-full text-left px-2 py-1.5 rounded-md border transition-colors ${getCriticalityCardClass(p)}`}
                      >
                        <div className="flex items-center gap-1.5">
                          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${p.dotClass} ${p.level === 'critical' ? 'animate-blink-dot' : ''}`} />
                          <span className="text-[10px] font-semibold text-slate-800 truncate">{c.internalShipmentNo || c.id}</span>
                          {p.level !== 'normal' && (
                            <span className={`text-[9px] font-bold ml-auto ${p.level === 'critical' ? 'text-red-600' : p.level === 'high' ? 'text-orange-600' : 'text-amber-600'}`}>
                              {getDisplayLabel(p)}
                            </span>
                          )}
                        </div>
                        <div className="mt-1 pl-3">
                          <UnitsProgressCell consignment={c} barWidth="w-full" showCounts={false} />
                        </div>
                        <div className="text-[9px] text-slate-400 pl-3 mt-0.5">Dispatch {formatDispatchDate(c.requiredDispatchDate || c.scheduledDispatchDate)}</div>
                      </button>
                    );
                  })}
                </div>
                </>
              )}
              <div className="flex gap-2">
                <input ref={inCidRef} placeholder="ID / Shipment No / Internal Ship No..." autoFocus className="flex-1 px-2.5 py-2 border rounded-lg outline-none transition-all text-xs bg-slate-50 border-slate-200 text-slate-900 font-mono focus:ring-2 focus:ring-primary-500" onKeyDown={e => e.key==='Enter'&&doLoad()} />
                <button onClick={doLoad} disabled={loading || uploading} className="relative overflow-hidden px-4 py-2 rounded-lg text-xs font-semibold text-white cursor-pointer transition-all active:scale-[0.96] bg-red-500 hover:bg-red-600">
                  {loading || uploading ? <span className="spin" /> : 'Load'}
                </button>
              </div>
            </div>
          </div>

          {/* Zone 2 */}
          <div id="z2" className={`rounded-xl p-3 border-2 relative overflow-hidden transition-all ${zone===2?'border-emerald-500 animate-[popIn_.4s]':'border-slate-200 opacity-40 pointer-events-none'} bg-white shadow-sm`}>
            <div className="flex items-center gap-2 mb-2">
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold transition-colors ${zone===2?'bg-emerald-500 text-white':'bg-slate-100 text-slate-400'}`}>2</div>
              <div className={`text-xs font-semibold ${zone===2?'text-emerald-600':'text-slate-500'}`}>Enter Box Number</div>
            </div>
            <div className="flex gap-2">
              <input
                ref={inBoxRef}
                placeholder="Box no... (numbers only)"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="off"
                className="flex-1 px-2.5 py-2 border rounded-lg outline-none transition-all text-xs bg-slate-50 border-slate-200 text-slate-900 font-mono focus:ring-2 focus:ring-primary-500"
                onChange={handleBoxNumberInput}
                onKeyDown={e => e.key==='Enter'&&doBox()}
              />
              <button onClick={doBox} className="relative overflow-hidden px-4 py-2 rounded-lg text-xs font-semibold text-white cursor-pointer transition-all active:scale-[0.96] bg-emerald-500 hover:bg-emerald-600">Set</button>
            </div>
          </div>

          {/* Zone 3 */}
          <div id="z3" className={`rounded-xl p-3 border-2 relative overflow-hidden transition-all ${zone===3?'border-emerald-500 animate-[popIn_.4s]':'border-slate-200 opacity-40 pointer-events-none'} bg-white shadow-sm`}>
            <div className="flex items-center gap-2 mb-2">
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold transition-colors ${zone===3?'bg-emerald-500 text-white':'bg-slate-100 text-slate-400'}`}>3</div>
              <div className="flex-1 flex justify-between text-xs font-semibold">
                <span className={zone===3?'text-emerald-600':'text-slate-500'}>Scan SKU Barcode</span>
                <span className="text-slate-500">Box Qty: <strong className="text-xs text-red-500">{currentBoxItems.reduce((s,i)=>s+i.qty,0)}</strong></span>
              </div>
            </div>
            <form onSubmit={e => { e.preventDefault(); doScan(); }}>
              <input
                ref={inSkuRef}
                placeholder={packingAllowPaste ? 'Paste barcode to count' : 'Scan marketplace barcode…'}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                inputMode={packingAllowPaste ? 'text' : 'none'}
                className="w-full px-2.5 py-2 border rounded-lg outline-none transition-all text-xs bg-slate-50 border-slate-200 text-slate-900 font-mono focus:ring-2 focus:ring-primary-500"
                onFocus={primeScanAudio}
                onKeyDown={(e) => {
                  scannerGuardRef.current.noteKeyDown();
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    doScan();
                  }
                }}
                onPaste={handleSkuBarcodePaste}
              />
            </form>
            <div className="flex gap-1.5 flex-wrap mt-2.5">
              <button onClick={doSaveBox} disabled={loading} className="px-3 py-1.5 rounded-lg text-[10px] font-semibold text-white cursor-pointer transition-all active:scale-[0.96] bg-emerald-500 hover:bg-emerald-600 disabled:opacity-60">💾 Save</button>
              <button onClick={doNewBox} disabled={loading} className="px-3 py-1.5 rounded-lg text-[11px] font-semibold text-white cursor-pointer transition-all active:scale-[0.96] bg-amber-600 hover:bg-amber-700 shadow-md shadow-amber-200 disabled:opacity-60">📦 NEXT BOX</button>
              <button onClick={doDL} className="px-3 py-1.5 rounded-lg text-[10px] font-semibold border cursor-pointer transition-all active:scale-[0.96] bg-white text-slate-600 border-slate-200 hover:bg-slate-50">⬇ PDF</button>
              <button onClick={doFinish} disabled={loading} className="px-3 py-1.5 rounded-lg text-[10px] font-semibold text-white cursor-pointer transition-all active:scale-[0.96] bg-red-500 hover:bg-red-600 disabled:opacity-60">✅ Done</button>
            </div>
          </div>

          {/* Camera with Floating PiP & Grid toggles */}
          <div className="relative">
            <div className={`overflow-hidden border bg-white shadow-sm border-slate-200 transition-all duration-300 ${floatingCamera ? 'fixed bottom-4 right-4 z-[999] w-[320px] rounded-xl shadow-2xl border-primary-500' : 'rounded-xl'}`}>
              <div className="px-3 py-2 border-b border-slate-100 flex items-center justify-between text-xs font-semibold bg-slate-50">
                <div className="flex items-center gap-1.5">
                  <span>📹 CCTV Feed</span>
                  <span className={`text-[9px] px-2 py-0.5 rounded-full font-medium ${camActive ? 'bg-red-50 text-red-600' : 'bg-slate-100 text-slate-400'}`}>{camActive ? 'LIVE' : 'OFFLINE'}</span>
                </div>
                <div className="flex items-center gap-1">
                  {camActive && (
                    <button
                      type="button"
                      onClick={() => setGridEnabled(!gridEnabled)}
                      className={`px-1.5 py-0.5 rounded text-[9px] font-bold transition-all ${gridEnabled ? 'bg-primary-50 text-primary-600 border border-primary-200' : 'bg-white text-slate-400 border border-slate-200'}`}
                      title="Toggle Center Alignment Grid"
                    >
                      Grid
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setFloatingCamera(!floatingCamera)}
                    className={`px-1.5 py-0.5 rounded text-[9px] font-bold border transition-all ${floatingCamera ? 'bg-primary-600 text-white border-primary-600 shadow-sm' : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50'}`}
                    title={floatingCamera ? "Dock Camera to Sidebar" : "Float Camera (PiP)"}
                  >
                    {floatingCamera ? "Dock" : "Float (PiP)"}
                  </button>
                </div>
              </div>
              <div className="relative w-full bg-slate-900" style={{ aspectRatio: '16/9' }}>
                <video ref={videoRef} autoPlay muted playsInline className="absolute inset-0 w-full h-full object-cover" />
                <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" style={{ display: camActive ? 'block' : 'none' }} />
                {!camActive && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-slate-900/95 px-4 text-center">
                    <span className="text-3xl">{cameraStarting ? '⏳' : '📹'}</span>
                    <span className="text-xs uppercase tracking-wider text-slate-400">
                      {cameraStarting ? 'Starting Camera…' : 'No Camera Signal'}
                    </span>
                    {cameraError && (
                      <p className="text-[10px] leading-relaxed text-red-300 max-w-[240px]">{cameraError}</p>
                    )}
                  </div>
                )}
              </div>
              <div className="px-3 py-1.5 flex justify-between items-center border-t border-slate-100 text-center bg-slate-50/50">
                <div><span className="text-[7.5px] uppercase tracking-wider block text-slate-400">Resolution</span><span className="text-[10px] font-semibold text-slate-700 font-mono">{camRes}</span></div>
                <div><span className="text-[7.5px] uppercase tracking-wider block text-slate-400">Duration</span><span className="text-[10px] font-semibold text-slate-700 font-mono">{recDuration}</span></div>
                <div><span className="text-[7.5px] uppercase tracking-wider block text-slate-400">Size</span><span className="text-[10px] font-semibold text-slate-700 font-mono">{recSize}</span></div>
              </div>
              <div className="px-3 py-2 bg-slate-50 border-t border-slate-100">
                <button
                  onClick={startCamera}
                  disabled={cameraStarting}
                  className={`w-full justify-center px-3 py-1.5 rounded-lg text-xs font-semibold text-white cursor-pointer transition-all disabled:opacity-60 disabled:cursor-not-allowed ${camActive ? 'bg-emerald-400' : 'bg-emerald-500 hover:bg-emerald-600'}`}
                >
                  {cameraStarting ? 'Starting Camera…' : camActive ? '✓ Camera Active' : '📷 Start Camera'}
                </button>
              </div>
            </div>

            {/* Sidebar Placeholder shown only when Camera card is floating */}
            {floatingCamera && (
              <div onClick={() => setFloatingCamera(false)} className="rounded-xl overflow-hidden border border-dashed border-slate-300 bg-slate-50/50 p-4 text-center cursor-pointer hover:bg-slate-50 transition-colors flex flex-col items-center justify-center gap-1.5 min-h-[160px]">
                <span className="text-xl animate-pulse">📺</span>
                <span className="text-[11px] font-semibold text-slate-500">Camera is Floating</span>
                <span className="text-[9px] text-slate-400 uppercase tracking-wider">Click to Dock to Sidebar</span>
              </div>
            )}
          </div>

          {/* Upload Progress */}
          <div className={`px-3 py-2 ${showUpload ? 'block' : 'hidden'}`}>
            <div className="text-[10px] mb-1 text-slate-500 flex justify-between gap-2">
              <span>
                {currentVideoUpload
                  ? `${currentVideoUpload.status === VIDEO_STATUS.VERIFYING ? 'Verifying' : 'Uploading'} Box #${currentVideoUpload.boxNo || '?'}…`
                  : pendingUploads > 0
                    ? `${pendingUploads} video(s) in background queue`
                    : 'Saving video…'}
              </span>
              <span className="font-mono">{uploadProgress || 0}%</span>
            </div>
            <div className="h-[3px] rounded-sm overflow-hidden bg-slate-200">
              <div className="h-full rounded-sm transition-[width] duration-300 bg-emerald-500" style={{ width: Math.max(0, Math.min(100, uploadProgress || 0)) + '%' }} />
            </div>
          </div>
        </div>

        {/* Center Column */}
        <div className="flex flex-col gap-3">
          {/* SKU Tracking */}
          <div className="flex-1 rounded-xl border overflow-hidden shadow-sm transition-all hover:shadow-md bg-white border-slate-100">
            <div className="px-3 py-2 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-xs font-semibold flex items-center gap-1 text-slate-700">📋 SKU Tracking</h3>
              <div className="flex items-center gap-2">
                <div className="flex gap-1 flex-wrap">
                  {['all','pending','done','current'].map(f => (
                    <button key={f} onClick={() => setSkuFilter(f)} className={`px-2 py-1 rounded-full text-[9px] font-semibold cursor-pointer border transition-all ${skuFilter===f?'bg-emerald-500 text-white border-emerald-500':'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'}`}>{f==='current'?'Current Box':f}</button>
                  ))}
                </div>
                <span className="text-[10px] text-slate-400">{filteredSkus.length}/{S.skus.length} items</span>
              </div>
            </div>
            <div className="p-0">
              {!S.skus.length ? (
                <div className="text-center py-6 text-slate-400">
                  <div className="text-[28px] mb-1.5">📦</div>
                  <div className="text-xs font-medium text-slate-500">No consignment loaded</div>
                  <div className="text-[10px] mt-0.5">Scan a consignment ID to begin</div>
                </div>
              ) : (
                <div className="max-h-[calc(100vh-200px)] overflow-y-auto" style={{ scrollbarWidth: 'thin', scrollbarColor: '#e2e8f0 transparent' }}>
                  <table className="w-full border-separate border-spacing-0 text-[10.5px]">
                    <thead><tr>
                      <th className="px-2 py-[5px] text-left text-[9px] font-semibold uppercase tracking-wider sticky top-0 z-[1] bg-slate-50 text-slate-500 border-b border-slate-100">#</th>
                      <th className="px-2 py-[5px] text-left text-[9px] font-semibold uppercase tracking-wider sticky top-0 z-[1] bg-slate-50 text-slate-500 border-b border-slate-100">Barcode</th>
                      <th className="px-2 py-[5px] text-left text-[9px] font-semibold uppercase tracking-wider sticky top-0 z-[1] bg-slate-50 text-slate-500 border-b border-slate-100">Name</th>
                      <th className="px-2 py-[5px] text-left text-[9px] font-semibold uppercase tracking-wider sticky top-0 z-[1] bg-slate-50 text-slate-500 border-b border-slate-100">Req</th>
                      <th className="px-2 py-[5px] text-left text-[9px] font-semibold uppercase tracking-wider sticky top-0 z-[1] bg-slate-50 text-slate-500 border-b border-slate-100">Pkd</th>
                      <th className="px-2 py-[5px] text-left text-[9px] font-semibold uppercase tracking-wider sticky top-0 z-[1] bg-slate-50 text-slate-500 border-b border-slate-100">Left</th>
                      <th className="px-2 py-[5px] text-left text-[9px] font-semibold uppercase tracking-wider sticky top-0 z-[1] bg-slate-50 text-slate-500 border-b border-slate-100">Over</th>
                      <th className="px-2 py-[5px] text-left text-[9px] font-semibold uppercase tracking-wider sticky top-0 z-[1] bg-slate-50 text-slate-500 border-b border-slate-100">%</th>
                    </tr></thead>
                    <tbody>
                      {filteredSkus.map((s, i) => {
                        const p = s.required > 0 ? Math.round(s.packed / s.required * 100) : 0;
                        const locked = s.remaining === 0 && s.required > 0 && (s.overScanned || 0) === 0;
                        const over = s.overScanned || 0;
                        return (
                          <tr key={s.marketplaceSku} className={`hover:bg-emerald-50/50 transition-colors ${locked ? 'opacity-60 bg-emerald-50/30' : ''} ${over > 0 ? 'bg-red-50/60' : ''}`}>
                            <td className="px-2 py-1 border-b border-slate-50 font-semibold text-slate-400">{i+1}</td>
                            <td className="px-2 py-1 border-b border-slate-50 font-mono text-[9px] max-w-[120px] overflow-hidden text-ellipsis whitespace-nowrap" title={s.barcode || s.marketplaceSku}>{s.barcode || s.marketplaceSku}</td>
                            <td className="px-2 py-1 border-b border-slate-50 text-[10px] max-w-[130px] overflow-hidden text-ellipsis whitespace-nowrap" title={s.internalSku}>{s.internalSku}</td>
                            <td className="px-2 py-1 border-b border-slate-50"><span className="inline-block px-[5px] py-[1px] rounded text-[10px] font-semibold font-mono bg-slate-100 text-slate-500">{s.required}</span></td>
                            <td className="px-2 py-1 border-b border-slate-50"><span className={`inline-block px-[5px] py-[1px] rounded text-[10px] font-semibold font-mono ${locked ? 'bg-emerald-50 text-emerald-600' : p > 0 ? 'bg-amber-50 text-amber-600' : 'bg-slate-100 text-slate-500'}`}>{s.packed}</span></td>
                            <td className="px-2 py-1 border-b border-slate-50"><span className={`inline-block px-[5px] py-[1px] rounded text-[10px] font-semibold font-mono ${s.remaining === 0 ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>{s.remaining}</span></td>
                            <td className="px-2 py-1 border-b border-slate-50"><span className={`inline-block px-[5px] py-[1px] rounded text-[10px] font-semibold font-mono ${over > 0 ? 'bg-red-50 text-red-600' : 'bg-slate-100 text-slate-400'}`}>{over > 0 ? over : '—'}</span></td>
                            <td className="px-2 py-1 border-b border-slate-50 min-w-[70px]">
                              <div className={`text-[9px] font-semibold font-mono ${p >= 100 ? 'text-emerald-600' : p > 50 ? 'text-amber-500' : 'text-red-500'}`}>{p}%</div>
                              <div className="w-full h-1 rounded-sm overflow-hidden bg-slate-100 mt-0.5">
                                <div className="h-full rounded-sm transition-[width] duration-75" style={{ width: Math.min(p, 100) + '%', background: p >= 100 ? '#10b981' : p > 50 ? '#f59e0b' : '#ef4444' }} />
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {/* Current Box Items */}
          <div className={`flex-1 rounded-xl border overflow-hidden shadow-sm bg-white border-slate-100 ${currentBoxItems.length ? 'block' : 'hidden'}`}>
            <div className="px-3 py-2 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-xs font-semibold text-red-500">📦 Current Box Items</h3>
              <span className="text-[10px] text-slate-400">{currentBoxItems.length} items</span>
            </div>
            <div className="p-2 space-y-1">
              {currentBoxItems.map(item => (
                <div key={item.marketplaceSku} className="flex items-center justify-between p-1.5 rounded-md bg-slate-50">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono text-slate-400">{item.marketplaceSku}</span>
                    <span className="text-[10px] font-medium text-slate-700">{item.internalSku}</span>
                    <span className="text-[10px] font-semibold text-red-500">x{item.qty}</span>
                  </div>
                  <button onClick={() => removeItem(item.marketplaceSku)} className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors">✕</button>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right Column */}
        <div className="flex-col gap-3 hidden xl:flex">
          {/* Boxes Pivot */}
          <div className={`rounded-xl border overflow-hidden shadow-sm bg-white border-slate-100 ${Object.keys(S.boxes).length ? 'block' : 'hidden'}`}>
            <div className="px-3 py-2 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-xs font-semibold text-slate-700">📊 Boxes</h3>
              <span className="text-[10px] text-slate-400">{Object.keys(S.boxes).filter(k => S.boxes[k].length).length}</span>
            </div>
            <div className="p-0">
              <table className="w-full border-separate border-spacing-0 text-[10px]">
                <thead><tr>
                  <th className="px-2 py-1 text-left text-[9px] font-semibold uppercase tracking-wider bg-slate-50 text-slate-500 border-b border-slate-100">Box</th>
                  <th className="px-2 py-1 text-left text-[9px] font-semibold uppercase tracking-wider bg-slate-50 text-slate-500 border-b border-slate-100">Items</th>
                  <th className="px-2 py-1 text-left text-[9px] font-semibold uppercase tracking-wider bg-slate-50 text-slate-500 border-b border-slate-100">Qty</th>
                </tr></thead>
                <tbody>
                  {Object.entries(S.boxes).filter(([,items]) => items.length).map(([boxNo, items]) => (
                    <tr key={boxNo} className="border-b border-slate-50">
                      <td className="px-2 py-1 font-semibold text-slate-700">#{boxNo}</td>
                      <td className="px-2 py-1 text-slate-600">{items.length}</td>
                      <td className="px-2 py-1 text-slate-600">{items.reduce((s,i)=>s+i.qty,0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pending Items */}
          {S.skus.filter(s => s.remaining > 0).length > 0 && (
            <div className="rounded-xl border overflow-hidden shadow-sm bg-white border-slate-100">
              <div className="px-3 py-2 border-b border-slate-100">
                <h3 className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">Pending Items</h3>
              </div>
              <div className="p-2 space-y-0.5 max-h-[300px] overflow-y-auto">
                {S.skus.filter(s => s.remaining > 0).map(sku => (
                  <div key={sku.marketplaceSku} className="flex justify-between text-[10px]">
                    <span className="text-slate-400 truncate max-w-[120px]">{sku.internalSku}</span>
                    <span className="text-amber-600 font-medium">{sku.remaining} left</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Toasts */}
      <ToastContainer toasts={toasts} onRemove={removeToast} />

      {/* Confirm Modal */}
      <Modal show={showMo} title={moConfig.title} wide={moConfig.wide} onClose={() => setShowMo(false)} actions={moConfig.actions}>{moConfig.body}</Modal>

      <QuantityRemovalModal
        open={removalModal.open}
        consignmentId={S.cid}
        boxNo={removalModal.boxNo}
        displayConsignmentId={S.intShip || S.cid}
        mediaStream={removalModal.stream || streamRef.current}
        toast={toast}
        onClose={() => setRemovalModal({ open: false, boxNo: null, stream: null })}
        onCompleted={async () => {
          if (S.cid) {
            try {
              await refreshPackingSession(S.cid, { preferServerBoxes: true });
            } catch (_) { /* ignore */ }
          }
        }}
      />

      {/* Dashboard Modal */}
      <Modal show={showDashboard} title="📊 Productivity" onClose={() => setShowDashboard(false)} actions={<button onClick={() => setShowDashboard(false)} className="px-3 py-1.5 border border-slate-200 rounded-lg text-[11px] font-medium hover:bg-slate-50">Close</button>}>
        {dashData && (
          <div className="grid grid-cols-2 gap-2 my-3">
            <div className="p-2.5 rounded-lg text-center bg-slate-50"><div className="text-xl font-extrabold text-emerald-600">{dashData.boxes_today}</div><div className="text-[9px] uppercase text-slate-400">Boxes Today</div></div>
            <div className="p-2.5 rounded-lg text-center bg-slate-50"><div className="text-xl font-extrabold text-red-500">{dashData.items_today}</div><div className="text-[9px] uppercase text-slate-400">Items Today</div></div>
            <div className="p-2.5 rounded-lg text-center bg-slate-50"><div className="text-xl font-extrabold text-slate-700">{dashData.avg_speed}</div><div className="text-[9px] uppercase text-slate-400">Avg Items/Box</div></div>
            <div className="p-2.5 rounded-lg text-center bg-slate-50"><div className="text-xl font-extrabold text-slate-700">—</div><div className="text-[9px] uppercase text-slate-400">Avg Time/Box</div></div>
          </div>
        )}
      </Modal>

      {/* Resume Modal */}
      <Modal show={showResumeModal} title="♻️ Resume Packing?" onClose={() => setShowResumeModal(false)} actions={<button onClick={() => setShowResumeModal(false)} className="px-3 py-1.5 border border-slate-200 rounded-lg text-[11px] font-medium hover:bg-slate-50">Start Fresh</button>}>
        <div className="text-left text-xs mb-2.5">You have <strong>{resumeList.length}</strong> in-progress consignment{resumeList.length > 1 ? 's' : ''}:</div>
        <div className="max-h-[250px] overflow-y-auto border rounded-lg border-slate-100">
          <table className="w-full text-[10px]">
            <thead><tr className="bg-slate-50"><th className="p-1 text-left text-slate-600">Consignment</th><th className="p-1 text-slate-600">Boxes</th><th className="p-1 text-slate-600">Packed</th><th></th></tr></thead>
            <tbody>
              {resumeList.map(c => {
                const pct = c.total_required > 0 ? Math.round(c.total_packed / c.total_required * 100) : 0;
                return (
                  <tr key={c.consignment_id} className="border-b border-slate-50">
                    <td className="p-1 font-bold text-slate-800">{c.consignment_id}</td>
                    <td className="p-1 text-center text-slate-600">{c.box_count}</td>
                    <td className="p-1 text-center font-semibold" style={{ color: pct >= 100 ? '#10b981' : pct > 50 ? '#f59e0b' : '#ef4444' }}>{c.total_packed}/{c.total_required} ({pct}%)</td>
                    <td className="p-1"><button onClick={() => { setShowResumeModal(false); inCidRef.current.value = c.consignment_id; doLoad(); }} className="px-2 py-0.5 rounded-md text-[9px] font-semibold text-white bg-emerald-500 hover:bg-emerald-600">Load</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Modal>

      {/* Label Modal */}
      <Modal show={showLabelModal} title="🖨️ Generate Labels / Restore" onClose={() => setShowLabelModal(false)} actions={null}>
        <p className="text-[11px] mb-3 text-slate-600">Upload CSV to generate labels or restore packing session</p>
        <input type="file" accept=".csv" className="w-full p-2 border rounded-lg mb-3 text-xs border-slate-200 bg-slate-50" />
        <button className="w-full px-3 py-2 rounded-lg text-xs font-semibold text-white mb-1.5 bg-emerald-500 hover:bg-emerald-600">Generate Labels from CSV</button>
        <button className="w-full px-3 py-2 rounded-lg text-xs font-semibold text-white mb-3 bg-amber-500 hover:bg-amber-600">♻️ Restore Session from CSV</button>
        <button onClick={() => setShowLabelModal(false)} className="w-full px-3 py-2 rounded-lg text-xs font-semibold border border-slate-200 hover:bg-slate-50">Cancel</button>
      </Modal>

      {/* Hidden Print Pending */}
      <button id="print-pending-btn" className="hidden" onClick={printPendingSkus} />

      {/* ── Video Upload Progress Modal (Finish / Done only — not Next Box) ── */}
      {showUploadLog && (
        <div className="fixed inset-0 bg-black/50 z-[10001] flex items-center justify-center backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-[420px] max-w-[95vw] overflow-hidden animate-pop-in">
            <div className="bg-gradient-to-r from-primary-600 to-primary-400 px-5 py-4 flex items-center justify-between">
              <div>
                <h3 className="text-white font-bold text-sm">Finishing — video upload</h3>
                <p className="text-white/80 text-[11px]">Keep this tab open until every box video is verified</p>
              </div>
              {uploadLog.every(l => ['completed', 'done', 'failed', 'error', 'retrying'].includes(l.status)) && (
                <button onClick={() => setShowUploadLog(false)} className="text-white/70 hover:text-white text-lg leading-none px-2">✕</button>
              )}
            </div>
            <div className="p-4 space-y-3 max-h-[320px] overflow-y-auto">
              {uploadLog.map((item) => {
                const done = item.status === 'completed' || item.status === 'done'
                const failed = item.status === 'failed' || item.status === 'error' || item.status === 'storage_failed'
                const active = item.status === 'uploading' || item.status === 'verifying' || item.status === 'retrying'
                return (
                <div key={item.id} className="bg-slate-50 rounded-xl p-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2 min-w-0">
                      {done && <span className="text-emerald-500 text-sm">✓</span>}
                      {failed && <span className="text-red-500 text-sm">×</span>}
                      {active && <span className="w-3.5 h-3.5 border-2 border-primary-300 border-t-primary-600 rounded-full animate-spin inline-block" />}
                      {item.status === 'queued' && <span className="text-slate-400 text-sm">…</span>}
                      <span className="text-[11px] font-medium text-slate-700 truncate">Box #{item.boxNo}</span>
                    </div>
                    <span className={`text-[10px] font-semibold ${done ? 'text-emerald-600' : failed ? 'text-red-600' : 'text-primary-600'}`}>
                      {done ? 'Verified' : failed ? 'Failed' : item.status === 'retrying' ? 'Retrying' : item.status === 'verifying' ? 'Verifying' : item.status === 'queued' ? 'Queued' : `${item.progress}%`}
                    </span>
                  </div>
                  <div className="progress-bar">
                    <div className="progress-bar-fill" style={{ width: `${item.progress}%`, background: done ? '#10b981' : failed ? '#ef4444' : undefined }} />
                  </div>
                  <p className="text-[9px] text-slate-400 mt-1 truncate">{item.name}</p>
                  {item.error && <p className="text-[9px] text-red-500 mt-1 truncate">{item.error}</p>}
                </div>
                )
              })}
            </div>
            <div className="border-t border-slate-100 px-4 py-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-slate-500">
                  {uploadLog.filter(l => l.status === 'completed' || l.status === 'done').length} / {uploadLog.length} verified
                </span>
                {uploadLog.every(l => ['completed', 'done', 'failed', 'error', 'retrying'].includes(l.status)) && (
                  <button onClick={() => setShowUploadLog(false)} className="px-4 py-1.5 bg-primary-600 text-white rounded-lg text-xs font-semibold hover:bg-primary-700 transition-colors">
                    Done
                  </button>
                )}
              </div>
              {uploadLog.some((l) => ['failed', 'error', 'retrying', 'queued', 'uploading', 'verifying'].includes(l.status)) && (
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => { void retryFailedSync(); }}
                    className="px-2.5 py-1.5 rounded-lg text-[10px] font-semibold bg-amber-500 text-white hover:bg-amber-600"
                  >
                    Retry all
                  </button>
                  <button
                    type="button"
                    onClick={() => { void clearDuplicateVideoUploads(); }}
                    className="px-2.5 py-1.5 rounded-lg text-[10px] font-semibold border border-slate-200 text-slate-600 hover:bg-slate-50"
                  >
                    Clear duplicates
                  </button>
                  <button
                    type="button"
                    onClick={() => { void discardFailedVideoUploads(); }}
                    className="px-2.5 py-1.5 rounded-lg text-[10px] font-semibold border border-red-200 text-red-600 hover:bg-red-50"
                  >
                    Discard failed
                  </button>
                  <button
                    type="button"
                    onClick={() => { void clearAllLocalVideoCache(); }}
                    className="px-2.5 py-1.5 rounded-lg text-[10px] font-semibold border border-red-300 text-red-700 hover:bg-red-50"
                  >
                    Clear all cache
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {showWeightModal && weightModalData && (
        <div className="fixed inset-0 bg-black/60 z-[10001] flex items-center justify-center backdrop-blur-[4px]">
          <WeightModalInner
            boxNo={weightModalData.boxNo}
            onSave={weightModalData.onSave}
            onSkip={weightModalData.onSkip}
            onCancel={() => setShowWeightModal(false)}
            weightUploading={weightUploading}
            weightUploadProgress={weightUploadProgress}
          />
        </div>
      )}
    </div>
  );
}

function WeightModalInner({ boxNo, onSave, onSkip, onCancel, weightUploading, weightUploadProgress }) {
  const [weight, setWeight] = useState('');
  const [unit, setUnit] = useState('KG');
  const [imageBlob, setImageBlob] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImageBlob(file);
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImagePreview(URL.createObjectURL(file));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!weight || Number(weight) <= 0) {
      alert('Weight is required and must be greater than 0');
      return;
    }
    onSave(Number(weight), unit, imageBlob);
  };

  return (
    <div className="bg-white rounded-2xl shadow-2xl w-[480px] max-w-[95vw] overflow-hidden animate-pop-in border border-slate-200" onClick={e => e.stopPropagation()}>
      <div className="bg-gradient-to-r from-primary-600 to-indigo-600 px-5 py-4 flex items-center justify-between">
        <div>
          <h3 className="text-white font-bold text-sm">⚖️ Box Weight Capture</h3>
          <p className="text-white/80 text-[10px]">Enter weight — upload scale photo manually (optional)</p>
        </div>
        <button type="button" onClick={onCancel} className="text-white/80 hover:text-white text-lg leading-none p-1 rounded-md hover:bg-white/10 transition-colors">✕</button>
      </div>

      <form onSubmit={handleSubmit} className="p-5 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold block mb-1">Box Number</label>
            <input
              type="text"
              readOnly
              value={`Box #${boxNo}`}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs bg-slate-50 text-slate-500 font-bold focus:outline-none"
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold block mb-1">Weight <span className="text-red-500">*</span></label>
            <div className="flex rounded-lg overflow-hidden border border-slate-200 focus-within:ring-2 focus-within:ring-primary-500">
              <input
                type="number"
                step="0.01"
                required
                min="0.01"
                placeholder="0.00"
                value={weight}
                onChange={e => setWeight(e.target.value)}
                className="w-full px-3 py-2 text-xs focus:outline-none border-none"
                autoFocus
              />
              <select
                value={unit}
                onChange={e => setUnit(e.target.value)}
                className="bg-slate-50 px-2 text-xs border-l border-slate-200 text-slate-600 focus:outline-none"
              >
                <option value="KG">KG</option>
                <option value="LBS">LBS</option>
              </select>
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold block">Weight scale proof photo (optional)</label>
          <p className="text-[10px] text-slate-500 leading-relaxed">
            The CCTV camera is already recording. Upload a photo from your phone or file manager after weighing the box.
          </p>
          <label className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-slate-200 bg-slate-50/70 hover:bg-slate-50 rounded-xl p-6 cursor-pointer transition-colors">
            <Upload className="w-6 h-6 text-slate-400" />
            <span className="text-xs font-semibold text-slate-600">Choose image file</span>
            <span className="text-[10px] text-slate-400">JPG, PNG, or WEBP</span>
            <input type="file" accept="image/*" onChange={handleFileUpload} className="hidden" />
          </label>
        </div>

        {imagePreview && (
          <div className="relative aspect-video w-full rounded-xl overflow-hidden border border-slate-200 bg-slate-100">
            <img src={imagePreview} className="w-full h-full object-contain" alt="Weight scale proof" />
            <button
              type="button"
              onClick={() => {
                setImageBlob(null);
                setImagePreview(null);
              }}
              className="absolute top-2 right-2 p-1.5 bg-black/60 hover:bg-black/80 text-white rounded-full transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
            <div className="absolute bottom-2 left-2 bg-emerald-500 text-white text-[9px] font-bold px-2 py-0.5 rounded-full shadow-sm">
              Ready to upload ✓
            </div>
          </div>
        )}

        {weightUploading && (
          <div className="space-y-1">
            <div className="flex justify-between text-[10px] text-slate-500 font-medium">
              <span className="flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin text-primary-500" /> Uploading image proof...</span>
              <span>{weightUploadProgress}%</span>
            </div>
            <div className="w-full bg-slate-100 h-1.5 rounded-full overflow-hidden">
              <div className="bg-primary-500 h-1.5 rounded-full transition-all duration-200" style={{ width: `${weightUploadProgress}%` }} />
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={weightUploading}
            className="w-1/4 py-2 border border-slate-200 hover:bg-slate-50 text-slate-700 text-xs font-semibold rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSkip}
            disabled={weightUploading}
            className="w-1/4 py-2 border border-slate-200 hover:bg-slate-50 text-slate-500 hover:text-slate-700 text-xs font-semibold rounded-lg transition-colors"
          >
            Skip
          </button>
          <button
            type="submit"
            disabled={weightUploading}
            className="w-2/4 py-2 bg-primary-600 hover:bg-primary-700 disabled:bg-primary-400 text-white text-xs font-semibold rounded-lg shadow-lg shadow-primary-100 transition-all flex items-center justify-center gap-1.5"
          >
            {weightUploading ? (
              <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving...</>
            ) : (
              'Save & Proceed'
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
