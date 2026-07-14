import { useEffect, useRef } from 'react'
import { useAuth } from '../context/AuthContext'
import {
  initVideoUploadService,
  stopVideoUploadService,
  subscribeVideoUploadStatus,
} from '../services/videoUploadService'
import {
  initPackingSyncService,
  stopPackingSyncService,
  subscribePackingSyncStatus,
} from '../services/packingSyncService'

/** Starts global background services when the user is authenticated. */
export default function AppServices() {
  const { isAuthenticated } = useAuth()
  const pendingRef = useRef(0)
  const countsRef = useRef({ video: 0, packing: 0 })

  const syncPendingTotal = () => {
    pendingRef.current = countsRef.current.video + countsRef.current.packing
  }

  useEffect(() => {
    if (!isAuthenticated) return undefined
    initVideoUploadService()
    initPackingSyncService()

    const unsubVideo = subscribeVideoUploadStatus(({ pending, failed }) => {
      countsRef.current.video = pending + failed
      syncPendingTotal()
    })
    const unsubPacking = subscribePackingSyncStatus(({ pendingScans, pendingJobs, failedScans, failedJobs }) => {
      countsRef.current.packing = pendingScans + pendingJobs + failedScans + failedJobs
      syncPendingTotal()
    })

    return () => {
      unsubVideo()
      unsubPacking()
      stopVideoUploadService()
      stopPackingSyncService()
    }
  }, [isAuthenticated])

  useEffect(() => {
    if (!isAuthenticated) return undefined

    const onBeforeUnload = (e) => {
      if (pendingRef.current > 0) {
        e.preventDefault()
        e.returnValue = ''
      }
    }

    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [isAuthenticated])

  return null
}
