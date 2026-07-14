import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react'
import api from '../services/api'
import { useAuth } from './AuthContext'

const ConsignmentSyncContext = createContext({
  pendingChanges: [],
  lastSyncAt: null,
  connected: false,
})

const POLL_MS = 8000
const REALTIME_FLUSH_MS = 300

function getAppToken() {
  return sessionStorage.getItem('token') || localStorage.getItem('token')
}

function getLiveToken() {
  return sessionStorage.getItem('liveSyncToken') || localStorage.getItem('supabaseRealtimeToken')
}

function applyChanges(setter, incoming) {
  if (!incoming?.length) return
  setter((prev) => {
    const map = new Map(prev.map((c) => [c.id, c]))
    for (const ch of incoming) {
      if (!ch.id) continue
      if (ch.deleted) map.delete(ch.id)
      else map.set(ch.id, { ...map.get(ch.id), ...ch })
    }
    return Array.from(map.values())
  })
}

/** Normalize Supabase Realtime Broadcast payloads from the app backend. */
function consignmentPatchFromBroadcast(message) {
  const payload = message?.payload || message
  if (!payload?.id) return null
  return {
    id: payload.id,
    status: payload.status,
    shipmentStatus: payload.shipmentStatus,
    totalPackedQty: payload.totalPackedQty,
    totalRequiredQty: payload.totalRequiredQty,
    deleted: payload.deleted === true,
    realtimeType: payload.realtimeType || null,
    updatedAt: payload.updatedAt || new Date().toISOString(),
    realtimeSource: payload.realtimeSource || 'supabase_broadcast',
  }
}

export function ConsignmentSyncProvider({ children }) {
  const { isAuthenticated } = useAuth()
  const [pendingChanges, setPendingChanges] = useState([])
  const [lastSyncAt, setLastSyncAt] = useState(null)
  const [connected, setConnected] = useState(false)
  const sinceRef = useRef(new Date().toISOString())
  const pollRef = useRef(null)
  const bufferedChangesRef = useRef([])
  const flushTimerRef = useRef(null)

  const pollOnce = useCallback(async () => {
    try {
      const { data } = await api.get('/sync/changes', { params: { since: sinceRef.current } })
      if (data.serverTime) sinceRef.current = data.serverTime
      setLastSyncAt(data.serverTime)
      applyChanges(setPendingChanges, data.changes)
    } catch {
      // retry on next tick
    }
  }, [])

  useEffect(() => {
    if (!isAuthenticated) return undefined

    let active = true
    const token = getAppToken()
    let es = null
    let channel = null
    let supabaseClient = null

    const startPolling = () => {
      if (pollRef.current) return
      pollOnce()
      pollRef.current = setInterval(() => {
        if (!document.hidden) pollOnce()
      }, POLL_MS)
    }

    const stopPolling = () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }

    const flushRealtimeChanges = () => {
      if (!active) return
      const changes = bufferedChangesRef.current
      bufferedChangesRef.current = []
      flushTimerRef.current = null
      if (!changes.length) return
      const latest = changes.reduce((memo, item) => item?.updatedAt || memo, changes[0]?.updatedAt || new Date().toISOString())
      setLastSyncAt(latest)
      applyChanges(setPendingChanges, changes)
    }

    const queueRealtimeChange = (patch) => {
      if (!active || !patch) return
      setConnected(true)
      bufferedChangesRef.current.push(patch)
      if (!flushTimerRef.current) {
        flushTimerRef.current = setTimeout(flushRealtimeChanges, REALTIME_FLUSH_MS)
      }
    }

    const startSseFallback = () => {
      if (!token || typeof EventSource === 'undefined') {
        startPolling()
        return
      }

      // Close any previous stream before opening a new one
      try { es?.close() } catch { /* ignore */ }
      es = null

      try {
        es = new EventSource(`/api/sync/events?token=${encodeURIComponent(token)}`)
        let settled = false

        es.onopen = () => {
          if (!active) return
          settled = true
          setConnected(true)
          stopPolling()
        }

        es.onmessage = (event) => {
          if (!active) return
          try {
            const data = JSON.parse(event.data)
            if (data.type === 'connected') {
              settled = true
              setConnected(true)
              setLastSyncAt(data.serverTime)
              stopPolling()
              return
            }
            if (data.type === 'consignment_updated' && data.id) {
              setConnected(true)
              setLastSyncAt(data.updatedAt || new Date().toISOString())
              queueRealtimeChange(data)
            }
          } catch {
            // ignore malformed events
          }
        }

        es.onerror = () => {
          // EventSource auto-retries; close it and fall back to polling once
          // so Vite proxy / backend restarts don't spam reconnect loops.
          setConnected(false)
          try { es?.close() } catch { /* ignore */ }
          es = null
          if (!settled || active) startPolling()
        }
      } catch {
        startPolling()
      }
    }

    const startRealtime = async () => {
      try {
        const realtime = await import('../config/supabase')
        if (!active) return
        const { supabase, supabaseConfigured, applySupabaseRealtimeToken } = realtime
        supabaseClient = supabase

        if (!supabaseConfigured || !supabase) {
          startSseFallback()
          return
        }

        const realtimeToken = getLiveToken()
        if (realtimeToken) applySupabaseRealtimeToken(realtimeToken)

        // Broadcast-only: keeps free-tier Supabase DB/Storage empty.
        // Operational data lives on local/Cloud SQL; files on Cloudflare R2.
        channel = supabase
          .channel('consignment-lifecycle', {
            config: {
              broadcast: { self: false },
            },
          })
          .on('broadcast', { event: 'consignment_updated' }, (message) => {
            queueRealtimeChange(consignmentPatchFromBroadcast(message))
          })
          .subscribe((status) => {
            if (!active) return
            if (status === 'SUBSCRIBED') {
              setConnected(true)
              stopPolling()
              pollOnce()
              return
            }
            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
              setConnected(false)
              startSseFallback()
            }
          })
      } catch {
        startSseFallback()
      }
    }

    startRealtime()

    const onVisible = () => { if (!document.hidden) pollOnce() }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      active = false
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
      bufferedChangesRef.current = []
      stopPolling()
      es?.close()
      if (channel && supabaseClient) supabaseClient.removeChannel(channel)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [isAuthenticated, pollOnce])

  const clearChanges = useCallback((ids) => {
    if (!ids?.length) return
    const idSet = new Set(Array.isArray(ids) ? ids : [ids])
    setPendingChanges((prev) => prev.filter((c) => !idSet.has(c.id)))
  }, [])

  return (
    <ConsignmentSyncContext.Provider value={{ pendingChanges, lastSyncAt, clearChanges, connected }}>
      {children}
    </ConsignmentSyncContext.Provider>
  )
}

export function useConsignmentSync() {
  return useContext(ConsignmentSyncContext)
}

export function mergeConsignmentChanges(items, changes) {
  if (!changes?.length || !items?.length) return items
  const changeMap = new Map(changes.map((c) => [c.id, c]))
  let changed = false
  const next = items.map((item) => {
    const patch = changeMap.get(item.id)
    if (!patch) return item
    changed = true
    return { ...item, ...patch }
  }).filter((item) => !item.deleted)
  return changed ? next : items
}

export function patchConsignment(consignment, changes, id) {
  if (!consignment || !changes?.length) return consignment
  const patch = changes.find((c) => c.id === id)
  if (!patch) return consignment
  if (patch.deleted) return null
  return { ...consignment, ...patch }
}
