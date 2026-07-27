import { Suspense, lazy, useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router'
import { AuthProvider, useAuth } from './context/AuthContext'
import { ToastProvider } from './context/ToastContext'
import { ConsignmentSyncProvider } from './context/ConsignmentSyncContext'
import AppServices from './components/AppServices'
import ErrorBoundary from './components/ErrorBoundary'
import PageSpinner from './components/Skeleton'
import Layout from './components/Layout'
import {
  VALIDATION_TTL_MS,
  getSessionValidationCache,
} from './utils/sessionValidationCache'

const Login = lazy(() => import('./pages/Login'))
const ResetPassword = lazy(() => import('./pages/ResetPassword'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Consignments = lazy(() => import('./pages/Consignments'))
const ConsignmentDetail = lazy(() => import('./pages/ConsignmentDetail'))
const Productivity = lazy(() => import('./pages/Productivity'))
const InventoryPlanning = lazy(() => import('./pages/InventoryPlanning'))
const Marketplaces = lazy(() => import('./pages/Marketplaces'))
const DocketCompanies = lazy(() => import('./pages/DocketCompanies'))
const Users = lazy(() => import('./pages/Users'))
const AuditLogs = lazy(() => import('./pages/AuditLogs'))
const Settings = lazy(() => import('./pages/Settings'))
const Profile = lazy(() => import('./pages/Profile'))
const PackingStation = lazy(() => import('./pages/PackingStation'))
const TermsAndConditions = lazy(() => import('./pages/TermsAndConditions'))
const PrivacyPolicy = lazy(() => import('./pages/PrivacyPolicy'))
const ContactDetails = lazy(() => import('./pages/ContactDetails'))
const CopyrightPage = lazy(() => import('./pages/CopyrightPage'))
const ShareVideo = lazy(() => import('./pages/ShareVideo'))

const Spinner = () => <PageSpinner label="Loading application…" />

const isElevatedRole = (user) => user?.role === 'admin' || user?.role === 'organization_head'

const PrivateRoute = ({ children }) => {
  const { isAuthenticated, loading, validateSession } = useAuth()
  const location = useLocation()
  const [validating, setValidating] = useState(true)

  useEffect(() => {
    let active = true
    if (loading) return undefined

    setValidating(true)
    const cached = getSessionValidationCache(VALIDATION_TTL_MS)
    const validationPromise = cached.hit
      ? Promise.resolve(cached.result)
      : validateSession()
        .then((user) => Boolean(user))
        .catch(() => false)

    validationPromise.then(() => {
      if (active) setValidating(false)
    })

    return () => { active = false }
  }, [loading, location.pathname, validateSession])

  if (loading || validating) return <Spinner />
  return isAuthenticated ? children : <Navigate to="/login" replace />
}

const PublicRoute = ({ children }) => {
  const { isAuthenticated, loading } = useAuth()
  if (loading) return <Spinner />
  return !isAuthenticated ? children : <Navigate to="/" replace />
}

const AdminRoute = ({ children }) => {
  const { user, loading } = useAuth()
  if (loading) return <Spinner />
  if (!user) return <Navigate to="/login" replace />
  if (user.role !== 'admin' && user.role !== 'organization_head') return <Navigate to="/" replace />
  return children
}

const PermissionRoute = ({ permission, children }) => {
  const { user, loading } = useAuth()
  if (loading) return <Spinner />
  if (!user) return <Navigate to="/login" replace />
  if (isElevatedRole(user) || !permission || user.permissions?.[permission] === true) return children
  return <Navigate to="/" replace />
}

function AppRoutes() {
  return (
    <Suspense fallback={<Spinner />}>
      <Routes>
        <Route path="/login" element={<PublicRoute><Login /></PublicRoute>} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/terms" element={<TermsAndConditions />} />
        <Route path="/privacy" element={<PrivacyPolicy />} />
        <Route path="/contact" element={<ContactDetails />} />
        <Route path="/copyright" element={<CopyrightPage />} />
        <Route path="/share/video/:token" element={<ShareVideo />} />

        <Route path="/packing" element={<PrivateRoute><PermissionRoute permission="packing"><PackingStation /></PermissionRoute></PrivateRoute>} />

        <Route path="/" element={<PrivateRoute><Layout /></PrivateRoute>}>
          <Route index element={<Dashboard />} />
          <Route path="profile" element={<Profile />} />
          <Route path="consignments" element={<PermissionRoute permission="consignments"><Consignments /></PermissionRoute>} />
          <Route path="consignments/:id" element={<PermissionRoute permission="consignments"><ConsignmentDetail /></PermissionRoute>} />
          <Route path="productivity" element={<PermissionRoute permission="productivity"><Productivity /></PermissionRoute>} />
          <Route path="inventory-planning" element={<PermissionRoute permission="inventoryPlanning"><InventoryPlanning /></PermissionRoute>} />
          <Route path="marketplaces" element={<PermissionRoute permission="marketplaces"><Marketplaces /></PermissionRoute>} />
          <Route path="docket-companies" element={<AdminRoute><DocketCompanies /></AdminRoute>} />
          <Route path="users" element={<AdminRoute><Users /></AdminRoute>} />
          <Route path="audit-logs" element={<AdminRoute><AuditLogs /></AdminRoute>} />
          <Route path="settings" element={<AdminRoute><Settings /></AdminRoute>} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  )
}

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <ToastProvider>
          <AuthProvider>
            <ConsignmentSyncProvider>
              <AppServices />
              <AppRoutes />
            </ConsignmentSyncProvider>
          </AuthProvider>
        </ToastProvider>
      </BrowserRouter>
    </ErrorBoundary>
  )
}
