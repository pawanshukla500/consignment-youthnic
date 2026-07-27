import React, { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { confirmPasswordReset, verifyPasswordResetCode } from 'firebase/auth'
import { Eye, EyeOff, Loader2, CheckCircle2 } from 'lucide-react'
import { auth as fbAuth } from '../config/firebase'
import logo from '../assets/logo.png'

const ResetPassword = () => {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const oobCode = searchParams.get('oobCode') || searchParams.get('code')
  const mode = searchParams.get('mode') || 'resetPassword'

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPwd, setShowPwd] = useState(false)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [invalidLink, setInvalidLink] = useState(false)

  useEffect(() => {
    const verify = async () => {
      if (!oobCode || mode !== 'resetPassword') {
        setInvalidLink(true)
        setLoading(false)
        return
      }
      if (!fbAuth) {
        setError('Password reset is temporarily unavailable. Please contact your administrator.')
        setInvalidLink(true)
        setLoading(false)
        return
      }
      try {
        const accountEmail = await verifyPasswordResetCode(fbAuth, oobCode)
        setEmail(accountEmail)
      } catch (err) {
        console.error('[ResetPassword] Invalid code:', err?.code)
        setInvalidLink(true)
      } finally {
        setLoading(false)
      }
    }
    verify()
  }, [oobCode, mode])

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }
    setSubmitting(true)
    try {
      if (!fbAuth) throw new Error('Password reset is temporarily unavailable.')
      await confirmPasswordReset(fbAuth, oobCode, password)
      setSuccess(true)
      setTimeout(() => navigate('/login'), 3000)
    } catch (err) {
      const code = err?.code || ''
      if (code === 'auth/weak-password') {
        setError('Password is too weak. Use at least 8 characters with mixed characters.')
      } else if (code === 'auth/expired-action-code') {
        setError('This reset link has expired. Request a new one from the login page.')
      } else {
        setError('Could not reset password. The link may be invalid or expired.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f8fafc]">
        <div className="w-10 h-10 border-[3px] border-primary-200 border-t-primary-600 rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f8fafc] p-6">
      <div className="w-full max-w-[420px] animate-fade-in">
        <div className="flex items-center gap-3 mb-8 justify-center">
          <img src={logo} alt="Youthnic" className="w-10 h-10 object-contain" />
          <div>
            <p className="font-bold text-slate-900 text-lg">Youthnic</p>
            <p className="text-slate-400 text-xs">Consignment Packing App</p>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-8">
          {invalidLink ? (
            <>
              <h1 className="text-xl font-bold text-slate-900 mb-2">Invalid reset link</h1>
              <p className="text-slate-500 text-sm mb-6">
                {error || 'This password reset link is invalid or has expired. Request a new one from the login page.'}
              </p>
              <Link to="/login" className="btn btn-primary w-full justify-center">Back to Sign In</Link>
            </>
          ) : success ? (
            <div className="text-center py-4">
              <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto mb-4" />
              <h1 className="text-xl font-bold text-slate-900 mb-2">Password updated</h1>
              <p className="text-slate-500 text-sm">Redirecting you to sign in…</p>
            </div>
          ) : (
            <>
              <h1 className="text-xl font-bold text-slate-900 mb-1">Set a new password</h1>
              <p className="text-slate-500 text-sm mb-6">
                {email ? <>For <span className="font-medium text-slate-700">{email}</span></> : 'Choose a strong password for your account.'}
              </p>

              {error && (
                <div className="mb-4 p-3.5 bg-red-50 border border-red-100 rounded-xl text-red-700 text-sm">{error}</div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-[13px] font-semibold text-slate-700 mb-1.5">New Password</label>
                  <div className="relative">
                    <input
                      type={showPwd ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      minLength={8}
                      className="inp pr-11"
                      placeholder="At least 8 characters"
                    />
                    <button type="button" onClick={() => setShowPwd(!showPwd)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                      {showPwd ? <EyeOff className="w-4.5 h-4.5" /> : <Eye className="w-4.5 h-4.5" />}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-[13px] font-semibold text-slate-700 mb-1.5">Confirm Password</label>
                  <input
                    type={showPwd ? 'text' : 'password'}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    required
                    className="inp"
                    placeholder="Re-enter your password"
                  />
                </div>
                <button type="submit" disabled={submitting} className="btn btn-primary w-full justify-center py-3">
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Update Password'}
                </button>
              </form>
            </>
          )}
        </div>

        <p className="text-center text-[11px] text-slate-400 mt-6">
          <Link to="/login" className="text-primary-600 hover:text-primary-700">← Back to Sign In</Link>
        </p>
      </div>
    </div>
  )
}

export default ResetPassword
