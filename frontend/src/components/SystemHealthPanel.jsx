import React, { useState, useEffect, useCallback } from 'react'
import { Activity, CheckCircle2, AlertTriangle, RefreshCw, HardDrive, Database, ShieldCheck, Cloud, UploadCloud, Radio, Trash2 } from 'lucide-react'
import { settingsAPI } from '../services/api'
import { getPendingScanCount, getFailedScanCount, resetFailedScans, clearFailedScans } from '../utils/scanQueue'
import { getPendingSyncJobCount, getFailedSyncJobCount, resetFailedSyncJobs, clearFailedSyncJobs } from '../utils/packingSyncQueue'
import { getQueueCount, getFailedCount, resetFailedToPending, clearFailedVideos, pruneDuplicateBoxVideos, clearLocalVideoCache } from '../utils/videoQueue'
import { processPackingSyncQueues } from '../services/packingSyncService'
import { processVideoUploadQueue } from '../services/videoUploadService'

function StatusPill({ ok, label }) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${
      ok ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-red-50 text-red-700 border-red-200'
    }`}>
      {ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
      {label}
    </span>
  )
}

function ServiceIcon({ tone = 'teal', icon: Icon }) {
  const toneClass = tone === 'amber' ? 'bg-amber-500' : tone === 'slate' ? 'bg-slate-900' : 'bg-primary-600'
  return (
    <div className={`w-9 h-9 rounded-lg ${toneClass} flex items-center justify-center`}>
      <Icon className="w-5 h-5 text-white" />
    </div>
  )
}

function ServiceCard({ logo, title, subtitle, status, children }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          {logo}
          <div>
            <h3 className="text-sm font-bold text-slate-900">{title}</h3>
            <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>
          </div>
        </div>
        {status}
      </div>
      {children}
    </div>
  )
}

export default function SystemHealthPanel() {
  const [health, setHealth] = useState(null)
  const [localSync, setLocalSync] = useState({
    pendingScans: 0,
    pendingVideos: 0,
    pendingSaveJobs: 0,
    failedJobs: 0,
    failedScans: 0,
    failedSaveJobs: 0,
    failedVideos: 0,
  })
  const [loading, setLoading] = useState(true)
  const [retrying, setRetrying] = useState(false)
  const [clearing, setClearing] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await settingsAPI.getSystemHealth()
      setHealth(res.data)
      const [pendingScans, failedScans, pendingSaveJobs, failedSaveJobs, pendingVideos, failedVideos] = await Promise.all([
        getPendingScanCount().catch(() => 0),
        getFailedScanCount().catch(() => 0),
        getPendingSyncJobCount().catch(() => 0),
        getFailedSyncJobCount().catch(() => 0),
        getQueueCount().catch(() => 0),
        getFailedCount().catch(() => 0),
      ])
      setLocalSync({
        pendingScans,
        pendingVideos,
        pendingSaveJobs,
        failedScans,
        failedSaveJobs,
        failedVideos,
        failedJobs: failedScans + failedSaveJobs + failedVideos,
      })
    } catch {
      setHealth(null)
    } finally {
      setLoading(false)
    }
  }, [])

  const retryFailedLocalSync = async () => {
    setRetrying(true)
    try {
      await pruneDuplicateBoxVideos().catch(() => 0)
      await Promise.all([
        resetFailedScans(),
        resetFailedSyncJobs(),
        resetFailedToPending(),
      ])
      await processPackingSyncQueues()
      await processVideoUploadQueue({ retryFailed: true, forceNow: true })
      await load()
    } catch (error) {
      console.error('[SystemHealth] retry local sync failed', error)
    } finally {
      setRetrying(false)
    }
  }

  const clearFailedLocalCaches = async () => {
    if (!window.confirm('Discard all failed local sync jobs (scans, boxes, videos) from this browser? Cloud data is not deleted.')) {
      return
    }
    setClearing(true)
    try {
      await Promise.all([
        clearFailedScans(),
        clearFailedSyncJobs(),
        clearFailedVideos(),
      ])
      await load()
    } catch (error) {
      console.error('[SystemHealth] clear failed caches failed', error)
    } finally {
      setClearing(false)
    }
  }

  const clearDuplicateVideos = async () => {
    setClearing(true)
    try {
      await pruneDuplicateBoxVideos()
      await load()
    } catch (error) {
      console.error('[SystemHealth] prune duplicates failed', error)
    } finally {
      setClearing(false)
    }
  }

  const clearAllVideoCache = async () => {
    if (!window.confirm('Clear ALL pending/failed packing videos from this browser? Unfinished boxes will need to be re-recorded.')) {
      return
    }
    setClearing(true)
    try {
      await clearLocalVideoCache('all')
      await load()
    } catch (error) {
      console.error('[SystemHealth] clear video cache failed', error)
    } finally {
      setClearing(false)
    }
  }

  useEffect(() => { load() }, [load])

  if (loading && !health) {
    return (
      <div className="bg-white rounded-xl border border-slate-100 p-8 text-center text-slate-400">
        <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2" />
        Loading system health...
      </div>
    )
  }

  if (!health) {
    return (
      <div className="bg-red-50 border border-red-100 rounded-xl p-6 text-red-700 text-sm">
        Unable to load system health. Ensure you are logged in as admin.
      </div>
    )
  }

  const dataService = health.dataService || health.postgres || {}
  const accessService = health.accessService || health.firebase || {}
  const fileService = health.fileService || health.storage || {}
  const liveSyncService = health.liveSyncService || {}
  const app = health.application || {}
  const validation = dataService.validation || {}

  return (
    <div className="space-y-4">
      {health.alerts?.length > 0 && (
        <div className="space-y-2">
          {health.alerts.map((alert, idx) => (
            <div
              key={idx}
              className={`rounded-xl border px-4 py-3 text-sm ${
                alert.level === 'critical'
                  ? 'bg-red-50 border-red-200 text-red-800'
                  : 'bg-amber-50 border-amber-200 text-amber-800'
              }`}
            >
              <p className="font-semibold">{alert.message}</p>
              {alert.hint && <p className="text-xs mt-1 opacity-90">{alert.hint}</p>}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-slate-900 rounded-xl">
            <Activity className="w-5 h-5 text-white" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-slate-900">System Monitoring</h2>
            <div className="text-xs text-slate-500 mt-1.5 flex flex-wrap items-center gap-1.5 font-semibold">
              <span className="bg-slate-100 px-2 py-0.5 rounded-lg font-mono text-[10px] text-slate-600 border border-slate-200/60">{app.name} v{app.version}</span>
              <span className="text-slate-300 select-none">•</span>
              <span className="bg-slate-100 px-2 py-0.5 rounded-lg font-mono text-[10px] text-slate-600 border border-slate-200/60 capitalize">{app.nodeEnv}</span>
              <span className="text-slate-300 select-none">•</span>
              <span className="bg-slate-100 px-2 py-0.5 rounded-lg font-mono text-[10px] text-slate-600 border border-slate-200/60">uptime {app.uptimeHuman}</span>
            </div>
          </div>
        </div>
        <StatusPill ok={health.healthy} label={health.healthy ? 'All systems healthy' : 'Needs attention'} />
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-2 px-4 py-2 border border-slate-200 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <ServiceCard
          logo={<ServiceIcon tone="amber" icon={UploadCloud} />}
          title="Local Sync Queue"
          subtitle="This browser's pending packing work"
          status={<StatusPill ok={localSync.failedJobs === 0} label={localSync.failedJobs ? 'Needs retry' : 'Ready'} />}
        >
          <dl className="space-y-2 text-xs">
            <div className="flex justify-between gap-2"><dt className="text-slate-500">Pending scans</dt><dd className="font-bold text-slate-900">{localSync.pendingScans}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-slate-500">Pending videos</dt><dd className="font-bold text-slate-900">{localSync.pendingVideos}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-slate-500">Pending boxes</dt><dd className="font-bold text-slate-900">{localSync.pendingSaveJobs}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-slate-500">Failed scans / boxes / videos</dt><dd className={`font-bold ${localSync.failedJobs ? 'text-red-600' : 'text-emerald-600'}`}>{localSync.failedScans || 0} / {localSync.failedSaveJobs || 0} / {localSync.failedVideos || 0}</dd></div>
            <p className="text-[10px] text-slate-500 bg-slate-50 border border-slate-100 rounded-lg p-2">Counts are from this browser IndexedDB. Failed jobs usually come from offline periods or interrupted video uploads. Use Clear to discard stale local retries that keep showing as 0/N uploaded.</p>
            <div className="flex flex-col gap-1.5 pt-1">
              {(localSync.failedJobs > 0 || localSync.pendingVideos > 0 || localSync.pendingScans > 0 || localSync.pendingSaveJobs > 0) && (
                <button
                  type="button"
                  onClick={retryFailedLocalSync}
                  disabled={retrying || clearing}
                  className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-60"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${retrying ? 'animate-spin' : ''}`} />
                  {retrying ? 'Retrying…' : 'Retry failed sync jobs'}
                </button>
              )}
              {(localSync.failedJobs > 0 || localSync.pendingVideos > 0) && (
                <>
                  <button
                    type="button"
                    onClick={clearDuplicateVideos}
                    disabled={retrying || clearing}
                    className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Clear duplicate videos
                  </button>
                  <button
                    type="button"
                    onClick={clearFailedLocalCaches}
                    disabled={retrying || clearing}
                    className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-60"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Discard failed local jobs
                  </button>
                  <button
                    type="button"
                    onClick={clearAllVideoCache}
                    disabled={retrying || clearing}
                    className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-60"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Clear all video cache
                  </button>
                </>
              )}
            </div>
          </dl>
        </ServiceCard>

        <ServiceCard
          logo={<ServiceIcon icon={Database} />}
          title={dataService.provider === 'cockroach' ? 'CockroachDB' : 'PostgreSQL'}
          subtitle={dataService.provider ? `${dataService.provider} — ${dataService.database || 'database'}` : 'Operational data store'}
          status={<StatusPill ok={dataService.connected} label={dataService.connected ? 'Connected' : 'Offline'} />}
        >
          <dl className="space-y-2 text-xs">
            <div className="flex justify-between gap-2"><dt className="text-slate-500">Provider</dt><dd className="font-medium text-slate-800 capitalize">{dataService.provider || '—'}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-slate-500">Host</dt><dd className="font-medium text-slate-800 text-right truncate max-w-[160px]">{dataService.host || '—'}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-slate-500">Latency</dt><dd className="font-medium text-slate-800">{dataService.latencyMs != null ? `${dataService.latencyMs}ms` : '—'}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-slate-500">Pool active</dt><dd className="font-medium text-slate-800">{dataService.pool?.totalCount ?? '—'} / {dataService.pool?.max ?? '—'}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-slate-500">Failed queries</dt><dd className="font-medium text-slate-800">{dataService.failedQueryCount ?? 0}</dd></div>
            {dataService.totalDocuments != null && (
              <div className="flex justify-between gap-2"><dt className="text-slate-500">Records</dt><dd className="font-bold text-primary-600">{dataService.totalDocuments?.toLocaleString()}</dd></div>
            )}
            {dataService.usage && (
              <>
                <div className="flex justify-between gap-2"><dt className="text-slate-500">Docs JSON size</dt><dd className="font-medium text-slate-800">{dataService.usage.approxDocumentsJsonPretty || '—'}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-slate-500">Free storage</dt><dd className="font-medium text-slate-800">{dataService.usage.freeTierStorageGiB} GiB / mo</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-slate-500">Free RUs</dt><dd className="font-medium text-slate-800">{Number(dataService.usage.freeTierRUs).toLocaleString()} / mo</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-slate-500">RUs used MTD</dt><dd className="font-medium text-slate-800">{dataService.usage.rusMonthToDate != null ? Number(dataService.usage.rusMonthToDate).toLocaleString() : 'See Cloud console'}</dd></div>
                <p className="text-[10px] text-slate-500 bg-slate-50 border border-slate-100 rounded-lg p-2">{dataService.usage.note}</p>
              </>
            )}
            {!validation.valid && (
              <p className="text-[10px] text-red-600 bg-red-50 border border-red-100 rounded-lg p-2 mt-1">{validation.error}</p>
            )}
            {dataService.error && validation.valid && (
              <p className="text-[10px] text-red-600 bg-red-50 border border-red-100 rounded-lg p-2 mt-1">{dataService.error}</p>
            )}
          </dl>
        </ServiceCard>

        <ServiceCard
          logo={<ServiceIcon tone="amber" icon={ShieldCheck} />}
          title="Firebase Auth"
          subtitle={accessService.projectId || 'Identity service'}
          status={<StatusPill ok={accessService.available} label={accessService.available ? 'Active' : 'Unavailable'} />}
        >
          <dl className="space-y-2 text-xs">
            <div className="flex justify-between gap-2"><dt className="text-slate-500">Project</dt><dd className="font-medium text-slate-800 text-right truncate max-w-[160px]">{accessService.projectId || '—'}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-slate-500">Auth domain</dt><dd className="font-medium text-slate-800 text-right truncate max-w-[160px]">{accessService.authDomain || '—'}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-slate-500">Secure access</dt><dd className="font-medium text-slate-800">{accessService.available ? 'Verified' : 'Not available'}</dd></div>
            {(accessService.setupRequired || accessService.error) && (
              <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-100 rounded-lg p-2 mt-1">Firebase Authentication needs setup or credentials.</p>
            )}
          </dl>
        </ServiceCard>

        <ServiceCard
          logo={<ServiceIcon tone="slate" icon={Cloud} />}
          title="Cloudflare R2"
          subtitle={fileService.provider || 'Object storage'}
          status={<StatusPill ok={fileService.reachable} label={fileService.reachable ? 'Reachable' : (fileService.configured ? 'Offline' : 'Not configured')} />}
        >
          <dl className="space-y-2 text-xs">
            <div className="flex justify-between gap-2"><dt className="text-slate-500">Storage provider</dt><dd className="font-medium text-slate-800">Cloudflare R2</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-slate-500">Bucket</dt><dd className="font-medium text-slate-800 text-right truncate max-w-[160px]">{fileService.bucket || '—'}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-slate-500">Connection</dt><dd className="font-medium text-slate-800 capitalize">{fileService.configured ? (fileService.reachable ? 'Connected' : 'Unreachable') : 'Not configured'}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-slate-500">Storage health</dt><dd className="font-medium text-slate-800 capitalize">{fileService.health || (fileService.reachable ? 'healthy' : '—')}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-slate-500">Upload mode</dt><dd className="font-medium text-slate-800">{fileService.uploadMode === 'signed-put-direct' ? 'Signed direct upload' : (fileService.uploadMode || '—')}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-slate-500">File access</dt><dd className="font-medium text-slate-800">{fileService.fileAccess === 'authenticated-stream' ? 'Auth stream only' : (fileService.fileAccess || '—')}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-slate-500">API status</dt><dd className="font-medium text-slate-800 capitalize">{health.api?.status || '—'}</dd></div>
            <div className="flex items-center gap-1.5 text-slate-500 pt-1">
              <HardDrive className="w-3.5 h-3.5" />
              <span>Last check {fileService.checkedAt ? new Date(fileService.checkedAt).toLocaleTimeString() : (health.api?.timestamp ? new Date(health.api.timestamp).toLocaleTimeString() : '—')}</span>
            </div>
            {fileService.error && (
              <p className="text-[10px] text-red-600 bg-red-50 border border-red-100 rounded-lg p-2 mt-1">{fileService.error}</p>
            )}
          </dl>
        </ServiceCard>

        <ServiceCard
          logo={<ServiceIcon icon={Radio} />}
          title="Supabase Live Sync"
          subtitle={liveSyncService.mode === 'broadcast' ? 'Realtime Broadcast (no DB/Storage)' : 'Cross-client live updates'}
          status={<StatusPill ok={liveSyncService.configured} label={liveSyncService.configured ? 'Configured' : 'Fallback only'} />}
        >
          <dl className="space-y-2 text-xs">
            <div className="flex justify-between gap-2"><dt className="text-slate-500">Provider</dt><dd className="font-medium text-slate-800">{liveSyncService.provider || '—'}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-slate-500">Mode</dt><dd className="font-medium text-slate-800 capitalize">{liveSyncService.mode || '—'}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-slate-500">Channel</dt><dd className="font-medium text-slate-800 text-right truncate max-w-[160px]">{liveSyncService.topic || '—'}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-slate-500">Uses Supabase DB</dt><dd className="font-medium text-slate-800">{liveSyncService.usesSupabaseDatabase ? 'Yes' : 'No'}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-slate-500">Uses Supabase Storage</dt><dd className="font-medium text-slate-800">{liveSyncService.usesSupabaseStorage ? 'Yes' : 'No'}</dd></div>
            <p className="text-[10px] text-slate-500 bg-slate-50 border border-slate-100 rounded-lg p-2">
              {liveSyncService.note || 'SSE and polling remain as fallbacks when Realtime is offline.'}
            </p>
          </dl>
        </ServiceCard>
      </div>
    </div>
  )
}
