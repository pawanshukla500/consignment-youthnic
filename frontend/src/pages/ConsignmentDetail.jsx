import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router';
import {
  ArrowLeft, Package, Box, Video, FileText, Upload, AlertCircle,
  Trash2, Download, Loader2, FileSpreadsheet, CheckCircle2,
  Copy, ExternalLink, Tag, ChevronDown, ChevronUp, Database, Scale, AlertTriangle, History, Pencil, UploadCloud,
  PackageCheck, Search, X, Eye, LayoutList, LayoutGrid, RefreshCw
} from 'lucide-react';
import ConfirmModal from '../components/ConfirmModal';
import {
  printShipmentBoxLabel,
  printAllShipmentBoxLabels,
  downloadShipmentBoxLabelPdf,
  downloadAllShipmentBoxLabelsPdf,
} from '../utils/shipmentLabel';
import { consignmentsAPI, uploadsAPI, packingAPI } from '../services/api';
import { useToast } from '../context/ToastContext';
import { buildUploadStreamUrl, fetchAuthenticatedStream } from '../utils/videoPlayback';
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
  'box_renumbered',
  'inward_import',
  'skus',
  'boxes',
  'box_items',
  'scan_events',
  'consignments',
]);

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

async function loadConsignmentWithLiveSession(consignmentId, { withSyncStatus = true } = {}) {
  const consignmentRes = await consignmentsAPI.getById(consignmentId)
  const consignment = consignmentRes.data.consignment
  const needsLive =
    withSyncStatus &&
    (consignment?.liveSessionActive || ['in_progress', 'pending'].includes(consignment?.status))
  if (!needsLive) {
    return mergeLivePackingSession(consignment, null)
  }
  const syncRes = await packingAPI.syncStatus(consignmentId).catch(() => null)
  return mergeLivePackingSession(consignment, syncRes?.data)
}

function VideoFileCard({ video, boxNo, onDelete, addToast, canDelete }) {
  const [links, setLinks] = useState(null);
  const [loadingLinks, setLoadingLinks] = useState(true);
  const [busy, setBusy] = useState('');

  const formatSize = (bytes) => {
    const n = Number(bytes) || 0;
    if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
    if (n >= 1024) return `${Math.round(n / 1024)} KB`;
    return `${n} B`;
  };

  const loadLinks = async () => {
    if (!video?.id) return;
    setLoadingLinks(true);
    try {
      const [{ data: play }, shareRes] = await Promise.all([
        uploadsAPI.getPlayUrl(video.id, 'video').catch(() => ({ data: null })),
        uploadsAPI.getShareLink(video.id, 'video').catch(() => ({ data: null })),
      ]);
      const share = shareRes?.data || null;
      const streamSrc = buildUploadStreamUrl(video.id, 'video', video.uploadedAt || video.updatedAt || video.size)
        || play?.streamUrl
        || play?.playUrl
        || null;
      const absoluteStream = streamSrc
        ? (String(streamSrc).startsWith('http') ? streamSrc : `${window.location.origin}${streamSrc}`)
        : (share?.streamUrl || null);
      const downloadSrc = play?.downloadUrl
        || (streamSrc ? `${streamSrc}${String(streamSrc).includes('?') ? '&' : '?'}download=1` : null)
        || share?.downloadUrl
        || null;
      const absoluteDownload = downloadSrc
        ? (String(downloadSrc).startsWith('http') ? downloadSrc : `${window.location.origin}${downloadSrc}`)
        : null;

      setLinks({
        // Prefer real R2 URLs for preview/copy. Dispute link is always the details page.
        previewUrl: play?.r2SignedUrl || play?.publicUrl || share?.r2SignedUrl || share?.publicUrl || share?.streamUrl || play?.publicStreamUrl || null,
        downloadUrl: absoluteDownload || play?.r2SignedUrl || share?.r2SignedUrl || play?.publicUrl || share?.publicUrl || null,
        disputeUrl: share?.shareUrl || share?.pageUrl || play?.shareUrl || null,
        r2Url: play?.r2SignedUrl || play?.publicUrl || share?.r2SignedUrl || share?.publicUrl || null,
        r2SignedUrl: play?.r2SignedUrl || share?.r2SignedUrl || null,
        publicUrl: play?.publicUrl || share?.publicUrl || null,
        storagePath: play?.storagePath || share?.storagePath || video.storagePath || null,
        mimeType: play?.mimeType || share?.mimeType || video.mimeType || null,
        size: play?.size || share?.size || video.size || 0,
        originalName: play?.originalName || share?.originalName || video.originalName || null,
        uploadedAt: play?.uploadedAt || share?.uploadedAt || video.uploadedAt || null,
        authStreamUrl: absoluteStream,
      });
    } catch {
      setLinks(null);
      addToast?.('Could not resolve Cloudflare R2 video link', 'error');
    } finally {
      setLoadingLinks(false);
    }
  };

  useEffect(() => {
    loadLinks();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video?.id, video?.uploadedAt, video?.updatedAt, video?.size, video?.originalName]);

  const handleCopy = async (value, label) => {
    if (!value) {
      addToast('Link unavailable', 'error');
      return;
    }
    try {
      await navigator.clipboard?.writeText(value);
      addToast(`${label} copied`, 'success');
    } catch {
      addToast('Could not copy link', 'error');
    }
  };

  const handlePreviewOpen = async (e) => {
    e.preventDefault();
    setBusy('open');
    try {
      const url = links?.previewUrl || links?.r2Url || links?.disputeUrl || links?.authStreamUrl;
      if (url) {
        window.open(url, '_blank', 'noopener,noreferrer');
        return;
      }
      addToast('Preview link unavailable — sign in again', 'error');
    } finally {
      setBusy('');
    }
  };

  const handleDownload = async () => {
    setBusy('download');
    try {
      const fileName = links?.originalName || video.originalName || `box_${boxNo || video.boxNo || 'video'}.mp4`;
      // Prefer authenticated R2 stream with attachment disposition (original bytes).
      if (links?.downloadUrl && String(links.downloadUrl).includes('/api/uploads/')) {
        const response = await fetchAuthenticatedStream(video.id, 'video', { download: true }).catch(() => null);
        if (response?.ok) {
          const blob = await response.blob();
          const objectUrl = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = objectUrl;
          a.download = fileName;
          a.click();
          URL.revokeObjectURL(objectUrl);
          return;
        }
      }

      if (links?.r2SignedUrl || links?.publicUrl || links?.downloadUrl) {
        const response = await fetch(links.r2SignedUrl || links.publicUrl || links.downloadUrl);
        if (!response.ok) throw new Error(`Download failed (${response.status})`);
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(objectUrl);
        return;
      }

      const response = await fetchAuthenticatedStream(video.id, 'video');
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(objectUrl);
    } catch {
      addToast('Could not download original video from Cloudflare R2', 'error');
    } finally {
      setBusy('');
    }
  };

  const displayName = links?.originalName || video.originalName || 'Packing video';
  const sizeLabel = formatSize(links?.size ?? video.size);
  const typeLabel = (links?.mimeType || video.mimeType || 'video/mp4').split(';')[0];
  const whenLabel = links?.uploadedAt || video.uploadedAt
    ? new Date(links?.uploadedAt || video.uploadedAt).toLocaleString()
    : '—';
  const r2Link = links?.r2Url || links?.previewUrl || '';

  return (
    <div className="border border-slate-200 rounded-xl bg-white overflow-hidden hover:shadow-md transition-shadow">
      <div className="px-3.5 py-2.5 border-b border-slate-100 bg-slate-50/80 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-emerald-50 text-emerald-700 flex items-center justify-center shrink-0">
            <CheckCircle2 className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-900 truncate flex items-center gap-1.5">
              {boxNo ? `Box #${boxNo}` : 'Video'} · available
              {Number(video.part) > 1 && (
                <span
                  className="text-[9px] font-bold uppercase tracking-wide text-primary-700 bg-primary-50 border border-primary-100 px-1.5 py-0.5 rounded shrink-0"
                  title="Recorded after this box was reopened to add more qty — the earlier video is kept, not replaced"
                >
                  {video.boxLabel || `Part ${video.part}`}
                </span>
              )}
            </p>
            <p className="text-[11px] text-slate-500 truncate" title={displayName}>{displayName}</p>
          </div>
        </div>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-sky-700 bg-sky-50 border border-sky-100 px-2 py-0.5 rounded shrink-0">
          Cloudflare R2
        </span>
      </div>

      <div className="p-3.5 space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2">
            <p className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold">Size</p>
            <p className="mt-0.5 font-semibold text-slate-800 tabular-nums">{sizeLabel}</p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2">
            <p className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold">Type</p>
            <p className="mt-0.5 font-semibold text-slate-800 truncate" title={typeLabel}>{typeLabel}</p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 sm:col-span-2">
            <p className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold">Uploaded</p>
            <p className="mt-0.5 font-semibold text-slate-800">{whenLabel}</p>
          </div>
        </div>

        {links?.storagePath ? (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold mb-1">R2 object path</p>
            <p className="text-[11px] font-mono text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 break-all">{links.storagePath}</p>
          </div>
        ) : null}

        <div>
          <p className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold mb-1">Cloudflare R2 link</p>
          {loadingLinks ? (
            <div className="flex items-center gap-2 text-xs text-slate-500 py-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Resolving R2 link…
            </div>
          ) : (
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                readOnly
                value={r2Link}
                placeholder="Link unavailable"
                className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-mono text-slate-700"
              />
              <button
                type="button"
                onClick={() => handleCopy(r2Link, 'R2 link')}
                disabled={!r2Link}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-900 disabled:opacity-50"
              >
                <Copy className="w-3.5 h-3.5" /> Copy
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap pt-1">
          <button
            type="button"
            onClick={handlePreviewOpen}
            disabled={loadingLinks || busy === 'open'}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary-700 bg-primary-50 hover:bg-primary-100 px-2.5 py-1.5 rounded-lg disabled:opacity-50"
          >
            {busy === 'open' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ExternalLink className="w-3.5 h-3.5" />}
            Preview open
          </button>
          <button
            type="button"
            onClick={handleDownload}
            disabled={loadingLinks || busy === 'download'}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 px-2.5 py-1.5 rounded-lg disabled:opacity-50"
          >
            {busy === 'download' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            Download original
          </button>
          <button
            type="button"
            onClick={() => handleCopy(links?.disputeUrl, 'Dispute share link')}
            disabled={!links?.disputeUrl}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 px-2.5 py-1.5 rounded-lg disabled:opacity-50"
          >
            <Copy className="w-3.5 h-3.5" /> Copy dispute link
          </button>
          {canDelete && (
            <button
              type="button"
              onClick={onDelete}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-700 bg-red-50 hover:bg-red-100 px-2.5 py-1.5 rounded-lg ml-auto"
            >
              <Trash2 className="w-3.5 h-3.5" /> Delete
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
  const isAdmin = user?.role === 'admin' || user?.role === 'organization_head';
  const canDeleteVideos = user?.role === 'admin' || user?.role === 'organization_head' || user?.permissions?.deleteVideos === true;
  const canEditBoxQuantities = user?.role === 'admin' || user?.role === 'organization_head' || user?.permissions?.editBoxQuantities === true;
  const { pendingChanges } = useConsignmentSync();
  const [searchParams, setSearchParams] = useSearchParams();
  const [uploading, setUploading] = useState(false);
  const [videoUploadBoxNo, setVideoUploadBoxNo] = useState('');
  const [selectedVideoBox, setSelectedVideoBox] = useState('all');
  const [consignment, setConsignment] = useState(null);
  // Google Sheet push (Packing Report → Consignment Master columns I and J)
  const [sheetPushing, setSheetPushing] = useState(false);
  const [sheetPushResult, setSheetPushResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [packingReport, setPackingReport] = useState(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportView, setReportView] = useState('compact'); // 'compact' | 'grid' — compact avoids a column per box
  const [previewWeightImgUrl, setPreviewWeightImgUrl] = useState(null);
  const [previewWeightBoxNo, setPreviewWeightBoxNo] = useState(null);
  const [fetchingWeightImg, setFetchingWeightImg] = useState(false);
  // Tab is synced to the URL (?tab=) so it's deep-linkable, shareable & survives refresh
  const activeTab = searchParams.get('tab') || 'skus';
  const setActiveTab = (tab) => {
    setSearchParams(prev => {
      const p = new URLSearchParams(prev);
      p.set('tab', tab);
      return p;
    }, { replace: true });
    requestAnimationFrame(() => {
      const navEl = document.getElementById('consignment-tabs-nav');
      if (navEl) {
        const rect = navEl.getBoundingClientRect();
        if (rect.top < 65) {
          window.scrollTo({
            top: Math.max(0, window.scrollY + rect.top - 65),
            behavior: 'smooth'
          });
        }
      }
    });
  };
  const [trackingOpen,  setTrackingOpen]  = useState(false);
  const [editingTracking, setEditingTracking] = useState(false);
  const [deleteFile, setDeleteFile] = useState(null); // { id, type, name }
  const [savingTracking, setSavingTracking] = useState(false);
  const [trackingForm, setTrackingForm] = useState({});
  const [showReassignId, setShowReassignId] = useState(false);
  const [newConsignmentId, setNewConsignmentId] = useState('');
  const [reassigningId, setReassigningId] = useState(false);
  const [, setOmsGuruUploading] = useState(false);
  const [, setOmsGuruUploads] = useState([]);
  const [, setOmsGuruUploadsLoading] = useState(false);
  const _omsGuruFileRef = useRef(null);
  const [inwardUploading, setInwardUploading] = useState(false);
  const [inwardUploads, setInwardUploads] = useState([]);
  const inwardFileRef = useRef(null);
  const [boxEdit, setBoxEdit] = useState(null); // { boxNo, skuId, qty, reason, remarks }
  const [boxEditSaving, setBoxEditSaving] = useState(false);
  const [boxRename, setBoxRename] = useState(null); // { boxNo, newBoxNo, reason, remarks }
  const [boxRenameSaving, setBoxRenameSaving] = useState(false);
  const liveRefreshRef = useRef(null);
  const initialTrackingRef = useRef({});
  const [skuSearch, setSkuSearch] = useState('');
  const [skuStatusFilter, setSkuStatusFilter] = useState('all');
  const [boxSearch, setBoxSearch] = useState('');

  const openTrackingEdit = () => {
    const initial = {
      name: consignment.name || '',
      shipmentNo: consignment.shipmentNo || '',
      internalShipmentNo: consignment.internalShipmentNo || '',
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
      unitsShipped: consignment.unitsShipped != null ? consignment.unitsShipped : '',
      unitsReceived: consignment.unitsReceived != null ? consignment.unitsReceived : '',
      unitsInwarded: consignment.unitsInwarded != null ? consignment.unitsInwarded : '',
      qaFailExcessQty: consignment.qaFailExcessQty != null ? consignment.qaFailExcessQty : '',
    };
    initialTrackingRef.current = initial;
    setTrackingForm(initial);
    setEditingTracking(true);
    setTrackingOpen(true);
  };

  const saveTracking = async () => {
    setSavingTracking(true);
    try {
      // Prevent race conditions: only update fields that were actually modified by the user
      // so concurrent workflow updates (e.g. invoice, dispatch, status, inward) are not overwritten
      const initial = initialTrackingRef.current || {};
      const numericFields = new Set(['unitsShipped', 'unitsReceived', 'unitsInwarded', 'qaFailExcessQty']);
      const dirtyPayload = {};

      Object.entries(trackingForm).forEach(([key, val]) => {
        if (val !== initial[key]) {
          if (numericFields.has(key)) {
            dirtyPayload[key] = val === '' ? null : (Number(val) || 0);
          } else {
            dirtyPayload[key] = val;
          }
        }
      });

      if (Object.keys(dirtyPayload).length > 0) {
        if ('internalShipmentNo' in dirtyPayload && !String(dirtyPayload.internalShipmentNo || '').trim()) {
          addToast('Internal Shipment No. cannot be empty', 'error');
          setSavingTracking(false);
          return;
        }
        await consignmentsAPI.update(id, dirtyPayload);
        addToast('Tracking details updated', 'success');
      } else {
        addToast('No changes detected', 'info');
      }

      setEditingTracking(false);
      await fetchConsignment({ silent: true });
    } catch (error) {
      addToast(error.response?.data?.error || 'Update failed', 'error');
    } finally {
      setSavingTracking(false);
    }
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

  const copyText = async (text, label) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      addToast(`Copied ${label}`, 'info');
    } catch {
      addToast(`Could not copy ${label}`, 'warning');
    }
  };

  const consignmentSkus = consignment?.skus;
  const filteredSkus = React.useMemo(() => {
    const list = consignmentSkus || [];
    const q = skuSearch.trim().toLowerCase();
    return list.filter((sku) => {
      if (skuStatusFilter === 'mismatch' && !sku.inwardMismatch) return false;
      const required = Number(sku.requiredQty) || 0;
      const packed = Number(sku.finalPackedQty ?? sku.packedQty) || 0;
      if (skuStatusFilter === 'packed' && packed < required) return false;
      if (skuStatusFilter === 'pending' && packed >= required) return false;

      if (!q) return true;
      const barcode = String(sku.barcode || sku.marketplaceBarcode || '').toLowerCase();
      const internal = String(sku.internalSku || '').toLowerCase();
      const mpSku = String(sku.marketplaceSku || '').toLowerCase();
      return barcode.includes(q) || internal.includes(q) || mpSku.includes(q);
    });
  }, [consignmentSkus, skuSearch, skuStatusFilter]);

  const consignmentBoxes = consignment?.boxes;
  const filteredBoxes = React.useMemo(() => {
    const list = [...(consignmentBoxes || [])].sort((a, b) =>
      String(a.boxNo).localeCompare(String(b.boxNo), undefined, { numeric: true })
    );
    const q = boxSearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter((b) => {
      if (String(b.boxNo).toLowerCase().includes(q)) return true;
      return (b.items || []).some(
        (i) =>
          String(i.internalSku || '').toLowerCase().includes(q) ||
          String(i.marketplaceSku || '').toLowerCase().includes(q) ||
          String(i.barcode || '').toLowerCase().includes(q)
      );
    });
  }, [consignmentBoxes, boxSearch]);

  const timelineEvents = useMemo(() => {
    if (!consignment) return [];
    const events = [];

    // 1. Consignment Creation
    if (consignment.createdAt) {
      events.push({
        id: 'evt-created',
        timestamp: new Date(consignment.createdAt).getTime(),
        type: 'creation',
        title: 'Consignment Inward Registered',
        description: `Shipment inward registered for ${consignment.marketplace || 'Marketplace'} (${consignment.marketplaceConsignmentId || consignment.internalShipmentNo || 'ID'})`,
        user: consignment.createdByName || consignment.createdBy || 'System',
        badge: 'Inward Created',
        badgeColor: 'bg-blue-50 text-blue-700 border-blue-200/80',
      });
    }

    // 2. Stage Confirmations
    if (consignment.stageConfirmations && typeof consignment.stageConfirmations === 'object') {
      const stageMeta = {
        material_inwarded: { title: 'Material Inward Confirmed', badge: 'Stage: Inward', color: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
        packing_completed: { title: 'Packing Station Completed', badge: 'Stage: Packed', color: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
        invoice_created: { title: 'Invoice Generated & Confirmed', badge: 'Stage: Invoiced', color: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
        ready_to_dispatch: { title: 'Ready to Dispatch Sign-off', badge: 'Stage: Ready', color: 'bg-teal-50 text-teal-700 border-teal-200' },
        dispatched: { title: 'Consignment Dispatched', badge: 'Stage: Dispatched', color: 'bg-purple-50 text-purple-700 border-purple-200' },
      };

      Object.entries(consignment.stageConfirmations).forEach(([stageKey, data]) => {
        if (data?.confirmedAt) {
          const meta = stageMeta[stageKey] || { title: `Stage Milestone: ${stageKey}`, badge: 'Milestone', color: 'bg-slate-50 text-slate-700 border-slate-200' };
          events.push({
            id: `evt-stage-${stageKey}`,
            timestamp: new Date(data.confirmedAt).getTime(),
            type: 'stage',
            title: meta.title,
            description: data.notes ? `Note: "${data.notes}"` : 'Stage milestone successfully approved and signed off.',
            user: data.confirmedByName || data.confirmedBy || 'Warehouse Team',
            badge: meta.badge,
            badgeColor: meta.color,
          });
        }
      });
    }

    // 3. Boxes Packed
    if (Array.isArray(consignment.boxes)) {
      consignment.boxes.forEach((box) => {
        const time = box.createdAt || box.updatedAt || box.scannedAt;
        if (time) {
          const itemCount = Array.isArray(box.items) ? box.items.reduce((sum, it) => sum + (Number(it.quantity) || 1), 0) : 0;
          events.push({
            id: `evt-box-${box.boxNo}`,
            timestamp: new Date(time).getTime(),
            type: 'box',
            title: `Box #${box.boxNo} Finalized`,
            description: `Box sealed with ${itemCount} units${box.weight ? ` · Weight: ${box.weight} kg` : ''}`,
            user: box.packedByName || box.packedBy || 'Packing Station',
            badge: `Box #${box.boxNo}`,
            badgeColor: 'bg-amber-50 text-amber-700 border-amber-200',
          });
        }

        // Box quantity audit events
        if (Array.isArray(box.auditLog)) {
          box.auditLog.forEach((audit, idx) => {
            if (audit.completedAt) {
              events.push({
                id: `evt-audit-${box.boxNo}-${idx}`,
                timestamp: new Date(audit.completedAt).getTime(),
                type: 'audit',
                title: `Quantity Adjustment in Box #${box.boxNo}`,
                description: `${audit.internalSku || audit.skuId || 'SKU'}: ${audit.actionType === 'edit' ? `${audit.previousQuantity} → ${audit.updatedQuantity}` : `-${audit.quantity}`} (${audit.reasonLabel || audit.reason || 'Variance adjustment'})`,
                user: audit.removedByName || audit.userName || 'Supervisor',
                badge: 'Adjustment',
                badgeColor: 'bg-rose-50 text-rose-700 border-rose-200',
              });
            }
          });
        }
      });
    }

    // 4. Video Proof Uploads
    if (Array.isArray(consignment.videos)) {
      consignment.videos.forEach((vid) => {
        if (vid.uploadedAt) {
          events.push({
            id: `evt-vid-${vid.id}`,
            timestamp: new Date(vid.uploadedAt).getTime(),
            type: 'video',
            title: 'Surveillance Video Attached',
            description: `Box #${vid.boxNo || '—'}: "${vid.originalName}" (${vid.size ? `${(vid.size / 1024 / 1024).toFixed(1)} MB` : 'Stream recorded'})`,
            user: vid.uploadedByName || 'CCTV Station',
            badge: 'Video Proof',
            badgeColor: 'bg-indigo-50 text-indigo-700 border-indigo-200',
          });
        }
      });
    }

    // 5. Document Uploads
    if (Array.isArray(consignment.documents)) {
      consignment.documents.forEach((doc) => {
        if (doc.uploadedAt) {
          events.push({
            id: `evt-doc-${doc.id}`,
            timestamp: new Date(doc.uploadedAt).getTime(),
            type: 'document',
            title: `Document Uploaded: ${doc.originalName}`,
            description: `Type: ${doc.purpose || 'Shipment Document'} (${doc.size ? `${(doc.size / 1024).toFixed(1)} KB` : 'Cloud Vault'})`,
            user: doc.uploadedByName || 'Operations Team',
            badge: doc.purpose === 'invoice' ? 'Invoice Doc' : doc.purpose === 'docket' ? 'Docket Doc' : 'Document',
            badgeColor: 'bg-emerald-50 text-emerald-700 border-emerald-200',
          });
        }
      });
    }

    // 6. Marketplace Dispute Ticket
    if (consignment.marketplaceTicketId) {
      events.push({
        id: 'evt-dispute-ticket',
        timestamp: consignment.updatedAt ? new Date(consignment.updatedAt).getTime() : Date.now(),
        type: 'dispute',
        title: 'Marketplace Claim / Dispute Logged',
        description: `Ticket Reference: ${consignment.marketplaceTicketId}`,
        user: 'Marketplace Operations',
        badge: 'Claim Filed',
        badgeColor: 'bg-red-50 text-red-700 border-red-200',
      });
    }

    return events.sort((a, b) => b.timestamp - a.timestamp);
  }, [consignment]);

  useEffect(() => {
    fetchConsignment();
  }, [id]);

  // Keep SKU tab aligned with active packing session while consignment is in progress
  useEffect(() => {
    if (!id || !consignment) return undefined;
    const inProgress = ['in_progress', 'pending'].includes(consignment.status);
    if (!inProgress && !consignment.liveSessionActive) return undefined;
    const timer = setInterval(() => {
      loadConsignmentWithLiveSession(id, { withSyncStatus: true })
        .then((merged) => setConsignment(merged))
        .catch(() => {});
    }, 15000);
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

  const _downloadOmsGuruTemplate = async () => {
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

  const _handleOmsGuruImport = async (event) => {
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

  const saveBoxRename = async () => {
    if (!boxRename?.boxNo) return;
    const newBoxNo = String(boxRename.newBoxNo || '').trim();
    if (!/^\d+$/.test(newBoxNo)) {
      addToast('New box number must contain digits only (e.g. 4)', 'error');
      return;
    }
    setBoxRenameSaving(true);
    try {
      const { data } = await consignmentsAPI.renameBox(id, boxRename.boxNo, {
        new_box_no: newBoxNo,
        reason: boxRename.reason,
        remarks: boxRename.remarks || '',
      });
      const parts = [`Box ${data.oldBoxNo} renamed to Box ${data.newBoxNo}`];
      if (data.videosUpdated) parts.push(`${data.videosUpdated} video${data.videosUpdated === 1 ? '' : 's'}`);
      if (data.scanEventsUpdated) parts.push(`${data.scanEventsUpdated} scan${data.scanEventsUpdated === 1 ? '' : 's'}`);
      if (data.adjustmentsUpdated) parts.push(`${data.adjustmentsUpdated} history entr${data.adjustmentsUpdated === 1 ? 'y' : 'ies'}`);
      addToast(parts.join(' · '), 'success', 5000);
      setBoxRename(null);
      await fetchConsignment({ silent: true });
    } catch (error) {
      addToast(error.response?.data?.error || 'Box rename failed', 'error');
    } finally {
      setBoxRenameSaving(false);
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

  // Push box-wise packing data to the Consignment Master sheet (columns I and J).
  const handleSheetPush = async () => {
    if (sheetPushing) return;
    setSheetPushing(true);
    setSheetPushResult(null);
    try {
      const { data } = await consignmentsAPI.sheetPush(id);
      setSheetPushResult(data);
      const unmatched = (data.unmatchedSkus || []).length;
      addToast(
        `Pushed to sheet — ${data.updated || 0} row(s) updated`
          + (data.cleared ? `, ${data.cleared} cleared` : '')
          + (unmatched ? `, ${unmatched} SKU(s) not in sheet` : ''),
        unmatched ? 'warning' : 'success'
      );
      await fetchConsignment({ silent: true });
    } catch (err) {
      const data = err?.response?.data || {};
      setSheetPushResult({ ok: false, ...data });
      addToast(data.error || 'Push to Google Sheet failed', 'error');
    } finally {
      setSheetPushing(false);
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

    const { escapeHtml: esc, openEscapedPrintWindow } = await import('../utils/printHtml');
    const rowsHtml = sortedBoxes.map((box) => {
      const qty = Number(box.totalQty) || (box.items || []).reduce((s, i) => s + (Number(i.qty) || 0), 0);
      const weightText = box.weight != null ? `${Number(box.weight).toFixed(2)} ${box.weightUnit || weightUnit}` : '—';
      return `<tr>
        <td>${esc(box.boxNo)}</td>
        <td class="num">${qty}</td>
        <td class="num">${esc(weightText)}</td>
      </tr>`;
    }).join('');

    const title = `Weight Summary - ${consignment.internalShipmentNo || consignment.id}`;
    const opened = openEscapedPrintWindow(`<!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>${esc(title)}</title>
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
          <div class="sub">VB Exports · Packing Station · ${esc(new Date().toLocaleString())}</div>
          <div class="meta">
            <div><strong>Consignment ID</strong> ${esc(consignment.id)}</div>
            <div><strong>Shipment No</strong> ${esc(consignment.shipmentNo || '—')}</div>
            <div><strong>Internal Shipment</strong> ${esc(consignment.internalShipmentNo || '—')}</div>
            <div><strong>Marketplace</strong> ${esc(consignment.marketplace?.name || '—')}</div>
          </div>
          <div class="totals">
            <div class="tot"><span>Total boxes</span><b>${boxCount}</b></div>
            <div class="tot"><span>Total quantity</span><b>${totalQty}</b></div>
            <div class="tot"><span>Total weight</span><b>${esc(`${Number(totalWeightVal).toFixed(2)} ${weightUnit}`)}</b></div>
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
    if (!opened) {
      addToast('Could not open print window — allow pop-ups and try again', 'warning');
    }
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
      ? ['#', 'Barcode SKU', 'Marketplace SKU', 'Internal SKU', 'Required', 'Pending (to pack)']
      : ['#', 'Barcode SKU', 'Marketplace SKU', 'Internal SKU', 'Required', 'Packed', 'Box wise Qty', 'Box number'];

    const csvRows = [];
    pushCsvRow(headers);
    let totRequired = 0, totPacked = 0, totPending = 0;

    rows.forEach((r, i) => {
      const packedFromBoxes = r.packedFromBoxes || 0;
      const pendingFromBoxes = Math.max(0, (r.required || 0) - packedFromBoxes);
      const barcodeSku = r.marketplaceBarcode || r.barcode || '';
      totRequired += r.required; totPacked += packedFromBoxes; totPending += pendingFromBoxes;
      if (type === 'pending') {
        pushCsvRow([i + 1, barcodeSku, r.marketplaceSku, r.internalSku, r.required, pendingFromBoxes]);
      } else {
        const boxEntries = [], boxNumbers = [];
        pivotData.boxes.forEach(b => {
          const qty = r.boxQtys[b.boxNo] || 0;
          if (qty > 0) { boxEntries.push(qty); boxNumbers.push(b.boxNo); }
        });
        pushCsvRow([
          i + 1, barcodeSku, r.marketplaceSku, r.internalSku,
          r.required, packedFromBoxes, boxEntries.join(','), boxNumbers.join(',')
        ]);
      }
    });

    // Totals row
    if (type === 'pending') {
      pushCsvRow(['', '', '', 'TOTAL', totRequired, totPending]);
    } else {
      pushCsvRow(['', '', '', 'TOTAL', totRequired, totPacked, '', '']);
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

  const downloadBoxLabel = (box) => {
    try {
      downloadShipmentBoxLabelPdf(consignment, box);
      addToast(`Box #${box.boxNo} label downloaded (4 x 6 in PDF)`, 'success');
    } catch (error) {
      console.error('Box label download failed', error);
      addToast('Could not build the label PDF', 'error');
    }
  };

  const downloadAllLabels = () => {
    const boxes = consignment.boxes || [];
    if (boxes.length === 0) { addToast('No boxes to download', 'warning'); return; }
    try {
      const pages = downloadAllShipmentBoxLabelsPdf(consignment);
      addToast(`${boxes.length} box label(s) downloaded - ${pages} page(s), 4 x 6 in PDF`, 'success');
    } catch (error) {
      console.error('Box label download failed', error);
      addToast('Could not build the label PDF', 'error');
    }
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

  // A box can carry more than one video once the operator reopens it to add more qty —
  // the earlier video(s) are kept (not replaced), so group into arrays, not a single pick.
  const videosByBox = (() => {
    const grouped = {};
    (consignment.videos || []).forEach((video) => {
      const box = String(video.boxNo || 'Unassigned');
      if (!grouped[box]) grouped[box] = [];
      grouped[box].push(video);
    });
    Object.values(grouped).forEach((list) => {
      list.sort((a, b) => (Number(a.part) || 1) - (Number(b.part) || 1) || new Date(a.uploadedAt) - new Date(b.uploadedAt));
    });
    return grouped;
  })();

  const videoBoxNumbers = [...new Set([
    ...(consignment.boxes || []).map((b) => String(b.boxNo)),
    ...Object.keys(videosByBox),
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
    <div className="animate-fade-in space-y-6">
      {/* Top Breadcrumb & Identifier */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => navigate('/consignments')}
          className="inline-flex items-center gap-2 text-xs font-semibold text-slate-500 hover:text-slate-800 transition-colors cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Consignments</span>
        </button>
        <span className="text-xs font-mono text-slate-400">
          ID: {consignment.id}
        </span>
      </div>

      {/* Hero Identity Banner */}
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs p-5 lg:p-6 transition-all">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-5">
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center gap-2">
              {consignment.marketplace?.name && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-primary-50 text-primary-700 border border-primary-100">
                  <Tag className="w-3.5 h-3.5" />
                  {consignment.marketplace.name}
                </span>
              )}
              <span className={`px-3 py-1 rounded-full text-xs font-bold ${getStatusColor(consignment.status)}`}>
                {consignment.status?.replace('_', ' ')}
              </span>
              <span className={`px-3 py-1 rounded-full text-xs font-bold ${consignment.shipmentStatus === 'Planned' ? 'bg-slate-100 text-slate-700' : consignment.shipmentStatus === 'Under Packing' ? 'bg-orange-100 text-orange-800' : consignment.shipmentStatus === 'Ready' ? 'bg-emerald-100 text-emerald-800' : consignment.shipmentStatus === 'In Transit' || consignment.shipmentStatus === 'Forwarded' ? 'bg-blue-100 text-blue-800' : consignment.shipmentStatus === 'Inwarded' ? 'bg-slate-200 text-slate-800' : consignment.shipmentStatus === 'Missed' ? 'bg-red-100 text-red-800' : 'bg-slate-100 text-slate-700'}`}>
                {consignment.shipmentStatus || 'Planned'}
              </span>
              {(consignment.inwardDisputes || []).some((d) => d.status === 'open') && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-red-100 text-red-800 border border-red-200 animate-pulse">
                  <AlertTriangle className="w-3.5 h-3.5" /> Inward Issue Pending
                </span>
              )}
              <CriticalityBadge priority={shipmentPriority} size="md" />
            </div>

            <div className="flex flex-wrap items-baseline gap-3">
              <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight flex items-center gap-2">
                <span>{consignment.internalShipmentNo || consignment.id}</span>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(consignment.internalShipmentNo || consignment.id);
                      addToast('Copied ID to clipboard', 'info');
                    } catch {
                      addToast('Failed to copy to clipboard', 'warning');
                    }
                  }}
                  className="p-1 text-slate-400 hover:text-slate-700 rounded-md transition-colors cursor-pointer"
                  title="Copy Consignment ID"
                >
                  <Copy className="w-4 h-4" />
                </button>
              </h1>
              {consignment.warehouse && (
                <span className="text-xs font-semibold text-slate-600 bg-slate-100 px-2.5 py-1 rounded-lg">
                  WH: {consignment.warehouse}
                </span>
              )}
            </div>

            <div className="flex items-center gap-3 text-xs text-slate-500 flex-wrap">
              {consignment.shipmentNo && (
                <span className="bg-slate-50 border border-slate-200 px-2 py-0.5 rounded text-[11px] font-semibold text-slate-700">
                  Consignment No: {consignment.shipmentNo}
                </span>
              )}
              {consignment.pendingExternalId && (
                <span className="text-amber-800 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded text-[11px] font-semibold">
                  Pending official ID
                </span>
              )}
              {(consignment.pendingExternalId || user?.role === 'admin' || user?.role === 'organization_head') && (
                <button
                  type="button"
                  onClick={() => { setShowReassignId(true); setNewConsignmentId(''); }}
                  className="font-bold text-primary-600 hover:text-primary-700 underline cursor-pointer"
                >
                  Assign Official ID
                </button>
              )}
              {consignment.pgEnabled === false && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-red-50 text-red-700 border border-red-200">
                  <Database className="w-3 h-3" /> Legacy Store
                </span>
              )}
            </div>
          </div>

          {/* Quick Action CTAs */}
          <div className="flex flex-wrap items-center gap-3 self-start lg:self-center">
            {consignment.status !== 'completed' && consignment.status !== 'archived' && (
              <button
                type="button"
                onClick={() => navigate(`/packing?consignmentId=${consignment.id}`)}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-primary-600 hover:bg-primary-700 text-white text-xs font-bold shadow-sm hover:shadow-md transition-all cursor-pointer"
              >
                <Package className="w-4 h-4" />
                <span>Open Packing Station</span>
              </button>
            )}
            <button
              type="button"
              onClick={downloadAllLabels}
              className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold shadow-2xs transition-colors cursor-pointer"
              title="Download all 4x6 box labels as PDF"
            >
              <Download className="w-4 h-4" />
              <span>Box Labels (PDF)</span>
            </button>
          </div>
        </div>
      </div>

      {/* 4 Vital KPI Metrics Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Metric 1: Units Progress */}
        <div className={`bg-white rounded-2xl p-4 lg:p-5 shadow-xs border transition-all ${shipmentPriority.level === 'critical' ? 'border-red-200 bg-red-50/20' : 'border-slate-200/80'}`}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Packing Progress</span>
            <span className={`text-sm font-extrabold tabular-nums ${shipmentPriority.level === 'critical' ? 'text-red-700' : 'text-slate-900'}`}>
              {progressPct}%
            </span>
          </div>
          <div className="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden mb-2">
            <div
              className={`${progressBarColor} h-2.5 rounded-full transition-all duration-500`}
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>{consignment.totalPackedQty || 0} / {consignment.totalRequiredQty || 0} packed</span>
            {consignment.totalRequiredQty > consignment.totalPackedQty && (
              <span className="text-amber-700 font-semibold">{consignment.totalRequiredQty - consignment.totalPackedQty} remaining</span>
            )}
          </div>
        </div>

        {/* Metric 2: Boxes & Weights */}
        <div className="bg-white rounded-2xl p-4 lg:p-5 shadow-xs border border-slate-200/80 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Boxes Packed</span>
              <Box className="w-4 h-4 text-primary-500" />
            </div>
            <div className="text-2xl font-extrabold text-slate-900">
              {boxCount} <span className="text-xs font-semibold text-slate-400">Boxes</span>
            </div>
          </div>
          <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
            <span>Weight: <strong className="text-slate-800">{totalWeightVal > 0 ? `${totalWeightVal.toFixed(2)} ${weightUnit}` : 'N/A'}</strong></span>
            <span>Avg: <strong className="text-slate-800">{avgBoxWeight} {weightUnit}</strong></span>
          </div>
        </div>

        {/* Metric 3: Workflow Stage & Assignee */}
        <div className="bg-white rounded-2xl p-4 lg:p-5 shadow-xs border border-slate-200/80 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Active Workflow</span>
              <PackageCheck className="w-4 h-4 text-emerald-500" />
            </div>
            <div className="text-base font-extrabold text-slate-900 truncate">
              {consignment.assignedDepartmentLabel || 'Ground Team'}
            </div>
          </div>
          <div className="pt-2 border-t border-slate-100 text-xs text-slate-500 truncate">
            Pending: <strong className="text-slate-800">{consignment.pendingAction || 'Verification on track'}</strong>
          </div>
        </div>

        {/* Metric 4: Logistics Schedule */}
        <div className="bg-white rounded-2xl p-4 lg:p-5 shadow-xs border border-slate-200/80 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Expected Date</span>
              <Scale className="w-4 h-4 text-indigo-500" />
            </div>
            <div className="text-base font-extrabold text-slate-900">
              {consignment.expectedDate || consignment.appointmentDate || 'Not specified'}
            </div>
          </div>
          <div className="pt-2 border-t border-slate-100 text-xs text-slate-500 truncate">
            {consignment.docketNo ? (
              <span>Docket: <strong className="text-slate-800">{consignment.docketNo}</strong> ({consignment.docketCompany || 'Courier'})</span>
            ) : (
              <span>Status: <strong className="text-slate-800">{consignment.shipmentStatus || 'Planned'}</strong></span>
            )}
          </div>
        </div>
      </div>

      {/* Streamlined Operational Workflow Stepper & Action Center */}
      <ConsignmentWorkflowPanel
        consignment={consignment}
        onUpdated={(next) => setConsignment((prev) => ({ ...prev, ...next }))}
      />

      {/* OMSGuru Checklist */}
      <OmsGuruChecklist consignment={consignment} onToggle={toggleOmsGuru} />

      {/* Shipment Tracking Details - Clean Collapsible Categorized Section */}
      <div className="bg-white rounded-2xl shadow-xs border border-slate-200/80 overflow-hidden transition-all">
        <div
          className="flex items-center justify-between px-5 py-4 cursor-pointer select-none hover:bg-slate-50/70 transition-colors"
          onClick={() => { if (!editingTracking) setTrackingOpen((o) => !o); }}
        >
          <div className="flex items-center gap-3">
            <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider">
              Shipment Tracking & Logistics Details
            </h3>
            {!trackingOpen && (
              <span className="text-[10px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full font-semibold">
                Click to expand
              </span>
            )}
          </div>
          <div className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
            {!editingTracking ? (
              <button
                type="button"
                onClick={openTrackingEdit}
                className="text-xs text-primary-600 hover:text-primary-700 font-bold px-3 py-1 hover:bg-primary-50 rounded-lg transition-colors cursor-pointer"
              >
                Edit Details
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setEditingTracking(false)}
                  className="text-xs text-slate-500 hover:text-slate-700 font-semibold px-2 py-1"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveTracking}
                  disabled={savingTracking}
                  className="text-xs text-white bg-primary-600 hover:bg-primary-700 font-bold px-3.5 py-1.5 rounded-xl shadow-xs transition-colors disabled:opacity-50"
                >
                  {savingTracking ? 'Saving…' : 'Save Changes'}
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={() => setTrackingOpen((o) => !o)}
              className="p-1 text-slate-400 hover:text-slate-600 transition-colors"
            >
              {trackingOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Collapsible body */}
        <div className={`collapsible-content ${trackingOpen ? 'open' : 'closed'}`}>
          <div className="px-5 pb-5">
            {editingTracking ? (
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3 pt-2">
                <div className="col-span-2 md:col-span-4 lg:col-span-5 rounded-lg border border-primary-100 bg-primary-50/50 px-3 py-2 text-[11px] text-primary-900">
                  Consignment No. may repeat across internal shipments — only Internal Shipment No. must stay unique.
                </div>
                {[
                  { label: 'Consignment No.', field: 'shipmentNo', type: 'text' },
                  { label: 'Internal Shipment No. *', field: 'internalShipmentNo', type: 'text' },
                  { label: 'Title / Name', field: 'name', type: 'text' },
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
                    <label className="text-[10px] uppercase font-bold tracking-wider text-slate-500 block mb-1">
                      {item.label}
                    </label>
                    {item.type === 'select' ? (
                      <select
                        value={trackingForm[item.field] || ''}
                        onChange={(e) => setTrackingForm({ ...trackingForm, [item.field]: e.target.value })}
                        className="w-full px-2.5 py-1.5 border border-slate-200 rounded-lg text-xs font-medium focus:ring-2 focus:ring-primary-500 outline-none"
                      >
                        <option value="Planned">Planned</option>
                        <option value="Scheduled">Scheduled</option>
                        <option value="Under Packing">Under Packing</option>
                        <option value="Ready">Ready</option>
                        <option value="In Transit">In Transit</option>
                        <option value="Forwarded">Forwarded</option>
                        <option value="Inwarded">Inwarded</option>
                        <option value="Missed">Missed</option>
                      </select>
                    ) : (
                      <input
                        type={item.type}
                        value={trackingForm[item.field] || ''}
                        onChange={(e) => setTrackingForm({ ...trackingForm, [item.field]: e.target.value })}
                        className="w-full px-2.5 py-1.5 border border-slate-200 rounded-lg text-xs font-medium focus:ring-2 focus:ring-primary-500 outline-none"
                      />
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="grid md:grid-cols-3 gap-4 pt-2">
                {/* Card 1: Logistics & Dates */}
                <div className="bg-slate-50/70 rounded-xl p-4 border border-slate-100 space-y-2.5">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block border-b border-slate-200/60 pb-1">
                    Timeline & Key Dates
                  </span>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <span className="text-slate-400 text-[10px] block">Appointment</span>
                      <span className="font-semibold text-slate-800">{consignment.appointmentDate || '—'}</span>
                    </div>
                    <div>
                      <span className="text-slate-400 text-[10px] block">PO Expiry</span>
                      <span className="font-semibold text-slate-800">{consignment.poExpiryDate || '—'}</span>
                    </div>
                    <div>
                      <span className="text-slate-400 text-[10px] block">Scheduled Dispatch</span>
                      <span className="font-semibold text-slate-800">{consignment.scheduledDispatchDate || '—'}</span>
                    </div>
                    <div>
                      <span className="text-slate-400 text-[10px] block">Actual Dispatch</span>
                      <span className="font-semibold text-slate-800">{consignment.actualDispatchDate || '—'}</span>
                    </div>
                    <div className="col-span-2">
                      <span className="text-slate-400 text-[10px] block">Date of Inward</span>
                      <span className="font-semibold text-slate-800">{consignment.dateOfInward || '—'}</span>
                    </div>
                  </div>
                </div>

                {/* Card 2: Transport & Identifiers */}
                <div className="bg-slate-50/70 rounded-xl p-4 border border-slate-100 space-y-2.5">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block border-b border-slate-200/60 pb-1">
                    Carrier & Documents
                  </span>
                  <div className="space-y-2 text-xs">
                    <div className="flex justify-between">
                      <span className="text-slate-400">Courier:</span>
                      <span className="font-semibold text-slate-800">{consignment.docketCompany || '—'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Docket No:</span>
                      <span className="font-semibold font-mono text-slate-800">{consignment.docketNo || '—'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Forward Invoice:</span>
                      <span className="font-semibold font-mono text-slate-800">{consignment.forwardInvoiceNo || '—'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Ticket ID:</span>
                      <span className="font-semibold font-mono text-slate-800">{consignment.marketplaceTicketId || '—'}</span>
                    </div>
                  </div>
                </div>

                {/* Card 3: Quantities Reconciliation */}
                <div className="bg-slate-50/70 rounded-xl p-4 border border-slate-100 space-y-2.5">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block border-b border-slate-200/60 pb-1">
                    Quantity Reconciliation
                  </span>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <span className="text-slate-400 text-[10px] block">Planned Qty</span>
                      <span className="font-bold text-slate-800">{consignment.totalRequiredQty || 0}</span>
                    </div>
                    <div>
                      <span className="text-slate-400 text-[10px] block">Packed Qty</span>
                      <span className="font-bold text-slate-800">{consignment.totalPackedQty || 0}</span>
                    </div>
                    <div>
                      <span className="text-slate-400 text-[10px] block">Units Shipped</span>
                      <span className="font-semibold text-slate-800">
                        {consignment.unitsShipped != null && consignment.unitsShipped !== '' ? consignment.unitsShipped : '—'}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-400 text-[10px] block">Units Inwarded</span>
                      <span className="font-semibold text-slate-800">
                        {consignment.unitsInwarded != null && consignment.unitsInwarded !== '' ? consignment.unitsInwarded : '—'}
                      </span>
                    </div>
                    <div className="col-span-2 pt-1 border-t border-slate-200/60 flex justify-between items-center">
                      <span className="text-slate-500 font-medium">Inward Variance:</span>
                      <span className={`font-bold ${((consignment.totalRequiredQty || 0) - (consignment.unitsInwarded || 0)) > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                        {consignment.unitsInwarded != null ? `${(consignment.totalRequiredQty || 0) - (consignment.unitsInwarded || 0)} units` : '—'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>


      {/* Tabs Container */}
      <div className="bg-white rounded-2xl shadow-xs border border-slate-200/80 overflow-hidden">
        {/* Modern Segmented Navigation Bar */}
        <div
          id="consignment-tabs-nav"
          role="tablist"
          aria-label="Consignment Details Navigation"
          className="sticky top-[60px] z-20 bg-white/95 backdrop-blur-xs border-b border-slate-200/80 px-3 sm:px-5 py-2.5 flex items-center gap-2 overflow-x-auto no-scrollbar"
        >
          {[
            { id: 'skus', label: 'SKU Items', subtitle: 'Quantities & Inward', icon: Package, count: consignment.skus?.length || 0 },
            { id: 'boxes', label: 'Boxes', subtitle: 'Weights & Labels', icon: Box, count: consignment.boxes?.length || 0 },
            { id: 'report', label: 'Packing Report', subtitle: 'Matrix & Sheets', icon: FileSpreadsheet, count: pivotData?.rows?.length ? `${pivotData.rows.length}` : 'Report' },
            { id: 'videos', label: 'Videos', subtitle: 'CCTV Proof', icon: Video, count: consignment.videos?.length || 0 },
            { id: 'documents', label: 'Documents', subtitle: 'Invoices & PODs', icon: FileText, count: consignment.documents?.length || 0 },
            { id: 'activity', label: 'Timeline & History', subtitle: 'Audit Log & Events', icon: History, count: timelineEvents.length },
          ].map((tab, idx, arr) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                role="tab"
                aria-selected={isActive}
                id={`tab-${tab.id}`}
                aria-controls={`panel-${tab.id}`}
                tabIndex={isActive ? 0 : -1}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    const next = arr[(idx + 1) % arr.length].id;
                    setActiveTab(next);
                    document.getElementById(`tab-${next}`)?.focus();
                  } else if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    const prev = arr[(idx - 1 + arr.length) % arr.length].id;
                    setActiveTab(prev);
                    document.getElementById(`tab-${prev}`)?.focus();
                  }
                }}
                className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs transition-all whitespace-nowrap cursor-pointer ${
                  isActive
                    ? 'bg-primary-50 text-primary-800 border border-primary-200 shadow-xs font-bold ring-2 ring-primary-100/50'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100/70 border border-transparent font-semibold'
                }`}
              >
                <tab.icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-primary-600' : 'text-slate-400'}`} />
                <div className="flex flex-col text-left">
                  <span className="leading-tight">{tab.label}</span>
                  <span className="text-[10px] text-slate-400 font-normal hidden lg:inline leading-tight">{tab.subtitle}</span>
                </div>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold tabular-nums ml-0.5 ${
                  isActive ? 'bg-primary-100 text-primary-800 border border-primary-200/60' : 'bg-slate-100 text-slate-500'
                }`}>
                  {tab.count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="p-4 lg:p-6">
          {activeTab === 'skus' && (
            <div id="panel-skus" role="tabpanel" aria-labelledby="tab-skus" tabIndex={0} className="space-y-5 outline-hidden">
              {/* Contextual Info & Quick Actions Banner */}
              <div className="rounded-2xl border border-slate-200/80 bg-slate-50/60 p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-xl bg-primary-100/80 text-primary-700 shrink-0">
                    <Package className="w-5 h-5" />
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider">SKU Inventory & Inward Ledger</h4>
                    <p className="text-xs text-slate-500">
                      Track packed quantities, post-pack removals, and warehouse inward counts. Inward counts never alter packed box records.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={downloadInwardTemplate}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-200/80 text-slate-700 rounded-xl text-xs font-bold hover:bg-slate-50 transition-colors shadow-2xs"
                  >
                    <Download className="w-3.5 h-3.5 text-slate-500" />
                    Template
                  </button>
                  <button
                    type="button"
                    onClick={() => inwardFileRef.current?.click()}
                    disabled={inwardUploading}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-emerald-600 text-white rounded-xl text-xs font-bold hover:bg-emerald-700 transition-colors shadow-2xs disabled:opacity-60"
                  >
                    {inwardUploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                    {inwardUploading ? 'Uploading…' : 'Upload Inward'}
                  </button>
                  <input
                    ref={inwardFileRef}
                    type="file"
                    accept=".csv,text/csv"
                    className="hidden"
                    onChange={handleInwardImport}
                  />
                </div>
              </div>

              {/* 5 Summary Metric Cards */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                {[
                  { label: 'Total Required', value: omsGuruSummary.totalRequiredQty, color: 'text-slate-900', note: 'Planned units' },
                  { label: 'Final Packed', value: omsGuruSummary.totalPackedQty, color: 'text-primary-700', note: 'Boxed & confirmed' },
                  {
                    label: 'Fulfillment Rate',
                    value: `${omsGuruSummary.totalRequiredQty > 0 ? Math.min(100, Math.round((omsGuruSummary.totalPackedQty / omsGuruSummary.totalRequiredQty) * 100)) : 0}%`,
                    color: (omsGuruSummary.totalPackedQty >= omsGuruSummary.totalRequiredQty && omsGuruSummary.totalRequiredQty > 0) ? 'text-emerald-700' : 'text-primary-700',
                    note: (omsGuruSummary.totalPackedQty >= omsGuruSummary.totalRequiredQty && omsGuruSummary.totalRequiredQty > 0) ? 'Fully packed' : 'In packing'
                  },
                  { label: 'Total Inward', value: inwardSummary.totalInwardQty, color: 'text-indigo-700', note: 'Warehouse receipt' },
                  {
                    label: 'Inward Mismatches',
                    value: inwardSummary.mismatchCount || 0,
                    color: (inwardSummary.mismatchCount || 0) > 0 ? 'text-amber-600' : 'text-slate-900',
                    note: (inwardSummary.mismatchCount || 0) > 0 ? `${inwardSummary.shortCount || 0} short, ${inwardSummary.excessCount || 0} excess` : 'Zero variance'
                  },
                ].map((item) => (
                  <div key={item.label} className="bg-white rounded-xl p-3.5 border border-slate-200/80 shadow-2xs">
                    <p className="text-[10px] uppercase font-bold tracking-wider text-slate-400 mb-1">{item.label}</p>
                    <p className={`text-xl font-extrabold ${item.color} tabular-nums`}>{item.value}</p>
                    <p className="text-[10px] text-slate-400 mt-1 font-medium">{item.note}</p>
                  </div>
                ))}
              </div>

              {/* Inward Mismatch Alert */}
              {(inwardSummary.mismatchCount || 0) > 0 && (
                <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50/70 p-3.5 text-xs text-amber-900">
                  <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                  <div>
                    <span className="font-bold">Quantity discrepancies identified: </span>
                    <span>
                      {inwardSummary.mismatchCount} SKU(s) show differences between packed and inward quantities ({inwardSummary.shortCount || 0} short/partial, {inwardSummary.excessCount || 0} excess).
                    </span>
                  </div>
                </div>
              )}

              {/* Search & Status Filter Toolbar for SKUs */}
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 bg-slate-50/70 p-2.5 rounded-xl border border-slate-200/80">
                <div className="relative flex-1 min-w-[200px]">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={skuSearch}
                    onChange={(e) => setSkuSearch(e.target.value)}
                    placeholder="Search by barcode, internal SKU, or marketplace SKU..."
                    className="w-full pl-9 pr-8 py-2 text-xs bg-white border border-slate-200 rounded-lg text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                  />
                  {skuSearch && (
                    <button
                      type="button"
                      onClick={() => setSkuSearch('')}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-0.5"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-1.5 overflow-x-auto text-xs no-scrollbar">
                  <button
                    type="button"
                    onClick={() => setSkuStatusFilter('all')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap cursor-pointer ${
                      skuStatusFilter === 'all'
                        ? 'bg-slate-900 text-white shadow-2xs'
                        : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200/80'
                    }`}
                  >
                    All ({consignment.skus?.length || 0})
                  </button>
                  <button
                    type="button"
                    onClick={() => setSkuStatusFilter('packed')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap cursor-pointer ${
                      skuStatusFilter === 'packed'
                        ? 'bg-emerald-600 text-white shadow-2xs'
                        : 'bg-white text-emerald-700 hover:bg-emerald-50 border border-emerald-200/80'
                    }`}
                  >
                    Packed
                  </button>
                  <button
                    type="button"
                    onClick={() => setSkuStatusFilter('pending')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap cursor-pointer ${
                      skuStatusFilter === 'pending'
                        ? 'bg-amber-600 text-white shadow-2xs'
                        : 'bg-white text-amber-700 hover:bg-amber-50 border border-amber-200/80'
                    }`}
                  >
                    Pending
                  </button>
                  {(inwardSummary.mismatchCount || 0) > 0 && (
                    <button
                      type="button"
                      onClick={() => setSkuStatusFilter('mismatch')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap cursor-pointer ${
                        skuStatusFilter === 'mismatch'
                          ? 'bg-red-600 text-white shadow-2xs'
                          : 'bg-white text-red-700 hover:bg-red-50 border border-red-200/80'
                      }`}
                    >
                      Mismatches ({inwardSummary.mismatchCount})
                    </button>
                  )}
                </div>
              </div>

              {/* Quantity Removals History */}
              {packingAdjustments.filter((a) => a.status === 'completed').length > 0 && (
                <div className="rounded-2xl border border-slate-200/80 p-4 bg-slate-50/30">
                  <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wide mb-3 flex items-center gap-2">
                    <History className="w-4 h-4 text-slate-500" /> Quantity Removals & Edit Audit
                  </h4>
                  <div className="overflow-x-auto max-h-48 overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 text-slate-500 uppercase tracking-wider text-[10px]">
                          <th className="py-2 text-left font-bold">Box</th>
                          <th className="py-2 text-left font-bold">SKU</th>
                          <th className="py-2 text-left font-bold">Action</th>
                          <th className="py-2 text-right font-bold">Qty</th>
                          <th className="py-2 text-left font-bold">Reason</th>
                          <th className="py-2 text-left font-bold">Operator & Time</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {packingAdjustments.filter((a) => a.status === 'completed').map((a) => (
                          <tr key={a.id} className="hover:bg-slate-50/60">
                            <td className="py-2 font-mono font-bold text-slate-800">#{a.boxNo}</td>
                            <td className="py-2 font-mono text-slate-700">{a.internalSku || a.skuId}</td>
                            <td className="py-2 capitalize font-medium text-slate-600">{a.actionType}{a.editAction ? ` (${a.editAction})` : ''}</td>
                            <td className="py-2 text-right font-bold tabular-nums text-slate-900">
                              {a.actionType === 'edit'
                                ? `${a.previousQuantity} → ${a.updatedQuantity}`
                                : a.quantity}
                            </td>
                            <td className="py-2 text-slate-600">{a.reasonLabel || a.reason || '—'}</td>
                            <td className="py-2 text-slate-500 text-[11px]">
                              {a.removedByName || a.userName || '—'} · {a.completedAt ? new Date(a.completedAt).toLocaleString() : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* SKU Items Table */}
              <div className="overflow-x-auto rounded-xl border border-slate-200/80">
                <table className="w-full text-left">
                  <thead>
                    <tr className="bg-slate-50/80 border-b border-slate-200/80 text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                      <th className="py-3 px-3">Barcode / Marketplace</th>
                      <th className="py-3 px-3">Internal SKU</th>
                      <th className="py-3 px-3 text-right">Required</th>
                      <th className="py-3 px-3 text-right">Orig Packed</th>
                      <th className="py-3 px-3 text-right">Removed</th>
                      <th className="py-3 px-3 text-right">Final Packed</th>
                      <th className="py-3 px-3">Box Breakdown</th>
                      <th className="py-3 px-3 text-right">Inward Qty</th>
                      <th className="py-3 px-3 text-right">Diff</th>
                      <th className="py-3 px-3">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-xs">
                    {filteredSkus.length > 0 ? (
                      filteredSkus.map((sku) => {
                        const requiredQty = Number(sku.requiredQty) || 0;
                        const packedQty = Number(sku.finalPackedQty ?? sku.packedQty) || 0;
                        const removedQty = Number(sku.postPackRemovedQty) || 0;
                        const originalPacked = sku.originallyPackedQty != null ? Number(sku.originallyPackedQty) : (packedQty + removedQty);
                        const inwardQty = Number(sku.inwardQty) || 0;
                        const diff = Number(sku.quantityDifference ?? (inwardQty - packedQty));
                        const mismatch = sku.inwardMismatch;
                        const barcode = sku.barcode || sku.marketplaceBarcode || '';
                        const boxEntries = Object.entries(sku.boxQuantities || {}).filter(([, qty]) => Number(qty) > 0);

                        return (
                          <tr
                            key={sku.id}
                            className={`hover:bg-slate-50/80 transition-colors ${mismatch ? 'bg-amber-50/40' : ''}`}
                          >
                            <td className="py-3 px-3">
                              <div className="flex items-center gap-1.5 font-mono text-xs text-slate-800">
                                <span>{barcode || '—'}</span>
                                {barcode && (
                                  <button
                                    type="button"
                                    onClick={() => copyText(barcode, 'Barcode')}
                                    className="text-slate-300 hover:text-slate-600 transition-colors p-0.5"
                                    title="Copy Barcode"
                                  >
                                    <Copy className="w-3 h-3" />
                                  </button>
                                )}
                              </div>
                              {sku.marketplaceSku && (
                                <div className="text-[10px] font-mono text-slate-400 truncate max-w-[180px]" title={sku.marketplaceSku}>
                                  {sku.marketplaceSku}
                                </div>
                              )}
                            </td>
                            <td className="py-3 px-3 font-bold text-slate-900">
                              <div className="flex items-center gap-1.5">
                                <span>{sku.internalSku || '—'}</span>
                                {sku.internalSku && (
                                  <button
                                    type="button"
                                    onClick={() => copyText(sku.internalSku, 'Internal SKU')}
                                    className="text-slate-300 hover:text-slate-600 transition-colors p-0.5"
                                    title="Copy SKU"
                                  >
                                    <Copy className="w-3 h-3" />
                                  </button>
                                )}
                              </div>
                            </td>
                            <td className="py-3 px-3 text-right font-semibold text-slate-600 tabular-nums">{requiredQty}</td>
                            <td className="py-3 px-3 text-right text-slate-500 tabular-nums">{originalPacked}</td>
                            <td className={`py-3 px-3 text-right font-bold tabular-nums ${removedQty > 0 ? 'text-red-600' : 'text-slate-400'}`}>
                              {removedQty}
                            </td>
                            <td className="py-3 px-3 text-right font-extrabold text-slate-900 tabular-nums">
                              {packedQty}
                            </td>
                            <td className="py-3 px-3 max-w-[200px]">
                              {boxEntries.length > 0 ? (
                                <div className="flex flex-wrap gap-1">
                                  {boxEntries.map(([boxNo, qty]) => (
                                    <span key={boxNo} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-700 font-mono text-[10px] font-semibold border border-slate-200/60">
                                      <span className="text-slate-400">#</span>{boxNo}:<strong className="text-primary-700">{qty}</strong>
                                    </span>
                                  ))}
                                </div>
                              ) : (
                                <span className="text-slate-300 font-mono text-xs">—</span>
                              )}
                            </td>
                            <td className="py-3 px-3 text-right font-bold text-slate-800 tabular-nums">{inwardQty}</td>
                            <td className="py-3 px-3 text-right">
                              {inwardQty > 0 ? (
                                diff < 0 ? (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-100 text-red-800 border border-red-200 tabular-nums">
                                    {diff} Short
                                  </span>
                                ) : diff > 0 ? (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-200 tabular-nums">
                                    +{diff} Excess
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200">
                                    Match
                                  </span>
                                )
                              ) : (
                                <span className="text-slate-300 font-mono text-xs">—</span>
                              )}
                            </td>
                            <td className="py-3 px-3">
                              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold border ${inwardStatusClass(sku.inwardStatus)}`}>
                                {inwardStatusLabel(sku.inwardStatus)}
                              </span>
                            </td>
                          </tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td colSpan="10" className="py-12 text-center text-slate-400">
                          {skuSearch || skuStatusFilter !== 'all'
                            ? 'No SKUs match your filter criteria'
                            : 'No SKUs registered for this consignment'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Inward Upload History (Admin) */}
              {isAdmin && (
                <div className="rounded-2xl border border-slate-200/80 bg-slate-50/60 p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <History className="w-4 h-4 text-slate-500" />
                    <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Inward Upload History (Admin)</h4>
                  </div>
                  {inwardUploads.length === 0 ? (
                    <p className="text-xs text-slate-500">No inward uploads recorded yet.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-slate-200 text-slate-500 uppercase tracking-wider text-[10px]">
                            <th className="py-2 px-2 text-left font-bold">Uploaded At</th>
                            <th className="py-2 px-2 text-left font-bold">File</th>
                            <th className="py-2 px-2 text-left font-bold">By</th>
                            <th className="py-2 px-2 text-right font-bold">Updated SKUs</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {inwardUploads.map((entry) => (
                            <tr key={entry.id}>
                              <td className="py-2 px-2 font-mono text-slate-600">{entry.createdAt ? new Date(entry.createdAt).toLocaleString() : '—'}</td>
                              <td className="py-2 px-2 font-medium text-slate-800">{entry.fileName || '—'}</td>
                              <td className="py-2 px-2 text-slate-600">{entry.uploadedByName || '—'}</td>
                              <td className="py-2 px-2 text-right font-bold text-slate-900 tabular-nums">{entry.updatedSkuCount ?? 0}</td>
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
            <div id="panel-boxes" role="tabpanel" aria-labelledby="tab-boxes" tabIndex={0} className="space-y-5 outline-hidden">
              {/* Box Summary KPI Banner */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="bg-white rounded-xl p-3.5 border border-slate-200/80 shadow-2xs">
                  <p className="text-[10px] uppercase font-bold tracking-wider text-slate-400 mb-1">Total Boxes</p>
                  <p className="text-xl font-extrabold text-slate-900 tabular-nums">{consignment.boxes?.length || 0}</p>
                  <p className="text-[10px] text-slate-400 mt-1 font-medium">Consignment containers</p>
                </div>
                <div className="bg-white rounded-xl p-3.5 border border-slate-200/80 shadow-2xs">
                  <p className="text-[10px] uppercase font-bold tracking-wider text-slate-400 mb-1">Total Packed Items</p>
                  <p className="text-xl font-extrabold text-primary-700 tabular-nums">{omsGuruSummary.totalPackedQty || 0} units</p>
                  <p className="text-[10px] text-slate-400 mt-1 font-medium">Units securely packed</p>
                </div>
                <div className="bg-white rounded-xl p-3.5 border border-slate-200/80 shadow-2xs">
                  <p className="text-[10px] uppercase font-bold tracking-wider text-slate-400 mb-1">Shipment Weight</p>
                  <p className="text-xl font-extrabold text-indigo-700 tabular-nums">
                    {(consignment.boxes || []).reduce((acc, b) => acc + (Number(b.weight) || 0), 0) > 0
                      ? `${(consignment.boxes || []).reduce((acc, b) => acc + (Number(b.weight) || 0), 0).toFixed(2)} ${consignment.weightUnit || 'KG'}`
                      : (consignment.totalWeight ? `${Number(consignment.totalWeight).toFixed(2)} ${consignment.weightUnit || 'KG'}` : 'Not Recorded')}
                  </p>
                  <p className="text-[10px] text-slate-400 mt-1 font-medium">Recorded scale weight</p>
                </div>
                <div className="bg-white rounded-xl p-3.5 border border-slate-200/80 shadow-2xs">
                  <p className="text-[10px] uppercase font-bold tracking-wider text-slate-400 mb-1">Station Video Proof</p>
                  <p className="text-xl font-extrabold text-slate-900 tabular-nums">
                    {consignment.videos?.length || 0} {(consignment.videos?.length === 1) ? 'video' : 'videos'}
                  </p>
                  <p className="text-[10px] text-slate-400 mt-1 font-medium">CCTV audit recordings</p>
                </div>
              </div>

              {/* Box Actions Toolbar & Search */}
              <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3 bg-slate-50/70 p-3 rounded-2xl border border-slate-200/80">
                <div className="relative flex-1 min-w-[200px]">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={boxSearch}
                    onChange={(e) => setBoxSearch(e.target.value)}
                    placeholder="Search boxes by number or contained SKU..."
                    className="w-full pl-9 pr-8 py-2 text-xs bg-white border border-slate-200 rounded-lg text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                  />
                  {boxSearch && (
                    <button
                      type="button"
                      onClick={() => setBoxSearch('')}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-0.5"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {consignment.boxes?.length > 0 && (
                  <div className="flex items-center gap-2 flex-wrap shrink-0">
                    <button
                      type="button"
                      onClick={printAllLabels}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold transition-colors shadow-2xs cursor-pointer"
                    >
                      <Tag className="w-3.5 h-3.5" /> Print All ({consignment.boxes.length})
                    </button>
                    <button
                      type="button"
                      onClick={downloadAllLabels}
                      title="Download 4x6 in PDF with every box label"
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-xl text-xs font-bold transition-colors shadow-2xs cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5 text-slate-500" /> PDF Labels
                    </button>
                    <button
                      type="button"
                      onClick={printWeightSummary}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold transition-colors shadow-2xs cursor-pointer"
                    >
                      <Scale className="w-3.5 h-3.5" /> Print Weight
                    </button>
                    <button
                      type="button"
                      onClick={downloadWeightReport}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold transition-colors shadow-2xs cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" /> Weight CSV
                    </button>
                  </div>
                )}
              </div>

              {/* Shipment Weight Ledger (Collapsible / Clean) */}
              {consignment.boxes?.length > 0 && (
                <div className="bg-white border border-slate-200/80 rounded-2xl p-4 shadow-2xs">
                  <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-3 flex items-center gap-2">
                    <Scale className="w-4 h-4 text-primary-500" />
                    Shipment Weight Records Ledger
                  </h4>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs border-collapse">
                      <thead>
                        <tr className="border-b border-slate-200 text-slate-500 uppercase tracking-wider text-[10px]">
                          <th className="py-2 px-3 text-left font-bold">Box No</th>
                          <th className="py-2 px-3 text-right font-bold">Weight</th>
                          <th className="py-2 px-3 text-left font-bold">Captured By</th>
                          <th className="py-2 px-3 text-left font-bold">Captured At</th>
                          <th className="py-2 px-3 text-center font-bold">Proof</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {filteredBoxes.map((box) => (
                          <tr key={box.id} className="hover:bg-slate-50/60 transition-colors">
                            <td className="py-2 px-3 font-semibold text-slate-800 font-mono">
                              <span className="inline-flex items-center gap-1.5">
                                Box #{box.boxNo}
                                {canEditBoxQuantities && (
                                  <button
                                    type="button"
                                    title="Correct box number"
                                    onClick={() => setBoxRename({ boxNo: box.boxNo, newBoxNo: '', reason: '', remarks: '' })}
                                    className="text-slate-400 hover:text-primary-600 transition-colors"
                                  >
                                    <Pencil className="w-3 h-3" />
                                  </button>
                                )}
                              </span>
                            </td>
                            <td className="py-2 px-3 text-right font-extrabold text-slate-900 tabular-nums">
                              {box.weight ? `${Number(box.weight).toFixed(2)} ${box.weightUnit || 'KG'}` : '—'}
                            </td>
                            <td className="py-2 px-3 text-slate-600">{box.weightCapturedByName || '—'}</td>
                            <td className="py-2 px-3 text-slate-500 font-mono text-[11px]">
                              {box.weightCapturedAt ? new Date(box.weightCapturedAt).toLocaleString() : '—'}
                            </td>
                            <td className="py-2 px-3 text-center">
                              {box.weightImageId ? (
                                <button
                                  type="button"
                                  onClick={() => openWeightImagePreview(box.weightImageId, box.boxNo)}
                                  className="text-primary-600 hover:text-primary-800 font-bold hover:underline text-xs inline-flex items-center gap-1"
                                >
                                  <Eye className="w-3.5 h-3.5" /> Proof
                                </button>
                              ) : (
                                <span className="text-slate-300">—</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Individual Box Cards */}
              {filteredBoxes.length > 0 ? (
                filteredBoxes.map((box) => (
                  <div key={box.id} className="bg-white border border-slate-200/80 rounded-2xl p-4 sm:p-5 shadow-xs hover:border-slate-300 transition-all">
                    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-4">
                      <div className="flex items-center gap-3">
                        <div className="px-3 py-1 rounded-xl bg-primary-50 text-primary-800 font-extrabold text-sm border border-primary-200/60 flex items-center gap-2">
                          <Box className="w-4 h-4 text-primary-600" />
                          <span>Box #{box.boxNo}</span>
                        </div>
                        {box.liveUnsaved ? (
                          <span className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200">
                            In progress
                          </span>
                        ) : (
                          <span className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200">
                            Saved Box
                          </span>
                        )}
                        <span className="text-xs font-semibold text-slate-500 bg-slate-100 px-2.5 py-0.5 rounded-lg">
                          {box.totalQty} items
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => printBoxLabel(box)}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold transition-colors shadow-2xs cursor-pointer"
                        >
                          <Tag className="w-3.5 h-3.5" /> Print
                        </button>
                        <button
                          type="button"
                          onClick={() => downloadBoxLabel(box)}
                          title="Download 4x6 in PDF"
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-xl text-xs font-bold transition-colors shadow-2xs cursor-pointer"
                        >
                          <Download className="w-3.5 h-3.5 text-slate-500" /> PDF
                        </button>
                        {canEditBoxQuantities && (
                          <button
                            type="button"
                            onClick={() => setBoxRename({ boxNo: box.boxNo, newBoxNo: '', reason: '', remarks: '' })}
                            className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
                            title="Rename Box Number"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Weight Details Strip */}
                    <div className="mb-4 px-3.5 py-2.5 bg-slate-50/80 rounded-xl border border-slate-100 flex flex-wrap items-center justify-between gap-3 text-xs">
                      <div className="flex flex-wrap items-center gap-4 sm:gap-6">
                        <div>
                          <span className="text-slate-400 block text-[10px] uppercase font-bold tracking-wider">Weight</span>
                          <span className="font-extrabold text-slate-900">
                            {box.weight ? `${Number(box.weight).toFixed(2)} ${box.weightUnit || 'KG'}` : 'Not Captured'}
                          </span>
                        </div>
                        {box.weightCapturedByName && (
                          <div>
                            <span className="text-slate-400 block text-[10px] uppercase font-bold tracking-wider">Captured By</span>
                            <span className="text-slate-700 font-semibold">{box.weightCapturedByName}</span>
                          </div>
                        )}
                        {box.weightCapturedAt && (
                          <div>
                            <span className="text-slate-400 block text-[10px] uppercase font-bold tracking-wider">Captured At</span>
                            <span className="text-slate-600 font-mono text-[11px]">
                              {new Date(box.weightCapturedAt).toLocaleString()}
                            </span>
                          </div>
                        )}
                      </div>
                      {box.weightImageId && (
                        <button
                          type="button"
                          onClick={() => openWeightImagePreview(box.weightImageId, box.boxNo)}
                          className="px-3 py-1 bg-white border border-slate-200/80 hover:bg-slate-100 text-slate-700 rounded-lg font-bold shadow-2xs transition-colors text-xs inline-flex items-center gap-1.5 cursor-pointer"
                        >
                          <Eye className="w-3.5 h-3.5 text-primary-600" /> View Proof
                        </button>
                      )}
                    </div>

                    {/* Box Items Table */}
                    {box.items?.length > 0 && (
                      <div className="overflow-x-auto rounded-xl border border-slate-100">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="bg-slate-50/80 border-b border-slate-100 text-[10px] text-slate-500 uppercase font-bold tracking-wider">
                              <th className="text-left py-2 px-3">Internal SKU</th>
                              <th className="text-left py-2 px-3">Marketplace SKU</th>
                              <th className="text-left py-2 px-3">Barcode</th>
                              <th className="text-right py-2 px-3">Quantity</th>
                              {canEditBoxQuantities && <th className="text-right py-2 px-3">Edit</th>}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-50">
                            {box.items.map((item, idx) => (
                              <tr key={`${item.skuId || item.internalSku}-${idx}`} className="hover:bg-slate-50/60">
                                <td className="py-2 px-3 font-bold text-slate-900">{item.internalSku || item.name || '—'}</td>
                                <td className="py-2 px-3 font-mono text-slate-600">{item.marketplaceSku || '—'}</td>
                                <td className="py-2 px-3 font-mono text-slate-500">{item.barcode || item.marketplaceBarcode || '—'}</td>
                                <td className="py-2 px-3 text-right font-extrabold text-slate-900 tabular-nums">{item.qty || 0}</td>
                                {canEditBoxQuantities && (
                                  <td className="py-2 px-3 text-right">
                                    <button
                                      type="button"
                                      className="text-xs font-bold text-primary-600 hover:text-primary-800 hover:underline cursor-pointer"
                                      onClick={() => setBoxEdit({
                                        boxNo: box.boxNo,
                                        skuId: item.skuId,
                                        internalSku: item.internalSku,
                                        qty: item.qty,
                                        reason: '',
                                        remarks: '',
                                      })}
                                    >
                                      Edit
                                    </button>
                                  </td>
                                )}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {/* Box History Audit */}
                    {(box.adjustments || []).filter((a) => a.status === 'completed').length > 0 && (
                      <div className="mt-3 border-t border-slate-100 pt-3">
                        <p className="text-[10px] uppercase font-bold tracking-wider text-slate-400 mb-1.5">Box Change Audit</p>
                        <ul className="space-y-1 text-xs text-slate-600">
                          {(box.adjustments || []).filter((a) => a.status === 'completed').map((a) => (
                            <li key={a.id} className="flex items-center gap-2">
                              <span className="font-semibold capitalize text-slate-800">{a.actionType}</span>
                              <span className="font-mono text-slate-700">{a.internalSku || a.skuId}</span>
                              <span className="font-bold text-slate-900">
                                {a.actionType === 'edit' ? `${a.previousQuantity} → ${a.updatedQuantity}` : a.quantity}
                              </span>
                              <span className="text-slate-400">·</span>
                              <span className="text-slate-500">{a.reasonLabel || a.reason || '—'}</span>
                              <span className="text-slate-400">·</span>
                              <span className="text-slate-400 text-[11px] font-mono">
                                {a.removedByName || a.userName || '—'} ({a.completedAt ? new Date(a.completedAt).toLocaleString() : ''})
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                ))
              ) : (
                boxSearch ? (
                  <div className="text-center py-12 px-4 bg-slate-50/60 rounded-2xl border border-dashed border-slate-200">
                    <Search className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                    <p className="text-sm font-semibold text-slate-700">No boxes match "{boxSearch}"</p>
                    <p className="text-xs text-slate-400 mt-1">Try clearing the search filter to see all consignment containers.</p>
                    <button
                      type="button"
                      onClick={() => setBoxSearch('')}
                      className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 rounded-lg text-xs font-semibold shadow-2xs cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" /> Clear search filter
                    </button>
                  </div>
                ) : (
                  <div className="text-center py-12 px-4 bg-slate-50/50 rounded-2xl border border-dashed border-slate-200">
                    <div className="w-12 h-12 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center mx-auto mb-3 border border-amber-100/80">
                      <Box className="w-6 h-6" />
                    </div>
                    <h4 className="text-sm font-bold text-slate-800">No Boxes Packed Yet</h4>
                    <p className="text-xs text-slate-500 max-w-sm mx-auto mt-1 mb-4">
                      This consignment is ready for packing. Launch the Packing Station to scan barcodes, seal boxes, and print shipping labels.
                    </p>
                    <Link
                      to={`/packing?consignmentId=${consignment.id}`}
                      className="inline-flex items-center gap-2 px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-xl text-xs font-bold transition-all shadow-xs"
                    >
                      <PackageCheck className="w-4 h-4" />
                      <span>Open in Packing Station</span>
                    </Link>
                  </div>
                )
              )}
            </div>
          )}

          {activeTab === 'report' && (
            <div id="panel-report" role="tabpanel" aria-labelledby="tab-report" tabIndex={0} className="space-y-5 outline-hidden">
              {reportLoading && (
                <div className="flex items-center justify-center py-16 text-slate-500">
                  <Loader2 className="w-5 h-5 animate-spin mr-2" />
                  Loading saved-box report...
                </div>
              )}

              {!reportLoading && !pivotData && (
                <div className="text-center py-14 px-4 bg-slate-50/50 rounded-2xl border border-dashed border-slate-200">
                  <div className="w-12 h-12 rounded-2xl bg-slate-100 text-slate-400 flex items-center justify-center mx-auto mb-3">
                    <FileSpreadsheet className="w-6 h-6" />
                  </div>
                  <h4 className="text-sm font-bold text-slate-800">No Packing Breakdown Available</h4>
                  <p className="text-xs text-slate-500 max-w-md mx-auto mt-1 mb-4">
                    The SKU matrix breakdown is computed once items are packed into boxes. Start packing or import box breakdown data to view matrix reports.
                  </p>
                  <button
                    type="button"
                    onClick={fetchPackingReport}
                    className="inline-flex items-center gap-2 px-3.5 py-1.5 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-xl text-xs font-semibold transition-all shadow-2xs cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5 text-slate-400" />
                    <span>Refresh Report Data</span>
                  </button>
                </div>
              )}

              {!reportLoading && pivotData && (
                <div className="space-y-4">
                  {/* Google Sheets Live Sync Banner & Action Card */}
                  <div className="rounded-2xl border border-emerald-200/90 bg-linear-to-r from-emerald-50/70 via-white to-teal-50/40 p-4 sm:p-5 shadow-xs">
                    <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                      <div className="flex items-start gap-3.5">
                        <div className="p-2.5 rounded-xl bg-emerald-100 text-emerald-800 border border-emerald-200 shadow-2xs shrink-0 mt-0.5">
                          <FileSpreadsheet className="w-5 h-5" />
                        </div>
                        <div className="space-y-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-bold text-slate-900">Google Sheets Live Sync</span>
                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100/90 text-emerald-800 border border-emerald-200">
                              <span className="relative flex h-1.5 w-1.5">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-600"></span>
                              </span>
                              Master Sheet
                            </span>
                            {consignment?.internalShipmentNo && (
                              <span className="font-mono text-[10px] font-semibold text-slate-600 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded-md" title="Internal Shipment No. for sheet row lookup">
                                Shipment #{consignment.internalShipmentNo}
                              </span>
                            )}
                          </div>

                          {sheetPushResult && sheetPushResult.ok === false ? (
                            <div className="flex items-center gap-1.5 text-xs text-red-700 font-medium">
                              <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
                              <span>{sheetPushResult.error || 'Push to Google Sheet failed. Please try again.'}</span>
                            </div>
                          ) : sheetPushResult ? (
                            <div className="text-xs text-emerald-800 font-medium">
                              <span className="font-bold text-slate-900">Pushed to Google Sheet just now</span>
                              {' — '}{sheetPushResult.updated || 0} row(s) updated
                              {sheetPushResult.cleared ? `, ${sheetPushResult.cleared} cleared` : ''}
                              {sheetPushResult.skippedMovedRows ? `, ${sheetPushResult.skippedMovedRows} skipped (row moved)` : ''}
                            </div>
                          ) : consignment?.sheetPush?.at ? (
                            <div className="text-xs text-slate-600 flex items-center gap-1.5 flex-wrap">
                              <span className="font-semibold text-slate-800">Last pushed to Google Sheet:</span>
                              <span>{new Date(consignment.sheetPush.at).toLocaleString()}</span>
                              {consignment.sheetPush.trigger === 'scheduled' ? (
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-slate-200/70 text-slate-700">Daily Sync</span>
                              ) : (
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-800">Manual Push</span>
                              )}
                            </div>
                          ) : (
                            <p className="text-xs text-slate-500">
                              Write box-wise quantities and box numbers (columns I &amp; J) directly into the Consignment Master Google Sheet.
                            </p>
                          )}

                          {sheetPushResult?.unmatchedSkus?.length > 0 && (
                            <p className="text-[11px] text-amber-700 font-medium">
                              {sheetPushResult.unmatchedSkus.length} SKU(s) had no matching sheet row:{' '}
                              {sheetPushResult.unmatchedSkus.slice(0, 5).map((s) => s.marketplaceBarcode).join(', ')}
                              {sheetPushResult.unmatchedSkus.length > 5 ? ' …' : ''}
                            </p>
                          )}

                          {!consignment?.internalShipmentNo && (
                            <p className="text-[11px] text-amber-600 font-medium">
                              Notice: Consignment has no Internal Shipment No. Set one in shipment overview to match sheet rows.
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 w-full md:w-auto shrink-0 justify-end">
                        <button
                          type="button"
                          id="btn-push-google-sheet"
                          onClick={handleSheetPush}
                          disabled={sheetPushing || !consignment?.internalShipmentNo}
                          title={!consignment?.internalShipmentNo ? 'Internal Shipment No. is required' : 'Write box-wise quantities and box numbers into the Consignment Master sheet'}
                          className="w-full md:w-auto flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl text-xs font-bold transition-all shadow-xs cursor-pointer"
                        >
                          {sheetPushing ? (
                            <>
                              <Loader2 className="w-4 h-4 animate-spin" />
                              <span>Pushing to Sheet…</span>
                            </>
                          ) : (
                            <>
                              <UploadCloud className="w-4 h-4 text-emerald-100" />
                              <span>{consignment?.sheetPush?.at ? 'Re-push to Google Sheet' : 'Push to Google Sheet'}</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  </div>

                  {pivotData.integrityIssues?.length > 0 && (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
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
                      <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
                        {cards.map(c => (
                          <div key={c.label} className="bg-slate-50 rounded-xl border border-slate-200/80 px-3 py-2.5 text-center shadow-2xs">
                            <p className={`text-lg font-bold ${c.color}`}>{c.value}</p>
                            <p className="text-[10px] uppercase tracking-wider text-slate-400 font-medium">{c.label}</p>
                          </div>
                        ))}
                      </div>
                    );
                  })()}

                  {/* Box-wise Packing Breakdown Toolbar */}
                  <div className="bg-slate-50/80 p-3.5 rounded-2xl border border-slate-200/80 flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div>
                        <h3 className="text-sm font-bold text-slate-900">Box-wise Packing Breakdown</h3>
                        <p className="text-[11px] text-slate-500 font-medium">Cross-tabulated box contents and fulfillment status</p>
                      </div>
                      <div className="hidden sm:flex items-center gap-1.5 ml-2 flex-wrap">
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200">
                          {pivotData.summary.completeSkuCount || 0} complete
                        </span>
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-primary-100 text-primary-800 border border-primary-200">
                          {pivotData.summary.packedSkuCount || 0} packed
                        </span>
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-200">
                          {pivotData.summary.pendingSkuCount || 0} pending
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 flex-wrap justify-end">
                      <div className="flex items-center rounded-lg border border-slate-200 bg-white overflow-hidden text-xs font-semibold shadow-2xs">
                        <button
                          type="button"
                          onClick={() => setReportView('compact')}
                          title="One row per SKU, box quantities shown as a compact list"
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 transition-colors ${reportView === 'compact' ? 'bg-primary-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
                        >
                          <LayoutList className="w-3.5 h-3.5" /> Compact
                        </button>
                        <button
                          type="button"
                          onClick={() => setReportView('grid')}
                          title={`Full matrix — one column per box (${pivotData.boxes.length})`}
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 transition-colors border-l border-slate-200 ${reportView === 'grid' ? 'bg-primary-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
                        >
                          <LayoutGrid className="w-3.5 h-3.5" /> Grid
                        </button>
                      </div>
                      <button onClick={() => exportCsv('packed')} className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-medium hover:bg-emerald-700 transition-colors shadow-2xs cursor-pointer">
                        <FileSpreadsheet className="w-3.5 h-3.5" />Export Packed
                      </button>
                      <button onClick={() => exportCsv('pending')} className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 text-white rounded-lg text-xs font-medium hover:bg-amber-600 transition-colors shadow-2xs cursor-pointer">
                        <FileSpreadsheet className="w-3.5 h-3.5" />Export Pending
                      </button>
                      <button
                        type="button"
                        onClick={handleSheetPush}
                        disabled={sheetPushing || !consignment?.internalShipmentNo}
                        title="Write box-wise quantities and box numbers into the Consignment Master sheet"
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 text-white rounded-lg text-xs font-medium hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-2xs cursor-pointer"
                      >
                        {sheetPushing ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <UploadCloud className="w-3.5 h-3.5 text-slate-300" />
                        )}
                        <span>{sheetPushing ? 'Pushing…' : 'Push to Sheet'}</span>
                      </button>
                    </div>
                  </div>

              {reportView === 'compact' && (
                <div className="overflow-x-auto max-h-[600px] overflow-y-auto rounded-xl border border-slate-200">
                  <table className="w-full text-sm border-collapse">
                    <thead className="sticky top-0 z-10 bg-slate-100 shadow-2xs">
                      <tr className="bg-slate-100">
                        <th className="text-left px-3 py-2 text-[10px] font-semibold text-slate-500 uppercase tracking-wide border-b border-slate-200 whitespace-nowrap">#</th>
                        <th className="text-left px-3 py-2 text-[10px] font-semibold text-slate-500 uppercase tracking-wide border-b border-slate-200 whitespace-nowrap">Barcode SKU</th>
                        <th className="text-left px-3 py-2 text-[10px] font-semibold text-slate-500 uppercase tracking-wide border-b border-slate-200 whitespace-nowrap">Marketplace SKU</th>
                        <th className="text-left px-3 py-2 text-[10px] font-semibold text-slate-500 uppercase tracking-wide border-b border-r border-slate-200 whitespace-nowrap">Internal SKU</th>
                        <th className="text-center px-3 py-2 text-[10px] font-semibold text-slate-600 uppercase tracking-wide border-b border-slate-200 whitespace-nowrap bg-slate-50">Required</th>
                        <th className="text-center px-3 py-2 text-[10px] font-semibold text-slate-600 uppercase tracking-wide border-b border-slate-200 whitespace-nowrap bg-slate-50">Packed</th>
                        <th className="text-center px-3 py-2 text-[10px] font-semibold text-slate-600 uppercase tracking-wide border-b border-r border-slate-200 whitespace-nowrap bg-slate-50">Remaining</th>
                        <th className="text-left px-3 py-2 text-[10px] font-semibold text-slate-600 uppercase tracking-wide border-b border-slate-200 whitespace-nowrap bg-slate-50">Packed In</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {pivotData.rows.map((row, idx) => {
                        const barcodeSku = row.marketplaceBarcode || row.barcode || '';
                        const packedIn = Object.entries(row.boxQtys || {})
                          .filter(([, qty]) => qty > 0)
                          .sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }));
                        return (
                          <tr key={row.skuId} className={`${row.remaining === 0 ? 'bg-emerald-50/40' : row.remaining < 0 ? 'bg-red-50/40' : 'bg-white'} hover:bg-slate-50/80`}>
                            <td className="px-3 py-2.5 text-xs text-slate-400">{idx + 1}</td>
                            <td className="px-3 py-2.5 font-mono text-xs text-slate-800 max-w-[200px] truncate" title={barcodeSku || '—'}>
                              {barcodeSku || '—'}
                              {row.marketplaceBarcodeType ? (
                                <span className="ml-1 text-[9px] font-semibold uppercase text-slate-400">{row.marketplaceBarcodeType}</span>
                              ) : null}
                            </td>
                            <td className="px-3 py-2.5 font-mono text-xs text-slate-700 max-w-[180px] truncate" title={row.marketplaceSku}>{row.marketplaceSku}</td>
                            <td className="px-3 py-2.5 font-medium text-slate-900 text-xs border-r border-slate-100 max-w-[160px] truncate" title={row.internalSku}>{row.internalSku}</td>
                            <td className="px-3 py-2.5 text-center font-semibold text-slate-700 text-xs bg-slate-50/40">{row.required}</td>
                            <td className="px-3 py-2.5 text-center font-semibold text-emerald-700 text-xs bg-slate-50/40">{row.packedFromBoxes || 0}</td>
                            <td className="px-3 py-2.5 text-center font-bold text-xs border-r border-slate-100 bg-slate-50/40">
                              {row.remaining === 0 ? (
                                <span className="inline-flex items-center gap-1 text-emerald-600"><CheckCircle2 className="w-3.5 h-3.5" />0</span>
                              ) : row.remaining < 0 ? (
                                <span className="inline-flex items-center gap-1 text-red-600"><AlertCircle className="w-3.5 h-3.5" />{row.remaining}</span>
                              ) : (
                                <span className="text-amber-600">{row.remaining}</span>
                              )}
                            </td>
                            <td className="px-3 py-2.5">
                              {packedIn.length > 0 ? (
                                <div className="flex flex-wrap gap-1">
                                  {packedIn.map(([boxNo, qty]) => (
                                    <span key={boxNo} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-primary-50 text-primary-800 text-[10px] font-mono font-semibold whitespace-nowrap">
                                      #{boxNo}<span className="text-primary-400">·</span>{qty}
                                    </span>
                                  ))}
                                </div>
                              ) : (
                                <span className="text-slate-300 text-xs">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {reportView === 'grid' && (
                <div className="overflow-x-auto max-h-[600px] overflow-y-auto rounded-xl border border-slate-200">
                  <table className="w-full text-sm border-collapse">
                  <thead>
                    {/* Group headers */}
                    <tr>
                      <th
                        colSpan={4}
                        className="sticky top-0 z-20 bg-slate-800 text-white text-left px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider border-r border-slate-600"
                      >
                        SKU Details
                      </th>
                      <th
                        colSpan={3}
                        className="sticky top-0 z-20 bg-slate-700 text-white text-center px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider border-r border-slate-500"
                      >
                        Qty Reporting
                      </th>
                      <th
                        colSpan={Math.max(pivotData.boxes.length, 1)}
                        className="sticky top-0 z-20 bg-primary-600 text-white text-center px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider border-r border-primary-500"
                      >
                        Box Quantities ({pivotData.boxes.length})
                      </th>
                      <th className="sticky top-0 z-20 bg-slate-800 text-white text-center px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider">
                        Total
                      </th>
                    </tr>
                    {/* Sub headers */}
                    <tr className="bg-slate-100">
                      <th className="text-left px-3 py-2 text-[10px] font-semibold text-slate-500 uppercase tracking-wide border-b border-slate-200 whitespace-nowrap">#</th>
                      <th className="text-left px-3 py-2 text-[10px] font-semibold text-slate-500 uppercase tracking-wide border-b border-slate-200 whitespace-nowrap">Barcode SKU</th>
                      <th className="text-left px-3 py-2 text-[10px] font-semibold text-slate-500 uppercase tracking-wide border-b border-slate-200 whitespace-nowrap">Marketplace SKU</th>
                      <th className="text-left px-3 py-2 text-[10px] font-semibold text-slate-500 uppercase tracking-wide border-b border-r border-slate-200 whitespace-nowrap">Internal SKU</th>
                      <th className="text-center px-3 py-2 text-[10px] font-semibold text-slate-600 uppercase tracking-wide border-b border-slate-200 whitespace-nowrap bg-slate-50">Required</th>
                      <th className="text-center px-3 py-2 text-[10px] font-semibold text-slate-600 uppercase tracking-wide border-b border-slate-200 whitespace-nowrap bg-slate-50">Packed</th>
                      <th className="text-center px-3 py-2 text-[10px] font-semibold text-slate-600 uppercase tracking-wide border-b border-r border-slate-200 whitespace-nowrap bg-slate-50">Remaining</th>
                      {pivotData.boxes.length > 0 ? pivotData.boxes.map((b) => (
                        <th
                          key={b.boxNo}
                          className="text-center px-2.5 py-2 text-[10px] font-semibold text-primary-800 uppercase tracking-wide border-b border-r border-primary-100 whitespace-nowrap bg-primary-50"
                          title={`Box ${b.boxNo}`}
                        >
                          #{b.boxNo}
                        </th>
                      )) : (
                        <th className="text-center px-3 py-2 text-[10px] font-semibold text-slate-400 uppercase tracking-wide border-b border-slate-200">—</th>
                      )}
                      <th className="text-center px-3 py-2 text-[10px] font-semibold text-slate-600 uppercase tracking-wide border-b border-slate-200 whitespace-nowrap bg-slate-50">In Boxes</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {pivotData.rows.map((row, idx) => {
                      const barcodeSku = row.marketplaceBarcode || row.barcode || '';
                      return (
                      <tr key={row.skuId} className={`${row.remaining === 0 ? 'bg-emerald-50/40' : row.remaining < 0 ? 'bg-red-50/40' : 'bg-white'} hover:bg-slate-50/80`}>
                        <td className="px-3 py-2.5 text-xs text-slate-400">{idx + 1}</td>
                        <td className="px-3 py-2.5 font-mono text-xs text-slate-800 max-w-[200px] truncate" title={barcodeSku || '—'}>
                          {barcodeSku || '—'}
                          {row.marketplaceBarcodeType ? (
                            <span className="ml-1 text-[9px] font-semibold uppercase text-slate-400">{row.marketplaceBarcodeType}</span>
                          ) : null}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-xs text-slate-700 max-w-[180px] truncate" title={row.marketplaceSku}>{row.marketplaceSku}</td>
                        <td className="px-3 py-2.5 font-medium text-slate-900 text-xs border-r border-slate-100 max-w-[160px] truncate" title={row.internalSku}>{row.internalSku}</td>
                        <td className="px-3 py-2.5 text-center font-semibold text-slate-700 text-xs bg-slate-50/40">{row.required}</td>
                        <td className="px-3 py-2.5 text-center font-semibold text-emerald-700 text-xs bg-slate-50/40">{row.packedFromBoxes || 0}</td>
                        <td className="px-3 py-2.5 text-center font-bold text-xs border-r border-slate-100 bg-slate-50/40">
                          {row.remaining === 0 ? (
                            <span className="inline-flex items-center gap-1 text-emerald-600"><CheckCircle2 className="w-3.5 h-3.5" />0</span>
                          ) : row.remaining < 0 ? (
                            <span className="inline-flex items-center gap-1 text-red-600"><AlertCircle className="w-3.5 h-3.5" />{row.remaining}</span>
                          ) : (
                            <span className="text-amber-600">{row.remaining}</span>
                          )}
                        </td>
                        {pivotData.boxes.map((b) => {
                          const qty = row.boxQtys[b.boxNo] || 0;
                          return (
                            <td
                              key={b.boxNo}
                              className={`px-2.5 py-2.5 text-center font-mono text-xs border-r border-slate-50 ${qty > 0 ? 'bg-primary-50 text-primary-800 font-bold' : 'text-slate-300'}`}
                            >
                              {qty > 0 ? qty : '·'}
                            </td>
                          );
                        })}
                        <td className="px-3 py-2.5 text-center font-bold text-slate-900 text-xs bg-slate-50/60">{row.totalInBoxes || row.packedFromBoxes || 0}</td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              )}
            </div>
          )}
        </div>
      )}

          {activeTab === 'videos' && (
            <div id="panel-videos" role="tabpanel" aria-labelledby="tab-videos" tabIndex={0} className="space-y-6 outline-hidden">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-4">
                <h3 className="text-lg font-semibold text-slate-900">Box-wise Videos</h3>
                <div className="flex items-center gap-2 flex-wrap justify-end">
                  {consignment.videos?.length > 0 && (
                    <button onClick={() => {
                      const headers = ['Box No', 'Part', 'File Name', 'Video URL', 'Size (KB)', 'Uploaded At'];
                      const csvRows = [headers.join(',')];
                      consignment.videos.forEach(v => {
                        csvRows.push([v.boxNo || 'Unassigned', v.boxLabel || (v.boxNo ? `BOX${v.boxNo}` : ''), `"${v.originalName}"`, buildUploadStreamUrl(v.id, 'video') || '', Math.round((v.size || 0) / 1024), new Date(v.uploadedAt).toLocaleString()].join(','));
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
                    const boxVideos = videosByBox[boxNo] || [];
                    return (
                      <button
                        key={boxNo}
                        type="button"
                        onClick={() => setSelectedVideoBox(boxNo)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                          selectedVideoBox === boxNo
                            ? 'bg-primary-600 text-white border-primary-600'
                            : boxVideos.length > 0
                              ? 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                              : 'bg-slate-50 text-slate-400 border-slate-100'
                        }`}
                      >
                        Box #{boxNo}{boxVideos.length > 1 ? ` (${boxVideos.length} videos)` : boxVideos.length === 0 ? ' (no video)' : ''}
                      </button>
                    );
                  })}
                </div>
              )}

              {visibleVideoBoxes.length > 0 ? (
                <div className="space-y-6">
                  {visibleVideoBoxes.map((boxNo) => {
                    const boxVideos = videosByBox[boxNo] || [];
                    return (
                      <div key={boxNo} className="rounded-xl border border-slate-200 bg-slate-50/40 p-4">
                        <div className="flex items-center gap-2 mb-3">
                          <Box className="w-4 h-4 text-primary-600" />
                          <h4 className="text-sm font-bold text-slate-900">Box #{boxNo}</h4>
                          {boxVideos.length > 0 ? (
                            <span className="text-xs text-emerald-600 font-medium">
                              {boxVideos.length > 1 ? `${boxVideos.length} videos available` : 'Video available'}
                            </span>
                          ) : (
                            <span className="text-xs text-slate-400">No video uploaded yet</span>
                          )}
                        </div>
                        {boxVideos.length > 0 ? (
                          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                            {boxVideos.map((video) => (
                              <VideoFileCard
                                key={video.id}
                                video={video}
                                boxNo={boxNo}
                                addToast={addToast}
                                canDelete={canDeleteVideos}
                                onDelete={() => setDeleteFile({ id: video.id, type: 'video', name: video.originalName })}
                              />
                            ))}
                          </div>
                        ) : (
                          <p className="text-sm text-slate-500">Select this box in the upload dropdown above to attach a packing video.</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-12 px-4 rounded-xl border border-dashed border-slate-200 bg-slate-50/50">
                  <div className="w-12 h-12 rounded-2xl bg-slate-100 text-slate-400 flex items-center justify-center mx-auto mb-3">
                    <Video className="w-6 h-6" />
                  </div>
                  <h4 className="text-sm font-bold text-slate-800">No box packing videos yet</h4>
                  <p className="text-xs text-slate-500 max-w-md mx-auto mt-1">
                    Once boxes are packed at the packing station with camera recording active, surveillance recordings will be archived here per box.
                  </p>
                </div>
              )}
            </div>
          )}

          {activeTab === 'documents' && (
            <div id="panel-documents" role="tabpanel" aria-labelledby="tab-documents" tabIndex={0} className="space-y-6 outline-hidden">
              {/* Documents KPI & Summary Strip */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="bg-slate-50/80 rounded-xl p-3 border border-slate-200/80">
                  <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Total Documents</span>
                  <div className="text-xl font-bold font-mono text-slate-900 mt-1">
                    {consignment.documents?.length || 0}
                  </div>
                  <span className="text-[11px] text-slate-500">Audit &amp; legal files</span>
                </div>
                <div className="bg-slate-50/80 rounded-xl p-3 border border-slate-200/80">
                  <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Invoice File</span>
                  <div className="text-sm font-bold text-slate-900 mt-1.5 flex items-center gap-1.5 truncate">
                    {consignment.invoiceDocumentId ? (
                      <span className="text-emerald-700 bg-emerald-100/80 px-2 py-0.5 rounded-md text-xs font-semibold">Attached</span>
                    ) : consignment.forwardInvoiceNo || consignment.invoice?.number ? (
                      <span className="text-amber-800 bg-amber-100/80 px-2 py-0.5 rounded-md text-xs font-semibold font-mono">No. Recorded</span>
                    ) : (
                      <span className="text-slate-500 bg-slate-200/60 px-2 py-0.5 rounded-md text-xs font-semibold">Pending</span>
                    )}
                  </div>
                  <span className="text-[11px] text-slate-500">Commercial billing</span>
                </div>
                <div className="bg-slate-50/80 rounded-xl p-3 border border-slate-200/80">
                  <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Docket / LR</span>
                  <div className="text-sm font-bold text-slate-900 mt-1.5 flex items-center gap-1.5 truncate">
                    {consignment.docketNo ? (
                      <span className="font-mono text-xs text-indigo-700 bg-indigo-50 border border-indigo-200 px-2 py-0.5 rounded-md truncate max-w-[130px]">
                        {consignment.docketNo}
                      </span>
                    ) : (
                      <span className="text-slate-500 bg-slate-200/60 px-2 py-0.5 rounded-md text-xs font-semibold">Not Assigned</span>
                    )}
                  </div>
                  <span className="text-[11px] text-slate-500">Transport manifest</span>
                </div>
                <div className="bg-slate-50/80 rounded-xl p-3 border border-slate-200/80">
                  <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Cloud Storage</span>
                  <div className="text-sm font-bold text-slate-900 mt-1.5 flex items-center gap-1 text-teal-700">
                    <CheckCircle2 className="w-3.5 h-3.5 text-teal-600 shrink-0" />
                    <span>Cloudflare R2</span>
                  </div>
                  <span className="text-[11px] text-slate-500">Immutable object vault</span>
                </div>
              </div>

              {consignment?.stageConfirmations?.packing_completed?.confirmedAt && !consignment?.stageConfirmations?.invoice_created?.confirmedAt && (
                <div className="rounded-xl border border-amber-200 bg-amber-50/40 p-4">
                  <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-2">
                    <div>
                      <h3 className="text-sm font-bold text-slate-900">Invoice upload (optional)</h3>
                      <p className="text-xs text-slate-600 mt-0.5">
                        Document upload is optional. Confirm Invoice completed with invoice number, date, and amount in the workflow panel.
                      </p>
                    </div>
                    <label className="flex items-center gap-2 px-3 py-2 bg-slate-900 text-white rounded-lg hover:bg-slate-800 cursor-pointer transition-colors text-xs font-semibold">
                      <Upload className="w-3.5 h-3.5" />
                      {uploading ? 'Uploading…' : 'Upload invoice'}
                      <input
                        type="file"
                        accept=".pdf,.doc,.docx,.xlsx,.xls,.csv,.png,.jpg,.jpeg"
                        className="hidden"
                        onChange={async (e) => {
                          const file = e.target.files?.[0]
                          if (!file) return
                          try {
                            setUploading(true)
                            await uploadFileToStorage(file, id, 'document', '', undefined, {
                              purpose: 'invoice',
                              description: 'Forward invoice',
                            })
                            addToast('Invoice document uploaded', 'success')
                            fetchConsignment({ silent: true })
                          } catch (error) {
                            addToast('Invoice upload failed: ' + (error.response?.data?.error || error.message || 'Unknown error'), 'error')
                          } finally {
                            setUploading(false)
                            e.target.value = ''
                          }
                        }}
                        disabled={uploading}
                      />
                    </label>
                  </div>
                  {consignment.invoiceDocumentId ? (
                    <p className="text-xs text-emerald-700 font-medium">
                      Invoice document attached
                      {consignment.forwardInvoiceNo ? ` · ${consignment.forwardInvoiceNo}` : ''}
                    </p>
                  ) : (
                    <p className="text-xs text-slate-600">No invoice document on file — optional for this stage.</p>
                  )}
                </div>
              )}

              {consignment?.invoice && (
                <div className="rounded-xl border border-slate-200 bg-white p-3.5 text-xs grid sm:grid-cols-3 gap-3 shadow-2xs">
                  <div>
                    <div className="text-[10px] uppercase text-slate-500 font-semibold tracking-wider">Invoice Number</div>
                    <div className="font-bold font-mono text-slate-900 mt-1">{consignment.invoice.number || consignment.forwardInvoiceNo || '—'}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase text-slate-500 font-semibold tracking-wider">Invoice Date</div>
                    <div className="font-semibold text-slate-900 mt-1">{consignment.invoice.date || '—'}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase text-slate-500 font-semibold tracking-wider">Invoice Amount</div>
                    <div className="font-bold font-mono text-slate-900 mt-1">{consignment.invoice.amount != null ? `₹${Number(consignment.invoice.amount).toLocaleString('en-IN')}` : '—'}</div>
                  </div>
                </div>
              )}

              <div>
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-4">
                  <div>
                    <h3 className="text-lg font-semibold text-slate-900">Shipment Documents &amp; Evidence</h3>
                    <p className="text-xs text-slate-500 mt-0.5">Carrier dockets, tax invoices, shipping manifests, and delivery PODs</p>
                  </div>
                  <label className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 cursor-pointer transition-colors text-xs font-semibold shadow-xs">
                    {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                    <span>{uploading ? 'Uploading...' : 'Upload Document'}</span>
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
                      <div key={doc.id} className="flex items-center justify-between p-4 border border-slate-200 rounded-xl bg-white hover:border-slate-300 hover:shadow-xs transition-all">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-10 h-10 rounded-xl bg-primary-50 text-primary-600 flex items-center justify-center shrink-0 border border-primary-100/60">
                            <FileText className="w-5 h-5" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-slate-900 truncate">
                              {doc.originalName}
                              {doc.purpose === 'invoice' && (
                                <span className="ml-2 text-[10px] font-bold uppercase tracking-wider text-amber-800 bg-amber-100 border border-amber-200 px-1.5 py-0.5 rounded">Invoice</span>
                              )}
                              {doc.purpose === 'docket' && (
                                <span className="ml-2 text-[10px] font-bold uppercase tracking-wider text-indigo-800 bg-indigo-100 border border-indigo-200 px-1.5 py-0.5 rounded">Docket</span>
                              )}
                            </p>
                            <p className="text-xs text-slate-500 mt-0.5 font-mono">
                              {new Date(doc.uploadedAt).toLocaleDateString('en-GB')} · {(doc.size / 1024).toFixed(1)} KB
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => openDocument(doc)}
                            className="p-2 text-slate-500 hover:text-primary-600 hover:bg-slate-100 rounded-lg transition-colors"
                            title="Open in new tab"
                          >
                            <ExternalLink className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => downloadDocument(doc)}
                            className="p-2 text-slate-500 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors"
                            title="Download document"
                          >
                            <Download className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => setDeleteFile({ id: doc.id, type: 'document', name: doc.originalName })}
                            className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                            title="Delete document"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="text-center py-12 px-4 rounded-xl border border-dashed border-slate-200 bg-slate-50/50">
                      <div className="w-12 h-12 rounded-2xl bg-slate-100 text-slate-400 flex items-center justify-center mx-auto mb-3">
                        <FileText className="w-6 h-6" />
                      </div>
                      <h4 className="text-sm font-bold text-slate-800">No documents attached yet</h4>
                      <p className="text-xs text-slate-500 max-w-md mx-auto mt-1 mb-4">
                        Upload invoice copies, carrier dockets, weight slips, or delivery receipts for permanent audit storage.
                      </p>
                      <label className="inline-flex items-center gap-2 px-3.5 py-2 bg-white border border-slate-200 text-slate-700 rounded-lg hover:bg-slate-50 cursor-pointer transition-colors text-xs font-semibold shadow-2xs">
                        <Upload className="w-3.5 h-3.5 text-primary-600" />
                        <span>Choose File to Upload</span>
                        <input
                          type="file"
                          accept=".pdf,.doc,.docx,.xlsx,.xls,.csv"
                          className="hidden"
                          onChange={(e) => handleFileUpload(e, 'document')}
                          disabled={uploading}
                        />
                      </label>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'activity' && (
            <div id="panel-activity" role="tabpanel" aria-labelledby="tab-activity" tabIndex={0} className="space-y-6 outline-hidden">
              {/* Header banner */}
              <div className="rounded-2xl border border-slate-200/80 bg-slate-50/60 p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-xl bg-primary-100/80 text-primary-700 shrink-0">
                    <History className="w-5 h-5" />
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider">Consignment Lifecycle &amp; Audit Trail</h4>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Chronological record of inward, stage milestones, container packaging, and audit modifications
                    </p>
                  </div>
                </div>
                <div className="text-xs font-semibold text-slate-600 bg-white border border-slate-200 px-3 py-1.5 rounded-xl shadow-2xs tabular-nums">
                  {timelineEvents.length} Recorded {timelineEvents.length === 1 ? 'Event' : 'Events'}
                </div>
              </div>

              {/* Timeline Stream */}
              {timelineEvents.length > 0 ? (
                <div className="relative pl-6 sm:pl-8 before:absolute before:left-3 before:top-3 before:bottom-3 before:w-0.5 before:bg-slate-200">
                  <div className="space-y-6">
                    {timelineEvents.map((evt) => (
                      <div key={evt.id} className="relative group">
                        {/* Dot */}
                        <div className="absolute -left-[27px] sm:-left-[35px] top-1.5 w-6 h-6 rounded-full bg-white border-2 border-primary-500 flex items-center justify-center shadow-xs">
                          <span className="w-2 h-2 rounded-full bg-primary-600" />
                        </div>

                        {/* Event card */}
                        <div className="bg-white border border-slate-200/80 rounded-2xl p-4 shadow-2xs hover:border-slate-300 hover:shadow-xs transition-all">
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-bold text-sm text-slate-900">{evt.title}</span>
                              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${evt.badgeColor}`}>
                                {evt.badge}
                              </span>
                            </div>
                            <span className="text-[11px] font-mono text-slate-400">
                              {new Date(evt.timestamp).toLocaleString('en-GB', {
                                day: '2-digit', month: 'short', year: 'numeric',
                                hour: '2-digit', minute: '2-digit'
                              })}
                            </span>
                          </div>
                          <p className="text-xs text-slate-600 mt-1.5">{evt.description}</p>
                          <div className="mt-3 pt-2.5 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-400">
                            <span className="font-medium text-slate-500">Recorded by: <span className="font-semibold text-slate-700">{evt.user}</span></span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="text-center py-12 px-4 rounded-xl border border-dashed border-slate-200 bg-slate-50/50">
                  <History className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                  <h4 className="text-sm font-bold text-slate-800">No events logged yet</h4>
                  <p className="text-xs text-slate-500 mt-1">Lifecycle events will populate as milestones and packing progress occur.</p>
                </div>
              )}
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

      {/* Rename Box Modal — corrects a mis-scanned box number (e.g. a SKU barcode
          landed in the box-no field instead of a digit). Items, weight, video,
          and history all move with it. */}
      {boxRename && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/50 p-4" onClick={() => !boxRenameSaving && setBoxRename(null)}>
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 w-full max-w-md p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-bold text-slate-900">Rename Box Number</h3>
            <p className="text-xs text-slate-500">
              Box #{boxRename.boxNo} — its items, weight, video and history all move to the corrected number.
            </p>
            <label className="block text-xs">
              <span className="font-semibold text-slate-500 uppercase">Correct box number</span>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={boxRename.newBoxNo}
                onChange={(e) => setBoxRename({ ...boxRename, newBoxNo: e.target.value.replace(/\D+/g, '') })}
                className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono"
                placeholder="e.g. 4"
                autoFocus
              />
            </label>
            <label className="block text-xs">
              <span className="font-semibold text-slate-500 uppercase">Reason</span>
              <input
                type="text"
                value={boxRename.reason}
                onChange={(e) => setBoxRename({ ...boxRename, reason: e.target.value })}
                className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                placeholder="Required — e.g. Packer scanned a barcode into the box-no field"
              />
            </label>
            <label className="block text-xs">
              <span className="font-semibold text-slate-500 uppercase">Remarks</span>
              <textarea
                value={boxRename.remarks}
                onChange={(e) => setBoxRename({ ...boxRename, remarks: e.target.value })}
                className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm resize-none"
                rows={2}
              />
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" disabled={boxRenameSaving} onClick={() => setBoxRename(null)} className="px-3 py-1.5 text-xs border rounded-lg">Cancel</button>
              <button
                type="button"
                disabled={boxRenameSaving || !boxRename.newBoxNo || !String(boxRename.reason || '').trim()}
                onClick={saveBoxRename}
                className="px-3 py-1.5 text-xs bg-primary-600 text-white rounded-lg disabled:opacity-50 inline-flex items-center gap-1"
              >
                {boxRenameSaving && <Loader2 className="w-3 h-3 animate-spin" />}
                Rename box
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
