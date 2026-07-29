import React, { useState, useEffect } from 'react';
import { Link, Navigate } from 'react-router';
import { useAuth } from '../context/AuthContext';
import { Save, Trash2, AlertTriangle, ChevronLeft, Loader2, Clock, Database, Play, Server, CheckCircle2, RefreshCw, ShieldCheck, HardDrive, Activity, BarChart3, ExternalLink, ClipboardPaste, Factory } from 'lucide-react';
import { settingsAPI, usersAPI } from '../services/api';
import { useToast } from '../context/ToastContext';
import ConfirmModal from '../components/ConfirmModal';
import SystemHealthPanel from '../components/SystemHealthPanel';
import { isPosthogConfigured } from '../utils/posthog';
import { resolvePosthogDashboardUrl } from '../utils/posthogDashboard';

export default function Settings() {
  const { addToast } = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'organization_head';
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [runningCleanup, setRunningCleanup] = useState(false);
  const [showCleanupConfirm, setShowCleanupConfirm] = useState(false);
  const [dbInfo, setDbInfo] = useState(null);
  const [dbLoading, setDbLoading] = useState(true);
  const posthogDashboardUrl = resolvePosthogDashboardUrl(
    dbInfo?.posthogDashboardUrl || import.meta.env.VITE_POSTHOG_DASHBOARD_URL
  );
  const betterStackDashboardUrl = (
    dbInfo?.betterStackDashboardUrl || import.meta.env.VITE_BETTERSTACK_DASHBOARD_URL || ''
  ).trim();
  const [reconciling, setReconciling] = useState(false);
  const [reconcileResult, setReconcileResult] = useState(null);
  const [healingShip, setHealingShip] = useState(false);
  const [healShipResult, setHealShipResult] = useState(null);
  const [fbAuthEnabled, setFbAuthEnabled] = useState(null);
  const [syncingFb, setSyncingFb] = useState(false);
  const [fbSyncResult, setFbSyncResult] = useState(null);
  const [migrating, setMigrating] = useState(false);
  const [migrationResult, setMigrationResult] = useState(null);
  const [showMigrateConfirm, setShowMigrateConfirm] = useState(false);
  const [activeTab, setActiveTab] = useState('general');
  const [liveLogs, setLiveLogs] = useState([]);
  const [isPollingLogs, setIsPollingLogs] = useState(true);
  const [settings, setSettings] = useState({
    consignmentRetentionDays: 450,
    videoRetentionDays: 60,
    weightImageRetentionDays: 90,
    auditLogRetentionDays: 400,
    cleanupEnabled: true,
    packingAllowPaste: true,
    lastCleanupRun: null
  });

  useEffect(() => {
    fetchSettings();
    fetchDbInfo();
    usersAPI.secureAccessStatus().then(r => setFbAuthEnabled(r.data.enabled)).catch(() => setFbAuthEnabled(false));
  }, []);

  const fetchLiveLogs = async () => {
    try {
      const res = await settingsAPI.getLiveLogs();
      setLiveLogs(res.data.logs || []);
    } catch (e) {
      // Quiet fail
    }
  };

  useEffect(() => {
    let interval;
    if (activeTab === 'monitoring' && isPollingLogs) {
      fetchLiveLogs();
      interval = setInterval(fetchLiveLogs, 5000);
    }
    return () => clearInterval(interval);
  }, [activeTab, isPollingLogs]);

  const handleAccessSync = async () => {
    setSyncingFb(true);
    setFbSyncResult(null);
    try {
      const res = await usersAPI.syncSecureAccess();
      setFbSyncResult(res.data);
      addToast(`Synced ${res.data.synced} user(s) — ${res.data.created} new in secure access`, 'success');
    } catch (e) {
      addToast(e.response?.data?.error || 'Secure access sync failed', 'error');
    }
    setSyncingFb(false);
  };

  const fetchDbInfo = async () => {
    setDbLoading(true);
    try {
      const res = await settingsAPI.getDbInfo();
      setDbInfo(res.data);
    } catch (e) {
      addToast('Failed to load database info', 'error');
    }
    setDbLoading(false);
  };

  const handleReconcile = async () => {
    setReconciling(true);
    setReconcileResult(null);
    try {
      const res = await settingsAPI.reconcile();
      setReconcileResult(res.data);
      addToast(`Reconciled ${res.data.scanned} consignments — fixed ${res.data.fixedConsignments}`, 'success');
      fetchDbInfo();
    } catch (e) {
      addToast(e.response?.data?.error || 'Reconcile failed', 'error');
    }
    setReconciling(false);
  };

  const handleHealShipmentStatuses = async () => {
    setHealingShip(true);
    setHealShipResult(null);
    try {
      const res = await settingsAPI.healShipmentStatuses();
      setHealShipResult(res.data);
      addToast(`Healed ${res.data.fixed} of ${res.data.scanned} consignments`, 'success');
    } catch (e) {
      addToast(e.response?.data?.error || 'Heal statuses failed', 'error');
    }
    setHealingShip(false);
  };

  const handleMigration = async () => {
    setShowMigrateConfirm(false);
    setMigrating(true);
    setMigrationResult(null);
    try {
      const res = await settingsAPI.importLegacyData();
      setMigrationResult(res.data);
      addToast(`Successfully migrated ${res.data.total} documents to primary live store!`, 'success');
      fetchDbInfo();
    } catch (e) {
      addToast(e.response?.data?.error || 'Migration failed', 'error');
    }
    setMigrating(false);
  };

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  const fetchSettings = async () => {
    try {
      setLoading(true);
      const res = await settingsAPI.get();
      setSettings(prev => ({ ...prev, ...res.data.settings }));
    } catch (err) {
      addToast('Failed to load settings', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await settingsAPI.update({
        consignmentRetentionDays: parseInt(settings.consignmentRetentionDays),
        videoRetentionDays: parseInt(settings.videoRetentionDays),
        weightImageRetentionDays: parseInt(settings.weightImageRetentionDays || 90),
        auditLogRetentionDays: parseInt(settings.auditLogRetentionDays || 400),
        cleanupEnabled: settings.cleanupEnabled,
        packingAllowPaste: settings.packingAllowPaste,
      });
      addToast('Settings saved', 'success');
    } catch (err) {
      addToast(err.response?.data?.error || 'Failed to save', 'error');
    }
    setSaving(false);
  };

  const handleRunCleanup = async () => {
    setRunningCleanup(true);
    try {
      const res = await settingsAPI.runCleanup();
      const r = res.data;
      addToast(`Cleanup done: ${r.consignmentsDeleted||0} consignments, ${r.videosDeleted||0} videos, ${r.weightImagesDeleted||0} weight proofs, ${r.auditLogsDeleted||0} old audit logs deleted`, 'success');
      fetchSettings();
    } catch (err) {
      addToast(err.response?.data?.error || 'Cleanup failed', 'error');
    }
    setRunningCleanup(false);
  };

  const fmtDate = (d) => {
    if (!d) return 'Never';
    const dt = new Date(d);
    if (isNaN(dt)) return d;
    return dt.toLocaleString('en-GB');
  };

  return (
    <div className="animate-fade-in">
      <div className="flex items-center gap-3 mb-6">
        <Link to="/" className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
          <ChevronLeft className="w-5 h-5" />
        </Link>
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Settings</h1>
          <p className="text-slate-500 mt-1">Data retention and system configuration</p>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="flex border-b border-slate-200 mb-6 max-w-5xl">
        <button
          onClick={() => setActiveTab('general')}
          className={`py-3 px-6 font-semibold text-sm border-b-2 transition-all ${
            activeTab === 'general'
              ? 'border-primary-600 text-primary-600 font-bold'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          General &amp; Retention
        </button>
        <button
          onClick={() => setActiveTab('monitoring')}
          className={`py-3 px-6 font-semibold text-sm border-b-2 transition-all flex items-center gap-2 ${
            activeTab === 'monitoring'
              ? 'border-primary-600 text-primary-600 font-bold'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Activity className="w-4 h-4 text-violet-500" /> System Logs &amp; Dashboards
        </button>
      </div>

      {loading ? (
        <div className="py-12 text-center"><Loader2 className="w-8 h-8 animate-spin mx-auto text-primary-600" /></div>
      ) : (
        <div className="max-w-5xl space-y-6">
          {activeTab === 'general' ? (
            <>
              <SystemHealthPanel />

          <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
            <div className="px-6 py-4 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-teal-50 rounded-lg"><Factory className="w-5 h-5 text-teal-700" /></div>
                <div>
                  <h2 className="text-lg font-semibold text-slate-900">Inventory Planning</h2>
                  <p className="text-sm text-slate-500">
                    Google Sheet AutoFetch inventory, SKU shortage report, and production emails
                  </p>
                </div>
              </div>
              <Link
                to="/inventory-planning"
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-teal-700 text-white text-sm font-semibold hover:bg-teal-800"
              >
                Open dashboard <ExternalLink className="w-3.5 h-3.5" />
              </Link>
            </div>
          </div>

          {/* ═══ DATABASE CONNECTION (admin) ═══ */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-primary-50 rounded-lg"><Server className="w-5 h-5 text-primary-600" /></div>
                <div>
                  <h2 className="text-lg font-semibold text-slate-900">Data Service</h2>
                  <p className="text-sm text-slate-500">Live record status &amp; configuration</p>
                </div>
              </div>
              <button onClick={fetchDbInfo} disabled={dbLoading}
                className="flex items-center gap-1.5 px-3 py-2 border border-slate-200 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-50">
                <RefreshCw className={`w-3.5 h-3.5 ${dbLoading ? 'animate-spin' : ''}`} /> Refresh
              </button>
            </div>
            <div className="p-6">
              {dbLoading ? (
                <div className="py-6 text-center text-slate-400 text-sm">Loading…</div>
              ) : dbInfo ? (
                <>
                  {/* Status banner */}
                  <div className={`flex items-center gap-2 px-4 py-3 rounded-xl mb-5 ${dbInfo.connected ? 'bg-emerald-50 border border-emerald-100' : 'bg-red-50 border border-red-100'}`}>
                    {dbInfo.connected
                      ? <><CheckCircle2 className="w-4 h-4 text-emerald-600" /><span className="text-sm font-medium text-emerald-700">Connected - Primary live store</span></>
                      : <><AlertTriangle className="w-4 h-4 text-red-600" /><span className="text-sm font-medium text-red-700">Not connected{dbInfo.error ? `: ${dbInfo.error}` : ''}</span></>}
                  </div>

                  {/* Connection details */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-5">
                    {[
                      { label: 'Provider', value: dbInfo.provider || '—' },
                      { label: 'Database', value: dbInfo.database || '—' },
                      { label: 'Host', value: dbInfo.host || '—' },
                      { label: 'Connection', value: dbInfo.connected ? 'Healthy' : 'Needs attention' },
                      { label: 'Latency', value: dbInfo.latencyMs != null ? `${dbInfo.latencyMs}ms` : '—' },
                      { label: 'Transport', value: dbInfo.ssl ? 'SSL/TLS' : 'Local only' },
                      { label: 'Pool active', value: dbInfo.pool ? `${dbInfo.pool.totalCount ?? 0} / ${dbInfo.pool.max ?? '—'}` : '—' },
                      { label: 'Failed queries', value: dbInfo.failedQueryCount ?? 0 },
                      { label: 'Last success', value: dbInfo.lastSuccessfulConnectionAt ? new Date(dbInfo.lastSuccessfulConnectionAt).toLocaleString('en-GB') : 'Never' },
                    ].map(item => (
                      <div key={item.label} className="bg-slate-50 rounded-lg px-3 py-2">
                        <p className="text-[10px] uppercase tracking-wider text-slate-400">{item.label}</p>
                        <p className="text-sm font-medium text-slate-800 truncate">{item.value}</p>
                      </div>
                    ))}
                  </div>

                  {dbInfo.redactedUrl && (
                    <div className="mb-4 p-3 bg-slate-50 rounded-lg border border-slate-100">
                      <p className="text-[10px] uppercase tracking-wider text-slate-400 mb-1">Connection string ({dbInfo.sourceEnvVar})</p>
                      <p className="text-xs font-mono text-slate-600 break-all">{dbInfo.redactedUrl}</p>
                    </div>
                  )}

                  {dbInfo.validation && !dbInfo.validation.valid && (
                    <div className="mb-4 p-4 bg-red-50 border border-red-100 rounded-xl text-sm text-red-800">
                      <p className="font-semibold">{dbInfo.validation.error}</p>
                      {dbInfo.validation.hint && <p className="text-xs mt-2 text-red-700">{dbInfo.validation.hint}</p>}
                    </div>
                  )}

                  {dbInfo.lastConnectionError && !dbInfo.connected && (
                    <div className="mb-4 p-3 bg-amber-50 border border-amber-100 rounded-lg text-xs text-amber-800">
                      Last error: {dbInfo.lastConnectionError}
                    </div>
                  )}

                  {dbInfo.postgresVersion && (
                    <div className="mb-4 text-xs text-slate-500 font-mono truncate">{dbInfo.postgresVersion}</div>
                  )}

                  {/* Record counts */}
                  <div className="flex items-center gap-2 mb-2">
                    <HardDrive className="w-4 h-4 text-slate-400" />
                    <p className="text-sm font-semibold text-slate-700">Stored Records ({dbInfo.totalDocuments?.toLocaleString()} total)</p>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {Object.entries(dbInfo.counts || {}).map(([col, n]) => (
                      <div key={col} className="bg-primary-50/50 border border-primary-100 rounded-lg px-3 py-2">
                        <p className="text-lg font-bold text-primary-700">{n}</p>
                        <p className="text-[10px] text-slate-500 capitalize">{col}</p>
                      </div>
                    ))}
                  </div>

                  {/* Legacy import section - hidden unless explicitly enabled server-side */}
                  {dbInfo.connected && dbInfo.legacyImportEnabled && (
                    <>
                      <div className="border-t border-slate-100 my-6"></div>
                      <div className="space-y-4">
                        <div className="flex items-center gap-2">
                          <Database className="w-5 h-5 text-primary-600" />
                          <h3 className="text-base font-semibold text-slate-900">Legacy Data Import</h3>
                        </div>
                        <p className="text-sm text-slate-500">
                          One-time recovery/import tool for older records. Normal operations now use the primary live data service only.
                        </p>

                        {migrationResult && (
                          <div className="p-4 bg-slate-50 border border-slate-100 rounded-xl space-y-3">
                            <div className="flex items-center gap-2 text-sm font-semibold text-emerald-700">
                              <CheckCircle2 className="w-4 h-4" />
                              <span>Successfully migrated {migrationResult.total} documents!</span>
                            </div>
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                              {Object.entries(migrationResult.migrated || {}).map(([col, n]) => (
                                <div key={col} className="bg-white border border-slate-100 rounded p-2 flex justify-between items-center">
                                  <span className="text-slate-500 capitalize truncate mr-1">{col}</span>
                                  <span className="font-bold text-slate-800">{n}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        <button
                          onClick={() => setShowMigrateConfirm(true)}
                          disabled={migrating}
                          className="flex items-center gap-2 px-5 py-2.5 bg-primary-600 text-white rounded-lg hover:bg-primary-700 text-sm font-medium transition-colors disabled:opacity-50"
                        >
                          {migrating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Database className="w-4 h-4" />}
                          {migrating ? 'Migrating Data…' : 'Start Migration Now'}
                        </button>
                      </div>
                    </>
                  )}
                </>
              ) : (
                <p className="text-sm text-slate-400 text-center py-4">Unable to load database info.</p>
              )}
            </div>
          </div>

          {/* ═══ DATA INTEGRITY / RECONCILE ═══ */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-3">
              <div className="p-2 bg-emerald-50 rounded-lg"><ShieldCheck className="w-5 h-5 text-emerald-600" /></div>
              <div>
                <h2 className="text-lg font-semibold text-slate-900">Data Integrity</h2>
                <p className="text-sm text-slate-500">Recalculate all packed totals from physical boxes so every number matches</p>
              </div>
            </div>
            <div className="p-6">
              <div className="flex items-start gap-3 p-4 bg-primary-50 rounded-xl border border-primary-100 mb-4">
                <ShieldCheck className="w-5 h-5 text-primary-600 shrink-0 mt-0.5" />
                <div className="text-sm text-primary-800">
                  This recomputes every SKU's packed quantity, box breakdown, and each consignment's totals
                  <strong> directly from the saved boxes</strong> — the physical source of truth. Use it if the
                  Packing Station, SKU list, Boxes tab, or Reports ever show different numbers. It's safe to run anytime.
                </div>
              </div>

              {reconcileResult && (
                <div className="mb-4 p-4 bg-slate-50 rounded-xl border border-slate-100 text-sm">
                  <p className="font-semibold text-slate-800 mb-1">
                    ✅ Scanned {reconcileResult.scanned} consignments — fixed {reconcileResult.fixedConsignments} consignment(s), {reconcileResult.fixedSkus} SKU(s)
                  </p>
                  {reconcileResult.issues?.length > 0 ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-primary-600">View {reconcileResult.issues.length} adjustments</summary>
                      <ul className="mt-2 space-y-0.5 max-h-40 overflow-y-auto">
                        {reconcileResult.issues.map((it, i) => <li key={i} className="text-[11px] text-slate-500 font-mono">{it}</li>)}
                      </ul>
                    </details>
                  ) : <p className="text-xs text-emerald-600">All data already consistent — nothing to fix. 🎯</p>}
                </div>
              )}

              <button onClick={handleReconcile} disabled={reconciling || healingShip}
                className="flex items-center gap-2 px-5 py-2.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-sm font-medium transition-colors disabled:opacity-50">
                {reconciling ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                {reconciling ? 'Reconciling…' : 'Reconcile All Data'}
              </button>

              <div className="mt-6 pt-6 border-t border-slate-100">
                <h3 className="text-sm font-semibold text-slate-900 mb-1">Heal Ship statuses</h3>
                <p className="text-sm text-slate-500 mb-3">
                  Fix archived / inward-done consignments still showing Ship as In Transit, Forwarded, or Ready.
                  Sets them to <strong>Inwarded</strong> in the database (safe, admin-only).
                </p>
                {healShipResult && (
                  <div className="mb-4 p-4 bg-slate-50 rounded-xl border border-slate-100 text-sm">
                    <p className="font-semibold text-slate-800 mb-1">
                      Scanned {healShipResult.scanned} — fixed {healShipResult.fixed}
                    </p>
                    {healShipResult.issues?.length > 0 ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-primary-600">View {healShipResult.issues.length} updates</summary>
                        <ul className="mt-2 space-y-0.5 max-h-40 overflow-y-auto">
                          {healShipResult.issues.map((it, i) => <li key={i} className="text-[11px] text-slate-500 font-mono">{it}</li>)}
                        </ul>
                      </details>
                    ) : <p className="text-xs text-emerald-600">Nothing to heal — all Ship statuses look correct.</p>}
                  </div>
                )}
                <button onClick={handleHealShipmentStatuses} disabled={healingShip || reconciling}
                  className="flex items-center gap-2 px-5 py-2.5 bg-slate-800 text-white rounded-lg hover:bg-slate-900 text-sm font-medium transition-colors disabled:opacity-50">
                  {healingShip ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                  {healingShip ? 'Healing…' : 'Heal Ship Statuses'}
                </button>
              </div>
            </div>
          </div>

          {/* Secure access */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-amber-50 rounded-lg"><ShieldCheck className="w-5 h-5 text-amber-600" /></div>
                <div>
                  <h2 className="text-lg font-semibold text-slate-900">Secure User Access</h2>
                  <p className="text-sm text-slate-500">Mirror app users into secure Auth — manage them from the secure Console</p>
                </div>
              </div>
              <span className={`px-2.5 py-1 rounded-full text-[11px] font-semibold ${fbAuthEnabled === null ? 'bg-slate-100 text-slate-500' : fbAuthEnabled ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                {fbAuthEnabled === null ? 'Checking…' : fbAuthEnabled ? 'Connected' : 'Not Available'}
              </span>
            </div>
            <div className="p-6">
              <div className="flex items-start gap-3 p-4 bg-amber-50 rounded-xl border border-amber-100 mb-4">
                <ShieldCheck className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                <div className="text-sm text-amber-800">
                  <p className="mb-1"><strong>What this does:</strong> New users created here are automatically mirrored into Secure User Access (and updated/deleted/password-changed accordingly).</p>
                  <p className="text-xs">For <strong>existing</strong> users, click below to backfill — their accounts will be created in secure access without a password. They can use the password reset flow to set one.</p>
                </div>
              </div>

              {fbSyncResult && (
                <div className="mb-4 p-4 bg-slate-50 rounded-xl border border-slate-100 text-sm">
                  <p className="font-semibold text-slate-800">
                    ✅ {fbSyncResult.synced}/{fbSyncResult.total} users synced — {fbSyncResult.created} newly created in secure access{fbSyncResult.failed > 0 ? ` (${fbSyncResult.failed} failed)` : ''}
                  </p>
                </div>
              )}

              <button onClick={handleAccessSync} disabled={syncingFb || !fbAuthEnabled}
                className="flex items-center gap-2 px-5 py-2.5 bg-amber-600 text-white rounded-lg hover:bg-amber-700 text-sm font-medium transition-colors disabled:opacity-50">
                {syncingFb ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                {syncingFb ? 'Syncing…' : 'Backfill All Users to Secure Access'}
              </button>
            </div>
          </div>

          {/* Monitoring & Analytics */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-violet-50 rounded-lg"><Activity className="w-5 h-5 text-violet-600" /></div>
                <div>
                  <h2 className="text-lg font-semibold text-slate-900">Monitoring &amp; Analytics</h2>
                  <p className="text-sm text-slate-500">Track application usage, performance, and backend logs</p>
                </div>
              </div>
            </div>
            <div className="p-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* PostHog Card */}
                <div className="border border-slate-100 rounded-xl p-5 bg-slate-50/50 hover:bg-slate-50 transition-all flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <div className="p-1.5 bg-orange-100 text-orange-600 rounded-lg">
                          <BarChart3 className="w-4 h-4" />
                        </div>
                        <h3 className="font-semibold text-slate-800">PostHog Analytics</h3>
                      </div>
                      <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold ${isPosthogConfigured ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                        {isPosthogConfigured ? 'Active' : 'Not Configured'}
                      </span>
                    </div>
                    <p className="text-sm text-slate-500 mb-4">
                      Tracks user and packer operations like sign-ins, box saves, and barcode scans to measure throughput and scan accuracy.
                      {posthogDashboardUrl && (
                        <span className="block mt-2 text-xs text-primary-600 font-medium">
                          Embedded dashboard is on the System Logs &amp; Dashboards tab.
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="pt-2 flex justify-between items-center">
                    <span className="text-xs text-slate-400">Client-side events</span>
                    <a
                      href="https://us.posthog.com/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-800 transition-colors"
                    >
                      Open PostHog <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                </div>

                {/* Better Stack Logs Card */}
                <div className="border border-slate-100 rounded-xl p-5 bg-slate-50/50 hover:bg-slate-50 transition-all flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <div className="p-1.5 bg-sky-100 text-sky-600 rounded-lg">
                          <Activity className="w-4 h-4" />
                        </div>
                        <h3 className="font-semibold text-slate-800">Better Stack Logs</h3>
                      </div>
                      <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold ${dbInfo?.betterStackLogsEnabled ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                        {dbInfo?.betterStackLogsEnabled ? 'Active' : 'Not Configured'}
                      </span>
                    </div>
                    <p className="text-sm text-slate-500 mb-4">
                      Collects all server-side console logs (logs, warnings, and errors) in real time to assist in debugging and service monitoring.
                    </p>
                  </div>
                  <div className="pt-2 flex justify-between items-center">
                    <span className="text-xs text-slate-400">Server-side logs</span>
                    <a
                      href="https://logs.betterstack.com/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-800 transition-colors"
                    >
                      Open Better Stack <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Retention Policy */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-3">
              <div className="p-2 bg-violet-50 rounded-lg">
                <ClipboardPaste className="w-5 h-5 text-violet-600" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-slate-900">Packing Station</h2>
                <p className="text-sm text-slate-500">Control barcode input behaviour on the packing station</p>
              </div>
            </div>

            <div className="p-6">
              <div className="flex items-start justify-between gap-4 p-4 rounded-xl border border-slate-100 bg-slate-50/60">
                <div>
                  <p className="text-sm font-semibold text-slate-900">Allow copy &amp; paste in scan bar</p>
                  <p className="text-sm text-slate-500 mt-1 leading-relaxed">
                    When disabled (default), packers must use the barcode scanner — pasted barcodes are blocked.
                    When enabled, packers can paste barcodes into the scan field. Barcode format validation still applies.
                  </p>
                  <p className="text-xs text-slate-400 mt-2">Use Save Settings below to apply this change.</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.packingAllowPaste}
                  onClick={() => setSettings({ ...settings, packingAllowPaste: !settings.packingAllowPaste })}
                  className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 ${
                    settings.packingAllowPaste ? 'bg-primary-600' : 'bg-slate-300'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition ${
                      settings.packingAllowPaste ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            </div>
          </div>

          {/* Retention Policy */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-3">
              <div className="p-2 bg-primary-50 rounded-lg">
                <Database className="w-5 h-5 text-primary-600" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-slate-900">Data Retention Policy</h2>
                <p className="text-sm text-slate-500">Configure how long consignments, videos, proofs, and audit history are kept</p>
              </div>
            </div>

            <div className="p-6 space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">
                    Consignment Retention (days)
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="3650"
                    value={settings.consignmentRetentionDays}
                    onChange={e => setSettings({ ...settings, consignmentRetentionDays: e.target.value })}
                    className="w-full px-4 py-2.5 border border-slate-200 rounded-lg focus:ring-2 focus:ring-primary-500 outline-none"
                  />
                  <p className="text-xs text-slate-400 mt-1.5">
                    Consignments older than this will be auto-deleted. Default: 450 days
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">
                    Video Retention (days)
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="3650"
                    value={settings.videoRetentionDays}
                    onChange={e => setSettings({ ...settings, videoRetentionDays: e.target.value })}
                    className="w-full px-4 py-2.5 border border-slate-200 rounded-lg focus:ring-2 focus:ring-primary-500 outline-none"
                  />
                  <p className="text-xs text-slate-400 mt-1.5">
                    Videos older than Inward Date + this period will be deleted. Default: 60 days
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">
                    Weight Image Retention (days)
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="3650"
                    value={settings.weightImageRetentionDays || 90}
                    onChange={e => setSettings({ ...settings, weightImageRetentionDays: e.target.value })}
                    className="w-full px-4 py-2.5 border border-slate-200 rounded-lg focus:ring-2 focus:ring-primary-500 outline-none"
                  />
                  <p className="text-xs text-slate-400 mt-1.5">
                    Weight proofs older than Inward Date + this period will be deleted. Default: 90 days
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">
                    Audit Log Retention (days)
                  </label>
                  <input
                    type="number"
                    min="400"
                    max="3650"
                    value={settings.auditLogRetentionDays || 400}
                    onChange={e => setSettings({ ...settings, auditLogRetentionDays: e.target.value })}
                    className="w-full px-4 py-2.5 border border-slate-200 rounded-lg focus:ring-2 focus:ring-primary-500 outline-none"
                  />
                  <p className="text-xs text-slate-400 mt-1.5">
                    Audit logs cannot be manually deleted. Cleanup removes only logs older than this. Minimum/default: 400 days
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3 p-4 bg-amber-50 rounded-lg border border-amber-100">
                <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
                <div className="text-sm text-amber-800">
                  <strong>Warning:</strong> Reducing these values will cause more data to be deleted during the next cleanup run. Audit logs are protected from manual deletion, but logs older than the audit retention period are cleaned automatically to control database load. Deleted data cannot be recovered.
                </div>
              </div>

              <div className="flex items-center justify-between pt-2">
                <div className="flex items-center gap-2 text-sm text-slate-500">
                  <Clock className="w-4 h-4" />
                  <span>Last cleanup run: <strong className="text-slate-700">{fmtDate(settings.lastCleanupRun)}</strong></span>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setShowCleanupConfirm(true)}
                    disabled={runningCleanup}
                    className="flex items-center gap-2 px-4 py-2.5 border border-slate-200 text-slate-700 rounded-lg hover:bg-slate-50 text-sm font-medium transition-colors"
                  >
                    {runningCleanup ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                    Run Cleanup Now
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="flex items-center gap-2 px-4 py-2.5 bg-primary-600 text-white rounded-lg hover:bg-primary-700 text-sm font-medium transition-colors"
                  >
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                    Save Settings
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Info Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-5">
              <div className="flex items-center gap-2 mb-3">
                <Trash2 className="w-4 h-4 text-red-500" />
                <h3 className="text-sm font-semibold text-slate-900">Consignment Cleanup</h3>
              </div>
              <p className="text-sm text-slate-500 leading-relaxed">
                Consignments and all related data (SKUs, boxes, documents) are permanently removed after 
                <strong className="text-slate-700"> {settings.consignmentRetentionDays} days</strong> from creation.
              </p>
            </div>
            <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-5">
              <div className="flex items-center gap-2 mb-3">
                <Trash2 className="w-4 h-4 text-red-500" />
                <h3 className="text-sm font-semibold text-slate-900">Video Cleanup</h3>
              </div>
              <p className="text-sm text-slate-500 leading-relaxed">
                Packing videos are permanently removed from protected file storage <strong className="text-slate-700">{settings.videoRetentionDays} days</strong> after
                the consignment's Date of Inward. Orphaned videos are also cleaned up.
              </p>
              <div className="mt-3 p-3 bg-emerald-50 rounded-lg border border-emerald-100">
                <p className="text-xs text-emerald-700">
                  <strong>Protected:</strong> Videos are NEVER deleted if the consignment has a <strong>Ticket ID</strong> filled in. Clear the Ticket ID to allow normal 60-day deletion.
                </p>
              </div>
            </div>
            <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-5">
              <div className="flex items-center gap-2 mb-3">
                <Trash2 className="w-4 h-4 text-red-500" />
                <h3 className="text-sm font-semibold text-slate-900">Weight Proof Cleanup</h3>
              </div>
              <p className="text-sm text-slate-500 leading-relaxed">
                Box-wise weight scale proof photos are permanently removed from file storage <strong className="text-slate-700">{settings.weightImageRetentionDays || 90} days</strong> after
                the consignment's Date of Inward.
              </p>
              <div className="mt-3 p-3 bg-emerald-50 rounded-lg border border-emerald-100">
                <p className="text-xs text-emerald-700">
                  <strong>Protected:</strong> Proofs are NEVER deleted if the consignment has a <strong>Ticket ID</strong> filled in. Clear the Ticket ID to allow normal 90-day deletion.
                </p>
              </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-5">
              <div className="flex items-center gap-2 mb-3">
                <ShieldCheck className="w-4 h-4 text-primary-600" />
                <h3 className="text-sm font-semibold text-slate-900">Audit Log Cleanup</h3>
              </div>
              <p className="text-sm text-slate-500 leading-relaxed">
                Audit logs are not manually deletable by users. The retention cleanup removes only logs older than
                <strong className="text-slate-700"> {settings.auditLogRetentionDays || 400} days</strong> to keep the database fast.
              </p>
            </div>
          </div>
        </>
      ) : (
            <div className="space-y-6">
              {/* Live Server Logs Console */}
              <div className="bg-slate-900 rounded-xl shadow-lg border border-slate-800 overflow-hidden animate-fade-in">
                <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between gap-4 flex-wrap">
                  <div className="flex items-center gap-3">
                    <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
                    <div>
                      <h2 className="text-base font-bold text-slate-100">Live Server Console Logs</h2>
                      <p className="text-xs text-slate-400">Real-time log buffer from Node.js backend</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      onClick={() => setIsPollingLogs(!isPollingLogs)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all flex items-center gap-1.5 ${
                        isPollingLogs
                          ? 'bg-slate-800 border-slate-700 text-amber-400 hover:bg-slate-700'
                          : 'bg-emerald-950 border-emerald-800 text-emerald-300 hover:bg-emerald-900'
                      }`}
                    >
                      {isPollingLogs ? 'Pause Autoplay' : 'Resume Autoplay'}
                    </button>
                    <button
                      onClick={() => setLiveLogs([])}
                      className="px-3 py-1.5 bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 rounded-lg text-xs font-semibold transition-all"
                    >
                      Clear Terminal
                    </button>
                    <button
                      onClick={fetchLiveLogs}
                      className="px-3 py-1.5 bg-slate-800 border border-slate-700 text-slate-100 hover:bg-slate-700 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all"
                    >
                      <RefreshCw className="w-3 h-3" /> Force Refresh
                    </button>
                  </div>
                </div>
                <div className="p-4 bg-slate-950/70">
                  <pre className="bg-slate-950 text-slate-300 font-mono text-xs p-4 rounded-lg h-[320px] overflow-y-auto flex flex-col gap-1 select-text scrollbar-thin scrollbar-thumb-slate-800 scrollbar-track-transparent">
                    {liveLogs.length === 0 ? (
                      <div className="text-slate-500 py-12 text-center italic">Waiting for new console output logs...</div>
                    ) : (
                      liveLogs.map((log, idx) => {
                        let levelColor = 'text-slate-400';
                        if (log.level === 'warn') levelColor = 'text-amber-400';
                        if (log.level === 'error') levelColor = 'text-red-400 font-bold';
                        return (
                          <div key={idx} className="hover:bg-slate-900/50 py-0.5 px-1 rounded transition-colors flex items-start gap-3">
                            <span className="text-slate-600 shrink-0 select-none">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                            <span className={`uppercase font-bold text-[10px] tracking-wider px-1.5 py-0.2 rounded shrink-0 border border-transparent ${
                              log.level === 'error' ? 'bg-red-950/50 text-red-400 border-red-900/30' :
                              log.level === 'warn' ? 'bg-amber-950/50 text-amber-400 border-amber-900/30' :
                              'bg-slate-900/60 text-slate-400'
                            }`}>{log.level}</span>
                            <span className={`whitespace-pre-wrap break-all text-left ${levelColor}`}>{log.message}</span>
                          </div>
                        );
                      })
                    )}
                  </pre>
                </div>
              </div>

              {/* Embedded PostHog Dashboard */}
              <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden animate-fade-in">
                <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-orange-50 rounded-lg"><BarChart3 className="w-5 h-5 text-orange-600" /></div>
                    <div>
                      <h2 className="text-lg font-semibold text-slate-900">PostHog Analytics Embed</h2>
                      <p className="text-sm text-slate-500">Live operational dashboards &amp; traffic statistics</p>
                    </div>
                  </div>
                  {posthogDashboardUrl && (
                    <a
                      href={posthogDashboardUrl.replace('/embedded/', '/shared/')}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-800 transition-colors"
                    >
                      Open in PostHog <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>
                <div className="p-6">
                  {posthogDashboardUrl ? (
                    <div className="border border-slate-100 rounded-xl overflow-hidden shadow-sm bg-slate-50">
                      <iframe
                        src={posthogDashboardUrl}
                        width="100%"
                        height="600"
                        frameBorder="0"
                        allowFullScreen
                        sandbox="allow-scripts allow-same-origin allow-popups"
                        title="PostHog analytics dashboard"
                        className="rounded-xl"
                      ></iframe>
                    </div>
                  ) : (
                    <div className="text-center py-10 border border-dashed border-slate-200 rounded-xl bg-slate-50/50">
                      <BarChart3 className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                      <h4 className="text-base font-bold text-slate-800 mb-1">No PostHog Embed URL Set</h4>
                      <p className="text-sm text-slate-500 max-w-lg mx-auto mb-4">
                        Set <code className="bg-slate-100 px-1.5 py-0.5 rounded font-mono text-xs">POSTHOG_DASHBOARD_URL</code> on the backend
                        (Cloud Run env or GitHub variable <code className="bg-slate-100 px-1 py-0.5 rounded font-mono text-[11px]">VITE_POSTHOG_DASHBOARD_URL</code> for builds).
                        Use the PostHog <strong>embedded</strong> URL (<code className="bg-slate-100 px-1 py-0.5 rounded font-mono text-[11px]">/embedded/…</code>).
                        Open the <strong>System Logs &amp; Dashboards</strong> tab above to view the embed.
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {/* Embedded Better Stack Logs Dashboard */}
              <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden animate-fade-in">
                <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-sky-50 rounded-lg"><Activity className="w-5 h-5 text-sky-600" /></div>
                    <div>
                      <h2 className="text-lg font-semibold text-slate-900">Better Stack Logs Embed</h2>
                      <p className="text-sm text-slate-500">Full logs search, filters, and streaming tail</p>
                    </div>
                  </div>
                </div>
                <div className="p-6">
                  {betterStackDashboardUrl ? (
                    <div className="border border-slate-100 rounded-xl overflow-hidden shadow-sm bg-slate-50">
                      <iframe
                        src={betterStackDashboardUrl}
                        width="100%"
                        height="600"
                        frameBorder="0"
                        allowFullScreen
                        className="rounded-xl"
                      ></iframe>
                    </div>
                  ) : (
                    <div className="text-center py-10 border border-dashed border-slate-200 rounded-xl bg-slate-50/50">
                      <Activity className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                      <h4 className="text-base font-bold text-slate-800 mb-1">No Better Stack Shared URL Set</h4>
                      <p className="text-sm text-slate-500 max-w-md mx-auto mb-4">
                        To view your live backend logs, set the <code className="bg-slate-100 px-1.5 py-0.5 rounded font-mono text-xs">VITE_BETTERSTACK_DASHBOARD_URL</code> variable in your frontend configuration.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      <ConfirmModal
        show={showCleanupConfirm}
        title="Run Retention Cleanup?"
        variant="warning"
        confirmLabel="Yes, Run Cleanup"
        loading={runningCleanup}
        message={
          <span>
            This will permanently delete consignments older than <strong>{settings.consignmentRetentionDays} days</strong>,
            videos older than <strong>{settings.videoRetentionDays} days</strong>, weight proof images older than <strong>{settings.weightImageRetentionDays || 90} days</strong> after inward date, and audit logs older than <strong>{settings.auditLogRetentionDays || 400} days</strong>.
            <br /><br />
            <span className="text-amber-700 font-medium">Deleted data cannot be recovered.</span>
          </span>
        }
        onConfirm={handleRunCleanup}
        onCancel={() => setShowCleanupConfirm(false)}
      />

      <ConfirmModal
        show={showMigrateConfirm}
        title="Import Legacy Data?"
        variant="warning"
        confirmLabel="Yes, Start Migration"
        loading={migrating}
        message={
          <span>
            This legacy-only action retrieves existing archived records and upserts them into the primary live store.
            <br /><br />
            <span className="text-amber-700 font-medium">Any existing records with the same ID will be merged or overwritten. Proceed with caution.</span>
          </span>
        }
        onConfirm={handleMigration}
        onCancel={() => setShowMigrateConfirm(false)}
      />
    </div>
  );
}
