import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router';
import {
  Package, CheckCircle2, Clock, AlertCircle, ArrowRight, Activity, Boxes, RefreshCw, GitBranch, Store
} from 'lucide-react';
import { productivityAPI } from '../services/api';
import { useConsignmentSync } from '../context/ConsignmentSyncContext';
import { useToast } from '../context/ToastContext';
import { getShipmentPriority, formatDispatchDate } from '../utils/priority';
import { getCriticalityCardClass } from '../utils/criticalityUi';
import { WORKFLOW_BUCKET_ORDER, WORKFLOW_BUCKET_LABELS } from '../utils/workflowPriority';
import { WORKFLOW_BUCKET_HEX, categoricalColor, formatCompactNumber } from '../utils/chartColors';
import CriticalityBadge from '../components/CriticalityBadge';
import ShipmentProgressBar from '../components/ShipmentProgressBar';
import UnitsProgressCell from '../components/UnitsProgressCell';
import { DashboardSkeleton } from '../components/Skeleton';
import { TrendChart, BarList, SegmentedBar } from '../components/charts';

const DASHBOARD_CACHE_KEY = 'dashboard_summary_cache';
const DASHBOARD_CACHE_MS = 30_000;
const REALTIME_REFETCH_MS = 4_000;

const StatCard = ({ title, value, icon: Icon, color, subtitle, link }) => (
  <Link to={link || '#'} className="block group">
    <div className="card p-5 hover:shadow-md hover:-translate-y-0.5 transition-all duration-200">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-slate-500">{title}</p>
          <p className="font-display text-2xl font-bold text-slate-900 mt-1.5 tabular-nums">{value}</p>
          {subtitle && <p className="text-xs text-slate-400 mt-1">{subtitle}</p>}
        </div>
        <div className={`p-2.5 rounded-lg ${color}`}>
          <Icon className="w-5 h-5 text-white" />
        </div>
      </div>
    </div>
  </Link>
);

function readDashboardCache() {
  try {
    const cached = JSON.parse(sessionStorage.getItem(DASHBOARD_CACHE_KEY) || 'null');
    if (cached?.savedAt && Date.now() - cached.savedAt < DASHBOARD_CACHE_MS) {
      return cached;
    }
  } catch {
    // ignore corrupt cache
  }
  return null;
}

function applyDashboardData(data, setters) {
  setters.setStats(data.stats || { total: 0, pending: 0, inProgress: 0, completed: 0 });
  setters.setRecentConsignments(data.recentConsignments || []);
  setters.setPriorityQueue(
    (data.priorityQueue || []).filter((c) => {
      const p = getShipmentPriority(c);
      return ['critical', 'high', 'medium'].includes(p.level);
    }).slice(0, 8)
  );
  setters.setTrend(data.trend || []);
  setters.setProductivity(data.productivity || null);
  setters.setWorkflowBuckets(data.workflowBuckets || null);
  setters.setMarketplaceBreakdown(data.marketplaceBreakdown || []);
  setters.setDisputedCount(data.disputedCount || 0);
}

const Dashboard = () => {
  const { addToast } = useToast();
  const initialCache = readDashboardCache();
  const [stats, setStats] = useState(initialCache?.data?.stats || {
    total: 0,
    pending: 0,
    inProgress: 0,
    completed: 0
  });
  const [productivity, setProductivity] = useState(initialCache?.data?.productivity || null);
  const [recentConsignments, setRecentConsignments] = useState(initialCache?.data?.recentConsignments || []);
  const [priorityQueue, setPriorityQueue] = useState(initialCache?.data?.priorityQueue || []);
  const [trend, setTrend] = useState(initialCache?.data?.trend || []);
  const [workflowBuckets, setWorkflowBuckets] = useState(initialCache?.data?.workflowBuckets || null);
  const [marketplaceBreakdown, setMarketplaceBreakdown] = useState(initialCache?.data?.marketplaceBreakdown || []);
  const [disputedCount, setDisputedCount] = useState(initialCache?.data?.disputedCount || 0);
  const [loading, setLoading] = useState(!initialCache);
  const [refreshing, setRefreshing] = useState(false);
  const { pendingChanges } = useConsignmentSync();
  const refetchTimerRef = useRef(null);
  const fetchInFlightRef = useRef(false);

  const fetchDashboardData = useCallback(async ({ force = false, background = false } = {}) => {
    if (fetchInFlightRef.current) return;

    const setters = {
      setStats, setRecentConsignments, setPriorityQueue, setTrend, setProductivity,
      setWorkflowBuckets, setMarketplaceBreakdown, setDisputedCount,
    };

    const cached = readDashboardCache();
    if (!force && cached?.data) {
      applyDashboardData(cached.data, setters);
      setLoading(false);
      if (Date.now() - cached.savedAt < DASHBOARD_CACHE_MS) {
        return;
      }
    }

    fetchInFlightRef.current = true;
    if (background) setRefreshing(true);
    else if (!cached?.data) setLoading(true);

    try {
      const { data } = await productivityAPI.getDashboardSummary(force ? { refresh: 1 } : undefined);
      applyDashboardData(data, setters);
      sessionStorage.setItem(DASHBOARD_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), data }));
    } catch (error) {
      console.error('Error fetching dashboard data:', error);
      if (!cached?.data) addToast('Failed to load dashboard data', 'error');
    } finally {
      fetchInFlightRef.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, [addToast]);

  useEffect(() => {
    fetchDashboardData({ background: Boolean(initialCache) });
  }, [fetchDashboardData]);

  useEffect(() => {
    if (!pendingChanges.length) return;
    if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
    refetchTimerRef.current = setTimeout(() => {
      fetchDashboardData({ force: true, background: true });
    }, REALTIME_REFETCH_MS);
    return () => {
      if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
    };
  }, [pendingChanges, fetchDashboardData]);

  if (loading) return <DashboardSkeleton />;

  const pipelineSegments = (workflowBuckets ? WORKFLOW_BUCKET_ORDER : [])
    .map((bucket) => ({
      key: bucket,
      label: WORKFLOW_BUCKET_LABELS[bucket],
      value: workflowBuckets?.[bucket] || 0,
      color: WORKFLOW_BUCKET_HEX[bucket],
    }));

  const marketplaceItems = marketplaceBreakdown.map((m, i) => ({
    key: m.id,
    label: m.name,
    value: m.count,
    color: categoricalColor(i),
    sublabel: m.required ? `${m.packed}/${m.required} pcs` : undefined,
  }));

  return (
    <div>
      <div className="mb-8 animate-fade-in flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold text-slate-900">Dashboard</h1>
          <p className="text-slate-500 mt-1 text-sm">Overview of your consignment packing operations</p>
        </div>
        {refreshing && (
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-400 mt-2">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Updating…
          </span>
        )}
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-5 mb-8 stagger-children">
        <StatCard
          title="Total Consignments"
          value={stats.total}
          icon={Package}
          color="bg-blue-500"
          subtitle="All time"
          link="/consignments"
        />
        <StatCard
          title="Pending"
          value={stats.pending}
          icon={Clock}
          color="bg-amber-500"
          subtitle="Awaiting packing"
          link="/consignments?status=pending"
        />
        <StatCard
          title="In Progress"
          value={stats.inProgress}
          icon={Boxes}
          color="bg-primary-500"
          subtitle="Currently packing"
          link="/consignments?status=in_progress"
        />
        <StatCard
          title="Completed"
          value={stats.completed}
          icon={CheckCircle2}
          color="bg-emerald-500"
          subtitle="Finished"
          link="/consignments?status=completed"
        />
        <StatCard
          title="Disputed"
          value={disputedCount}
          icon={AlertCircle}
          color="bg-red-500"
          subtitle="Inward issue pending"
          link="/consignments?bucket=disputed"
        />
      </div>

      {/* Packing priority queue */}
      {priorityQueue.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-red-100 p-6 mb-8">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-red-600" />
              <h2 className="text-lg font-semibold text-slate-900">Priority Shipments — Planning &amp; Packing</h2>
            </div>
            <Link to="/packing" className="text-primary-600 hover:text-primary-700 font-medium text-sm flex items-center gap-1">
              Open Packing Station <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            {priorityQueue.map((c) => {
              const p = getShipmentPriority(c);
              return (
                <Link
                  key={c.id}
                  to="/packing"
                  className={`block p-4 rounded-xl border hover:shadow-sm transition-all ${getCriticalityCardClass(p)}`}
                >
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="font-mono font-bold text-slate-900 text-sm truncate">{c.internalShipmentNo || c.id}</span>
                    <CriticalityBadge priority={p} />
                  </div>
                  <p className="text-xs text-slate-500">Dispatch {formatDispatchDate(c.requiredDispatchDate || c.scheduledDispatchDate)}</p>
                  <p className="text-[10px] text-slate-400 mt-0.5">{p.sublabel}</p>
                  <div className="mt-3">
                    <UnitsProgressCell consignment={c} barWidth="w-full" />
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* Charts row 1 — workflow pipeline + packing trend */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-6">
          <div className="flex items-center gap-2 mb-1">
            <GitBranch className="w-5 h-5 text-primary-600" />
            <h2 className="text-base font-semibold text-slate-900">Workflow Pipeline</h2>
          </div>
          <p className="text-xs text-slate-400 mb-5">Where every consignment sits right now, out of {stats.total} total</p>
          {stats.total > 0 && workflowBuckets ? (
            <SegmentedBar segments={pipelineSegments} valueFormatter={(v) => String(v)} height={18} />
          ) : (
            <p className="text-slate-400 text-center py-8 text-sm">No consignments yet</p>
          )}
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-6">
          <div className="flex items-center gap-2 mb-1">
            <Activity className="w-5 h-5 text-primary-600" />
            <h2 className="text-base font-semibold text-slate-900">Boxes Packed — Last 14 Days</h2>
          </div>
          <p className="text-xs text-slate-400 mb-1">Daily box-save volume across the whole team</p>
          <TrendChart data={trend} color="#E11D48" valueLabel="boxes" height={176} />
        </div>
      </div>

      {/* Charts row 2 — productivity, marketplace mix, recent consignments */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Today's Productivity */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-6">
          <div className="flex items-center gap-2 mb-5">
            <Boxes className="w-5 h-5 text-primary-600" />
            <h2 className="text-base font-semibold text-slate-900">Today's Productivity</h2>
          </div>

          {productivity ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                <span className="text-sm text-slate-600">Boxes Packed</span>
                <span className="text-xl font-bold text-slate-900 tabular-nums">{productivity.today?.boxes || 0}</span>
              </div>
              <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                <span className="text-sm text-slate-600">Items Packed</span>
                <span className="text-xl font-bold text-slate-900 tabular-nums">{productivity.today?.items || 0}</span>
              </div>
              <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                <span className="text-sm text-slate-600">Avg Items/Box</span>
                <span className="text-xl font-bold text-slate-900 tabular-nums">
                  {productivity.today?.avgItemsPerBox || 0}
                </span>
              </div>
            </div>
          ) : (
            <p className="text-slate-400 text-center py-8 text-sm">No data available</p>
          )}

          <Link
            to="/productivity"
            className="flex items-center justify-center gap-2 mt-5 text-primary-600 hover:text-primary-700 font-medium text-sm"
          >
            View Details <ArrowRight className="w-4 h-4" />
          </Link>
        </div>

        {/* By Marketplace */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-6">
          <div className="flex items-center gap-2 mb-5">
            <Store className="w-5 h-5 text-primary-600" />
            <h2 className="text-base font-semibold text-slate-900">By Marketplace</h2>
          </div>
          <BarList items={marketplaceItems} maxItems={6} valueFormatter={(v) => formatCompactNumber(v)} />
        </div>

        {/* Recent Consignments */}
        <div className="lg:col-span-2 bg-white rounded-xl shadow-sm border border-slate-100 p-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <Package className="w-5 h-5 text-primary-600" />
              <h2 className="text-base font-semibold text-slate-900">Recent Consignments</h2>
            </div>
            <Link
              to="/consignments"
              className="text-primary-600 hover:text-primary-700 font-medium text-sm flex items-center gap-1"
            >
              View All <ArrowRight className="w-4 h-4" />
            </Link>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider py-3">ID</th>
                  <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider py-3">Name</th>
                  <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider py-3">Status</th>
                  <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider py-3">Criticality</th>
                  <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider py-3">Units Progress %</th>
                  <th className="text-right text-xs font-semibold text-slate-500 uppercase tracking-wider py-3">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {recentConsignments.length > 0 ? (
                  recentConsignments.map((c) => {
                    const p = getShipmentPriority(c);
                    return (
                    <tr key={c.id} className={`transition-colors ${p.level === 'critical' ? 'bg-red-50/80' : p.level === 'high' ? 'bg-orange-50/50' : p.level === 'medium' ? 'bg-amber-50/40' : 'hover:bg-slate-50'}`}>
                      <td className="py-4 text-sm font-mono text-slate-600">{c.id}</td>
                      <td className="py-4 text-sm font-medium text-slate-900">{c.name || c.internalShipmentNo}</td>
                      <td className="py-4">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          c.status === 'completed' ? 'bg-emerald-100 text-emerald-800' :
                          c.status === 'in_progress' ? 'bg-blue-100 text-blue-800' :
                          'bg-amber-100 text-amber-800'
                        }`}>
                          {c.status?.replace('_', ' ')}
                        </span>
                      </td>
                      <td className="py-4">
                        <CriticalityBadge priority={p} />
                      </td>
                      <td className="py-4">
                        <ShipmentProgressBar consignment={c} variant="compact" />
                      </td>
                      <td className="py-4 text-right">
                        <Link
                          to={`/consignments/${c.id}`}
                          className="text-primary-600 hover:text-primary-700 text-sm font-medium"
                        >
                          View
                        </Link>
                      </td>
                    </tr>
                  )})
                ) : (
                  <tr>
                    <td colSpan="6" className="py-8 text-center text-slate-400">
                      No consignments found
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
