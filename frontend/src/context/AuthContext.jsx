import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import {
  browserLocalPersistence,
  GoogleAuthProvider,
  OAuthProvider,
  onAuthStateChanged,
  sendEmailVerification,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as fbSignOut,
} from 'firebase/auth'
import { auth as fbAuth, firebaseConfigured } from '../config/firebase'
import { authAPI } from '../services/api'
import api from '../services/api'
import { posthog, isPosthogConfigured } from '../utils/posthog'

import {
  clearSessionValidationCache,
  markSessionValidated,
} from '../utils/sessionValidationCache'

const AuthContext = createContext(null)

const APP_TOKEN_KEY = 'token'
const USER_KEY = 'user'
const LIVE_TOKEN_KEY = 'liveSyncToken'
const LEGACY_LIVE_TOKEN_KEY = 'supabaseRealtimeToken'
const LAST_ACTIVE_KEY = 'lastActiveAt'
const LAST_LIVE_SYNC_AT_KEY = 'liveSyncTokenFetchedAt'
const SESSION_TIMEOUT_MINUTES = Number(import.meta.env.VITE_SESSION_TIMEOUT_MINUTES || 120)
const SESSION_TIMEOUT_MS = Math.max(15, SESSION_TIMEOUT_MINUTES) * 60 * 1000
const ACTIVITY_WRITE_MS = 30_000
const AUTH_INIT_TIMEOUT_MS = 12_000
// Live tokens expire in 1h; refresh in background well before expiry.
const LIVE_TOKEN_REFRESH_MS = 45 * 60 * 1000

function getStoredToken() {
  return sessionStorage.getItem(APP_TOKEN_KEY) || localStorage.getItem(APP_TOKEN_KEY)
}

function getStoredLiveToken() {
  return sessionStorage.getItem(LIVE_TOKEN_KEY) || localStorage.getItem(LEGACY_LIVE_TOKEN_KEY)
}

function clearStoredSession() {
  sessionStorage.removeItem(APP_TOKEN_KEY)
  sessionStorage.removeItem(USER_KEY)
  sessionStorage.removeItem(LIVE_TOKEN_KEY)
  sessionStorage.removeItem(LAST_LIVE_SYNC_AT_KEY)
  localStorage.removeItem(APP_TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
  localStorage.removeItem(LEGACY_LIVE_TOKEN_KEY)
  clearSessionValidationCache()
}

function liveSyncTokenIsFresh() {
  const token = getStoredLiveToken()
  if (!token) return false
  const fetchedAt = Number(sessionStorage.getItem(LAST_LIVE_SYNC_AT_KEY) || 0)
  if (!fetchedAt) return false
  return Date.now() - fetchedAt < LIVE_TOKEN_REFRESH_MS
}

function backendUnavailableMessage(status) {
  if (status === 502) {
    return 'Service is temporarily unavailable. Please try again in a moment.'
  }
  if (status === 503) {
    return 'Secure services are temporarily unavailable. Please contact your administrator if this continues.'
  }
  return 'Cannot reach the application service. Check your connection and try again.'
}

function isBackendUnreachable(err) {
  if (err?.code?.startsWith('auth/')) return false
  const message = String(err?.message || '')
  if (/secure sign-in is not configured|firebase.*not configured/i.test(message)) return false
  const status = err?.response?.status
  return !err?.response || status === 502 || status === 503 || status === 504 || err?.code === 'ERR_NETWORK'
}

function publicAuthMessage(message) {
  if (!message) return message
  if (/(firebase|supabase|postgres|postgresql|firestore|jwt|service account|backend|api|database schema|wal)/i.test(message)) {
    return 'Secure services are temporarily unavailable. Please contact your administrator if this continues.'
  }
  return message
}

async function applyLiveSyncToken(token) {
  const { applySupabaseRealtimeToken } = await import('../config/supabase')
  applySupabaseRealtimeToken(token)
}

function wrapBackendError(err) {
  const status = err?.response?.status
  const message = isBackendUnreachable(err)
    ? backendUnavailableMessage(status)
    : publicAuthMessage(err?.response?.data?.error || err.message)
  const e = new Error(message)
  e.response = { data: { error: message } }
  return e
}

function normalizeLoginError(err) {
  const code = err?.code || ''
  const apiMsg = err?.response?.data?.error

  if (apiMsg) {
    const message = publicAuthMessage(apiMsg)
    const e = new Error(message)
    e.response = { data: { error: message } }
    return e
  }
  if (isBackendUnreachable(err)) return wrapBackendError(err)
  if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
    const e = new Error('Invalid email or password.')
    e.response = { data: { error: 'Invalid email or password.' } }
    return e
  }
  if (code === 'auth/too-many-requests') {
    const e = new Error('Too many failed attempts. Please try again later or reset your password.')
    e.response = { data: { error: e.message } }
    return e
  }
  if (code === 'auth/network-request-failed' || err?.code === 'ERR_NETWORK') {
    const e = new Error('Network error. Check your connection and try again.')
    e.response = { data: { error: e.message } }
    return e
  }
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
    const e = new Error('Sign-in was cancelled.')
    e.response = { data: { error: 'Sign-in was cancelled.' } }
    return e
  }
  if (code === 'auth/account-exists-with-different-credential') {
    const e = new Error('An account already exists with this email using a different sign-in method.')
    e.response = { data: { error: e.message } }
    return e
  }
  return err
}

function getCurrentProviderUser() {
  if (!fbAuth) return Promise.resolve(null)
  if (fbAuth.currentUser) return Promise.resolve(fbAuth.currentUser)

  return new Promise((resolve) => {
    let unsubscribe = () => {}
    unsubscribe = onAuthStateChanged(
      fbAuth,
      (providerUser) => {
        unsubscribe()
        resolve(providerUser)
      },
      () => {
        unsubscribe()
        resolve(null)
      }
    )
  })
}

function withTimeout(promise, ms, label) {
  let timeoutId
  const timeout = new Promise((resolve) => {
    timeoutId = window.setTimeout(() => {
      console.warn(`[Auth] ${label} timed out after ${ms}ms`)
      resolve(null)
    }, ms)
  })
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timeoutId))
}

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const authMutationSeqRef = useRef(0)

  const persistSession = useCallback((token, sessionUser, mutationSeq = null) => {
    if (mutationSeq !== null && mutationSeq !== authMutationSeqRef.current) {
      return sessionUser
    }
    sessionStorage.setItem(APP_TOKEN_KEY, token)
    sessionStorage.setItem(USER_KEY, JSON.stringify(sessionUser))
    localStorage.removeItem(APP_TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
    setUser(sessionUser)
    markSessionValidated(true)

    if (isPosthogConfigured && sessionUser?.id) {
      posthog.identify(sessionUser.id, {
        email: sessionUser.email,
        name: sessionUser.name,
        role: sessionUser.role,
        warehouseId: sessionUser.warehouseId || null,
      })
    }

    return sessionUser
  }, [])

  const updateUser = useCallback((patch) => {
    setUser((current) => {
      const next = { ...(current || {}), ...(patch || {}) }
      if (next.id) sessionStorage.setItem(USER_KEY, JSON.stringify(next))
      return next.id ? next : current
    })
  }, [])

  const refreshLiveSyncToken = useCallback(async ({ force = false } = {}) => {
    try {
      if (!force && liveSyncTokenIsFresh()) {
        return getStoredLiveToken()
      }
      const { data } = await api.get('/auth/realtime-token')
      if (data?.token) {
        sessionStorage.setItem(LIVE_TOKEN_KEY, data.token)
        sessionStorage.setItem(LAST_LIVE_SYNC_AT_KEY, String(Date.now()))
        localStorage.removeItem(LEGACY_LIVE_TOKEN_KEY)
        await applyLiveSyncToken(data.token)
      }
      return data?.token || null
    } catch (error) {
      sessionStorage.removeItem(LIVE_TOKEN_KEY)
      sessionStorage.removeItem(LAST_LIVE_SYNC_AT_KEY)
      localStorage.removeItem(LEGACY_LIVE_TOKEN_KEY)
      console.warn('[Auth] Live sync token unavailable:', publicAuthMessage(error?.response?.data?.error || error.message))
      return null
    }
  }, [])

  const queueLiveSyncRefresh = useCallback((force = false) => {
    // Non-critical for first paint — do not block login / session restore.
    void refreshLiveSyncToken({ force }).catch(() => {})
  }, [refreshLiveSyncToken])

  const refreshSessionFromProvider = useCallback(async (forceRefresh = false, mutationSeq = null) => {
    if (!fbAuth) return null
    const providerUser = await getCurrentProviderUser()
    if (!providerUser) return null

    const idToken = await providerUser.getIdToken(forceRefresh)
    const res = await api.post('/auth/firebase-login', { idToken })
    const { token, user: sessionUser } = res.data
    if (mutationSeq !== null && mutationSeq !== authMutationSeqRef.current) return sessionUser
    const storedUser = persistSession(token, sessionUser, mutationSeq)
    queueLiveSyncRefresh(true)
    return storedUser
  }, [persistSession, queueLiveSyncRefresh])

  const validateSession = useCallback(async (mutationSeq = null) => {
    const token = getStoredToken()

    if (!token) {
      try {
        return await refreshSessionFromProvider(false, mutationSeq)
      } catch {
        clearStoredSession()
        setUser(null)
        return null
      }
    }

    try {
      const response = await authAPI.me()
      const sessionUser = response.data.user
      if (mutationSeq !== null && mutationSeq !== authMutationSeqRef.current) return sessionUser
      persistSession(token, sessionUser, mutationSeq)
      queueLiveSyncRefresh(false)
      return sessionUser
    } catch {
      try {
        return await refreshSessionFromProvider(true, mutationSeq)
      } catch {
        clearStoredSession()
        try { if (fbAuth) await fbSignOut(fbAuth) } catch (_) {}
        setUser(null)
        return null
      }
    }
  }, [persistSession, queueLiveSyncRefresh, refreshSessionFromProvider])

  useEffect(() => {
    let active = true
    const initAuth = async () => {
      const mutationSeq = authMutationSeqRef.current + 1
      authMutationSeqRef.current = mutationSeq
      try {
        const liveToken = getStoredLiveToken()
        if (liveToken) await withTimeout(applyLiveSyncToken(liveToken), 3000, 'Live sync token restore')

        if (fbAuth) {
          try { await setPersistence(fbAuth, browserLocalPersistence) } catch (_) {}
        }

        const sessionUser = await withTimeout(validateSession(mutationSeq), AUTH_INIT_TIMEOUT_MS, 'Session validation')
        if (!sessionUser && authMutationSeqRef.current === mutationSeq) {
          authMutationSeqRef.current += 1
        }
        sessionStorage.setItem(LAST_ACTIVE_KEY, String(Date.now()))
      } catch (error) {
        console.warn('[Auth] Startup session validation failed:', publicAuthMessage(error?.message))
        clearStoredSession()
        setUser(null)
      } finally {
        if (active) setLoading(false)
      }
    }
    initAuth()
    return () => { active = false }
  }, [validateSession])

  useEffect(() => {
    if (!user) return undefined

    let lastWrite = 0
    const markActive = () => {
      const now = Date.now()
      if (now - lastWrite < ACTIVITY_WRITE_MS) return
      lastWrite = now
      sessionStorage.setItem(LAST_ACTIVE_KEY, String(now))
    }

    const checkTimeout = () => {
      const lastActive = Number(sessionStorage.getItem(LAST_ACTIVE_KEY) || Date.now())
      if (Date.now() - lastActive > SESSION_TIMEOUT_MS) {
        logout()
      }
    }

    const events = ['pointerdown', 'keydown', 'scroll', 'touchstart']
    events.forEach((eventName) => window.addEventListener(eventName, markActive, { passive: true }))
    const timer = window.setInterval(checkTimeout, 60_000)

    return () => {
      events.forEach((eventName) => window.removeEventListener(eventName, markActive))
      window.clearInterval(timer)
    }
  }, [user])

  const exchangeFirebaseSession = useCallback(async (providerUser) => {
    const loginStarted = typeof performance !== 'undefined' ? performance.now() : Date.now()
    const idTokenStarted = typeof performance !== 'undefined' ? performance.now() : Date.now()
    // Prefer cached ID token when still valid; force-refresh only if Firebase requires it.
    const idToken = await providerUser.getIdToken(false)
    const idTokenMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - idTokenStarted

    const exchangeStarted = typeof performance !== 'undefined' ? performance.now() : Date.now()
    const res = await api.post('/auth/firebase-login', { idToken })
    const exchangeMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - exchangeStarted
    const { token, user: sessionUser, _timings: backendTimings } = res.data
    const storedUser = persistSession(token, sessionUser)
    sessionStorage.setItem(LAST_ACTIVE_KEY, String(Date.now()))

    if (isPosthogConfigured) {
      posthog.capture('user_logged_in', {
        userId: sessionUser.id,
        role: sessionUser.role,
      })
    }

    // Realtime authorization is non-critical for first paint.
    queueLiveSyncRefresh(true)

    const totalMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - loginStarted
    console.info('[Auth] Login exchange timings', {
      idTokenMs: Math.round(idTokenMs),
      firebaseLoginMs: Math.round(exchangeMs),
      totalUntilSessionReadyMs: Math.round(totalMs),
      backendTimings: backendTimings || null,
    })

    return storedUser
  }, [persistSession, queueLiveSyncRefresh])

  const login = async (email, password) => {
    try {
      if (!firebaseConfigured || !fbAuth) {
        throw new Error('Sign-in is not configured on this deployment. Ask your admin to set VITE_FIREBASE_* GitHub secrets and redeploy.')
      }
      await setPersistence(fbAuth, browserLocalPersistence)
      const cred = await signInWithEmailAndPassword(fbAuth, email, password)
      return await exchangeFirebaseSession(cred.user)
    } catch (err) {
      throw normalizeLoginError(err)
    }
  }

  const loginWithGoogle = async () => {
    try {
      if (!firebaseConfigured || !fbAuth) {
        throw new Error('Sign-in is not configured on this deployment. Ask your admin to set VITE_FIREBASE_* GitHub secrets and redeploy.')
      }
      await setPersistence(fbAuth, browserLocalPersistence)
      const provider = new GoogleAuthProvider()
      provider.setCustomParameters({ prompt: 'select_account' })
      const cred = await signInWithPopup(fbAuth, provider)
      return await exchangeFirebaseSession(cred.user)
    } catch (err) {
      throw normalizeLoginError(err)
    }
  }

  const loginWithMicrosoft = async () => {
    try {
      if (!firebaseConfigured || !fbAuth) {
        throw new Error('Sign-in is not configured on this deployment. Ask your admin to set VITE_FIREBASE_* GitHub secrets and redeploy.')
      }
      await setPersistence(fbAuth, browserLocalPersistence)
      const provider = new OAuthProvider('microsoft.com')
      provider.setCustomParameters({ prompt: 'select_account' })
      const cred = await signInWithPopup(fbAuth, provider)
      return await exchangeFirebaseSession(cred.user)
    } catch (err) {
      throw normalizeLoginError(err)
    }
  }

  const sendPasswordReset = async (email) => {
    try {
      const res = await api.post('/auth/forgot-password', {
        email,
        appOrigin: window.location.origin,
      })

      if (!res.data?.sent) {
        throw new Error(
          res.data?.error
            || res.data?.message
            || 'Password reset email could not be sent. Contact your administrator.'
        )
      }

      return {
        ...res.data,
        method: 'branded-email',
        message: res.data.message || 'Password reset email sent. Check your inbox and spam folder.',
      }
    } catch (backendErr) {
      const message = publicAuthMessage(backendErr?.response?.data?.error || backendErr?.message)
      const e = new Error(message)
      e.response = { data: { error: message } }
      throw e
    }
  }

  const sendVerificationEmail = async () => {
    if (!fbAuth?.currentUser) {
      throw new Error('Please sign in again before sending a verification email.')
    }
    await sendEmailVerification(fbAuth.currentUser)
    return true
  }

  const logout = async () => {
    if (isPosthogConfigured && user?.id) {
      posthog.capture('user_logged_out', {
        userId: user.id,
      })
      posthog.reset()
    }
    if (getStoredToken()) {
      try { await authAPI.logout() } catch (_) {}
    }
    try { if (fbAuth) await fbSignOut(fbAuth) } catch (_) {}
    clearStoredSession()
    setUser(null)
  }

  const value = {
    user,
    login,
    loginWithGoogle,
    loginWithMicrosoft,
    logout,
    sendPasswordReset,
    sendVerificationEmail,
    validateSession,
    refreshSessionFromProvider,
    updateUser,
    loading,
    isAuthenticated: !!user,
    sessionTimeoutMinutes: Math.round(SESSION_TIMEOUT_MS / 60000),
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export const useAuth = () => {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within AuthProvider')
  return context
}
