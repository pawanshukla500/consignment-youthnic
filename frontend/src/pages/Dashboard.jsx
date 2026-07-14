import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  Package, CheckCircle2, Clock, AlertCircle, TrendingUp, ArrowRight, BarChart3, Activity, Boxes, RefreshCw
} from 'lucide-react';
import { productivityAPI } from '../services/api';
import { useConsignmentSync } from '../context/ConsignmentSyncContext';
import { useToast } from '../context/ToastContext';
import { getShipmentPriority, formatDispatchDate } from '../utils/priority';
import { getCriticalityCardClass } from '../utils/criticalityUi';
import CriticalityBadge from '../components/CriticalityBadge';
import ShipmentProgressBar from '../components/ShipmentProgressBar';
import UnitsProgressCell from '../components/UnitsProgressCell';
import { DashboardSkeleton } from '../components/Skeleton';

const DASHBOARD_CACHE_KEY = 'dashboard_summary_cache';
const DASHBOARD_CACHE_MS = 30_000;
const REALTIME_REFETCH_MS = 4_000;

// ── Lightweight dependency-free charts ──────────────────────────────────────
const Donut = ({ segments }) => {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  let acc = 0;
  const R = 54, C = 2 * Math.PI * R;
  return (
    <div className="flex items-center gap-5">
      <svg width="130" height="130" viewBox="0 0 130 130" className="-rotate-90">
        <circle cx="65" cy="65" r={R} fill="none" stroke="#FFF1F2" strokeWidth="16" />
        {segments.map((s, i) => {
          const len = (s.value / total) * C;
          const dash = `${len} ${C - len}`;
          const off = -acc; acc += len;
          return <circle key={i} cx="65" cy="65" r={R} fill="none" stroke={s.color} strokeWidth="16" strokeDasharray={dash} strokeDashoffset={off} strokeLinecap="butt" />;
        })}
      </svg>
      <div className="space-y-1.5">
        {segments.map((s, i) => (
          <div key={i} className="flex items-center gap-2 text-sm">
            <span className="w-3 h-3 rounded-sm" style={{ background: s.color }} />
            <span className="text-slate-600">{s.label}</span>
            <span className="font-bold text-slate-900 ml-auto">{s.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

const Bars = ({ data }) => {
  const max = Math.max(...data.map(d => d.value), 1);
  return (
    <div className="flex items-end justify-between gap-2 h-40 pt-4">
      {data.map((d, i) => (
        <div key={i} className="flex-1 flex flex-col items-center gap-1.5 group">
          <span className="text-[10px] font-semibold text-slate-500 opacity-0 group-hover:opacity-100 transition-opacity">{d.value}</span>
          <div className="w-full bg-primary-100 rounded-t-md relative" style={{ height: `${(d.value / max) * 100}%`, minHeight: d.value > 0 ? '4px' : '0' }}>
            <div className="absolute inset-0 rounded-t-md bg-gradient-to-t from-primary-600 to-primary-400" />
          </div>
          <span className="text-[10px] text-slate-400">{d.label}</span>
        </div>
      ))}
    </div>
  );
};

const StatCard = ({ title, value, icon: Icon, color, subtitle, link }) => (
  <Link to={link || '#'} className="block group">
    <div className="card p-6 hover:shadow-md hover:-translate-y-0.5 transition-all duration-200">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-slate-500">{title}</p>
          <p className="font-display text-3xl font-bold text-slate-900 mt-2 tabular-nums">{value}</p>
          {subtitle && <p className="text-sm text-slate-400 mt-1">{subtitle}</p>}
        </div>
        <div className={`p-3 rounded-lg ${color}`}>
          <Icon className="w-6 h-6 text-white" />
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
  const [loading, setLoading] = useState(!initialCache);
  const [refreshing, setRefreshing] = useState(false);
  const { pendingChanges } = useConsignmentSync();
  const refetchTimerRef = useRef(null);
  const fetchInFlightRef = useRef(false);

  const fetchDashboardData = useCallback(async ({ force = false, background = false } = {}) => {
    if (fetchInFlightRef.current) return;

    const cached = readDashboardCache();
    if (!force && cached?.data) {
      applyDashboardData(cached.data, { setStats, setRecentConsignments, setPriorityQueue, setTrend, setProductivity });
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
      applyDashboardData(data, { setStats, setRecentConsignments, setPriorityQueue, setTrend, setProductivity });
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
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8 stagger-children">
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

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* Status donut */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-6">
          <div className="flex items-center gap-2 mb-5">
            <BarChart3 className="w-5 h-5 text-primary-600" />
            <h2 className="text-base font-semibold text-slate-900">Consignment Status</h2>
          </div>
          {stats.total > 0 ? (
            <Donut segments={[
              { label: 'Completed', value: stats.completed, color: '#10b981' },
              { label: 'In Progress', value: stats.inProgress, color: '#E11D48' },
              { label: 'Pending', value: stats.pending, color: '#f59e0b' },
            ]} />
          ) : <p className="text-slate-400 text-center py-8 text-sm">No consignments yet</p>}
        </div>

        {/* 7-day trend */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-6">
          <div className="flex items-center gap-2 mb-1">
            <Activity className="w-5 h-5 text-primary-600" />
            <h2 className="text-base font-semibold text-slate-900">Boxes Packed — Last 7 Days</h2>
          </div>
          <Bars data={trend} />
        </div>
      </div>

      {/* Productivity & Recent */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Today's Productivity */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-6">
          <div className="flex items-center gap-2 mb-6">
            <TrendingUp className="w-5 h-5 text-primary-600" />
            <h2 className="text-lg font-semibold text-slate-900">Today's Productivity</h2>
          </div>
          
          {productivity ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg">
                <span className="text-sm text-slate-600">Boxes Packed</span>
                <span className="text-2xl font-bold text-slate-900">{productivity.today?.boxes || 0}</span>
              </div>
              <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg">
                <span className="text-sm text-slate-600">Items Packed</span>
                <span className="text-2xl font-bold text-slate-900">{productivity.today?.items || 0}</span>
              </div>
              <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg">
                <span className="text-sm text-slate-600">Avg Items/Box</span>
                <span className="text-2xl font-bold text-slate-900">
                  {productivity.today?.avgItemsPerBox || 0}
                </span>
              </div>
            </div>
          ) : (
            <p className="text-slate-400 text-center py-8">No data available</p>
          )}
          
          <Link 
            to="/productivity" 
            className="flex items-center justify-center gap-2 mt-6 text-primary-600 hover:text-primary-700 font-medium text-sm"
          >
            View Details <ArrowRight className="w-4 h-4" />
          </Link>
        </div>

        {/* Recent Consignments */}
        <div className="lg:col-span-2 bg-white rounded-xl shadow-sm border border-slate-100 p-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <Package className="w-5 h-5 text-primary-600" />
              <h2 className="text-lg font-semibold text-slate-900">Recent Consignments</h2>
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
