import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router'
import { Cloud, Copy, AlertTriangle, PlayCircle } from 'lucide-react'

/**
 * Public dispute share page — no login required.
 * Streams packing evidence from Cloudflare R2 via durable HMAC token.
 */
export default function ShareVideo() {
  const { token } = useParams()
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const [meta, setMeta] = useState(null)

  const streamUrl = useMemo(() => {
    if (!token) return ''
    return `/api/uploads/s/${encodeURIComponent(token)}`
  }, [token])

  const pageUrl = useMemo(() => {
    if (typeof window === 'undefined' || !token) return ''
    return `${window.location.origin}/share/video/${encodeURIComponent(token)}`
  }, [token])

  useEffect(() => {
    if (!token) return undefined
    let cancelled = false
    fetch(`/api/uploads/s/${encodeURIComponent(token)}/meta`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Video not found')
        return res.json()
      })
      .then((data) => {
        if (!cancelled) setMeta(data)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'This share link is invalid or the video was deleted.')
      })
    return () => { cancelled = true }
  }, [token])

  const copyLink = async () => {
    try {
      await navigator.clipboard?.writeText(pageUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(14,165,233,0.18),_transparent_55%),radial-gradient(ellipse_at_bottom,_rgba(15,23,42,1),_#020617)]" />
      <div className="relative mx-auto max-w-4xl px-4 py-8 sm:py-12">
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
        ) : (
          <>
            <div className="overflow-hidden rounded-2xl border border-white/10 bg-black shadow-2xl shadow-sky-950/40">
              {streamUrl ? (
                <video
                  key={streamUrl}
                  className="aspect-video w-full bg-black"
                  controls
                  playsInline
                  preload="metadata"
                  src={streamUrl}
                >
                  Your browser does not support video playback.
                </video>
              ) : (
                <div className="flex aspect-video items-center justify-center text-slate-400">
                  <PlayCircle className="h-10 w-10 animate-pulse" />
                </div>
              )}
            </div>

            <div className="mt-5 grid gap-3 rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur sm:grid-cols-2">
              <div>
                <p className="text-[11px] uppercase tracking-wider text-slate-400">Box</p>
                <p className="mt-0.5 text-sm font-semibold">{meta?.boxNo ? `#${meta.boxNo}` : '—'}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wider text-slate-400">File</p>
                <p className="mt-0.5 truncate text-sm font-semibold">{meta?.originalName || 'Packing video'}</p>
              </div>
              <div className="sm:col-span-2">
                <p className="text-[11px] uppercase tracking-wider text-slate-400">Share link for dispute</p>
                <div className="mt-1 flex flex-col gap-2 sm:flex-row">
                  <input
                    readOnly
                    value={pageUrl}
                    className="w-full rounded-lg border border-white/10 bg-slate-900/80 px-3 py-2 text-xs text-slate-200"
                  />
                  <button
                    type="button"
                    onClick={copyLink}
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-sky-500 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-400"
                  >
                    <Copy className="h-3.5 w-3.5" />
                    {copied ? 'Copied' : 'Copy link'}
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
