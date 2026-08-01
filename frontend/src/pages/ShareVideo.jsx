import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router'
import { Cloud, Copy, AlertTriangle, Download, ExternalLink, Loader2 } from 'lucide-react'

/**
 * Public dispute share page — no login required.
 * Shows Cloudflare R2 file details + Preview / Download actions.
 */
export default function ShareVideo() {
  const { token } = useParams()
  const [copiedKey, setCopiedKey] = useState('')
  const [error, setError] = useState('')
  const [meta, setMeta] = useState(null)
  const [loading, setLoading] = useState(true)
  const [downloading, setDownloading] = useState(false)

  const pageUrl = useMemo(() => {
    if (typeof window === 'undefined' || !token) return ''
    return `${window.location.origin}/share/video/${encodeURIComponent(token)}`
  }, [token])

  const streamUrl = useMemo(() => {
    if (!token) return ''
    return meta?.streamPath || `/api/uploads/s/${encodeURIComponent(token)}`
  }, [token, meta?.streamPath])

  const previewUrl = useMemo(() => {
    return meta?.previewUrl || meta?.r2SignedUrl || meta?.publicUrl || streamUrl || ''
  }, [meta, streamUrl])

  const downloadUrl = useMemo(() => {
    return meta?.downloadUrl
      || meta?.downloadPath
      || (streamUrl ? `${streamUrl}${streamUrl.includes('?') ? '&' : '?'}download=1` : '')
  }, [meta, streamUrl])

  const r2Link = useMemo(() => {
    return meta?.r2Url || meta?.r2SignedUrl || meta?.publicUrl || ''
  }, [meta])

  useEffect(() => {
    if (!token) return undefined
    let cancelled = false
    setLoading(true)
    fetch(`/api/uploads/s/${encodeURIComponent(token)}/meta`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Video not found')
        return res.json()
      })
      .then((data) => {
        if (!cancelled) {
          setMeta(data)
          setError('')
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'This share link is invalid or the video was deleted.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [token])

  const copyValue = async (value, key) => {
    if (!value) return
    try {
      await navigator.clipboard?.writeText(value)
      setCopiedKey(key)
      setTimeout(() => setCopiedKey(''), 2000)
    } catch {
      setCopiedKey('')
    }
  }

  const formatSize = (bytes) => {
    const n = Number(bytes) || 0
    if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`
    if (n >= 1024) return `${Math.round(n / 1024)} KB`
    return n ? `${n} B` : '—'
  }

  const handleDownload = async () => {
    if (!downloadUrl) return
    setDownloading(true)
    try {
      const response = await fetch(downloadUrl)
      if (!response.ok) throw new Error(`Download failed (${response.status})`)
      const blob = await response.blob()
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = meta?.originalName || 'packing-video.mp4'
      a.click()
      URL.revokeObjectURL(objectUrl)
    } catch {
      window.open(downloadUrl, '_blank', 'noopener,noreferrer')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(14,165,233,0.18),_transparent_55%),radial-gradient(ellipse_at_bottom,_rgba(15,23,42,1),_#020617)]" />
      <div className="relative mx-auto max-w-3xl px-4 py-8 sm:py-12">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-300/80">Youthnic Packing Station</p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">Dispute video evidence</h1>
            <p className="mt-1 text-sm text-slate-300">
              Stored on Cloudflare R2 · shareable without login
            </p>
          </div>
          <div className="inline-flex items-center gap-2 rounded-full border border-sky-400/30 bg-sky-500/10 px-3 py-1.5 text-xs font-semibold text-sky-200">
            <Cloud className="h-3.5 w-3.5" />
            Cloudflare R2
          </div>
        </div>

        {error ? (
          <div className="rounded-2xl border border-red-400/30 bg-red-500/10 p-6 text-red-100">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
              <div>
                <p className="font-semibold">Unable to open this video</p>
                <p className="mt-1 text-sm opacity-90">{error}</p>
              </div>
            </div>
          </div>
        ) : loading ? (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-8 flex items-center justify-center gap-2 text-slate-300">
            <Loader2 className="h-5 w-5 animate-spin" />
            Loading dispute details…
          </div>
        ) : (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-5 backdrop-blur space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <p className="text-[11px] uppercase tracking-wider text-slate-400">Box</p>
                <p className="mt-0.5 text-sm font-semibold">{meta?.boxNo ? `#${meta.boxNo}` : '—'}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wider text-slate-400">Consignment</p>
                <p className="mt-0.5 truncate text-sm font-semibold" title={meta?.consignmentId || ''}>
                  {meta?.consignmentId || '—'}
                </p>
              </div>
              <div className="sm:col-span-2">
                <p className="text-[11px] uppercase tracking-wider text-slate-400">File</p>
                <p className="mt-0.5 truncate text-sm font-semibold" title={meta?.originalName || ''}>
                  {meta?.originalName || 'Packing video'}
                </p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wider text-slate-400">Size</p>
                <p className="mt-0.5 text-sm font-semibold">{formatSize(meta?.size)}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wider text-slate-400">Type</p>
                <p className="mt-0.5 text-sm font-semibold">{(meta?.mimeType || 'video/mp4').split(';')[0]}</p>
              </div>
              <div className="sm:col-span-2">
                <p className="text-[11px] uppercase tracking-wider text-slate-400">Uploaded</p>
                <p className="mt-0.5 text-sm font-semibold">
                  {meta?.uploadedAt ? new Date(meta.uploadedAt).toLocaleString() : '—'}
                </p>
              </div>
            </div>

            {meta?.storagePath ? (
              <div>
                <p className="text-[11px] uppercase tracking-wider text-slate-400">R2 object path</p>
                <p className="mt-1 break-all rounded-lg border border-white/10 bg-slate-900/80 px-3 py-2 font-mono text-[11px] text-slate-300">
                  {meta.storagePath}
                </p>
              </div>
            ) : null}

            <div>
              <p className="text-[11px] uppercase tracking-wider text-slate-400">Cloudflare R2 link</p>
              <div className="mt-1 flex flex-col gap-2 sm:flex-row">
                <input
                  readOnly
                  value={r2Link}
                  placeholder={r2Link ? undefined : 'Signed R2 link unavailable — use Preview / Download'}
                  className="w-full rounded-lg border border-white/10 bg-slate-900/80 px-3 py-2 font-mono text-xs text-slate-200"
                />
                <button
                  type="button"
                  onClick={() => copyValue(r2Link, 'r2')}
                  disabled={!r2Link}
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-xs font-semibold text-white hover:bg-white/10 disabled:opacity-50"
                >
                  <Copy className="h-3.5 w-3.5" />
                  {copiedKey === 'r2' ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <a
                href={previewUrl || '#'}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-sky-500 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-400"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Preview open
              </a>
              <button
                type="button"
                onClick={handleDownload}
                disabled={!downloadUrl || downloading}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-400 disabled:opacity-50"
              >
                {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                {downloading ? 'Downloading…' : 'Download original'}
              </button>
            </div>

            <div>
              <p className="text-[11px] uppercase tracking-wider text-slate-400">Share link for dispute</p>
              <div className="mt-1 flex flex-col gap-2 sm:flex-row">
                <input
                  readOnly
                  value={pageUrl}
                  className="w-full rounded-lg border border-white/10 bg-slate-900/80 px-3 py-2 text-xs text-slate-200"
                />
                <button
                  type="button"
                  onClick={() => copyValue(pageUrl, 'page')}
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-xs font-semibold text-white hover:bg-white/10"
                >
                  <Copy className="h-3.5 w-3.5" />
                  {copiedKey === 'page' ? 'Copied' : 'Copy link'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
