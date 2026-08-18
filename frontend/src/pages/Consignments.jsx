import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Link, useNavigate } from 'react-router';
import { Package, Plus, Search, Filter, Trash2, Eye, Download, Loader2, Store, Upload, Pencil, CheckCircle2, X, FileSpreadsheet, ChevronDown, ChevronUp, LayoutList, LayoutGrid, RefreshCw, Radio, Activity, AlertTriangle } from 'lucide-react';
import { consignmentsAPI, templatesAPI, marketplacesAPI, docketCompaniesAPI } from '../services/api';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { useDebounce } from '../hooks/useDebounce';
import { useConsignmentSync, mergeConsignmentChanges } from '../context/ConsignmentSyncContext';
import Modal from '../components/Modal';
import ConfirmModal from '../components/ConfirmModal';
import { getShipmentPriority, formatAppointmentDate, formatDispatchDate } from '../utils/priority';
import {
  sortByWorkflowPriority,
  getWorkflowBucket,
  WORKFLOW_BUCKET_ORDER,
  WORKFLOW_BUCKET_LABELS,
  WORKFLOW_BUCKET_SHORT,
  WORKFLOW_BUCKET_CLASS,
  WORKFLOW_BUCKET_FILTER_VARIANT,
  shipStatusClass,
  packStatusClass,
} from '../utils/workflowPriority';
import { getCriticalityRowClass } from '../utils/criticalityUi';
import CriticalityBadge from '../components/CriticalityBadge';
import ShipmentProgressBar from '../components/ShipmentProgressBar';
import TagButton, { TagButtonGroup } from '../components/TagButton';
import { TableSkeleton } from '../components/Skeleton';
import OmsGuruChecklist from '../components/OmsGuruChecklist';
import { normalizeWarehouses, computeRequiredDispatchDate, getTransitDays } from '../utils/dispatchPlanning';

const FULL_COL_COUNT = 29;
const COMPACT_COL_COUNT = 17;

const EMPTY_FORM = {
  id: '', internalShipmentNo: '', name: '', description: '', expectedDate: '', marketplaceId: '', warehouse: '',
  poExpiryDate: '', appointmentDate: '', scheduledDispatchDate: '', actualDispatchDate: '', dateOfInward: '',
  forwardInvoiceNo: '', docketCompany: '', docketNo: '', marketplaceTicketId: '', isDisputed: false, shipmentStatus: 'Planned',
  unitsShipped: '', unitsReceived: '', unitsInwarded: '', qaFailExcessQty: '',
  skus: [{ marketplaceBarcode: '', marketplaceBarcodeType: '', marketplaceSku: '', internalSku: '', requiredQty: '' }]
};

const EMPTY_SKU_ROW = { marketplaceBarcode: '', marketplaceBarcodeType: '', marketplaceSku: '', internalSku: '', requiredQty: '' };
const createEmptyForm = () => ({ ...EMPTY_FORM, skus: [{ ...EMPTY_SKU_ROW }] });

const clean = (value) => (value == null ? '' : String(value).trim());
const getScanBarcode = (sku = {}) => clean(sku.marketplaceBarcode || sku.barcode || sku.skuBarcode || sku.scanBarcode || sku.marketplaceSku);

const normalizeCsvHeader = (value) => clean(value).toLowerCase().replace(/[^a-z0-9]/g, '');

const parseCsvLine = (line) => {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      i++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells.map((cell) => cell.replace(/^"|"$/g, ''));
};

function applyDispatchToForm(form, marketplaces) {
  const mp = marketplaces.find((m) => m.id === form.marketplaceId);
  const transitDays = getTransitDays(mp, form.warehouse);
  const dispatch = computeRequiredDispatchDate(form.appointmentDate, transitDays);
  return dispatch ? { ...form, scheduledDispatchDate: dispatch } : form;
}

export default function Consignments() {
  const navigate = useNavigate();
  const { addToast } = useToast();
  const { user } = useAuth();
  const { pendingChanges, connected, lastSyncAt } = useConsignmentSync();
  const initialBucketFilter = (() => {
    try {
      const value = new URLSearchParams(window.location.search).get('bucket');
      return WORKFLOW_BUCKET_ORDER.includes(value) ? value : '';
    } catch {
      return '';
    }
  })();
  const [listTab, setListTab] = useState('all');
  const isAdmin = user?.role === 'admin' || user?.role === 'organization_head';
  const canDeleteConsignments = isAdmin || user?.permissions?.deleteConsignments === true;
  const [consignments, setConsignments] = useState([]);
  const [marketplaces, setMarketplaces] = useState([]);
  const [docketCompanies, setDocketCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [workflowFilter, setWorkflowFilter] = useState(initialBucketFilter);
  const [mpFilter, setMpFilter] = useState('');
  const [shortPackOnly, setShortPackOnly] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [showFinalDelete, setShowFinalDelete] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [selected, setSelected] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [editingRow, setEditingRow] = useState(null);
  const [editForm, setEditForm] = useState({});
  const debouncedSearch = useDebounce(search, 400);

  const [showAdvanced, setShowAdvanced] = useState(false);
  // Compact (17-column) view is the default — full (29-column) view is opt-in via localStorage.
  const [compactView, setCompactView] = useState(() => localStorage.getItem('consignmentsCompact') !== 'false');
  const [form, setForm] = useState(createEmptyForm);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  const colCount = compactView ? COMPACT_COL_COUNT : FULL_COL_COUNT;
  const didInitialLoad = useRef(false);

  const fetchData = useCallback(async ({ silent = false } = {}) => {
    try {
      if (silent) setRefreshing(true);
      else setLoading(true);
      const [consRes, mpRes, dcRes] = await Promise.all([
        consignmentsAPI.getAll({
          marketplaceId: mpFilter || undefined,
          search: debouncedSearch || undefined,
          sort: 'workflow',
          limit: pageSize,
          page: page,
          archivedOnly: workflowFilter === 'archived' ? 'true' : undefined,
          includeArchived: workflowFilter === 'archived' || debouncedSearch ? 'true' : undefined,
          shortPackOnly: shortPackOnly ? 'true' : undefined,
          // 'archived' already has a dedicated, DB-paginated path via
          // archivedOnly/includeArchived above — only route the other
          // buckets through the server-side bucket filter so filtering
          // (and the "total" it reports) applies before pagination, not
          // just to whatever page happened to load first.
          workflowBucket: (workflowFilter && workflowFilter !== 'archived') ? workflowFilter : undefined,
        }),
        marketplacesAPI.getAll(),
        docketCompaniesAPI.getAll()
      ]);
      setConsignments(consRes.data.consignments || []);
      setTotal(consRes.data.total || 0);
      setHasMore(consRes.data.hasMore || false);
      setMarketplaces(mpRes.data.marketplaces || []);
      setDocketCompanies(dcRes.data.companies || []);
    } catch (error) { addToast('Failed to load', 'error'); }
    finally { setLoading(false); setRefreshing(false); }
  }, [mpFilter, debouncedSearch, page, pageSize, workflowFilter, shortPackOnly, addToast]);

  // Reset page to 1 when search or filters change
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, workflowFilter, mpFilter, shortPackOnly]);

  useEffect(() => {
    fetchData({ silent: didInitialLoad.current });
    didInitialLoad.current = true;
  }, [fetchData]);

  // Real-time sync: merge packing-station status updates without manual refresh
  useEffect(() => {
    if (!pendingChanges.length) return;
    setConsignments((prev) => mergeConsignmentChanges(prev, pendingChanges));
  }, [pendingChanges]);

  const openCreateModal = () => {
    setEditingRow(null);
    setEditForm({});
    setShowDelete(false);
    setShowFinalDelete(false);
    setDeleteConfirmText('');
    setShowAdvanced(false);
    setForm(createEmptyForm());
    setShowCreate(true);
  };

  const closeCreateModal = () => {
    if (isSubmitting) return;
    setShowCreate(false);
    setShowAdvanced(false);
    setForm(createEmptyForm());
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const payload = {
        ...form,
        id: form.id?.trim() || undefined,
        unitsShipped: parseInt(form.unitsShipped) || 0,
        unitsReceived: parseInt(form.unitsReceived) || 0,
        unitsInwarded: parseInt(form.unitsInwarded) || 0,
        qaFailExcessQty: parseInt(form.qaFailExcessQty) || 0,
        isDisputed: Boolean(form.isDisputed),
        skus: form.skus.filter(s => getScanBarcode(s) || s.internalSku).map(s => {
          const marketplaceBarcode = getScanBarcode(s);
          return {
            marketplaceBarcode,
            marketplaceBarcodeType: clean(s.marketplaceBarcodeType),
            barcode: marketplaceBarcode,
            marketplaceSku: clean(s.marketplaceSku) || marketplaceBarcode,
            internalSku: s.internalSku,
            requiredQty: parseInt(s.requiredQty) || 0
          };
        })
      };
      const { data } = await consignmentsAPI.create(payload);
      const created = data.consignment;
      if (created) {
        setConsignments((prev) => sortByWorkflowPriority([created, ...prev.filter((c) => c.id !== created.id)]));
        setTotal((prev) => prev + 1);
      }
      addToast(
        created?.pendingExternalId
          ? `Consignment created — pack using Internal Shipment No. ${created.internalShipmentNo}`
          : 'Consignment created',
        'success'
      );
      closeCreateModal();
    } catch (error) {
      const msg = error.response?.data?.error || 'Failed';
      addToast(msg, 'error');
    }
    finally { setIsSubmitting(false); }
  };

  // ── Bulk selection ──
  const [selectedIds, setSelectedIds] = useState(new Set());
  const toggleSelect = (id) => setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleSelectAll = () => setSelectedIds(prev => prev.size === sortedConsignments.length ? new Set() : new Set(sortedConsignments.map(c => c.id)));
  const clearSelection = () => setSelectedIds(new Set());

  const bulkExport = () => {
    const rows = consignments.filter(c => selectedIds.has(c.id));
    if (!rows.length) return;
    const headers = ['Consignment No','Internal Shipment No','Portal','FC Name','Planned','Packed','Pending','Pack Status','Ship Status','Disputed','Protected','Total Weight','Weight Unit'];
    const csv = [headers, ...rows.map(c => [
      c.id, c.internalShipmentNo || '', getMpName(c.marketplaceId), c.warehouse || '',
      c.totalRequiredQty || 0, c.totalPackedQty || 0, Math.max(0,(c.totalRequiredQty||0)-(c.totalPackedQty||0)),
      c.status || '', c.shipmentStatus || '', c.isDisputed ? 'Yes' : 'No',
      (c.isDisputed || c.marketplaceTicketId) ? 'Yes' : 'No', c.totalWeight || 0, c.weightUnit || 'KG'
    ])].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `selected_consignments_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    addToast(`Exported ${rows.length} consignment(s)`, 'success');
  };

  const deletionTargets = selected ? [selected.id, selected.name, selected.internalShipmentNo].filter(Boolean).map((v) => String(v).trim().toLowerCase()) : [];
  const deleteConfirmationMatches = deletionTargets.includes(deleteConfirmText.trim().toLowerCase());

  const openDelete = (consignment) => {
    setSelected(consignment);
    setDeleteConfirmText('');
    setShowFinalDelete(false);
    setShowDelete(true);
  };

  const closeDelete = () => {
    if (isSubmitting) return;
    setShowDelete(false);
    setShowFinalDelete(false);
    setDeleteConfirmText('');
  };

  const handleDelete = async () => {
    if (!selected) return;
    setIsSubmitting(true);
    try {
      await consignmentsAPI.delete(selected.id, { confirmationText: deleteConfirmText.trim() });
      addToast('Consignment permanently deleted', 'success');
      setConsignments((prev) => prev.filter((c) => c.id !== selected.id));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(selected.id);
        return next;
      });
      closeDelete();
      fetchData({ silent: true });
    }
    catch (error) { addToast(error.response?.data?.error || 'Delete failed', 'error'); }
    setIsSubmitting(false);
  };

  const addSku = () => setForm(prev => ({ ...prev, skus: [...prev.skus, { ...EMPTY_SKU_ROW }] }));
  const removeSku = (i) => setForm(prev => ({ ...prev, skus: prev.skus.filter((_, idx) => idx !== i) }));
  const updateSku = (i, field, value) => setForm(prev => {
    const s = prev.skus.map((sku, idx) => idx === i ? { ...sku, [field]: value } : sku);
    return { ...prev, skus: s };
  });

  const parseCsv = (text) => {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return [];
    const headers = parseCsvLine(lines[0]).map(normalizeCsvHeader);
    const findHeader = (needles) => headers.findIndex(h => needles.some(n => h === n || h.includes(n)));
    const idxScan = findHeader(['marketplacebarcode', 'skubarcode', 'scanbarcode', 'fnsku', 'asin', 'fsn', 'barcode']);
    const idxType = findHeader(['marketplacebarcodetype', 'barcodetype', 'skubarcodetype']);
    const idxMp = findHeader(['marketplacesku', 'marketplaceid', 'marketplacecode']);
    const idxInt = findHeader(['internalsku', 'omssku', 'internal']);
    const idxQty = findHeader(['requiredqty', 'qty', 'quantity', 'required']);
    const items = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCsvLine(lines[i]);
      if (!cols[0]) continue;
      const marketplaceBarcode = idxScan >= 0 ? cols[idxScan] : cols[0];
      const marketplaceSku = idxMp >= 0 ? cols[idxMp] : marketplaceBarcode;
      items.push({
        marketplaceBarcode,
        marketplaceBarcodeType: idxType >= 0 ? cols[idxType] : '',
        marketplaceSku,
        internalSku: idxInt >= 0 ? cols[idxInt] : (cols[1] || ''),
        requiredQty: idxQty >= 0 ? cols[idxQty] : (cols[2] || '0')
      });
    }
    return items;
  };

  const handleCsvUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const text = ev.target.result;
        const items = parseCsv(text);
        if (items.length === 0) { addToast('No valid SKUs found in file', 'warning'); return; }

        setForm(prev => ({ ...prev, skus: items }));
        addToast(`${items.length} SKU(s) imported from ${file.name}`, 'success');
      } catch (err) { addToast('Failed to parse file: ' + err.message, 'error'); }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const getMpWarehouses = (marketplaceId) => {
    const mp = marketplaces.find((m) => m.id === marketplaceId);
    return normalizeWarehouses(mp?.warehouses);
  };

  const getMpName = (id) => marketplaces.find(m => m.id === id)?.name || '';

  const startEdit = (c) => {
    setShowCreate(false);
    setEditingRow(c.id);
    setEditForm({
      marketplaceId: c.marketplaceId || '',
      warehouse: c.warehouse || '',
      appointmentDate: c.appointmentDate || '',
      scheduledDispatchDate: c.scheduledDispatchDate || c.requiredDispatchDate || '',
      actualDispatchDate: c.actualDispatchDate || '',
      dateOfInward: c.dateOfInward || '',
      forwardInvoiceNo: c.forwardInvoiceNo || '',
      docketCompany: c.docketCompany || '',
      docketNo: c.docketNo || '',
      marketplaceTicketId: c.marketplaceTicketId || '',
      isDisputed: Boolean(c.isDisputed),
      unitsShipped: c.unitsShipped || '',
      unitsReceived: c.unitsReceived || '',
      unitsInwarded: c.unitsInwarded || '',
      qaFailExcessQty: c.qaFailExcessQty || '',
    });
  };

  const cancelEdit = () => { setEditingRow(null); setEditForm({}); };

  const saveEdit = async (c) => {
    setIsSubmitting(true);
    try {
      const payload = {
        ...editForm,
        unitsShipped: parseInt(editForm.unitsShipped) || 0,
        unitsReceived: parseInt(editForm.unitsReceived) || 0,
        unitsInwarded: parseInt(editForm.unitsInwarded) || 0,
        qaFailExcessQty: parseInt(editForm.qaFailExcessQty) || 0,
        isDisputed: Boolean(editForm.isDisputed),
      };
      await consignmentsAPI.update(c.id, payload);
      addToast('Updated', 'success');
      setEditingRow(null);
      fetchData({ silent: true });
    } catch (error) { addToast('Update failed', 'error'); }
    setIsSubmitting(false);
  };

  const fmtDate = (d) => {
    if (!d) return '—';
    const dt = new Date(d);
    if (isNaN(dt)) return d;
    return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  };

  const handleExport = () => {
    const headers = [
      'Consignment No','Internal Shipment No','Portal','FC Name','Actual Dispatch','Date of Inward',
      'Docket Company','Docket No','Forward Invoice','Ticket ID','Disputed','Protected','Planned','Packed','Shipped',
      'Received','Inwarded','Short','Pack Status','Ship Status','Total Weight','Weight Unit'
    ];
    const rows = consignments.map(c => {
      const shortQty = (c.totalRequiredQty || 0) - (c.unitsInwarded || 0);
      return [
        c.id, c.internalShipmentNo || '', getMpName(c.marketplaceId), c.warehouse || '',
        c.actualDispatchDate || '', c.dateOfInward || '', c.docketCompany || '', c.docketNo || '',
        c.forwardInvoiceNo || '', c.marketplaceTicketId || '', c.isDisputed ? 'Yes' : 'No',
        (c.isDisputed || c.marketplaceTicketId) ? 'Yes' : 'No', c.totalRequiredQty || 0,
        c.totalPackedQty || 0, c.unitsShipped || 0, c.unitsReceived || 0, c.unitsInwarded || 0,
        shortQty, c.status || '', c.shipmentStatus || '', c.totalWeight || 0, c.weightUnit || 'KG'
      ];
    });
    const csv = [headers.join(','), ...rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `consignments_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    addToast('Exported to CSV', 'success');
  };

  const statusClass = packStatusClass;
  const shipStatusClassFn = shipStatusClass;

  const toggleCompactView = () => {
    setCompactView(prev => {
      const next = !prev;
      localStorage.setItem('consignmentsCompact', String(next));
      return next;
    });
  };

  const stats = useMemo(() => {
    const byBucket = Object.fromEntries(WORKFLOW_BUCKET_ORDER.map((k) => [k, 0]));
    for (const c of consignments) {
      const b = getWorkflowBucket(c);
      if (byBucket[b] != null) byBucket[b] += 1;
    }
    return {
      total: consignments.length,
      ...byBucket,
    };
  }, [consignments]);

  const sortedConsignments = useMemo(() => {
    const sorted = sortByWorkflowPriority(consignments);
    if (!workflowFilter) return sorted;
    return sorted.filter((c) => getWorkflowBucket(c) === workflowFilter);
  }, [consignments, workflowFilter]);

  /** Rows with optional section headers when viewing all priorities */
  const tableRows = useMemo(() => {
    if (workflowFilter) return sortedConsignments.map((c) => ({ type: 'row', c }));
    const rows = [];
    let lastBucket = null;
    for (const c of sortedConsignments) {
      const bucket = getWorkflowBucket(c);
      if (bucket !== lastBucket) {
        rows.push({ type: 'section', bucket });
        lastBucket = bucket;
      }
      rows.push({ type: 'row', c });
    }
    return rows;
  }, [sortedConsignments, workflowFilter]);

  const liveFeed = useMemo(() => {
    const map = new Map(consignments.map((c) => [c.id, c]));
    for (const ch of pendingChanges) {
      if (ch.id) map.set(ch.id, { ...map.get(ch.id), ...ch, _live: true });
    }
    return Array.from(map.values())
      .filter((c) => c._live || c.status === 'in_progress' || pendingChanges.some((p) => p.id === c.id))
      .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
      .slice(0, 40);
  }, [consignments, pendingChanges]);

  const toggleOmsGuru = async (consignment, checked) => {
    try {
      await consignmentsAPI.update(consignment.id, {
        omsGuruQtyRemoved: checked,
        omsGuruQtyRemovedAt: checked ? new Date().toISOString() : null,
        omsGuruQtyRemovedBy: checked ? (user?.name || user?.email || 'Unknown') : null,
      });
      setConsignments((prev) => prev.map((c) => (
        c.id === consignment.id
          ? {
            ...c,
            omsGuruQtyRemoved: checked,
            omsGuruQtyRemovedAt: checked ? new Date().toISOString() : null,
            omsGuruQtyRemovedBy: checked ? (user?.name || user?.email) : null,
          }
          : c
      )));
      addToast(checked ? 'OMSGuru removal confirmed' : 'OMSGuru checklist reset', 'success');
    } catch {
      addToast('Could not update OMSGuru checklist', 'error');
    }
  };

  return (
    <div className="space-y-3">
      {/* Toolbar + list mode */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-0.5 bg-slate-100 rounded-md p-0.5">
            <button type="button" onClick={() => setListTab('all')}
              className={`px-2.5 py-1 rounded text-[11px] font-semibold flex items-center gap-1 ${listTab === 'all' ? 'bg-white shadow-sm text-primary-700' : 'text-slate-600'}`}>
              <LayoutList className="w-3 h-3" /> All Consignments
            </button>
            <button type="button" onClick={() => setListTab('live')}
              className={`px-2.5 py-1 rounded text-[11px] font-semibold flex items-center gap-1 ${listTab === 'live' ? 'bg-white shadow-sm text-primary-700' : 'text-slate-600'}`}>
              <Activity className="w-3 h-3" /> Live
              {pendingChanges.length > 0 && (
                <span className="bg-red-500 text-white text-[8px] font-bold px-1 py-px rounded-full min-w-[14px] text-center">{pendingChanges.length}</span>
              )}
            </button>
          </div>
          <div className="flex items-center gap-1 text-[10px] text-slate-500">
            <Radio className={`w-3 h-3 ${connected ? 'text-emerald-500' : 'text-amber-500'}`} />
            {connected ? 'Sync active' : 'Polling'}
            {lastSyncAt && <span className="text-slate-400">· {new Date(lastSyncAt).toLocaleTimeString()}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap sm:ml-auto">
          {refreshing && <RefreshCw className="w-3.5 h-3.5 animate-spin text-primary-500" />}
          <button
            type="button"
            onClick={toggleCompactView}
            className="flex items-center gap-1.5 px-2.5 py-1.5 border border-slate-200 text-slate-600 bg-white rounded-md hover:bg-slate-50 text-xs"
            title={compactView ? 'Show all columns' : 'Show compact view'}
          >
            {compactView ? <LayoutGrid className="w-3.5 h-3.5" /> : <LayoutList className="w-3.5 h-3.5" />}
            {compactView ? 'Full' : 'Compact'}
          </button>
          <button type="button" onClick={() => handleExport()} className="flex items-center gap-1.5 px-2.5 py-1.5 border border-slate-200 text-slate-700 bg-white rounded-md hover:bg-slate-50 text-xs"><FileSpreadsheet className="w-3.5 h-3.5" />Export</button>
          <button type="button" onClick={openCreateModal} className="flex items-center gap-1.5 px-3 py-1.5 bg-primary-600 text-white rounded-md hover:bg-primary-700 text-xs font-medium"><Plus className="w-3.5 h-3.5" />New</button>
        </div>
      </div>

      {listTab === 'live' && (
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
          <div className="px-3 py-2 border-b border-slate-100 bg-slate-50">
            <h3 className="text-xs font-semibold text-slate-800">Live Consignment Feed</h3>
          </div>
          <div className="divide-y divide-slate-100 max-h-64 overflow-y-auto">
            {liveFeed.length === 0 ? (
              <p className="text-center text-slate-400 text-xs py-6">No live activity yet</p>
            ) : liveFeed.map((c) => (
              <Link key={c.id} to={`/consignments/${c.id}`} className="flex items-center justify-between px-3 py-2 hover:bg-slate-50">
                <div>
                  <p className="text-xs font-semibold text-slate-800">{c.internalShipmentNo || c.id}</p>
                  <p className="text-[10px] text-slate-500">
                    {WORKFLOW_BUCKET_LABELS[getWorkflowBucket(c)] || 'New'} · {c.shipmentStatus || 'Planned'}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-[10px] font-semibold text-emerald-600">{c.totalPackedQty || 0}/{c.totalRequiredQty || 0}</p>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}
      <div className="bg-white rounded-lg border border-slate-200 p-2.5 sm:p-3">
        <div className="flex flex-col gap-2">
          <div className="relative w-full">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by consignment ID, shipment, docket, invoice…"
              className="inp pl-8 py-1.5 text-xs"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Filter className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
            <TagButtonGroup>
              <TagButton
                variant="default"
                active={workflowFilter === ''}
                count={loading ? '—' : stats.total}
                onClick={() => setWorkflowFilter('')}
              >
                All
              </TagButton>
              {WORKFLOW_BUCKET_ORDER.map((value) => (
                <TagButton
                  key={value}
                  variant={WORKFLOW_BUCKET_FILTER_VARIANT[value] || 'default'}
                  active={workflowFilter === value}
                  count={loading ? '—' : stats[value]}
                  onClick={() => setWorkflowFilter(value)}
                >
                  {WORKFLOW_BUCKET_SHORT[value]}
                </TagButton>
              ))}
            </TagButtonGroup>
            <button
              type="button"
              onClick={() => setShortPackOnly((v) => !v)}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold border transition-colors ${
                shortPackOnly
                  ? 'bg-red-50 text-red-700 border-red-200'
                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
              }`}
              title="Show consignments confirmed short at packing"
            >
              Short pack
            </button>
            <div className="w-px h-6 bg-slate-200 hidden sm:block" />
            <select
              value={mpFilter}
              onChange={e => setMpFilter(e.target.value)}
              title={marketplaces.find((m) => m.id === mpFilter)?.name || 'All marketplaces'}
              className="inp py-1 px-1.5 text-[11px] w-[7.5rem] sm:w-[8.5rem] shrink-0 truncate"
            >
              <option value="">All MPs</option>
              {marketplaces.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            <button
              type="button"
              onClick={() => fetchData({ silent: true })}
              disabled={loading || refreshing}
              className="btn btn-ghost px-2 py-1"
              title="Refresh list"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
      </div>

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-2 bg-primary-600 text-white rounded-lg px-3 py-2 animate-fade-in">
          <span className="text-xs font-semibold">{selectedIds.size} selected</span>
          <button onClick={bulkExport} className="flex items-center gap-1.5 px-3 py-1.5 bg-white/15 hover:bg-white/25 rounded-lg text-xs font-medium transition-colors"><FileSpreadsheet className="w-3.5 h-3.5" />Export</button>
          <button onClick={clearSelection} className="ml-auto text-xs text-white/70 hover:text-white">Clear</button>
        </div>
      )}

      {loading ? (
        <TableSkeleton rows={8} />
      ) : (
      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden relative">
        {refreshing && (
          <div className="absolute inset-x-0 top-0 h-0.5 bg-primary-100 overflow-hidden z-20">
            <div className="h-full w-1/3 bg-primary-500 animate-pulse" />
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full tbl">
            <thead><tr>
              <th className="px-2 sticky left-0 bg-slate-50 z-10"><input type="checkbox" checked={sortedConsignments.length > 0 && selectedIds.size === sortedConsignments.length} onChange={toggleSelectAll} className="w-3.5 h-3.5 rounded accent-primary-600 cursor-pointer" /></th>
              <th className="text-left whitespace-nowrap">Consignment No</th>
              <th className="text-left whitespace-nowrap">Internal Shipment</th>
              <th className="text-left whitespace-nowrap">Criticality</th>
              <th className="text-left whitespace-nowrap">Appointment</th>
              <th className="text-left whitespace-nowrap">Req. Dispatch</th>
              <th className="text-left whitespace-nowrap">Portal</th>
              <th className="text-left whitespace-nowrap">FC Name</th>
              {!compactView && <>
              <th className="text-left whitespace-nowrap">Transit</th>
              <th className="text-left whitespace-nowrap">Actual Dispatch</th>
              <th className="text-left whitespace-nowrap">Date of Inward</th>
              <th className="text-left whitespace-nowrap">Docket Co.</th>
              <th className="text-left whitespace-nowrap">Docket No</th>
              <th className="text-left whitespace-nowrap">Invoice</th>
              <th className="text-left whitespace-nowrap">Ticket ID</th>
              <th className="text-left whitespace-nowrap">Protection</th>
              </>}
              <th className="text-right whitespace-nowrap">Planned</th>
              <th className="text-right whitespace-nowrap">Packed</th>
              {!compactView && <>
              <th className="text-right whitespace-nowrap">Shipped</th>
              <th className="text-right whitespace-nowrap">Received</th>
              <th className="text-right whitespace-nowrap">Inwarded</th>
              <th className="text-right whitespace-nowrap">Short</th>
              </>}
              <th className="text-left whitespace-nowrap">Pack</th>
              <th className="text-left whitespace-nowrap">Ship</th>
              <th className="text-left whitespace-nowrap">Workflow</th>
              <th className="text-left whitespace-nowrap">Ground team</th>
              <th className="text-left whitespace-nowrap min-w-[88px]">Progress</th>
              <th className="text-left whitespace-nowrap">OMS Guru</th>
              <th className="text-right whitespace-nowrap sticky right-0 bg-slate-50 z-10">Actions</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? <tr><td colSpan={colCount} className="py-12 text-center"><Loader2 className="w-8 h-8 animate-spin mx-auto text-primary-600" /></td></tr>
              : tableRows.length > 0 ? tableRows.map((entry) => {
                if (entry.type === 'section') {
                  return (
                    <tr key={`section-${entry.bucket}`} className="bg-slate-50/90">
                      <td colSpan={colCount} className="px-3 py-1.5 border-y border-slate-100">
                        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide border ${WORKFLOW_BUCKET_CLASS[entry.bucket] || WORKFLOW_BUCKET_CLASS.new}`}>
                          {WORKFLOW_BUCKET_LABELS[entry.bucket] || entry.bucket}
                        </span>
                        <span className="ml-2 text-[10px] text-slate-400">
                          {entry.bucket === 'new' || entry.bucket === 'active' ? 'Action needed first' : entry.bucket === 'shipped' || entry.bucket === 'inwarded' ? 'Lower priority · completed flow' : 'Follow-up in progress'}
                        </span>
                      </td>
                    </tr>
                  );
                }
                const c = entry.c;
                const shortQty = (c.totalRequiredQty || 0) - (c.unitsInwarded || 0);
                const isEditing = editingRow === c.id;
                const isSelected = selectedIds.has(c.id);
                const priority = getShipmentPriority(c);
                const rowClass = getCriticalityRowClass(priority, { selected: isSelected, editing: isEditing });
                const stickyBg = isEditing ? 'bg-slate-50' : isSelected ? 'bg-slate-100' :
                  priority.level === 'critical' ? 'bg-red-50/90' :
                  priority.level === 'high' ? 'bg-orange-50/70' :
                  priority.level === 'medium' ? 'bg-amber-50/60' : 'bg-white';
                return (
                <React.Fragment key={c.id}>
                  <tr className={`group transition-colors ${rowClass}`}>
                    <td className={`sticky left-0 z-10 border-r border-slate-100 ${stickyBg}`}><input type="checkbox" checked={isSelected} onChange={() => toggleSelect(c.id)} className="w-3.5 h-3.5 rounded accent-primary-600 cursor-pointer" /></td>
                    <td className="font-medium text-slate-800 whitespace-nowrap">{c.id}</td>
                    <td className="font-semibold text-slate-900 whitespace-nowrap">{c.internalShipmentNo || '—'}</td>
                    <td className="whitespace-nowrap">
                      {priority.level !== 'normal' ? (
                        <CriticalityBadge priority={priority} showSublabel />
                      ) : (
                        <span className="text-[10px] text-slate-400">On track</span>
                      )}
                    </td>
                    <td className="text-slate-600 whitespace-nowrap">{formatAppointmentDate(c.appointmentDate)}</td>
                    <td className="whitespace-nowrap">
                      <span className={`font-medium ${priority.level === 'critical' ? 'text-red-700' : 'text-slate-700'}`}>
                        {formatDispatchDate(c.requiredDispatchDate || c.scheduledDispatchDate)}
                      </span>
                    </td>
                    <td className="whitespace-nowrap"><span className="inline-flex items-center gap-0.5 text-slate-700 bg-slate-100 px-1.5 py-px rounded text-[10px] font-medium"><Store className="w-2.5 h-2.5" />{getMpName(c.marketplaceId) || '—'}</span></td>
                    <td className="text-slate-600 whitespace-nowrap">{c.warehouse || '—'}</td>
                    {!compactView && <>
                    <td className="text-slate-600 whitespace-nowrap">{c.transitDays ? `${c.transitDays}d` : '—'}</td>
                    <td className="text-slate-600 whitespace-nowrap">{fmtDate(c.actualDispatchDate)}</td>
                    <td className="text-slate-600 whitespace-nowrap">{fmtDate(c.dateOfInward)}</td>
                    <td className="text-slate-600 whitespace-nowrap">{c.docketCompany || '—'}</td>
                    <td className="text-slate-600 whitespace-nowrap">{c.docketNo || '—'}</td>
                    <td className="text-slate-600 whitespace-nowrap">{c.forwardInvoiceNo || '—'}</td>
                    <td className="text-slate-600 whitespace-nowrap">{c.marketplaceTicketId || '—'}</td>
                    <td className="whitespace-nowrap">
                      {c.isDisputed || c.marketplaceTicketId ? (
                        <span className={`inline-flex px-1.5 py-px rounded text-[10px] font-medium ${c.isDisputed ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'}`}>
                          {c.isDisputed ? 'Disputed' : 'Ticket'}
                        </span>
                      ) : <span className="text-slate-400">—</span>}
                    </td>
                    </>}
                    <td className="text-right font-medium text-slate-700 whitespace-nowrap tabular-nums">{c.totalRequiredQty || 0}</td>
                    <td className="text-right font-medium text-slate-700 whitespace-nowrap tabular-nums">{c.totalPackedQty || 0}</td>
                    {!compactView && <>
                    <td className="text-right text-slate-700 whitespace-nowrap tabular-nums">{c.unitsShipped || 0}</td>
                    <td className="text-right text-slate-700 whitespace-nowrap tabular-nums">{c.unitsReceived || 0}</td>
                    <td className="text-right text-slate-700 whitespace-nowrap tabular-nums">{c.unitsInwarded || 0}</td>
                    <td className={`text-right font-semibold whitespace-nowrap tabular-nums ${shortQty > 0 ? 'text-red-600' : shortQty < 0 ? 'text-amber-600' : 'text-emerald-600'}`}>{shortQty}</td>
                    </>}
                    <td className="whitespace-nowrap"><span className={`inline-flex px-1.5 py-px rounded text-[10px] font-medium ${statusClass(c.status)}`}>{c.status?.replace('_',' ')}</span></td>
                    <td className="whitespace-nowrap"><span className={`inline-flex px-1.5 py-px rounded text-[10px] font-medium ${shipStatusClassFn(c.shipmentStatus)}`}>{c.shipmentStatus || 'Planned'}</span></td>
                    <td className="whitespace-nowrap">
                      <span className={`inline-flex px-1.5 py-px rounded text-[10px] font-semibold border ${WORKFLOW_BUCKET_CLASS[getWorkflowBucket(c)] || WORKFLOW_BUCKET_CLASS.new}`}>
                        {WORKFLOW_BUCKET_LABELS[getWorkflowBucket(c)] || 'New'}
                      </span>
                      {c.hasPackingShort && (
                        <span
                          className="ml-1 inline-flex px-1.5 py-px rounded text-[10px] font-semibold bg-red-50 text-red-700 border border-red-100"
                          title={c.packingCompletion?.shortReason || `Short ${c.packingShortQty || c.packingTotals?.short || 0}`}
                        >
                          Short {c.packingShortQty || c.packingTotals?.short || ''}
                        </span>
                      )}
                      {c.isEscalated && <span className="ml-1 inline-flex px-1.5 py-px rounded text-[10px] font-semibold bg-red-100 text-red-800">Escalated</span>}
                      {c.isTatOverdue && !c.isEscalated && <span className="ml-1 inline-flex px-1.5 py-px rounded text-[10px] font-semibold bg-amber-100 text-amber-900">TAT</span>}
                    </td>
                    <td className="text-slate-600 whitespace-nowrap text-[10px]" title={c.pendingAction || ''}>
                      {c.groundTeamName || '—'}
                      {c.pendingAction ? <div className="text-amber-700 truncate max-w-[120px]">{c.pendingAction}</div> : null}
                    </td>
                    <td className="whitespace-nowrap"><ShipmentProgressBar consignment={c} variant="inline" /></td>
                    <td className="whitespace-nowrap">
                      <OmsGuruChecklist
                        consignment={c}
                        compact
                        onToggle={(checked) => toggleOmsGuru(c, checked)}
                      />
                    </td>
                    <td className={`whitespace-nowrap sticky right-0 z-10 border-l border-slate-100 ${stickyBg}`}><div className="flex items-center justify-end gap-0.5">
                      {isEditing ? (
                        <>
                          <button onClick={()=>saveEdit(c)} disabled={isSubmitting} className="p-1 text-emerald-600 hover:bg-emerald-50 rounded transition-colors" title="Save"><CheckCircle2 className="w-3.5 h-3.5" /></button>
                          <button onClick={cancelEdit} className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-50 rounded transition-colors" title="Cancel"><X className="w-3.5 h-3.5" /></button>
                        </>
                      ) : (
                        <>
                          <button onClick={()=>startEdit(c)} className="p-1 text-slate-400 hover:text-primary-600 hover:bg-slate-100 rounded transition-colors" title="Edit tracking"><Pencil className="w-3.5 h-3.5" /></button>
                          <Link to={`/consignments/${c.id}`} className="p-1 text-slate-400 hover:text-primary-600 hover:bg-slate-100 rounded transition-colors"><Eye className="w-3.5 h-3.5" /></Link>
                          {canDeleteConsignments && <button onClick={()=>openDelete(c)} className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors" title="Delete consignment"><Trash2 className="w-3.5 h-3.5" /></button>}
                        </>
                      )}
                    </div></td>
                  </tr>
                  {isEditing && (
                    <tr className="bg-slate-50">
                      <td colSpan={colCount} className="px-3 py-2">
                        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
                          <div><label className="text-[10px] uppercase tracking-wider text-slate-500 block mb-1">Appointment Date</label><input type="date" value={editForm.appointmentDate || ''} onChange={e=>setEditForm(applyDispatchToForm({...editForm,appointmentDate:e.target.value}, marketplaces))} className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm focus:ring-2 focus:ring-primary-500 outline-none" /></div>
                          <div><label className="text-[10px] uppercase tracking-wider text-slate-500 block mb-1">Required Dispatch</label><input type="date" value={editForm.scheduledDispatchDate || ''} readOnly className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm bg-slate-50 text-slate-600" title="Auto-calculated from appointment − transit days" /></div>
                          <div><label className="text-[10px] uppercase tracking-wider text-slate-500 block mb-1">Actual Dispatch</label><input type="date" value={editForm.actualDispatchDate || ''} onChange={e=>setEditForm({...editForm,actualDispatchDate:e.target.value})} className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm focus:ring-2 focus:ring-primary-500 outline-none" /></div>
                          <div><label className="text-[10px] uppercase tracking-wider text-slate-500 block mb-1">Date of Inward</label><input type="date" value={editForm.dateOfInward || ''} onChange={e=>setEditForm({...editForm,dateOfInward:e.target.value})} className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm focus:ring-2 focus:ring-primary-500 outline-none" /></div>
                          <div><label className="text-[10px] uppercase tracking-wider text-slate-500 block mb-1">Docket Company</label><select value={editForm.docketCompany || ''} onChange={e=>setEditForm({...editForm,docketCompany:e.target.value})} className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm focus:ring-2 focus:ring-primary-500 outline-none bg-white"><option value="">Select</option>{docketCompanies.map(dc=><option key={dc.id} value={dc.name}>{dc.name}</option>)}</select></div>
                          <div><label className="text-[10px] uppercase tracking-wider text-slate-500 block mb-1">Docket No</label><input type="text" value={editForm.docketNo || ''} onChange={e=>setEditForm({...editForm,docketNo:e.target.value})} className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm focus:ring-2 focus:ring-primary-500 outline-none" placeholder="Docket #" /></div>
                          <div><label className="text-[10px] uppercase tracking-wider text-slate-500 block mb-1">Forward Invoice No.</label><input type="text" value={editForm.forwardInvoiceNo || ''} onChange={e=>setEditForm({...editForm,forwardInvoiceNo:e.target.value})} className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm focus:ring-2 focus:ring-primary-500 outline-none" placeholder="Invoice #" /></div>
                          <div><label className="text-[10px] uppercase tracking-wider text-slate-500 block mb-1">Marketplace Ticket ID</label><input type="text" value={editForm.marketplaceTicketId || ''} onChange={e=>setEditForm({...editForm,marketplaceTicketId:e.target.value})} className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm focus:ring-2 focus:ring-primary-500 outline-none" placeholder="Ticket ID" /></div>
                          <label className="flex items-center gap-2 text-sm text-slate-700 border border-slate-200 rounded px-2 py-1.5"><input type="checkbox" checked={!!editForm.isDisputed} onChange={e=>setEditForm({...editForm,isDisputed:e.target.checked})} /> Disputed (protect videos)</label>
                          <div><label className="text-[10px] uppercase tracking-wider text-slate-500 block mb-1">Units Shipped</label><input type="number" min="0" value={editForm.unitsShipped || ''} onChange={e=>setEditForm({...editForm,unitsShipped:e.target.value})} className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm focus:ring-2 focus:ring-primary-500 outline-none" placeholder="0" /></div>
                          <div><label className="text-[10px] uppercase tracking-wider text-slate-500 block mb-1">Units Received</label><input type="number" min="0" value={editForm.unitsReceived || ''} onChange={e=>setEditForm({...editForm,unitsReceived:e.target.value})} className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm focus:ring-2 focus:ring-primary-500 outline-none" placeholder="0" /></div>
                          <div><label className="text-[10px] uppercase tracking-wider text-slate-500 block mb-1">Units Inwarded</label><input type="number" min="0" value={editForm.unitsInwarded || ''} onChange={e=>setEditForm({...editForm,unitsInwarded:e.target.value})} className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm focus:ring-2 focus:ring-primary-500 outline-none" placeholder="0" /></div>
                          <div><label className="text-[10px] uppercase tracking-wider text-slate-500 block mb-1">QA Fail / Excess</label><input type="number" min="0" value={editForm.qaFailExcessQty || ''} onChange={e=>setEditForm({...editForm,qaFailExcessQty:e.target.value})} className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm focus:ring-2 focus:ring-primary-500 outline-none" placeholder="0" /></div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              )}) : <tr><td colSpan={colCount} className="py-12 text-center text-slate-400"><Package className="w-12 h-12 mx-auto mb-3 text-slate-300" /><p>No consignments found</p></td></tr>}
            </tbody>
          </table>
        </div>
        {/* Pagination controls */}
        {total > 0 && (
          <div className="flex items-center justify-between px-4 py-3 bg-white border-t border-slate-200 sm:px-6">
            <div className="flex justify-between flex-1 sm:hidden">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="relative inline-flex items-center px-4 py-2 border border-slate-300 text-xs font-semibold rounded-md text-slate-700 bg-white hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={() => setPage((p) => (hasMore ? p + 1 : p))}
                disabled={!hasMore}
                className="relative inline-flex items-center ml-3 px-4 py-2 border border-slate-300 text-xs font-semibold rounded-md text-slate-700 bg-white hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
            <div className="hidden sm:flex-1 sm:flex sm:items-center sm:justify-between">
              <div>
                <p className="text-xs text-slate-700">
                  Showing <span className="font-semibold">{Math.min(total, (page - 1) * pageSize + 1)}</span> to{' '}
                  <span className="font-semibold">{Math.min(total, page * pageSize)}</span> of{' '}
                  <span className="font-semibold">{total}</span> consignments
                  {workflowFilter ? ` · ${WORKFLOW_BUCKET_LABELS[workflowFilter] || workflowFilter}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={pageSize}
                  onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
                  className="inp py-1 px-2 text-xs w-auto bg-white border border-slate-300 rounded"
                >
                  <option value={25}>25 per page</option>
                  <option value={50}>50 per page</option>
                  <option value={100}>100 per page</option>
                </select>
                <nav className="relative z-0 inline-flex rounded-md shadow-sm -space-x-px" aria-label="Pagination">
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                    className="relative inline-flex items-center px-3 py-1.5 rounded-l-md border border-slate-300 bg-white text-xs font-medium text-slate-500 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Previous
                  </button>
                  <span className="relative inline-flex items-center px-3 py-1.5 border-t border-b border-slate-300 bg-slate-50 text-xs font-medium text-slate-700">
                    Page {page}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPage((p) => (hasMore ? p + 1 : p))}
                    disabled={!hasMore}
                    className="relative inline-flex items-center px-3 py-1.5 rounded-r-md border border-slate-300 bg-white text-xs font-medium text-slate-500 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Next
                  </button>
                </nav>
              </div>
            </div>
          </div>
        )}
      </div>
      )}

      {/* Create modal — portaled, scroll-locked */}
      <Modal
        open={showCreate}
        onClose={closeCreateModal}
        title="Create New Consignment"
        subtitle={<>Fields marked <span className="text-red-500">*</span> are required · IDs must be unique</>}
        size="xl"
        footer={
          <div className="flex justify-end gap-3">
            <button type="button" onClick={closeCreateModal} className="px-5 py-2.5 border border-slate-200 rounded-lg text-slate-700 hover:bg-slate-50 text-sm" disabled={isSubmitting}>Cancel</button>
            <button type="submit" form="create-consignment-form" disabled={isSubmitting} className="px-5 py-2.5 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 flex items-center gap-2 text-sm font-medium">
              {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
              Create Consignment
            </button>
          </div>
        }
      >
        <form id="create-consignment-form" onSubmit={handleCreate} className="p-4 sm:p-5 space-y-4">
              {/* Identity + portal */}
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Package className="w-4 h-4 text-primary-600" />
                  <h3 className="text-sm font-semibold text-slate-800">Shipment</h3>
                </div>

                <div className="rounded-lg border border-amber-100 bg-amber-50/70 px-3 py-2 text-[11px] text-amber-900">
                  Consignment ID and Internal Shipment No. must be unique — including archived consignments.
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                      Internal Shipment No. <span className="text-primary-600">*</span>
                    </label>
                    <input type="text" required autoFocus value={form.internalShipmentNo} onChange={e=>setForm({...form,internalShipmentNo:e.target.value})} className="inp" placeholder="e.g. 6605JVXH" />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                      Consignment ID <span className="text-slate-400 font-normal normal-case">(optional)</span>
                    </label>
                    <input type="text" value={form.id} onChange={e=>setForm({...form,id:e.target.value})} className="inp" placeholder="Blank → uses Internal Shipment No." />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                      Marketplace <span className="text-primary-600">*</span>
                    </label>
                    <select required value={form.marketplaceId} onChange={e=>setForm(applyDispatchToForm({...form,marketplaceId:e.target.value,warehouse:''}, marketplaces))} className="inp bg-white">
                      <option value="">Select portal</option>
                      {marketplaces.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">Warehouse</label>
                    {form.marketplaceId && getMpWarehouses(form.marketplaceId).length===0 ? (
                      <div className="inp bg-slate-50 text-slate-400 text-xs flex items-center justify-between h-[38px]">
                        No warehouses
                        <button
                          type="button"
                          className="text-primary-600 hover:text-primary-700 underline font-bold"
                          onClick={() => { closeCreateModal(); navigate('/marketplaces'); }}
                        >
                          Add +
                        </button>
                      </div>
                    ) : (
                      <select value={form.warehouse} onChange={e=>setForm(applyDispatchToForm({...form,warehouse:e.target.value}, marketplaces))} disabled={!form.marketplaceId} className="inp bg-white disabled:bg-slate-50 disabled:text-slate-400">
                        <option value="">Select warehouse</option>
                        {getMpWarehouses(form.marketplaceId).map(w=><option key={w.name} value={w.name}>{w.name}{w.transitDays ? ` (${w.transitDays}d)` : ''}</option>)}
                      </select>
                    )}
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">Appointment Date</label>
                    <input type="date" value={form.appointmentDate} onChange={e=>setForm(applyDispatchToForm({...form,appointmentDate:e.target.value}, marketplaces))} className="inp" />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                      Required Dispatch <span className="font-normal text-[10px] text-slate-400 normal-case">(auto)</span>
                    </label>
                    <input type="date" value={form.scheduledDispatchDate} readOnly className="inp bg-slate-50 text-slate-500" title="Appointment − warehouse transit days" />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">Expected Date</label>
                    <input type="date" value={form.expectedDate} onChange={e=>setForm({...form,expectedDate:e.target.value})} className="inp" />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">PO Expiry</label>
                    <input type="date" value={form.poExpiryDate} onChange={e=>setForm({...form,poExpiryDate:e.target.value})} className="inp" />
                  </div>
                </div>
              </div>

              {/* Advanced (collapsible) */}
              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <button type="button" onClick={()=>setShowAdvanced(a=>!a)}
                  className="w-full flex items-center justify-between px-3.5 py-2.5 bg-slate-50 hover:bg-slate-100/70 transition-colors text-xs font-semibold text-slate-700">
                  <span>More details <span className="font-normal text-slate-400">(docket, invoice, status, units)</span></span>
                  {showAdvanced ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
                </button>
                {showAdvanced && (
                  <div className="p-3.5 grid grid-cols-2 md:grid-cols-4 gap-3 border-t border-slate-100">
                    <div>
                      <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">Shipment Status</label>
                      <select value={form.shipmentStatus} onChange={e=>setForm({...form,shipmentStatus:e.target.value})} className="inp bg-white">
                        <option>Planned</option>
                        <option>Scheduled</option>
                        <option>Under Packing</option>
                        <option>Ready</option>
                        <option>In Transit</option>
                        <option>Forwarded</option>
                        <option>Inwarded</option>
                        <option>Missed</option>
                      </select>
                    </div>
                    <div><label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">Docket Company</label><select value={form.docketCompany} onChange={e=>setForm({...form,docketCompany:e.target.value})} className="inp bg-white"><option value="">Select</option>{docketCompanies.map(dc=><option key={dc.id} value={dc.name}>{dc.name}</option>)}</select></div>
                    <div><label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">Docket No</label><input type="text" value={form.docketNo} onChange={e=>setForm({...form,docketNo:e.target.value})} className="inp" placeholder="DK-12345" /></div>
                    <div><label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">Forward Invoice No.</label><input type="text" value={form.forwardInvoiceNo} onChange={e=>setForm({...form,forwardInvoiceNo:e.target.value})} className="inp" placeholder="INV-12345" /></div>
                    <div><label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">Marketplace Ticket ID</label><input type="text" value={form.marketplaceTicketId} onChange={e=>setForm({...form,marketplaceTicketId:e.target.value})} className="inp" placeholder="Optional" /></div>
                    <label className="flex items-center gap-2 text-sm text-slate-700 border border-slate-200 rounded-lg px-3 py-2"><input type="checkbox" checked={!!form.isDisputed} onChange={e=>setForm({...form,isDisputed:e.target.checked})} /> Disputed (protect videos)</label>
                    <div><label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">Actual Dispatch</label><input type="date" value={form.actualDispatchDate} onChange={e=>setForm({...form,actualDispatchDate:e.target.value})} className="inp" /></div>
                    <div><label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">Date of Inward</label><input type="date" value={form.dateOfInward} onChange={e=>setForm({...form,dateOfInward:e.target.value})} className="inp" /></div>
                    <div><label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">Units Shipped</label><input type="number" min="0" value={form.unitsShipped} onChange={e=>setForm({...form,unitsShipped:e.target.value})} className="inp" placeholder="0" /></div>
                    <div><label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">Units Received</label><input type="number" min="0" value={form.unitsReceived} onChange={e=>setForm({...form,unitsReceived:e.target.value})} className="inp" placeholder="0" /></div>
                    <div><label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">Units Inwarded</label><input type="number" min="0" value={form.unitsInwarded} onChange={e=>setForm({...form,unitsInwarded:e.target.value})} className="inp" placeholder="0" /></div>
                    <div><label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">QA Fail / Excess</label><input type="number" min="0" value={form.qaFailExcessQty} onChange={e=>setForm({...form,qaFailExcessQty:e.target.value})} className="inp" placeholder="0" /></div>
                  </div>
                )}
              </div>

              {/* SKU Items */}
              <div className="space-y-3">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2">
                    <LayoutList className="w-4 h-4 text-primary-600" />
                    <div>
                      <h3 className="text-sm font-semibold text-slate-800">SKU Items</h3>
                      <p className="text-[10px] text-slate-400">Marketplace barcode is required for scanning</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button type="button" onClick={async () => { try { const r = await templatesAPI.downloadConsignment(); const url = URL.createObjectURL(new Blob([r.data])); const a = document.createElement('a'); a.href = url; a.download = 'sku_template.csv'; a.click(); } catch(e){ addToast('Download failed','error'); } }} className="flex items-center gap-1 text-xs text-slate-600 hover:text-primary-700 font-medium px-2 py-1.5 rounded-md border border-slate-200 hover:bg-slate-50">
                      <Download className="w-3.5 h-3.5" />Template
                    </button>
                    <label className="flex items-center gap-1 text-xs text-slate-600 hover:text-primary-700 font-medium px-2 py-1.5 rounded-md border border-slate-200 hover:bg-slate-50 cursor-pointer">
                      <Upload className="w-3.5 h-3.5" />CSV
                      <input type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={handleCsvUpload} />
                    </label>
                    <button type="button" onClick={addSku} className="inline-flex items-center gap-1 text-xs bg-primary-600 hover:bg-primary-700 text-white font-medium px-2.5 py-1.5 rounded-md">
                      <Plus className="w-3.5 h-3.5" />Add row
                    </button>
                  </div>
                </div>

                {form.skus.length > 0 && (
                  <p className="text-[11px] text-slate-500">
                    <strong className="text-slate-700">{form.skus.length}</strong> SKU row{form.skus.length === 1 ? '' : 's'} · use exact marketplace barcode for packing scans
                  </p>
                )}

                <div className="hidden md:grid grid-cols-[minmax(0,1.2fr)_7rem_minmax(0,1fr)_minmax(0,1fr)_5.5rem_2rem] gap-2 px-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                  <span>Marketplace Barcode</span>
                  <span>Type</span>
                  <span>Marketplace SKU</span>
                  <span>Internal SKU</span>
                  <span>Qty</span>
                  <span />
                </div>

                <div className="space-y-2 max-h-64 overflow-y-auto pr-0.5">
                  {form.skus.map((sku,i)=> {
                    const inputClass = (isMono = false) => `min-w-0 w-full px-2.5 py-1.5 border rounded-lg text-sm outline-none ${isMono ? 'font-mono' : ''} border-slate-200 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/15`;

                    return (
                      <div key={`sku-${i}-${getScanBarcode(sku) || sku.marketplaceSku || i}`} className="grid grid-cols-1 md:grid-cols-[minmax(0,1.2fr)_7rem_minmax(0,1fr)_minmax(0,1fr)_5.5rem_2rem] gap-2 items-center border md:border-0 border-slate-100 rounded-lg p-2 md:p-0">
                        <input type="text" value={sku.marketplaceBarcode || sku.barcode || ''} onChange={e=>updateSku(i,'marketplaceBarcode',e.target.value)} className={inputClass(true)} placeholder="FNSKU / FSN / ASIN" />
                        <input type="text" value={sku.marketplaceBarcodeType || ''} onChange={e=>updateSku(i,'marketplaceBarcodeType',e.target.value)} className={inputClass(true)} placeholder="FNSKU" />
                        <input type="text" value={sku.marketplaceSku} onChange={e=>updateSku(i,'marketplaceSku',e.target.value)} className={inputClass(false)} placeholder="Marketplace SKU" />
                        <input type="text" value={sku.internalSku} onChange={e=>updateSku(i,'internalSku',e.target.value)} className={inputClass(false)} placeholder="OMS SKU" />
                        <div className="flex gap-1.5 items-center">
                          <input type="number" value={sku.requiredQty} onChange={e=>updateSku(i,'requiredQty',e.target.value)} className={inputClass(false)} placeholder="Qty" min="0" />
                          {form.skus.length>1 && (
                            <button type="button" onClick={()=>removeSku(i)} className="md:hidden p-1.5 text-slate-400 hover:text-red-600 rounded" title="Remove row">
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                        {form.skus.length>1 ? (
                          <button type="button" onClick={()=>removeSku(i)} className="hidden md:inline-flex p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded justify-center" title="Remove row">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        ) : <span className="hidden md:block" />}
                      </div>
                    );
                  })}
                </div>
              </div>
        </form>
      </Modal>

      <Modal
        open={showDelete && !!selected}
        onClose={closeDelete}
        title="Delete Consignment"
        subtitle={selected?.internalShipmentNo || selected?.id}
        size="md"
        footer={
          <div className="flex justify-end gap-3">
            <button type="button" onClick={closeDelete} className="px-4 py-2 border border-slate-200 rounded-lg text-slate-700 hover:bg-slate-50 text-sm" disabled={isSubmitting}>Cancel</button>
            <button
              type="button"
              onClick={() => setShowFinalDelete(true)}
              disabled={!deleteConfirmationMatches || isSubmitting}
              className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 text-sm font-semibold"
            >
              <Trash2 className="w-4 h-4" />
              Delete
            </button>
          </div>
        }
      >
        <div className="p-5 space-y-4">
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-600 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-red-900">This action is irreversible.</p>
              <p className="text-xs text-red-700 mt-1 leading-relaxed">
                Deletion permanently removes the consignment, SKUs, boxes, packing scans, shipment records, upload metadata, and related Cloudflare R2 files.
              </p>
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <div className="grid grid-cols-[110px_1fr] gap-y-1">
              <span className="font-semibold text-slate-500">Consignment ID</span>
              <span className="font-mono text-slate-900">{selected?.id}</span>
              <span className="font-semibold text-slate-500">Name</span>
              <span className="text-slate-900">{selected?.name || selected?.internalShipmentNo || '-'}</span>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Type the Consignment ID or Name to enable deletion
            </label>
            <input
              type="text"
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              className="inp font-mono"
              placeholder={selected?.id || 'Consignment ID'}
              autoComplete="off"
            />
          </div>
        </div>
      </Modal>

      <ConfirmModal
        show={showFinalDelete && !!selected}
        title="Final confirmation"
        message={<>Permanently delete <strong>{selected?.internalShipmentNo || selected?.id}</strong> and all related data?</>}
        confirmLabel="Permanently Delete"
        loading={isSubmitting}
        onConfirm={handleDelete}
        onCancel={() => { if (!isSubmitting) setShowFinalDelete(false); }}
      />
    </div>
  );
}
