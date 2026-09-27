import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import {
  Boxes,
  RefreshCw,
  Settings,
  LogOut,
  HardDrive,
  Search,
  X,
  ShieldCheck,
  CheckCircle2,
  Clock,
  Video,
  AlertTriangle,
  AlertOctagon,
  Copy,
  Check,
  CheckCheck,
  ArrowRight,
  Layers,
  Wifi,
  WifiOff,
  User,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import api from '../services/api'

const desktop = window.youthnicDesktop
const gb = (bytes) => (bytes == null ? 'Unavailable' : `${(bytes / 1024 ** 3).toFixed(1)} GB`)

const TABS = [
  { id: 'consignments', label: 'Consignments', icon: Boxes },
  { id: 'sync', label: 'Sync center', icon: RefreshCw },
  { id: 'settings', label: 'Station settings', icon: Settings },
]

export default function DesktopHome() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const searchInputId = useId()

  const [tab, setTab] = useState('consignments')
  const [cached, setCached] = useState([])
  const [available, setAvailable] = useState([])
  const [status, setStatus] = useState({ boxes: [] })
  const [station, setStation] = useState(null)
  const [health, setHealth] = useState(null)
  const [info, setInfo] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [online, setOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true)
  const [recoveries, setRecoveries] = useState([])
  const [searchQuery, setSearchQuery] = useState('')
  const [copiedField, setCopiedField] = useState(null)
  const [savedSettings, setSavedSettings] = useState(false)

  const tabListRef = useRef(null)

  const canPack = ['admin', 'organization_head'].includes(user?.role) || user?.permissions?.packing === true

  const refresh = useCallback(async () => {
    if (!canPack || !desktop) return
    setBusy(true)
    setError('')
    try {
      const [rows, counts, settings, disk, version, recovery] = await Promise.all([
        desktop.packing.listCachedConsignments(),
        desktop.sync.status(),
        desktop.station.get(),
        desktop.storage.health(),
        desktop.app.info(),
        desktop.video.recover(),
      ])
      setCached(rows || [])
      setStatus(counts || { boxes: [] })
      setStation(settings)
      setHealth(disk)
      setInfo(version)
      setRecoveries(recovery || [])

      try {
        const { data } = await api.get('/consignments', {
          params: { status: 'pending,in_progress', limit: 200 },
          timeout: 8000,
        })
        setAvailable(data?.consignments || [])
        setOnline(true)
      } catch {
        setOnline(false)
      }
    } catch (failure) {
      setError(failure.message || 'Station data could not be loaded')
    } finally {
      setBusy(false)
    }
  }, [canPack])

  useEffect(() => {
    void refresh()
    if (!desktop?.sync?.onStatus) return undefined

    const unsubscribe = desktop.sync.onStatus((update) => {
      setStatus((current) => ({ ...current, ...update }))
      if (typeof update.online === 'boolean') setOnline(update.online)
    })
    const offline = () => setOnline(false)
    window.addEventListener('online', refresh)
    window.addEventListener('offline', offline)
    return () => {
      unsubscribe()
      window.removeEventListener('online', refresh)
      window.removeEventListener('offline', offline)
    }
  }, [refresh])

  const saveSettings = async (event) => {
    event.preventDefault()
    if (!desktop?.station) return
    setBusy(true)
    setError('')
    setSavedSettings(false)
    try {
      const form = new FormData(event.currentTarget)
      const updated = await desktop.station.update({
        stationName: form.get('name'),
        warehouse: form.get('warehouse'),
      })
      setStation(updated)
      setSavedSettings(true)
      setTimeout(() => setSavedSettings(false), 3000)
    } catch (failure) {
      setError(failure.message || 'Failed to save station settings')
    } finally {
      setBusy(false)
    }
  }

  const copyToClipboard = (text, fieldName) => {
    if (!text || typeof navigator === 'undefined' || !navigator.clipboard) return
    navigator.clipboard.writeText(text).then(() => {
      setCopiedField(fieldName)
      setTimeout(() => setCopiedField(null), 2000)
    }).catch(() => {})
  }

  // WAI-ARIA tab keyboard navigation (ArrowLeft / ArrowRight / Home / End)
  const handleTabKeyDown = (event, currentIdx) => {
    let nextIdx = null
    if (event.key === 'ArrowRight') {
      nextIdx = (currentIdx + 1) % TABS.length
    } else if (event.key === 'ArrowLeft') {
      nextIdx = (currentIdx - 1 + TABS.length) % TABS.length
    } else if (event.key === 'Home') {
      nextIdx = 0
    } else if (event.key === 'End') {
      nextIdx = TABS.length - 1
    }

    if (nextIdx !== null) {
      event.preventDefault()
      const nextTab = TABS[nextIdx]
      setTab(nextTab.id)
      const targetBtn = tabListRef.current?.querySelector(`[data-tab-id="${nextTab.id}"]`)
      targetBtn?.focus()
    }
  }

  // Filtered lists
  const query = searchQuery.trim().toLowerCase()
  const filteredCached = useMemo(() => {
    if (!query) return cached
    return cached.filter((c) => {
      const shipment = (c.internalShipmentNo || '').toLowerCase()
      const cid = (c.consignmentId || '').toLowerCase()
      return shipment.includes(query) || cid.includes(query)
    })
  }, [cached, query])

  const filteredAvailable = useMemo(() => {
    const cachedIds = new Set(cached.map((local) => local.consignmentId))
    const unCached = available.filter((row) => !cachedIds.has(row.id))
    if (!query) return unCached
    return unCached.filter((row) => {
      const shipment = (row.internalShipmentNo || '').toLowerCase()
      const id = (row.id || '').toLowerCase()
      const market = (row.marketplace || '').toLowerCase()
      return shipment.includes(query) || id.includes(query) || market.includes(query)
    })
  }, [available, cached, query])

  // Disk metrics
  const totalBytes = health?.totalBytes || 0
  const freeBytes = health?.freeBytes || 0
  const usedBytes = totalBytes > freeBytes ? totalBytes - freeBytes : 0
  const percentUsed = totalBytes > 0 ? Math.min(100, Math.max(0, Math.round((usedBytes / totalBytes) * 100))) : 0

  // Pending counts
  const pendingTotal = (status.pendingData || 0) + (status.pendingVideos || 0)

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 antialiased">
      {/* Station Header */}
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 px-6 py-4 shadow-2xs backdrop-blur-sm sm:px-8">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-600 text-white shadow-sm ring-4 ring-primary-50">
              <Boxes size={22} aria-hidden="true" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold tracking-widest text-primary-600 uppercase">
                  Youthnic Operations
                </span>
                <span className="h-1 w-1 rounded-full bg-slate-300"></span>
                <span className="text-xs text-slate-500">Desktop Station</span>
              </div>
              <h1 className="text-lg font-bold text-slate-900 tracking-tight sm:text-xl">
                Packing Station
              </h1>
              <p className="text-xs text-slate-500">
                {station?.station_name || 'Warehouse station'}
                {station?.warehouse ? ` · ${station.warehouse}` : ''}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {/* Live Connectivity Badge */}
            <div
              role="status"
              aria-live="polite"
              className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold shadow-2xs ${
                online
                  ? 'border border-emerald-200 bg-emerald-50 text-emerald-800'
                  : 'border border-amber-200 bg-amber-50 text-amber-800'
              }`}
            >
              {online ? (
                <>
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500"></span>
                  </span>
                  <Wifi size={13} aria-hidden="true" />
                  <span>Online · Cloud synced</span>
                </>
              ) : (
                <>
                  <span className="h-2 w-2 rounded-full bg-amber-500"></span>
                  <WifiOff size={13} aria-hidden="true" />
                  <span>Offline · local packing available</span>
                </>
              )}
            </div>

            {/* Operator Pill */}
            {user?.name && (
              <div className="hidden items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 sm:flex">
                <User size={13} className="text-slate-400" aria-hidden="true" />
                <span className="max-w-[130px] truncate">{user.name}</span>
              </div>
            )}

            {/* Sign Out Button */}
            <button
              type="button"
              onClick={logout}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-2xs transition hover:border-red-200 hover:bg-red-50 hover:text-red-700 focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:outline-none"
            >
              <LogOut size={14} aria-hidden="true" />
              <span>Sign out</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="mx-auto max-w-6xl space-y-6 px-6 py-8 sm:px-8">
        {!canPack ? (
          <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-amber-900 shadow-xs">
            <h2 className="text-base font-bold">Packing Permission Required</h2>
            <p className="mt-1 text-sm text-amber-800">
              Your account needs packing permission to use this workstation. Contact your administrator to enable packing rights.
            </p>
          </div>
        ) : (
          <>
            {/* Primary Navigation Tabs (WAI-ARIA compliant tablist) */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
              <div
                ref={tabListRef}
                role="tablist"
                aria-label="Station views"
                className="flex flex-wrap items-center gap-2"
              >
                {TABS.map(({ id, label, icon: Icon }, idx) => {
                  const isSelected = tab === id
                  return (
                    <button
                      key={id}
                      role="tab"
                      id={`tab-${id}`}
                      data-tab-id={id}
                      aria-selected={isSelected}
                      aria-controls={`panel-${id}`}
                      tabIndex={isSelected ? 0 : -1}
                      onClick={() => setTab(id)}
                      onKeyDown={(e) => handleTabKeyDown(e, idx)}
                      className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:outline-none ${
                        isSelected
                          ? 'bg-primary-600 text-white shadow-sm ring-1 ring-primary-700'
                          : 'border border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      <Icon size={16} aria-hidden="true" />
                      <span>{label}</span>

                      {/* Tab Badges */}
                      {id === 'consignments' && cached.length > 0 && (
                        <span
                          className={`ml-1 rounded-full px-2 py-0.5 text-[11px] font-bold ${
                            isSelected
                              ? 'bg-primary-700 text-white'
                              : 'bg-emerald-100 text-emerald-800'
                          }`}
                        >
                          {cached.length}
                        </span>
                      )}

                      {id === 'sync' && (
                        <>
                          {pendingTotal > 0 ? (
                            <span
                              className={`ml-1 rounded-full px-2 py-0.5 text-[11px] font-bold ${
                                isSelected
                                  ? 'bg-amber-400 text-slate-900'
                                  : 'bg-amber-100 text-amber-800'
                              }`}
                            >
                              {pendingTotal}
                            </span>
                          ) : recoveries.length > 0 ? (
                            <span className="ml-1 flex h-2 w-2 rounded-full bg-amber-500" title="Recovery review needed" />
                          ) : null}
                        </>
                      )}
                    </button>
                  )
                })}
              </div>

              {/* Refresh Action */}
              <button
                type="button"
                disabled={busy}
                onClick={refresh}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 shadow-2xs transition hover:border-slate-300 hover:bg-slate-50 disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:outline-none"
              >
                <RefreshCw size={13} className={busy ? 'animate-spin' : ''} aria-hidden="true" />
                <span>{busy ? 'Loading…' : 'Refresh'}</span>
              </button>
            </div>

            {/* Error Banner */}
            {error && (
              <div
                role="alert"
                className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 shadow-xs"
              >
                <AlertTriangle size={18} className="mt-0.5 shrink-0 text-red-600" aria-hidden="true" />
                <div className="flex-1">
                  <p className="font-semibold">Station Attention Required</p>
                  <p className="mt-0.5">{error}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setError('')}
                  className="rounded p-1 text-red-600 hover:bg-red-100"
                  aria-label="Dismiss error"
                >
                  <X size={14} />
                </button>
              </div>
            )}

            {/* Disk Health Warning Banner */}
            {(health?.low || health?.unavailable) && (
              <div
                role="alert"
                className={`flex items-start gap-3 rounded-xl border p-4 text-sm shadow-xs ${
                  health?.critical || health?.unavailable
                    ? 'border-red-200 bg-red-50 text-red-900'
                    : 'border-amber-200 bg-amber-50 text-amber-900'
                }`}
              >
                <HardDrive size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
                <div>
                  <p className="font-bold">
                    {health?.critical || health?.unavailable
                      ? 'Recording Blocked: Critical Disk Storage'
                      : 'Low Disk Storage Warning'}
                  </p>
                  <p className="mt-0.5">
                    {health?.critical || health?.unavailable
                      ? 'Recording is blocked until sufficient disk space can be confirmed. Unsynced evidence is preserved.'
                      : 'Disk space is low. Free space before recording more boxes. Unsynced evidence is preserved.'}
                  </p>
                  <p className="mt-1 text-xs opacity-80">
                    Remaining: {gb(health?.freeBytes)} of {gb(health?.totalBytes)}
                  </p>
                </div>
              </div>
            )}

            {/* Tab 1: Consignments Panel */}
            {tab === 'consignments' && (
              <section
                role="tabpanel"
                id="panel-consignments"
                aria-labelledby="tab-consignments"
                tabIndex={0}
                className="space-y-6 outline-none"
              >
                {/* Section Header & Fast Launch */}
                <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-xs sm:p-6">
                  <div>
                    <h2 className="text-xl font-bold tracking-tight text-slate-900">
                      Ready offline
                    </h2>
                    <p className="mt-1 text-sm text-slate-600">
                      Downloaded work is kept on this computer. Open Packing to resume a box or select another consignment.
                    </p>
                  </div>
                  <Link
                    to="/packing"
                    className="inline-flex items-center gap-2 rounded-xl bg-primary-600 px-5 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-primary-700 active:scale-98 focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:outline-none"
                  >
                    <span>Open packing</span>
                    <ArrowRight size={16} aria-hidden="true" />
                  </Link>
                </div>

                {/* Search & Filter Bar */}
                <div className="relative">
                  <label htmlFor={searchInputId} className="sr-only">
                    Search consignments
                  </label>
                  <Search
                    size={16}
                    className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-slate-400"
                    aria-hidden="true"
                  />
                  <input
                    id={searchInputId}
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search shipments by ID, number, carrier or marketplace…"
                    className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pr-10 pl-10 text-sm text-slate-900 placeholder:text-slate-400 shadow-2xs transition hover:border-slate-300 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 focus:outline-none"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      className="absolute top-1/2 right-3 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-slate-600"
                      aria-label="Clear search"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>

                {/* Ready Offline Cards */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold tracking-wider text-slate-500 uppercase">
                      Downloaded on Station ({filteredCached.length})
                    </span>
                    {searchQuery && (
                      <span className="text-xs text-slate-500">Filtered by &ldquo;{searchQuery}&rdquo;</span>
                    )}
                  </div>

                  {filteredCached.length > 0 ? (
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {filteredCached.map((row) => (
                        <button
                          key={row.consignmentId}
                          type="button"
                          onClick={() =>
                            navigate('/packing', { state: { consignmentId: row.consignmentId } })
                          }
                          className="group relative flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-5 text-left shadow-2xs transition hover:border-primary-300 hover:bg-slate-50/50 hover:shadow-xs focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:outline-none"
                        >
                          <div>
                            <div className="flex items-start justify-between gap-2">
                              <strong className="text-base font-bold text-slate-900 group-hover:text-primary-600">
                                {row.internalShipmentNo || row.consignmentId}
                              </strong>
                              <ShieldCheck
                                size={18}
                                className="shrink-0 text-emerald-600"
                                aria-hidden="true"
                              />
                            </div>
                            <div className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
                              <span>Ready offline · resume local work</span>
                            </div>
                          </div>

                          <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3 text-xs text-slate-500">
                            <span>ID: {row.consignmentId}</span>
                            <span className="inline-flex items-center gap-1 font-semibold text-primary-600 group-hover:translate-x-0.5 transition-transform">
                              Resume <ArrowRight size={12} />
                            </span>
                          </div>
                        </button>
                      ))}
                    </div>
                  ) : searchQuery ? (
                    <div className="rounded-xl border border-dashed border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
                      No downloaded consignments match &ldquo;{searchQuery}&rdquo;.
                    </div>
                  ) : (
                    <div className="rounded-xl border border-dashed border-slate-200 bg-white p-6 text-center text-sm text-slate-600">
                      No downloaded consignments yet. Open Packing while online to download and claim your first consignment, or select one below from Available online.
                    </div>
                  )}
                </div>

                {/* Available Online Section */}
                <div className="space-y-3 pt-4">
                  <div className="flex items-center justify-between border-t border-slate-200 pt-6">
                    <h2 className="flex items-center gap-2 text-lg font-bold text-slate-900">
                      <span>Available online</span>
                      <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600">
                        {filteredAvailable.length}
                      </span>
                    </h2>
                    {online ? (
                      <span className="text-xs text-slate-500">Server consignments awaiting packing</span>
                    ) : (
                      <span className="text-xs text-amber-700 font-medium">Reconnect to refresh online list</span>
                    )}
                  </div>

                  {filteredAvailable.length > 0 ? (
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {filteredAvailable.map((row) => (
                        <button
                          key={row.id}
                          type="button"
                          onClick={() => navigate('/packing', { state: { consignmentId: row.id } })}
                          className="group flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-5 text-left shadow-2xs transition hover:border-slate-300 hover:bg-slate-50/50 hover:shadow-xs focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:outline-none"
                        >
                          <div>
                            <div className="flex items-start justify-between gap-2">
                              <strong className="text-base font-bold text-slate-900 group-hover:text-primary-600">
                                {row.internalShipmentNo || row.id}
                              </strong>
                              {row.marketplace && (
                                <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                                  {row.marketplace}
                                </span>
                              )}
                            </div>
                            <p className="mt-2 text-xs font-medium text-slate-600">
                              Download in Packing · {row.status}
                            </p>
                          </div>

                          <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3 text-xs text-slate-500">
                            <span>ID: {row.id}</span>
                            <span className="inline-flex items-center gap-1 font-semibold text-slate-700 group-hover:text-primary-600">
                              Claim &amp; Pack <ArrowRight size={12} />
                            </span>
                          </div>
                        </button>
                      ))}
                    </div>
                  ) : !online ? (
                    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600">
                      <WifiOff size={20} className="text-slate-400" />
                      <div>
                        <p className="font-semibold text-slate-900">Station is Offline</p>
                        <p className="text-xs text-slate-500">
                          Online shipments will appear once network connectivity is restored.
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-xl border border-dashed border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
                      {searchQuery
                        ? `No online consignments match "${searchQuery}".`
                        : 'No pending consignments waiting on the server.'}
                    </div>
                  )}
                </div>
              </section>
            )}

            {/* Tab 2: Sync Center Panel */}
            {tab === 'sync' && (
              <section
                role="tabpanel"
                id="panel-sync"
                aria-labelledby="tab-sync"
                tabIndex={0}
                className="space-y-6 outline-none"
              >
                {/* 4 Stat KPI Cards */}
                <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                  {/* Card 1: Safe locally */}
                  <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-bold tracking-wider text-slate-500 uppercase">
                        Safe locally
                      </p>
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
                        <ShieldCheck size={18} aria-hidden="true" />
                      </div>
                    </div>
                    <p className="mt-3 text-3xl font-extrabold text-slate-900">
                      {status.localSafe || 0}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">Durable in local SQLite ledger</p>
                  </div>

                  {/* Card 2: Cloud synced */}
                  <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-bold tracking-wider text-slate-500 uppercase">
                        Cloud synced
                      </p>
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-50 text-sky-600">
                        <CheckCircle2 size={18} aria-hidden="true" />
                      </div>
                    </div>
                    <p className="mt-3 text-3xl font-extrabold text-slate-900">
                      {status.cloudSynced || 0}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">Confirmed received by server</p>
                  </div>

                  {/* Card 3: Pending data */}
                  <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-bold tracking-wider text-slate-500 uppercase">
                        Pending data
                      </p>
                      <div
                        className={`flex h-8 w-8 items-center justify-center rounded-lg ${
                          status.pendingData > 0
                            ? 'bg-amber-50 text-amber-600'
                            : 'bg-slate-50 text-slate-400'
                        }`}
                      >
                        <Clock size={18} aria-hidden="true" />
                      </div>
                    </div>
                    <p className="mt-3 text-3xl font-extrabold text-slate-900">
                      {status.pendingData || 0}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">Box scans &amp; records queued</p>
                  </div>

                  {/* Card 4: Pending videos */}
                  <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-bold tracking-wider text-slate-500 uppercase">
                        Pending videos
                      </p>
                      <div
                        className={`flex h-8 w-8 items-center justify-center rounded-lg ${
                          status.pendingVideos > 0
                            ? 'bg-violet-50 text-violet-600'
                            : 'bg-slate-50 text-slate-400'
                        }`}
                      >
                        <Video size={18} aria-hidden="true" />
                      </div>
                    </div>
                    <p className="mt-3 text-3xl font-extrabold text-slate-900">
                      {status.pendingVideos || 0}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">High-res evidence awaiting upload</p>
                  </div>
                </div>

                {/* Sync Queue Explanation Banner */}
                <div className="flex items-start gap-3.5 rounded-2xl border border-slate-200 bg-slate-50/70 p-5 text-sm text-slate-700">
                  <Layers size={20} className="mt-0.5 shrink-0 text-primary-600" aria-hidden="true" />
                  <div>
                    <p className="font-semibold text-slate-900">Sequential Outbox Guarantee</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-slate-600">
                      Boxes upload in order: box data, then its video, then the next box. Packing can continue during upload. Pending work resumes when the app is opened again.
                    </p>
                  </div>
                </div>

                {/* Actions Toolbar */}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <button
                    type="button"
                    disabled={busy || !desktop?.sync}
                    onClick={async () => {
                      if (!desktop?.sync) return
                      setBusy(true)
                      try {
                        await desktop.sync.retry()
                        await refresh()
                      } catch (failure) {
                        setError(failure.message || 'Retry failed')
                      } finally {
                        setBusy(false)
                      }
                    }}
                    className="inline-flex items-center gap-2 rounded-xl bg-primary-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-primary-700 active:scale-98 disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:outline-none"
                  >
                    <RefreshCw size={15} className={busy ? 'animate-spin' : ''} aria-hidden="true" />
                    <span>Retry pending uploads</span>
                  </button>

                  <span className="text-xs text-slate-500">
                    {online ? 'Background sync active' : 'Sync paused until connection returns'}
                  </span>
                </div>

                {/* Last Sync Error */}
                {status.lastError && (
                  <div
                    role="alert"
                    className="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
                  >
                    <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-600" aria-hidden="true" />
                    <div>
                      <p className="font-semibold">Last Synchronization Warning</p>
                      <p className="mt-0.5 text-xs">{status.lastError}</p>
                    </div>
                  </div>
                )}

                {/* Active Box Queue Table */}
                <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs">
                  <div className="border-b border-slate-100 bg-slate-50/80 px-5 py-3">
                    <h3 className="text-xs font-bold tracking-wider text-slate-600 uppercase">
                      Box Upload Outbox ({status.boxes?.length || 0})
                    </h3>
                  </div>
                  {status.boxes && status.boxes.length > 0 ? (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-sm">
                        <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600 uppercase tracking-wider">
                          <tr>
                            {['Consignment', 'Box', 'Box data', 'Video'].map((label) => (
                              <th key={label} scope="col" className="px-5 py-3.5">
                                {label}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {status.boxes.map((box) => {
                            const isDataSynced = box.state === 'SYNCED'
                            const isVideoSynced = box.video_state === 'SYNCED'
                            return (
                              <tr key={box.box_id} className="hover:bg-slate-50/50 transition">
                                <td className="px-5 py-3.5 font-medium text-slate-900">
                                  {box.consignment_id}
                                </td>
                                <td className="px-5 py-3.5 font-semibold text-slate-800">
                                  Box {box.box_no}
                                </td>
                                <td className="px-5 py-3.5">
                                  <span
                                    className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                                      isDataSynced
                                        ? 'bg-emerald-50 text-emerald-700'
                                        : 'bg-amber-50 text-amber-700'
                                    }`}
                                  >
                                    {isDataSynced ? <Check size={11} /> : <Clock size={11} />}
                                    {box.state.replaceAll('_', ' ')}
                                  </span>
                                </td>
                                <td className="px-5 py-3.5">
                                  <span
                                    className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                                      isVideoSynced
                                        ? 'bg-emerald-50 text-emerald-700'
                                        : 'bg-indigo-50 text-indigo-700'
                                    }`}
                                  >
                                    {isVideoSynced ? <Check size={11} /> : <Video size={11} />}
                                    {box.video_state?.replaceAll('_', ' ') || 'None'}
                                  </span>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center p-8 text-center text-sm text-slate-500">
                      <CheckCheck size={28} className="text-emerald-500" aria-hidden="true" />
                      <p className="mt-2 font-semibold text-slate-800">All Packed Boxes are Synchronized</p>
                      <p className="text-xs text-slate-500">No pending jobs in the local SQLite outbox.</p>
                    </div>
                  )}
                </div>

                {/* Recovery Alert for Interrupted Videos */}
                {recoveries.length > 0 && (
                  <div
                    role="alert"
                    className="rounded-2xl border border-amber-200 bg-amber-50/80 p-5 shadow-xs"
                  >
                    <div className="flex items-start gap-3">
                      <AlertOctagon size={20} className="mt-0.5 shrink-0 text-amber-700" aria-hidden="true" />
                      <div className="flex-1">
                        <h3 className="font-bold text-amber-900">
                          Interrupted recordings need review
                        </h3>
                        <p className="mt-0.5 text-xs text-amber-800 leading-relaxed">
                          Partial recordings are preserved. Resume the open box with a new recording; do not delete its recovery files.
                        </p>
                        <ul className="mt-3 divide-y divide-amber-200/60 rounded-xl border border-amber-200 bg-white/70 text-xs">
                          {recoveries.map((item) => (
                            <li key={item.path} className="flex items-center justify-between p-3">
                              <span className="font-mono text-slate-800">{item.videoId}</span>
                              <span className="font-semibold text-slate-600">
                                {(item.sizeBytes / 1024 ** 2).toFixed(1)} MB
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </div>
                )}
              </section>
            )}

            {/* Tab 3: Station Settings Panel */}
            {tab === 'settings' && (
              <section
                role="tabpanel"
                id="panel-settings"
                aria-labelledby="tab-settings"
                tabIndex={0}
                className="max-w-3xl space-y-6 outline-none"
              >
                {/* Station Form Card */}
                <form
                  onSubmit={saveSettings}
                  className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs space-y-5"
                >
                  <div className="flex items-center justify-between border-b border-slate-100 pb-4">
                    <div>
                      <h2 className="text-lg font-bold text-slate-900">Station settings</h2>
                      <p className="text-xs text-slate-500">
                        Station identity reported in dispatch audit trails and video manifests.
                      </p>
                    </div>
                    {savedSettings && (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 border border-emerald-200">
                        <Check size={13} />
                        Saved
                      </span>
                    )}
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="block text-sm font-semibold text-slate-700">
                      Station name
                      <input
                        key={station?.station_name}
                        name="name"
                        required
                        maxLength={100}
                        defaultValue={station?.station_name}
                        className="mt-1.5 block w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-2xs transition focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 focus:outline-none"
                      />
                    </label>

                    <label className="block text-sm font-semibold text-slate-700">
                      Warehouse
                      <input
                        key={station?.warehouse}
                        name="warehouse"
                        maxLength={100}
                        defaultValue={station?.warehouse || ''}
                        placeholder="e.g. Surat Main Unit"
                        className="mt-1.5 block w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-2xs transition focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 focus:outline-none"
                      />
                    </label>
                  </div>

                  <div className="flex items-center justify-between pt-2">
                    <button
                      type="submit"
                      disabled={busy}
                      className="inline-flex items-center gap-2 rounded-xl bg-primary-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-primary-700 active:scale-98 disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:outline-none"
                    >
                      <Check size={15} aria-hidden="true" />
                      <span>Save settings</span>
                    </button>
                    <p className="text-xs text-slate-500">Changes persist to local SQLite configuration.</p>
                  </div>

                  {/* Hardware & Diagnostics Details List */}
                  <dl className="space-y-4 border-t border-slate-100 pt-6 text-sm">
                    {/* Station ID */}
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                      <dt className="font-bold text-slate-700">Station ID</dt>
                      <dd className="flex items-center gap-2 font-mono text-xs text-slate-800">
                        <span className="break-all">{station?.station_id}</span>
                        {station?.station_id && (
                          <button
                            type="button"
                            onClick={() => copyToClipboard(station.station_id, 'stationId')}
                            className="rounded p-1 text-slate-400 hover:text-slate-600"
                            title="Copy Station ID"
                            aria-label="Copy Station ID"
                          >
                            {copiedField === 'stationId' ? (
                              <Check size={14} className="text-emerald-600" />
                            ) : (
                              <Copy size={14} />
                            )}
                          </button>
                        )}
                      </dd>
                    </div>

                    {/* Local Storage Root */}
                    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-1">
                      <dt className="font-bold text-slate-700">Local storage</dt>
                      <dd className="flex items-center gap-2 font-mono text-xs text-slate-800">
                        <span className="break-all">{health?.root}</span>
                        {health?.root && (
                          <button
                            type="button"
                            onClick={() => copyToClipboard(health.root, 'storageRoot')}
                            className="rounded p-1 text-slate-400 hover:text-slate-600"
                            title="Copy Storage Root"
                            aria-label="Copy Storage Root"
                          >
                            {copiedField === 'storageRoot' ? (
                              <Check size={14} className="text-emerald-600" />
                            ) : (
                              <Copy size={14} />
                            )}
                          </button>
                        )}
                      </dd>
                    </div>

                    {/* Visual Disk Capacity */}
                    <div className="rounded-xl border border-slate-100 bg-slate-50/80 p-3.5">
                      <div className="flex items-center justify-between text-xs text-slate-700">
                        <div className="flex items-center gap-1.5 font-bold">
                          <HardDrive size={15} aria-hidden="true" />
                          <span>Disk Capacity</span>
                        </div>
                        <dd>{gb(health?.freeBytes)} free of {gb(health?.totalBytes)}</dd>
                      </div>
                      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-200">
                        <div
                          className={`h-full transition-all duration-500 ${
                            health?.critical
                              ? 'bg-red-500'
                              : health?.low
                              ? 'bg-amber-500'
                              : 'bg-emerald-500'
                          }`}
                          style={{ width: `${percentUsed}%` }}
                        />
                      </div>
                    </div>

                    {/* Recording Specs */}
                    <div>
                      <dt className="font-bold text-slate-700">Recording</dt>
                      <dd className="mt-0.5 text-xs text-slate-600 leading-relaxed">
                        Up to 1280 × 720 at 18–20 FPS. Original camera video; no transcoding.
                      </dd>
                    </div>

                    {/* Runtime Version */}
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                      <dt className="font-bold text-slate-700">Version</dt>
                      <dd className="text-xs text-slate-600">
                        {info?.version} · {info?.platform} {info?.arch}
                      </dd>
                    </div>
                  </dl>

                  <div className="rounded-xl border border-slate-100 bg-slate-50/50 p-4">
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Videos remain on this computer after verification. Automatic deletion is disabled.
                    </p>
                  </div>
                </form>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  )
}
