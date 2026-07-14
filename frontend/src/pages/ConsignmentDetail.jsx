import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, Package, Box, Video, FileText, Upload, AlertCircle,
  Trash2, Download, Loader2, FileSpreadsheet, CheckCircle2,
  Copy, ExternalLink, Tag, ChevronDown, ChevronUp, Database, Scale, AlertTriangle, History
} from 'lucide-react';
import ConfirmModal from '../components/ConfirmModal';
import { printShipmentBoxLabel, printAllShipmentBoxLabels } from '../utils/shipmentLabel';
import { consignmentsAPI, uploadsAPI, packingAPI } from '../services/api';
import { useToast } from '../context/ToastContext';
import { buildUploadStreamUrl, verifyUploadStream, fetchAuthenticatedStream } from '../utils/videoPlayback';
import { uploadFileToStorage } from '../hooks/useStorageUpload';
import { getShipmentPriority } from '../utils/priority';
import { useConsignmentSync } from '../context/ConsignmentSyncContext';
import { getProgressBarColor } from '../utils/criticalityUi';
import CriticalityBadge from '../components/CriticalityBadge';
import OmsGuruChecklist from '../components/OmsGuruChecklist';
import ConsignmentWorkflowPanel from '../components/ConsignmentWorkflowPanel';
import { useAuth } from '../context/AuthContext';
import { summarizeOmsGuruSkus } from '../utils/omsGuruSku';
import { inwardStatusClass, inwardStatusLabel } from '../utils/inwardSku';

const PACKING_LIVE_TYPES = new Set([
  'packing_scan',
  'packing_decrement',
  'packing_save_box',
  'packing_drafts',
  'quantity_removal',
  'box_quantity_edit',
  'inward_import',
  'skus',
  'boxes',
  'box_items',
  'scan_events',
  'consignments',
]);

function formatBoxBreakdown(boxQuantities = {}) {
  const entries = Object.entries(boxQuantities || {}).filter(([, qty]) => Number(qty) > 0);
  if (!entries.length) return '—';
  return entries
    .sort(([a], [b]) => String(a).localeCompare(String(b), undefined, { numeric: true }))
    .map(([boxNo, qty]) => `Box ${boxNo}: ${qty}`)
    .join(' · ');
}

function mergeLivePackingSession(consignment, syncData) {
  if (!consignment || !syncData?.sessionActive) return consignment;

  const liveById = new Map((syncData.skus || []).map((sku) => [sku.id, sku]));
  let totalPackedQty = 0;
  const skus = (consignment.skus || []).map((sku) => {
    const live = liveById.get(sku.id);
    if (!live) return sku;
    const requiredQty = Number(sku.requiredQty ?? live.required ?? 0);
    const packedQty = Number(live.packed) || 0;
    const overScanned = Math.max(0, packedQty - requiredQty);
    totalPackedQty += packedQty;
    return {
      ...sku,
      packedQty,
      boxQuantities: live.boxQuantities || sku.boxQuantities || {},
      liveOverScanned: overScanned > 0,
      status: requiredQty > 0 && packedQty >= requiredQty ? 'completed' : (sku.status || 'pending'),
    };
  });

  const savedBoxes = [...(consignment.boxes || [])];
  const savedBoxNos = new Set(savedBoxes.map((b) => String(b.boxNo)));
  const liveBoxes = syncData.boxes || {};

  for (const [boxNo, items] of Object.entries(liveBoxes)) {
    if (!Array.isArray(items) || items.length === 0) continue;
    const totalQty = items.reduce((sum, item) => sum + (Number(item.qty) || 0), 0);
    const existingIdx = savedBoxes.findIndex((b) => String(b.boxNo) === String(boxNo));
    const overlay = {
      items,
      totalQty,
      liveUnsaved: !savedBoxNos.has(String(boxNo)),
    };
    if (existingIdx >= 0) {
      savedBoxes[existingIdx] = { ...savedBoxes[existingIdx], ...overlay };
    } else {
      savedBoxes.push({
        id: `${consignment.id}_box_${boxNo}`,
        boxNo: String(boxNo),
        consignmentId: consignment.id,
        ...overlay,
      });
    }
  }

  savedBoxes.sort((a, b) => String(a.boxNo).localeCompare(String(b.boxNo), undefined, { numeric: true }));

  return {
    ...consignment,
    totalPackedQty: syncData.totals?.totalPackedQty ?? totalPackedQty ?? consignment.totalPackedQty,
    totalRequiredQty: syncData.totals?.totalRequiredQty ?? consignment.totalRequiredQty,
    skus,
    boxes: savedBoxes,
    liveSessionActive: true,
  };
}

async function loadConsignmentWithLiveSession(consignmentId) {
  const [consignmentRes, syncRes] = await Promise.all([
    consignmentsAPI.getById(consignmentId),
    packingAPI.syncStatus(consignmentId).catch(() => null),
  ]);
  return mergeLivePackingSession(consignmentRes.data.consignment, syncRes?.data);
}

function VideoPreviewCard({ video, boxNo, onDelete, addToast, canDelete }) {
  const [src, setSrc] = useState(null);
  const [loadingSrc, setLoadingSrc] = useState(true);
  const [loadError, setLoadError] = useState('');
  const refreshAttempted = useRef(false);

  const loadPlayUrl = async (force = false) => {
    if (!video?.id) return;
    if (force) refreshAttempted.current = false;
    if (refreshAttempted.current && !force) return;
    refreshAttempted.current = true;
    setLoadingSrc(true);
    setLoadError('');

    // Prefer durable share URL (works on mobile without JWT in <video src>).
    try {
      const { data } = await uploadsAPI.getShareLink(video.id, 'video');
      if (data?.shareUrl) {
        setSrc(data.shareUrl);
        setLoadingSrc(false);
        return;
      }
    } catch {
      // fall through to authenticated stream
    }

    const verified = await verifyUploadStream(video.id, 'video');
    if (verified.ok && verified.streamUrl) {
      setSrc(verified.streamUrl);
      setLoadingSrc(false);
      return;
    }

    try {
      const { data } = await uploadsAPI.getPlayUrl(video.id, 'video');
      const streamPath = data?.streamUrl || data?.playUrl || data?.url;
      if (streamPath && String(streamPath).startsWith('/api/')) {
        const streamSrc = buildUploadStreamUrl(video.id, 'video');
        if (streamSrc) {
          setSrc(streamSrc);
          setLoadingSrc(false);
          return;
        }
      }
    } catch {
      // fall through
    }

    const message = verified.error || 'Could not load video preview';
    setLoadError(message);
    addToast?.(message, 'error');
    setLoadingSrc(false);
  };

  useEffect(() => {
    refreshAttempted.current = false;
    setSrc(null);
    setLoadError('');
    loadPlayUrl();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video?.id, video?.playUrl, video?.url, video?.storageUrl]);

  const refreshPlayUrl = () => loadPlayUrl(true);

  const handleShare = async () => {
    try {
      const { data } = await uploadsAPI.getShareLink(video.id, 'video');
      const link = data?.shareUrl || data?.url;
      if (!link) throw new Error('No URL');
      await navigator.clipboard?.writeText(link);
      addToast('Shareable video link copied (works anytime — no login)', 'success');
    } catch {
      addToast('Could not copy video link — check permissions', 'error');
    }
  };

  const handleOpen = async (e) => {
    e.preventDefault();
    try {
      const { data } = await uploadsAPI.getShareLink(video.id, 'video');
      if (data?.shareUrl) {
        window.open(data.shareUrl, '_blank', 'noopener,noreferrer');
        return;
      }
    } catch {
      // fall through
    }
    const streamSrc = buildUploadStreamUrl(video.id, 'video');
    if (streamSrc) {
      window.open(streamSrc, '_blank', 'noopener,noreferrer');
      return;
    }
    addToast('Video link unavailable — please sign in again', 'error');
  };

  const handleDownload = async () => {
    try {
      let downloadUrl = null;
      let fileName = video.originalName || `box_${boxNo || video.boxNo || 'video'}.webm`;
      try {
        const { data } = await uploadsAPI.getShareLink(video.id, 'video');
        downloadUrl = data?.shareUrl || null;
        if (data?.originalName) fileName = data.originalName;
      } catch {
        // fall through
      }

      if (!downloadUrl) {
        const response = await fetchAuthenticatedStream(video.id, 'video');
        const blob = await response.blob();
        downloadUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(downloadUrl);
        return;
      }

      // Stream original bytes from durable share URL (same object as uploaded).
      const response = await fetch(downloadUrl);
      if (!response.ok) throw new Error(`Download failed (${response.status})`);
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(objectUrl);
    } catch {
      addToast('Could not download video', 'error');
    }
  };

  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden hover:shadow-md transition-shadow">
      {loadingSrc && !src ? (
        <div className="aspect-video bg-slate-900 flex items-center justify-center">
          <Loader2 className="w-8 h-8 text-slate-500 animate-spin" />
        </div>
      ) : src ? (
        <video
          key={src}
          src={src}
          controls
          className="w-full aspect-video bg-slate-900"
          preload="metadata"
          playsInline
          onLoadedData={() => setLoadingSrc(false)}
          onError={() => {
            if (!loadError) {
              setLoadError('Video failed to play');
              refreshPlayUrl();
            }
          }}
        />
      ) : (
        <div className="aspect-video bg-slate-900 flex flex-col items-center justify-center gap-2 px-4 text-center">
          <Video className="w-12 h-12 text-slate-600" />
          {loadError && <p className="text-xs text-red-300">{loadError}</p>}
        </div>
      )}
      <div className="p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium text-slate-900 truncate flex-1">
            {boxNo ? `Box #${boxNo}` : video.originalName}
          </p>
          <span className="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded shrink-0">{Math.round((video.size || 0) / 1024)} KB</span>
        </div>
        {boxNo ? <p className="text-xs text-slate-500 mt-0.5 truncate" title={video.originalName}>{video.originalName}</p> : null}
        <p className="text-xs text-slate-500 mt-0.5">{new Date(video.uploadedAt).toLocaleString()}</p>
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          <button
            type="button"
            onClick={handleOpen}
            className="flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 bg-primary-50 px-2 py-1 rounded"
          >
            <ExternalLink className="w-3 h-3" /> Open
          </button>
          <button
            type="button"
            onClick={handleShare}
            className="flex items-center gap-1 text-xs text-slate-600 hover:text-slate-800 bg-slate-100 px-2 py-1 rounded transition-colors"
          >
            <Copy className="w-3 h-3" /> Copy Share Link
          </button>
          {src && (
            <button
              type="button"
              onClick={handleDownload}
              className="flex items-center gap-1 text-xs text-emerald-600 hover:text-emerald-700 bg-emerald-50 px-2 py-1 rounded transition-colors"
            >
              <Download className="w-3 h-3" /> Download
            </button>
          )}
          {canDelete && (
            <button type="button" onClick={onDelete} className="flex items-center gap-1 text-xs text-red-600 hover:text-red-700 ml-auto bg-red-50 px-2 py-1 rounded transition-colors">
              <Trash2 className="w-3 h-3" /> Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}


const ConsignmentDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { addToast } = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const canDeleteVideos = user?.role === 'admin' || user?.permissions?.deleteVideos === true;
  const canEditBoxQuantities = user?.role === 'admin' || user?.permissions?.editBoxQuantities === true;
  const { pendingChanges } = useConsignmentSync();
  const [searchParams, setSearchParams] = useSearchParams();
  const [uploading, setUploading] = useState(false);
  const [videoUploadBoxNo, setVideoUploadBoxNo] = useState('');
  const [selectedVideoBox, setSelectedVideoBox] = useState('all');
  const [consignment, setConsignment] = useState(null);
  const [loading, setLoading] = useState(true);
  const [packingReport, setPackingReport] = useState(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [previewWeightImgUrl, setPreviewWeightImgUrl] = useState(null);
  const [previewWeightBoxNo, setPreviewWeightBoxNo] = useState(null);
  const [fetchingWeightImg, setFetchingWeightImg] = useState(false);
  // Tab is synced to the URL (?tab=) so it's deep-linkable, shareable & survives refresh
  const activeTab = searchParams.get('tab') || 'skus';
  const setActiveTab = (tab) => setSearchParams(prev => { const p = new URLSearchParams(prev); p.set('tab', tab); return p; }, { replace: true });
  const [trackingOpen,  setTrackingOpen]  = useState(true);
  const [editingTracking, setEditingTracking] = useState(false);
  const [deleteFile, setDeleteFile] = useState(null); // { id, type, name }
  const [savingTracking, setSavingTracking] = useState(false);
  const [trackingForm, setTrackingForm] = useState({});
  const [showReassignId, setShowReassignId] = useState(false);
  const [newConsignmentId, setNewConsignmentId] = useState('');
  const [reassigningId, setReassigningId] = useState(false);
  const [omsGuruUploading, setOmsGuruUploading] = useState(false);
  const [omsGuruUploads, setOmsGuruUploads] = useState([]);
  const [omsGuruUploadsLoading, setOmsGuruUploadsLoading] = useState(false);
  const omsGuruFileRef = useRef(null);
  const [inwardUploading, setInwardUploading] = useState(false);
  const [inwardUploads, setInwardUploads] = useState([]);
  const inwardFileRef = useRef(null);
  const [boxEdit, setBoxEdit] = useState(null); // { boxNo, skuId, qty, reason, remarks }
  const [boxEditSaving, setBoxEditSaving] = useState(false);
  const liveRefreshRef = useRef(null);

  const openTrackingEdit = () => {
    setTrackingForm({
      appointmentDate: consignment.appointmentDate || '',
      scheduledDispatchDate: consignment.scheduledDispatchDate || '',
      actualDispatchDate: consignment.actualDispatchDate || '',
      dateOfInward: consignment.dateOfInward || '',
      poExpiryDate: consignment.poExpiryDate || '',
      forwardInvoiceNo: consignment.forwardInvoiceNo || '',
      docketCompany: consignment.docketCompany || '',
      docketNo: consignment.docketNo || '',
      marketplaceTicketId: consignment.marketplaceTicketId || '',
      shipmentStatus: consignment.shipmentStatus || 'Planned',
      unitsShipped: consignment.unitsShipped || 0,
      unitsReceived: consignment.unitsReceived || 0,
      unitsInwarded: consignment.unitsInwarded || 0,
      qaFailExcessQty: consignment.qaFailExcessQty || 0,
    });
    setEditingTracking(true);
  };

  const saveTracking = async () => {
    setSavingTracking(true);
    try {
      const payload = {
        ...trackingForm,
        unitsShipped: Number(trackingForm.unitsShipped) || 0,
        unitsReceived: Number(trackingForm.unitsReceived) || 0,
        unitsInwarded: Number(trackingForm.unitsInwarded) || 0,
        qaFailExcessQty: Number(trackingForm.qaFailExcessQty) || 0,
      };
      await consignmentsAPI.update(id, payload);
      addToast('Tracking details updated', 'success');
      setEditingTracking(false);
      fetchConsignment();
    } catch (error) {
      addToast('Update failed', 'error');
    }
    setSavingTracking(false);
  };

  const pivotData = React.useMemo(() => {
    if (!packingReport) return null;
    return {
      ...packingReport,
      rows: packingReport.rows || [],
      boxes: packingReport.boxes || [],
      summary: packingReport.summary || {},
      integrityIssues: packingReport.integrityIssues || []
    };
  }, [packingReport]);

  useEffect(() => {
    fetchConsignment();
  }, [id]);

  // Keep SKU tab aligned with active packing session while consignment is in progress
  useEffect(() => {
    if (!id || !consignment) return undefined;
    const inProgress = ['in_progress', 'pending'].includes(consignment.status);
    if (!inProgress && !consignment.liveSessionActive) return undefined;
    const timer = setInterval(() => {
      loadConsignmentWithLiveSession(id)
        .then((merged) => setConsignment(merged))
        .catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [id, consignment?.status, consignment?.liveSessionActive]);

  useEffect(() => {
    if (activeTab === 'report') fetchPackingReport();
  }, [activeTab, id]);

  useEffect(() => {
    if (activeTab === 'skus' && isAdmin && consignment?.id) {
      fetchOmsGuruUploads();
      consignmentsAPI.getInwardUploads(id)
        .then((r) => setInwardUploads(r.data.uploads || []))
        .catch(() => {});
    }
  }, [activeTab, id, isAdmin, consignment?.id]);

  const fetchOmsGuruUploads = async () => {
    if (!isAdmin) return;
    try {
      setOmsGuruUploadsLoading(true);
      const { data } = await consignmentsAPI.getOmsGuruUploads(id);
      setOmsGuruUploads(data.uploads || []);
    } catch {
      setOmsGuruUploads([]);
    } finally {
      setOmsGuruUploadsLoading(false);
    }
  };

  const downloadOmsGuruTemplate = async () => {
    try {
      const response = await consignmentsAPI.downloadOmsGuruTemplate(id);
      const safeName = String(id).replace(/[^a-zA-Z0-9_-]+/g, '_');
      const url = URL.createObjectURL(new Blob([response.data], { type: 'text/csv' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `oms_guru_removed_${safeName}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
      addToast('OMSGuru template downloaded', 'success');
    } catch (error) {
      addToast(error.response?.data?.error || 'Template download failed', 'error');
    }
  };

  const handleOmsGuruImport = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setOmsGuruUploading(true);
    try {
      const { data } = await consignmentsAPI.importOmsGuruTemplate(id, file);
      setConsignment((prev) => (prev ? {
        ...prev,
        skus: data.skus || prev.skus,
        omsGuruSummary: data.omsGuruSummary || prev.omsGuruSummary,
      } : prev));
      addToast(`Updated OMSGuru quantities for ${data.updatedSkuCount} SKU(s)`, 'success');
      fetchOmsGuruUploads();
    } catch (error) {
      const errors = error.response?.data?.errors;
      if (Array.isArray(errors) && errors.length) {
        addToast(errors.slice(0, 3).join(' · '), 'error');
      } else {
        addToast(error.response?.data?.error || 'OMSGuru import failed', 'error');
      }
    } finally {
      setOmsGuruUploading(false);
    }
  };

  const downloadInwardTemplate = async () => {
    try {
      const response = await consignmentsAPI.downloadInwardTemplate(id);
      const safeName = String(id).replace(/[^a-zA-Z0-9_-]+/g, '_');
      const url = URL.createObjectURL(new Blob([response.data], { type: 'text/csv' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `inward_${safeName}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
      addToast('Inward template downloaded', 'success');
    } catch (error) {
      addToast(error.response?.data?.error || 'Inward template download failed', 'error');
    }
  };

  const handleInwardImport = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setInwardUploading(true);
    try {
      const { data } = await consignmentsAPI.importInwardCsv(id, file);
      setConsignment((prev) => (prev ? {
        ...prev,
        skus: data.skus || prev.skus,
        inwardSummary: data.inwardSummary || prev.inwardSummary,
        inwardMismatch: data.inwardSummary?.hasMismatch,
      } : prev));
      addToast(`Inward data updated for ${data.updatedSkuCount} SKU(s)`, 'success');
      if (isAdmin) {
        consignmentsAPI.getInwardUploads(id).then((r) => setInwardUploads(r.data.uploads || [])).catch(() => {});
      }
    } catch (error) {
      const errors = error.response?.data?.errors;
      if (Array.isArray(errors) && errors.length) {
        addToast(errors.slice(0, 3).map((e) => e.error || e).join(' · '), 'error');
      } else {
        addToast(error.response?.data?.error || 'Inward import failed', 'error');
      }
    } finally {
      setInwardUploading(false);
    }
  };

  const saveBoxQuantityEdit = async () => {
    if (!boxEdit?.boxNo || !boxEdit?.skuId) return;
    setBoxEditSaving(true);
    try {
      const { data } = await consignmentsAPI.editBoxQuantity(id, boxEdit.boxNo, {
        sku_id: boxEdit.skuId,
        quantity: Number(boxEdit.qty),
        reason: boxEdit.reason,
        remarks: boxEdit.remarks || '',
      });
      if (data.invoice_warning || data.invoiceWarning) {
        addToast(data.invoice_warning || data.invoiceWarning, 'warning', 7000);
      }
      addToast('Box quantity updated', 'success');
      setBoxEdit(null);
      await fetchConsignment({ silent: true });
    } catch (error) {
      addToast(error.response?.data?.error || 'Quantity edit failed', 'error');
    } finally {
      setBoxEditSaving(false);
    }
  };

  // Live status sync from packing station (debounced to avoid UI freezes during scan bursts)
  useEffect(() => {
    const patch = pendingChanges.find((c) => c.id === id);
    if (!patch) return undefined;

    setConsignment((prev) => (prev ? { ...prev, ...patch } : prev));

    const shouldRefresh = patch.totalPackedQty != null
      || PACKING_LIVE_TYPES.has(patch.realtimeType)
      || String(patch.realtimeSource || '').includes('scan')
      || String(patch.realtimeSource || '').includes('skus')
      || String(patch.realtimeSource || '').includes('boxes')
      || String(patch.realtimeSource || '').includes('packing_drafts')
      || String(patch.realtimeSource || '').includes('draft');

    if (!shouldRefresh) return undefined;

    if (liveRefreshRef.current) clearTimeout(liveRefreshRef.current);
    liveRefreshRef.current = setTimeout(() => {
      loadConsignmentWithLiveSession(id)
        .then((merged) => setConsignment(merged))
        .catch(() => {});
      if (activeTab === 'report') fetchPackingReport();
    }, 450);

    return () => {
      if (liveRefreshRef.current) clearTimeout(liveRefreshRef.current);
    };
  }, [pendingChanges, id, activeTab]);

  const fetchConsignment = async ({ silent = false } = {}) => {
    try {
      if (!silent) setLoading(true);
      const merged = await loadConsignmentWithLiveSession(id);
      setConsignment(merged);
      if (activeTab === 'report') fetchPackingReport();
    } catch (error) {
      if (!silent) addToast('Failed to load consignment', 'error');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  const fetchPackingReport = async () => {
    try {
      setReportLoading(true);
      const response = await consignmentsAPI.getPackingReport(id);
      setPackingReport(response.data.report);
    } catch (error) {
      addToast(error.response?.data?.error || 'Failed to load packing report', 'error');
    } finally {
      setReportLoading(false);
    }
  };

  const resolveDocumentStreamUrl = (fileId) => buildUploadStreamUrl(fileId, 'document');

  const openDocument = (doc) => {
    const streamSrc = resolveDocumentStreamUrl(doc?.id);
    if (!streamSrc) {
      addToast('Could not open document — please sign in again', 'error');
      return;
    }
    window.open(streamSrc, '_blank', 'noopener,noreferrer');
  };

  const downloadDocument = async (doc) => {
    try {
      const response = await fetchAuthenticatedStream(doc.id, 'document');
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = doc.originalName || 'document';
      a.click();
      URL.revokeObjectURL(objectUrl);
    } catch {
      addToast('Could not download document', 'error');
    }
  };

  const openWeightImagePreview = async (fileId, boxNo) => {
    if (!fileId) return;
    setFetchingWeightImg(true);
    setPreviewWeightBoxNo(boxNo);
    try {
      const streamSrc = resolveDocumentStreamUrl(fileId);
      if (streamSrc) {
        setPreviewWeightImgUrl(streamSrc);
        return;
      }
      addToast('Could not load weight verification image — please sign in again', 'error');
    } catch (err) {
      addToast('Could not load weight verification image', 'error');
    } finally {
      setFetchingWeightImg(false);
    }
  };

  const printWeightSummary = async () => {
    const boxes = consignment.boxes || [];
    if (boxes.length === 0) {
      addToast('No boxes found to print weight summary', 'warning');
      return;
    }

    const sortedBoxes = [...boxes].sort((a, b) => String(a.boxNo).localeCompare(String(b.boxNo), undefined, { numeric: true }));
    const boxCount = sortedBoxes.length;
    const totalQty = sortedBoxes.reduce((sum, b) => sum + (Number(b.totalQty) || (b.items || []).reduce((s, i) => s + (Number(i.qty) || 0), 0)), 0);
    const totalWeightVal = consignment.totalWeight || boxes.reduce((sum, b) => sum + (Number(b.weight) || 0), 0) || 0;
    const weightUnit = consignment.weightUnit || boxes[0]?.weightUnit || 'KG';

    const w = window.open('', '_blank', 'width=800,height=1000');
    if (!w) {
      addToast('Could not open print window — allow pop-ups and try again', 'warning');
      return;
    }

    const rowsHtml = sortedBoxes.map((box) => {
      const qty = Number(box.totalQty) || (box.items || []).reduce((s, i) => s + (Number(i.qty) || 0), 0);
      const weightText = box.weight != null ? `${Number(box.weight).toFixed(2)} ${box.weightUnit || weightUnit}` : '—';
      return `<tr>
        <td>${box.boxNo}</td>
        <td class="num">${qty}</td>
        <td class="num">${weightText}</td>
      </tr>`;
    }).join('');

    w.document.write(`<!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Weight Summary - ${consignment.internalShipmentNo || consignment.id}</title>
          <style>
            @page { size: A4; margin: 12mm; }
            * { box-sizing: border-box; }
            body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #0f172a; font-size: 10pt; }
            h1 { font-size: 14pt; margin: 0 0 2px; }
            .sub { color: #64748b; font-size: 8.5pt; margin-bottom: 10px; }
            .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 16px; margin-bottom: 12px; font-size: 9pt; }
            .meta strong { display: inline-block; min-width: 110px; color: #64748b; font-weight: 600; }
            .totals { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 12px; }
            .tot { border: 1px solid #e2e8f0; border-radius: 6px; padding: 8px; text-align: center; }
            .tot span { display: block; font-size: 7.5pt; text-transform: uppercase; color: #64748b; }
            .tot b { font-size: 12pt; }
            table { width: 100%; border-collapse: collapse; }
            th, td { border: 1px solid #cbd5e1; padding: 5px 8px; font-size: 9pt; }
            th { background: #0f172a; color: #fff; text-align: left; font-size: 8pt; text-transform: uppercase; }
            td.num, th.num { text-align: right; }
            .no-print { margin-bottom: 12px; }
            @media print { .no-print { display: none !important; } }
          </style>
        </head>
        <body>
          <div class="no-print"><button onclick="window.print()">Print Weight Summary</button></div>
          <h1>Weight Summary</h1>
          <div class="sub">VB Exports · Packing Station · ${new Date().toLocaleString()}</div>
          <div class="meta">
            <div><strong>Consignment ID</strong> ${consignment.id}</div>
            <div><strong>Shipment No</strong> ${consignment.shipmentNo || '—'}</div>
            <div><strong>Internal Shipment</strong> ${consignment.internalShipmentNo || '—'}</div>
            <div><strong>Marketplace</strong> ${consignment.marketplace?.name || '—'}</div>
          </div>
          <div class="totals">
            <div class="tot"><span>Total boxes</span><b>${boxCount}</b></div>
            <div class="tot"><span>Total quantity</span><b>${totalQty}</b></div>
            <div class="tot"><span>Total weight</span><b>${Number(totalWeightVal).toFixed(2)} ${weightUnit}</b></div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Box number</th>
                <th class="num">Box quantity</th>
                <th class="num">Box weight</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </body>
      </html>`);
    w.document.close();
  };

  const downloadWeightReport = async () => {
    const boxes = consignment.boxes || [];
    if (boxes.length === 0) {
      addToast('No boxes found to download weight report', 'warning');
      return;
    }
    
    addToast('Generating weight report with proof links...', 'info');
    
    const sortedBoxes = [...boxes].sort((a, b) => String(a.boxNo).localeCompare(String(b.boxNo), undefined, { numeric: true }));
    const imageMap = {};
    try {
      const fetchPromises = sortedBoxes.map(async (box) => {
        if (!box.weightImageId) return;
        const streamSrc = resolveDocumentStreamUrl(box.weightImageId);
        if (streamSrc) {
          imageMap[box.boxNo] = streamSrc;
        }
      });
      await Promise.all(fetchPromises);
    } catch (err) {
      console.error('Error fetching weight image links', err);
    }

    const csvValue = (value) => {
      if (value === null || value === undefined) return '';
      const text = String(value);
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    const csvRows = [];
    csvRows.push(['Box Number', 'Weight', 'Unit', 'Items Summary', 'Captured By', 'Captured At', 'Proof Image Link'].map(csvValue).join(','));

    sortedBoxes.forEach(box => {
      const itemsText = box.items?.map(i => `${i.internalSku || i.name} (x${i.qty})`).join(', ') || '';
      const weightVal = box.weight ? box.weight.toFixed(2) : '';
      const weightUnit = box.weightUnit || '';
      const userText = box.weightCapturedByName || '';
      const dateText = box.weightCapturedAt ? new Date(box.weightCapturedAt).toISOString() : '';
      const imgUrl = imageMap[box.boxNo] || '';
      
      csvRows.push([
        `Box #${box.boxNo}`,
        weightVal,
        weightUnit,
        itemsText,
        userText,
        dateText,
        imgUrl
      ].map(csvValue).join(','));
    });

    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${consignment.internalShipmentNo || consignment.id}_weight_proof_report.csv`;
    a.click();
    URL.revokeObjectURL(url);
    addToast('Weight report downloaded successfully', 'success');
  };

  const exportCsv = (type) => {
    if (!pivotData) return;
    const rows = type === 'packed'
      ? pivotData.rows.filter(r => (r.packedFromBoxes || 0) > 0)
      : pivotData.rows.filter(r => (r.required || 0) - (r.packedFromBoxes || 0) > 0);
    if (rows.length === 0) { addToast(`No ${type} SKUs to export`, 'warning'); return; }

    const csvValue = (value) => {
      if (value === null || value === undefined) return '';
      const text = String(value);
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const pushCsvRow = (values) => csvRows.push(values.map(csvValue).join(','));

    // Pending report focuses on what's LEFT (no packed column).
    // Packed report shows the completed items with how they were boxed.
    const headers = type === 'pending'
      ? ['#', 'Marketplace SKU', 'Internal SKU', 'Required', 'Pending (to pack)']
      : ['#', 'Marketplace SKU', 'Internal SKU', 'Required', 'Packed', 'Box wise Qty', 'Box number'];

    const csvRows = [];
    pushCsvRow(headers);
    let totRequired = 0, totPacked = 0, totPending = 0;

    rows.forEach((r, i) => {
      const packedFromBoxes = r.packedFromBoxes || 0;
      const pendingFromBoxes = Math.max(0, (r.required || 0) - packedFromBoxes);
      totRequired += r.required; totPacked += packedFromBoxes; totPending += pendingFromBoxes;
      if (type === 'pending') {
        pushCsvRow([i + 1, r.marketplaceSku, r.internalSku, r.required, pendingFromBoxes]);
      } else {
        const boxEntries = [], boxNumbers = [];
        pivotData.boxes.forEach(b => {
          const qty = r.boxQtys[b.boxNo] || 0;
          if (qty > 0) { boxEntries.push(qty); boxNumbers.push(b.boxNo); }
        });
        pushCsvRow([
          i + 1, r.marketplaceSku, r.internalSku,
          r.required, packedFromBoxes, boxEntries.join(','), boxNumbers.join(',')
        ]);
      }
    });

    // Totals row
    if (type === 'pending') {
      pushCsvRow(['', '', 'TOTAL', totRequired, totPending]);
    } else {
      pushCsvRow(['', '', 'TOTAL', totRequired, totPacked, '', '']);
    }

    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${consignment.internalShipmentNo || consignment.id}_${type}_report.csv`;
    a.click();
    URL.revokeObjectURL(url);
    addToast(`${rows.length} ${type} SKU(s) exported`, 'success');
  };

  const handleFileUpload = async (e, type) => {
    const file = e.target.files[0];
    if (!file) return;

    if (type === 'video' && !videoUploadBoxNo) {
      addToast('Select a box number before uploading a video', 'error');
      e.target.value = '';
      return;
    }

    try {
      setUploading(true);
      await uploadFileToStorage(
        file,
        id,
        type,
        type === 'video' ? videoUploadBoxNo : ''
      );
      addToast('File uploaded successfully', 'success');
      fetchConsignment({ silent: true });
    } catch (error) {
      addToast('Upload failed: ' + (error.response?.data?.error || error.message || 'Unknown error'), 'error');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const handleDeleteFile = async () => {
    if (!deleteFile) return;
    if (deleteFile.type === 'video' && !canDeleteVideos) {
      addToast('You do not have permission to delete videos', 'error');
      setDeleteFile(null);
      return;
    }
    try {
      await uploadsAPI.delete(deleteFile.id, deleteFile.type);
      addToast('File deleted', 'success');
      setDeleteFile(null);
      fetchConsignment({ silent: true });
    } catch (error) {
      addToast(error.response?.data?.error || 'Delete failed', 'error');
      setDeleteFile(null);
    }
  };

  const printBoxLabel = (box) => {
    if (!printShipmentBoxLabel(consignment, box)) {
      addToast('Could not open print window — allow pop-ups and try again', 'warning');
    }
  };

  const printAllLabels = () => {
    const boxes = consignment.boxes || [];
    if (boxes.length === 0) { addToast('No boxes to print', 'warning'); return; }
    if (!printAllShipmentBoxLabels(consignment)) {
      addToast('Could not open print window — allow pop-ups and try again', 'warning');
      return;
    }
    addToast(`Printing ${boxes.length} box label(s)`, 'success');
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'completed': return 'bg-emerald-100 text-emerald-800';
      case 'in_progress': return 'bg-blue-100 text-blue-800';
      default: return 'bg-amber-100 text-amber-800';
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-12 h-12 animate-spin text-primary-600" />
      </div>
    );
  }

  if (!consignment) {
    return (
      <div className="text-center py-12">
        <AlertCircle className="w-12 h-12 mx-auto text-red-400 mb-3" />
        <h2 className="text-xl font-bold text-slate-900">Consignment Not Found</h2>
        <button
          onClick={() => navigate('/consignments')}
          className="mt-4 text-primary-600 hover:text-primary-700 font-medium"
        >
          Back to Consignments
        </button>
      </div>
    );
  }

  const progressPct = consignment.totalRequiredQty > 0 
    ? Math.round((consignment.totalPackedQty / consignment.totalRequiredQty) * 100) 
    : 0;
  const shipmentPriority = getShipmentPriority(consignment);
  const progressBarColor = getProgressBarColor(shipmentPriority);

  const boxCount = consignment.boxes?.length || 0;
  const totalWeightVal = consignment.totalWeight || consignment.boxes?.reduce((sum, b) => sum + (Number(b.weight) || 0), 0) || 0;
  const avgBoxWeight = boxCount > 0 ? (totalWeightVal / boxCount).toFixed(2) : '0.00';
  const weightUnit = consignment.weightUnit || consignment.boxes?.[0]?.weightUnit || 'KG';
  const omsGuruSummary = consignment.omsGuruSummary || summarizeOmsGuruSkus(consignment.skus || []);
  const inwardSummary = consignment.inwardSummary || {
    totalPackedQty: omsGuruSummary.totalPackedQty,
    totalInwardQty: (consignment.skus || []).reduce((s, sku) => s + (Number(sku.inwardQty) || 0), 0),
    mismatchCount: (consignment.skus || []).filter((s) => s.inwardMismatch).length,
    hasMismatch: (consignment.skus || []).some((s) => s.inwardMismatch),
    notInwardedCount: (consignment.skus || []).filter((s) => !s.inwardQty).length,
    fullyInwardedCount: (consignment.skus || []).filter((s) => s.inwardStatus === 'fully_inwarded').length,
    shortCount: (consignment.skus || []).filter((s) => s.inwardStatus === 'short_received' || s.inwardStatus === 'partially_inwarded').length,
    excessCount: (consignment.skus || []).filter((s) => s.inwardStatus === 'excess_received').length,
    totalDifference: 0,
  };
  const packingAdjustments = consignment.packingAdjustments || [];
  // OMSGuru checklist fields remain available on the workflow panel; SKU tab focuses on inward + removals.

  const videoByBox = (() => {
    const grouped = {};
    (consignment.videos || []).forEach((video) => {
      const box = String(video.boxNo || 'Unassigned');
      if (!grouped[box]) grouped[box] = video;
      else if (new Date(video.uploadedAt) > new Date(grouped[box].uploadedAt)) grouped[box] = video;
    });
    return grouped;
  })();

  const videoBoxNumbers = [...new Set([
    ...(consignment.boxes || []).map((b) => String(b.boxNo)),
    ...Object.keys(videoByBox),
  ])].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));

  const visibleVideoBoxes = selectedVideoBox === 'all'
    ? videoBoxNumbers
    : videoBoxNumbers.filter((boxNo) => boxNo === selectedVideoBox);

  const handleReassignId = async (e) => {
    e?.preventDefault?.();
    const trimmed = newConsignmentId.trim();
    if (!trimmed) {
      addToast('Enter the official consignment ID', 'error');
      return;
    }
    if (trimmed === consignment.id) {
      addToast('New ID must differ from the current ID', 'error');
      return;
    }
    setReassigningId(true);
    try {
      const { data } = await consignmentsAPI.reassignId(consignment.id, trimmed);
      addToast(`Consignment ID updated to ${data.newId}`, 'success');
      setShowReassignId(false);
      setNewConsignmentId('');
      navigate(`/consignments/${data.newId}`, { replace: true });
    } catch (error) {
      addToast(error.response?.data?.error || 'Could not update consignment ID', 'error');
    } finally {
      setReassigningId(false);
    }
  };

  const toggleOmsGuru = async (checked) => {
    try {
      await consignmentsAPI.update(id, {
        omsGuruQtyRemoved: checked,
        omsGuruQtyRemovedAt: checked ? new Date().toISOString() : null,
        omsGuruQtyRemovedBy: checked ? (user?.name || user?.email || 'Unknown') : null,
      });
      setConsignment((prev) => ({
        ...prev,
        omsGuruQtyRemoved: checked,
        omsGuruQtyRemovedAt: checked ? new Date().toISOString() : null,
        omsGuruQtyRemovedBy: checked ? (user?.name || user?.email) : null,
      }));
      addToast(checked ? 'OMSGuru removal confirmed' : 'OMSGuru checklist reset', 'success');
    } catch {
      addToast('Could not update OMSGuru checklist', 'error');
    }
  };

  return (
    <div className="animate-fade-in">
      <div className="mb-8">
        <button
          onClick={() => navigate('/consignments')}
          className="flex items-center gap-2 text-slate-500 hover:text-slate-700 mb-4"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Consignments
        </button>
        
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <h1 className="text-3xl font-bold text-slate-900">{consignment.internalShipmentNo || consignment.id}</h1>
              <span className={`px-3 py-1 rounded-full text-xs font-medium ${getStatusColor(consignment.status)}`}>
                {consignment.status?.replace('_', ' ')}
              </span>
              <span className={`px-3 py-1 rounded-full text-xs font-medium ${consignment.shipmentStatus==='Planned'?'bg-slate-100 text-slate-700':consignment.shipmentStatus==='Under Packing'?'bg-orange-100 text-orange-800':consignment.shipmentStatus==='Ready'?'bg-emerald-100 text-emerald-800':consignment.shipmentStatus==='In Transit'||consignment.shipmentStatus==='Forwarded'?'bg-blue-100 text-blue-800':consignment.shipmentStatus==='Missed'?'bg-red-100 text-red-800':'bg-slate-100 text-slate-700'}`}>
                {consignment.shipmentStatus || 'Planned'}
              </span>
              <CriticalityBadge priority={shipmentPriority} size="lg" />
            </div>
            <div className="flex items-center gap-4 text-sm flex-wrap">
              <p className="text-slate-500 font-mono">{consignment.id}</p>
              {consignment.pendingExternalId && (
                <span className="text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded text-xs font-semibold">
                  Pending official consignment ID
                </span>
              )}
              {(consignment.pendingExternalId || user?.role === 'admin') && (
                <button
                  type="button"
                  onClick={() => { setShowReassignId(true); setNewConsignmentId(''); }}
                  className="text-xs font-semibold text-primary-600 hover:text-primary-700 underline"
                >
                  Assign official ID
                </button>
              )}
              {consignment.shipmentNo && (
                <p className="text-slate-700 bg-slate-100 px-2 py-0.5 rounded text-xs font-semibold">
                  Shipment: {consignment.shipmentNo}
                </p>
              )}
            </div>
          </div>
          <div className="text-left sm:text-right flex flex-col items-start sm:items-end gap-2">
            <div>
              {consignment.marketplace?.name && <p className="text-xs text-primary-600 font-semibold">{consignment.marketplace.name}</p>}
              {consignment.warehouse && <p className="text-xs text-slate-500 mt-0.5">WH: {consignment.warehouse}</p>}
            </div>
            {consignment.pgEnabled ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                <Database className="w-3.5 h-3.5" /> Stored in primary live store
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <ConsignmentWorkflowPanel
        consignment={consignment}
        onUpdated={(next) => setConsignment((prev) => ({ ...prev, ...next }))}
      />

      {/* Progress & Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 lg:gap-6 mb-8">
        <div className={`bg-white rounded-xl p-4 lg:p-6 shadow-sm border ${shipmentPriority.level === 'critical' ? 'border-red-200 bg-red-50/30' : shipmentPriority.level === 'high' ? 'border-orange-200' : shipmentPriority.level === 'medium' ? 'border-amber-200' : 'border-slate-100'}`}>
          <p className="text-sm text-slate-500 mb-1">Units Progress</p>
          <div className="flex items-center gap-3">
            <div className="flex-1 bg-slate-200 rounded-full h-3">
              <div 
                className={`${progressBarColor} h-3 rounded-full transition-all`}
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <span className={`text-lg font-bold tabular-nums ${shipmentPriority.level === 'critical' ? 'text-red-700' : 'text-slate-900'}`}>{progressPct}%</span>
          </div>
          <p className="text-xs text-slate-400 mt-1">{consignment.totalPackedQty || 0} of {consignment.totalRequiredQty || 0} units packed</p>
        </div>
        <div className="bg-white rounded-xl p-4 lg:p-6 shadow-sm border border-slate-100">
          <p className="text-sm text-slate-500 mb-1">Total Items</p>
          <p className="text-2xl font-bold text-slate-900">{consignment.totalRequiredQty || 0}</p>
          <p className="text-xs text-slate-400">{consignment.totalPackedQty || 0} packed</p>
        </div>
        <div className="bg-white rounded-xl p-4 lg:p-6 shadow-sm border border-slate-100">
          <p className="text-sm text-slate-500 mb-1">Boxes</p>
          <p className="text-2xl font-bold text-slate-900">{consignment.boxes?.length || 0}</p>
        </div>
        <div className="bg-white rounded-xl p-4 lg:p-6 shadow-sm border border-slate-100">
          <p className="text-sm text-slate-500 mb-1">Expected Date</p>
          <p className="text-lg font-bold text-slate-900">{consignment.expectedDate || 'N/A'}</p>
        </div>
        <div className="bg-white rounded-xl p-4 lg:p-6 shadow-sm border border-slate-100 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-1">
              <p className="text-sm text-slate-500">Weight Summary</p>
              <Scale className="w-4 h-4 text-primary-500" />
            </div>
            <p className="text-2xl font-bold text-slate-900">
              {totalWeightVal > 0 ? `${totalWeightVal.toFixed(2)} ${weightUnit}` : 'N/A'}
            </p>
          </div>
          <div className="mt-2 pt-2 border-t border-slate-50 flex items-center justify-between text-xs text-slate-400">
            <span>Avg: {avgBoxWeight} {weightUnit}</span>
            <span>Boxes: {boxCount}</span>
          </div>
        </div>
      </div>

      <div className="mb-6">
        <OmsGuruChecklist consignment={consignment} onToggle={toggleOmsGuru} />
      </div>

      {/* Shipment Tracking Details - Collapsible */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-100 mb-8 overflow-hidden">
        {/* Section header - click to collapse/expand */}
        <div
          className="flex items-center justify-between px-5 py-3.5 cursor-pointer select-none hover:bg-slate-50 transition-colors"
          onClick={() => { if (!editingTracking) setTrackingOpen(o => !o); }}
        >
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wide">Shipment Tracking Details</h3>
            {!trackingOpen && (
              <span className="text-[10px] bg-primary-100 text-primary-700 px-2 py-0.5 rounded-full font-medium">Collapsed</span>
            )}
          </div>
          <div className="flex items-center gap-3" onClick={e => e.stopPropagation()}>
            {!editingTracking ? (
              <button onClick={openTrackingEdit} className="text-xs text-primary-600 hover:text-primary-700 font-medium px-2 py-1 hover:bg-primary-50 rounded-lg transition-colors">Edit</button>
            ) : (
              <div className="flex items-center gap-2">
                <button onClick={() => setEditingTracking(false)} className="text-xs text-slate-500 hover:text-slate-700 font-medium">Cancel</button>
                <button onClick={saveTracking} disabled={savingTracking} className="text-xs text-white bg-primary-600 hover:bg-primary-700 font-medium px-3 py-1 rounded-lg transition-colors">{savingTracking ? 'Saving...' : 'Save Changes'}</button>
              </div>
            )}
            <button onClick={() => setTrackingOpen(o => !o)} className="p-1 text-slate-400 hover:text-slate-600 transition-colors">
              {trackingOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          </div>
        </div>
        {/* Collapsible body */}
        <div className={`collapsible-content ${trackingOpen ? 'open' : 'closed'}`}>
        <div className="px-5 pb-5">
        {editingTracking ? (
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {[
              { label: 'Appointment Date', field: 'appointmentDate', type: 'date' },
              { label: 'Scheduled Dispatch', field: 'scheduledDispatchDate', type: 'date' },
              { label: 'Actual Dispatch', field: 'actualDispatchDate', type: 'date' },
              { label: 'Date of Inward', field: 'dateOfInward', type: 'date' },
              { label: 'PO Expiry Date', field: 'poExpiryDate', type: 'date' },
              { label: 'Forward Invoice', field: 'forwardInvoiceNo', type: 'text' },
              { label: 'Docket Company', field: 'docketCompany', type: 'text' },
              { label: 'Docket No', field: 'docketNo', type: 'text' },
              { label: 'Ticket ID', field: 'marketplaceTicketId', type: 'text' },
              { label: 'Shipment Status', field: 'shipmentStatus', type: 'select' },
              { label: 'Units Shipped', field: 'unitsShipped', type: 'number' },
              { label: 'Units Received', field: 'unitsReceived', type: 'number' },
              { label: 'Units Inwarded', field: 'unitsInwarded', type: 'number' },
              { label: 'QA Fail/Excess', field: 'qaFailExcessQty', type: 'number' },
            ].map((item) => (
              <div key={item.field}>
                <label className="text-[10px] uppercase tracking-wider text-slate-500 block mb-1">{item.label}</label>
                {item.type === 'select' ? (
                  <select value={trackingForm[item.field] || ''} onChange={e => setTrackingForm({...trackingForm, [item.field]: e.target.value})} className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm focus:ring-2 focus:ring-primary-500 outline-none">
                    <option value="Planned">Planned</option>
                    <option value="Scheduled">Scheduled</option>
                    <option value="Under Packing">Under Packing</option>
                    <option value="Ready">Ready</option>
                    <option value="In Transit">In Transit</option>
                    <option value="Forwarded">Forwarded</option>
                    <option value="Missed">Missed</option>
                  </select>
                ) : (
                  <input type={item.type} value={trackingForm[item.field] || ''} onChange={e => setTrackingForm({...trackingForm, [item.field]: e.target.value})} className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm focus:ring-2 focus:ring-primary-500 outline-none" />
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {[
              { label: 'Appointment Date', value: consignment.appointmentDate },
              { label: 'Scheduled Dispatch', value: consignment.scheduledDispatchDate },
              { label: 'Actual Dispatch', value: consignment.actualDispatchDate },
              { label: 'Date of Inward', value: consignment.dateOfInward },
              { label: 'PO Expiry Date', value: consignment.poExpiryDate },
              { label: 'Forward Invoice', value: consignment.forwardInvoiceNo },
              { label: 'Docket Company', value: consignment.docketCompany },
              { label: 'Docket No', value: consignment.docketNo },
              { label: 'Ticket ID', value: consignment.marketplaceTicketId },
              { label: 'Shipment Status', value: consignment.shipmentStatus },
              { label: 'Planned Qty', value: consignment.totalRequiredQty },
              { label: 'Total Packed', value: consignment.totalPackedQty },
              { label: 'Units Shipped', value: consignment.unitsShipped },
              { label: 'Units Received', value: consignment.unitsReceived },
              { label: 'Units Inwarded', value: consignment.unitsInwarded },
              { label: 'Short Qty', value: (consignment.totalRequiredQty || 0) - (consignment.unitsInwarded || 0), color: ((consignment.totalRequiredQty || 0) - (consignment.unitsInwarded || 0)) > 0 ? 'text-red-600' : 'text-emerald-600' },
              { label: 'QA Fail/Excess', value: consignment.qaFailExcessQty },
              { label: 'No. of Boxes', value: (consignment.boxes?.length || consignment.boxIds?.length || 0) },
              { label: 'Total Consignment Weight', value: totalWeightVal > 0 ? `${totalWeightVal.toFixed(2)} ${weightUnit}` : '-' },
              { label: 'Total Shipment Weight', value: totalWeightVal > 0 ? `${totalWeightVal.toFixed(2)} ${weightUnit}` : '-' },
              { label: 'Average Box Weight', value: boxCount > 0 ? `${avgBoxWeight} ${weightUnit}` : '-' },
            ].map((item, i) => (
              <div key={i} className="bg-slate-50 rounded-lg p-3">
                <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">{item.label}</p>
                <p className={`text-sm font-semibold ${item.color || 'text-slate-900'}`}>{item.value !== undefined && item.value !== '' ? item.value : '-'}</p>
              </div>
            ))}
          </div>
        )}
        </div>{/* /px-5 pb-5 */}
        </div>{/* /collapsible-content */}
      </div>

      {/* Tabs */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-100">
        <div className="flex border-b border-slate-100 overflow-x-auto sticky top-[60px] bg-white z-20 rounded-t-xl">
          {[
            { id: 'skus', label: 'SKU Items', icon: Package },
            { id: 'boxes', label: 'Boxes', icon: Box },
            { id: 'report', label: 'Packing Report', icon: FileSpreadsheet },
            { id: 'videos', label: 'Videos', icon: Video },
            { id: 'documents', label: 'Documents', icon: FileText },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 lg:px-6 py-4 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === tab.id
                  ? 'border-primary-500 text-primary-600'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              <tab.icon className="w-4 h-4" />
              {tab.label}
              <span className="bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full text-xs">
                {tab.id === 'skus' ? (consignment.skus?.length || 0) :
                 tab.id === 'boxes' ? (consignment.boxes?.length || 0) :
                 tab.id === 'report' ? 'View' :
                 tab.id === 'videos' ? (consignment.videos?.length || 0) :
                 (consignment.documents?.length || 0)}
              </span>
            </button>
          ))}
        </div>

        <div className="p-4 lg:p-6">
          {activeTab === 'skus' && (
            <div className="space-y-5">
              <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                <p className="text-sm text-slate-700 leading-relaxed">
                  SKU packing totals, post-pack quantity removals, and warehouse inward quantities.
                  Inward data is stored separately and never overwrites packed quantities.
                </p>
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {[
                  { label: 'Total Required', value: omsGuruSummary.totalRequiredQty },
                  { label: 'Final Packed', value: omsGuruSummary.totalPackedQty },
                  { label: 'Total Inward', value: inwardSummary.totalInwardQty },
                  { label: 'Inward Mismatches', value: inwardSummary.mismatchCount },
                ].map((item) => (
                  <div key={item.label} className="bg-white rounded-lg p-3 border border-slate-100">
                    <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">{item.label}</p>
                    <p className="text-lg font-bold text-slate-900">{item.value}</p>
                  </div>
                ))}
              </div>

              {(inwardSummary.mismatchCount || 0) > 0 && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>
                    {inwardSummary.mismatchCount} SKU(s) have packed vs inward mismatches
                    ({inwardSummary.shortCount || 0} short/partial, {inwardSummary.excessCount || 0} excess).
                  </span>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={downloadInwardTemplate}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 transition-colors"
                >
                  <Download className="w-4 h-4" />
                  Download Inward Template
                </button>
                <button
                  type="button"
                  onClick={() => inwardFileRef.current?.click()}
                  disabled={inwardUploading}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 transition-colors disabled:opacity-60"
                >
                  {inwardUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                  {inwardUploading ? 'Uploading...' : 'Upload Inward Data'}
                </button>
                <input
                  ref={inwardFileRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={handleInwardImport}
                />
                <span className="text-xs text-slate-500">Fill Inward Qty (and optional Inward Date / Remarks).</span>
              </div>

              {packingAdjustments.filter((a) => a.status === 'completed').length > 0 && (
                <div className="rounded-xl border border-slate-200 p-4">
                  <h4 className="text-sm font-bold text-slate-800 uppercase tracking-wide mb-3 flex items-center gap-2">
                    <History className="w-4 h-4" /> Quantity removals / edits
                  </h4>
                  <div className="overflow-x-auto max-h-48 overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-slate-100 text-slate-500 uppercase">
                          <th className="py-1.5 text-left">Box</th>
                          <th className="py-1.5 text-left">SKU</th>
                          <th className="py-1.5 text-left">Action</th>
                          <th className="py-1.5 text-right">Qty</th>
                          <th className="py-1.5 text-left">Reason</th>
                          <th className="py-1.5 text-left">By / When</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {packingAdjustments.filter((a) => a.status === 'completed').map((a) => (
                          <tr key={a.id}>
                            <td className="py-1.5 font-semibold">#{a.boxNo}</td>
                            <td className="py-1.5">{a.internalSku || a.skuId}</td>
                            <td className="py-1.5 capitalize">{a.actionType}{a.editAction ? ` (${a.editAction})` : ''}</td>
                            <td className="py-1.5 text-right font-bold">
                              {a.actionType === 'edit'
                                ? `${a.previousQuantity} → ${a.updatedQuantity}`
                                : a.quantity}
                            </td>
                            <td className="py-1.5">{a.reasonLabel || a.reason || '—'}</td>
                            <td className="py-1.5 text-slate-500">
                              {a.removedByName || a.userName || '—'}
                              <br />
                              {a.completedAt ? new Date(a.completedAt).toLocaleString() : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-100">
                      <th className="text-left text-xs font-semibold text-slate-500 uppercase py-3">Barcode / Marketplace</th>
                      <th className="text-left text-xs font-semibold text-slate-500 uppercase py-3">Internal SKU</th>
                      <th className="text-right text-xs font-semibold text-slate-500 uppercase py-3">Required</th>
                      <th className="text-right text-xs font-semibold text-slate-500 uppercase py-3">Original Packed</th>
                      <th className="text-right text-xs font-semibold text-slate-500 uppercase py-3">Removed</th>
                      <th className="text-right text-xs font-semibold text-slate-500 uppercase py-3">Final Packed</th>
                      <th className="text-left text-xs font-semibold text-slate-500 uppercase py-3">Boxes</th>
                      <th className="text-right text-xs font-semibold text-slate-500 uppercase py-3">Inward Qty</th>
                      <th className="text-right text-xs font-semibold text-slate-500 uppercase py-3">Diff</th>
                      <th className="text-left text-xs font-semibold text-slate-500 uppercase py-3">Inward Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {consignment.skus?.length > 0 ? (
                      consignment.skus.map((sku) => {
                        const requiredQty = Number(sku.requiredQty) || 0
                        const packedQty = Number(sku.finalPackedQty ?? sku.packedQty) || 0
                        const removedQty = Number(sku.postPackRemovedQty) || 0
                        const originalPacked = Number(sku.originallyPackedQty) || (packedQty + removedQty)
                        const inwardQty = Number(sku.inwardQty) || 0
                        const diff = Number(sku.quantityDifference ?? (inwardQty - packedQty))
                        const mismatch = sku.inwardMismatch
                        return (
                          <tr
                            key={sku.id}
                            className={`hover:bg-slate-50 ${mismatch ? 'bg-amber-50/70' : ''}`}
                          >
                            <td className="py-3 text-sm font-mono text-slate-500">
                              <div>{sku.barcode || sku.marketplaceBarcode || '—'}</div>
                              <div className="text-[10px] text-slate-400">{sku.marketplaceSku || ''}</div>
                            </td>
                            <td className="py-3 text-sm font-medium text-slate-900">{sku.internalSku || '—'}</td>
                            <td className="py-3 text-sm text-right text-slate-600">{requiredQty}</td>
                            <td className="py-3 text-sm text-right text-slate-600">{originalPacked}</td>
                            <td className={`py-3 text-sm text-right font-medium ${removedQty > 0 ? 'text-red-600' : 'text-slate-500'}`}>{removedQty}</td>
                            <td className="py-3 text-sm text-right font-semibold text-slate-800">{packedQty}</td>
                            <td className="py-3 text-xs text-slate-500 max-w-[160px]">{formatBoxBreakdown(sku.boxQuantities)}</td>
                            <td className="py-3 text-sm text-right text-slate-700">{inwardQty}</td>
                            <td className={`py-3 text-sm text-right font-medium ${diff !== 0 && inwardQty > 0 ? 'text-amber-700' : 'text-slate-500'}`}>{inwardQty > 0 ? diff : '—'}</td>
                            <td className="py-3">
                              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${inwardStatusClass(sku.inwardStatus)}`}>
                                {inwardStatusLabel(sku.inwardStatus)}
                              </span>
                            </td>
                          </tr>
                        )
                      })
                    ) : (
                      <tr>
                        <td colSpan="10" className="py-8 text-center text-slate-400">No SKUs found</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {isAdmin && (
                <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <History className="w-4 h-4 text-slate-500" />
                    <h4 className="text-sm font-bold text-slate-800 uppercase tracking-wide">Inward Upload History (Admin)</h4>
                  </div>
                  {inwardUploads.length === 0 ? (
                    <p className="text-sm text-slate-500">No inward uploads recorded yet. Upload a sheet to create history.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-slate-200 text-slate-500 uppercase tracking-wider">
                            <th className="py-2 px-2 text-left font-semibold">Uploaded At</th>
                            <th className="py-2 px-2 text-left font-semibold">File</th>
                            <th className="py-2 px-2 text-left font-semibold">By</th>
                            <th className="py-2 px-2 text-right font-semibold">Updated SKUs</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {inwardUploads.map((entry) => (
                            <tr key={entry.id}>
                              <td className="py-2 px-2">{entry.createdAt ? new Date(entry.createdAt).toLocaleString() : '—'}</td>
                              <td className="py-2 px-2">{entry.fileName || '—'}</td>
                              <td className="py-2 px-2">{entry.uploadedByName || '—'}</td>
                              <td className="py-2 px-2 text-right font-semibold">{entry.updatedSkuCount ?? 0}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {activeTab === 'boxes' && (
            <div className="space-y-4">
              {consignment.boxes?.length > 0 && (
                <div className="flex justify-end gap-2 flex-wrap">
                  <button onClick={downloadWeightReport} className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 transition-colors">
                    <Download className="w-4 h-4" />Download Weight Report (CSV)
                  </button>
                  <button onClick={printWeightSummary} className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 transition-colors">
                    <Scale className="w-4 h-4" />Print Weight Summary
                  </button>
                  <button onClick={printAllLabels} className="flex items-center gap-2 px-4 py-2 bg-slate-800 text-white rounded-lg text-sm font-medium hover:bg-slate-700 transition-colors">
                    <Tag className="w-4 h-4" />Print All {consignment.boxes.length} Labels
                  </button>
                </div>
              )}

              {/* Shipment Level Weight ledger/table */}
              {consignment.boxes?.length > 0 && (
                <div className="bg-slate-50/50 border border-slate-200 rounded-xl p-5 mb-6">
                  <h4 className="text-sm font-bold text-slate-800 uppercase tracking-wide mb-3 flex items-center gap-2">
                    <Scale className="w-4 h-4 text-primary-500" />
                    Shipment Weight Records (Ledger)
                  </h4>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs border-collapse">
                      <thead>
                        <tr className="border-b border-slate-200 text-slate-500 uppercase tracking-wider">
                          <th className="py-2 px-3 text-left font-semibold">Box No</th>
                          <th className="py-2 px-3 text-right font-semibold">Weight</th>
                          <th className="py-2 px-3 text-left font-semibold">Captured By</th>
                          <th className="py-2 px-3 text-left font-semibold">Captured At</th>
                          <th className="py-2 px-3 text-center font-semibold">Proof</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {[...consignment.boxes]
                          .sort((a, b) => String(a.boxNo).localeCompare(String(b.boxNo), undefined, { numeric: true }))
                          .map((box) => (
                            <tr key={box.id} className="hover:bg-slate-100/50">
                              <td className="py-2 px-3 font-semibold text-slate-700">Box #{box.boxNo}</td>
                              <td className="py-2 px-3 text-right font-bold text-slate-900">
                                {box.weight ? `${box.weight.toFixed(2)} ${box.weightUnit || 'KG'}` : '-'}
                              </td>
                              <td className="py-2 px-3 text-slate-600">{box.weightCapturedByName || '-'}</td>
                              <td className="py-2 px-3 text-slate-500">
                                {box.weightCapturedAt ? new Date(box.weightCapturedAt).toLocaleString() : '-'}
                              </td>
                              <td className="py-2 px-3 text-center">
                                {box.weightImageId ? (
                                  <button
                                    onClick={() => openWeightImagePreview(box.weightImageId, box.boxNo)}
                                    className="text-primary-600 hover:text-primary-800 font-medium hover:underline text-xs inline-flex items-center gap-1"
                                  >
                                    View Image
                                  </button>
                                ) : (
                                  <span className="text-slate-400">-</span>
                                )}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {consignment.boxes?.length > 0 ? (
                consignment.boxes.map((box) => (
                  <div key={box.id} className="border border-slate-200 rounded-lg p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <Box className="w-5 h-5 text-primary-600" />
                        <span className="font-medium text-slate-900">Box #{box.boxNo}</span>
                        {box.liveUnsaved && (
                          <span className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">
                            In progress
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <button onClick={() => printBoxLabel(box)} className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 text-white rounded-lg text-xs font-medium hover:bg-slate-700 transition-colors">
                          <Tag className="w-3.5 h-3.5" />Print Label
                        </button>
                        <span className="text-sm text-slate-500">{box.totalQty} items</span>
                      </div>
                    </div>

                    {box.history && (
                      <div className="mb-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                        <div className="rounded-md bg-slate-50 border border-slate-100 px-2 py-1.5">Originally packed: <strong>{box.history.originallyPacked}</strong></div>
                        <div className="rounded-md bg-slate-50 border border-slate-100 px-2 py-1.5">Added later: <strong>{box.history.addedLater}</strong></div>
                        <div className="rounded-md bg-slate-50 border border-slate-100 px-2 py-1.5">Removed later: <strong>{box.history.removedLater}</strong></div>
                        <div className="rounded-md bg-slate-50 border border-slate-100 px-2 py-1.5">Final: <strong>{box.history.finalQuantity}</strong></div>
                      </div>
                    )}

                    {/* Weight Details */}
                    <div className="mb-3 px-3 py-2 bg-slate-50 rounded-lg border border-slate-100 flex flex-wrap items-center justify-between gap-2 text-xs">
                      <div className="flex items-center gap-4">
                        <div>
                          <span className="text-slate-400 block text-[10px] uppercase font-semibold">Weight</span>
                          <span className="font-bold text-slate-800">
                            {box.weight ? `${box.weight.toFixed(2)} ${box.weightUnit || 'KG'}` : 'Not Captured'}
                          </span>
                        </div>
                        {box.weightCapturedByName && (
                          <div>
                            <span className="text-slate-400 block text-[10px] uppercase font-semibold">Captured By</span>
                            <span className="text-slate-700 font-medium">{box.weightCapturedByName}</span>
                          </div>
                        )}
                        {box.weightCapturedAt && (
                          <div>
                            <span className="text-slate-400 block text-[10px] uppercase font-semibold">Captured At</span>
                            <span className="text-slate-700 font-medium">
                              {new Date(box.weightCapturedAt).toLocaleString()}
                            </span>
                          </div>
                        )}
                      </div>
                      {box.weightImageId && (
                        <button
                          onClick={() => openWeightImagePreview(box.weightImageId, box.boxNo)}
                          className="px-2.5 py-1 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-md font-medium shadow-sm transition-colors text-[10px] inline-flex items-center gap-1"
                        >
                          ⚖️ View Proof Image
                        </button>
                      )}
                    </div>

                    {box.items?.length > 0 && (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-slate-100 text-xs text-slate-500 uppercase">
                              <th className="text-left py-2 pr-3 font-semibold">Internal SKU</th>
                              <th className="text-left py-2 pr-3 font-semibold">Marketplace SKU</th>
                              <th className="text-left py-2 pr-3 font-semibold">Barcode</th>
                              <th className="text-right py-2 font-semibold">Qty</th>
                              {canEditBoxQuantities && <th className="text-right py-2 font-semibold">Edit</th>}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-50">
                            {box.items.map((item, idx) => (
                              <tr key={`${item.skuId || item.internalSku}-${idx}`}>
                                <td className="py-2 pr-3 font-medium text-slate-800">{item.internalSku || item.name || '—'}</td>
                                <td className="py-2 pr-3 font-mono text-slate-600">{item.marketplaceSku || '—'}</td>
                                <td className="py-2 pr-3 font-mono text-slate-500 text-xs">{item.barcode || item.marketplaceBarcode || '—'}</td>
                                <td className="py-2 text-right font-bold text-slate-900">{item.qty || 0}</td>
                                {canEditBoxQuantities && (
                                  <td className="py-2 text-right">
                                    <button
                                      type="button"
                                      className="text-xs font-semibold text-primary-600 hover:underline"
                                      onClick={() => setBoxEdit({
                                        boxNo: box.boxNo,
                                        skuId: item.skuId,
                                        internalSku: item.internalSku,
                                        qty: item.qty,
                                        reason: '',
                                        remarks: '',
                                      })}
                                    >
                                      Edit qty
                                    </button>
                                  </td>
                                )}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {(box.adjustments || []).filter((a) => a.status === 'completed').length > 0 && (
                      <div className="mt-3 border-t border-slate-100 pt-3">
                        <p className="text-[10px] uppercase font-semibold text-slate-400 mb-1.5">Box history</p>
                        <ul className="space-y-1 text-[11px] text-slate-600">
                          {(box.adjustments || []).filter((a) => a.status === 'completed').map((a) => (
                            <li key={a.id}>
                              <strong className="capitalize">{a.actionType}</strong>
                              {' '}{a.internalSku || a.skuId}:{' '}
                              {a.actionType === 'edit'
                                ? `${a.previousQuantity} → ${a.updatedQuantity}`
                                : a.quantity}
                              {' · '}{a.reasonLabel || a.reason || '—'}
                              {' · '}{a.removedByName || a.userName || '—'}
                              {' · '}{a.completedAt ? new Date(a.completedAt).toLocaleString() : ''}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                ))
              ) : (
                <div className="text-center py-8 text-slate-400">No boxes found</div>
              )}
            </div>
          )}

          {activeTab === 'report' && reportLoading && (
            <div className="flex items-center justify-center py-16 text-slate-500">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              Loading saved-box report...
            </div>
          )}

          {activeTab === 'report' && !reportLoading && !pivotData && (
            <div className="text-center py-16 text-slate-400">No packing report available</div>
          )}

          {activeTab === 'report' && !reportLoading && pivotData && (
            <div>
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-4 gap-3">
                <h3 className="text-lg font-semibold text-slate-900">Box-wise Packing Breakdown</h3>
                <div className="flex items-center gap-2">
                  <button onClick={() => exportCsv('packed')} className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-medium hover:bg-emerald-700 transition-colors">
                    <FileSpreadsheet className="w-3.5 h-3.5" />Export Packed
                  </button>
                  <button onClick={() => exportCsv('pending')} className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 text-white rounded-lg text-xs font-medium hover:bg-amber-600 transition-colors">
                    <FileSpreadsheet className="w-3.5 h-3.5" />Export Pending
                  </button>
                  <span className="text-xs text-slate-500 ml-2">
                    {pivotData.summary.packedSkuCount || 0} packed, {pivotData.summary.pendingSkuCount || 0} pending, {pivotData.summary.completeSkuCount || 0} complete
                  </span>
                </div>
              </div>

              {pivotData.integrityIssues?.length > 0 && (
                <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="w-5 h-5 text-amber-600 mt-0.5" />
                    <div>
                      <p className="text-sm font-semibold text-amber-900">
                        Report uses saved boxes only. {pivotData.integrityIssues.length} integrity issue(s) found.
                      </p>
                      <div className="mt-2 space-y-1">
                        {pivotData.integrityIssues.slice(0, 3).map((issue, idx) => (
                          <p key={`${issue.type}-${idx}`} className="text-xs text-amber-800">
                            {issue.message || issue.type}
                          </p>
                        ))}
                        {pivotData.integrityIssues.length > 3 && (
                          <p className="text-xs font-medium text-amber-900">
                            +{pivotData.integrityIssues.length - 3} more issue(s)
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Report summary strip */}
              {(() => {
                const summary = pivotData.summary || {};
                const cards = [
                  { label: 'Total SKUs', value: summary.skuCount || 0, color: 'text-slate-900' },
                  { label: 'Required', value: summary.totalRequired || 0, color: 'text-slate-700' },
                  { label: 'Packed', value: summary.totalPacked || 0, color: 'text-emerald-600' },
                  { label: 'Pending', value: summary.totalPending || 0, color: 'text-amber-600' },
                  { label: 'Boxes', value: summary.boxCount || 0, color: 'text-primary-600' },
                  { label: 'Complete', value: `${summary.percentComplete || 0}%`, color: 'text-primary-600' },
                ];
                return (
                  <div className="grid grid-cols-3 md:grid-cols-6 gap-2 mb-4">
                    {cards.map(c => (
                      <div key={c.label} className="bg-slate-50 rounded-lg px-3 py-2 text-center">
                        <p className={`text-lg font-bold ${c.color}`}>{c.value}</p>
                        <p className="text-[10px] uppercase tracking-wider text-slate-400">{c.label}</p>
                      </div>
                    ))}
                  </div>
                );
              })()}

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase">#</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Marketplace SKU</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Internal SKU</th>
                      <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Required</th>
                      <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Packed</th>
                      <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Remaining</th>
                      {pivotData.boxes.map(b => (
                        <th key={b.boxNo} className="text-center px-3 py-3 text-xs font-semibold text-white bg-primary-600 uppercase whitespace-nowrap">Box #{b.boxNo}</th>
                      ))}
                      <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Total in Boxes</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {pivotData.rows.map((row, idx) => (
                      <tr key={row.skuId} className={`${row.remaining === 0 ? 'bg-emerald-50/50' : row.remaining < 0 ? 'bg-red-50/50' : ''} hover:bg-slate-50`}>
                        <td className="px-4 py-3 text-xs text-slate-400">{idx + 1}</td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-700">{row.marketplaceSku}</td>
                        <td className="px-4 py-3 font-medium text-slate-900">{row.internalSku}</td>
                        <td className="px-4 py-3 text-center font-semibold text-slate-700">{row.required}</td>
                        <td className="px-4 py-3 text-center font-semibold text-primary-600">{row.packedFromBoxes || 0}</td>
                        <td className="px-4 py-3 text-center font-bold">
                          {row.remaining === 0 ? (
                            <span className="inline-flex items-center gap-1 text-emerald-600"><CheckCircle2 className="w-3.5 h-3.5" />0</span>
                          ) : row.remaining < 0 ? (
                            <span className="inline-flex items-center gap-1 text-red-600"><AlertCircle className="w-3.5 h-3.5" />{row.remaining}</span>
                          ) : (
                            <span className="text-amber-600">{row.remaining}</span>
                          )}
                        </td>
                        {pivotData.boxes.map(b => {
                          const qty = row.boxQtys[b.boxNo] || 0;
                          return (
                            <td key={b.boxNo} className={`px-3 py-3 text-center font-mono text-xs ${qty > 0 ? 'bg-primary-50 text-primary-700 font-bold' : 'text-slate-300'}`}>
                              {qty > 0 ? qty : '-'}
                            </td>
                          );
                        })}
                        <td className="px-4 py-3 text-center font-bold text-slate-900">{row.totalInBoxes || row.packedFromBoxes || 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'videos' && (
            <div>
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-4">
                <h3 className="text-lg font-semibold text-slate-900">Box-wise Videos</h3>
                <div className="flex items-center gap-2 flex-wrap justify-end">
                  {consignment.videos?.length > 0 && (
                    <button onClick={() => {
                      const headers = ['Box No', 'File Name', 'Video URL', 'Size (KB)', 'Uploaded At'];
                      const csvRows = [headers.join(',')];
                      consignment.videos.forEach(v => {
                        csvRows.push([v.boxNo || 'Unassigned', `"${v.originalName}"`, buildUploadStreamUrl(v.id, 'video') || '', Math.round((v.size || 0) / 1024), new Date(v.uploadedAt).toLocaleString()].join(','));
                      });
                      const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `${consignment.internalShipmentNo || consignment.id}_videos.csv`;
                      a.click();
                      URL.revokeObjectURL(url);
                      addToast('Video list exported', 'success');
                    }} className="flex items-center gap-1.5 px-3 py-2 border border-slate-200 rounded-lg text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors">
                      <FileSpreadsheet className="w-3.5 h-3.5" />Export List
                    </button>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    {(consignment.boxes?.length > 0) ? (
                      <select
                        value={videoUploadBoxNo}
                        onChange={(e) => setVideoUploadBoxNo(e.target.value)}
                        className="text-sm border border-slate-200 rounded-lg px-3 py-2 bg-white text-slate-700"
                      >
                        <option value="">Select box...</option>
                        {[...consignment.boxes]
                          .sort((a, b) => String(a.boxNo).localeCompare(String(b.boxNo), undefined, { numeric: true }))
                          .map((b) => (
                            <option key={b.id || b.boxNo} value={b.boxNo}>Box #{b.boxNo}</option>
                          ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        placeholder="Box #"
                        value={videoUploadBoxNo}
                        onChange={(e) => setVideoUploadBoxNo(e.target.value)}
                        className="text-sm border border-slate-200 rounded-lg px-3 py-2 w-24"
                      />
                    )}
                    <label className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors text-sm ${videoUploadBoxNo ? 'bg-primary-600 text-white hover:bg-primary-700 cursor-pointer' : 'bg-slate-200 text-slate-500 cursor-not-allowed'}`}>
                      <Upload className="w-4 h-4" />
                      {uploading ? 'Uploading...' : 'Upload Video'}
                      <input type="file" accept="video/*" className="hidden" onChange={(e) => handleFileUpload(e, 'video')} disabled={uploading || !videoUploadBoxNo} />
                    </label>
                  </div>
                </div>
              </div>

              {videoBoxNumbers.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-5">
                  <button
                    type="button"
                    onClick={() => setSelectedVideoBox('all')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                      selectedVideoBox === 'all'
                        ? 'bg-primary-600 text-white border-primary-600'
                        : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    All Boxes ({videoBoxNumbers.length})
                  </button>
                  {videoBoxNumbers.map((boxNo) => {
                    const hasVideo = !!videoByBox[boxNo];
                    return (
                      <button
                        key={boxNo}
                        type="button"
                        onClick={() => setSelectedVideoBox(boxNo)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                          selectedVideoBox === boxNo
                            ? 'bg-primary-600 text-white border-primary-600'
                            : hasVideo
                              ? 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                              : 'bg-slate-50 text-slate-400 border-slate-100'
                        }`}
                      >
                        Box #{boxNo}{hasVideo ? '' : ' (no video)'}
                      </button>
                    );
                  })}
                </div>
              )}

              {visibleVideoBoxes.length > 0 ? (
                <div className="space-y-6">
                  {visibleVideoBoxes.map((boxNo) => {
                    const video = videoByBox[boxNo];
                    return (
                      <div key={boxNo} className="rounded-xl border border-slate-200 bg-slate-50/40 p-4">
                        <div className="flex items-center gap-2 mb-3">
                          <Box className="w-4 h-4 text-primary-600" />
                          <h4 className="text-sm font-bold text-slate-900">Box #{boxNo}</h4>
                          {video ? (
                            <span className="text-xs text-emerald-600 font-medium">Video available</span>
                          ) : (
                            <span className="text-xs text-slate-400">No video uploaded yet</span>
                          )}
                        </div>
                        {video ? (
                          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                            <VideoPreviewCard
                              video={video}
                              boxNo={boxNo}
                              addToast={addToast}
                              canDelete={canDeleteVideos}
                              onDelete={() => setDeleteFile({ id: video.id, type: 'video', name: video.originalName })}
                            />
                          </div>
                        ) : (
                          <p className="text-sm text-slate-500">Select this box in the upload dropdown above to attach a packing video.</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-8 text-slate-400">No boxes or videos for this consignment yet</div>
              )}
            </div>
          )}

          {activeTab === 'documents' && (
            <div>
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-4">
                <h3 className="text-lg font-semibold text-slate-900">Documents</h3>
                <label className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 cursor-pointer transition-colors text-sm">
                  <Upload className="w-4 h-4" />
                  {uploading ? 'Uploading...' : 'Upload Document'}
                  <input
                    type="file"
                    accept=".pdf,.doc,.docx,.xlsx,.xls,.csv"
                    className="hidden"
                    onChange={(e) => handleFileUpload(e, 'document')}
                    disabled={uploading}
                  />
                </label>
              </div>
              <div className="space-y-3">
                {consignment.documents?.length > 0 ? (
                  consignment.documents.map((doc) => (
                    <div key={doc.id} className="flex items-center justify-between p-4 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors">
                      <div className="flex items-center gap-3">
                        <FileText className="w-8 h-8 text-primary-600" />
                        <div>
                          <p className="text-sm font-medium text-slate-900">{doc.originalName}</p>
                          <p className="text-xs text-slate-500">
                            {new Date(doc.uploadedAt).toLocaleDateString()} - {(doc.size / 1024).toFixed(1)} KB
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => openDocument(doc)}
                          className="p-2 text-slate-400 hover:text-primary-600 transition-colors"
                          title="Open"
                        >
                          <ExternalLink className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => downloadDocument(doc)}
                          className="p-2 text-slate-400 hover:text-emerald-600 transition-colors"
                          title="Download"
                        >
                          <Download className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => setDeleteFile({ id: doc.id, type: 'document', name: doc.originalName })}
                          className="p-2 text-slate-400 hover:text-red-600 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-center py-8 text-slate-400">No documents uploaded</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* File Delete Confirmation */}
      <ConfirmModal
        show={!!deleteFile}
        title="Delete File?"
        message={<span>Are you sure you want to delete <strong className="text-slate-800">{deleteFile?.name}</strong>? This will also remove it from protected file storage.</span>}
        confirmLabel="Delete File"
        loading={false}
        onConfirm={handleDeleteFile}
        onCancel={() => setDeleteFile(null)}
      />

      {boxEdit && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/50 p-4" onClick={() => !boxEditSaving && setBoxEdit(null)}>
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 w-full max-w-md p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-bold text-slate-900">Edit Box Quantity</h3>
            <p className="text-xs text-slate-500">
              Box #{boxEdit.boxNo} · {boxEdit.internalSku || boxEdit.skuId}
            </p>
            <label className="block text-xs">
              <span className="font-semibold text-slate-500 uppercase">Updated quantity</span>
              <input
                type="number"
                min={0}
                value={boxEdit.qty}
                onChange={(e) => setBoxEdit({ ...boxEdit, qty: e.target.value })}
                className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
              />
            </label>
            <label className="block text-xs">
              <span className="font-semibold text-slate-500 uppercase">Reason</span>
              <input
                type="text"
                value={boxEdit.reason}
                onChange={(e) => setBoxEdit({ ...boxEdit, reason: e.target.value })}
                className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                placeholder="Required"
              />
            </label>
            <label className="block text-xs">
              <span className="font-semibold text-slate-500 uppercase">Remarks</span>
              <textarea
                value={boxEdit.remarks}
                onChange={(e) => setBoxEdit({ ...boxEdit, remarks: e.target.value })}
                className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm resize-none"
                rows={2}
              />
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" disabled={boxEditSaving} onClick={() => setBoxEdit(null)} className="px-3 py-1.5 text-xs border rounded-lg">Cancel</button>
              <button
                type="button"
                disabled={boxEditSaving || !String(boxEdit.reason || '').trim()}
                onClick={saveBoxQuantityEdit}
                className="px-3 py-1.5 text-xs bg-primary-600 text-white rounded-lg disabled:opacity-50 inline-flex items-center gap-1"
              >
                {boxEditSaving && <Loader2 className="w-3 h-3 animate-spin" />}
                Save change
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Weight Image Preview Modal */}
      {previewWeightBoxNo && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/80 backdrop-blur-sm p-4 animate-fade-in" onClick={() => { setPreviewWeightImgUrl(null); setPreviewWeightBoxNo(null); }}>
          <div className="bg-white rounded-2xl max-w-2xl w-full overflow-hidden shadow-2xl animate-pop-in border border-slate-200" onClick={e => e.stopPropagation()}>
            <div className="bg-slate-900 text-white px-5 py-4 flex items-center justify-between">
              <div>
                <h3 className="font-bold text-sm">⚖️ Box #{previewWeightBoxNo} Weight Proof</h3>
                <p className="text-slate-400 text-[10px]">Verification image captured during packing</p>
              </div>
              <button
                type="button"
                onClick={() => { setPreviewWeightImgUrl(null); setPreviewWeightBoxNo(null); }}
                className="text-slate-400 hover:text-white text-lg leading-none p-1 rounded-md hover:bg-white/10 transition-colors"
              >
                ✕
              </button>
            </div>
            <div className="p-6 flex flex-col items-center justify-center min-h-[300px] bg-slate-50">
              {fetchingWeightImg ? (
                <div className="flex flex-col items-center gap-2">
                  <Loader2 className="w-8 h-8 animate-spin text-primary-600" />
                  <span className="text-xs text-slate-500 font-medium">Loading proof image...</span>
                </div>
              ) : previewWeightImgUrl ? (
                <img
                  src={previewWeightImgUrl}
                  alt={`Weight Proof Box #${previewWeightBoxNo}`}
                  className="max-h-[60vh] object-contain rounded-lg border border-slate-200 shadow-sm"
                />
              ) : (
                <div className="text-center py-8">
                  <AlertCircle className="w-10 h-10 text-slate-400 mx-auto mb-2" />
                  <p className="text-xs text-slate-500">Weight image proof could not be loaded or is unavailable.</p>
                </div>
              )}
            </div>
            <div className="bg-slate-50 px-5 py-3 border-t border-slate-200 flex justify-end">
              <button
                type="button"
                onClick={() => { setPreviewWeightImgUrl(null); setPreviewWeightBoxNo(null); }}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-xs font-semibold transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {showReassignId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form
            onSubmit={handleReassignId}
            className="bg-white rounded-xl shadow-xl border border-slate-200 w-full max-w-md p-5 space-y-4"
          >
            <h3 className="text-lg font-bold text-slate-900">Assign official consignment ID</h3>
            <p className="text-sm text-slate-600">
              Current ID: <span className="font-mono font-semibold">{consignment.id}</span>
              {consignment.internalShipmentNo && (
                <> · Internal: <span className="font-semibold">{consignment.internalShipmentNo}</span></>
              )}
            </p>
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-1.5">
                Official consignment ID
              </label>
              <input
                type="text"
                value={newConsignmentId}
                onChange={(e) => setNewConsignmentId(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm font-mono focus:ring-2 focus:ring-primary-500 outline-none"
                placeholder="CON-2024-001"
                autoFocus
                required
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowReassignId(false)}
                className="px-4 py-2 text-sm border border-slate-200 rounded-lg hover:bg-slate-50"
                disabled={reassigningId}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-60"
                disabled={reassigningId}
              >
                {reassigningId ? 'Updating…' : 'Update ID'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};

export default ConsignmentDetail;
