import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Boxes, RefreshCw, Settings, LogOut, HardDrive } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import api from '../services/api'

const desktop = window.youthnicDesktop
const gb = (bytes) => bytes == null ? 'Unavailable' : `${(bytes / 1024 ** 3).toFixed(1)} GB`

export default function DesktopHome() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [tab, setTab] = useState('consignments')
  const [cached, setCached] = useState([])
  const [available, setAvailable] = useState([])
  const [status, setStatus] = useState({ boxes: [] })
  const [station, setStation] = useState(null)
  const [health, setHealth] = useState(null)
  const [info, setInfo] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [online, setOnline] = useState(navigator.onLine)
  const [recoveries, setRecoveries] = useState([])
  const canPack = ['admin', 'organization_head'].includes(user?.role) || user?.permissions?.packing === true

  const refresh = useCallback(async () => {
    if (!canPack) return
    setBusy(true)
    setError('')
    try {
      const [rows, counts, settings, disk, version, recovery] = await Promise.all([
        desktop.packing.listCachedConsignments(), desktop.sync.status(), desktop.station.get(), desktop.storage.health(), desktop.app.info(), desktop.video.recover(),
      ])
      setCached(rows); setStatus(counts); setStation(settings); setHealth(disk); setInfo(version); setRecoveries(recovery)
      try {
        const { data } = await api.get('/consignments', { params: { status: 'pending,in_progress', limit: 200 }, timeout: 8000 })
        setAvailable(data.consignments || []); setOnline(true)
      } catch { setOnline(false) }
    } catch (failure) { setError(failure.message || 'Station data could not be loaded') }
    finally { setBusy(false) }
  }, [canPack])

  useEffect(() => {
    void refresh()
    const unsubscribe = desktop.sync.onStatus((update) => {
      setStatus((current) => ({ ...current, ...update }))
      if (typeof update.online === 'boolean') setOnline(update.online)
    })
    const offline = () => setOnline(false)
    window.addEventListener('online', refresh)
    window.addEventListener('offline', offline)
    return () => { unsubscribe(); window.removeEventListener('online', refresh); window.removeEventListener('offline', offline) }
  }, [refresh])

  const saveSettings = async (event) => {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const form = new FormData(event.currentTarget)
      setStation(await desktop.station.update({ stationName: form.get('name'), warehouse: form.get('warehouse') }))
    } catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }

  return <div className="min-h-screen bg-slate-50 text-slate-900">
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 bg-white px-8 py-5">
      <div><p className="text-xs font-bold tracking-widest text-primary-600">YOUTHNIC OPERATIONS</p><h1 className="text-xl font-bold">Packing Station</h1><p className="text-sm text-slate-500">{station?.station_name || 'Warehouse station'} · {user?.name}</p></div>
      <div className="flex items-center gap-4"><span role="status" className={online ? 'text-emerald-700' : 'text-amber-700'}>{online ? 'Online' : 'Offline · local packing available'}</span><button onClick={logout} className="flex items-center gap-2 rounded-lg border px-4 py-2"><LogOut size={16} aria-hidden="true" />Sign out</button></div>
    </header>
    <main className="mx-auto max-w-6xl space-y-6 p-8">
      {!canPack ? <p role="alert">Your account needs packing permission. Contact your administrator.</p> : <>
      <nav aria-label="Station navigation" className="flex flex-wrap gap-3">{[['consignments', Boxes, 'Consignments'], ['sync', RefreshCw, 'Sync center'], ['settings', Settings, 'Station settings']].map(([key, Icon, label]) => <button key={key} onClick={() => setTab(key)} aria-pressed={tab === key} className={`flex items-center gap-2 rounded-lg px-5 py-3 font-semibold ${tab === key ? 'bg-primary-600 text-white' : 'border border-slate-200 bg-white'}`}><Icon size={18} aria-hidden="true" />{label}</button>)}<button disabled={busy} onClick={refresh} className="ml-auto rounded-lg border px-4 py-2">{busy ? 'Loading…' : 'Refresh'}</button></nav>
      {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800">{error}</p>}
      {(health?.low || health?.unavailable) && <p role="alert" className="rounded-lg bg-amber-50 p-4 text-amber-900">{health?.critical || health?.unavailable ? 'Recording is blocked until sufficient disk space can be confirmed.' : 'Disk space is low. Free space before recording more boxes.'} Unsynced evidence is preserved.</p>}
      {tab === 'consignments' && <>
        <div className="flex items-center justify-between"><div><h2 className="text-lg font-bold">Ready offline</h2><p className="text-sm text-slate-600">Downloaded work is kept on this computer. Open Packing to resume a box or select another consignment.</p></div><Link to="/packing" className="rounded-lg bg-primary-600 px-5 py-3 font-bold text-white">Open packing</Link></div>
        <div className="grid gap-3 sm:grid-cols-2">{cached.map((row) => <button key={row.consignmentId} onClick={() => navigate('/packing', { state: { consignmentId: row.consignmentId } })} className="rounded-xl border border-slate-200 bg-white p-5 text-left"><strong>{row.internalShipmentNo || row.consignmentId}</strong><p className="mt-2 text-sm text-emerald-700">Ready offline · resume local work</p></button>)}</div>
        {!cached.length && <p className="rounded-lg border border-dashed p-6 text-slate-600">No downloaded consignments yet. Open Packing while online to download and claim your first consignment.</p>}
        <h2 className="text-lg font-bold">Available online</h2><div className="grid gap-3 sm:grid-cols-2">{available.filter((row) => !cached.some((local) => local.consignmentId === row.id)).map((row) => <button key={row.id} onClick={() => navigate('/packing', { state: { consignmentId: row.id } })} className="rounded-xl border bg-white p-5 text-left"><strong>{row.internalShipmentNo || row.id}</strong><p className="mt-2 text-sm text-slate-600">Download in Packing · {row.status}</p></button>)}</div>
      </>}
      {tab === 'sync' && <>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">{[['Safe locally', status.localSafe], ['Cloud synced', status.cloudSynced], ['Pending data', status.pendingData], ['Pending videos', status.pendingVideos]].map(([label, count]) => <div key={label} className="rounded-xl border bg-white p-5"><p className="text-sm text-slate-600">{label}</p><p className="text-3xl font-bold">{count || 0}</p></div>)}</div>
        <p className="text-sm text-slate-600">Boxes upload in order: box data, then its video, then the next box. Packing can continue during upload. Pending work resumes when the app is opened again.</p>
        <button disabled={busy} onClick={async () => { setBusy(true); try { await desktop.sync.retry(); await refresh() } catch (failure) { setError(failure.message) } finally { setBusy(false) } }} className="rounded-lg bg-primary-600 px-5 py-3 font-semibold text-white">Retry pending uploads</button>
        {status.lastError && <p role="alert" className="text-red-700">{status.lastError}</p>}
        <div className="overflow-x-auto rounded-xl border bg-white"><table className="w-full text-left text-sm"><thead className="bg-slate-100"><tr>{['Consignment', 'Box', 'Box data', 'Video'].map((label) => <th key={label} className="p-4">{label}</th>)}</tr></thead><tbody>{status.boxes?.map((box) => <tr key={box.box_id} className="border-t"><td className="p-4">{box.consignment_id}</td><td className="p-4">{box.box_no}</td><td className="p-4">{box.state.replaceAll('_', ' ')}</td><td className="p-4">{box.video_state?.replaceAll('_', ' ')}</td></tr>)}</tbody></table></div>
        {recoveries.length > 0 && <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-4"><h3 className="font-bold">Interrupted recordings need review</h3><p>Partial recordings are preserved. Resume the open box with a new recording; do not delete its recovery files.</p><ul className="mt-2 list-inside list-disc">{recoveries.map((item) => <li key={item.path}>{item.videoId} · {(item.sizeBytes / 1024 ** 2).toFixed(1)} MB</li>)}</ul></div>}
      </>}
      {tab === 'settings' && <form onSubmit={saveSettings} className="max-w-2xl space-y-5 rounded-xl border bg-white p-6">
        <h2 className="text-lg font-bold">Station settings</h2><label className="block">Station name<input key={station?.station_name} name="name" required maxLength={100} defaultValue={station?.station_name} className="mt-2 block w-full rounded-lg border p-3" /></label><label className="block">Warehouse<input key={station?.warehouse} name="warehouse" maxLength={100} defaultValue={station?.warehouse || ''} className="mt-2 block w-full rounded-lg border p-3" /></label><button disabled={busy} className="rounded-lg bg-primary-600 px-5 py-3 font-semibold text-white">Save settings</button>
        <dl className="space-y-3 border-t pt-5 text-sm"><div><dt className="font-bold">Station ID</dt><dd className="break-all">{station?.station_id}</dd></div><div><dt className="font-bold">Local storage</dt><dd className="break-all">{health?.root}</dd></div><div className="flex items-center gap-2"><HardDrive size={18} aria-hidden="true" /><dd>{gb(health?.freeBytes)} free of {gb(health?.totalBytes)}</dd></div><div><dt className="font-bold">Recording</dt><dd>Up to 1280 × 720 at 18–20 FPS. Original camera video; no transcoding.</dd></div><div><dt className="font-bold">Version</dt><dd>{info?.version} · {info?.platform} {info?.arch}</dd></div></dl>
        <p className="text-sm text-slate-600">Videos remain on this computer after verification. Automatic deletion is disabled.</p>
      </form>}
      </>}
    </main>
  </div>
}
