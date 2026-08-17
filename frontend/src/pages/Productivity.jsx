import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router';
import {
  BarChart3, Boxes, Package, Clock, TrendingUp, Activity,
  User, Calendar, Download, RefreshCw, CheckCircle2, AlertCircle,
  FileSpreadsheet, ChevronRight, Layers, ClipboardList, Factory, Award
} from 'lucide-react';
import { productivityAPI, consignmentsAPI } from '../services/api';
import { useConsignmentSync, mergeConsignmentChanges } from '../context/ConsignmentSyncContext';
import { format, subDays, startOfWeek, endOfWeek, startOfMonth, endOfMonth } from 'date-fns';
import { getShipmentPriority, formatDispatchDate } from '../utils/priority';
import ProductivityReportsTab from '../components/ProductivityReportsTab';
import { ProductivitySkeleton } from '../components/Skeleton';
import { TrendChart, BarList, SegmentedBar } from '../components/charts';
import { STATUS_HEX, formatCompactNumber } from '../utils/chartColors';

const PRODUCTIVITY_CACHE_KEY = 'productivity_page_cache';
const PRODUCTIVITY_CACHE_MS = 45_000;

// ── Quick date presets ────────────────────────────────────────────────────────
const PRESETS = [
  { label: 'Today',       getRange: () => { const d = format(new Date(), 'yyyy-MM-dd'); return { start: d, end: d }; } },
  { label: 'Yesterday',   getRange: () => { const d = format(subDays(new Date(), 1), 'yyyy-MM-dd'); return { start: d, end: d }; } },
  { label: 'This Week',   getRange: () => ({ start: format(startOfWeek(new Date(), { weekStartsOn: 1 }), 'yyyy-MM-dd'), end: format(endOfWeek(new Date(), { weekStartsOn: 1 }), 'yyyy-MM-dd') }) },
  { label: 'Last 7 Days', getRange: () => ({ start: format(subDays(new Date(), 6), 'yyyy-MM-dd'), end: format(new Date(), 'yyyy-MM-dd') }) },
  { label: 'This Month',  getRange: () => ({ start: format(startOfMonth(new Date()), 'yyyy-MM-dd'), end: format(endOfMonth(new Date()), 'yyyy-MM-dd') }) },
];

const KPI_STYLES = {
  primary: { bg: 'bg-primary-100', text: 'text-primary-600' },
  blue: { bg: 'bg-blue-100', text: 'text-blue-600' },
  amber: { bg: 'bg-amber-100', text: 'text-amber-600' },
  emerald: { bg: 'bg-emerald-100', text: 'text-emerald-600' },
  orange: { bg: 'bg-orange-100', text: 'text-orange-600' },
  red: { bg: 'bg-red-100', text: 'text-red-600' },
};

const actionColor = (action) => ({
  create: 'bg-emerald-100 text-emerald-800',
  update: 'bg-blue-100 text-blue-800',
  delete: 'bg-red-100 text-red-800',
  pack: 'bg-amber-100 text-amber-800',
  save_box: 'bg-amber-100 text-amber-800',
  upload: 'bg-cyan-100 text-cyan-800',
  login: 'bg-primary-100 text-primary-800',
  finish: 'bg-emerald-100 text-emerald-800',
}[action] || 'bg-slate-100 text-slate-800');

const Productivity = () => {
  const initialCache = (() => {
    try {
      const cached = JSON.parse(sessionStorage.getItem(PRODUCTIVITY_CACHE_KEY) || 'null');
      if (cached?.savedAt && Date.now() - cached.savedAt < PRODUCTIVITY_CACHE_MS) return cached;
    } catch {
      // ignore corrupt cache
    }
    return null;
  })();

  const [stats,       setStats]       = useState(initialCache?.data?.stats || null);
  const [auditLogs,   setAuditLogs]   = useState(initialCache?.data?.auditLogs || []);
  const [consignments,setConsignments]= useState(initialCache?.data?.consignments || []);
  const [initialLoading, setInitialLoading] = useState(!initialCache);
  const [secondaryLoading, setSecondaryLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [activePreset,setActivePreset]= useState('Today');
  const [dateRange,   setDateRange]   = useState(PRESETS[0].getRange());
  const [lastRefresh, setLastRefresh] = useState(initialCache ? new Date(initialCache.savedAt) : new Date());
  // Production planning
  const [planning,    setPlanning]    = useState(initialCache?.data?.planning || null);
  const [planTab,     setPlanTab]     = useState('consignment'); // 'consignment' | 'sku'
  const [expandedRow, setExpandedRow] = useState(null);
  const [pageTab,     setPageTab]     = useState('dashboard'); // 'dashboard' | 'reports'
  const { pendingChanges } = useConsignmentSync();

  const loading = initialLoading || secondaryLoading;

  const persistCache = useCallback((payload) => {
    sessionStorage.setItem(PRODUCTIVITY_CACHE_KEY, JSON.stringify({
      savedAt: Date.now(),
      data: payload,
    }));
  }, []);

  // ── Fetch ─────────────────────────────────────────────────────────────────
  const fetchData = useCallback(async (range, { background = false } = {}) => {
    const r = range || dateRange;
    const hasCachedCore = Boolean(stats && planning);

    if (!background && !hasCachedCore) setInitialLoading(true);
    else if (background) setRefreshing(true);
    else setSecondaryLoading(true);

    try {
      const [prodRes, planRes] = await Promise.all([
        productivityAPI.getStats({ startDate: r.start, endDate: r.end, limit: 100 }),
        productivityAPI.getPlanning(),
      ]);
      setStats(prodRes.data);
      setPlanning(planRes.data);
      setLastRefresh(new Date());

      const corePayload = {
        stats: prodRes.data,
        planning: planRes.data,
        auditLogs,
        consignments,
      };
      persistCache(corePayload);

      setSecondaryLoading(true);
      const [auditRes, conRes] = await Promise.all([
        productivityAPI.getAuditLogs({ limit: 100 }),
        consignmentsAPI.getAll({ limit: 200 }),
      ]);
      setAuditLogs(auditRes.data.logs || []);
      setConsignments(conRes.data.consignments || []);
      persistCache({
        stats: prodRes.data,
        planning: planRes.data,
        auditLogs: auditRes.data.logs || [],
        consignments: conRes.data.consignments || [],
      });
    } catch (e) {
      console.error('Productivity fetch error', e);
    } finally {
      setInitialLoading(false);
      setSecondaryLoading(false);
      setRefreshing(false);
    }
  }, [dateRange, stats, planning, auditLogs, consignments, persistCache]);

  useEffect(() => { fetchData(undefined, { background: Boolean(initialCache) }); }, []);

  useEffect(() => {
    if (!pendingChanges.length) return;
    setConsignments((prev) => mergeConsignmentChanges(prev, pendingChanges));
  }, [pendingChanges]);

  const applyPreset = (preset) => {
    const r = preset.getRange();
    setActivePreset(preset.label);
    setDateRange(r);
    fetchData(r);
  };

  // ── Derived stats ─────────────────────────────────────────────────────────
  const completedToday = useMemo(() => consignments.filter(c =>
    c.status === 'completed' &&
    c.updatedAt && new Date(c.updatedAt).toDateString() === new Date().toDateString()
  ).length, [consignments]);

  const inProgress = planning?.summary?.inProgressConsignments
    ?? consignments.filter(c => c.status === 'in_progress').length;
  const pending = planning?.summary?.pendingStatusConsignments
    ?? consignments.filter(c => c.status === 'pending').length;

  const byConsignment = useMemo(() => {
    const map = {};
    (stats?.recentActivity || []).filter(r => r.eventType === 'box_saved').forEach(r => {
      if (!map[r.consignmentId]) map[r.consignmentId] = { boxes: 0, items: 0 };
      map[r.consignmentId].boxes++;
      map[r.consignmentId].items += r.itemsCount || 0;
    });
    return map;
  }, [stats]);

  const conRows = useMemo(() => Object.entries(byConsignment)
    .sort((a, b) => b[1].boxes - a[1].boxes)
    .slice(0, 15), [byConsignment]);

  const packingActivityItems = useMemo(() => conRows.map(([cid, data]) => ({
    key: cid,
    label: cid,
    value: data.boxes,
    sublabel: `${data.items} items`,
  })), [conRows]);

  const topPackerItems = useMemo(() => (stats?.topPackers || []).map((p) => ({
    key: p.userId,
    label: p.userName || p.userId,
    value: p.boxes,
    sublabel: `${p.items} items`,
  })), [stats]);

  const dailyTrendData = useMemo(() => (stats?.dailyTrend || []).map((d) => ({
    label: d.label,
    value: d.boxes,
  })), [stats]);

  const statusSnapshot = useMemo(() => {
    const total = planning?.summary?.totalConsignments || consignments.length;
    const completed = planning?.summary?.completedConsignments
      ?? consignments.filter(c => c.status === 'completed').length;
    const inProgressCount = inProgress;
    const pendingCount = pending;
    return { total, completed, inProgress: inProgressCount, pending: pendingCount };
  }, [planning, consignments, inProgress, pending]);

  // ── Export CSV ────────────────────────────────────────────────────────────
  const exportCsv = () => {
    const headers = ['Consignment ID', 'Internal Shipment No', 'Status', 'Ship Status',
      'Total Required', 'Total Packed', 'Boxes', 'Progress %'];
    const rows = consignments.map(c => {
      const pct = c.totalRequiredQty > 0 ? Math.round((c.totalPackedQty / c.totalRequiredQty) * 100) : 0;
      return [c.id, c.internalShipmentNo || '', c.status || '', c.shipmentStatus || '',
        c.totalRequiredQty || 0, c.totalPackedQty || 0, c.boxIds?.length || 0, pct + '%'];
    });
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a   = document.createElement('a');
    a.href    = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download= `productivity_${format(new Date(), 'yyyy-MM-dd')}.csv`;
    a.click();
  };

  const exportPlanningCsv = () => {
    if (!planning) return;
    let headers, rows, fname;
    if (planTab === 'sku') {
      headers = ['Internal SKU', 'Marketplace SKU', 'Barcode', 'Total Required', 'Total Packed', 'Total Pending', 'Pending In (Consignments)'];
      rows = planning.bySku.map(s => [
        s.internalSku, s.marketplaceSku, s.barcode, s.totalRequired, s.totalPacked, s.totalPending,
        s.consignments.map(c => `${c.internalShipmentNo}(${c.pending})`).join(' | ')
      ]);
      fname = 'sku_pending_report';
    } else {
      headers = ['Consignment', 'Internal Shipment No', 'Status', 'Required', 'Packed', 'Pending', 'Pending SKUs'];
      rows = planning.byConsignment.map(c => [
        c.id, c.internalShipmentNo, c.status, c.required, c.packed, c.pending, c.pendingSkuCount
      ]);
      fname = 'consignment_pending_report';
    }
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `${fname}_${format(new Date(), 'yyyy-MM-dd')}.csv`;
    a.click();
  };

  const exportAuditCsv = () => {
    const headers = ['Timestamp', 'Action', 'Entity Type', 'Entity ID', 'User'];
    const rows    = auditLogs.map(l => [
      format(new Date(l.timestamp), 'dd/MM/yyyy HH:mm:ss'),
      l.action, l.entityType, l.entityId, l.userId
    ]);
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a   = document.createElement('a');
    a.href    = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download= `audit_${format(new Date(), 'yyyy-MM-dd')}.csv`;
    a.click();
  };

  // ── Render ────────────────────────────────────────────────────────────────
  if (initialLoading && !stats && !planning) {
    return <ProductivitySkeleton />;
  }

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-6 gap-3">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Productivity & Reports</h1>
          <p className="text-slate-500 mt-1 text-sm">
            Last refreshed: {format(lastRefresh, 'h:mm:ss a')}
            {refreshing ? ' · updating…' : secondaryLoading ? ' · loading details…' : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => fetchData()} disabled={loading || refreshing}
            className="flex items-center gap-1.5 px-3 py-2 border border-slate-200 rounded-lg text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50">
            <RefreshCw className={`w-4 h-4 ${loading || refreshing ? 'animate-spin' : ''}`} /> Refresh
          </button>
          {pageTab === 'dashboard' && (
            <button onClick={exportCsv}
              className="flex items-center gap-1.5 px-3 py-2 border border-slate-200 rounded-lg text-sm text-slate-600 hover:bg-slate-50">
              <Download className="w-4 h-4" /> Export CSV
            </button>
          )}
        </div>
      </div>

      {/* Main page tabs */}
      <div className="flex gap-1 bg-slate-100 rounded-xl p-1 mb-6 w-fit">
        <button onClick={() => setPageTab('dashboard')}
          className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors flex items-center gap-2 ${
            pageTab === 'dashboard' ? 'bg-white text-primary-700 shadow-sm' : 'text-slate-600 hover:text-slate-800'
          }`}>
          <BarChart3 className="w-4 h-4" /> Dashboard
        </button>
        <button onClick={() => setPageTab('reports')}
          className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors flex items-center gap-2 ${
            pageTab === 'reports' ? 'bg-white text-primary-700 shadow-sm' : 'text-slate-600 hover:text-slate-800'
          }`}>
          <FileSpreadsheet className="w-4 h-4" /> Reports
        </button>
      </div>

      {/* Date preset tabs — shared by Dashboard & Reports */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-3 mb-6">
        <div className="flex flex-wrap gap-2 items-center">
          {PRESETS.map(p => (
            <button key={p.label} onClick={() => applyPreset(p)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                activePreset === p.label
                  ? 'bg-primary-600 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}>
              {p.label}
            </button>
          ))}
          <div className="h-5 w-px bg-slate-200 mx-1" />
          <div className="flex items-center gap-2 text-sm">
            <input type="date" value={dateRange.start}
              onChange={e => setDateRange(r => ({ ...r, start: e.target.value }))}
              className="px-3 py-1.5 border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-primary-500 text-sm" />
            <span className="text-slate-400">→</span>
            <input type="date" value={dateRange.end}
              onChange={e => setDateRange(r => ({ ...r, end: e.target.value }))}
              className="px-3 py-1.5 border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-primary-500 text-sm" />
            <button onClick={() => { setActivePreset('Custom'); fetchData(); }}
              className="px-3 py-1.5 bg-primary-600 text-white rounded-lg text-sm hover:bg-primary-700">
              Apply
            </button>
          </div>
        </div>
      </div>

      {pageTab === 'reports' && (
        <ProductivityReportsTab
          loading={loading}
          dateRange={dateRange}
          activePreset={activePreset}
          stats={stats}
          consignments={consignments}
          planning={planning}
          auditLogs={auditLogs}
        />
      )}

      {pageTab === 'dashboard' && (<>

      {/* Shipment criticality KPIs */}
      {planning?.summary && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
          {[
            { label: 'Critical', value: planning.summary.criticalShipments ?? 0, className: 'text-red-600', bg: 'bg-red-50 border-red-100' },
            { label: 'High Priority', value: planning.summary.highPriorityShipments ?? 0, className: 'text-orange-600', bg: 'bg-orange-50 border-orange-100' },
            { label: 'Delayed', value: planning.summary.delayedShipments ?? 0, className: 'text-rose-600', bg: 'bg-rose-50 border-rose-100' },
            { label: 'Open Shipments', value: planning.summary.openConsignments ?? 0, className: 'text-primary-600', bg: 'bg-primary-50 border-primary-100' },
            { label: 'Pending Units', value: planning.summary.totalPendingQty?.toLocaleString() ?? 0, className: 'text-amber-600', bg: 'bg-amber-50 border-amber-100' },
          ].map(({ label, value, className, bg }) => (
            <div key={label} className={`rounded-xl border p-4 ${bg}`}>
              <p className={`text-2xl font-bold ${className}`}>{loading ? '…' : value}</p>
              <p className="text-xs font-medium text-slate-500 mt-1">{label}</p>
            </div>
          ))}
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-4 mb-6">
        {[
          { icon: Boxes,        color: 'primary', label: 'Boxes Today',      value: stats?.today?.boxes ?? '—' },
          { icon: Package,      color: 'blue',    label: 'Items Today',       value: stats?.today?.items ?? '—' },
          { icon: TrendingUp,   color: 'amber',  label: 'Avg Items/Box',     value: stats?.summary?.avgItemsPerBox ?? '—' },
          { icon: Clock,        color: 'amber',   label: 'Avg Time/Box',      value: stats?.summary?.avgTimePerBoxSeconds ? `${stats.summary.avgTimePerBoxSeconds}s` : '—' },
          { icon: CheckCircle2, color: 'emerald', label: 'Completed Today',   value: completedToday },
          { icon: Activity,     color: 'orange',  label: 'In Progress',       value: inProgress },
          { icon: AlertCircle,  color: 'red',     label: 'Pending',           value: pending },
        ].map(({ icon: Icon, color, label, value }) => {
          const styles = KPI_STYLES[color] || KPI_STYLES.primary
          return (
          <div key={label} className="bg-white rounded-xl p-4 shadow-sm border border-slate-100">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center mb-2 ${styles.bg}`}>
              <Icon className={`w-4 h-4 ${styles.text}`} />
            </div>
            <p className="text-2xl font-bold text-slate-900">{loading ? '…' : value}</p>
            <p className="text-xs text-slate-500 mt-0.5">{label}</p>
          </div>
        )})}
      </div>

      {/* Daily Trend */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-6 mb-6">
        <div className="flex items-center gap-2 mb-1">
          <TrendingUp className="w-5 h-5 text-primary-600" />
          <h2 className="text-base font-semibold text-slate-900">Boxes Packed Trend — {activePreset}</h2>
        </div>
        <p className="text-xs text-slate-400 mb-1">Daily box-save volume across the selected date range</p>
        <TrendChart data={dailyTrendData} color="#E11D48" valueLabel="boxes" height={200} />
      </div>

      {/* ═══ PRODUCTION PLANNING ═══ */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-100 mb-6 overflow-hidden">
        {/* Section header */}
        <div className="px-5 py-4 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-gradient-to-r from-primary-50/50 to-transparent">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 bg-primary-100 rounded-xl flex items-center justify-center">
              <Factory className="w-5 h-5 text-primary-600" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900">Production Planning</h2>
              <p className="text-[11px] text-slate-400">What's left to pack — for the production team to plan</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Sub-tab toggle */}
            <div className="flex bg-slate-100 rounded-lg p-0.5">
              <button onClick={() => { setPlanTab('consignment'); setExpandedRow(null); }}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors flex items-center gap-1.5 ${planTab==='consignment'?'bg-white text-primary-600 shadow-sm':'text-slate-500'}`}>
                <ClipboardList className="w-3.5 h-3.5" /> By Consignment
              </button>
              <button onClick={() => { setPlanTab('sku'); setExpandedRow(null); }}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors flex items-center gap-1.5 ${planTab==='sku'?'bg-white text-primary-600 shadow-sm':'text-slate-500'}`}>
                <Layers className="w-3.5 h-3.5" /> By SKU
              </button>
            </div>
            <button onClick={exportPlanningCsv} className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-50">
              <Download className="w-3.5 h-3.5" /> Export
            </button>
          </div>
        </div>

        {/* Planning summary strip */}
        {planning && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-slate-100 border-b border-slate-100">
            {[
              { label: 'Open Consignments', value: planning.summary.openConsignments, color: 'text-primary-600' },
              { label: 'Total Pending Units', value: planning.summary.totalPendingQty?.toLocaleString(), color: 'text-amber-600' },
              { label: 'Total Packed Units', value: planning.summary.totalPackedQty?.toLocaleString(), color: 'text-emerald-600' },
              { label: 'Unique Pending SKUs', value: planning.summary.uniquePendingSkus, color: 'text-rose-600' },
            ].map(s => (
              <div key={s.label} className="bg-white px-4 py-3">
                <p className={`text-xl font-bold ${s.color}`}>{s.value ?? 0}</p>
                <p className="text-[10px] uppercase tracking-wider text-slate-400 mt-0.5">{s.label}</p>
              </div>
            ))}
          </div>
        )}

        {/* ── By Consignment ── */}
        {planTab === 'consignment' && (
          <div className="overflow-x-auto max-h-[420px]">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 sticky top-0 z-[1]">
                <tr>
                  <th className="text-left px-4 py-2.5 text-slate-500 font-semibold uppercase">Consignment</th>
                  <th className="text-left px-3 py-2.5 text-slate-500 font-semibold uppercase">Criticality</th>
                  <th className="text-left px-3 py-2.5 text-slate-500 font-semibold uppercase">Dispatch</th>
                  <th className="text-left px-3 py-2.5 text-slate-500 font-semibold uppercase">Status</th>
                  <th className="text-right px-3 py-2.5 text-slate-500 font-semibold uppercase">Required</th>
                  <th className="text-right px-3 py-2.5 text-slate-500 font-semibold uppercase">Packed</th>
                  <th className="text-right px-3 py-2.5 text-slate-500 font-semibold uppercase">Pending</th>
                  <th className="text-right px-3 py-2.5 text-slate-500 font-semibold uppercase">Pending SKUs</th>
                  <th className="px-3 py-2.5"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {loading ? (
                  <tr><td colSpan="9" className="py-8 text-center text-slate-400">Loading…</td></tr>
                ) : planning?.byConsignment?.length > 0 ? planning.byConsignment.map(c => {
                  const open = expandedRow === c.id;
                  const p = getShipmentPriority(c);
                  const pct = c.required > 0 ? Math.round((c.packed / c.required) * 100) : 0;
                  const skusOfC = planning.pendingSkusByConsignmentId?.[c.id]
                    || (planning.bySku || []).map(s => {
                      const m = s.consignments.find(x => x.id === c.id);
                      return m ? { ...s, _c: m } : null;
                    }).filter(Boolean);
                  return (
                    <React.Fragment key={c.id}>
                      <tr className="hover:bg-primary-50/40 cursor-pointer" onClick={() => setExpandedRow(open ? null : c.id)}>
                        <td className="px-4 py-2.5 font-semibold text-slate-800">{c.internalShipmentNo}</td>
                        <td className="px-3 py-2.5">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold border ${p.badgeClass}`}>{p.label}</span>
                          <p className="text-[10px] text-slate-400 mt-0.5">{pct}% packed</p>
                        </td>
                        <td className="px-3 py-2.5 text-slate-600 whitespace-nowrap">{formatDispatchDate(c.requiredDispatchDate || c.scheduledDispatchDate)}</td>
                        <td className="px-3 py-2.5">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${c.status==='in_progress'?'bg-blue-100 text-blue-700':'bg-amber-100 text-amber-700'}`}>{c.status?.replace('_',' ')}</span>
                        </td>
                        <td className="px-3 py-2.5 text-right text-slate-600">{c.required}</td>
                        <td className="px-3 py-2.5 text-right text-emerald-600 font-medium">{c.packed}</td>
                        <td className="px-3 py-2.5 text-right text-amber-600 font-bold">{c.pending}</td>
                        <td className="px-3 py-2.5 text-right text-slate-600">{c.pendingSkuCount}</td>
                        <td className="px-3 py-2.5 text-right">
                          <ChevronRight className={`w-4 h-4 text-slate-400 inline transition-transform ${open?'rotate-90':''}`} />
                        </td>
                      </tr>
                      {open && (
                        <tr className="bg-slate-50/60">
                          <td colSpan="9" className="px-4 py-3">
                            <div className="flex items-center justify-between mb-2">
                              <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Pending SKUs in {c.internalShipmentNo}</p>
                              <Link to={`/consignments/${c.id}`} className="text-[11px] text-primary-600 hover:underline font-medium">Open consignment →</Link>
                            </div>
                            {skusOfC.length > 0 ? (
                              <div className="rounded-lg border border-slate-200 overflow-hidden bg-white">
                                <table className="w-full text-[11px]">
                                  <thead className="bg-slate-50"><tr>
                                    <th className="text-left px-3 py-1.5 text-slate-400 font-semibold">Internal SKU</th>
                                    <th className="text-left px-3 py-1.5 text-slate-400 font-semibold">Marketplace SKU</th>
                                    <th className="text-right px-3 py-1.5 text-slate-400 font-semibold">Req</th>
                                    <th className="text-right px-3 py-1.5 text-slate-400 font-semibold">Packed</th>
                                    <th className="text-right px-3 py-1.5 text-slate-400 font-semibold">Pending</th>
                                  </tr></thead>
                                  <tbody className="divide-y divide-slate-50">
                                    {skusOfC.map(s => (
                                      <tr key={(s.internalSku || s.marketplaceSku) + (s._c?.pending ?? s.pending)}>
                                        <td className="px-3 py-1.5 font-medium text-slate-700">{s.internalSku || '—'}</td>
                                        <td className="px-3 py-1.5 font-mono text-slate-500">{s.marketplaceSku || '—'}</td>
                                        <td className="px-3 py-1.5 text-right text-slate-600">{s._c?.required ?? s.required}</td>
                                        <td className="px-3 py-1.5 text-right text-emerald-600">{s._c?.packed ?? s.packed}</td>
                                        <td className="px-3 py-1.5 text-right text-amber-600 font-bold">{s._c?.pending ?? s.pending}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            ) : (
                              <p className="text-[11px] text-emerald-600">✅ All SKUs fully packed in this consignment.</p>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                }) : (
                  <tr><td colSpan="9" className="py-8 text-center text-emerald-600">🎉 No pending consignments — everything is packed!</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* ── By SKU ── */}
        {planTab === 'sku' && (
          <div className="overflow-x-auto max-h-[420px]">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 sticky top-0 z-[1]">
                <tr>
                  <th className="text-left px-4 py-2.5 text-slate-500 font-semibold uppercase">Internal SKU (OMS)</th>
                  <th className="text-left px-3 py-2.5 text-slate-500 font-semibold uppercase">Marketplace SKU</th>
                  <th className="text-left px-3 py-2.5 text-slate-500 font-semibold uppercase">Barcode</th>
                  <th className="text-right px-3 py-2.5 text-slate-500 font-semibold uppercase">Required</th>
                  <th className="text-right px-3 py-2.5 text-slate-500 font-semibold uppercase">Packed</th>
                  <th className="text-right px-3 py-2.5 text-slate-500 font-semibold uppercase">Pending</th>
                  <th className="text-right px-3 py-2.5 text-slate-500 font-semibold uppercase"># Consignments</th>
                  <th className="px-3 py-2.5"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {loading ? (
                  <tr><td colSpan="8" className="py-8 text-center text-slate-400">Loading…</td></tr>
                ) : planning?.bySku?.length > 0 ? planning.bySku.map((s, i) => {
                  const key = (s.internalSku || s.marketplaceSku || s.barcode) + i;
                  const open = expandedRow === key;
                  return (
                    <React.Fragment key={key}>
                      <tr className="hover:bg-primary-50/40 cursor-pointer" onClick={() => setExpandedRow(open ? null : key)}>
                        <td className="px-4 py-2.5 font-semibold text-slate-800">{s.internalSku || '—'}</td>
                        <td className="px-3 py-2.5 font-mono text-slate-500">{s.marketplaceSku || '—'}</td>
                        <td className="px-3 py-2.5 font-mono text-slate-400">{s.barcode || '—'}</td>
                        <td className="px-3 py-2.5 text-right text-slate-600">{s.totalRequired}</td>
                        <td className="px-3 py-2.5 text-right text-emerald-600 font-medium">{s.totalPacked}</td>
                        <td className="px-3 py-2.5 text-right text-amber-600 font-bold">{s.totalPending}</td>
                        <td className="px-3 py-2.5 text-right text-slate-600">{s.consignments.length}</td>
                        <td className="px-3 py-2.5 text-right">
                          <ChevronRight className={`w-4 h-4 text-slate-400 inline transition-transform ${open?'rotate-90':''}`} />
                        </td>
                      </tr>
                      {open && (
                        <tr className="bg-slate-50/60">
                          <td colSpan="8" className="px-4 py-3">
                            <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-2">
                              "{s.internalSku || s.marketplaceSku}" is pending in these consignments:
                            </p>
                            <div className="rounded-lg border border-slate-200 overflow-hidden bg-white">
                              <table className="w-full text-[11px]">
                                <thead className="bg-slate-50"><tr>
                                  <th className="text-left px-3 py-1.5 text-slate-400 font-semibold">Consignment</th>
                                  <th className="text-left px-3 py-1.5 text-slate-400 font-semibold">Status</th>
                                  <th className="text-right px-3 py-1.5 text-slate-400 font-semibold">Req</th>
                                  <th className="text-right px-3 py-1.5 text-slate-400 font-semibold">Packed</th>
                                  <th className="text-right px-3 py-1.5 text-slate-400 font-semibold">Pending</th>
                                  <th className="px-3 py-1.5"></th>
                                </tr></thead>
                                <tbody className="divide-y divide-slate-50">
                                  {s.consignments.map(c => (
                                    <tr key={c.id}>
                                      <td className="px-3 py-1.5 font-medium text-slate-700">{c.internalShipmentNo}</td>
                                      <td className="px-3 py-1.5">
                                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${c.status==='in_progress'?'bg-blue-100 text-blue-700':'bg-amber-100 text-amber-700'}`}>{c.status?.replace('_',' ')}</span>
                                      </td>
                                      <td className="px-3 py-1.5 text-right text-slate-600">{c.required}</td>
                                      <td className="px-3 py-1.5 text-right text-emerald-600">{c.packed}</td>
                                      <td className="px-3 py-1.5 text-right text-amber-600 font-bold">{c.pending}</td>
                                      <td className="px-3 py-1.5 text-right"><Link to={`/consignments/${c.id}`} className="text-primary-600 hover:underline">Open →</Link></td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                }) : (
                  <tr><td colSpan="8" className="py-8 text-center text-emerald-600">🎉 No pending SKUs — all packed!</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Consignment Status Overview */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        {/* Per-shipment packing in selected period */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-primary-600" /> Packing Activity
            </h2>
            <span className="text-xs text-slate-400">{activePreset}</span>
          </div>
          <BarList
            items={packingActivityItems}
            color="#E11D48"
            maxItems={8}
            emptyLabel="No packing activity in this period"
          />
        </div>

        {/* Top packers leaderboard */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
              <Award className="w-4 h-4 text-primary-600" /> Top Packers
            </h2>
            <span className="text-xs text-slate-400">{activePreset}</span>
          </div>
          <BarList
            items={topPackerItems}
            color="#3b82f6"
            maxItems={8}
            emptyLabel="No packer activity in this period"
          />
        </div>

        {/* Consignment status breakdown */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-slate-900">Status Snapshot</h2>
            <span className="text-xs text-slate-400">{statusSnapshot.total} total</span>
          </div>
          <SegmentedBar
            segments={[
              { key: 'completed', label: 'Completed', value: statusSnapshot.completed, color: STATUS_HEX.completed },
              { key: 'in_progress', label: 'In Progress', value: statusSnapshot.inProgress, color: STATUS_HEX.inProgress },
              { key: 'pending', label: 'Pending', value: statusSnapshot.pending, color: STATUS_HEX.pending },
            ]}
            valueFormatter={(v) => String(v)}
            height={16}
          />
          <div className="mt-4 pt-3 border-t border-slate-100 text-xs text-slate-500 space-y-1">
            <div className="flex justify-between">
              <span>Total Required</span>
              <span className="font-semibold text-slate-700">
                {formatCompactNumber(planning?.summary?.totalRequiredQty
                  ?? consignments.reduce((s, c) => s + (c.totalRequiredQty || 0), 0))} units
              </span>
            </div>
            <div className="flex justify-between">
              <span>Total Packed</span>
              <span className="font-semibold text-emerald-700">
                {formatCompactNumber(planning?.summary?.totalPackedQty
                  ?? consignments.reduce((s, c) => s + (c.totalPackedQty || 0), 0))} units
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* All Consignments Summary Table */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-100 mb-6 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
            <FileSpreadsheet className="w-4 h-4 text-primary-600" /> All Consignments Summary
          </h2>
          <button onClick={exportCsv}
            className="flex items-center gap-1.5 text-xs text-primary-600 hover:text-primary-700 font-medium">
            <Download className="w-3.5 h-3.5" /> Export CSV
          </button>
        </div>
        <div className="overflow-x-auto max-h-72">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 sticky top-0 z-[1]">
              <tr>
                <th className="text-left px-3 py-2 text-slate-500 font-semibold uppercase whitespace-nowrap">Internal Shipment No</th>
                <th className="text-left px-3 py-2 text-slate-500 font-semibold uppercase whitespace-nowrap">Pack Status</th>
                <th className="text-left px-3 py-2 text-slate-500 font-semibold uppercase whitespace-nowrap">Ship Status</th>
                <th className="text-right px-3 py-2 text-slate-500 font-semibold uppercase whitespace-nowrap">Required</th>
                <th className="text-right px-3 py-2 text-slate-500 font-semibold uppercase whitespace-nowrap">Packed</th>
                <th className="text-right px-3 py-2 text-slate-500 font-semibold uppercase whitespace-nowrap">Boxes</th>
                <th className="text-left px-3 py-2 text-slate-500 font-semibold uppercase whitespace-nowrap">Progress</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {loading ? (
                <tr><td colSpan="7" className="py-6 text-center text-slate-400">Loading…</td></tr>
              ) : consignments.length > 0 ? consignments.map(c => {
                const pct = c.totalRequiredQty > 0 ? Math.round((c.totalPackedQty / c.totalRequiredQty) * 100) : 0;
                return (
                  <tr key={c.id} className="hover:bg-slate-50">
                    <td className="px-3 py-2 font-medium text-slate-800 whitespace-nowrap">{c.internalShipmentNo || c.id}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                        c.status === 'completed' ? 'bg-emerald-100 text-emerald-800' :
                        c.status === 'in_progress' ? 'bg-blue-100 text-blue-800' :
                        'bg-amber-100 text-amber-800'
                      }`}>{c.status?.replace('_', ' ')}</span>
                    </td>
                    <td className="px-3 py-2 text-slate-500 whitespace-nowrap text-[10px]">{c.shipmentStatus || 'Planned'}</td>
                    <td className="px-3 py-2 text-right font-medium text-slate-700">{c.totalRequiredQty || 0}</td>
                    <td className="px-3 py-2 text-right font-medium text-emerald-600">{c.totalPackedQty || 0}</td>
                    <td className="px-3 py-2 text-right text-slate-600">{c.boxIds?.length || 0}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="flex items-center gap-2 min-w-[90px]">
                        <div className="flex-1 bg-slate-200 rounded-full h-1.5">
                          <div className={`h-1.5 rounded-full ${pct >= 100 ? 'bg-emerald-500' : pct > 50 ? 'bg-blue-500' : 'bg-amber-400'}`}
                            style={{ width: `${Math.min(pct, 100)}%` }} />
                        </div>
                        <span className="text-[10px] font-semibold text-slate-600 w-8 text-right">{pct}%</span>
                      </div>
                    </td>
                  </tr>
                );
              }) : (
                <tr><td colSpan="7" className="py-6 text-center text-slate-400">No consignments found</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Activity + Audit side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Activity */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-100">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-100">
            <Activity className="w-4 h-4 text-primary-600" />
            <h2 className="text-sm font-semibold text-slate-900">Recent Packing Activity</h2>
          </div>
          <div className="divide-y divide-slate-50 max-h-80 overflow-y-auto">
            {stats?.recentActivity?.length > 0 ? stats.recentActivity.slice(0, 30).map((a, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50">
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                  a.eventType === 'box_saved' ? 'bg-primary-500' :
                  a.eventType === 'consignment_finished' ? 'bg-emerald-500' : 'bg-amber-500'
                }`} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-slate-800">
                    {a.eventType === 'box_saved' ? 'Box Saved' :
                     a.eventType === 'consignment_finished' ? 'Consignment Finished' : 'Event'}
                    {' — '}
                    <span className="font-mono text-[10px] text-slate-500">{a.consignmentId}</span>
                    {a.boxNo ? <span className="text-slate-400"> / Box #{a.boxNo}</span> : ''}
                  </p>
                  <p className="text-[10px] text-slate-400">{format(new Date(a.timestamp), 'dd MMM, h:mm a')}</p>
                </div>
                {a.itemsCount > 0 && (
                  <span className="text-[10px] font-semibold bg-primary-50 text-primary-700 px-2 py-0.5 rounded-full flex-shrink-0">
                    {a.itemsCount} items
                  </span>
                )}
              </div>
            )) : (
              <p className="text-center text-slate-400 py-8 text-sm">No activity yet</p>
            )}
          </div>
        </div>

        {/* Audit Logs */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-100">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
            <div className="flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-primary-600" />
              <h2 className="text-sm font-semibold text-slate-900">Audit Log</h2>
            </div>
            <button onClick={exportAuditCsv}
              className="flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 font-medium">
              <Download className="w-3 h-3" /> Export
            </button>
          </div>
          <div className="divide-y divide-slate-50 max-h-80 overflow-y-auto">
            {auditLogs.length > 0 ? auditLogs.map(log => (
              <div key={log.id} className="flex items-start gap-3 px-4 py-2.5 hover:bg-slate-50">
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold capitalize flex-shrink-0 mt-0.5 ${actionColor(log.action)}`}>
                  {log.action}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-slate-700">
                    <span className="font-medium">{log.entityType}</span>
                    {' · '}
                    <span className="font-mono text-[10px] text-slate-500 truncate">{log.entityId}</span>
                  </p>
                  <div className="flex items-center gap-3 mt-0.5">
                    <span className="flex items-center gap-1 text-[10px] text-slate-400">
                      <User className="w-3 h-3" />{log.userId === 'default-admin' ? 'Admin' : log.userId}
                    </span>
                    <span className="flex items-center gap-1 text-[10px] text-slate-400">
                      <Calendar className="w-3 h-3" />{format(new Date(log.timestamp), 'dd MMM, h:mm a')}
                    </span>
                  </div>
                </div>
              </div>
            )) : (
              <p className="text-center text-slate-400 py-8 text-sm">No audit logs</p>
            )}
          </div>
        </div>
      </div>

      </>)}
    </div>
  );
};

export default Productivity;
